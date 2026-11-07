// meetings — the CRUD side of PRD §8.2, closing the gap flagged in the
// ABION demo seed's knownGaps (0034's seed script was the only thing
// ever writing to this table; no service/route existed until now).
// Mirrors projectService.ts's actual structure deliberately — same
// toX/diffColumns/logActivity shape as every other resource here — not
// just its outward interface, so a future reader who knows one knows
// both.
//
// `archived_at` (not a `status` column, unlike projects/goals) is the
// lifecycle field here, per 0009_remaining_entities.sql's own note that
// meetings follow PRD §6.4.1's "archive, never hard-delete" rule for
// entries a user edits over time. archive/restore below are therefore a
// null-check flip on that column, not a status transition.
import { withOrgContext } from '../db.js';
import { diffColumns, logActivity, logActivityCreated } from './activityLogService.js';
import type { CreateMeetingInput, Meeting, MeetingLocationType, UpdateMeetingInput } from '@nexus/shared';

interface MeetingRow {
  id: string;
  org_id: string;
  title: string;
  location_type: MeetingLocationType;
  location_detail: string | null;
  start_time: Date;
  end_time: Date | null;
  organizer_user_id: string | null;
  google_calendar_event_id: string | null;
  zoom_meeting_id: string | null;
  notes: string | null;
  // 0034_abion_demo_seed_gaps.sql
  agenda: string | null;
  invitee_user_ids: string[]; // uuid[] not null default '{}'
  external_emails: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

function toMeeting(row: MeetingRow): Meeting {
  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    locationType: row.location_type,
    locationDetail: row.location_detail ?? undefined,
    startTime: row.start_time.toISOString(),
    endTime: row.end_time?.toISOString(),
    organizerUserId: row.organizer_user_id ?? undefined,
    googleCalendarEventId: row.google_calendar_event_id ?? undefined,
    zoomMeetingId: row.zoom_meeting_id ?? undefined,
    notes: row.notes ?? undefined,
    agenda: row.agenda ?? undefined,
    inviteeUserIds: row.invitee_user_ids,
    externalEmails: row.external_emails ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString(),
  };
}

const UPDATABLE_COLUMNS = [
  'title',
  'location_type',
  'location_detail',
  'start_time',
  'end_time',
  'organizer_user_id',
  'zoom_meeting_id',
  'notes',
  'agenda',
  'invitee_user_ids',
  'external_emails',
] as const;

export async function createMeeting(orgId: string, input: CreateMeetingInput, actorUserId: string | null): Promise<Meeting> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<MeetingRow>(
      `insert into meetings (org_id, title, location_type, location_detail, start_time, end_time, organizer_user_id, zoom_meeting_id, notes, agenda, invitee_user_ids, external_emails)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning *`,
      [
        orgId,
        input.title,
        input.locationType,
        input.locationDetail ?? null,
        input.startTime,
        input.endTime ?? null,
        input.organizerUserId ?? null,
        input.zoomMeetingId ?? null,
        input.notes ?? null,
        input.agenda ?? null,
        input.inviteeUserIds ?? [],
        input.externalEmails ?? null,
      ]
    );
    const meeting = toMeeting(rows[0]!);
    await logActivityCreated(client, { orgId, actorUserId, resourceType: 'meetings', resourceId: meeting.id });
    return meeting;
  });
}

/** Excludes archived meetings by default — same "list = active view,
 * archived is opt-in" convention as every other archivable resource
 * here (contrast with projects/goals, which pass `status` explicitly
 * since they have more than two states; meetings only has two). */
export async function listMeetings(
  orgId: string,
  opts: { from?: string; to?: string; includeArchived?: boolean } = {}
): Promise<Meeting[]> {
  return withOrgContext(orgId, async (client) => {
    const conditions = ['org_id = $1'];
    const params: unknown[] = [orgId];

    if (!opts.includeArchived) conditions.push('archived_at is null');
    if (opts.from) {
      params.push(opts.from);
      conditions.push(`start_time >= $${params.length}`);
    }
    if (opts.to) {
      params.push(opts.to);
      conditions.push(`start_time <= $${params.length}`);
    }

    const { rows } = await client.query<MeetingRow>(
      `select * from meetings where ${conditions.join(' and ')} order by start_time asc`,
      params
    );
    return rows.map(toMeeting);
  });
}

export async function getMeeting(orgId: string, meetingId: string): Promise<Meeting | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<MeetingRow>(`select * from meetings where org_id = $1 and id = $2`, [orgId, meetingId]);
    return rows[0] ? toMeeting(rows[0]) : null;
  });
}

export async function updateMeeting(
  orgId: string,
  meetingId: string,
  input: UpdateMeetingInput,
  actorUserId: string | null
): Promise<Meeting | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows: beforeRows } = await client.query<MeetingRow>(`select * from meetings where org_id = $1 and id = $2`, [orgId, meetingId]);
    const before = beforeRows[0];
    if (!before) return null;

    const sets: string[] = [];
    const params: unknown[] = [orgId, meetingId];
    const fieldMap: Record<string, unknown> = {
      title: input.title,
      location_type: input.locationType,
      location_detail: input.locationDetail,
      start_time: input.startTime,
      end_time: input.endTime,
      organizer_user_id: input.organizerUserId,
      zoom_meeting_id: input.zoomMeetingId,
      notes: input.notes,
      agenda: input.agenda,
      invitee_user_ids: input.inviteeUserIds,
      external_emails: input.externalEmails,
    };
    for (const [col, val] of Object.entries(fieldMap)) {
      if (val === undefined) continue; // undefined = not sent, leave column alone
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }
    if (sets.length === 0) return toMeeting(before); // no-op update, nothing to log

    sets.push('updated_at = now()');
    const { rows } = await client.query<MeetingRow>(
      `update meetings set ${sets.join(', ')} where org_id = $1 and id = $2 returning *`,
      params
    );
    const after = rows[0]!;

    const changes = diffColumns(before, after, [...UPDATABLE_COLUMNS]);
    if (changes.length > 0) {
      await logActivity(client, { orgId, actorUserId, resourceType: 'meetings', resourceId: meetingId, changes });
    }
    return toMeeting(after);
  });
}

export async function archiveMeeting(orgId: string, meetingId: string, actorUserId: string | null = null): Promise<Meeting | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<MeetingRow>(
      `update meetings set archived_at = now() where org_id = $1 and id = $2 and archived_at is null returning *`,
      [orgId, meetingId]
    );
    if (!rows[0]) return null;
    await logActivity(client, {
      orgId,
      actorUserId,
      resourceType: 'meetings',
      resourceId: meetingId,
      changes: [{ field: 'archived_at', oldValue: null, newValue: rows[0].archived_at!.toISOString() }],
    });
    return toMeeting(rows[0]);
  });
}

export async function restoreMeeting(orgId: string, meetingId: string, actorUserId: string | null = null): Promise<Meeting | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows: beforeRows } = await client.query<MeetingRow>(`select * from meetings where org_id = $1 and id = $2`, [orgId, meetingId]);
    const before = beforeRows[0];
    if (!before || !before.archived_at) return null;

    const { rows } = await client.query<MeetingRow>(
      `update meetings set archived_at = null where org_id = $1 and id = $2 returning *`,
      [orgId, meetingId]
    );
    const after = rows[0]!;
    await logActivity(client, {
      orgId,
      actorUserId,
      resourceType: 'meetings',
      resourceId: meetingId,
      changes: [{ field: 'archived_at', oldValue: before.archived_at.toISOString(), newValue: null }],
    });
    return toMeeting(after);
  });
}
