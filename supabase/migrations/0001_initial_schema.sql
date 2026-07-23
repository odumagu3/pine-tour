-- Pine Tour — initial schema (Option B migration, Phase 1)
-- Tables: profiles, transactions, admin_config
-- Money stored as numeric(14,2); PostgREST serializes numeric as a JSON number,
-- so it maps cleanly onto the app's existing number-based balance logic.

-- ---------------------------------------------------------------------------
-- updated_at helper
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles — one row per player. Email is the app-level identity (the game
-- engine keys on it); user_id links to Supabase Auth once the player signs in.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  email               text primary key,
  user_id             uuid references auth.users(id) on delete set null,
  balance             numeric(14,2) not null default 0,
  total_earnings      numeric(14,2) not null default 0,
  games_played        integer not null default 0,
  games_won           integer not null default 0,
  highest_roll        integer not null default 0,
  tickets             integer not null default 0,
  free_game_used      boolean not null default false,
  verification_status text not null default 'unverified',
  verification_details jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

drop trigger if exists trg_profiles_updated_at on public.profiles;
create trigger trg_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- transactions — wallet ledger entries (deposits, withdrawals, tickets, wins)
-- ---------------------------------------------------------------------------
create table if not exists public.transactions (
  id            text primary key default gen_random_uuid()::text,
  email         text not null references public.profiles(email) on delete cascade,
  type          text not null,                 -- deposit | withdrawal | ticket | win
  amount        numeric(14,2) not null,
  status        text not null default 'completed',
  method        text,
  tx_hash       text,
  balance_after numeric(14,2),
  created_at    timestamptz not null default now()
);

create index if not exists idx_transactions_email_created
  on public.transactions (email, created_at desc);

-- ---------------------------------------------------------------------------
-- admin_config — single authoritative row (id is pinned to 1).
-- Holds the admin passcode, so it must never be readable by anon (RLS below).
-- ---------------------------------------------------------------------------
create table if not exists public.admin_config (
  id                 integer primary key default 1 check (id = 1),
  arena_name         text not null default 'Neon Whot! Bet',
  default_room_id    text not null default 'VaporSuite',
  prize_mode         text not null default 'random',
  fixed_sponsor_name text not null default 'IgniTech',
  fixed_prize        numeric(14,2) not null default 100000,
  sponsor_pool       text[] not null default array[
    'MTN Naija','Glo Mobile','Airtel Africa','Dangote Group','GTBank',
    'Jumia','Paystack','Bet9ja','Flutterwave','Indomie'],
  prize_min          numeric(14,2) not null default 25000,
  prize_max          numeric(14,2) not null default 200000,
  ticket_pack_price  numeric(14,2) not null default 3800,
  ticket_pack_size   integer not null default 8,
  free_game_enabled  boolean not null default true,
  turn_timer_seconds integer not null default 20,
  max_players        integer not null default 4,
  auto_bot_fill      boolean not null default true,
  admin_emails       text[] not null default array['hudozit@gmail.com'],
  admin_passcode     text not null default 'whot-admin',
  updated_at         timestamptz not null default now()
);

drop trigger if exists trg_admin_config_updated_at on public.admin_config;
create trigger trg_admin_config_updated_at
  before update on public.admin_config
  for each row execute function public.set_updated_at();

-- Seed the single config row (no-op if it already exists).
insert into public.admin_config (id) values (1)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- The Render server uses the service_role key, which BYPASSES RLS entirely —
-- so these policies only govern direct client (anon/authed) access.
-- ---------------------------------------------------------------------------
alter table public.profiles     enable row level security;
alter table public.transactions enable row level security;
alter table public.admin_config enable row level security;

-- profiles: a signed-in user may read & update only their own row (matched by email).
drop policy if exists "own profile read"   on public.profiles;
drop policy if exists "own profile update" on public.profiles;
create policy "own profile read"   on public.profiles
  for select using (auth.jwt() ->> 'email' = email);
create policy "own profile update" on public.profiles
  for update using (auth.jwt() ->> 'email' = email);

-- transactions: a signed-in user may read only their own ledger entries.
drop policy if exists "own transactions read" on public.transactions;
create policy "own transactions read" on public.transactions
  for select using (auth.jwt() ->> 'email' = email);

-- admin_config: no anon/authed policies at all → only service_role can touch it.
