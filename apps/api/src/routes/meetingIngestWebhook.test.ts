// Route-level tests for routes/meetingIngestWebhook.ts. No session
// exists for this endpoint at all (n8n calls it directly) — what's under
// test is secret->org resolution and the "never leak verification
// outcome via status code" posture every unauthenticated webhook in this
// codebase shares (see calendarWebhook.ts/billingWebhook.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const GOOD_SECRET = 'shared-secret-abc';
const ORG_ID = 'org-1';

vi.mock('../services/aiSettingsService.js', () => ({
  resolveOrgIdByMeetingIngestSecret: vi.fn(async (secret: string) => (secret === GOOD_SECRET ? ORG_ID : null)),
}));

const ingestMeetingRecordingMock = vi.fn(async () => ({ id: 'recording-1' }));
vi.mock('../services/meetingRecordingService.js', () => ({
  ingestMeetingRecording: ingestMeetingRecordingMock,
}));

describe('Meeting ingest webhook', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.COOKIE_SECRET = 'test-secret';
    ingestMeetingRecordingMock.mockClear();
    const { buildServer } = await import('../server.js');
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  const VALID_PAYLOAD = {
    source: 'fireflies',
    organizerEmail: 'organizer@abion.test',
    transcriptText: 'transcript text',
    callStartTime: '2026-03-01T10:00:00.000Z',
    callEndTime: '2026-03-01T11:00:00.000Z',
  };

  it('200s with no header at all, never distinguishing "no secret" from "wrong secret" via status', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/meetings/ingest', payload: VALID_PAYLOAD });
    expect(res.statusCode).toBe(200);
    expect(ingestMeetingRecordingMock).not.toHaveBeenCalled();
  });

  it('200s on an unrecognized secret without ever reaching ingestMeetingRecording', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/meetings/ingest',
      headers: { 'x-meeting-ingest-secret': 'wrong-secret' },
      payload: VALID_PAYLOAD,
    });
    expect(res.statusCode).toBe(200);
    expect(ingestMeetingRecordingMock).not.toHaveBeenCalled();
  });

  it('200s but does not ingest a malformed payload (missing callStartTime) from a genuinely valid org secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/meetings/ingest',
      headers: { 'x-meeting-ingest-secret': GOOD_SECRET },
      payload: { source: 'fireflies' },
    });
    expect(res.statusCode).toBe(200);
    expect(ingestMeetingRecordingMock).not.toHaveBeenCalled();
  });

  it('resolves the org from the secret and ingests a well-formed payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/meetings/ingest',
      headers: { 'x-meeting-ingest-secret': GOOD_SECRET },
      payload: VALID_PAYLOAD,
    });
    expect(res.statusCode).toBe(200);
    expect(ingestMeetingRecordingMock).toHaveBeenCalledWith(ORG_ID, expect.objectContaining({ source: 'fireflies' }));
  });

  it('still 200s (and logs, not throws) when ingestMeetingRecording itself fails — n8n should never retry into the same failure', async () => {
    ingestMeetingRecordingMock.mockRejectedValueOnce(new Error('db unavailable'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/meetings/ingest',
      headers: { 'x-meeting-ingest-secret': GOOD_SECRET },
      payload: VALID_PAYLOAD,
    });
    expect(res.statusCode).toBe(200);
  });
});
