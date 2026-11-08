// Web-side superAdminService — wraps apps/api/src/routes/admin/superAdmin.ts
// (ADMIN_BUILD_GUIDE.md §3 "Session 4" backend / "Session 5" UI, this
// session — repo Session 43). Same thin one-function-per-route wrapper
// convention as groupAdminService.ts/companyAdminService.ts; no business
// logic here.
import { apiClient } from './apiClient';
import type {
  BillingSummary,
  BillingTierKey,
  MemberRole,
  PendingInvite,
  Person,
  PlatformAdminEntry,
  AuditLogEntry,
  AuditLogQuery,
  BillingReviewQueueEntry,
  Organization,
  OrgType,
  PlatformAnalyticsSummary,
  PlatformUserSummary,
  ResolvedBillingReview,
  SystemHealthReport,
} from '@nexus/shared';

export function fetchPlatformAnalytics(): Promise<PlatformAnalyticsSummary> {
  return apiClient.get<PlatformAnalyticsSummary>('/admin/super/analytics/overview');
}

export function fetchSystemHealth(): Promise<SystemHealthReport> {
  return apiClient.get<SystemHealthReport>('/admin/super/system-health');
}

export function searchOrganizations(q?: string): Promise<Organization[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  return apiClient.get<{ organizations: Organization[] }>(`/admin/super/investigate/organizations${qs}`).then((r) => r.organizations);
}

export function searchPlatformUsers(q?: string): Promise<PlatformUserSummary[]> {
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  return apiClient.get<{ users: PlatformUserSummary[] }>(`/admin/super/investigate/users${qs}`).then((r) => r.users);
}

export interface CreateOrganizationInput {
  name: string;
  orgType: OrgType;
  parentOrgId?: string;
}

export function createOrganization(input: CreateOrganizationInput): Promise<Organization> {
  return apiClient.post<Organization>('/admin/super/organizations', input);
}

export interface UpdateOrganizationInput {
  name?: string;
  plan?: 'free' | 'paid';
  active?: boolean;
}

export function updateOrganization(id: string, input: UpdateOrganizationInput): Promise<Organization> {
  return apiClient.patch<Organization>(`/admin/super/organizations/${id}`, input);
}

export function deactivateOrganization(id: string): Promise<Organization> {
  return apiClient.post<Organization>(`/admin/super/organizations/${id}/deactivate`);
}

export function assignCompanyToGroup(id: string, groupOrgId: string | null): Promise<Organization> {
  return apiClient.post<Organization>(`/admin/super/organizations/${id}/assign-group`, { groupOrgId });
}

// ---- Billing review queue (Session 47 backend / this session's UI) --------
// Wraps superAdmin.ts's own §"Billing review queue" block. Both routes
// now go through billingService.ts's own listBillingPendingReview/
// resolveBillingReviewEntry mappers server-side, so these use the
// shared, camelCase @nexus/shared types rather than hand-typed
// snake_case shapes.

export function fetchBillingReviewQueue(): Promise<BillingReviewQueueEntry[]> {
  return apiClient.get<{ entries: BillingReviewQueueEntry[] }>('/admin/super/billing/review-queue').then((r) => r.entries);
}

export interface ResolveBillingReviewInput {
  tier?: string;
  billingStatus?: string;
  note?: string;
}

export function resolveBillingReview(orgId: string, input: ResolveBillingReviewInput): Promise<ResolvedBillingReview> {
  return apiClient.post<ResolvedBillingReview>(`/admin/super/billing/review-queue/${orgId}/resolve`, input);
}

export function fetchAuditLog(query: AuditLogQuery = {}): Promise<AuditLogEntry[]> {
  const params = new URLSearchParams();
  if (query.orgId) params.set('orgId', query.orgId);
  if (query.userId) params.set('userId', query.userId);
  if (query.action) params.set('action', query.action);
  if (query.resourceType) params.set('resourceType', query.resourceType);
  if (query.result) params.set('result', query.result);
  if (query.since) params.set('since', query.since);
  if (query.until) params.set('until', query.until);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const qs = params.toString();
  return apiClient.get<{ entries: AuditLogEntry[] }>(`/admin/super/audit-log${qs ? `?${qs}` : ''}`).then((r) => r.entries);
}

// ---- Session 53: people, invites and Super Admins ------------------------

export function fetchOrgMembers(orgId: string): Promise<{ people: Person[]; invites: PendingInvite[] }> {
  return apiClient.get<{ people: Person[]; invites: PendingInvite[] }>(`/admin/super/organizations/${orgId}/members`);
}

export function inviteToOrganization(orgId: string, email: string, role: MemberRole): Promise<PendingInvite> {
  return apiClient.post<PendingInvite>(`/admin/super/organizations/${orgId}/invites`, { email, role });
}

export function cancelOrganizationInvite(orgId: string, inviteId: string): Promise<void> {
  return apiClient.delete<void>(`/admin/super/organizations/${orgId}/invites/${inviteId}`);
}

export function changeOrganizationMemberRole(orgId: string, userId: string, role: MemberRole): Promise<{ userId: string; role: MemberRole }> {
  return apiClient.patch<{ userId: string; role: MemberRole }>(`/admin/super/organizations/${orgId}/members/${userId}/role`, { role });
}

export function fetchPlatformAdmins(): Promise<PlatformAdminEntry[]> {
  return apiClient.get<{ admins: PlatformAdminEntry[] }>('/admin/super/platform-admins').then((r) => r.admins);
}

export type AddPlatformAdminResult =
  | { status: 'granted'; admin: PlatformAdminEntry }
  | { status: 'invited'; invite: PendingInvite };

export function addPlatformAdmin(input: { email: string; homeOrgId?: string; role?: MemberRole }): Promise<AddPlatformAdminResult> {
  return apiClient.post<AddPlatformAdminResult>('/admin/super/platform-admins', input);
}

export function removePlatformAdmin(userId: string): Promise<void> {
  return apiClient.delete<void>(`/admin/super/platform-admins/${userId}`);
}

export function fetchOrganizationBilling(orgId: string): Promise<BillingSummary> {
  return apiClient.get<BillingSummary>(`/admin/super/organizations/${orgId}/billing`);
}

export function setOrganizationBillingTier(orgId: string, tier: BillingTierKey): Promise<BillingSummary> {
  return apiClient.patch<BillingSummary>(`/admin/super/organizations/${orgId}/billing`, { tier });
}
