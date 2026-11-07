// PRD §8.3 Network domain — one service file backing the three
// consolidated MVP tabs (0008_network.sql). Mirrors taskService.ts's
// row-mapping/CRUD shape; COS has no per-row owner (see migration
// comment), Partnerships/OrgContacts do — isOwnPartnership/
// isOwnOrgContact exist for the same reason taskService.ts's isOwnTask
// does: routes decide own-record access after loading the row, a
// generic preHandler can't.
import { withOrgContext } from '../db.js';
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

// ---------------------------------------------------------------------
// network_cos
// ---------------------------------------------------------------------

interface NetworkCosRow {
  id: string;
  org_id: string;
  state: string;
  admin_name: string | null;
  admin_phone: string | null;
  admin_email: string | null;
  whatsapp_group_created: boolean;
  members_count: number | null;
  status: NetworkCosStatus;
  last_report_date: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

function toNetworkCos(row: NetworkCosRow): NetworkCos {
  return {
    id: row.id,
    orgId: row.org_id,
    state: row.state,
    adminName: row.admin_name ?? undefined,
    adminPhone: row.admin_phone ?? undefined,
    adminEmail: row.admin_email ?? undefined,
    whatsappGroupCreated: row.whatsapp_group_created,
    membersCount: row.members_count ?? undefined,
    status: row.status,
    lastReportDate: row.last_report_date ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString(),
  };
}

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

export async function listNetworkCos(orgId: string, includeArchived = false): Promise<NetworkCos[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<NetworkCosRow>(
      `select * from network_cos where org_id = $1 ${includeArchived ? '' : 'and archived_at is null'} order by state`,
      [orgId]
    );
    return rows.map(toNetworkCos);
  });
}

export async function getNetworkCosById(orgId: string, id: string): Promise<NetworkCos | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<NetworkCosRow>(`select * from network_cos where org_id = $1 and id = $2`, [orgId, id]);
    return rows[0] ? toNetworkCos(rows[0]) : null;
  });
}

export async function createNetworkCos(orgId: string, input: CosInput): Promise<NetworkCos> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<NetworkCosRow>(
      `insert into network_cos (org_id, state, admin_name, admin_phone, admin_email, whatsapp_group_created, members_count, status, last_report_date, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning *`,
      [
        orgId,
        input.state,
        input.adminName ?? null,
        input.adminPhone ?? null,
        input.adminEmail ?? null,
        input.whatsappGroupCreated ?? false,
        input.membersCount ?? null,
        input.status ?? 'not_started',
        input.lastReportDate ?? null,
        input.notes ?? null,
      ]
    );
    return toNetworkCos(rows[0]!);
  });
}

export async function updateNetworkCos(orgId: string, id: string, input: Partial<CosInput>): Promise<NetworkCos | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<NetworkCosRow>(
      `update network_cos set
         admin_name = coalesce($3, admin_name),
         admin_phone = coalesce($4, admin_phone),
         admin_email = coalesce($5, admin_email),
         whatsapp_group_created = coalesce($6, whatsapp_group_created),
         members_count = coalesce($7, members_count),
         status = coalesce($8, status),
         last_report_date = coalesce($9, last_report_date),
         notes = coalesce($10, notes),
         updated_at = now()
       where org_id = $1 and id = $2 and archived_at is null
       returning *`,
      [
        orgId,
        id,
        input.adminName,
        input.adminPhone,
        input.adminEmail,
        input.whatsappGroupCreated,
        input.membersCount,
        input.status,
        input.lastReportDate,
        input.notes,
      ]
    );
    return rows[0] ? toNetworkCos(rows[0]) : null;
  });
}

// ---------------------------------------------------------------------
// partnerships
// ---------------------------------------------------------------------

interface PartnershipRow {
  id: string;
  org_id: string;
  assigned_to_user_id: string | null;
  organisation: string;
  contact_name: string | null;
  contact_email: string | null;
  category: string | null;
  current_status: PartnershipStatus;
  document_status: DocumentStatus;
  last_contact_date: string | null;
  follow_up_date: string | null;
  remarks: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

function toPartnership(row: PartnershipRow): Partnership {
  return {
    id: row.id,
    orgId: row.org_id,
    assignedToUserId: row.assigned_to_user_id ?? undefined,
    organisation: row.organisation,
    contactName: row.contact_name ?? undefined,
    contactEmail: row.contact_email ?? undefined,
    category: row.category ?? undefined,
    currentStatus: row.current_status,
    documentStatus: row.document_status,
    lastContactDate: row.last_contact_date ?? undefined,
    followUpDate: row.follow_up_date ?? undefined,
    remarks: row.remarks ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString(),
  };
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

export interface PartnershipListQuery {
  assignedToUserId?: string;
  includeArchived?: boolean;
}

export function isOwnPartnership(p: Partnership, userId: string): boolean {
  return p.assignedToUserId === userId;
}

export async function listPartnerships(orgId: string, query: PartnershipListQuery): Promise<Partnership[]> {
  return withOrgContext(orgId, async (client) => {
    const params: unknown[] = [orgId];
    const clauses = ['org_id = $1'];
    if (!query.includeArchived) clauses.push('archived_at is null');
    if (query.assignedToUserId) {
      params.push(query.assignedToUserId);
      clauses.push(`assigned_to_user_id = $${params.length}`);
    }
    const { rows } = await client.query<PartnershipRow>(
      `select * from partnerships where ${clauses.join(' and ')} order by organisation`,
      params
    );
    return rows.map(toPartnership);
  });
}

export async function getPartnershipById(orgId: string, id: string): Promise<Partnership | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<PartnershipRow>(`select * from partnerships where org_id = $1 and id = $2`, [orgId, id]);
    return rows[0] ? toPartnership(rows[0]) : null;
  });
}

export async function createPartnership(orgId: string, input: PartnershipInput): Promise<Partnership> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<PartnershipRow>(
      `insert into partnerships (org_id, assigned_to_user_id, organisation, contact_name, contact_email, category, current_status, document_status, last_contact_date, follow_up_date, remarks)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning *`,
      [
        orgId,
        input.assignedToUserId ?? null,
        input.organisation,
        input.contactName ?? null,
        input.contactEmail ?? null,
        input.category ?? null,
        input.currentStatus ?? 'not_started',
        input.documentStatus ?? 'not_started',
        input.lastContactDate ?? null,
        input.followUpDate ?? null,
        input.remarks ?? null,
      ]
    );
    return toPartnership(rows[0]!);
  });
}

export async function updatePartnership(orgId: string, id: string, input: Partial<PartnershipInput>): Promise<Partnership | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<PartnershipRow>(
      `update partnerships set
         assigned_to_user_id = coalesce($3, assigned_to_user_id),
         organisation = coalesce($4, organisation),
         contact_name = coalesce($5, contact_name),
         contact_email = coalesce($6, contact_email),
         category = coalesce($7, category),
         current_status = coalesce($8, current_status),
         document_status = coalesce($9, document_status),
         last_contact_date = coalesce($10, last_contact_date),
         follow_up_date = coalesce($11, follow_up_date),
         remarks = coalesce($12, remarks),
         updated_at = now()
       where org_id = $1 and id = $2 and archived_at is null
       returning *`,
      [
        orgId,
        id,
        input.assignedToUserId,
        input.organisation,
        input.contactName,
        input.contactEmail,
        input.category,
        input.currentStatus,
        input.documentStatus,
        input.lastContactDate,
        input.followUpDate,
        input.remarks,
      ]
    );
    return rows[0] ? toPartnership(rows[0]) : null;
  });
}

export async function archivePartnership(orgId: string, id: string): Promise<Partnership | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<PartnershipRow>(
      `update partnerships set archived_at = now(), updated_at = now()
       where org_id = $1 and id = $2 and archived_at is null
       returning *`,
      [orgId, id]
    );
    return rows[0] ? toPartnership(rows[0]) : null;
  });
}

const FAILSAFE_LIST_LIMIT = 50; // matches analyticsService.ts's own cap for the same class of alert list

/** PRD §8.7/§8.9 Failsafe "stale partner follow-ups" — the 4th and last
 * category, unblocked now that this table exists. Mirrors
 * analyticsService.ts's getUpcomingDeadlines shape: overdue (not just
 * upcoming) follow-ups on partnerships not yet resolved either way. */
export async function getStalePartnerFollowUps(orgId: string, assignedToUserId?: string): Promise<Partnership[]> {
  return withOrgContext(orgId, async (client) => {
    const params: unknown[] = [orgId];
    const clauses = [
      'org_id = $1',
      'archived_at is null',
      "current_status not in ('active', 'declined')",
      'follow_up_date is not null',
      'follow_up_date < now()',
    ];
    if (assignedToUserId) {
      params.push(assignedToUserId);
      clauses.push(`assigned_to_user_id = $${params.length}`);
    }
    const { rows } = await client.query<PartnershipRow>(
      `select * from partnerships where ${clauses.join(' and ')} order by follow_up_date asc limit ${FAILSAFE_LIST_LIMIT}`,
      params
    );
    return rows.map(toPartnership);
  });
}

// ---------------------------------------------------------------------
// org_contacts
// ---------------------------------------------------------------------

interface OrgContactRow {
  id: string;
  org_id: string;
  contact_owner_user_id: string | null;
  visitor_name: string;
  position: string | null;
  company_org: string | null;
  email: string | null;
  phone: string | null;
  state: string | null;
  staff_size: string | null;
  date_visited: string | null;
  letter_status: LetterStatus;
  onboarding_status: OnboardingStatus;
  whatsapp_added: boolean;
  follow_up_date: string | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

function toOrgContact(row: OrgContactRow): OrgContact {
  return {
    id: row.id,
    orgId: row.org_id,
    contactOwnerUserId: row.contact_owner_user_id ?? undefined,
    visitorName: row.visitor_name,
    position: row.position ?? undefined,
    companyOrg: row.company_org ?? undefined,
    email: row.email ?? undefined,
    phone: row.phone ?? undefined,
    state: row.state ?? undefined,
    staffSize: row.staff_size ?? undefined,
    dateVisited: row.date_visited ?? undefined,
    letterStatus: row.letter_status,
    onboardingStatus: row.onboarding_status,
    whatsappAdded: row.whatsapp_added,
    followUpDate: row.follow_up_date ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    archivedAt: row.archived_at?.toISOString(),
  };
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

export interface OrgContactListQuery {
  contactOwnerUserId?: string;
  includeArchived?: boolean;
}

export function isOwnOrgContact(c: OrgContact, userId: string): boolean {
  return c.contactOwnerUserId === userId;
}

export async function listOrgContacts(orgId: string, query: OrgContactListQuery): Promise<OrgContact[]> {
  return withOrgContext(orgId, async (client) => {
    const params: unknown[] = [orgId];
    const clauses = ['org_id = $1'];
    if (!query.includeArchived) clauses.push('archived_at is null');
    if (query.contactOwnerUserId) {
      params.push(query.contactOwnerUserId);
      clauses.push(`contact_owner_user_id = $${params.length}`);
    }
    const { rows } = await client.query<OrgContactRow>(
      `select * from org_contacts where ${clauses.join(' and ')} order by visitor_name`,
      params
    );
    return rows.map(toOrgContact);
  });
}

export async function getOrgContactById(orgId: string, id: string): Promise<OrgContact | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<OrgContactRow>(`select * from org_contacts where org_id = $1 and id = $2`, [orgId, id]);
    return rows[0] ? toOrgContact(rows[0]) : null;
  });
}

export async function createOrgContact(orgId: string, input: OrgContactInput): Promise<OrgContact> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<OrgContactRow>(
      `insert into org_contacts (org_id, contact_owner_user_id, visitor_name, "position", company_org, email, phone, state, staff_size, date_visited, letter_status, onboarding_status, whatsapp_added, follow_up_date, notes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       returning *`,
      [
        orgId,
        input.contactOwnerUserId ?? null,
        input.visitorName,
        input.position ?? null,
        input.companyOrg ?? null,
        input.email ?? null,
        input.phone ?? null,
        input.state ?? null,
        input.staffSize ?? null,
        input.dateVisited ?? null,
        input.letterStatus ?? 'not_sent',
        input.onboardingStatus ?? 'pending',
        input.whatsappAdded ?? false,
        input.followUpDate ?? null,
        input.notes ?? null,
      ]
    );
    return toOrgContact(rows[0]!);
  });
}

export async function updateOrgContact(orgId: string, id: string, input: Partial<OrgContactInput>): Promise<OrgContact | null> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<OrgContactRow>(
      `update org_contacts set
         contact_owner_user_id = coalesce($3, contact_owner_user_id),
         visitor_name = coalesce($4, visitor_name),
         "position" = coalesce($5, "position"),
         company_org = coalesce($6, company_org),
         email = coalesce($7, email),
         phone = coalesce($8, phone),
         state = coalesce($9, state),
         staff_size = coalesce($10, staff_size),
         date_visited = coalesce($11, date_visited),
         letter_status = coalesce($12, letter_status),
         onboarding_status = coalesce($13, onboarding_status),
         whatsapp_added = coalesce($14, whatsapp_added),
         follow_up_date = coalesce($15, follow_up_date),
         notes = coalesce($16, notes),
         updated_at = now()
       where org_id = $1 and id = $2 and archived_at is null
       returning *`,
      [
        orgId,
        id,
        input.contactOwnerUserId,
        input.visitorName,
        input.position,
        input.companyOrg,
        input.email,
        input.phone,
        input.state,
        input.staffSize,
        input.dateVisited,
        input.letterStatus,
        input.onboardingStatus,
        input.whatsappAdded,
        input.followUpDate,
        input.notes,
      ]
    );
    return rows[0] ? toOrgContact(rows[0]) : null;
  });
}
