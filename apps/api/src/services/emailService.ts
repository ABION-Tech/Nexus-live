// PRD §10.3 EmailService — Service layer over integrations/emailProvider.ts
// (PRD §6: UI → Service → Provider → External API). Two call sites are
// already wired as of Session 50 (routes/invites.ts, routes/guests.ts);
// this pass adds the templates NEXUS_LAUNCH_CHECKLIST.md P0 #2's second
// half calls out: "every automation job that PRD describes as an email
// (COB reminders, follow-up escalation, EOD nudge, morning digest)
// currently only writes an in-app `notifications` row."
//
// The automation-job functions below were rewritten this session against
// the real job code in automationJobs.ts (Sessions 45-46) once it was
// available — see the "Automation-job emails" section header for what
// changed from the earlier checklist-derived guess (two of four guessed
// shapes didn't match reality: the COB-reminder/EOD-nudge split, and the
// morning digest's counts-not-items payload).
//
// Everything above the "Automation-job emails" section is unchanged in
// behavior from what emailService.test.ts already exercises.

import { withOrgContext } from '../db.js';
import { getEmailProvider } from '../integrations/emailProvider.js';
import type { Invite } from './inviteService.js';
import type { GuestCredential } from './guestService.js';
import type { Role } from '@nexus/shared';

function labelForRole(role: Role): string {
  switch (role) {
    case 'leader':
      return 'Leader';
    case 'team_member':
      return 'Team Member';
    case 'intern':
      return 'Intern';
    default:
      // Any future role value still renders as *something* readable in
      // an email rather than throwing — this is copy, not authorization,
      // so failing open here is the right default.
      return role;
  }
}

/** Best-effort org display name for email copy. Swallows a failed
 * lookup rather than letting a DB hiccup block a send that doesn't
 * strictly need the org's real name — same "don't let this layer be
 * the reason a send fails" posture as emailProvider.ts's own stub
 * fallback. */
async function getOrgName(orgId: string): Promise<string> {
  try {
    return await withOrgContext(orgId, async (client) => {
      const { rows } = await client.query<{ name: string }>(`select name from organizations where id = $1`, [orgId]);
      return rows[0]?.name ?? 'your team';
    });
  } catch {
    return 'your team';
  }
}

/** Single read path for "what do we call this user in an email",
 * shared by anything that needs to say who invited/escalated/etc. —
 * same one-read-path reasoning userPreferencesService.ts's own header
 * comment gives for getThemePreference. Falls back rather than
 * throwing: a missing/unresolvable name is a worse email, not a
 * blocked one. */
export async function getUserDisplayName(orgId: string, userId: string): Promise<string> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ name: string }>(`select name from users where id = $1`, [userId]);
    return rows[0]?.name ?? 'A NEXUS leader';
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Session 53: accepting an invite is just signing in with Google at the
// web app (routes/auth.ts consumes the pending invite for that email), so
// the email links straight there. The previous copy pointed at an "invite
// link you were given" that was never sent to anyone.
export async function sendInviteEmail(invite: Invite, invitedByName: string): Promise<void> {
  const orgName = await getOrgName(invite.orgId);
  const roleLabel = labelForRole(invite.role);
  const provider = getEmailProvider();
  const signInUrl = (process.env.WEB_ORIGIN ?? '').replace(/\/$/, '') || 'https://nexusabion.com';
  const expires = new Date(invite.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const superAdminLine = invite.grantPlatformAdmin ? ' You will also be a NEXUS Super Admin.' : '';

  await provider.send({
    to: invite.email,
    subject: `${invitedByName} invited you to join ${orgName} on NEXUS`,
    text: [
      `${invitedByName} has invited you to join ${orgName} on NEXUS as a ${roleLabel}.${superAdminLine}`,
      ``,
      `To accept, go to ${signInUrl} and choose "Sign in with Google" using this email address (${invite.email}).`,
      ``,
      `This invite expires on ${expires}.`,
    ].join('\n'),
    html: [
      `<p>${escapeHtml(invitedByName)} has invited you to join <strong>${escapeHtml(orgName)}</strong> on NEXUS as a ${escapeHtml(roleLabel)}.${escapeHtml(superAdminLine)}</p>`,
      `<p><a href="${escapeHtml(signInUrl)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#5b52f0;color:#ffffff;text-decoration:none;font-weight:600">Accept and sign in</a></p>`,
      `<p style="color:#666;font-size:13px">Sign in with Google using <strong>${escapeHtml(invite.email)}</strong>. This invite expires on ${escapeHtml(expires)}.</p>`,
    ].join(''),
  });
}

export async function sendGuestCredentialEmail(orgId: string, credential: GuestCredential): Promise<void> {
  const orgName = await getOrgName(orgId);
  const provider = getEmailProvider();

  await provider.send({
    to: credential.email,
    subject: `Your NEXUS guest access for ${orgName}`,
    text: [
      `Hi ${credential.name},`,
      ``,
      `You've been given guest access to ${orgName} on NEXUS.`,
      `Email: ${credential.email}`,
      `Temporary password: ${credential.tempPassword}`,
      ``,
      `Sign in and change your password when you get a chance.`,
    ].join('\n'),
    html: [
      `<p>Hi ${credential.name},</p>`,
      `<p>You've been given guest access to <strong>${orgName}</strong> on NEXUS.</p>`,
      `<p>Email: ${credential.email}<br/>Temporary password: <strong>${credential.tempPassword}</strong></p>`,
      `<p>Sign in and change your password when you get a chance.</p>`,
    ].join(''),
  });
}

// ---------------------------------------------------------------------
// Automation-job emails — real call sites confirmed against
// automationJobs.ts (Sessions 45-46) and packages/shared's
// MissingEodUser/Person types. This replaces an earlier session's
// checklist-derived guesses at these shapes; two of the four guesses
// were wrong in a way worth recording:
//   - "COB reminders" and "EOD nudge" are NOT one job. The checklist's
//     single bucket is actually two real jobs with two different
//     audiences: runCobReminders nudges the person who hasn't filed
//     directly; runEodNudge sends a missing-people summary to that
//     org's leaders. They need two functions, not one shared shape.
//   - Neither COB reminders nor the morning digest carry a list of
//     items. MissingEodUser is `{userId, name}` — no per-item data to
//     enumerate — and runMorningDigest's real payload is open/overdue/
//     activeGoals *counts*, not itemized bullets. The old
//     EodReminderItem[] / MorningDigestSection[] shapes had nothing
//     real behind them.
// sendFollowUpEscalationEmail's shape held up unchanged — the real
// runFollowUpEscalation call site matches what was guessed, once the
// owner's name is looked up alongside the supervisor's contact info
// (automationJobs.ts's job only had IDs on hand, not names/emails).
//
// Every function here follows the same fire-and-.catch() contract as the
// invite/guest sends' call sites in routes/invites.ts and routes/guests.ts:
// the job that calls these should never `await` one into its own
// success/failure path. The in-app `notifications` row these jobs
// already write stays the source of truth; email is a best-effort
// second channel for whoever isn't looking at the app right now.

export interface EmailContact {
  email: string;
  name: string;
}

/** "COB reminder" — direct nudge to the person who hasn't filed their
 * EOD report yet today. runCobReminders' own in-app copy is just a flag
 * that it's outstanding, not a breakdown of what's in it (an EOD report
 * doesn't have sub-items the way a task list does), so this mirrors
 * that rather than inventing item-level content. */
export async function sendCobReminderEmail(orgId: string, recipient: EmailContact): Promise<void> {
  const orgName = await getOrgName(orgId);
  const provider = getEmailProvider();

  await provider.send({
    to: recipient.email,
    subject: `[${orgName}] Don't forget your EOD report`,
    text: [
      `Hi ${recipient.name},`,
      ``,
      `You're expected to file an EOD report today and it hasn't been submitted yet.`,
      ``,
      `Open NEXUS to file it.`,
    ].join('\n'),
    html: [
      `<p>Hi ${recipient.name},</p>`,
      `<p>You're expected to file an EOD report today and it hasn't been submitted yet.</p>`,
      `<p>Open NEXUS to file it.</p>`,
    ].join(''),
  });
}

/** "EOD nudge" — end-of-day summary to a leader of who on the team
 * still hasn't filed. One email per leader, matching runEodNudge's own
 * one-notification-per-leader shape; `missingNames` is the same name
 * list that job puts in the in-app notification body. */
export async function sendEodNudgeEmail(orgId: string, leader: EmailContact, missingNames: string[]): Promise<void> {
  if (missingNames.length === 0) return; // runEodNudge already skips this case upstream; stay defensive
  const orgName = await getOrgName(orgId);
  const provider = getEmailProvider();
  const plural = missingNames.length === 1 ? 'member' : 'members';

  await provider.send({
    to: leader.email,
    subject: `[${orgName}] ${missingNames.length} team ${plural} missing today's EOD`,
    text: [
      `Hi ${leader.name},`,
      ``,
      `These team members haven't filed today's EOD report yet:`,
      ``,
      missingNames.join(', '),
    ].join('\n'),
    html: [
      `<p>Hi ${leader.name},</p>`,
      `<p>These team members haven't filed today's EOD report yet:</p>`,
      `<p>${missingNames.join(', ')}</p>`,
    ].join(''),
  });
}

export interface FollowUpEscalationRecipient {
  email: string;
  name: string;
}

/** "Follow-up escalation" — an overdue item has crossed its follow-up
 * window and moved to someone above the original owner. Confirmed
 * against the real runFollowUpEscalation call site: it needs the
 * supervisor's contact info and the original owner's name looked up
 * separately, since that job only has both users' IDs on hand. */
export async function sendFollowUpEscalationEmail(
  orgId: string,
  recipient: FollowUpEscalationRecipient,
  itemTitle: string,
  originalOwnerName: string,
): Promise<void> {
  const orgName = await getOrgName(orgId);
  const provider = getEmailProvider();

  await provider.send({
    to: recipient.email,
    subject: `[${orgName}] Escalated: "${itemTitle}" is overdue`,
    text: [
      `Hi ${recipient.name},`,
      ``,
      `"${itemTitle}" (owned by ${originalOwnerName}) has passed its follow-up window and has been escalated to you.`,
      ``,
      `Open NEXUS for details.`,
    ].join('\n'),
    html: [
      `<p>Hi ${recipient.name},</p>`,
      `<p><strong>${itemTitle}</strong> (owned by ${originalOwnerName}) has passed its follow-up window and has been escalated to you.</p>`,
      `<p>Open NEXUS for details.</p>`,
    ].join(''),
  });
}

export interface MorningDigestStats {
  openTasks: number;
  overdue: number;
  /** Only present on the Monday "full" variant — runMorningDigest only
   * computes an active-goal count on Mondays (PRD §12: "Mon=full,
   * Tue-Fri=light"), so a light-day digest omits this rather than
   * sending a fabricated 0. */
  activeGoals?: number;
}

/** "Morning digest" — start-of-day summary. runMorningDigest's real
 * payload is open/overdue/active-goal *counts* per user, not an
 * itemized "Due today" / "Overdue" / "Goals at risk" section list — this
 * mirrors that exactly rather than the enumerable-items shape an
 * earlier guess assumed. */
export async function sendMorningDigestEmail(
  orgId: string,
  recipient: EmailContact,
  stats: MorningDigestStats,
  variant: 'full' | 'light',
): Promise<void> {
  const orgName = await getOrgName(orgId);
  const provider = getEmailProvider();
  const parts = [`${stats.openTasks} open task${stats.openTasks === 1 ? '' : 's'}`, `${stats.overdue} overdue`];
  if (variant === 'full' && stats.activeGoals !== undefined) {
    parts.push(`${stats.activeGoals} active org goal${stats.activeGoals === 1 ? '' : 's'}`);
  }
  const greeting = variant === 'full' ? 'Your week ahead' : 'Your day ahead';

  await provider.send({
    to: recipient.email,
    subject: `[${orgName}] ${greeting}`,
    text: [`Hi ${recipient.name},`, ``, parts.join(' · ')].join('\n'),
    html: [`<p>Hi ${recipient.name},</p>`, `<p>${parts.join(' · ')}</p>`].join(''),
  });
}
