# Transaction Parser — Supported Input Formats

The LLM parser must handle 2 raw input formats from Google Sheets paste.

---

## Format A — With Account Header

```
Tuấn - cycle 2026-05
A. Shopee
Type  Date   Notes                  Amount        % Back  Account
Out   25-12  17 PM 512 - Góp Tech   40.399.000    0,00    Tpbank
Out   01-01  Voucher TGDĐ 6.3       6.300.000     4,00    Vpbank
```

**Parse rules:**
- `person` = "Tuấn", `cycle_tag` = "2026-05"
- `merchant` = section header ("Shopee")
- `type` = Out → `expense`
- `amount` = strip dots → integer (40.399.000 → 40399000)
- `cb_rate` = % Back column (0,00 → 0, 4,00 → 4)
- `source_account_id` = lookup by bank_name ("Tpbank", "Vpbank")
- `date` format: DD-MM within the cycle year → full date "2025-12-25"

---

## Format B — Without Account Column (inherit from section)

```
B. Lazada - Thẻ Msb
Type  Date   Notes                  Amount        % Back
Out   25-12  17 PM 512 - Góp Tech   40.399.000    0,00
Out   01-01  Voucher TGDĐ 6.3       6.300.000     4,00
```

**Parse rules:**
- `source_account` = extract from section header → "Msb" (after last `-`)
- All other rules same as Format A
- `cb_rate` is per-row (not inherited)

---

## LLM Output Schema

Must return JSON array for `bulk_insert_parsed_txns`:

```json
[
  {
    "occurred_at": "2025-12-25",
    "type": "expense",
    "amount": 40399000,
    "source_account_id": "<uuid>",
    "merchant": "Shopee",
    "notes": "17 PM 512 - Góp Tech",
    "cycle_tag": "2026-05",
    "cb_rate": 0,
    "raw_input": "Out   25-12  17 PM 512...",
    "parsed_by": "llm"
  }
]
```

---

## Notes Field Rules
- Keep original notes text
- Append installment info if detected: `"Góp Tech → installment_plan"`
- `cb_rate` stored in cashback_cycles, not in transaction directly
