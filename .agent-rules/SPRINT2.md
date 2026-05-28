# Agent Rules — Sprint 2

> Tài liệu này dành cho AI agent (Cursor, Copilot CLI, etc.) hiểu context khi làm việc trong repo này.

## Project

- **Name:** money-flow-2
- **Stack:** Supabase (Postgres + Edge Functions Deno) + Google Sheets API
- **Repo:** https://github.com/namnt888/money-flow-2

## DB Schema Key Tables

```
people          — users, has sheet_id/sheet_url/sheet_enabled columns
accounts        — bank/credit/wallet accounts
transactions    — source of truth (9 types, 3 statuses: posted/pending/void)
categories      — business-category 2-tier (12 L1, ~50 L2)
shop_map        — keyword → icon_url/display_name (replaces GAS Shop!A:B tab)
cashback_policy — cashback rules per account
cashback_cycles — cycle snapshots
budgets         — budget per category per period
debt            — debt tracking (lent/borrowed)
installment_plans — installment split plans
recurring_services — subscription/auto-charge
audit_history   — immutable audit log
```

## Edge Functions

| Function | Purpose |
|---|---|
| `sync-sheet` | Write transactions to Google Sheets (replaces GAS doPost) |
| (2B) `cashback-calc` | Compute cashback per cycle |
| (2C) `debt-api` | Debt + repayment CRUD |
| (2D) `recurring-trigger` | n8n-compatible webhook for recurring services |

## Column Layout (Google Sheet v6.9)

```
A: ID (hidden)  B: Type  C: Date  D: Shop(resolved)  E: Notes
F: Amount  G: %Back  H: đBack  I: ΣBack(computed)  J: Final(computed)  K: ShopSource(hidden)
```

## Branching Convention

```
main
└── sprint2/module-2a-sheet-sync   ← people.sheet_id + shop_map + sync-sheet EF
└── sprint2/module-2b-cashback     ← cashback engine
└── sprint2/module-2c-debt-installment
└── sprint2/module-2d-recurring
```

## Key Business Rules

1. `transactions.status = 'void'` → never synced to sheet, never counted in balance/cashback
2. `people.sheet_enabled = false` → skip all sheet operations for that person
3. Shop icon resolution order: `shop_map.icon_url` → `shop_map.display_name` → raw `txn.shop`
4. Cashback: only `posted` transactions + not `internal_transfer` category count
5. Family accounts: `available_credit = parent.credit_limit - (parent.balance + Σ children.balance)`
6. Transfer: always 2 atomic transaction records (debit + credit)
7. `audit_history` is APPEND-ONLY — never update or delete rows

## Migration Naming Convention

```
YYYYMMDDHHMMSS_description.sql
20260527210000_core_schema.sql   ← Sprint 1 (already applied)
20260527220000_people_sheet_id.sql ← Sprint 2A
```

## Environment Variables

```
# Supabase (auto-provided in edge functions)
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY

# Google Sheets (set via: supabase secrets set ...)
GOOGLE_SERVICE_ACCOUNT_JSON  # GCP service account JSON stringified
```

## Testing a new Edge Function

```bash
supabase functions deploy <function-name>
curl -X POST https://<ref>.supabase.co/functions/v1/<function-name> \
  -H 'Authorization: Bearer <anon_key>' \
  -H 'Content-Type: application/json' \
  -d '<payload>'
```
