-- ============================================================
-- MIGRATION 005: Budgets + Recurring Services
-- ============================================================

create table if not exists public.budgets (
  id              uuid primary key default gen_random_uuid(),
  category_id     uuid not null references public.business_categories(id),
  owner_note      text,
  amount          bigint not null check (amount > 0),
  cycle_type      text not null default 'monthly'
                    check (cycle_type in ('monthly', 'quarterly', 'yearly', 'custom')),
  start_date      date not null,
  end_date        date,
  is_rollover     boolean not null default false,
  status          text not null default 'active'
                    check (status in ('active', 'completed', 'exceeded', 'archived')),
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table public.budgets is 'Spending budgets per category per period';

create or replace view public.v_budget_spend as
select
  b.id                                              as budget_id,
  b.category_id,
  b.amount                                          as budgeted,
  coalesce(sum(t.amount), 0)                        as spent,
  greatest(0, b.amount - coalesce(sum(t.amount),0)) as remaining,
  round(coalesce(sum(t.amount),0) * 100.0 / b.amount, 1) as pct_used
from public.budgets b
left join public.transactions t
  on  t.category_id = b.category_id
  and t.occurred_at between b.start_date and coalesce(b.end_date, current_date)
  and t.status = 'posted'
  and t.type in ('expense', 'debt', 'service', 'installment')
where b.status = 'active'
group by b.id, b.category_id, b.amount;

create table if not exists public.recurring_services (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  account_id            uuid not null references public.accounts(id),
  category_id           uuid references public.business_categories(id),
  amount                bigint not null,
  billing_cycle         text not null default 'monthly'
                          check (billing_cycle in ('weekly','monthly','quarterly','yearly')),
  billing_day           smallint check (billing_day between 1 and 31),
  next_due_date         date,
  reminder_days_before  smallint not null default 3,
  is_auto_charge        boolean not null default false,
  is_active             boolean not null default true,
  notes                 text,
  last_charged_at       date,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.recurring_services is 'Subscriptions and recurring bills';

alter table public.transactions
  add constraint fk_txn_service
  foreign key (recurring_service_id) references public.recurring_services(id);
