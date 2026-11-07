// meeting_recordings — the recording/transcript half of PRD §8.2/§8.9's
// "link to Fireflies, Zoom, Google Meet" ask. One ingest entry point
// (routes/meetingIngestWebhook.ts) feeds all three sources: n8n
// normalizes whichever platform it's watching into one
// `MeetingIngestPayload` shape before it ever reaches NEXUS
// (Integrations.tsx's "Meeting Ingest Secret — n8n's Fireflies → NEXUS
// webhook" label), so this service never parses a vendor-specific
// payload directly.
//
// Matching runs in a strict priority order, and the whole point of this
// file is what it refuses to do at step 2:
//
//   1. Exact ID match — payload.externalMeetingId against
//      meetings.zoom_meeting_id or meetings.google_calendar_event_id.
//      Zoom and Google Meet always have one of these the moment the
//      meeting was scheduled through NEXUS, so this is the common case
//      for those two sources and it always resolves to exactly one row.
//
//   2. Time-window match — only when step 1 finds nothing (this is the
//      normal case for Fireflies, which joins a call by link, not a
//      NEXUS-known ID). Candidates are same organizer (when
//      organizerEmail resolves to a user) + overlapping
//      [start_time, end_time] within a small tolerance.
//        - exactly one candidate  -> matched
//        - zero candidates        -> unmatched (stored regardless, for
//                                     the manual review queue)
//        - two or more candidates -> ambiguous. meeting_id stays null;
//          candidate_meeting_ids holds every candidate. This is the
//          simultaneous-meetings case: the same organizer double-booked,
//          or two unrelated calls both happen to overlap this transcript
//          — either way, NEVER auto-pick the "closest" or "first" one.
//          Only a human (routes/meetings.ts's manual-link endpoint) or a
//          later exact-ID match moves a row out of 'ambiguous'.
//
//   3. Manual — a human resolves an unmatched/ambiguous row via the
//      review queue.
import { withOrgContext } from '../db.js';
import type { MeetingIngestPayload, MeetingRecording, MeetingRecordingMatchMethod, MeetingRecordingMatchStatus, MeetingRecordingSource } from '@nexus/shared';
import type { PoolClient } from 'pg';

interface MeetingRecordingRow {
  id: string;
  org_id: string;
  meeting_id: string | null;
  source: MeetingRecordingSource;
  external_meeting_id: string | null;
  external_transcript_id: string | null;
  recording_url: string | null;
  transcript_url: string | null;
  transcript_text: string | null;
  call_start_time: Date | null;
  call_end_time: Date | null;
  match_method: MeetingRecordingMatchMethod;
  match_status: MeetingRecordingMatchStatus;
  candidate_meeting_ids: string[];
  created_at: Date;
}

function toMeetingRecording(row: MeetingRecordingRow): MeetingRecording {
  return {
    id: row.id,
    orgId: row.org_id,
    meetingId: row.meeting_id ?? undefined,
    source: row.source,
    externalMeetingId: row.external_meeting_id ?? undefined,
    externalTranscriptId: row.external_transcript_id ?? undefined,
    recordingUrl: row.recording_url ?? undefined,
    transcriptUrl: row.transcript_url ?? undefined,
    transcriptText: row.transcript_text ?? undefined,
    callStartTime: row.call_start_time?.toISOString(),
    callEndTime: row.call_end_time?.toISOString(),
    matchMethod: row.match_method,
    matchStatus: row.match_status,
    candidateMeetingIds: row.candidate_meeting_ids,
    createdAt: row.created_at.toISOString(),
  };
}

/** ±5 minutes either side. Wide enough to absorb a source's clock/join
 * jitter (Fireflies' bot joining a minute late, a host starting early),
 * narrow enough that two genuinely back-to-back meetings on the same
 * organizer's calendar don't spuriously overlap. Not user-configurable
 * today — a per-org tolerance setting is a reasonable future ask, but
 * nothing in the PRD calls for it, so it isn't invented here. */
const MATCH_TOLERANCE_MINUTES = 5;

async function findExactIdMatch(client: PoolClient, orgId: string, externalMeetingId: string): Promise<{ id: string } | null> {
  const { rows } = await client.query<{ id: string }>(
    `select id from meetings
      where org_id = $1 and archived_at is null
        and (zoom_meeting_id = $2 or google_calendar_event_id = $2)`,
    [orgId, externalMeetingId]
  );
  // Uniqueness isn't DB-enforced on these two columns (a legacy-import
  // edge case could in principle duplicate one) — if it ever somehow
  // isn't exactly one row, that's not a safe exact match either;
  // fall through to time-window rather than guessing which row is right.
  return rows.length === 1 ? rows[0]! : null;
}

async function resolveOrganizerUserId(client: PoolClient, orgId: string, organizerEmail: string | undefined): Promise<string | null> {
  if (!organizerEmail) return null;
  const { rows } = await client.query<{ id: string }>(
    `select id from users where home_org_id = $1 and email = $2`,
    [orgId, organizerEmail]
  );
  return rows[0]?.id ?? null;
}

async function findTimeWindowCandidates(
  client: PoolClient,
  orgId: string,
  organizerUserId: string | null,
  callStart: string,
  callEnd: string
): Promise<Array<{ id: string }>> {
  const { rows } = await client.query<{ id: string }>(
    `select id from meetings
      where org_id = $1
        and archived_at is null
        and ($2::uuid is null or organizer_user_id = $2)
        and start_time - make_interval(mins => $5) <= $4::timestamptz
        and coalesce(end_time, start_time) + make_interval(mins => $5) >= $3::timestamptz
      order by start_time asc`,
    [orgId, organizerUserId, callStart, callEnd, MATCH_TOLERANCE_MINUTES]
  );
  return rows;
}

export async function ingestMeetingRecording(orgId: string, payload: MeetingIngestPayload): Promise<MeetingRecording> {
  return withOrgContext(orgId, async (client) => {
    const callStart = payload.callStartTime;
    const callEnd = payload.callEndTime ?? payload.callStartTime;

    let meetingId: string | null = null;
    let matchMethod: MeetingRecordingMatchMethod;
    let matchStatus: MeetingRecordingMatchStatus;
    let candidateMeetingIds: string[] = [];

    const exact = payload.externalMeetingId ? await findExactIdMatch(client, orgId, payload.externalMeetingId) : null;

    if (exact) {
      meetingId = exact.id;
      matchMethod = 'exact_id';
      matchStatus = 'matched';
    } else {
      const organizerUserId = await resolveOrganizerUserId(client, orgId, payload.organizerEmail);
      const candidates = await findTimeWindowCandidates(client, orgId, organizerUserId, callStart, callEnd);
      matchMethod = 'time_window';
      if (candidates.length === 1) {
        meetingId = candidates[0]!.id;
        matchStatus = 'matched';
      } else if (candidates.length === 0) {
        matchStatus = 'unmatched';
      } else {
        // Two or more overlapping candidates — the simultaneous-meetings
        // case. Deliberately not resolved here; see file header.
        matchStatus = 'ambiguous';
        candidateMeetingIds = candidates.map((c) => c.id);
      }
    }

    const { rows } = await client.query<MeetingRecordingRow>(
      `insert into meeting_recordings (
         org_id, meeting_id, source, external_meeting_id, external_transcript_id,
         recording_url, transcript_url, transcript_text, call_start_time, call_end_time,
         match_method, match_status, candidate_meeting_ids, raw_payload
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       returning *`,
      [
        orgId,
        meetingId,
        payload.source,
        payload.externalMeetingId ?? null,
        payload.externalTranscriptId ?? null,
        payload.recordingUrl ?? null,
        payload.transcriptUrl ?? null,
        payload.transcriptText ?? null,
        callStart,
        callEnd,
        matchMethod,
        matchStatus,
        candidateMeetingIds,
        JSON.stringify(payload),
      ]
    );
    return toMeetingRecording(rows[0]!);
  });
}

/** The review queue routes/meetings.ts's GET /recordings/unmatched
 * backs — anything not cleanly matched, oldest first so a long-ambiguous
 * row doesn't get buried under newer ones. */
export async function listRecordingsNeedingReview(orgId: string): Promise<MeetingRecording[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<MeetingRecordingRow>(
      `select * from meeting_recordings where org_id = $1 and match_status != 'matched' order by created_at asc`,
      [orgId]
    );
    return rows.map(toMeetingRecording);
  });
}

export async function listRecordingsForMeeting(orgId: string, meetingId: string): Promise<MeetingRecording[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<MeetingRecordingRow>(
      `select * from meeting_recordings where org_id = $1 and meeting_id = $2 order by created_at asc`,
      [orgId, meetingId]
    );
    return rows.map(toMeetingRecording);
  });
}

/** The one human-in-the-loop step this whole design defers to for
 * anything ambiguous or unmatched. Requires the target meeting to
 * actually exist in this org — a typo'd meetingId doesn't silently
 * "link" to nothing. Deliberately does NOT allow re-linking an
 * already-matched row through this path (that would let a manual action
 * quietly override an exact_id match); a genuine correction should
 * archive/re-ingest instead. */
export async function manuallyLinkRecording(orgId: string, recordingId: string, meetingId: string): Promise<MeetingRecording | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<MeetingRecordingRow>(
      `update meeting_recordings
          set meeting_id = $3, match_method = 'manual', match_status = 'matched'
        where org_id = $1 and id = $2 and match_status != 'matched'
          and exists (select 1 from meetings m where m.id = $3 and m.org_id = $1)
        returning *`,
      [orgId, recordingId, meetingId]
    );
    return rows[0] ? toMeetingRecording(rows[0]) : null;
  });
}
