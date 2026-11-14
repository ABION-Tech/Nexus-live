// Session 58 — GET /overview (apps/api/src/routes/overview.ts): the real
// Dashboard and the sidebar's live counts.
import { apiClient } from './apiClient';

export interface OverviewCounts {
  activeTasks: number;
  blocked: number;
  overdue: number;
  atRisk: number;
  stale: number;
  partnerships: number;
  partnerFollowUps: number;
  followUps: number;
  missingEod: number;
  failsafe: number;
  reviewPending: number;
  upcomingMeetings: number;
  marketingOpen: number;
}

export interface RecentTask {
  id: string;
  ref: string | null;
  title: string;
  status: string;
  priority: string;
  assignee: string | null;
  deadline: string | null;
  notes: string | null;
  checklistDone: number;
  checklistTotal: number;
}

export interface Overview {
  today: string;
  counts: OverviewCounts;
  recentTasks: RecentTask[];
}

export const fetchOverview = (recent = 10) => apiClient.get<Overview>(`/overview?recent=${recent}`);

/** A short human id (T-031, NEXUS-004) when the task has one; long
 * machine ids from imports aren't worth showing. */
export function shortRef(ref: string | null | undefined): string | null {
  return ref && /^[A-Z]{1,6}-?\d{1,5}$/.test(ref) ? ref : null;
}
