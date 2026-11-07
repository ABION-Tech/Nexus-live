// Web-side taskService — wraps apps/api/src/routes/tasks.ts (PRD §8.2).
// GET /tasks is paginated ({ tasks, total, page, pageSize }, PRD §13.4's
// pagination-enforcement rule) — unlike networkService.ts's flat-array
// endpoints, so fetchTasks unwraps `.tasks` and drops pagination metadata
// for now (Work's list views don't paginate yet; the API already does
// the enforcement server-side regardless of what the client asks for).
import { apiClient, postQueueable } from './apiClient';
import type { Task, TaskStatus } from '@nexus/shared';

// Mirrors apps/api/src/services/taskService.ts's *Input interfaces —
// same reasoning as networkService.ts's CosInput/PartnershipInput: those
// live in the API package, not @nexus/shared, so the web side defines
// its own equivalent rather than reaching across the workspace boundary.
export interface TaskCreateInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  assignedToUserId?: string;
  supportUserId?: string;
  supervisorUserId?: string;
  dependsOnTaskId?: string;
  goalId?: string;
  business?: string;
  department?: string;
  deadline?: string;
}

export interface TaskUpdateInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  assignedToUserId?: string | null;
  supportUserId?: string | null;
  supervisorUserId?: string | null;
  dependsOnTaskId?: string | null;
  goalId?: string | null;
  business?: string;
  department?: string;
  deadline?: string | null;
}

export interface TaskListParams {
  status?: TaskStatus;
  assignedToUserId?: string;
  // Session 35 — "assigned to me OR I'm the support OR I'm the
  // supervisor". See taskService.ts (api)'s own comment on
  // `TaskListQuery.involvingUserId` for why this is a separate filter
  // from `assignedToUserId` rather than folded into it.
  involvingUserId?: string;
  goalId?: string;
  includeArchived?: boolean;
}

function toQueryString(params: TaskListParams): string {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.assignedToUserId) qs.set('assignedToUserId', params.assignedToUserId);
  if (params.involvingUserId) qs.set('involvingUserId', params.involvingUserId);
  if (params.goalId) qs.set('goalId', params.goalId);
  if (params.includeArchived) qs.set('includeArchived', 'true');
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export function fetchTasks(params: TaskListParams = {}): Promise<Task[]> {
  return apiClient
    .get<{ tasks: Task[]; total: number; page: number; pageSize: number }>(`/tasks${toQueryString(params)}`)
    .then((res) => res.tasks);
}

// PRD §15 Phase J — the one write-path in this file wired into the
// offline queue this session (TaskSection.tsx's handleCreate is
// `createTask`'s only call site, confirmed before wiring this). Resolves
// to the real, server-assigned `Task` when the POST goes through
// normally; throws `QueuedOfflineError` (apiClient.ts) instead of
// resolving when the write got queued because the browser was offline or
// the request failed at the network level — TaskSection.tsx's
// `handleCreate` catches that case specifically. `updateTask` and
// `archiveTask` below are unchanged: neither has been wired into the
// queue this session, so both still fail outright when offline, same as
// every other mutation in this codebase that isn't `createTask` or
// eodService.ts's `submitEodLog`.
export function createTask(input: TaskCreateInput): Promise<Task> {
  return postQueueable<Task>('/tasks', input, 'Task');
}

export function updateTask(id: string, input: TaskUpdateInput): Promise<Task> {
  return apiClient.patch<Task>(`/tasks/${id}`, input);
}

// DELETE archives, never hard-deletes (PRD §6.4.1) — same contract as
// networkService.ts's archivePartnership.
export function archiveTask(id: string): Promise<Task> {
  return apiClient.delete<Task>(`/tasks/${id}`);
}

// TaskDrawer.tsx's "People on this task" panel (0032_task_assignees.sql).
// Mirrors apps/api/src/services/taskService.ts's own TaskAssignee shape —
// same "web defines its own equivalent rather than reaching into the API
// package" reasoning as TaskCreateInput/TaskUpdateInput above.
export type TaskAssigneeRole = 'assignee' | 'support';

export interface TaskAssignee {
  id: string;
  taskId: string;
  userId: string;
  role: TaskAssigneeRole;
  createdAt: string;
}

export function fetchTaskAssignees(taskId: string): Promise<TaskAssignee[]> {
  return apiClient.get<TaskAssignee[]>(`/tasks/${taskId}/assignees`);
}

export function addTaskAssignee(taskId: string, userId: string, role: TaskAssigneeRole): Promise<TaskAssignee> {
  return apiClient.post<TaskAssignee>(`/tasks/${taskId}/assignees`, { userId, role });
}

// Not wired into the offline write queue (postQueueable) — same
// unaddressed gap NEXT_STEPS.md's own standing-gaps section already
// flags for updateTask/archiveTask above; this is a third single-call-site
// write joining that same open question rather than a new one.
export function removeTaskAssignee(taskId: string, userId: string, role: TaskAssigneeRole): Promise<void> {
  return apiClient.delete<void>(`/tasks/${taskId}/assignees/${userId}/${role}`);
}
