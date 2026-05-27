# Legacy GAS Reference

This folder stores the original Google Apps Script for reference during migration.
Do NOT run or deploy these files — they are superseded by the Supabase Edge Functions.

## Files

- `Code.js` — original GAS script (v8.0, last updated 2026-03-28)
- `appsscript.json` — GAS manifest

## Key mapping to new system

| GAS | New |
|---|---|
| `doPost()` router | `sync-sheet` Edge Function |
| `getOrCreateSpreadsheet(personId)` | `SELECT sheet_id FROM people WHERE id=$id` |
| `handleSyncTransactions` | `action: syncTransactions` |
| `handleSingleTransaction` | `action: syncOne` |
| `VLOOKUP Shop!A:B` → col D | `resolveShopDisplay()` via `shop_map` table |
| `ARRAYFORMULA I (ΣBack)` | `computeSigmaBack()` server-side |
| `ARRAYFORMULA J (Final)` | `computeFinal()` server-side |
| `PropertiesService SHEET_xxx` | `people.sheet_id` column |
| `BankInfo tab` | `accounts` table |
