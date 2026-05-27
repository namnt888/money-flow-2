-- ============================================================
-- MIGRATION 006: Audit Log + Row Level Security
-- ============================================================

create table if not exists public.audit_log (
  id            bigint generated always as identity primary key,
  entity_type   text not null,
  entity_id     uuid not null,
  action        text not null check (action in ('create','update','delete')),
  old_value     jsonb,
  new_value     jsonb,
  changed_by    text default 'system',
  created_at    timestamptz not null default now()
);

comment on table public.audit_log is 'Immutable audit trail for all mutations';

create index if not exists idx_audit_entity on public.audit_log(entity_type, entity_id);
create index if not exists idx_audit_date   on public.audit_log(created_at desc);

create or replace function public.audit_trigger_fn()
returns trigger language plpgsql security definer as $$
begin
  if TG_OP = 'INSERT' then
    insert into public.audit_log(entity_type, entity_id, action, new_value)
    values (TG_TABLE_NAME, NEW.id, 'create', to_jsonb(NEW));
    return NEW;
  elsif TG_OP = 'UPDATE' then
    insert into public.audit_log(entity_type, entity_id, action, old_value, new_value)
    values (TG_TABLE_NAME, NEW.id, 'update', to_jsonb(OLD), to_jsonb(NEW));
    return NEW;
  elsif TG_OP = 'DELETE' then
    insert into public.audit_log(entity_type, entity_id, action, old_value)
    values (TG_TABLE_NAME, OLD.id, 'delete', to_jsonb(OLD));
    return OLD;
  end if;
  return null;
end;
$$;

create or replace trigger audit_transactions
  after insert or update or delete on public.transactions
  for each row execute function public.audit_trigger_fn();

create or replace trigger audit_debts
  after insert or update or delete on public.debts
  for each row execute function public.audit_trigger_fn();

create or replace trigger audit_accounts
  after insert or update or delete on public.accounts
  for each row execute function public.audit_trigger_fn();

alter table public.accounts           enable row level security;
alter table public.transactions        enable row level security;
alter table public.debts               enable row level security;
alter table public.people              enable row level security;
alter table public.cashback_policies   enable row level security;
alter table public.cashback_cycles     enable row level security;
alter table public.budgets             enable row level security;
alter table public.recurring_services  enable row level security;
alter table public.installment_plans   enable row level security;
alter table public.business_categories enable row level security;

create policy "auth_full_access" on public.accounts           for all using (auth.role() = 'authenticated');
create policy "auth_full_access" on public.transactions        for all using (auth.role() = 'authenticated');
create policy "auth_full_access" on public.debts               for all using (auth.role() = 'authenticated');
create policy "auth_full_access" on public.people              for all using (auth.role() = 'authenticated');
create policy "auth_full_access" on public.cashback_policies   for all using (auth.role() = 'authenticated');
create policy "auth_full_access" on public.cashback_cycles     for all using (auth.role() = 'authenticated');
create policy "auth_full_access" on public.budgets             for all using (auth.role() = 'authenticated');
create policy "auth_full_access" on public.recurring_services  for all using (auth.role() = 'authenticated');
create policy "auth_full_access" on public.installment_plans   for all using (auth.role() = 'authenticated');
create policy "auth_full_access" on public.business_categories for all using (auth.role() = 'authenticated' or auth.role() = 'anon');
