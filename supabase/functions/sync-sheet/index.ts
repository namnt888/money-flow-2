/**
 * sync-sheet Edge Function
 * Sprint 2A — Module: Sheet Sync (GAS doPost replacement)
 *
 * Maps:
 *   GAS getOrCreateSpreadsheet(personId) → SELECT sheet_id FROM people WHERE id=$id
 *   GAS handleSyncTransactions(payload)  → batch upsert rows to Google Sheet
 *   GAS VLOOKUP Shop!A:B                 → SELECT icon_url FROM shop_map WHERE lower(keyword)=lower($shop)
 *   GAS ARRAYFORMULA I,J                 → computed server-side before writing
 *
 * Sheet Layout (v6.9 compatible):
 *   A: ID | B: Type | C: Date | D: Shop (resolved) | E: Notes
 *   F: Amount | G: %Back | H: đBack | I: ΣBack | J: Final | K: ShopSource (hidden)
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GOOGLE_SERVICE_ACCOUNT = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON'); // JSON string of GCP service account

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ─── Types ────────────────────────────────────────────────────────────────────

interface SyncPayload {
  action: 'syncTransactions' | 'ensureSheet' | 'singleTransaction';
  person_id: string;
  cycle_tag?: string;   // format YYYY-MM
  rows?: TransactionRow[];
  transaction?: TransactionRow;
}

interface TransactionRow {
  id: string;
  type: string;             // 'expense'|'income'|'transfer'|... normalised to In/Out
  occurred_at: string;
  shop?: string;            // raw shop source (K column)
  notes?: string;
  amount: number;
  percent_back?: number;
  fixed_back?: number;
  status: string;           // only 'posted' rows written
}

interface SheetPerson {
  sheet_id: string;
  sheet_url: string;
  sheet_enabled: boolean;
  sheet_tab_prefix?: string;
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders() });
  }

  try {
    const payload: SyncPayload = await req.json();

    if (!payload.person_id) {
      return jsonError('person_id is required', 400);
    }

    // 1. Resolve sheet_id from DB (replaces GAS PropertiesService)
    const person = await getPersonSheet(payload.person_id);
    if (!person) return jsonError('Person not found', 404);
    if (!person.sheet_enabled) return jsonError('Sheet sync disabled for this person', 403);
    if (!person.sheet_id) return jsonError('No sheet_id configured for this person. Set people.sheet_id in DB.', 422);

    // 2. Route action
    switch (payload.action) {
      case 'syncTransactions':
        return await handleSyncTransactions(person, payload);
      case 'singleTransaction':
        return await handleSingleTransaction(person, payload);
      case 'ensureSheet':
        return await handleEnsureSheet(person, payload);
      default:
        return jsonError(`Unknown action: ${(payload as any).action}`, 400);
    }
  } catch (err) {
    console.error('sync-sheet error:', err);
    return jsonError(String(err), 500);
  }
});

// ─── Action Handlers ──────────────────────────────────────────────────────────

async function handleSyncTransactions(person: SheetPerson, payload: SyncPayload): Promise<Response> {
  const rows = payload.rows ?? [];
  if (!rows.length) return jsonOk({ written: 0, message: 'No rows provided' });

  const cycleTag = payload.cycle_tag ?? getCycleTag(new Date(rows[0].occurred_at));
  const tabName = resolveTabName(cycleTag, person.sheet_tab_prefix);

  // Filter: only posted transactions
  const validRows = rows.filter(r => r.status !== 'void');

  // Resolve shop icons for all rows (batch)
  const shopKeys = [...new Set(validRows.map(r => r.shop ?? '').filter(Boolean))];
  const shopMap = await resolveShopMap(shopKeys);

  // Build sheet rows (A:K)
  const sheetRows = validRows
    .sort((a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime())
    .map(txn => buildSheetRow(txn, shopMap));

  // Write to Google Sheet
  await upsertRowsToSheet(person.sheet_id, tabName, sheetRows);

  return jsonOk({ written: sheetRows.length, tab: tabName, sheet_id: person.sheet_id });
}

async function handleSingleTransaction(person: SheetPerson, payload: SyncPayload): Promise<Response> {
  const txn = payload.transaction;
  if (!txn) return jsonError('transaction is required for singleTransaction action', 400);

  const cycleTag = payload.cycle_tag ?? getCycleTag(new Date(txn.occurred_at));
  const tabName = resolveTabName(cycleTag, person.sheet_tab_prefix);
  const shopMap = await resolveShopMap([txn.shop ?? '']);

  if (txn.status === 'void') {
    // Delete row from sheet by ID
    await deleteRowFromSheet(person.sheet_id, tabName, txn.id);
    return jsonOk({ deleted: txn.id, tab: tabName });
  }

  const row = buildSheetRow(txn, shopMap);
  await upsertRowsToSheet(person.sheet_id, tabName, [row]);
  return jsonOk({ written: 1, tab: tabName });
}

async function handleEnsureSheet(person: SheetPerson, payload: SyncPayload): Promise<Response> {
  const cycleTag = payload.cycle_tag ?? getCycleTag(new Date());
  const tabName = resolveTabName(cycleTag, person.sheet_tab_prefix);
  await ensureTabExists(person.sheet_id, tabName);
  return jsonOk({ ok: true, tab: tabName, sheet_id: person.sheet_id, sheet_url: person.sheet_url });
}

// ─── DB Helpers ───────────────────────────────────────────────────────────────

async function getPersonSheet(personId: string): Promise<SheetPerson | null> {
  const { data, error } = await supabase
    .from('people')
    .select('sheet_id, sheet_url, sheet_enabled, sheet_tab_prefix')
    .eq('id', personId)
    .single();

  if (error || !data) return null;
  return data as SheetPerson;
}

/** Batch-resolve shop icons from shop_map table.
 *  Replaces GAS VLOOKUP(K, Shop!A:B, 2, FALSE)
 */
async function resolveShopMap(keys: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!keys.length) return result;

  const { data } = await supabase
    .from('shop_map')
    .select('keyword, display_name, icon_url')
    .in('keyword', keys);

  for (const row of data ?? []) {
    // Prefer icon_url, fallback to display_name, fallback to keyword
    result.set(row.keyword, row.icon_url ?? row.display_name ?? row.keyword);
  }
  return result;
}

// ─── Row Builder ──────────────────────────────────────────────────────────────

/**
 * Builds A:K array for one transaction row.
 * Computes I (Σ Back) and J (Final) server-side — no ARRAYFORMULA needed in sheet.
 *
 * Layout:
 *  [0]A ID | [1]B Type | [2]C Date | [3]D Shop | [4]E Notes
 *  [5]F Amount | [6]G %Back | [7]H đBack | [8]I ΣBack | [9]J Final | [10]K ShopSource
 */
function buildSheetRow(
  txn: TransactionRow,
  shopMap: Map<string, string>
): (string | number | null)[] {
  const type = normalizeType(txn.type);
  const amount = Math.abs(txn.amount);
  const shopSource = txn.shop ?? '';
  const shopResolved = shopMap.get(shopSource) ?? shopSource;

  // D column: if icon_url → write as =IMAGE() formula, else plain text
  const shopCell = isUrl(shopResolved)
    ? `=IMAGE("${shopResolved}",1)`
    : shopResolved;

  const pBack = normalizePercent(txn.percent_back ?? 0);
  const dBack = txn.fixed_back ?? 0;

  // I: Σ Back = amount * (pBack/100) + dBack
  const sigmaBack = amount * (pBack / 100) + dBack;

  // J: Final = Out → amount - sigmaBack, In → -(amount - sigmaBack)
  const finalPrice = type === 'Out' ? amount - sigmaBack : -(amount - sigmaBack);

  return [
    txn.id,                                           // A: ID
    type,                                              // B: Type
    new Date(txn.occurred_at).toISOString(),          // C: Date
    shopCell,                                          // D: Shop (resolved)
    txn.notes ?? '',                                   // E: Notes
    amount,                                            // F: Amount
    pBack,                                             // G: %Back
    dBack,                                             // H: đBack
    sigmaBack,                                         // I: ΣBack (computed)
    finalPrice,                                        // J: Final (computed)
    shopSource,                                        // K: ShopSource (raw, hidden)
  ];
}

// ─── Google Sheets API ────────────────────────────────────────────────────────

/**
 * Get OAuth2 access token from service account JSON.
 * Requires GOOGLE_SERVICE_ACCOUNT_JSON env var.
 */
async function getGoogleAccessToken(): Promise<string> {
  if (!GOOGLE_SERVICE_ACCOUNT) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var not set');
  }
  const sa = JSON.parse(GOOGLE_SERVICE_ACCOUNT);
  // Use Google OAuth2 JWT flow
  const scope = 'https://www.googleapis.com/auth/spreadsheets';
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  // Sign JWT with RS256
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify(claim));
  const signingInput = `${header}.${payload}`;

  const privateKey = await importPrivateKey(sa.private_key);
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Failed to get Google token: ' + JSON.stringify(data));
  return data.access_token;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemBody = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '')
    .trim();
  const binaryDer = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    binaryDer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/** Ensure a tab exists in the spreadsheet. Creates it if missing. */
async function ensureTabExists(sheetId: string, tabName: string): Promise<void> {
  const token = await getGoogleAccessToken();

  // Check existing sheets
  const metaResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const meta = await metaResp.json();
  const titles: string[] = (meta.sheets ?? []).map((s: any) => s.properties.title);

  if (titles.includes(tabName)) return; // Already exists

  // Create new tab
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{
        addSheet: {
          properties: { title: tabName }
        }
      }]
    }),
  });

  // Write header row
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}!A1:K1?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        values: [['ID', 'Type', 'Date', 'Shop', 'Notes', 'Amount', '% Back', 'đ Back', 'Σ Back', 'Final Price', 'ShopSource']]
      })
    }
  );
}

/**
 * Upsert rows into a sheet tab.
 * Strategy: Read existing IDs (col A), update matching rows, append new ones.
 * Mirrors GAS handleSyncTransactions upsert logic.
 */
async function upsertRowsToSheet(
  sheetId: string,
  tabName: string,
  newRows: (string | number | null)[][]
): Promise<void> {
  await ensureTabExists(sheetId, tabName);
  const token = await getGoogleAccessToken();

  // Read existing data
  const readResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}!A:K`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const existing = await readResp.json();
  const allValues: any[][] = existing.values ?? [];

  // Build ID → row index map (skip header row at index 0)
  const idToRowIndex = new Map<string, number>();
  for (let i = 1; i < allValues.length; i++) {
    const id = String(allValues[i][0] ?? '').trim();
    if (id.length > 5) idToRowIndex.set(id, i);
  }

  const updates: { range: string; values: any[][] }[] = [];
  const toAppend: any[][] = [];

  for (const row of newRows) {
    const id = String(row[0]);
    if (idToRowIndex.has(id)) {
      // Update existing row (1-indexed, +1 for header)
      const rowNum = idToRowIndex.get(id)! + 1;
      updates.push({
        range: `${tabName}!A${rowNum}:K${rowNum}`,
        values: [row]
      });
    } else {
      toAppend.push(row);
    }
  }

  // Batch update existing rows
  if (updates.length > 0) {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: updates })
      }
    );
  }

  // Append new rows
  if (toAppend.length > 0) {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}!A:K:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: toAppend })
      }
    );
  }
}

/** Delete a row by transaction ID (set all cells to empty, or find and delete) */
async function deleteRowFromSheet(sheetId: string, tabName: string, txnId: string): Promise<void> {
  const token = await getGoogleAccessToken();
  const readResp = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}!A:A`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await readResp.json();
  const ids: any[][] = data.values ?? [];

  for (let i = 1; i < ids.length; i++) {
    if (String(ids[i][0] ?? '').trim() === txnId) {
      const rowNum = i + 1;
      // Clear the row
      await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(tabName)}!A${rowNum}:K${rowNum}:clear`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } }
      );
      return;
    }
  }
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function normalizeType(type: string): 'In' | 'Out' {
  const t = type.toLowerCase();
  if (t === 'income' || t === 'in' || t === 'transfer_in') return 'In';
  return 'Out';
}

function normalizePercent(val: number): number {
  if (val > 0 && val < 1) return val * 100; // 0.05 → 5
  return val;
}

function getCycleTag(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function resolveTabName(cycleTag: string, prefix?: string | null): string {
  return prefix ? `${prefix}-${cycleTag}` : cycleTag;
}

function isUrl(s: string): boolean {
  return s.startsWith('http://') || s.startsWith('https://');
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  };
}

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, ...data as object }), {
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

function jsonError(message: string, status = 400): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}
