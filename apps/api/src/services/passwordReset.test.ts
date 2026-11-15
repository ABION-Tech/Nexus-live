// Session 60 (C-18) — setting a new password signs out every other
// session for that person (an intruder doesn't stay signed in after a
// reset). A brand-new account has no sessions to end.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
const revokeAll = vi.fn(async () => undefined);
vi.mock('../db.js', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock('./sessionService.js', () => ({ revokeAllSessionsForUser: revokeAll }));
vi.mock('./inviteService.js', () => ({
  InviteError: class extends Error {},
  acceptInvite: vi.fn(async () => ({ userId: 'u-new', orgId: 'o1' })),
}));

const { setPasswordWithToken } = await import('./passwordAuthService.js');

function db(existingUser: boolean) {
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('update password_tokens set used_at = now()\n      where token_hash')) return { rows: [{ email: 'ada@abion.test' }] };
    if (sql.includes('find_user_by_email')) return { rows: existingUser ? [{ id: 'u-ada', org_id: 'o1' }] : [] };
    return { rows: [] };
  });
}

describe('password reset', () => {
  beforeEach(() => {
    query.mockReset();
    revokeAll.mockClear();
  });

  it('signs out every existing session of that person', async () => {
    db(true);
    const r = await setPasswordWithToken({ token: 't', password: 'a long enough password' });
    expect(r).toMatchObject({ userId: 'u-ada', createdAccount: false });
    expect(revokeAll).toHaveBeenCalledWith('u-ada');
  });

  it('a brand-new account has nothing to sign out', async () => {
    db(false);
    const r = await setPasswordWithToken({ token: 't', password: 'a long enough password' });
    expect(r.createdAccount).toBe(true);
    expect(revokeAll).not.toHaveBeenCalled();
  });
});
