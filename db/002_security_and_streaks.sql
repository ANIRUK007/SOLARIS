-- Streaks by day, and the columns security needs.
--
-- A streak counted in consecutive good takes reset the moment someone put the
-- phone down, which made it meaningless. Counting days a person contributed is
-- what the word means to anyone using an app like this, and it rewards coming
-- back rather than sitting still.
--
-- Apply after db/schema.sql:  psql "$SUPABASE_DB_URL" -f db/002_security_and_streaks.sql

alter table contributors
  -- The last day this person contributed, in the project's timezone. A date,
  -- not a timestamp: "did they contribute yesterday" is a question about days,
  -- and answering it from an instant means re-deriving the timezone every time.
  add column if not exists last_contribution_day date,

  -- Bumped to invalidate every token already issued to this account: a
  -- password change, or a session signed out everywhere. Tokens carry the
  -- epoch they were signed with and are refused when it no longer matches.
  add column if not exists token_epoch int not null default 0,

  -- Failed sign-ins, and the point until which further attempts are refused.
  -- Without this a password is only as strong as the attacker's patience.
  add column if not exists failed_logins int not null default 0,
  add column if not exists locked_until timestamptz;

comment on column contributors.streak is
  'Consecutive days with at least one recording, in the project timezone';

create index if not exists contributors_last_day_idx on contributors (last_contribution_day);
