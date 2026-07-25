-- Pine Tour — per-user withdrawal PIN.
--
-- The withdrawal gate was previously the literal string '1234' compared in
-- code, identical for every account. Anyone who read the error message ("Default
-- secure PIN is 1234") could drain any verified wallet they had access to.
--
-- Stored as a PBKDF2-SHA256 hash with a per-user salt, in the format
--   pbkdf2$<iterations>$<salt-hex>$<derived-hex>
-- so the iteration count can be raised later without invalidating old PINs.
-- The hash is never sent to the client; the profile only exposes a boolean.

alter table public.profiles
  add column if not exists withdrawal_pin_hash text;
