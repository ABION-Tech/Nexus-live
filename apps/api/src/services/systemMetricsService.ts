// systemMetricsService.ts — ADMIN_BUILD_GUIDE.md §3 "Session 4 — Super
// Admin backend": "systemMetricsService.ts skeleton (API/DB/AI/email/n8n/
// notifications/webhooks)." Deliberately a skeleton, per the guide's own
// wording — a real per-subsystem check (e.g. an actual n8n ping, an
// actual Resend account-quota read) is its own follow-up piece of work
// per subsystem, not sized into this session. What this session does
// build for real: the database check (this process already holds a live
// pool, so `select 1` is a real, meaningful check, not a stub) and the
// shape every future subsystem check reports into.
import { pool } from '../db.js';
import type { SubsystemHealth, SystemHealthReport, SubsystemStatus } from '@nexus/shared';

async function checkDatabase(): Promise<SubsystemHealth> {
  const checkedAt = new Date().toISOString();
  try {
    await pool.query('select 1');
    return { name: 'database', status: 'ok', checkedAt };
  } catch (err) {
    return { name: 'database', status: 'down', detail: err instanceof Error ? err.message : String(err), checkedAt };
  }
}

/** Every subsystem below this line is a real, named placeholder — not
 * yet wired to a live check — rather than omitted, so the "AI & Costs" /
 * "System Health" dashboard (Session 5 per the guide) has a stable shape
 * to render against from day one, and each row is easy to find and wire
 * up individually later without a schema/type change. */
function unknownSubsystem(name: SubsystemHealth['name'], detail: string): SubsystemHealth {
  return { name, status: 'unknown', detail, checkedAt: new Date().toISOString() };
}

function worstOf(statuses: SubsystemStatus[]): SubsystemStatus {
  if (statuses.includes('down')) return 'down';
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.includes('unknown')) return 'unknown';
  return 'ok';
}

export async function getSystemHealth(): Promise<SystemHealthReport> {
  const subsystems: SubsystemHealth[] = [
    { name: 'api', status: 'ok', checkedAt: new Date().toISOString() }, // this process answering the request is itself the check
    await checkDatabase(),
    unknownSubsystem('ai', 'Per-provider health check not yet wired — see aiUsageService for recent-call success rate as a proxy.'),
    unknownSubsystem('email', 'Resend/Gmail-fallback quota check not yet wired.'),
    unknownSubsystem('n8n', 'n8n reachability check not yet wired.'),
    unknownSubsystem('notifications', 'Web push delivery check not yet wired.'),
    unknownSubsystem('webhooks', 'Calendar webhook channel health not yet wired.'),
  ];

  return {
    overall: worstOf(subsystems.map((s) => s.status)),
    subsystems,
  };
}
