// Web-side analyticsService — the "Service" in PRD §6's UI → Service →
// Provider chain. Maps 1:1 onto apps/api/src/routes/analytics.ts; the
// Analytics module (modules/analytics/Overview.tsx) never calls apiClient
// or fetch() directly (§6.2: no component makes its own API calls).
import { apiClient } from './apiClient';
import type { Task, TaskTrendPoint, TaskTrendQuery } from '@nexus/shared';
import type { Partnership } from '@nexus/shared';

export function fetchTaskTrends(query: TaskTrendQuery = {}): Promise<TaskTrendPoint[]> {
  const params = new URLSearchParams();
  if (query.from) params.set('from', query.from);
  if (query.to) params.set('to', query.to);
  if (query.userId) params.set('userId', query.userId);
  const qs = params.toString();

  return apiClient
    .get<{ points: TaskTrendPoint[] }>(`/analytics/task-trends${qs ? `?${qs}` : ''}`)
    .then((r) => r.points);
}

export function fetchBlockedTasks(): Promise<Task[]> {
  return apiClient.get<{ tasks: Task[] }>('/analytics/failsafe/blocked').then((r) => r.tasks);
}

export function fetchUpcomingDeadlines(withinDays = 7): Promise<Task[]> {
  return apiClient
    .get<{ tasks: Task[] }>(`/analytics/failsafe/deadlines?withinDays=${withinDays}`)
    .then((r) => r.tasks);
}

// 4th Failsafe category (PRD §8.7/§8.9) — surfaces for Comms & Ops >
// Failsafe Alerts (Analytics' own Overview module doesn't render this
// one yet; it's picked up here for the first caller that needs it).
export function fetchStalePartnerFollowUps(): Promise<Partnership[]> {
  return apiClient.get<{ partnerships: Partnership[] }>('/analytics/failsafe/partners').then((r) => r.partnerships);
}
