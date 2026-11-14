// Web-side eodService — maps onto apps/api/src/routes/eod.ts. Submit/list
// (Comms & Ops > EOD Report) and attendance (People > Attendance) now
// built alongside the compliance/missing pair Analytics already used.
import { apiClient, postQueueable } from './apiClient';
import type { AttendanceEntry, EodComplianceSummary, EodLog, MissingEodUser, SubmitEodInput } from '@nexus/shared';

export function fetchEodCompliance(date?: string): Promise<EodComplianceSummary> {
  return apiClient.get<EodComplianceSummary>(`/eod/compliance${date ? `?date=${date}` : ''}`);
}

export function fetchMissingEod(date?: string): Promise<MissingEodUser[]> {
  return apiClient.get<{ users: MissingEodUser[] }>(`/eod/missing${date ? `?date=${date}` : ''}`).then((r) => r.users);
}

export function fetchAttendance(date?: string): Promise<AttendanceEntry[]> {
  return apiClient.get<{ entries: AttendanceEntry[] }>(`/eod/attendance${date ? `?date=${date}` : ''}`).then((r) => r.entries);
}

export function fetchEodLogs(date?: string): Promise<EodLog[]> {
  return apiClient.get<{ logs: EodLog[] }>(`/eod${date ? `?date=${date}` : ''}`).then((r) => r.logs);
}

// PRD §15 Phase J — this file's one offline-queued write, alongside
// taskService.ts's createTask (both confirmed single-call-site before
// wiring). Throws `QueuedOfflineError` instead of resolving when the
// write was queued rather than sent — EodReport.tsx's `handleSubmit`
// catches that specifically, since a queued EOD has no real `EodLog.id`
// yet and can't be treated like a normal success (no id to attach a
// proof file to, no row to prepend to today's list).
export function submitEodLog(input: SubmitEodInput): Promise<EodLog> {
  return postQueueable<EodLog>('/eod', input, 'EOD report');
}

/** Session 58 — Activity Log: EOD history between two dates. */
export function fetchEodHistory(params: { from?: string; to?: string; userId?: string } = {}): Promise<{ from: string; to: string; logs: EodLog[] }> {
  const q = new URLSearchParams();
  if (params.from) q.set('from', params.from);
  if (params.to) q.set('to', params.to);
  if (params.userId) q.set('userId', params.userId);
  const qs = q.toString();
  return apiClient.get(`/eod/history${qs ? `?${qs}` : ''}`);
}
