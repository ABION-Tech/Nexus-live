-- 0035_meeting_recordings.sql
-- Closes the `meetings` gap flagged in the ABION demo seed's knownGaps
-- (0034's seed script was the only thing ever writing to `meetings` —
-- no service/route existed). This migration adds the recording/transcript
-- side: PRD §8.2/§8.9's "link to Fireflies, Zoom, Google Meet" ask,
-- landing on the ingest path the Settings > Integrations UI already
-- half-built (Integrations.tsx's "Meeting Ingest Secret — n8n's
-- Fireflies → NEXUS webhook" field, ai_settings.meeting_ingest_secret,
-- both shipped with no endpoint behind them until now).

-- ---------------------------------------------------------------------
-- 1. meetings — a Zoom meeting ID, when scheduled through NEXUS, gives
--    the ingest path an exact match instead of falling back to time-
--    window matching. google_calendar_event_id already exists (0009)
--    and serves the same role for Meet.
-- ---------------------------------------------------------------------
alter table meetings add column zoom_meeting_id text;

-- ---------------------------------------------------------------------
-- 2. meeting_recordings — one row per inbound recording/transcript,
--    kept separate from `meetings` rather than columns-on-meetings:
--    a single meeting can accumulate more than one artifact (e.g. a
--    Zoom cloud recording AND a Fireflies transcript of the same call),
--    and an artifact that arrives before it's matched (or never
--    matches) still needs somewhere durable to live — nullable
--    meeting_id, not a rejected/dropped webhook payload.
--
--    match_status is the actual point of this table. Three sources feed
--    one endpoint (n8n normalizes Fireflies/Zoom/Meet into one shape
--    before it ever reaches NEXUS — see meetingRecordingService.ts's own
--    header), so the ingest side cannot assume which one it's getting;
--    it can only tell whether it's SURE which meeting a payload belongs
--    to:
--      - exact_id: external_meeting_id matched meetings.zoom_meeting_id
--        or meetings.google_calendar_event_id directly. Always resolves
--        to exactly one row.
--      - time_window: no exact ID available (Fireflies joins by call
--        link, not a NEXUS-known ID) — matched by same organizer +
--        overlapping [start_time,end_time], and exactly one candidate
--        existed.
--      - manual: a human resolved it after the fact via the review
--        queue (routes/meetings.ts's /recordings/unmatched).
--    match_status='ambiguous' with meeting_id left null and
--    candidate_meeting_ids populated is the deliberate output when time-
--    window matching finds MORE than one candidate — e.g. the same
--    organizer double-booked, two calls running simultaneously. This
--    row is never auto-resolved to "closest" or "first" candidate; only
--    a human (or an exact-ID match arriving later, e.g. Fireflies fills
--    in Zoom's own meeting ID in a later payload) moves it out of
--    'ambiguous'.
-- ---------------------------------------------------------------------
create table meeting_recordings (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references organizations(id),
  meeting_id              uuid references meetings(id),
  source                  text not null check (source in ('zoom', 'google_meet', 'fireflies')),
  external_meeting_id     text,
  external_transcript_id  text,
  recording_url           text,
  transcript_url          text,
  transcript_text         text,
  call_start_time         timestamptz,
  call_end_time           timestamptz,
  match_method            text not null check (match_method in ('exact_id', 'time_window', 'manual')),
  match_status            text not null default 'unmatched'
                            check (match_status in ('matched', 'ambiguous', 'unmatched')),
  -- populated only while ambiguous/unmatched — the review queue's
  -- candidate list; cleared (left as-is, harmlessly) once matched.
  candidate_meeting_ids   uuid[] not null default '{}',
  raw_payload             jsonb,
  created_at              timestamptz not null default now(),
  archived_at             timestamptz
);
create index idx_meeting_recordings_org on meeting_recordings(org_id);
create index idx_meeting_recordings_meeting on meeting_recordings(meeting_id);
-- Partial index backing the review queue's own query
-- (meetingRecordingService.listNeedingReview) — most rows are quickly
-- matched, so this stays small in practice rather than scanning
-- everything the org has ever ingested.
create index idx_meeting_recordings_needs_review
  on meeting_recordings(org_id, created_at)
  where match_status != 'matched';

alter table meeting_recordings enable row level security;
alter table meeting_recordings force row level security;
create policy tenant_isolation on meeting_recordings
  using (org_id = current_setting('app.current_org_id', true)::uuid);

grant select, insert, update, delete on meeting_recordings to nexus_app;

-- ---------------------------------------------------------------------
-- 3. ai_settings.meeting_ingest_secret — needs a uniqueness guarantee
--    the moment it's used for lookup, not just storage. The ingest
--    webhook (routes/meetingIngestWebhook.ts) arrives with no NEXUS
--    session, so it can only identify which org a payload belongs to by
--    resolving org_id FROM the secret itself (raw pool query, same
--    "checked outside RLS on purpose" shape projectService.fetchMembers'
--    own header documents) — that resolution is only sound if secrets
--    are unique across orgs. 0011 never enforced this since nothing read
--    the column back by value until this migration. Partial (where not
--    null) so multiple orgs leaving it unset don't collide on null=null.
-- ---------------------------------------------------------------------
create unique index idx_ai_settings_meeting_ingest_secret
  on ai_settings(meeting_ingest_secret)
  where meeting_ingest_secret is not null;
