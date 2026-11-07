-- 0018_ai_usage.sql
-- ADMIN_BUILD_GUIDE.md §3 "Session 3 — AI provider interface + usage
-- tracking" (merged) — repo Session 39. Guide's own ordering constraint:
-- "Session 3's ai_usage piece cannot start before its interface-change
-- half is verified" — this migration is the second half, added only
-- after apps/api/src/integrations/aiProvider.ts's AIProvider.complete()
-- return shape change and every existing caller (aiService.ts's four
-- methods, aiSettingsService.testAiConnection) were updated and
-- typechecked/tested clean first (see SESSION_LOG.md's own account of
-- that ordering).
--
-- Shape mirrors audit_log (0016_admin_foundation.sql) deliberately: same
-- "new dedicated table, not an extension of an existing one" reasoning
-- applies here for a different pair of reasons — activity_log/
-- permission_log are keyed to a single resource change, and this needs
-- per-call token/latency/model/feature columns none of those carry.
-- Same append-only doctrine too (PRD §13.10's "written but never
-- deleted" — grant below has no update/delete).
create table ai_usage (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organizations(id),
  -- Null only for a future system/scheduled AI call with no human
  -- actor — every current caller (goal decomposition, chat, reports,
  -- agent handoff fallback) has a real actor_user_id in scope at its
  -- call site (see aiService.ts's *Input interfaces), so this is never
  -- actually null yet. Left nullable rather than `not null` so a future
  -- automation-triggered call (PRD §12's cron jobs, none of which call
  -- AIService today) doesn't need a schema change just to log usage.
  actor_user_id       uuid references users(id),
  feature             text not null check (feature in ('goal_decomposition', 'chat', 'report', 'agent_handoff')),
  -- Which Settings > Integrations slot was resolved (aiSettingsService.
  -- resolveProviderForOrg's own 'chat' | 'report' target) — distinct
  -- from `feature` above: goal_decomposition and agent_handoff both
  -- resolve the 'chat' provider target today (aiService.ts's own
  -- choice), so this column is what actually tells you which model
  -- configuration served the call, not just which product feature asked.
  provider_target     text not null check (provider_target in ('chat', 'report')),
  -- The resolved model name — 'stub' when no org configuration exists
  -- yet (aiSettingsService.resolveProviderForOrg falls back to
  -- StubAIProvider), so a stub-served call is still counted as a real
  -- feature-usage event, just at zero cost/tokens, rather than silently
  -- unlogged.
  model               text not null,
  prompt_tokens       integer,
  completion_tokens   integer,
  total_tokens        integer,
  latency_ms          integer not null,
  success             boolean not null,
  -- Populated only when success = false — the provider/parsing error
  -- message, same "log the failure, don't just drop it" posture
  -- agentHandoffService.ts's own completeHandoff('failed', message)
  -- already takes for that one feature.
  error_message       text,
  created_at          timestamptz not null default now()
);

create index idx_ai_usage_org on ai_usage(org_id);
create index idx_ai_usage_org_created on ai_usage(org_id, created_at);
create index idx_ai_usage_feature on ai_usage(feature);

-- Plain tenant_isolation — every ai_usage row is always org-scoped (no
-- platform-level AI usage concept exists in this build, unlike
-- audit_log's nullable org_id for Super-Admin-issued actions), so this
-- doesn't need audit_log's "null org_id rows are invisible by
-- construction" carve-out.
alter table ai_usage enable row level security;
alter table ai_usage force row level security;

create policy tenant_isolation on ai_usage
  using (org_id = current_setting('app.current_org_id', true)::uuid);

grant select, insert on ai_usage to nexus_app;
