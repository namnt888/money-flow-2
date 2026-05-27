-- ============================================================
-- MIGRATION 003: Cashback Engine
-- ============================================================

create table if not exists public.cashback_policies (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references public.accounts(id) on delete cascade,
  policy_name         text not null,
  cb_rate             numeric(5,2) not null default 0,
  cb_min_spend        bigint not null default 0,
  cb_max_budget       bigint,
  cycle_type          text not null default 'calendar'
                        check (cycle_type in ('calendar', 'statement')),
  statement_start_day smallint,
  cashback_mode       text not null default 'percent'
                        check (cashback_mode in ('percent', 'fixed', 'tiered')),
  excluded_categories text[],
  is_active           boolean not null default true,
  valid_from          date not null default current_date,
  valid_to            date,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.cashback_policies is 'Cashback rules per account';

create table if not exists public.cashback_cycles (
  id                  uuid primary key default gen_random_uuid(),
  account_id          uuid not null references public.accounts(id) on delete cascade,
  policy_id           uuid references public.cashback_policies(id),
  cycle_tag           text not null,
  cycle_start         date not null,
  cycle_end           date not null,
  total_spend         bigint not null default 0,
  cb_earned           bigint not null default 0,
  cb_clawback         bigint not null default 0,
  cb_net              bigint generated always as (cb_earned - cb_clawback) stored,
  min_spend_met       boolean not null default false,
  budget_capped       boolean not null default false,
  status              text not null default 'open'
                        check (status in ('open', 'locked', 'paid')),
  paid_at             date,
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (account_id, cycle_tag)
);

comment on table public.cashback_cycles is 'Monthly cashback snapshot per account';

create index if not exists idx_cb_cycle_tag on public.cashback_cycles(cycle_tag);
create index if not exists idx_cb_account   on public.cashback_cycles(account_id);

create or replace view public.v_cashback_cycle_summary as
select
  t.source_account_id                     as account_id,
  coalesce(t.persisted_cycle_tag,
    to_char(t.occurred_at, 'YYYY-MM'))    as cycle_tag,
  sum(t.amount)                           as total_spend,
  sum(case
    when t.type = 'refund' then 0
    else round(t.amount * coalesce(p.cb_rate,0) / 100)
  end)                                    as cb_earned_raw,
  count(*)                                as txn_count
from public.transactions t
left join public.cashback_policies p
  on p.account_id = t.source_account_id and p.is_active = true
where
  t.status = 'posted'
  and t.type not in ('transfer_out', 'transfer_in')
group by 1, 2;
