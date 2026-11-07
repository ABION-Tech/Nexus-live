-- 0030_notification_preferences.sql
--
-- Session 11 (routes/notifications.ts) — PRD §10.4's two-axis
-- (notification type × channel) preference model. Nothing persisted a
-- per-user opt-out before this; notifyInApp (notificationService.ts)
-- always sent. This table is deliberately sparse: a missing row for a
-- given (user, type, channel) means "enabled" (the default every
-- existing user already experiences today), matching
-- notificationPreferencesService.ts's own isNotificationEnabled — a row
-- only exists once someone has actually turned something off.
--
-- Written against app_current_org_id() directly per 0029's own
-- "new policies should use this" note, not the bare
-- current_setting(...)::uuid pattern every earlier migration used.
create table notification_preferences (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id),
  user_id            uuid not null references users(id),
  notification_type  text not null,
  channel            text not null check (channel in ('in_app', 'push')),
  enabled            boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (user_id, notification_type, channel)
);

create index idx_notification_preferences_user
  on notification_preferences(org_id, user_id);

alter table notification_preferences enable row level security;
alter table notification_preferences force row level security;

create policy tenant_isolation on notification_preferences
  using (org_id = app_current_org_id())
  with check (org_id = app_current_org_id());

grant select, insert, update, delete on notification_preferences to nexus_app;
