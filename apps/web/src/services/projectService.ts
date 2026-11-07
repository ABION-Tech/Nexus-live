// Web-side projectService — wraps apps/api/src/routes/projects.ts.
// GET /projects and GET /projects/:id both return ProjectWithTasks (list
// included) — same "always the full shape" call routes/projects.ts's own
// comment makes, contrast with goalService.ts's fetchGoals returning
// bare Goal[].
import { apiClient } from './apiClient';
import type { Project, ProjectMember, ProjectStatus, ProjectWithTasks } from '@nexus/shared';

export function fetchProjects(status?: ProjectStatus): Promise<ProjectWithTasks[]> {
  const qs = status ? `?status=${status}` : '';
  return apiClient.get<{ projects: ProjectWithTasks[] }>(`/projects${qs}`).then((res) => res.projects);
}

export function fetchProject(id: string): Promise<ProjectWithTasks> {
  return apiClient.get<ProjectWithTasks>(`/projects/${id}`);
}

export function createProject(title: string, description?: string): Promise<Project> {
  return apiClient.post<Project>('/projects', { title, description });
}

// DELETE archives, never hard-deletes — same contract as goalService.archiveGoal.
export function archiveProject(id: string): Promise<Project> {
  return apiClient.delete<Project>(`/projects/${id}`);
}

export function restoreProject(id: string): Promise<Project> {
  return apiClient.post<Project>(`/projects/${id}/restore`, {});
}

export function addProjectMember(projectId: string, email: string): Promise<ProjectMember> {
  return apiClient.post<ProjectMember>(`/projects/${projectId}/members`, { email });
}

export function removeProjectMember(projectId: string, userId: string): Promise<void> {
  return apiClient.delete<void>(`/projects/${projectId}/members/${userId}`);
}
