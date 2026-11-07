// AiSettingsService — backs Settings > Integrations (0011_ai_settings.sql).
// Owns the one place that ever sees a raw api_key/meeting_ingest_secret;
// everything else (routes/aiSettings.ts, aiService.ts) goes through this
// file's masked or resolved views, never the raw row directly.
import { pool, withOrgContext } from '../db.js';
import { DEFAULT_AI_MODEL } from '@nexus/shared';
import type { AiSettings, AiSettingsInput, AiTestResult, AiTestTarget } from '@nexus/shared';
import { AIProviderNotConfiguredError, OpenAICompatibleProvider, StubAIProvider, type AIProvider } from '../integrations/aiProvider.js';

interface AiSettingsRow {
  org_id: string;
  base_url: string | null;
  api_key: string | null;
  chat_model: string;
  report_model: string | null;
  meeting_ingest_secret: string | null;
  updated_at: Date;
}

async function fetchRow(orgId: string): Promise<AiSettingsRow | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<AiSettingsRow>(
      `select * from ai_settings where org_id = $1`,
      [orgId]
    );
    return rows[0] ?? null;
  });
}

/** GET /settings/ai — never returns api_key or meeting_ingest_secret
 * themselves, only whether one is currently saved (the "A key is
 * currently saved — leave blank to keep it" UI copy relies on this). */
export async function getMaskedAiSettings(orgId: string): Promise<AiSettings> {
  const row = await fetchRow(orgId);
  if (!row) {
    return {
      baseUrl: null,
      hasApiKey: false,
      chatModel: DEFAULT_AI_MODEL,
      reportModel: null,
      hasMeetingIngestSecret: false,
      updatedAt: null,
    };
  }
  return {
    baseUrl: row.base_url,
    hasApiKey: Boolean(row.api_key),
    chatModel: row.chat_model,
    reportModel: row.report_model,
    hasMeetingIngestSecret: Boolean(row.meeting_ingest_secret),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** PUT /settings/ai — a blank/omitted apiKey or meetingIngestSecret means
 * "keep whatever is already saved", never "clear it", matching the
 * mockup's own copy on both fields. baseUrl/reportModel are the one
 * exception in the opposite direction: an explicit blank there does clear
 * them, since neither has a "saved secret" concept to preserve. */
export async function upsertAiSettings(
  orgId: string,
  input: AiSettingsInput,
  updatedByUserId: string
): Promise<AiSettings> {
  const existing = await fetchRow(orgId);

  const apiKey = input.apiKey?.trim() ? input.apiKey.trim() : (existing?.api_key ?? null);
  const meetingIngestSecret = input.meetingIngestSecret?.trim()
    ? input.meetingIngestSecret.trim()
    : (existing?.meeting_ingest_secret ?? null);

  await withOrgContext(orgId, (client) =>
    client.query(
      `insert into ai_settings (org_id, base_url, api_key, chat_model, report_model, meeting_ingest_secret, updated_by_user_id, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (org_id) do update set
         base_url = excluded.base_url,
         api_key = excluded.api_key,
         chat_model = excluded.chat_model,
         report_model = excluded.report_model,
         meeting_ingest_secret = excluded.meeting_ingest_secret,
         updated_by_user_id = excluded.updated_by_user_id,
         updated_at = now()`,
      [
        orgId,
        input.baseUrl?.trim() || null,
        apiKey,
        input.chatModel || DEFAULT_AI_MODEL,
        input.reportModel?.trim() || null,
        meetingIngestSecret,
        updatedByUserId,
      ]
    )
  );

  return getMaskedAiSettings(orgId);
}

/** meetingIngestWebhook.ts's one lookup: the ingest webhook arrives with
 * no NEXUS session, so it can only learn which org a payload belongs to
 * by resolving org_id FROM the shared secret n8n's HTTP node sent —
 * necessarily a raw `pool` query, not withOrgContext(orgId, ...), since
 * there's no orgId yet to set. Deliberately scoped to exactly this one
 * column/purpose (same "checked outside RLS on purpose, narrowly" shape
 * projectService.fetchMembers documents for its own bypass), not a
 * general escape hatch — nothing else in this file runs on the raw pool.
 * 0035_meeting_recordings.sql's unique index is what makes this safe to
 * treat as a single-org resolution rather than an ambiguous one. */
export async function resolveOrgIdByMeetingIngestSecret(secret: string): Promise<string | null> {
  const { rows } = await pool.query<{ org_id: string }>(
    `select org_id from ai_settings where meeting_ingest_secret = $1`,
    [secret]
  );
  return rows[0]?.org_id ?? null;
}

/** Resolves the live provider for an org — the one thing above this file
 * (aiService.ts) actually needs. Falls back to StubAIProvider when the
 * org hasn't configured a base URL/key yet, so goal decomposition (and
 * anything else built on AIService) keeps working with no setup, exactly
 * like the old AI_PROVIDER=stub default did. */
/** Resolves the live provider for an org — the one thing above this file
 * (aiService.ts) actually needs. Falls back to StubAIProvider when the
 * org hasn't configured a base URL/key yet, so goal decomposition (and
 * anything else built on AIService) keeps working with no setup, exactly
 * like the old AI_PROVIDER=stub default did.
 *
 * Returns `model` alongside the provider (Session 39 addition) — the
 * caller (aiService.ts) needs it to attribute an `ai_usage` row to the
 * right model even when it's about to call the stub, so 'stub' is
 * returned rather than omitting model for that branch. Previously this
 * returned just the provider; every call site was already inside this
 * codebase (four in aiService.ts) so widening the return type here was
 * a contained, verifiable change rather than a public-API break. */
export async function resolveProviderForOrg(
  orgId: string,
  target: AiTestTarget = 'chat'
): Promise<{ provider: AIProvider; model: string }> {
  const row = await fetchRow(orgId);
  if (!row || !row.base_url || !row.api_key) {
    return { provider: new StubAIProvider(), model: 'stub' };
  }
  const model = (target === 'report' ? row.report_model : row.chat_model) || row.chat_model || DEFAULT_AI_MODEL;
  return { provider: new OpenAICompatibleProvider({ baseUrl: row.base_url, apiKey: row.api_key, model }), model };
}

/** Backs the Test button — a minimal real completion call against
 * whichever model the picker has selected, surfaced as a pass/fail the
 * UI can show inline rather than a raw thrown error. Deliberately not
 * logged to ai_usage: this is a connectivity check, not a feature call,
 * and doesn't have an actor_user_id/feature to attribute the way the
 * four real AIService methods do — same reasoning testAiConnection
 * already stood on for skipping other feature-specific bookkeeping. */
export async function testAiConnection(orgId: string, target: AiTestTarget): Promise<AiTestResult> {
  const row = await fetchRow(orgId);
  if (!row || !row.base_url || !row.api_key) {
    throw new AIProviderNotConfiguredError('no base URL or API key saved yet');
  }
  const model = (target === 'report' ? row.report_model : row.chat_model) || row.chat_model || DEFAULT_AI_MODEL;
  const provider = new OpenAICompatibleProvider({ baseUrl: row.base_url, apiKey: row.api_key, model });
  try {
    const result = await provider.complete(
      'You are a connection test. Reply with exactly: ok',
      'Reply with exactly: ok'
    );
    return { ok: true, model, message: result.text.trim().slice(0, 200) || 'Connected.' };
  } catch (err) {
    return { ok: false, model, message: err instanceof Error ? err.message : 'Connection failed.' };
  }
}
