// Web-side goalService — wraps apps/api/src/routes/goals.ts (PRD §8.5).
// GET /goals → { goals: Goal[] }, unwrapped here same as every other
// list-wrapping route (networkService.ts, peopleService.ts pattern).
// GET /goals/:id already returns GoalWithProgress directly (no wrapper
// key) — matches routes/goals.ts's `reply.send(goal)`.
import { apiClient } from './apiClient';
import type { Goal, GoalStatus, GoalWithProgress, PendingAiTask, ProposedTaskInput } from '@nexus/shared';

export function fetchGoals(status?: GoalStatus): Promise<Goal[]> {
  const qs = status ? `?status=${status}` : '';
  return apiClient.get<{ goals: Goal[] }>(`/goals${qs}`).then((res) => res.goals);
}

export function fetchGoal(id: string): Promise<GoalWithProgress> {
  return apiClient.get<GoalWithProgress>(`/goals/${id}`);
}

// `proposedTasks` deliberately omitted (not sent as `undefined` vs sent
// as `[]`) triggers the server's real AIService decomposition call —
// routes/goals.ts's resolveProposedTasks() only skips the AI call when
// the key is genuinely absent from the JSON body. Passing `undefined`
// here and letting JSON.stringify drop it is exactly that "absent" case.
export function createGoal(
  title: string,
  proposedTasks?: ProposedTaskInput[]
): Promise<{ goal: Goal; pendingTasks: PendingAiTask[] }> {
  return apiClient.post('/goals', proposedTasks === undefined ? { title } : { title, proposedTasks });
}

export function regenerateGoal(id: string, proposedTasks?: ProposedTaskInput[]) {
  return apiClient.post(`/goals/${id}/regenerate`, proposedTasks === undefined ? {} : { proposedTasks });
}

// DELETE archives, never hard-deletes (PRD §6.4.1) — same contract as
// taskService.archiveTask / networkService.archivePartnership.
export function archiveGoal(id: string): Promise<Goal> {
  return apiClient.delete<Goal>(`/goals/${id}`);
}

// Counterpart to archiveGoal — not in the original PRD §6.4.1 route list,
// added server-side (routes/goals.ts POST /:id/restore) so archived
// goals have a way back instead of being a dead end.
export function restoreGoal(id: string): Promise<Goal> {
  return apiClient.post<Goal>(`/goals/${id}/restore`, {});
}
