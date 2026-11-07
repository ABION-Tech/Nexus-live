// Service-level tests for meetingRecordingService.ts's matching priority
// order. db.js is mocked (same posture as projectService.test.ts) — this
// is the matching logic under test, not an RLS/migration integration
// test. The scenario this file exists to prove: two meetings overlapping
// in time for the same organizer never get silently merged — the
// ambiguous case is the whole point of this design.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakeClient = { query: vi.fn() };

vi.mock('../db.js', () => ({
  pool: { query: vi.fn() },
  withOrgContext: vi.fn(async (_orgId: string, fn: (client: unknown) => unknown) => fn(fakeClient)),
}));

import { ingestMeetingRecording } from './meetingRecordingService.js';
import type { MeetingIngestPayload } from '@nexus/shared';

const ORG = 'org-1';

function insertedRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'recording-1',
    org_id: ORG,
    meeting_id: overrides.meeting_id ?? null,
    source: 'fireflies',
    external_meeting_id: null,
    external_transcript_id: null,
    recording_url: null,
    transcript_url: null,
    transcript_text: 'transcript text',
    call_start_time: new Date('2026-03-01T10:00:00.000Z'),
    call_end_time: new Date('2026-03-01T11:00:00.000Z'),
    match_method: overrides.match_method ?? 'time_window',
    match_status: overrides.match_status ?? 'unmatched',
    candidate_meeting_ids: overrides.candidate_meeting_ids ?? [],
    created_at: new Date('2026-03-01T11:05:00.000Z'),
  };
}

const BASE_PAYLOAD: MeetingIngestPayload = {
  source: 'fireflies',
  organizerEmail: 'organizer@abion.test',
  transcriptText: 'transcript text',
  callStartTime: '2026-03-01T10:00:00.000Z',
  callEndTime: '2026-03-01T11:00:00.000Z',
};

beforeEach(() => {
  fakeClient.query.mockReset();
});

describe('ingestMeetingRecording — priority 1: exact ID match', () => {
  it('matches on external_meeting_id against zoom_meeting_id/google_calendar_event_id and never runs the time-window query', async () => {
    fakeClient.query
      .mockResolvedValueOnce({ rows: [{ id: 'meeting-exact' }] }) // exact id lookup
      .mockResolvedValueOnce({ rows: [insertedRow({ meeting_id: 'meeting-exact', match_method: 'exact_id', match_status: 'matched' })] }); // insert

    const result = await ingestMeetingRecording(ORG, { ...BASE_PAYLOAD, source: 'zoom', externalMeetingId: 'zoom-123' });

    expect(result.matchStatus).toBe('matched');
    expect(result.matchMethod).toBe('exact_id');
    expect(result.meetingId).toBe('meeting-exact');
    // Only 2 calls: the exact-id lookup and the insert — no organizer
    // resolution, no time-window query.
    expect(fakeClient.query).toHaveBeenCalledTimes(2);
  });
});

describe('ingestMeetingRecording — priority 2: time-window match, exactly one candidate', () => {
  it('matches when no exact ID is available (the normal Fireflies case) and exactly one meeting overlaps', async () => {
    fakeClient.query
      .mockResolvedValueOnce({ rows: [{ id: 'organizer-user-1' }] }) // organizer email -> user
      .mockResolvedValueOnce({ rows: [{ id: 'meeting-only-candidate' }] }) // time-window candidates
      .mockResolvedValueOnce({ rows: [insertedRow({ meeting_id: 'meeting-only-candidate', match_status: 'matched' })] }); // insert

    const result = await ingestMeetingRecording(ORG, BASE_PAYLOAD);

    expect(result.matchStatus).toBe('matched');
    expect(result.matchMethod).toBe('time_window');
    expect(result.meetingId).toBe('meeting-only-candidate');
  });
});

describe('ingestMeetingRecording — priority 2: simultaneous meetings, the case this design exists for', () => {
  it('never auto-picks a meeting when two or more candidates overlap — marks ambiguous with every candidate listed, meetingId left unset', async () => {
    fakeClient.query
      .mockResolvedValueOnce({ rows: [{ id: 'organizer-user-1' }] }) // organizer email -> user
      .mockResolvedValueOnce({ rows: [{ id: 'meeting-a' }, { id: 'meeting-b' }] }) // TWO overlapping candidates — double-booked organizer
      .mockResolvedValueOnce({
        rows: [insertedRow({ match_status: 'ambiguous', candidate_meeting_ids: ['meeting-a', 'meeting-b'] })],
      }); // insert

    const result = await ingestMeetingRecording(ORG, BASE_PAYLOAD);

    expect(result.matchStatus).toBe('ambiguous');
    expect(result.meetingId).toBeUndefined();
    expect(result.candidateMeetingIds).toEqual(['meeting-a', 'meeting-b']);

    // Verify the insert call itself was told meeting_id = null, not
    // guessed as one of the two candidates.
    const insertCall = fakeClient.query.mock.calls[2]!;
    const insertParams = insertCall[1] as unknown[];
    // params order: org_id, meeting_id, source, ... — meeting_id is index 1
    expect(insertParams[1]).toBeNull();
  });
});

describe('ingestMeetingRecording — priority 2: zero candidates', () => {
  it('stores the recording as unmatched rather than dropping it, for the manual review queue', async () => {
    fakeClient.query
      .mockResolvedValueOnce({ rows: [{ id: 'organizer-user-1' }] }) // organizer email -> user
      .mockResolvedValueOnce({ rows: [] }) // no overlapping meetings at all
      .mockResolvedValueOnce({ rows: [insertedRow({ match_status: 'unmatched' })] }); // insert

    const result = await ingestMeetingRecording(ORG, BASE_PAYLOAD);

    expect(result.matchStatus).toBe('unmatched');
    expect(result.meetingId).toBeUndefined();
  });
});

describe('ingestMeetingRecording — organizer email does not resolve to a user', () => {
  it('still runs the time-window query (without an organizer filter) rather than refusing to match at all', async () => {
    fakeClient.query
      .mockResolvedValueOnce({ rows: [] }) // organizer email lookup finds nobody
      .mockResolvedValueOnce({ rows: [{ id: 'meeting-only-candidate' }] }) // time-window candidates, no organizer filter applied
      .mockResolvedValueOnce({ rows: [insertedRow({ meeting_id: 'meeting-only-candidate', match_status: 'matched' })] });

    const result = await ingestMeetingRecording(ORG, { ...BASE_PAYLOAD, organizerEmail: 'unknown@nowhere.test' });

    expect(result.matchStatus).toBe('matched');
    // The time-window call's organizerUserId param (2nd query, 2nd bind param) must be null.
    const timeWindowCall = fakeClient.query.mock.calls[1]!;
    const timeWindowParams = timeWindowCall[1] as unknown[];
    expect(timeWindowParams[1]).toBeNull();
  });
});
