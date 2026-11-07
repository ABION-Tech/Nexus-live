// Web-side companyAdminService — wraps apps/api/src/routes/admin/companyAdmin.ts
// (ADMIN_BUILD_GUIDE.md §3 "Session 6", Company Admin half). Same thin
// wrapper convention as groupAdminService.ts. The admin shell's People/
// Work/Goals/Knowledge tabs deliberately are NOT wrapped here — per the
// guide, Company Admin is "mostly reuse" (a Company Admin is just a
// `leader`), so those stay on the existing top-level sidebar sections
// (People, Work, Goals, Knowledge) rather than being duplicated inside
// /admin; only the five admin-shell-specific tabs (Overview, Analytics,
// Automation, Activity, Settings) live under modules/admin.
import { apiClient } from './apiClient';
import type { AuditLogEntry, AuditLogQuery, AutomationControl, CompanyAnalyticsSummary, TaskTrendPoint } from '@nexus/shared';

export function fetchCompanyOverview(): Promise<CompanyAnalyticsSummary> {
  return apiClient.get<CompanyAnalyticsSummary>('/admin/company/overview');
}

export interface CompanyAnalyticsOverview {
  trends: TaskTrendPoint[];
  blockedCount: number;
  upcomingDeadlineCount: number;
}

export function fetchCompanyAnalyticsOverview(from?: string, to?: string): Promise<CompanyAnalyticsOverview> {
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const qs = params.toString();
  return apiClient.get<CompanyAnalyticsOverview>(`/admin/company/analytics/overview${qs ? `?${qs}` : ''}`);
}

export function fetchCompanyAutomation(): Promise<AutomationControl[]> {
  return apiClient.get<{ controls: AutomationControl[] }>('/admin/company/automation').then((r) => r.controls);
}

export function fetchCompanyActivity(query: AuditLogQuery = {}): Promise<AuditLogEntry[]> {
  const params = new URLSearchParams();
  if (query.action) params.set('action', query.action);
  if (query.resourceType) params.set('resourceType', query.resourceType);
  if (query.result) params.set('result', query.result);
  if (query.since) params.set('since', query.since);
  if (query.until) params.set('until', query.until);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return apiClient.get<{ entries: AuditLogEntry[] }>(`/admin/company/activity${qs ? `?${qs}` : ''}`).then((r) => r.entries);
}
