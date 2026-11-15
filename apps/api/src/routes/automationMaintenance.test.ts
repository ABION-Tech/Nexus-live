// PRD §12 / §17.1 Phase H trigger endpoint. Same strategy as
// calendarSyncService.test.ts for calendarMaintenance's /sweep: no
// session, a shared secret header instead — mock the job runner and
// the audit-write side (automationService.js), exercise the route
// layer's secret/key validation and response shaping, not a live
// Postgres integration.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const SECRET = 'test-maintenance-secret';

const runDailyCobRemindersMock = vi.fn(async () => [
  { orgId: 'org-1', status: 'success' as const, detail: { sent: 3 } },
  { orgId: 'org-2', status: 'error' as const, error: 'resend timeout' },
]);

vi.mock('../services/automationJobs.js', () => ({
  IMPLEMENTED_JOBS: {
    daily_cob_reminders: runDailyCobRemindersMock,
  },
  // Session 60: both are built now; kept here only to exercise the 501 path.
  UNIMPLEMENTED_JOBS: new Set(['daily_recurring_tasks', 'hourly_follow_up']),
}));

const recordAutomationRunMock = vi.fn(async () => undefined);
const recordDispatchMock = vi.fn(async (_input: { status: string; orgsRun: number; orgsFailed: number; error?: string }) => 'd-1');
const claimDispatchAlertMock = vi.fn(async () => true);
const alertMock = vi.fn(async () => 1);

vi.mock('../services/automationAlertService.js', () => ({ alertPlatformAdminsOfAutomationFailure: alertMock }));

vi.mock('../services/automationService.js', async () => {
  const actual = await vi.importActual<typeof import('../services/automationService.js')>('../services/automationService.js');
  return {
    ...actual, // keeps isKnownAutomationKey real — it reads AUTOMATION_CONTROL_KEYS from @nexus/shared
    recordAutomationRun: recordAutomationRunMock,
    recordDispatch: recordDispatchMock,
    claimDispatchAlert: claimDispatchAlertMock,
  };
});

describe('POST /automation/maintenance/run/:jobKey', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.COOKIE_SECRET = 'test-secret';
    process.env.AUTOMATION_MAINTENANCE_SECRET = SECRET;
    const { buildServer } = await import('../server.js');
    app = buildServer({ logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
    delete process.env.AUTOMATION_MAINTENANCE_SECRET;
  });

  it('fails closed with 503 when the secret is not configured', async () => {
    delete process.env.AUTOMATION_MAINTENANCE_SECRET;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/automation/maintenance/run/daily_cob_reminders',
      headers: { 'x-nexus-maintenance-secret': SECRET },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('not_configured');
  });

  it('rejects a missing secret header with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/automation/maintenance/run/daily_cob_reminders',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong secret with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/automation/maintenance/run/daily_cob_reminders',
      headers: { 'x-nexus-maintenance-secret': 'wrong-secret' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a key outside the PRD §12 checklist with 400 (unknown_key)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/automation/maintenance/run/not_a_real_job',
      headers: { 'x-nexus-maintenance-secret': SECRET },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unknown_key');
  });

  it('returns 501 for a real §12 key with no implementation yet', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/automation/maintenance/run/daily_recurring_tasks',
      headers: { 'x-nexus-maintenance-secret': SECRET },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('not_implemented');
    expect(runDailyCobRemindersMock).not.toHaveBeenCalled();
  });

  it('runs the job, records one automation_run_log row per org, and summarizes results', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/automation/maintenance/run/daily_cob_reminders',
      headers: { 'x-nexus-maintenance-secret': SECRET },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.jobKey).toBe('daily_cob_reminders');
    expect(body.orgsRun).toBe(2);
    expect(body.succeeded).toBe(1);
    expect(body.failed).toBe(1);
    expect(body.failures).toHaveLength(1);
    expect(body.failures[0].orgId).toBe('org-2');

    // One recordAutomationRun call per org in the result set, per this
    // route's own header comment (a single startedAt/finishedAt spanning
    // the whole invocation, not per-org sub-timing).
    expect(recordAutomationRunMock).toHaveBeenCalledTimes(2);
    expect(recordAutomationRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-1', jobKey: 'daily_cob_reminders', status: 'success' }),
    );
    expect(recordAutomationRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'org-2', jobKey: 'daily_cob_reminders', status: 'error', error: 'resend timeout' }),
    );
  });

  it('records the dispatch and alerts the platform admins when a company fails', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/automation/maintenance/run/daily_cob_reminders',
      headers: { 'x-nexus-maintenance-secret': SECRET },
    });
    expect(res.statusCode).toBe(200);
    expect(recordDispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ jobKey: 'daily_cob_reminders', status: 'error', orgsRun: 2, orgsFailed: 1, error: 'resend timeout' }),
    );
    expect(claimDispatchAlertMock).toHaveBeenCalledWith('d-1', 'daily_cob_reminders');
    expect(alertMock).toHaveBeenCalledWith(expect.objectContaining({ jobKey: 'daily_cob_reminders', orgsFailed: 1, orgsRun: 2 }));
  });

  it("doesn't alert again when today's alert for that job already went out", async () => {
    claimDispatchAlertMock.mockResolvedValueOnce(false);
    await app.inject({
      method: 'POST',
      url: '/api/v1/automation/maintenance/run/daily_cob_reminders',
      headers: { 'x-nexus-maintenance-secret': SECRET },
    });
    expect(alertMock).not.toHaveBeenCalled();
  });

  it('a dispatch that fails before any company ran is recorded, alerted and returns 500 (the 0043 failure)', async () => {
    runDailyCobRemindersMock.mockRejectedValueOnce(new Error('permission denied for table automation_controls'));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/automation/maintenance/run/daily_cob_reminders',
      headers: { 'x-nexus-maintenance-secret': SECRET },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('dispatch_failed');
    expect(recordAutomationRunMock).not.toHaveBeenCalled();
    expect(recordDispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', orgsRun: 0, error: 'permission denied for table automation_controls' }),
    );
    expect(alertMock).toHaveBeenCalledWith(expect.objectContaining({ orgsRun: 0, error: 'permission denied for table automation_controls' }));
  });

  it('rate-limits repeated triggers past the configured max', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/automation/maintenance/run/daily_cob_reminders',
        headers: { 'x-nexus-maintenance-secret': SECRET },
      });
      expect(res.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/api/v1/automation/maintenance/run/daily_cob_reminders',
      headers: { 'x-nexus-maintenance-secret': SECRET },
    });
    expect(limited.statusCode).toBe(429);
  });
});
