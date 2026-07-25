-- Pine Tour — withdrawal requests.
--
-- Payouts are not wired to Paystack Transfers, so a withdrawal is a REQUEST an
-- admin fulfils by hand and then marks paid. Until now the bank details the
-- player typed were thrown away entirely — the server received account number
-- and name and never stored them, so there was no way to actually pay anyone.
--
-- The wallet is debited the moment the request is made, so the same balance
-- can't be withdrawn twice while a request sits in the queue. Rejecting a
-- request refunds it.

create table if not exists public.withdrawals (
  id             text primary key default gen_random_uuid()::text,
  email          text not null references public.profiles(email) on delete cascade,
  amount         numeric(14,2) not null,
  bank_name      text,
  account_number text,
  account_name   text,
  status         text not null default 'pending',  -- pending | paid | rejected
  note           text,
  transaction_id text,        -- the ledger entry, so its status can follow along
  created_at     timestamptz not null default now(),
  processed_at   timestamptz
);

create index if not exists idx_withdrawals_status_created
  on public.withdrawals (status, created_at desc);

create index if not exists idx_withdrawals_email_created
  on public.withdrawals (email, created_at desc);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- The Render server uses the service_role key, which BYPASSES RLS entirely —
-- this policy only governs direct client (anon/authed) access.
-- ---------------------------------------------------------------------------
alter table public.withdrawals enable row level security;

-- A player may read their own requests. Bank details are sensitive, so there is
-- deliberately no policy granting anyone else access: the admin panel reads
-- them through the server's service-role key, gated by the admin passcode.
drop policy if exists "own withdrawals read" on public.withdrawals;
create policy "own withdrawals read" on public.withdrawals
  for select using (auth.jwt() ->> 'email' = email);
