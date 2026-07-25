-- Pine Tour — referrals
--
-- Every profile gets a short, shareable referral code. A signed-in player copies
-- their link (…/?ref=CODE) and sends it out; the invitee opens it while logged
-- OUT, the code rides along through sign-up, and once that invitee buys tickets
-- the referrer is credited one free ticket — up to a per-referrer cap.
--
-- The `referrals` table is the ledger that makes the payout idempotent: one row
-- per invitee (unique), flipped from 'pending' to 'rewarded' exactly once.

-- ---------------------------------------------------------------------------
-- profiles.referral_code — the code a player shares. Nullable because existing
-- rows are backfilled lazily (the server mints one the first time it's needed).
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists referral_code text;

-- Partial unique index: codes must not collide, but many rows may still be null.
create unique index if not exists idx_profiles_referral_code
  on public.profiles (referral_code)
  where referral_code is not null;

-- ---------------------------------------------------------------------------
-- referrals — one row per invitee.
--   status 'pending'  → signed up through a link, has not bought tickets yet
--   status 'rewarded' → invitee bought tickets, referrer was credited
--   status 'capped'   → invitee qualified but the referrer had hit their cap
-- ---------------------------------------------------------------------------
create table if not exists public.referrals (
  id             text primary key default gen_random_uuid()::text,
  referrer_email text not null references public.profiles(email) on delete cascade,
  referred_email text not null unique references public.profiles(email) on delete cascade,
  code           text not null,
  status         text not null default 'pending',
  rewarded_at    timestamptz,
  created_at     timestamptz not null default now(),
  -- A player can never refer themselves.
  constraint referrals_no_self_referral check (referrer_email <> referred_email)
);

create index if not exists idx_referrals_referrer
  on public.referrals (referrer_email, status);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- The Render server uses the service_role key, which BYPASSES RLS entirely —
-- this policy only governs direct client (anon/authed) access.
-- ---------------------------------------------------------------------------
alter table public.referrals enable row level security;

-- A signed-in user may read the referrals they made (never anyone else's, and
-- never the rows where they are the invitee — who invited them is not theirs).
drop policy if exists "own referrals read" on public.referrals;
create policy "own referrals read" on public.referrals
  for select using (auth.jwt() ->> 'email' = referrer_email);
