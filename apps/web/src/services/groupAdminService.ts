// Web-side groupAdminService — wraps apps/api/src/routes/admin/groupAdmin.ts
// (ADMIN_BUILD_GUIDE.md §3 "Session 6", Group Admin half). Same thin
// wrapper convention as every other *Service.ts in this directory (one
// function per route, all types from @nexus/shared, no business logic
// here). Companies/Analytics/Activity match the three routes that
// actually exist under /api/v1/admin/group — Overview/People/Operations/
// Goals (modules/admin's other four Group Admin tabs) intentionally
// reuse peopleService/goalService/automationService directly instead of
// duplicating wrappers here: those routes are already org-scoped by the
// session cookie, and a Group Admin's session orgId *is* their group, so
// GET /people, GET /goals, GET /automation already return exactly the
// group's own data with no group-specific backend needed.
import { apiClient } from './apiClient';
import type { AuditLogEntry, AuditLogQuery, GroupAnalyticsSummary, Organization } from '@nexus/shared';

export function fetchGroupCompanies(): Promise<Organization[]> {
  return apiClient.get<{ companies: Organization[] }>('/admin/group/companies').then((r) => r.companies);
}

export function fetchGroupAnalyticsOverview(): Promise<GroupAnalyticsSummary> {
  return apiClient.get<GroupAnalyticsSummary>('/admin/group/analytics/overview');
}

export function fetchGroupActivity(query: AuditLogQuery = {}): Promise<AuditLogEntry[]> {
  const params = new URLSearchParams();
  if (query.action) params.set('action', query.action);
  if (query.resourceType) params.set('resourceType', query.resourceType);
  if (query.result) params.set('result', query.result);
  if (query.since) params.set('since', query.since);
  if (query.until) params.set('until', query.until);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return apiClient.get<{ entries: AuditLogEntry[] }>(`/admin/group/activity${qs ? `?${qs}` : ''}`).then((r) => r.entries);
}
