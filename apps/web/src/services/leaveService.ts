// Web-side leaveService — wraps apps/api/src/routes/leave.ts (PRD §7.2
// 04 PEOPLE → Leave). Same unwrap-the-named-key pattern as
// networkService.ts/peopleService.ts.
import { apiClient } from './apiClient';
import type { LeaveListQuery, LeaveRequest, LeaveRequestInput } from '@nexus/shared';

function toQueryString(query?: LeaveListQuery): string {
  if (!query) return '';
  const params = new URLSearchParams();
  if (query.userId) params.set('userId', query.userId);
  if (query.status) params.set('status', query.status);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function fetchLeaveRequests(query?: LeaveListQuery): Promise<LeaveRequest[]> {
  return apiClient.get<{ requests: LeaveRequest[] }>(`/leave${toQueryString(query)}`).then((res) => res.requests);
}

export function createLeaveRequest(input: LeaveRequestInput): Promise<LeaveRequest> {
  return apiClient.post<LeaveRequest>('/leave', input);
}

export function approveLeaveRequest(id: string, note?: string): Promise<LeaveRequest> {
  return apiClient.post<LeaveRequest>(`/leave/${id}/approve`, note ? { note } : undefined);
}

export function rejectLeaveRequest(id: string, note?: string): Promise<LeaveRequest> {
  return apiClient.post<LeaveRequest>(`/leave/${id}/reject`, note ? { note } : undefined);
}

export function cancelLeaveRequest(id: string): Promise<LeaveRequest> {
  return apiClient.delete<LeaveRequest>(`/leave/${id}`);
}
