-- SOLARIS — Postgres schema for Supabase.
--
-- Four things are stored: the prompt list, the people recording, what each
-- person has answered, and a log per sitting. The audio itself is NOT here.
-- Recordings go to object storage (Supabase Storage or a disk); a database is
-- the wrong place for a few hundred thousand WAV files, and keeping them out
-- means the archive can be copied, checksummed and backed up on its own terms.
--
-- Apply with:  psql "$SUPABASE_DB_URL" -f db/schema.sql
-- or paste into the Supabase SQL editor.

-- ── Reference data ───────────────────────────────────────────────────────────

create table if not exists categories (
  id           text primary key,           -- 'places', 'animals', …
  name         text not null,
  icon         text not null,              -- key into the app's icon sprite
  accent       text not null,
  description  text,
  sort_order    int  not null default 0
);

create table if not exists words (
  id         text primary key,             -- 'tel_pl_001', also the folder name
  category   text not null references categories(id) on delete restrict,
  te         text not null,                -- the Telugu prompt
  translit   text,
  en         text,
  level      int,
  word_order int,
  -- Retired prompts stay in the table: recordings already reference them.
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists words_category_idx on words (category) where active;

-- ── Server secrets ───────────────────────────────────────────────────────────
--
-- The key that signs session tokens. It lives in the database so that two
-- servers pointed at the same project issue tokens the other will accept, and
-- so a redeploy does not silently sign everyone out.

create table if not exists app_secrets (
  key        text primary key,
  value      text not null,
  created_at timestamptz not null default now()
);

-- ── People ───────────────────────────────────────────────────────────────────

create table if not exists contributors (
  username      text primary key,          -- lowercase, 3-32 chars
  display_name  text not null,
  -- scrypt hash and its salt. Never leaves the server, never sent to a client.
  password_hash text not null,
  password_salt text not null,
  xp            int  not null default 0,
  words_count   int  not null default 0,
  streak        int  not null default 0,
  best_streak   int  not null default 0,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz,
  last_contribution_at timestamptz
);

-- ── What has been answered ───────────────────────────────────────────────────

-- One row per contributor per word. The primary key is the pair, so a repeat
-- submission cannot double-count coverage — the insert simply conflicts.
create table if not exists contributions (
  contributor text not null references contributors(username) on delete cascade,
  word_id     text not null references words(id) on delete restrict,
  outcome     text not null check (outcome in ('recorded', 'skipped')),
  quality     int,                          -- 0-100, null for a skip
  xp_awarded  int  not null default 0,
  duration_ms int,
  storage_path text,                        -- where the audio landed
  created_at  timestamptz not null default now(),
  primary key (contributor, word_id)
);

create index if not exists contributions_word_idx on contributions (word_id) where outcome = 'recorded';
create index if not exists contributions_contributor_idx on contributions (contributor);

-- Coverage per word, for the assignment to favour thin prompts.
create or replace view word_coverage as
  select w.id as word_id,
         w.category,
         count(c.contributor) filter (where c.outcome = 'recorded') as voices
    from words w
    left join contributions c on c.word_id = w.id
   group by w.id, w.category;

-- ── Session logs ─────────────────────────────────────────────────────────────

create table if not exists sessions (
  id          uuid primary key default gen_random_uuid(),
  contributor text not null references contributors(username) on delete cascade,
  category    text references categories(id) on delete set null,
  started_at  timestamptz not null,
  finished_at timestamptz not null,
  ended_how   text not null check (ended_how in ('completed', 'quit')),
  xp          int not null default 0,
  recorded    int not null default 0,
  skipped     int not null default 0,
  detail      jsonb                          -- the per-prompt run sheet
);

create index if not exists sessions_contributor_idx on sessions (contributor, finished_at desc);

-- ── Access ───────────────────────────────────────────────────────────────────
--
-- Every one of these tables is reached only through the SOLARIS server, using
-- the service role key. No browser ever holds a Supabase key, so row-level
-- security is enabled with no permissive policy: anon and authenticated roles
-- can read nothing. If the app is ever changed to talk to Supabase directly
-- from the phone, policies have to be written before that ships — leaving RLS
-- off would expose every password hash in the table.

alter table app_secrets  enable row level security;
alter table categories   enable row level security;
alter table words        enable row level security;
alter table contributors enable row level security;
alter table contributions enable row level security;
alter table sessions     enable row level security;
