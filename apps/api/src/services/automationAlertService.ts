// Session 60 (C-04) — tell a person when the scheduled automations fail.
//
// Before this, a failing job only showed up in Railway's logs; all seven
// daily jobs failed for weeks without anyone knowing. The caller
// (routes/automationMaintenance.ts) throttles to one email per job per
// 24 hours via claimDispatchAlert, so a broken job can't flood inboxes.
import { pool } from '../db.js';
import { getEmailProvider } from '../integrations/emailProvider.js';

const LABEL: Record<string, string> = {
  daily_overdue_check: 'Overdue check (08:00)',
  daily_morning_digest: 'Morning digest (08:05)',
  daily_dependency_sweep: 'Dependency sweep (09:00)',
  daily_cob_reminders: 'Close-of-business reminders (16:00)',
  daily_follow_up_escalation: 'Follow-up escalation (18:00)',
  daily_eod_nudge: 'EOD nudge (18:05)',
  daily_task_snapshot: 'Nightly task snapshot (23:00)',
};

const escapeHtml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface AutomationFailure {
  jobKey: string;
  error: string;
  orgsRun: number;
  orgsFailed: number;
}

/** Emails every platform admin. Returns how many were sent to. */
export async function alertPlatformAdminsOfAutomationFailure(f: AutomationFailure): Promise<number> {
  const { rows } = await pool.query<{ name: string; email: string }>(`select name, email from list_platform_admins()`);
  if (rows.length === 0) return 0;
  const job = LABEL[f.jobKey] ?? f.jobKey;
  const scope =
    f.orgsRun === 0 ? 'It failed before any company ran, so it did nothing for anyone.' : `${f.orgsFailed} of ${f.orgsRun} companies failed.`;
  const link = `${(process.env.WEB_ORIGIN || 'https://app.nexusabion.com').replace(/\/$/, '')}/admin/platform`;
  const provider = getEmailProvider();
  for (const admin of rows) {
    await provider.send({
      to: admin.email,
      subject: `[NEXUS] Automation failed: ${job}`,
      text: [
        `Hi ${admin.name},`,
        ``,
        `The scheduled automation "${job}" failed. ${scope}`,
        ``,
        `Error: ${f.error}`,
        ``,
        `Scheduled jobs are on the Super Admin page: ${link}`,
        `You'll get at most one of these a day for this job.`,
      ].join('\n'),
      html: [
        `<p>Hi ${escapeHtml(admin.name)},</p>`,
        `<p>The scheduled automation <b>${escapeHtml(job)}</b> failed. ${escapeHtml(scope)}</p>`,
        `<p><code>${escapeHtml(f.error)}</code></p>`,
        `<p><a href="${link}">Open scheduled jobs on the Super Admin page</a></p>`,
        `<p style="color:#666">You'll get at most one of these a day for this job.</p>`,
      ].join(''),
    });
  }
  return rows.length;
}
