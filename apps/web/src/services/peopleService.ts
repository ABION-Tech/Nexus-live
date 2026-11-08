// Web-side peopleService — wraps apps/api/src/routes/people.ts (PRD
// §8.4). GET /people → { people: Person[] }; unwrapped here so callers
// (Partnerships.tsx, OrgDatabase.tsx) just work with a plain array, same
// pattern as networkService.ts's fetch* functions.
import { apiClient } from './apiClient';
import type { MemberRole, Person } from '@nexus/shared';

export function fetchPeople(): Promise<Person[]> {
  return apiClient.get<{ people: Person[] }>('/people').then((res) => res.people);
}

/** Session 53 — leader-only; PATCH /people/:userId/role. */
export function changeMemberRole(userId: string, role: MemberRole): Promise<{ userId: string; role: MemberRole }> {
  return apiClient.patch<{ userId: string; role: MemberRole }>(`/people/${userId}/role`, { role });
}
