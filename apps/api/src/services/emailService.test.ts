// Service-level tests for emailService.ts. db.js is mocked (same
// posture as fileService.test.ts / projectService.test.ts — query logic
// under test, not an RLS/migration integration test), and
// emailProvider.js is mocked at the module level so no real network call
// is ever attempted here — ResendEmailProvider's own fetch call is
// exercised separately, if at all, only against Resend's sandbox, not
// unit-tested against a live endpoint.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakeClient = { query: vi.fn() };

vi.mock('../db.js', () => ({
  pool: { query: vi.fn() },
  withOrgContext: vi.fn(async (_orgId: string, fn: (client: unknown) => unknown) => fn(fakeClient)),
}));

const sendMock = vi.fn();
vi.mock('../integrations/emailProvider.js', () => ({
  getEmailProvider: () => ({ send: sendMock }),
}));

import { withOrgContext } from '../db.js';
import {
  sendInviteEmail,
  sendGuestCredentialEmail,
  getUserDisplayName,
  sendCobReminderEmail,
  sendEodNudgeEmail,
  sendFollowUpEscalationEmail,
  sendMorningDigestEmail,
} from './emailService.js';
import type { Invite } from './inviteService.js';
import type { GuestCredential } from './guestService.js';

const withOrgContextMock = withOrgContext as unknown as ReturnType<typeof vi.fn>;

const invite: Invite = {
  id: 'invite-1',
  orgId: 'org-1',
  email: 'newteammate@example.com',
  role: 'team_member',
  invitedBy: 'user-1',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(),
};

const guestCredential: GuestCredential = {
  userId: 'user-2',
  name: 'Visiting Guest',
  email: 'guest@example.com',
  tempPassword: 'abc123xyz',
};

beforeEach(() => {
  sendMock.mockReset();
  sendMock.mockResolvedValue({ sent: true, providerMessageId: 'msg_123' });
  fakeClient.query.mockReset();
  fakeClient.query.mockResolvedValue({ rows: [{ name: 'ABION Industries' }] });
  withOrgContextMock.mockClear();
});

describe('sendInviteEmail', () => {
  it('sends to the invited address with the org name and role in the copy', async () => {
    await sendInviteEmail(invite, 'Ayo Joshua');

    expect(sendMock).toHaveBeenCalledTimes(1);
    const message = sendMock.mock.calls[0]![0];
    expect(message.to).toBe(invite.email);
    expect(message.subject).toContain('Ayo Joshua');
    expect(message.subject).toContain('ABION Industries');
    expect(message.text).toContain('Team Member');
    expect(message.html).toContain('ABION Industries');
  });

  it('falls back to a generic org label when the org lookup fails', async () => {
    withOrgContextMock.mockRejectedValueOnce(new Error('db down'));

    await sendInviteEmail(invite, 'Ayo Joshua');

    const message = sendMock.mock.calls[0]![0];
    expect(message.text).toContain('your team');
  });

  it('propagates a provider send failure to the caller', async () => {
    sendMock.mockRejectedValueOnce(new Error('Resend send failed (422)'));
    await expect(sendInviteEmail(invite, 'Ayo Joshua')).rejects.toThrow('Resend send failed');
  });
});

describe('sendGuestCredentialEmail', () => {
  it('includes the temp password and email in the message body', async () => {
    await sendGuestCredentialEmail('org-1', guestCredential);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const message = sendMock.mock.calls[0]![0];
    expect(message.to).toBe(guestCredential.email);
    expect(message.text).toContain(guestCredential.tempPassword);
    expect(message.html).toContain(guestCredential.email);
  });
});

describe('getUserDisplayName', () => {
  it('resolves the name via withOrgContext, not the raw pool (users RLS is membership-scoped)', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [{ name: 'Ayo Joshua' }] });

    const name = await getUserDisplayName('org-1', 'user-1');

    expect(name).toBe('Ayo Joshua');
    expect(withOrgContextMock).toHaveBeenCalledWith('org-1', expect.any(Function));
  });

  it('falls back to a generic label when no row is found', async () => {
    fakeClient.query.mockResolvedValueOnce({ rows: [] });
    const name = await getUserDisplayName('org-1', 'missing-user');
    expect(name).toBe('A NEXUS leader');
  });
});

describe('sendCobReminderEmail', () => {
  const recipient = { email: 'teammember@example.com', name: 'Dara' };

  it('nudges the person directly about their own EOD report', async () => {
    await sendCobReminderEmail('org-1', recipient);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const message = sendMock.mock.calls[0]![0];
    expect(message.to).toBe(recipient.email);
    expect(message.subject).toContain("Don't forget your EOD report");
    expect(message.text).toContain('Dara');
    expect(message.html).toContain('EOD report');
  });
});

describe('sendEodNudgeEmail', () => {
  const leader = { email: 'leader@example.com', name: 'Kunle' };

  it('lists each missing team member by name for the leader', async () => {
    await sendEodNudgeEmail('org-1', leader, ['Sade', 'Tunde']);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const message = sendMock.mock.calls[0]![0];
    expect(message.to).toBe(leader.email);
    expect(message.subject).toContain('2 team members missing');
    expect(message.text).toContain('Sade, Tunde');
    expect(message.html).toContain('Sade, Tunde');
  });

  it('does not send when nobody is missing', async () => {
    await sendEodNudgeEmail('org-1', leader, []);
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe('sendFollowUpEscalationEmail', () => {
  it('names the item and the original owner in the copy', async () => {
    await sendFollowUpEscalationEmail(
      'org-1',
      { email: 'manager@example.com', name: 'Kunle' },
      'Vendor contract review',
      'Ayo Joshua',
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    const message = sendMock.mock.calls[0]![0];
    expect(message.to).toBe('manager@example.com');
    expect(message.subject).toContain('Vendor contract review');
    expect(message.text).toContain('Ayo Joshua');
    expect(message.html).toContain('Vendor contract review');
  });
});

describe('sendMorningDigestEmail', () => {
  const recipient = { email: 'teammember@example.com', name: 'Sade' };

  it('renders open/overdue counts and greets with "week ahead" on the full Monday variant', async () => {
    await sendMorningDigestEmail('org-1', recipient, { openTasks: 3, overdue: 1, activeGoals: 2 }, 'full');

    const message = sendMock.mock.calls[0]![0];
    expect(message.subject).toContain('Your week ahead');
    expect(message.text).toContain('3 open tasks');
    expect(message.text).toContain('1 overdue');
    expect(message.text).toContain('2 active org goals');
    expect(message.html).toContain('3 open tasks');
  });

  it('omits the active-goals count on the light variant even if provided', async () => {
    await sendMorningDigestEmail('org-1', recipient, { openTasks: 1, overdue: 0, activeGoals: 2 }, 'light');

    const message = sendMock.mock.calls[0]![0];
    expect(message.subject).toContain('Your day ahead');
    expect(message.text).not.toContain('active org goal');
  });
});
