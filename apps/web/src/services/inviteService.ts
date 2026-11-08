// Web-side inviteService — wraps apps/api/src/routes/invites.ts (Session
// 53 adds GET). Inviting is how a new team member gets an account: they
// accept by signing in with Google using the invited address.
import { apiClient } from './apiClient';
import type { MemberRole, PendingInvite } from '@nexus/shared';

export function fetchPendingInvites(): Promise<PendingInvite[]> {
  return apiClient.get<{ invites: PendingInvite[] }>('/invites').then((r) => r.invites);
}

export function sendInvite(email: string, role: MemberRole): Promise<PendingInvite> {
  return apiClient.post<PendingInvite>('/invites', { email, role });
}

export function cancelInvite(id: string): Promise<void> {
  return apiClient.delete<void>(`/invites/${id}`);
}
