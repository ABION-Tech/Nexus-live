// PRD §13.3 check 4 (per-resource trust) — the own-record fallback for
// Network's Partnerships and Org Contacts. Session log flagged this as
// "built, not tested" since Session 16; this is that test suite.
//
// Covers exactly the three cases the session log named:
//  1. a team member without a flat `network.partnerships`/`network.org`
//     grant sees only their own rows (list is scoped, not filtered
//     client-side)
//  2. a leader (flat grant) sees all rows regardless of ownership
//  3. an own-record caller is blocked from reassigning `assignedToUserId`
//     / editing `documentStatus` (Partnerships) — those are silently
//     stripped, not rejected, per network.ts's enforceLeaderOnlyFields
//     mirror — while every other field still saves
//
// Strategy: mock `sessionService` (so `requireAuth`/`req.sessionUser`
// resolve without a real cookie/DB round trip) and mock the DB-touching
// half of `networkService` (list/get/create/update/archive) while
// keeping `isOwnPartnership`/`isOwnOrgContact` real, since those are the
// actual logic under test on the route side. No Postgres needed — this
// is the route/RBAC layer, not a migration/integration test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { OrgContact, Partnership } from '@nexus/shared';

const LEADER_TOKEN = 'leader-token';
const OWNER_TOKEN = 'owner-token';
const OTHER_TOKEN = 'other-token';

const LEADER = { sessionId: 's1', userId: 'user-leader', orgId: 'org-1', role: 'leader', name: 'Leader', email: 'leader@abion.test' };
const OWNER = { sessionId: 's2', userId: 'user-owner', orgId: 'org-1', role: 'member', name: 'Owner', email: 'owner@abion.test' };
const OTHER = { sessionId: 's3', userId: 'user-other', orgId: 'org-1', role: 'member', name: 'Other', email: 'other@abion.test' };

vi.mock('../services/sessionService.js', () => ({
  verifySession: vi.fn(async (token: string) => {
    if (token === LEADER_TOKEN) return LEADER;
    if (token === OWNER_TOKEN) return OWNER;
    if (token === OTHER_TOKEN) return OTHER;
    return null;
  }),
}));

vi.mock('../plugins/rbac.js', async () => {
  const actual = await vi.importActual<typeof import('../plugins/rbac.js')>('../plugins/rbac.js');
  return {
    ...actual,
    // Only the leader has the flat `network.*` grant in this suite —
    // OWNER/OTHER fall through to the own-record path being tested.
    hasPermission: vi.fn(async (user: { role: string }) => user.role === 'leader'),
  };
});

const basePartnership: Partnership = {
  id: 'ptn-1',
  orgId: 'org-1',
  assignedToUserId: OWNER.userId,
  organisation: 'Acme Foundation',
  currentStatus: 'in_discussion',
  documentStatus: 'not_started',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const baseOrgContact: OrgContact = {
  id: 'org-contact-1',
  orgId: 'org-1',
  contactOwnerUserId: OWNER.userId,
  visitorName: 'Jane Visitor',
  letterStatus: 'not_sent',
  onboardingStatus: 'pending',
  whatsappAdded: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../services/networkService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/networkService.js')>('../services/networkService.js');
  return {
    ...actual, // keeps isOwnPartnership / isOwnOrgContact real
    listPartnerships: vi.fn(async (_orgId: string, query: { assignedToUserId?: string }) => {
      const all = [basePartnership, { ...basePartnership, id: 'ptn-2', assignedToUserId: OTHER.userId }];
      return query.assignedToUserId ? all.filter((p) => p.assignedToUserId === query.assignedToUserId) : all;
    }),
    getPartnershipById: vi.fn(async (_orgId: string, id: string) =>
      id === basePartnership.id ? { ...basePartnership } : null
    ),
    updatePartnership: vi.fn(async (_orgId: string, id: string, input: Partial<Partnership>) => ({
      ...basePartnership,
      id,
      ...input,
    })),
    listOrgContacts: vi.fn(async (_orgId: string, query: { contactOwnerUserId?: string }) => {
      const all = [baseOrgContact, { ...baseOrgContact, id: 'org-contact-2', contactOwnerUserId: OTHER.userId }];
      return query.contactOwnerUserId ? all.filter((c) => c.contactOwnerUserId === query.contactOwnerUserId) : all;
    }),
    getOrgContactById: vi.fn(async (_orgId: string, id: string) =>
      id === baseOrgContact.id ? { ...baseOrgContact } : null
    ),
  };
});

describe('Network — PRD §13.3 check 4 (own-record trust)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.COOKIE_SECRET = 'test-secret';
    const { buildServer } = await import('../server.js');
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });

  describe('list scoping', () => {
    it('scopes an own-record team member to only their partnerships', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/network/partnerships',
        headers: { cookie: `nexus_session=${OWNER_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.partnerships).toHaveLength(1);
      expect(body.partnerships[0].assignedToUserId).toBe(OWNER.userId);
    });

    it('lets a leader see all partnerships regardless of assignment', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/network/partnerships',
        headers: { cookie: `nexus_session=${LEADER_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().partnerships).toHaveLength(2);
    });

    it('rejects an own-record caller requesting someone else\'s assignedToUserId filter', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/network/partnerships?assignedToUserId=${OTHER.userId}`,
        headers: { cookie: `nexus_session=${OWNER_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('scopes an own-record team member to only their org contacts', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/network/org-contacts',
        headers: { cookie: `nexus_session=${OWNER_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.contacts).toHaveLength(1);
      expect(body.contacts[0].contactOwnerUserId).toBe(OWNER.userId);
    });
  });

  describe('single-record read', () => {
    it('lets the owner read their own partnership', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/network/partnerships/${basePartnership.id}`,
        headers: { cookie: `nexus_session=${OWNER_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
    });

    it("blocks a non-owner, non-leader team member from reading someone else's partnership", async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/network/partnerships/${basePartnership.id}`,
        headers: { cookie: `nexus_session=${OTHER_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('own-record update — leader-only field stripping', () => {
    it("strips assignedToUserId and documentStatus for an own-record caller, but keeps other fields", async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/network/partnerships/${basePartnership.id}`,
        headers: { cookie: `nexus_session=${OWNER_TOKEN}` },
        payload: {
          assignedToUserId: OTHER.userId, // attempted reassignment — must be dropped
          documentStatus: 'signed', // leader-only field — must be dropped
          remarks: 'Called them back, following up next week.', // allowed — must persist
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.assignedToUserId).not.toBe(OTHER.userId);
      expect(body.documentStatus).not.toBe('signed');
      expect(body.remarks).toBe('Called them back, following up next week.');
    });

    it('lets a leader reassign assignedToUserId and set documentStatus freely', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/network/partnerships/${basePartnership.id}`,
        headers: { cookie: `nexus_session=${LEADER_TOKEN}` },
        payload: { assignedToUserId: OTHER.userId, documentStatus: 'signed' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.assignedToUserId).toBe(OTHER.userId);
      expect(body.documentStatus).toBe('signed');
    });

    it("blocks a non-owner, non-leader team member from updating someone else's partnership at all", async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/network/partnerships/${basePartnership.id}`,
        headers: { cookie: `nexus_session=${OTHER_TOKEN}` },
        payload: { remarks: 'trying to edit a record that is not mine' },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
