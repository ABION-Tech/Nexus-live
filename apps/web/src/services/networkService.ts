// Web-side networkService — wraps apps/api/src/routes/network.ts (PRD
// §8.3). Response shapes here are NOT generic — they mirror exactly what
// that route file sends back for each sub-resource:
//   GET /network/cos            → { cos: NetworkCos[] }
//   GET /network/partnerships   → { partnerships: Partnership[] }
//   GET /network/org-contacts   → { contacts: OrgContact[] }
// Each fetch* function unwraps its own key so callers (Overview.tsx,
// the three module files) just work with plain arrays, same as
// analyticsService.ts's pattern for its own wrapped endpoints.
//
// No archive/delete wrapper for COS or Org Contacts — routes/network.ts
// doesn't expose a DELETE for either (only Partnerships has one, backing
// the MVP's real "mark inactive" affordance there). Not an oversight to
// "fix" here; the route file simply doesn't have the endpoint yet.
import { apiClient } from './apiClient';
import type {
  DocumentStatus,
  LetterStatus,
  NetworkCos,
  NetworkCosStatus,
  OnboardingStatus,
  OrgContact,
  Partnership,
  PartnershipStatus,
} from '@nexus/shared';

// Mirrors apps/api/src/services/networkService.ts's *Input interfaces —
// those live in the API package, not @nexus/shared (only the row shapes
// themselves are shared), so the web side defines its own equivalents
// rather than reaching into the API's internals across the workspace
// boundary.
export interface CosInput {
  state: string;
  adminName?: string;
  adminPhone?: string;
  adminEmail?: string;
  whatsappGroupCreated?: boolean;
  membersCount?: number;
  status?: NetworkCosStatus;
  lastReportDate?: string;
  notes?: string;
}

export interface PartnershipInput {
  assignedToUserId?: string;
  organisation: string;
  contactName?: string;
  contactEmail?: string;
  category?: string;
  currentStatus?: PartnershipStatus;
  documentStatus?: DocumentStatus;
  lastContactDate?: string;
  followUpDate?: string;
  remarks?: string;
}

export interface OrgContactInput {
  contactOwnerUserId?: string;
  visitorName: string;
  position?: string;
  companyOrg?: string;
  email?: string;
  phone?: string;
  state?: string;
  staffSize?: string;
  dateVisited?: string;
  letterStatus?: LetterStatus;
  onboardingStatus?: OnboardingStatus;
  whatsappAdded?: boolean;
  followUpDate?: string;
  notes?: string;
}

// Generic rather than a fixed `Record<string, string | boolean |
// undefined>` param — a named interface (PartnershipListParams,
// OrgContactListParams) isn't assignable to an indexed-signature type
// even when structurally compatible, so a fixed signature rejected every
// caller here. `Object.entries` still only ever sees the same
// string/boolean/undefined value shapes these list-params interfaces
// actually declare.
function toQuery<T extends object>(params: T): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params) as [string, string | boolean | undefined][]) {
    if (value === undefined || value === '') continue;
    usp.set(key, String(value));
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : '';
}

// ---------------------------------------------------------------------
// network_cos (← State Network)
// ---------------------------------------------------------------------

export function fetchNetworkCos(includeArchived?: boolean): Promise<NetworkCos[]> {
  return apiClient
    .get<{ cos: NetworkCos[] }>(`/network/cos${toQuery({ includeArchived })}`)
    .then((res) => res.cos);
}

export function fetchNetworkCosById(id: string): Promise<NetworkCos> {
  return apiClient.get<NetworkCos>(`/network/cos/${id}`);
}

export function createNetworkCos(input: CosInput): Promise<NetworkCos> {
  return apiClient.post<NetworkCos>('/network/cos', input);
}

export function updateNetworkCos(id: string, input: Partial<CosInput>): Promise<NetworkCos> {
  return apiClient.patch<NetworkCos>(`/network/cos/${id}`, input);
}

// ---------------------------------------------------------------------
// partnerships
// ---------------------------------------------------------------------

export interface PartnershipListParams {
  assignedToUserId?: string;
  includeArchived?: boolean;
}

export function fetchPartnerships(params: PartnershipListParams = {}): Promise<Partnership[]> {
  return apiClient
    .get<{ partnerships: Partnership[] }>(`/network/partnerships${toQuery(params)}`)
    .then((res) => res.partnerships);
}

export function fetchPartnershipById(id: string): Promise<Partnership> {
  return apiClient.get<Partnership>(`/network/partnerships/${id}`);
}

export function createPartnership(input: PartnershipInput): Promise<Partnership> {
  return apiClient.post<Partnership>('/network/partnerships', input);
}

export function updatePartnership(id: string, input: Partial<PartnershipInput>): Promise<Partnership> {
  return apiClient.patch<Partnership>(`/network/partnerships/${id}`, input);
}

// The one sub-resource with a real archive endpoint (routes/network.ts's
// DELETE /partnerships/:id) — matches Partnerships being the only one of
// the three tabs the MVP itself tracked a "declined/inactive" close-out
// state for.
export function archivePartnership(id: string): Promise<Partnership> {
  return apiClient.delete<Partnership>(`/network/partnerships/${id}`);
}

// ---------------------------------------------------------------------
// org_contacts (← Org Database)
// ---------------------------------------------------------------------

export interface OrgContactListParams {
  contactOwnerUserId?: string;
  includeArchived?: boolean;
}

export function fetchOrgContacts(params: OrgContactListParams = {}): Promise<OrgContact[]> {
  return apiClient
    .get<{ contacts: OrgContact[] }>(`/network/org-contacts${toQuery(params)}`)
    .then((res) => res.contacts);
}

export function fetchOrgContactById(id: string): Promise<OrgContact> {
  return apiClient.get<OrgContact>(`/network/org-contacts/${id}`);
}

export function createOrgContact(input: OrgContactInput): Promise<OrgContact> {
  return apiClient.post<OrgContact>('/network/org-contacts', input);
}

export function updateOrgContact(id: string, input: Partial<OrgContactInput>): Promise<OrgContact> {
  return apiClient.patch<OrgContact>(`/network/org-contacts/${id}`, input);
}
