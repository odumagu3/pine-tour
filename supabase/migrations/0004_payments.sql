-- Pine Tour — real Paystack deposits.
--
-- Replaces the in-memory `paystackPending` map, which lost every in-flight
-- deposit on restart: a player could pay Paystack, the server could redeploy,
-- and the money would never reach their wallet.
--
-- This table is also the idempotency guard. A single deposit can be reported
-- twice — once by the client calling /verify and once by Paystack's webhook,
-- and the webhook itself retries for hours. `reference` is the primary key and
-- the credit is a compare-and-swap on status, so a wallet is credited exactly
-- once no matter how many times a reference is reported.
--
-- `amount` is what WE initialized, in naira. Verification compares it against
-- what Paystack says was actually paid, so a tampered client cannot ask for a
-- ₦100 charge and get a ₦100,000 credit.

create table if not exists public.payments (
  reference    text primary key,
  email        text not null references public.profiles(email) on delete cascade,
  amount       numeric(14,2) not null,
  status       text not null default 'pending',   -- pending | credited | failed
  channel      text,                              -- card | bank_transfer | ussd | …
  paid_amount  numeric(14,2),                     -- what Paystack reported
  credited_at  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists idx_payments_email_created
  on public.payments (email, created_at desc);

create index if not exists idx_payments_status
  on public.payments (status) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- The Render server uses the service_role key, which BYPASSES RLS entirely —
-- this policy only governs direct client (anon/authed) access.
-- ---------------------------------------------------------------------------
alter table public.payments enable row level security;

drop policy if exists "own payments read" on public.payments;
create policy "own payments read" on public.payments
  for select using (auth.jwt() ->> 'email' = email);
