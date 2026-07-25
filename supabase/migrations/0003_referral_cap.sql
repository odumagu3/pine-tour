-- Pine Tour — make the referral reward cap admin-configurable.
--
-- Was a hardcoded constant in server.ts; now it lives alongside the rest of the
-- ticket economy so it can be changed from the admin panel without a redeploy.
-- 0 disables referral rewards entirely (links still work, nothing pays out).

alter table public.admin_config
  add column if not exists referral_reward_cap integer not null default 10;
