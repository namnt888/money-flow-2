-- ============================================================
-- MIGRATION 001: Core Schema
-- Tables: accounts, people, business_categories
-- ============================================================

-- Enable UUID extension
create extension if not exists "pgcrypto";

-- ============================================================
-- TABLE: people
-- ============================================================
create table if not exists public.people (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  phone         text,
  relationship  text,           -- 'friend' | 'family' | 'colleague' | 'other'
  is_active     boolean not null default true,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table public.people is 'Contacts used in debt/repayment tracking';

-- ============================================================
-- TABLE: business_categories
-- 2-tier hierarchy: Level 1 (group) → Level 2 (detail)
-- ============================================================
create table if not exists public.business_categories (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,         -- e.g. 'FOOD', 'FOOD_DELIVERY'
  name_vi         text not null,
  parent_code     text references public.business_categories(code),
  level           smallint not null check (level in (1, 2)),
  tx_group        text not null check (tx_group in ('expense', 'income', 'transfer')),
  affects_cashback boolean not null default true,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);

comment on table public.business_categories is 'Transaction category taxonomy (2-tier)';

-- Seed Level-1 categories
insert into public.business_categories (code, name_vi, level, tx_group, affects_cashback) values
  ('FOOD',        'Ăn uống',             1, 'expense', true),
  ('SHOPPING',    'Mua sắm',             1, 'expense', true),
  ('TRANSPORT',   'Di chuyển',           1, 'expense', true),
  ('HEALTH',      'Sức khỏe',            1, 'expense', true),
  ('ENTERTAIN',   'Giải trí',            1, 'expense', true),
  ('EDUCATION',   'Giáo dục',            1, 'expense', true),
  ('BILLS',       'Hóa đơn & Dịch vụ',  1, 'expense', true),
  ('INVEST',      'Đầu tư',              1, 'expense', false),
  ('INCOME',      'Thu nhập',            1, 'income',  false),
  ('TRANSFER',    'Chuyển khoản nội bộ', 1, 'transfer',false),
  ('DEBT',        'Vay / Nợ',            1, 'expense', true),
  ('OTHER',       'Khác',                1, 'expense', true)
on conflict (code) do nothing;

-- ============================================================
-- TABLE: accounts
-- ============================================================
create table if not exists public.accounts (
  id                  uuid primary key default gen_random_uuid(),
  name                text not null,
  account_type        text not null check (account_type in (
                        'credit', 'debit', 'savings', 'e_wallet', 'cash'
                      )),
  bank_name           text,                    -- 'Tpbank' | 'Vpbank' | 'MSB' …
  last4               text,                    -- last 4 digits for display
  credit_limit        bigint,                  -- NULL for debit/cash
  current_balance     bigint not null default 0, -- computed via trigger, VND
  available_credit    bigint,                  -- credit_limit - current_balance
  parent_account_id   uuid references public.accounts(id),
  is_primary          boolean not null default false,
  is_active           boolean not null default true,
  color               text,                    -- hex for UI badge
  icon                text,                    -- icon slug
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.accounts is 'Bank accounts, credit cards, e-wallets, cash';

-- Constraint: only 1 primary account
create unique index if not exists accounts_primary_unique
  on public.accounts(is_primary)
  where is_primary = true;
