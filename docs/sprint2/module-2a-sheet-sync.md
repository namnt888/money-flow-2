# Sprint 2A — Sheet Sync Module

## Overview

Replaces the Google Apps Script (GAS) `doPost` webhook with a Supabase Edge Function.
Sheet IDs are now stored in `people.sheet_id` column — no more manual env vars or GAS Script Properties.

---

## What Changed vs GAS

| GAS Pattern | New Pattern |
|---|---|
| `PropertiesService.getScriptProperty('SHEET_' + personId)` | `SELECT sheet_id FROM people WHERE id=$person_id` |
| `VLOOKUP(K, Shop!A:B, 2, FALSE)` | `SELECT icon_url FROM shop_map WHERE keyword=$shop` |
| `ARRAYFORMULA` for I (Σ Back), J (Final) | Computed server-side in `buildSheetRow()` |
| GAS `doPost` router | `Deno.serve` + `switch(action)` |
| Manual GAS Properties per user | `people.sheet_enabled = true/false` — queryable in DB |

---

## DB Changes

### `people` table (new columns)

```sql
sheet_id        TEXT      -- Google Spreadsheet ID
sheet_url       TEXT      -- Full Sheet URL (convenience)
sheet_enabled   BOOLEAN   -- Toggle sync on/off per person
sheet_tab_prefix TEXT     -- Optional custom tab prefix
```

### `shop_map` table (new)

```sql
id           UUID PK
keyword      TEXT UNIQUE  -- raw shop name (case-insensitive lookup)
display_name TEXT
icon_url     TEXT         -- If set, D column = =IMAGE(url,1) formula
category_hint TEXT
is_active    BOOLEAN
```

**To list all people with sheets configured:**
```sql
SELECT id, name, sheet_id, sheet_url, sheet_enabled
FROM people
WHERE sheet_id IS NOT NULL
ORDER BY name;
```

---

## Edge Function: `sync-sheet`

**Endpoint:** `POST /functions/v1/sync-sheet`

### Actions

#### `syncTransactions` — batch write (replaces `handleSyncTransactions`)
```json
{
  "action": "syncTransactions",
  "person_id": "uuid",
  "cycle_tag": "2026-05",
  "rows": [
    {
      "id": "uuid",
      "type": "expense",
      "occurred_at": "2026-05-27T10:00:00Z",
      "shop": "Shopee",
      "notes": "Mua đồ",
      "amount": 250000,
      "percent_back": 5,
      "fixed_back": 0,
      "status": "posted"
    }
  ]
}
```

#### `singleTransaction` — create/update/delete
```json
{
  "action": "singleTransaction",
  "person_id": "uuid",
  "transaction": { ...same fields as above... }
}
```
> If `status = "void"` → row will be cleared from sheet.

#### `ensureSheet` — create tab if missing
```json
{
  "action": "ensureSheet",
  "person_id": "uuid",
  "cycle_tag": "2026-05"
}
```

---

## Environment Variables Required

```
SUPABASE_URL                  # Auto-provided in edge function
SUPABASE_SERVICE_ROLE_KEY     # Auto-provided in edge function
GOOGLE_SERVICE_ACCOUNT_JSON   # GCP service account JSON (stringified)
```

### Setting up Google Service Account

1. Go to [GCP Console](https://console.cloud.google.com/) → IAM → Service Accounts
2. Create new service account → Enable **Google Sheets API**
3. Download JSON key
4. Share each user's spreadsheet with `service-account@project.iam.gserviceaccount.com` as **Editor**
5. Set env var: `supabase secrets set GOOGLE_SERVICE_ACCOUNT_JSON='<json string>'`

---

## Sheet Layout (v6.9 — unchanged from GAS)

| Col | Field | Source |
|-----|-------|--------|
| A | ID | `txn.id` |
| B | Type | `In` / `Out` (normalized) |
| C | Date | ISO string |
| D | Shop | Resolved from `shop_map` (icon URL or display name) |
| E | Notes | `txn.notes` |
| F | Amount | `|txn.amount|` |
| G | % Back | percent integer |
| H | đ Back | fixed cashback |
| I | Σ Back | **computed**: `F × G/100 + H` |
| J | Final | **computed**: `Out→F-I`, `In→-(F-I)` |
| K | ShopSource | raw `txn.shop` (hidden) |

---

## Verify After Merge

```bash
# 1. Pull branch
git checkout sprint2/module-2a-sheet-sync
git pull

# 2. Apply migration
supabase db push
# OR:
supabase migration up

# 3. Deploy edge function
supabase functions deploy sync-sheet

# 4. Set Google env
supabase secrets set GOOGLE_SERVICE_ACCOUNT_JSON='$(cat service-account.json)'

# 5. Set a person's sheet_id
UPDATE people SET sheet_id = '1BxiM...', sheet_url = 'https://docs.google.com/...', sheet_enabled = true WHERE id = 'your-uuid';

# 6. Test
curl -X POST https://<project>.supabase.co/functions/v1/sync-sheet \
  -H 'Authorization: Bearer <anon_key>' \
  -H 'Content-Type: application/json' \
  -d '{"action":"ensureSheet","person_id":"<uuid>","cycle_tag":"2026-05"}'
```

---

## Sprint 2 Roadmap

| Module | Branch | Status |
|--------|--------|--------|
| **2A** — people.sheet_id + shop_map + sync-sheet EF | `sprint2/module-2a-sheet-sync` | ✅ This PR |
| **2B** — Cashback engine (cycle calculation, cap logic) | `sprint2/module-2b-cashback` | 🔜 Next |
| **2C** — Debt + Installment API | `sprint2/module-2c-debt-installment` | 🔜 Queued |
| **2D** — Recurring services + n8n trigger webhook | `sprint2/module-2d-recurring` | 🔜 Queued |
