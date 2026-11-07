-- 0011_ai_settings.sql
-- Settings > Integrations (PRD §7.2 11 SETTINGS) — one row per org holding
-- the AI provider connection: an OpenAI-compatible endpoint (NVIDIA NIM or
-- anything else that speaks the same /chat/completions shape), never a
-- vendor baked into code. This replaces the O3-era assumption ("AI
-- provider | Gemini API (primary)") with what the org actually configures
-- at runtime — see integrations/aiProvider.ts's header comment for why the
-- provider layer was always meant to be swappable, this is just the first
-- migration that makes the swap a UI action instead of an env var + deploy.
--
-- One row per org (org_id is both PK and the tenant key) rather than a
-- generic key-value settings table — there is exactly one AI connection
-- per org today (PRD has no per-user AI settings), and a dedicated table
-- keeps the RLS policy and the masked-read shape simple and explicit.
--
-- api_key / meeting_ingest_secret are stored as plain text columns, same
-- trust boundary as every other secret this codebase holds server-side
-- (e.g. COOKIE_SECRET, GOOGLE_OAUTH_CLIENT_SECRET are plain env vars) —
-- protected by RLS + the API never echoing them back (routes/aiSettings.ts
-- always masks), not by column-level encryption. Flagged here rather than
-- silently assumed: if these ever need encryption-at-rest, that's a
-- follow-up migration, not a blocker for shipping the settings page.
create table ai_settings (
  org_id                  uuid primary key references organizations(id),
  base_url                text,
  api_key                 text,
  chat_model              text not null default 'GLM 5.2',
  report_model            text,
  meeting_ingest_secret   text,
  updated_by_user_id      uuid references users(id),
  updated_at              timestamptz not null default now()
);

-- Same tenant_isolation policy shape as every prior migration
-- (DECISIONS.md §3), added individually here rather than editing 0001's
-- loop — migrations are append-only.
alter table ai_settings enable row level security;
alter table ai_settings force row level security;
create policy tenant_isolation on ai_settings
  using (org_id = current_setting('app.current_org_id', true)::uuid);

grant select, insert, update, delete on ai_settings to nexus_app;
