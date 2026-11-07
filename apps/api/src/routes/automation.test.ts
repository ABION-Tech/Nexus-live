// PRD §8.10 Automation route tests. Same strategy as files.test.ts/
// network.test.ts: mock sessionService and automationService entirely —
// this is the route/RBAC/validation layer, not a migration/integration
// test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AutomationControl } from '@nexus/shared';

const GRANTED_TOKEN = 'granted-token';
const READONLY_TOKEN = 'readonly-token';
const UNGRANTED_TOKEN = 'ungranted-token';

const GRANTED = { sessionId: 's1', userId: 'user-granted', orgId: 'org-1', role: 'member', name: 'Granted', email: 'granted@abion.test' };
const READONLY = { sessionId: 's2', userId: 'user-readonly', orgId: 'org-1', role: 'member', name: 'ReadOnly', email: 'readonly@abion.test' };
const UNGRANTED = { sessionId: 's3', userId: 'user-ungranted', orgId: 'org-1', role: 'member', name: 'Ungranted', email: 'ungranted@abion.test' };

vi.mock('../services/sessionService.js', () => ({
  verifySession: vi.fn(async (token: string) => {
    if (token === GRANTED_TOKEN) return GRANTED;
    if (token === READONLY_TOKEN) return READONLY;
    if (token === UNGRANTED_TOKEN) return UNGRANTED;
    return null;
  }),
}));

vi.mock('../plugins/rbac.js', async () => {
  const actual = await vi.importActual<typeof import('../plugins/rbac.js')>('../plugins/rbac.js');
  return {
    ...actual,
    hasPermission: vi.fn(async (user: { userId: string }, resource: string, action: string) => {
      if (resource !== 'automation') return false;
      if (user.userId === GRANTED.userId) return true; // read + update
      if (user.userId === READONLY.userId) return action === 'read';
      return false;
    }),
  };
});

const baseControl: AutomationControl = {
  id: 'ctrl-1',
  orgId: 'org-1',
  key: 'daily_cob_reminders',
  enabled: true,
  updatedByUserId: GRANTED.userId,
  updatedAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../services/automationService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/automationService.js')>('../services/automationService.js');
  return {
    ...actual, // keeps UnknownAutomationKeyError real
    listAutomationControls: vi.fn(async () => [baseControl]),
    setAutomationControl: vi.fn(async (_orgId: string, key: string, enabled: boolean) => {
      if (!actual.isKnownAutomationKey(key)) throw new actual.UnknownAutomationKeyError(key);
      if (key !== baseControl.key) return null; // simulates "no seed row yet" branch
      return { ...baseControl, enabled, updatedAt: '2026-01-02T00:00:00.000Z' };
    }),
    listAutomationLog: vi.fn(async (_orgId: string, limit?: number) => [
      { id: 'log-1', orgId: 'org-1', controlKey: baseControl.key, previousValue: true, newValue: false, changedByUserId: GRANTED.userId, changedAt: '2026-01-02T00:00:00.000Z' },
    ].slice(0, limit ?? 50)),
  };
});

describe('Automation — PRD §8.10 routes', () => {
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

  describe('GET / (list controls)', () => {
    it('returns controls for a caller with automation.read', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/automation',
        headers: { cookie: `nexus_session=${READONLY_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().controls).toHaveLength(1);
    });

    it('rejects a caller without automation.read', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/automation',
        headers: { cookie: `nexus_session=${UNGRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('PATCH /:key', () => {
    it('toggles a control for a caller with automation.update', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/automation/${baseControl.key}`,
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().enabled).toBe(false);
    });

    it('rejects a caller with only automation.read', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/automation/${baseControl.key}`,
        headers: { cookie: `nexus_session=${READONLY_TOKEN}` },
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects a non-boolean enabled with 400', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/automation/${baseControl.key}`,
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
        payload: { enabled: 'yes' },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects a key outside the PRD §12 checklist with 400 ('unknown_key')", async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/automation/not_a_real_job',
        headers: { cookie: `nexus_session=${GRANTED_TOKEN}` },
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('unknown_key');
    });
  });

  describe('GET /log', () => {
    it('returns audit entries for a caller with automation.read', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/automation/log',
        headers: { cookie: `nexus_session=${READONLY_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().entries).toHaveLength(1);
    });

    it('rejects a caller without automation.read', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/automation/log',
        headers: { cookie: `nexus_session=${UNGRANTED_TOKEN}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it('rejects a non-positive limit with 400', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/automation/log?limit=0',
        headers: { cookie: `nexus_session=${READONLY_TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
