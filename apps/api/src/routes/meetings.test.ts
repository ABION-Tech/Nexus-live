// Route-level tests for routes/meetings.ts. sessionService + rbac's
// hasPermission are mocked (same posture as projects.test.ts) — this is
// the permission-gating/HTTP layer under test, not meetingService's own
// query logic (that's meetingService.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Meeting, MeetingRecording } from '@nexus/shared';

const LEADER_TOKEN = 'leader-token'; // blanket meetings.* grant (role === 'leader')
const OUTSIDER_TOKEN = 'outsider-token'; // no grant at all

const LEADER = { sessionId: 's1', userId: 'user-leader', orgId: 'org-1', role: 'leader', name: 'Leader', email: 'leader@abion.test' };
const OUTSIDER = { sessionId: 's2', userId: 'user-outsider', orgId: 'org-1', role: 'guest', name: 'Outsider', email: 'outsider@abion.test' };

vi.mock('../services/sessionService.js', () => ({
  verifySession: vi.fn(async (token: string) => {
    if (token === LEADER_TOKEN) return LEADER;
    if (token === OUTSIDER_TOKEN) return OUTSIDER;
    return null;
  }),
}));

vi.mock('../plugins/rbac.js', async () => {
  const actual = await vi.importActual<typeof import('../plugins/rbac.js')>('../plugins/rbac.js');
  return {
    ...actual,
    // Only LEADER carries a blanket grant — meetings has no membership-
    // fallback (unlike projects.ts), so an outsider has no path in at all.
    hasPermission: vi.fn(async (user: { userId: string }) => user.userId === LEADER.userId),
  };
});

const MEETING_A: Meeting = {
  id: 'meeting-a',
  orgId: 'org-1',
  title: 'Weekly Sync',
  locationType: 'zoom',
  locationDetail: 'https://zoom.us/j/123',
  startTime: '2026-03-01T10:00:00.000Z',
  endTime: '2026-03-01T11:00:00.000Z',
  organizerUserId: LEADER.userId,
  zoomMeetingId: 'zoom-123',
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
};

const AMBIGUOUS_RECORDING: MeetingRecording = {
  id: 'recording-1',
  orgId: 'org-1',
  source: 'fireflies',
  transcriptText: 'transcript text',
  callStartTime: '2026-03-01T10:00:00.000Z',
  callEndTime: '2026-03-01T11:00:00.000Z',
  matchMethod: 'time_window',
  matchStatus: 'ambiguous',
  candidateMeetingIds: ['meeting-a', 'meeting-b'],
  createdAt: '2026-03-01T11:05:00.000Z',
};

vi.mock('../services/meetingService.js', () => ({
  listMeetings: vi.fn(async () => [MEETING_A]),
  getMeeting: vi.fn(async (_orgId: string, id: string) => (id === MEETING_A.id ? MEETING_A : null)),
  createMeeting: vi.fn(async (_orgId: string, input: { title: string }) => ({ ...MEETING_A, title: input.title })),
  updateMeeting: vi.fn(async (_orgId: string, id: string) => (id === MEETING_A.id ? MEETING_A : null)),
  archiveMeeting: vi.fn(async (_orgId: string, id: string) => (id === MEETING_A.id ? { ...MEETING_A, archivedAt: '2026-03-05T00:00:00.000Z' } : null)),
  restoreMeeting: vi.fn(async (_orgId: string, id: string) => (id === MEETING_A.id ? MEETING_A : null)),
}));

vi.mock('../services/meetingRecordingService.js', () => ({
  listRecordingsForMeeting: vi.fn(async () => [AMBIGUOUS_RECORDING]),
  listRecordingsNeedingReview: vi.fn(async () => [AMBIGUOUS_RECORDING]),
  manuallyLinkRecording: vi.fn(async (_orgId: string, recordingId: string, meetingId: string) =>
    recordingId === AMBIGUOUS_RECORDING.id ? { ...AMBIGUOUS_RECORDING, meetingId, matchStatus: 'matched', matchMethod: 'manual' } : null
  ),
}));

describe('Meetings routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.COOKIE_SECRET = 'test-secret';
    const { buildServer } = await import('../server.js');
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  describe('GET / (list)', () => {
    it('401s with no session', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/meetings' });
      expect(res.statusCode).toBe(401);
    });

    it('403s a caller with no meetings.read grant — no membership fallback exists here, unlike projects', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/meetings', headers: { cookie: `nexus_session=${OUTSIDER_TOKEN}` } });
      expect(res.statusCode).toBe(403);
    });

    it('a caller with the grant gets the list', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/meetings', headers: { cookie: `nexus_session=${LEADER_TOKEN}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json().meetings).toEqual([MEETING_A]);
    });
  });

  describe('POST / (create)', () => {
    it('403s without meetings.create', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/meetings',
        headers: { cookie: `nexus_session=${OUTSIDER_TOKEN}` },
        payload: { title: 'X', locationType: 'zoom', startTime: '2026-03-01T10:00:00.000Z' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('400s on an invalid locationType rather than passing it through to the service', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/meetings',
        headers: { cookie: `nexus_session=${LEADER_TOKEN}` },
        payload: { title: 'X', locationType: 'microsoft_teams', startTime: '2026-03-01T10:00:00.000Z' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('creates a meeting for a caller with the grant', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/meetings',
        headers: { cookie: `nexus_session=${LEADER_TOKEN}` },
        payload: { title: 'New Sync', locationType: 'zoom', startTime: '2026-03-01T10:00:00.000Z' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().title).toBe('New Sync');
    });
  });

  describe('GET /:id/recordings', () => {
    it('404s for a nonexistent meeting rather than returning an empty list', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/meetings/does-not-exist/recordings',
        headers: { cookie: `nexus_session=${LEADER_TOKEN}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns recordings linked to a real meeting', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/meetings/${MEETING_A.id}/recordings`,
        headers: { cookie: `nexus_session=${LEADER_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().recordings).toEqual([AMBIGUOUS_RECORDING]);
    });
  });

  describe('GET /recordings/unmatched (review queue)', () => {
    it('surfaces the ambiguous simultaneous-meeting case for manual review', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/meetings/recordings/unmatched',
        headers: { cookie: `nexus_session=${LEADER_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().recordings[0].matchStatus).toBe('ambiguous');
    });
  });

  describe('POST /recordings/:recordingId/link (manual resolution)', () => {
    it('400s when meetingId is missing from the body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/meetings/recordings/${AMBIGUOUS_RECORDING.id}/link`,
        headers: { cookie: `nexus_session=${LEADER_TOKEN}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('links an ambiguous recording to the human-chosen meeting', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/meetings/recordings/${AMBIGUOUS_RECORDING.id}/link`,
        headers: { cookie: `nexus_session=${LEADER_TOKEN}` },
        payload: { meetingId: 'meeting-b' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().matchStatus).toBe('matched');
      expect(res.json().matchMethod).toBe('manual');
    });
  });

  describe('DELETE /:id (archive)', () => {
    it('403s without meetings.delete', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/meetings/${MEETING_A.id}`,
        headers: { cookie: `nexus_session=${OUTSIDER_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('archives (not deletes) for a caller with the grant', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/meetings/${MEETING_A.id}`,
        headers: { cookie: `nexus_session=${LEADER_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().archivedAt).toBe('2026-03-05T00:00:00.000Z');
    });
  });
});
