-- ============================================================
--  010 — User accounts, so the Super Admin controls who can do what
--
--  Until now one PIN was shared by every volunteer, and a phone's block
--  was whatever it had saved in its own storage — which meant the server
--  had to take the phone's word for it. This replaces both: each person
--  gets an account, and their block comes from the signed session, not
--  from the browser.
--
--  Adds tables and one nullable column. Removes nothing. Safe to re-run.
-- ============================================================


-- --- 1. The accounts ----------------------------------------------------
create table if not exists app_users (
  id            uuid primary key default gen_random_uuid(),

  -- Who this is, in words the Super Admin will recognise on the day:
  -- "Ramesh — P5 gate" beats a uuid when someone rings up locked out.
  name          text not null,

  -- Digits only. Stored as typed, deliberately, and it is worth being
  -- clear why: a four-to-six digit PIN has at most a million values, so
  -- hashing buys almost nothing against anyone who can reach the table
  -- — and the table is reachable only by the server's secret key, never
  -- from a browser. What it costs is the thing that actually happens at
  -- an event: a volunteer forgets their PIN mid-rush and the Super Admin
  -- has to be able to read it back to them in five seconds.
  --
  -- The real defence against guessing is the rate limit below, not a hash.
  pin           text not null,

  role          text not null check (role in ('entry','search')),

  -- Which block this account may enter and correct. Exactly one, and only
  -- for entry accounts — see the constraint below.
  block_id      uuid references blocks(id) on delete restrict,

  -- The switch the whole feature exists for. Turning this off stops the
  -- account on its next request, not at its next login.
  is_active     boolean not null default true,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  last_login_at timestamptz
);

-- Two people must never share a PIN — the login looks an account up *by*
-- its PIN, so a duplicate would silently hand one person the other's block.
create unique index if not exists app_users_pin_unique on app_users (pin);
create index if not exists app_users_active_idx on app_users (is_active, role);

-- An entry account is meaningless without a block, and a help-desk account
-- must not carry one — it searches across all of them.
do $$
begin
  alter table app_users add constraint app_users_block_matches_role check (
    (role = 'entry'  and block_id is not null) or
    (role = 'search' and block_id is null)
  );
exception
  when duplicate_object then null;
end;
$$;

create or replace function touch_app_users_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists app_users_touch on app_users;
create trigger app_users_touch
  before update on app_users
  for each row execute function touch_app_users_updated_at();


-- --- 2. Who entered what -------------------------------------------------
-- Half of "control" is being able to answer "who put this in?". Nullable,
-- because the 1673 entries already in the table predate accounts.
--
-- set null on delete, not restrict: removing a volunteer's account months
-- later must not be blocked by the entries they made, and must certainly
-- not take those entries with it.
alter table vehicles
  add column if not exists user_id uuid references app_users(id) on delete set null;

create index if not exists vehicles_user_id_idx on vehicles (user_id);


-- --- 3. Guessing has to get expensive -----------------------------------
-- A six-digit PIN is a million guesses; unthrottled that is an afternoon's
-- work for a script. This is the actual protection on every PIN in the
-- system, including the Super Admin's.
create table if not exists login_attempts (
  id         bigserial primary key,
  ip         text not null,
  succeeded  boolean not null,
  at         timestamptz not null default now()
);

create index if not exists login_attempts_ip_at_idx on login_attempts (ip, at desc);

-- Old rows are noise. Called on each login, so the table cannot grow
-- without bound over a three-day event.
create or replace function prune_login_attempts()
returns void
language sql
as $$
  delete from login_attempts where at < now() - interval '1 day';
$$;


-- --- 4. Permissions ------------------------------------------------------
grant select, insert, update, delete on app_users      to service_role;
grant select, insert, delete         on login_attempts to service_role;
grant usage, select on sequence login_attempts_id_seq  to service_role;
grant execute on function prune_login_attempts()       to service_role;

alter table app_users      enable row level security;
alter table login_attempts enable row level security;

-- No anon policy anywhere near this. The table holds every PIN in the
-- system; there must be no path to it from a browser.
revoke all on app_users      from anon, authenticated;
revoke all on login_attempts from anon, authenticated;


notify pgrst, 'reload schema';
