-- Pine Tour — admin-controlled All Hands on Deck kickoff.
--
-- Previously a game started on its own: the moment enough humans sat down it
-- dealt, and any seated player could also force it with "Play now". That left
-- no window in which an admin could look at the table and decide anything.
--
-- With this on, neither happens — the game waits until an admin starts it from
-- the panel.
--
-- Persisted rather than in-memory on purpose: a Render restart must not
-- silently hand kickoff back to the players.

alter table public.admin_config
  add column if not exists all_hands_admin_start boolean not null default true;
