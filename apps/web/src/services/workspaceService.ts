// Session 57 — one person, many companies (apps/api/src/routes/workspaces.ts).
import type { CrossCompanyTask, Workspace, WorkspaceInvitation } from '@nexus/shared';
import { apiClient } from './apiClient';

export interface WorkspaceState {
  workspaces: Workspace[];
  invitations: WorkspaceInvitation[];
}

export const fetchWorkspaces = () => apiClient.get<WorkspaceState>('/me/workspaces');

export const switchWorkspace = (orgId: string) =>
  apiClient.post<{ workspace: Workspace }>('/me/workspaces/switch', { orgId }).then((r) => r.workspace);

export const setHomeWorkspace = (orgId: string) => apiClient.post<{ ok: true }>('/me/workspaces/home', { orgId });

export const acceptInvitation = (id: string) =>
  apiClient.post<{ workspace: Workspace }>(`/me/invitations/${id}/accept`, {}).then((r) => r.workspace);

export const declineInvitation = (id: string) => apiClient.post<{ ok: true }>(`/me/invitations/${id}/decline`, {});

export interface MyWork {
  companies: { id: string; name: string; open: number }[];
  tasks: CrossCompanyTask[];
}

export function fetchMyWork(opts: { orgId?: string; includeDone?: boolean } = {}): Promise<MyWork> {
  const q = new URLSearchParams();
  if (opts.orgId) q.set('orgId', opts.orgId);
  if (opts.includeDone) q.set('includeDone', 'true');
  const qs = q.toString();
  return apiClient.get<MyWork>(`/me/work${qs ? `?${qs}` : ''}`);
}

export const ROLE_LABEL: Record<string, string> = {
  leader: 'Leader',
  team_member: 'Team member',
  intern: 'Intern',
  guest: 'Guest',
};
