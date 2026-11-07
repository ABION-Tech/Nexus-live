// Session 40 continuation. Scope is narrow by design: only worstOf's
// aggregation logic, exercised through getSystemHealth() since worstOf
// itself isn't exported. The db check is the one subsystem this session
// can actually toggle (the other five are hardcoded 'unknown' placeholders
// per this file's own header comment) — real per-subsystem checks are
// explicitly out of scope for this session, per the task list.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db.js', () => ({
  pool: { query: vi.fn() },
}));

import { pool } from '../db.js';
import { getSystemHealth } from './systemMetricsService.js';

const poolQuery = pool.query as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  poolQuery.mockReset();
});

describe('getSystemHealth — worstOf aggregation', () => {
  it('reports overall "unknown" when the db check is healthy, since the still-unwired subsystems outrank "ok"', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] }); // select 1 succeeds

    const report = await getSystemHealth();

    const db = report.subsystems.find((s) => s.name === 'database');
    expect(db?.status).toBe('ok');
    // ai/email/n8n/notifications/webhooks are still 'unknown' placeholders —
    // worstOf must surface that over the db's healthy 'ok'.
    expect(report.overall).toBe('unknown');
  });

  it('reports overall "down" when the db check fails, overriding the unknown placeholders', async () => {
    poolQuery.mockRejectedValueOnce(new Error('connection refused'));

    const report = await getSystemHealth();

    const db = report.subsystems.find((s) => s.name === 'database');
    expect(db?.status).toBe('down');
    expect(db?.detail).toContain('connection refused');
    expect(report.overall).toBe('down');
  });
});
