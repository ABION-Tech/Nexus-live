// Web-side approvalService — wraps apps/api/src/routes/approvals.ts (the
// Review Queue, PRD §8.5). Gated on the `goals` permission server-side
// (approvals.ts's own header comment: no separate `approvals` resource
// exists) — nothing extra to encode here, the API just 403s if the
// caller lacks `goals.approve`.
//
// listPendingApprovals (approvalService.ts, API side) always filters
// `status = 'pending'` in the query itself — GET /approvals never
// returns approved/rejected rows, with or without `goalId`. So there's
// no client-side status filter to apply here; the array this returns is
// already exactly "what's awaiting review."
import { apiClient } from './apiClient';
import type { PendingAiTask, Task } from '@nexus/shared';

export function fetchApprovals(goalId?: string): Promise<PendingAiTask[]> {
  const qs = goalId ? `?goalId=${goalId}` : '';
  return apiClient.get<{ items: PendingAiTask[] }>(`/approvals${qs}`).then((res) => res.items);
}

// Approving creates a real task — PRD §8.5: "approved tasks enter Master
// Tasks with dependency ordering." Returns the new Task, not the
// (now-approved) PendingAiTask.
export function approvePendingTask(id: string): Promise<Task> {
  return apiClient.post<Task>(`/approvals/${id}/approve`);
}

export function rejectPendingTask(id: string, reason?: string): Promise<PendingAiTask> {
  return apiClient.post<PendingAiTask>(`/approvals/${id}/reject`, reason ? { reason } : undefined);
}
