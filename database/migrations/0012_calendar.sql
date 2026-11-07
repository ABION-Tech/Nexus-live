-- 0012_calendar.sql
-- PRD §10.5 CalendarService / §8.2 Calendar: Google Calendar integration
-- with write-back. Per-user OAuth connections (offline access,
-- calendar-scoped — deliberately separate from login's online/openid
-- scope, see calendarOAuthService.ts), one or more synced calendars per
-- connection, and a local mirror of events for fast reads + the merged
-- cross-calendar agenda view. "Whoever connects a shared calendar first
-- owns the sync" (SESSION_LOG) falls out of this shape for free: a
-- shared Google calendar is just a google_calendar_id some user's
-- connection happens to have access to — no separate "org calendar"
-- table or code path.
--
-- Same conventions as every prior migration: uuid pk, non-null org_id FK,
-- RLS via the tenant_isolation policy loop (DECISIONS.md §3).

-- ---------------------------------------------------------------------
-- calendar_connections — one row per (org, user, Google account) OAuth
-- grant. google_sub (Google's stable subject id) is part of the
-- upsert key alongside user_id so reconnecting the *same* Google account
-- updates in place, but a user connecting a *second* Google account
-- gets a second row rather than clobbering the first.
-- ---------------------------------------------------------------------
create table calendar_connections (
  id                        uuid primary key default gen_random_uuid(),
  org_id                    uuid not null references organizations(id),
  user_id                   uuid not null references users(id) on delete cascade,
  google_email              text not null,
  google_sub                text not null,
  refresh_token             text not null, -- encrypted at the application layer before storage, PRD §13.6 — see DEPLOYMENT.md
  access_token              text,
  access_token_expires_at   timestamptz,
  scopes                    text not null,
  created_at                timestamptz not null default now(),
  revoked_at                timestamptz,
  unique (org_id, user_id, google_sub)
);
create index idx_calendar_connections_org on calendar_connections(org_id);
create index idx_calendar_connections_user on calendar_connections(user_id);

-- ---------------------------------------------------------------------
-- calendar_subscriptions — a specific Google calendar (from a
-- connection's calendar list) the org has chosen to sync into NEXUS.
-- channel_id/resource_id/channel_expires_at back the push-webhook
-- registration (calendarSyncService.ts watchCalendar); sync_token backs
-- incremental sync. Both are nullable because a freshly-created
-- subscription runs its first sync (and channel registration)
-- synchronously right after this row is inserted (calendarService.ts's
-- createSubscription), not atomically with it.
-- ---------------------------------------------------------------------
create table calendar_subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organizations(id),
  connection_id         uuid not null references calendar_connections(id) on delete cascade,
  google_calendar_id    text not null,
  calendar_name         text not null,
  added_by_user_id      uuid references users(id),
  is_active             boolean not null default true,
  sync_token            text,
  channel_id            text,
  resource_id           text,
  channel_expires_at    timestamptz,
  last_synced_at        timestamptz,
  last_sync_error       text,
  created_at            timestamptz not null default now(),
  revoked_at            timestamptz,
  unique (connection_id, google_calendar_id)
);
create index idx_calendar_subscriptions_org on calendar_subscriptions(org_id);
create index idx_calendar_subscriptions_connection on calendar_subscriptions(connection_id);
-- Webhook deliveries arrive keyed by channel_id with no org context —
-- this index is what makes find_subscription_by_channel_id below cheap.
create index idx_calendar_subscriptions_channel on calendar_subscriptions(channel_id) where channel_id is not null;

-- ---------------------------------------------------------------------
-- calendar_events — local mirror of synced Google events, kept current
-- by incrementalSync. Source of truth remains Google; this table exists
-- so the merged agenda view (PRD §8.2 Calendar) and write-back "which
-- event/calendar/connection does this row belong to" lookups don't need
-- a live Google API round-trip on every read.
-- ---------------------------------------------------------------------
create table calendar_events (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organizations(id),
  subscription_id       uuid not null references calendar_subscriptions(id) on delete cascade,
  google_event_id       text not null,
  title                 text,
  description           text,
  location              text,
  all_day               boolean not null default false,
  start_at              timestamptz,
  end_at                timestamptz,
  start_date            date,
  end_date              date,
  status                text not null default 'confirmed' check (status in ('confirmed', 'tentative', 'cancelled')),
  html_link             text,
  attendees             jsonb,
  created_by_user_id    uuid references users(id), -- set only for events NEXUS created (write-back); null for events merely mirrored from a sync
  google_updated_at     text, -- Google's own updated timestamp string, used to short-circuit no-op re-writes during sync
  synced_at             timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  unique (subscription_id, google_event_id)
);
create index idx_calendar_events_org on calendar_events(org_id);
create index idx_calendar_events_subscription on calendar_events(subscription_id);
-- Backs listEventsInRange's overlap query (coalesce(start_at, start_date) < to AND coalesce(end_at, end_date) >= from).
create index idx_calendar_events_range on calendar_events(subscription_id, start_at, end_at);

-- ---------------------------------------------------------------------
-- Row-Level Security — same tenant_isolation shape as every prior
-- migration's loop.
-- ---------------------------------------------------------------------
do $$
declare
  t text;
begin
  for t in select unnest(array[
    'calendar_connections', 'calendar_subscriptions', 'calendar_events'
  ])
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format(
      'create policy tenant_isolation on %I using (org_id = current_setting(''app.current_org_id'', true)::uuid)',
      t
    );
  end loop;
end $$;

grant select, insert, update, delete on
  calendar_connections, calendar_subscriptions, calendar_events
to nexus_app;

-- ---------------------------------------------------------------------
-- Two narrow SECURITY DEFINER functions — same "resolve identity before
-- org context exists" shape as find_user_by_email (0003_invites.sql) /
-- list_users_for_dev_login (0010_dev_login_roster.sql). nexus_app is
-- granted EXECUTE only, never SELECT on these tables directly, so the
-- bypass surface stays exactly "resolve which org this request belongs
-- to," not "read any org's calendar data."
--
-- 1. find_subscription_by_channel_id — Google's push-webhook POST
--    (routes/calendarWebhook.ts) arrives with only an X-Goog-Channel-Id
--    header, no session, no org. This is the one lookup that turns that
--    header into an org_id + subscription_id so the handler can then
--    call incrementalSync inside a normal withOrgContext.
-- 2. list_active_subscriptions_for_sync — the reconciliation sweep
--    (routes/calendarMaintenance.ts, shared-secret cron/n8n trigger,
--    also no session) needs "every active subscription across every
--    org" to safety-net anything a missed webhook delivery would have
--    caught. Returns only id/org_id — the sweep re-enters withOrgContext
--    per row for the actual sync, same as devAuth's roster lookup is
--    just the identity step, never the privileged action itself.
-- ---------------------------------------------------------------------
create or replace function find_subscription_by_channel_id(p_channel_id text)
returns table (id uuid, org_id uuid, connection_id uuid, google_calendar_id text)
language sql
security definer
set search_path = public
as $$
  select id, org_id, connection_id, google_calendar_id
    from calendar_subscriptions
   where channel_id = p_channel_id and is_active
   limit 1;
$$;

alter function find_subscription_by_channel_id(text) owner to nexus_bootstrap;
revoke all on function find_subscription_by_channel_id(text) from public;
grant execute on function find_subscription_by_channel_id(text) to nexus_app;

create or replace function list_active_subscriptions_for_sync()
returns table (id uuid, org_id uuid)
language sql
security definer
set search_path = public
as $$
  select id, org_id from calendar_subscriptions where is_active order by last_synced_at nulls first;
$$;

alter function list_active_subscriptions_for_sync() owner to nexus_bootstrap;
revoke all on function list_active_subscriptions_for_sync() from public;
grant execute on function list_active_subscriptions_for_sync() to nexus_app;

grant select on calendar_subscriptions to nexus_bootstrap;
