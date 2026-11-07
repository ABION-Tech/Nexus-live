// The one NEXUS endpoint n8n's HTTP node reaches with no NEXUS session —
// same class as calendarWebhook.ts/billingWebhook.ts (see those files'
// own headers for why this is its own file/prefix, never nested under a
// requireAuth-gated plugin). Backs the Settings > Integrations "Meeting
// Ingest Secret" field (aiSettingsService.ts's own header), which shipped
// with no endpoint behind it until this route existed.
//
// Auth is a shared secret, not a per-vendor signature (contrast with
// billingWebhook.ts's Paystack signature check) — n8n sits between NEXUS
// and Fireflies/Zoom/Google Meet, so NEXUS never receives a vendor's own
// signed payload directly; it only ever sees whatever shape n8n's
// workflow normalizes to. The secret identifies WHICH ORG a payload
// belongs to (resolveOrgIdByMeetingIngestSecret), not just whether the
// request is authorized — there is no other org-identifying field in the
// request at all.
import type { FastifyInstance } from 'fastify';
import { resolveOrgIdByMeetingIngestSecret } from '../services/aiSettingsService.js';
import { ingestMeetingRecording } from '../services/meetingRecordingService.js';
import type { MeetingIngestPayload, MeetingRecordingSource } from '@nexus/shared';

const VALID_SOURCES: MeetingRecordingSource[] = ['zoom', 'google_meet', 'fireflies'];

function isValidPayload(body: unknown): body is MeetingIngestPayload {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  if (typeof b.source !== 'string' || !VALID_SOURCES.includes(b.source as MeetingRecordingSource)) return false;
  if (typeof b.callStartTime !== 'string' || Number.isNaN(Date.parse(b.callStartTime))) return false;
  return true;
}

export async function registerMeetingIngestWebhookRoutes(app: FastifyInstance) {
  app.post('/', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const secret = req.headers['x-meeting-ingest-secret'] as string | undefined;

    // Always ack 200 on a missing/wrong secret — same "don't leak
    // verification outcome via status code" posture calendarWebhook.ts's
    // own token check takes. A non-200 here would just make n8n retry
    // the same unauthorized request indefinitely.
    if (!secret) {
      reply.status(200).send();
      return;
    }

    const orgId = await resolveOrgIdByMeetingIngestSecret(secret);
    if (!orgId) {
      req.log.warn('Meeting ingest webhook: unrecognized secret');
      reply.status(200).send();
      return;
    }

    if (!isValidPayload(req.body)) {
      // A real org, but a malformed body — n8n's own workflow bug or a
      // vendor payload it failed to normalize. Log for diagnosis; still
      // ack so n8n doesn't retry into the same failure.
      req.log.warn({ orgId }, 'Meeting ingest webhook: malformed payload');
      reply.status(200).send();
      return;
    }

    try {
      await ingestMeetingRecording(orgId, req.body);
    } catch (err) {
      req.log.error({ err, orgId }, 'Meeting ingest webhook processing failed');
    }

    reply.status(200).send();
  });
}
