-- ============================================================
-- MIGRATION 007: Parser API Helpers
-- Functions to support CLI/LLM raw text → txn insert
-- ============================================================

-- ============================================================
-- FUNCTION: upsert_transaction
-- Called by Next.js API route after LLM parses raw input
-- ============================================================
create or replace function public.upsert_transaction(
  p_occurred_at         date,
  p_type                text,
  p_amount              bigint,
  p_source_account_id   uuid,
  p_category_id         uuid default null,
  p_person_id           uuid default null,
  p_notes               text default null,
  p_merchant            text default null,
  p_cycle_tag           text default null,
  p_raw_input           text default null,
  p_parsed_by           text default 'llm'
)
returns uuid language plpgsql as $$
declare
  v_txn_id uuid;
  v_cycle  text;
begin
  -- Auto-derive cycle tag if not provided
  v_cycle := coalesce(p_cycle_tag, to_char(p_occurred_at, 'YYYY-MM'));

  insert into public.transactions (
    occurred_at, type, amount,
    source_account_id, category_id, person_id,
    notes, merchant, persisted_cycle_tag,
    raw_input, parsed_by
  ) values (
    p_occurred_at, p_type, p_amount,
    p_source_account_id, p_category_id, p_person_id,
    p_notes, p_merchant, v_cycle,
    p_raw_input, p_parsed_by
  )
  returning id into v_txn_id;

  return v_txn_id;
end;
$$;

comment on function public.upsert_transaction is
  'Insert a parsed transaction. Balance + cashback recalc via triggers.';

-- ============================================================
-- FUNCTION: bulk_insert_parsed_txns
-- Insert multiple txns from LLM parse result (JSON array)
-- Input: [{occurred_at, type, amount, source_account_id, ...}]
-- ============================================================
create or replace function public.bulk_insert_parsed_txns(
  p_txns jsonb
)
returns setof uuid language plpgsql as $$
declare
  rec jsonb;
  v_id uuid;
begin
  for rec in select * from jsonb_array_elements(p_txns)
  loop
    select public.upsert_transaction(
      (rec->>'occurred_at')::date,
      rec->>'type',
      (rec->>'amount')::bigint,
      (rec->>'source_account_id')::uuid,
      (rec->>'category_id')::uuid,
      (rec->>'person_id')::uuid,
      rec->>'notes',
      rec->>'merchant',
      rec->>'cycle_tag',
      rec->>'raw_input',
      coalesce(rec->>'parsed_by', 'llm')
    ) into v_id;
    return next v_id;
  end loop;
end;
$$;

comment on function public.bulk_insert_parsed_txns is
  'Bulk insert parsed transactions from LLM JSON array output';
