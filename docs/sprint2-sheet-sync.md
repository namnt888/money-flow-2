# Sprint 2 — Sheet Sync Edge Function

## Overview

Replaces Google Apps Script `doPost()` with a Supabase Edge Function `sync-sheet`.
Sheet IDs are now managed in the `people` table (DB), not in GAS Script Properties or env vars.

---

## New DB columns: `people`

| Column | Type | Default | Purpose |
|---|---|---|---|
| `sheet_id` | TEXT | NULL | Google Spreadsheet ID |
| `sheet_url` | TEXT | NULL | Convenience full URL |
| `sheet_enabled` | BOOLEAN | false | Toggle sync per person |
| `sheet_cycle_mode` | TEXT | `month` | `month` = YYYY-MM tab \| `year` = YYYY tab |

**How to add a person's sheet:**
```sql
UPDATE people
SET sheet_id      = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms',
    sheet_url     = 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms',
    sheet_enabled = true,
    sheet_cycle_mode = 'month'
WHERE id = '<person-uuid>';
```

---

## New table: `shop_map`

Replaces the `Shop` tab in every spreadsheet.

| Column | Purpose |
|---|---|
| `keyword` | Raw shop name from transaction |
| `display_name` | Human label |
| `icon_url` | If set, rendered as `=IMAGE(url,1)` in sheet col D |
| `match_mode` | `exact` / `ilike` / `prefix` |

---

## Edge Function: `sync-sheet`

### Actions

| `action` | Replaces GAS | Description |
|---|---|---|
| `ensureSheet` | `handleEnsureSheet` | Create tab if not exists, write header |
| `syncTransactions` | `handleSyncTransactions` | Batch upsert all rows for a cycle |
| `syncOne` | `handleSingleTransaction` | Single create/update |
| `delete` | `handleSingleTransaction` (delete) | Delete row by ID |

### Sheet Layout (preserved v6.9)

```
A: ID (hidden)   B: Type   C: Date   D: Shop (resolved)   E: Notes
F: Amount        G: %Back  H: đBack  I: ΣBack (computed)  J: Final (computed)
K: ShopSource (hidden)
```

**Key change vs GAS**: Columns I, J, D are now **computed values** written directly
(not ARRAYFORMULA). This makes the sheet portable and read-only friendly.

### Env Secrets required

| Secret | Description |
|---|---|
| `SUPABASE_URL` | Auto-injected by Supabase runtime |
| `SUPABASE_SERVICE_ROLE_KEY` | Auto-injected by Supabase runtime |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google Service Account JSON (full content) |

**How to set GOOGLE_SERVICE_ACCOUNT_JSON:**
```bash
supabase secrets set GOOGLE_SERVICE_ACCOUNT_JSON='{ ...paste full JSON... }'
```

### Deploy
```bash
supabase functions deploy sync-sheet --no-verify-jwt
```
> `--no-verify-jwt` allows n8n / external webhooks to call without Supabase auth header.
> If you want auth-protected: remove that flag and pass `Authorization: Bearer <service_role_key>`.

### Test locally
```bash
curl -X POST http://localhost:54321/functions/v1/sync-sheet \
  -H "Content-Type: application/json" \
  -d '{
    "action": "ensureSheet",
    "person_id": "<uuid>",
    "cycle_tag": "2026-05"
  }'
```

---

## Google Service Account Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com) → IAM → Service Accounts
2. Create service account → Download JSON key
3. **Share each person's spreadsheet** with the service account email (`xxx@project.iam.gserviceaccount.com`) as **Editor**
4. Store JSON in Supabase secret: `GOOGLE_SERVICE_ACCOUNT_JSON`

---

## Formula mapping: GAS → Edge Function

| GAS (Google Sheet formula) | Edge Function (server-side) |
|---|---|
| `ARRAYFORMULA VLOOKUP(K, Shop!A:B, 2)` → D | `resolveShopDisplay(shopSource)` → writes value to D |
| `ARRAYFORMULA F*G/100 + H` → I (ΣBack) | `computeSigmaBack(amt, pct, fix)` |
| `ARRAYFORMULA IF(B="In", -F+I, F-I)` → J (Final) | `computeFinal(type, amt, sigma)` |
| `PropertiesService.getProperty('SHEET_'+id)` | `SELECT sheet_id FROM people WHERE id=$id` |

---

## n8n Webhook config

Replace old GAS Web App URL with:
```
https://<project-ref>.supabase.co/functions/v1/sync-sheet
```

Payload stays identical (same field names as GAS), just swap `personId` → `person_id`.
