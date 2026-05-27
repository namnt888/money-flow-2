-- ============================================================
-- MIGRATION 004: Debt + Installment Plans
-- ============================================================

create table if not exists public.debts (
  id                  uuid primary key default gen_random_uuid(),
  person_id           uuid not null references public.people(id),
  account_id          uuid not null references public.accounts(id),
  debt_role           text not null check (debt_role in ('lent', 'borrowed')),
  original_amount     bigint not null check (original_amount > 0),
  repaid_amount       bigint not null default 0,
  remaining_amount    bigint generated always as (original_amount - repaid_amount) stored,
  status              text not null default 'pending'
                        check (status in ('pending', 'partial', 'settled', 'cancelled')),
  due_date            date,
  occurred_at         date not null default current_date,
  notes               text,
  cycle_tag           text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.debts is 'Lent/borrowed money tracker';

create index if not exists idx_debt_person on public.debts(person_id);
create index if not exists idx_debt_status on public.debts(status);
create index if not exists idx_debt_cycle  on public.debts(cycle_tag);

alter table public.transactions
  add constraint fk_txn_debt
  foreign key (debt_id) references public.debts(id);

create or replace function public.sync_debt_repaid()
returns trigger language plpgsql as $$
begin
  if NEW.debt_id is not null and NEW.type = 'repayment' then
    update public.debts
    set
      repaid_amount = (
        select coalesce(sum(amount), 0)
        from public.transactions
        where debt_id = NEW.debt_id and type = 'repayment' and status = 'posted'
      ),
      updated_at = now()
    where id = NEW.debt_id;

    update public.debts
    set status = case
      when remaining_amount <= 0 then 'settled'
      when repaid_amount > 0     then 'partial'
      else 'pending'
    end
    where id = NEW.debt_id;
  end if;
  return NEW;
end;
$$;

create or replace trigger txn_debt_sync
  after insert or update or delete
  on public.transactions
  for each row execute function public.sync_debt_repaid();

create table if not exists public.installment_plans (
  id                    uuid primary key default gen_random_uuid(),
  plan_name             text not null,
  account_id            uuid not null references public.accounts(id),
  original_txn_id       uuid references public.transactions(id),
  debt_id               uuid references public.debts(id),
  principal_amount      bigint not null,
  total_installments    smallint not null,
  installment_amount    bigint not null,
  installments_paid     smallint not null default 0,
  payment_day           smallint check (payment_day between 1 and 31),
  next_payment_date     date,
  is_auto_post          boolean not null default false,
  status                text not null default 'active'
                          check (status in ('active', 'completed', 'cancelled')),
  started_at            date not null default current_date,
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table public.installment_plans is 'Installment payment tracker (N-kỳ góp)';

alter table public.transactions
  add constraint fk_txn_installment
  foreign key (installment_plan_id) references public.installment_plans(id);
