// Web-side meetingService — wraps apps/api/src/routes/meetings.ts (PRD
// §8.2). Same unwrap-the-named-key pattern as networkService.ts/
// peopleService.ts for the list endpoints; the recording sub-routes are
// gated on the same 'meetings' resource as the rest of this file per
// meetings.ts's own header note, so they live here rather than in a
// separate service.
import { apiClient } from './apiClient';
import type { CreateMeetingInput, Meeting, MeetingRecording, UpdateMeetingInput } from '@nexus/shared';

export interface MeetingListQuery {
  from?: string;
  to?: string;
  includeArchived?: boolean;
}

function toQueryString(query?: MeetingListQuery): string {
  if (!query) return '';
  const params = new URLSearchParams();
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.includeArchived) params.set('includeArchived', 'true');
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function fetchMeetings(query?: MeetingListQuery): Promise<Meeting[]> {
  return apiClient.get<{ meetings: Meeting[] }>(`/meetings${toQueryString(query)}`).then((res) => res.meetings);
}

export function fetchMeeting(id: string): Promise<Meeting> {
  return apiClient.get<Meeting>(`/meetings/${id}`);
}

export function createMeeting(input: CreateMeetingInput): Promise<Meeting> {
  return apiClient.post<Meeting>('/meetings', input);
}

export function updateMeeting(id: string, input: UpdateMeetingInput): Promise<Meeting> {
  return apiClient.patch<Meeting>(`/meetings/${id}`, input);
}

export function archiveMeeting(id: string): Promise<Meeting> {
  return apiClient.delete<Meeting>(`/meetings/${id}`);
}

export function restoreMeeting(id: string): Promise<Meeting> {
  return apiClient.post<Meeting>(`/meetings/${id}/restore`);
}

// Recordings — see meetingRecordingService.ts's own header for the match
// priority order (exact ID -> time window -> manual). 'matched' rows show
// up per-meeting via fetchMeetingRecordings; 'ambiguous'/'unmatched' rows
// only ever surface through the review queue below until a human links
// them (or a later exact-ID ingest resolves them automatically).
export function fetchMeetingRecordings(meetingId: string): Promise<MeetingRecording[]> {
  return apiClient.get<{ recordings: MeetingRecording[] }>(`/meetings/${meetingId}/recordings`).then((res) => res.recordings);
}

export function fetchRecordingsNeedingReview(): Promise<MeetingRecording[]> {
  return apiClient.get<{ recordings: MeetingRecording[] }>('/meetings/recordings/unmatched').then((res) => res.recordings);
}

export function linkRecordingToMeeting(recordingId: string, meetingId: string): Promise<MeetingRecording> {
  return apiClient.post<MeetingRecording>(`/meetings/recordings/${recordingId}/link`, { meetingId });
}
