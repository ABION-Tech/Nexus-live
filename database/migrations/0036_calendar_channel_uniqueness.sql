-- 0036_calendar_channel_uniqueness.sql
--
-- Two things that belong together:
--
-- 1. Partial unique index on calendar_subscriptions.channel_id (non-null
--    rows only). The column was intentionally nullable in 0012 — a freshly
--    created subscription has no channel yet, and stopSubscriptionChannel
--    NULLs it out rather than deleting the row. A plain UNIQUE constraint
--    would wrongly reject the multiple NULL rows that exist legitimately
--    during those windows. A partial index on (channel_id) WHERE channel_id
--    IS NOT NULL gives uniqueness only where it matters: Google issues each
--    channel_id once and it must map to exactly one subscription; having it
--    appear twice would cause webhook deliveries to resolve to the wrong org.
--
-- 2. list_expiring_channel_subscriptions() — SECURITY DEFINER bootstrap
--    function for the channel-renewal sweep (calendarSyncService.ts's
--    renewExpiringChannels, triggered by calendarMaintenance.ts's new
--    /renew-channels endpoint). Same cross-org read pattern as
--    list_active_subscriptions_for_sync() in 0012 — read the full set
--    via a bootstrap function that bypasses RLS, then re-enter
--    withOrgContext per row for the privileged write (nulling out the
--    old channel and re-registering a fresh one).
--
--    "Expiring" is defined as channel_expires_at within the next 48 hours.
--    Google's push channels have a maximum lifetime of ~30 days; sweeping
--    48 hours ahead gives plenty of runway for the sweep to run even if the
--    scheduler hiccups once. Rows where channel_id IS NULL are excluded —
--    maybeRegisterChannel already handles unregistered subscriptions; the
--    renewal sweep only needs to handle the clock-expiry case.
--
--    Returns id / org_id / connection_id only — same minimal surface as
--    the sync function. The renewal job re-enters withOrgContext per row
--    and does its own loadConnection / getValidAccessToken there; it
--    doesn't need the full row here.

-- ---------------------------------------------------------------------
-- 1. Partial unique index on channel_id
-- ---------------------------------------------------------------------
create unique index if not exists idx_calendar_subscriptions_channel_id_unique
  on calendar_subscriptions(channel_id)
  where channel_id is not null;

-- ---------------------------------------------------------------------
-- 2. Bootstrap query function for the channel-renewal sweep
-- ---------------------------------------------------------------------
create or replace function list_expiring_channel_subscriptions(p_within_hours int default 48)
returns table (id uuid, org_id uuid, connection_id uuid)
language sql
security definer
set search_path = public
as $$
  select id, org_id, connection_id
    from calendar_subscriptions
   where is_active
     and channel_id is not null
     and channel_expires_at <= now() + (p_within_hours || ' hours')::interval
   order by channel_expires_at asc;
$$;

alter function list_expiring_channel_subscriptions(int) owner to nexus_bootstrap;
revoke all on function list_expiring_channel_subscriptions(int) from public;
grant execute on function list_expiring_channel_subscriptions(int) to nexus_app;
