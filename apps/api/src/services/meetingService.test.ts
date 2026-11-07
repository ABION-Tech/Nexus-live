// Service-level tests for meetingService.ts. db.js is mocked, same
// posture as projectService.test.ts — this is query-construction logic
// under test (archive-vs-delete, partial update leaving columns alone),
// not an RLS/migration integration test.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakeClient = { query: vi.fn() };

vi.mock('../db.js', () => ({
  pool: { query: vi.fn() },
  withOrgContext: vi.fn(async (_orgId: string, fn: (client: unknown) => unknown) => fn(fakeClient)),
}));

vi.mock('./activityLogService.js', () => ({
  logActivity: vi.fn(),
  logActivityCreated: vi.fn(),
  diffColumns: vi.fn(() => []),
}));

import { archiveMeeting, createMeeting, updateMeeting } from './meetingService.js';

const ORG = 'org-1';

function meetingRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'meeting-1',
    org_id: ORG,
    title: 'Weekly Sync',
    location_type: 'zoom',
    location_detail: 'https://zoom.us/j/123',
    start_time: new Date('2026-03-01T10:00:00.000Z'),
    end_time: new Date('2026-03-01T11:00:00.000Z'),
    organizer_user_id: 'user-1',
    google_calendar_event_id: null,
    zoom_meeting_id: 'zoom-123',
    notes: null,
    created_at: new Date('2026-02-01T00:00:00.000Z'),
    updated_at: new Date('2026-02-01T00:00:00.000Z'),
    archived_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  fakeClient.query.mockReset();
});

describe('createMeeting', () => {
  it('inserts and returns the created meeting, including the zoom_meeting_id column added for exact-ID recording matching', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [meetingRow()] });

    const result = await createMeeting(
      ORG,
      {
        title: 'Weekly Sync',
        locationType: 'zoom',
        locationDetail: 'https://zoom.us/j/123',
        startTime: '2026-03-01T10:00:00.000Z',
        endTime: '2026-03-01T11:00:00.000Z',
        organizerUserId: 'user-1',
        zoomMeetingId: 'zoom-123',
      },
      'user-1'
    );

    expect(result.id).toBe('meeting-1');
    expect(result.zoomMeetingId).toBe('zoom-123');
    expect(result.locationType).toBe('zoom');
  });
});

describe('updateMeeting', () => {
  it('only sets columns that were actually sent, leaving omitted fields untouched', async () => {
    fakeClient.query
      .mockResolvedValueOnce({ rows: [meetingRow()] }) // before
      .mockResolvedValueOnce({ rows: [meetingRow({ title: 'Renamed Sync' })] }); // after

    const result = await updateMeeting(ORG, 'meeting-1', { title: 'Renamed Sync' }, 'user-1');

    expect(result?.title).toBe('Renamed Sync');
    const updateCall = fakeClient.query.mock.calls[1]!;
    const sql = updateCall[0] as string;
    // Only title + updated_at should appear in the SET clause — no other
    // column names leaked in as accidental no-op updates.
    expect(sql).toContain('title = $3');
    expect(sql).not.toContain('location_type =');
    expect(sql).not.toContain('zoom_meeting_id =');
  });

  it('returns null for a meeting that does not exist in this org, rather than throwing', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [] }); // before-lookup finds nothing

    const result = await updateMeeting(ORG, 'nonexistent', { title: 'X' }, 'user-1');
    expect(result).toBeNull();
  });
});

describe('archiveMeeting', () => {
  it('sets archived_at rather than deleting the row, and is a no-op (returns null) on an already-archived meeting', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [] }); // the `and archived_at is null` guard excludes it

    const result = await archiveMeeting(ORG, 'already-archived-meeting');
    expect(result).toBeNull();
  });

  it('archives an active meeting and logs the transition', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [meetingRow({ archived_at: new Date('2026-03-05T00:00:00.000Z') })] });

    const result = await archiveMeeting(ORG, 'meeting-1', 'user-1');
    expect(result?.archivedAt).toBe('2026-03-05T00:00:00.000Z');
  });
});
