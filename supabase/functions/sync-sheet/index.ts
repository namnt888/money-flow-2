/**
 * sync-sheet — Supabase Edge Function
 * Sprint 2 · money-flow-2
 *
 * Replaces Google Apps Script doPost() for sheet write operations.
 *
 * Actions:
 *   ensureSheet        → getOrCreate cycle tab in person's spreadsheet
 *   syncTransactions   → batch upsert rows (mirrors handleSyncTransactions)
 *   syncOne            → single create/edit/delete (mirrors handleSingleTransaction)
 *
 * Sheet Layout v6.9 (preserved 1:1 from GAS):
 *   A: ID  B: Type  C: Date  D: Shop(resolved)  E: Notes
 *   F: Amount  G: %Back  H: đBack  I: ΣBack(computed)  J: Final(computed)  K: ShopSource(hidden)
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TransactionRow {
  id: string;
  type: string;
  date?: string;
  occurred_at?: string;
  shop?: string;
  shop_name?: string;
  notes?: string;
  note?: string;
  amount?: number;
  original_amount?: number;
  percent_back?: number;
  cashback_percent?: number;
  fixed_back?: number;
  cashback_fixed?: number;
  status?: string;
  cycle_tag?: string;
}

interface SyncPayload {
  action: 'ensureSheet' | 'syncTransactions' | 'syncOne' | 'delete';
  person_id: string;
  cycle_tag?: string;
  rows?: TransactionRow[];
  // single-row fields (syncOne/delete)
  id?: string;
  type?: string;
  date?: string;
  occurred_at?: string;
  shop?: string;
  notes?: string;
  amount?: number;
  percent_back?: number;
  fixed_back?: number;
  status?: string;
  // optional overrides
  sheet_id?: string;
  sheet_cycle_mode?: 'month' | 'year';
  bank_account?: string;
}

interface ShopMapRow {
  keyword: string;
  display_name: string | null;
  icon_url: string | null;
  match_mode: string;
}

// ─── Supabase client (service role — runs inside Edge runtime) ────────────────

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toNum(v: unknown): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  const s = String(v).trim().replace(/,/g, '').replace(/\s+/g, '');
  if (/^\d+\.\d+\.\d+$/.test(s)) return Number(s.replace(/\./g, ''));
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

function resolveAmount(row: TransactionRow): number {
  return Math.abs(toNum(row.amount ?? row.original_amount ?? 0));
}

function resolvePercent(row: TransactionRow): number {
  let v = toNum(row.percent_back ?? row.cashback_percent ?? 0);
  if (v > 0 && v < 1) v = v * 100;
  return v;
}

function resolveFixed(row: TransactionRow): number {
  return toNum(row.fixed_back ?? row.cashback_fixed ?? 0);
}

function normalizeType(type: string, amount?: number): 'In' | 'Out' {
  const t = (type || '').toLowerCase();
  if (['debt', 'expense', 'out'].some(k => t.includes(k))) return 'Out';
  if (['repay', 'income', 'in'].some(k => t.includes(k))) return 'In';
  return (amount ?? 0) < 0 ? 'Out' : 'In';
}

function getCycleTag(date: string | Date): string {
  const d = date instanceof Date ? date : new Date(date);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}`;
}

function resolveTabName(cycleTag: string, mode: 'month' | 'year'): string {
  if (mode === 'year') {
    const m = cycleTag.match(/^(\d{4})/);
    return m ? m[1] : cycleTag;
  }
  return cycleTag;
}

/** Compute ΣBack (I col) server-side — mirrors GAS ARRAYFORMULA */
function computeSigmaBack(amount: number, percent: number, fixed: number): number {
  return (amount * percent) / 100 + fixed;
}

/** Compute Final (J col) server-side — mirrors GAS ARRAYFORMULA */
function computeFinal(type: 'In' | 'Out', amount: number, sigmaBack: number): number {
  return type === 'In' ? -amount + sigmaBack : amount - sigmaBack;
}

// ─── Shop icon resolution ─────────────────────────────────────────────────────

let shopMapCache: ShopMapRow[] | null = null;
let shopMapCacheAt = 0;
const SHOP_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getShopMap(): Promise<ShopMapRow[]> {
  if (shopMapCache && Date.now() - shopMapCacheAt < SHOP_CACHE_TTL) return shopMapCache!;
  const { data } = await supabase.from('shop_map').select('keyword,display_name,icon_url,match_mode');
  shopMapCache = (data as ShopMapRow[]) ?? [];
  shopMapCacheAt = Date.now();
  return shopMapCache!;
}

/**
 * Resolves shop source → display value.
 * Mirrors GAS ARRAYFORMULA:
 *   VLOOKUP(K, Shop!A:B, 2) → if URL → "=IMAGE(url,1)" formula string
 */
async function resolveShopDisplay(shopSource: string): Promise<string> {
  if (!shopSource) return '';
  const map = await getShopMap();
  const src = shopSource.trim().toLowerCase();

  for (const row of map) {
    const kw = row.keyword.toLowerCase();
    let matched = false;
    if (row.match_mode === 'exact')  matched = src === kw;
    if (row.match_mode === 'ilike')  matched = src.includes(kw) || kw.includes(src);
    if (row.match_mode === 'prefix') matched = src.startsWith(kw);
    if (matched) {
      const val = row.icon_url ?? row.display_name ?? shopSource;
      // If URL → wrap as =IMAGE() formula for Sheets to render icon
      return val.startsWith('http') ? `=IMAGE("${val}",1)` : val;
    }
  }
  return shopSource; // fallback: raw text
}

// ─── Google Sheets API helpers ────────────────────────────────────────────────

async function getSheetsToken(): Promise<string> {
  // Uses service account credentials stored in Supabase vault secret: GOOGLE_SERVICE_ACCOUNT_JSON
  const saJson = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!saJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON secret not set');
  const sa = JSON.parse(saJson);

  const now = Math.floor(Date.now() / 1000);
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = btoa(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));

  // Sign with RSA-SHA256 using Web Crypto
  const pemKey = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\n/g, '');
  const keyData = Uint8Array.from(atob(pemKey), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyData.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign'],
  );
  const sigData = new TextEncoder().encode(`${header}.${claim}`);
  const sigBuf = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, sigData);
  const sig = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

  const jwt = `${header}.${claim}.${sig}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await res.json();
  if (!tokenData.access_token) throw new Error('Failed to get Google token: ' + JSON.stringify(tokenData));
  return tokenData.access_token as string;
}

async function sheetsGet(token: string, sheetId: string, range: string) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

async function sheetsBatchUpdate(token: string, sheetId: string, requests: unknown[]) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  return res.json();
}

async function sheetsValuesUpdate(
  token: string, sheetId: string, range: string, values: unknown[][],
) {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ range, majorDimension: 'ROWS', values }),
  });
  return res.json();
}

async function sheetsValuesAppend(
  token: string, sheetId: string, range: string, values: unknown[][],
) {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ majorDimension: 'ROWS', values }),
  });
  return res.json();
}

/** Ensure a sheet tab exists by name; create if missing */
async function ensureTab(token: string, sheetId: string, tabName: string): Promise<number> {
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const meta = await metaRes.json();
  const sheets: Array<{ properties: { title: string; sheetId: number } }> = meta.sheets ?? [];
  const existing = sheets.find(s => s.properties.title === tabName);
  if (existing) return existing.properties.sheetId;

  const addRes = await sheetsBatchUpdate(token, sheetId, [{
    addSheet: { properties: { title: tabName } },
  }]);
  return addRes.replies?.[0]?.addSheet?.properties?.sheetId ?? 0;
}

/** Write header row A1:K1 with styling (blue background, white bold text) */
async function ensureHeader(token: string, sheetId: string, tabName: string, tabSheetId: number) {
  const HEADERS = ['ID', 'Type', 'Date', 'Shop', 'Notes', 'Amount', '% Back', 'đ Back', 'Σ Back', 'Final Price', 'ShopSource'];
  // Write header values
  await sheetsValuesUpdate(token, sheetId, `${tabName}!A1:K1`, [HEADERS]);
  // Style header
  await sheetsBatchUpdate(token, sheetId, [{
    repeatCell: {
      range: { sheetId: tabSheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 11 },
      cell: {
        userEnteredFormat: {
          backgroundColor: { red: 0.31, green: 0.27, blue: 0.90 }, // #4f46e5
          textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
          horizontalAlignment: 'CENTER',
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
    },
  }, {
    // Freeze row 1
    updateSheetProperties: {
      properties: { sheetId: tabSheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount',
    },
  }]);
}

// ─── Person sheet resolver ─────────────────────────────────────────────────────

async function resolvePersonSheet(
  personId: string,
  overrideSheetId?: string,
): Promise<{ sheetId: string; cycleMode: 'month' | 'year' }> {
  if (overrideSheetId) return { sheetId: overrideSheetId, cycleMode: 'month' };

  const { data, error } = await supabase
    .from('people')
    .select('sheet_id, sheet_enabled, sheet_cycle_mode')
    .eq('id', personId)
    .single();

  if (error || !data) throw new Error(`Person not found: ${personId}`);
  if (!data.sheet_enabled) throw new Error(`Sheet sync disabled for person: ${personId}`);
  if (!data.sheet_id) throw new Error(`No sheet_id configured for person: ${personId}`);

  return { sheetId: data.sheet_id, cycleMode: data.sheet_cycle_mode ?? 'month' };
}

// ─── Action handlers ──────────────────────────────────────────────────────────

async function handleEnsureSheet(payload: SyncPayload) {
  const { sheetId, cycleMode } = await resolvePersonSheet(payload.person_id, payload.sheet_id);
  const cycleTag = payload.cycle_tag ?? getCycleTag(new Date());
  const tabName = resolveTabName(cycleTag, cycleMode);
  const token = await getSheetsToken();
  const tabSheetId = await ensureTab(token, sheetId, tabName);
  await ensureHeader(token, sheetId, tabName, tabSheetId);
  return { ok: true, sheetId, tabName };
}

async function handleSyncTransactions(payload: SyncPayload) {
  const { sheetId, cycleMode } = await resolvePersonSheet(payload.person_id, payload.sheet_id);
  const transactions = (payload.rows ?? []).filter(t => t.status !== 'void');
  if (transactions.length === 0) return { ok: true, syncedCount: 0 };

  const cycleTag = payload.cycle_tag ?? getCycleTag(transactions[0].date ?? transactions[0].occurred_at ?? new Date().toISOString());
  const tabName = resolveTabName(cycleTag, cycleMode);

  const token = await getSheetsToken();
  const tabSheetId = await ensureTab(token, sheetId, tabName);
  await ensureHeader(token, sheetId, tabName, tabSheetId);

  // Read existing rows to build ID→rowIndex map
  const existing = await sheetsGet(token, sheetId, `${tabName}!A:K`);
  const existingRows: unknown[][] = existing.values ?? [];
  const rowMap: Record<string, number> = {};
  for (let i = 1; i < existingRows.length; i++) {
    const id = String(existingRows[i][0] ?? '').trim();
    if (id.length > 5) rowMap[id] = i + 1; // 1-indexed sheet row
  }

  // Sort by date ASC
  transactions.sort((a, b) => new Date(a.date ?? '').getTime() - new Date(b.date ?? '').getTime());

  // Build output rows
  const outputRows: unknown[][] = [['ID', 'Type', 'Date', 'Shop', 'Notes', 'Amount', '% Back', 'đ Back', 'Σ Back', 'Final Price', 'ShopSource']];

  for (const txn of transactions) {
    const type = normalizeType(txn.type, txn.amount);
    const amt = resolveAmount(txn);
    const pct = resolvePercent(txn);
    const fix = resolveFixed(txn);
    const sigma = computeSigmaBack(amt, pct, fix);
    const final = computeFinal(type, amt, sigma);
    const shopSrc = txn.shop ?? txn.shop_name ?? '';
    const shopDisplay = await resolveShopDisplay(shopSrc);
    const dateStr = txn.date ?? txn.occurred_at ?? '';
    // Format date as DD-MM for display (Sheets keeps raw string)
    const dateDisplay = dateStr ? new Date(dateStr).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }) : '';

    outputRows.push([
      txn.id,        // A: ID
      type,          // B: Type
      dateDisplay,   // C: Date
      shopDisplay,   // D: Shop (resolved, may be =IMAGE() formula)
      txn.notes ?? txn.note ?? '',  // E: Notes
      amt,           // F: Amount
      pct,           // G: % Back
      fix,           // H: đ Back
      sigma,         // I: Σ Back (computed)
      final,         // J: Final (computed)
      shopSrc,       // K: ShopSource (hidden)
    ]);
  }

  // Full rewrite strategy (mirrors GAS: clear → write → sort → hide cols)
  await sheetsValuesUpdate(token, sheetId, `${tabName}!A1`, outputRows);

  // Hide col A (ID) and K (ShopSource) via batchUpdate
  await sheetsBatchUpdate(token, sheetId, [
    { updateDimensionProperties: { range: { sheetId: tabSheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } },
    { updateDimensionProperties: { range: { sheetId: tabSheetId, dimension: 'COLUMNS', startIndex: 10, endIndex: 11 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } },
  ]);

  return { ok: true, syncedCount: transactions.length, sheetId, tabName };
}

async function handleSyncOne(payload: SyncPayload) {
  const { sheetId, cycleMode } = await resolvePersonSheet(payload.person_id, payload.sheet_id);
  const cycleTag = payload.cycle_tag ?? getCycleTag(payload.date ?? payload.occurred_at ?? new Date().toISOString());
  const tabName = resolveTabName(cycleTag, cycleMode);

  const token = await getSheetsToken();
  const tabSheetId = await ensureTab(token, sheetId, tabName);
  await ensureHeader(token, sheetId, tabName, tabSheetId);

  // Find existing row
  const existing = await sheetsGet(token, sheetId, `${tabName}!A:A`);
  const ids: unknown[][] = existing.values ?? [];
  let targetRow = -1;
  for (let i = 1; i < ids.length; i++) {
    if (String(ids[i][0] ?? '').trim() === payload.id) {
      targetRow = i + 1;
      break;
    }
  }

  // DELETE
  if (payload.action === 'delete' || payload.status === 'void') {
    if (targetRow > 0) {
      await sheetsBatchUpdate(token, sheetId, [{
        deleteDimension: { range: { sheetId: tabSheetId, dimension: 'ROWS', startIndex: targetRow - 1, endIndex: targetRow } },
      }]);
    }
    return { ok: true, action: 'deleted', sheetId, tabName };
  }

  // BUILD ROW
  const asTxn = payload as unknown as TransactionRow;
  const type = normalizeType(payload.type ?? '', payload.amount);
  const amt = resolveAmount(asTxn);
  const pct = resolvePercent(asTxn);
  const fix = resolveFixed(asTxn);
  const sigma = computeSigmaBack(amt, pct, fix);
  const final = computeFinal(type, amt, sigma);
  const shopSrc = payload.shop ?? '';
  const shopDisplay = await resolveShopDisplay(shopSrc);
  const dateStr = payload.date ?? payload.occurred_at ?? '';
  const dateDisplay = dateStr ? new Date(dateStr).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }) : '';

  const rowData = [
    payload.id, type, dateDisplay, shopDisplay,
    payload.notes ?? '', amt, pct, fix, sigma, final, shopSrc,
  ];

  if (targetRow > 0) {
    // Update existing row
    await sheetsValuesUpdate(token, sheetId, `${tabName}!A${targetRow}:K${targetRow}`, [rowData]);
    return { ok: true, action: 'updated', sheetId, tabName };
  }

  // Append new row
  await sheetsValuesAppend(token, sheetId, `${tabName}!A:K`, [rowData]);
  return { ok: true, action: 'created', sheetId, tabName };
}

// ─── Main handler ─────────────────────────────────────────────────────────────

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type' } });
  }

  try {
    const payload: SyncPayload = await req.json();

    if (!payload.person_id && !payload.sheet_id) {
      return Response.json({ error: 'person_id or sheet_id required' }, { status: 400 });
    }

    let result;
    switch (payload.action) {
      case 'ensureSheet':
        result = await handleEnsureSheet(payload);
        break;
      case 'syncTransactions':
        result = await handleSyncTransactions(payload);
        break;
      case 'syncOne':
      case 'delete':
        result = await handleSyncOne(payload);
        break;
      default:
        return Response.json({ error: `Unknown action: ${payload.action}` }, { status: 400 });
    }

    return Response.json(result);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[sync-sheet]', msg);
    return Response.json({ error: msg }, { status: 500 });
  }
});
