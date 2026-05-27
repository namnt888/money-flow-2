-- ============================================================
-- MIGRATION 002: Transactions
-- ============================================================

create table if not exists public.transactions (
  id                    uuid primary key default gen_random_uuid(),
  occurred_at           date not null,
  posted_at             date,
  type                  text not null check (type in (
                          'expense','income','transfer_out','transfer_in',
                          'debt','repayment','refund','installment','service'
                        )),
  status                text not null default 'posted'
                          check (status in ('posted', 'pending', 'void')),
  amount                bigint not null check (amount > 0),
  source_account_id     uuid not null references public.accounts(id),
  dest_account_id       uuid references public.accounts(id),
  category_id           uuid references public.business_categories(id),
  person_id             uuid references public.people(id),
  notes                 text,
  merchant              text,
  persisted_cycle_tag   text,
  original_txn_id       uuid references public.transactions(id),
  debt_id               uuid,
  installment_plan_id   uuid,
  recurring_service_id  uuid,
  raw_input             text,
  parsed_by             text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.transactions is 'All money movements — source of truth for balances';

create index if not exists idx_txn_account      on public.transactions(source_account_id);
create index if not exists idx_txn_occurred_at  on public.transactions(occurred_at desc);
create index if not exists idx_txn_cycle_tag    on public.transactions(persisted_cycle_tag);
create index if not exists idx_txn_status       on public.transactions(status);
create index if not exists idx_txn_type         on public.transactions(type);
create index if not exists idx_txn_person       on public.transactions(person_id);

-- Balance recalc function
create or replace function public.recalc_account_balance(acc_id uuid)
returns void language plpgsql as $$
begin
  update public.accounts
  set
    current_balance = (
      select coalesce(sum(case
        when t.type in ('income','transfer_in','refund','repayment') then  t.amount
        when t.type in ('expense','transfer_out','debt','installment','service') then -t.amount
        else 0
      end), 0)
      from public.transactions t
      where t.source_account_id = acc_id and t.status = 'posted'
    ),
    updated_at = now()
  where id = acc_id;

  update public.accounts
  set available_credit = credit_limit + current_balance
  where id = acc_id and account_type = 'credit';
end;
$$;

create or replace function public.trigger_recalc_balance()
returns trigger language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    perform public.recalc_account_balance(OLD.source_account_id);
    if OLD.dest_account_id is not null then
      perform public.recalc_account_balance(OLD.dest_account_id);
    end if;
    return OLD;
  else
    perform public.recalc_account_balance(NEW.source_account_id);
    if NEW.dest_account_id is not null then
      perform public.recalc_account_balance(NEW.dest_account_id);
    end if;
    return NEW;
  end if;
end;
$$;

create or replace trigger txn_balance_sync
  after insert or update or delete
  on public.transactions
  for each row execute function public.trigger_recalc_balance();
