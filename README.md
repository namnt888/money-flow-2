# Money Flow 2

Personal finance management: expense tracking, cashback, debt, recurring services.

## Stack
- **Frontend**: Next.js 15 (App Router)
- **Database**: Supabase (PostgreSQL)
- **Background**: Supabase Edge Functions / n8n
- **Sheets Sync**: Google Apps Script → Supabase REST

## Quick Start

```bash
# Install Supabase CLI
brew install supabase/tap/supabase

# Clone repo
git clone https://github.com/namnt888/money-flow-2
cd money-flow-2

# Link to your Supabase project
supabase login
supabase link --project-ref ddpiyjnildiygjqrmrnx

# Push all migrations
supabase db push

# Generate TypeScript types
supabase gen types typescript --project-id ddpiyjnildiygjqrmrnx > lib/supabase/types.ts
```

## Migration Order

| File | Tables / Objects |
|------|------------------|
| `001_core_schema.sql` | `accounts`, `people`, `business_categories` |
| `002_transactions.sql` | `transactions` + balance trigger |
| `003_cashback.sql` | `cashback_policies`, `cashback_cycles`, view |
| `004_debt_installment.sql` | `debts`, `installment_plans` + debt sync trigger |
| `005_budgets_services.sql` | `budgets`, `recurring_services` |
| `006_audit_rls.sql` | `audit_log` + RLS policies |
| `007_parser_api.sql` | `upsert_transaction`, `bulk_insert_parsed_txns` RPC |

## Agent Workflow

```
Raw text paste  →  LLM parse (Hermes/OpenRouter)  →  bulk_insert_parsed_txns RPC
                                                   →  DB triggers recalc balance + debt
                                                   →  Sheets sync
```

## Key Business Rules
- Balance computed via trigger — never update `current_balance` directly
- Cashback cycle locked by `persisted_cycle_tag` (YYYY-MM)
- Debt status auto-computed — never update `status` directly
- No hard delete — set `status = 'void'` for transactions
