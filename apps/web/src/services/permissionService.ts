// Web-side permissionService — wraps apps/api/src/routes/permissions.ts.
// Same unwrap convention as automationService.ts/networkService.ts: the
// server envelopes the list response in { permissions }; unwrap here so
// TeamRoles.tsx receives the array directly. Grant/revoke are already
// bare (POST returns the created Permission, DELETE returns 204/no
// body), so no unwrap needed on those two.
import { apiClient } from './apiClient';
import type { Permission, PermissionAction } from '@nexus/shared';

export function fetchPermissionsForUser(userId: string): Promise<Permission[]> {
  return apiClient
    .get<{ permissions: Permission[] }>(`/permissions?userId=${encodeURIComponent(userId)}`)
    .then((r) => r.permissions);
}

export function grantPermission(userId: string, resource: string, action: PermissionAction): Promise<Permission> {
  return apiClient.post<Permission>('/permissions', { userId, resource, action });
}

// 204 No Content — apiClient's request() already guards this case
// (fixed in this same session, see apiClient.ts), returning undefined
// rather than throwing on the empty body.
export function revokePermission(id: string): Promise<void> {
  return apiClient.delete<void>(`/permissions/${id}`);
}
