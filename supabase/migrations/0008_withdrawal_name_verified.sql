-- Pine Tour — track whether a withdrawal's account name came from the bank.
--
-- Account name resolution only works with LIVE Paystack keys on an activated
-- business. In test mode Paystack refuses the lookup, and the app previously
-- filled the gap by inventing a plausible Nigerian name from a hardcoded pool,
-- keyed off a hash of the digits. That is worse than showing nothing: the
-- player sees a confident-looking name and assumes their account was checked.
--
-- Now the name is either genuinely resolved by the bank, or typed by the player
-- and marked unverified so whoever pays it knows to check first.

-- The server sets this itself by re-resolving at withdrawal time, so a tampered
-- client cannot claim an unverified name was checked by the bank.

alter table public.withdrawals
  add column if not exists name_verified boolean not null default false;

-- The NIP bank code (e.g. 058), kept alongside the display name. Needed to
-- resolve the account, and to initiate a real transfer later.
alter table public.withdrawals
  add column if not exists bank_code text;
