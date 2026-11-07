import { useState } from 'react';
import { Button, Card, Input, EmptyState, useToast } from '../../components/ui';
import { createGuestCredential, type GuestCredential } from '../../services/guestInviteService';
import type { CurrentUser } from '../../services/authService';

// Settings > Guest Invites (ADMIN_BUILD_GUIDE.md §1/§3). The UI half of
// guestService.ts's backend (Session 37) — routes/guests.ts's own
// header comment says this surface was deferred to "Session 41/42".
// Gated the same client-side `role === 'leader'` way TeamRoles.tsx's
// `canManage` already is (the real boundary is POST /guests' own
// `user.role !== 'leader'` check server-side) — no orgType restriction
// here since the backend doesn't apply one either: any leader, group or
// company, can provision a guest for their own org.
export function GuestInvites({ user }: { user: CurrentUser }) {
  const { show } = useToast();
  const canManage = user.role === 'leader';

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [created, setCreated] = useState<GuestCredential[]>([]);

  async function handleCreate() {
    if (!name.trim() || !email.trim()) {
      setFormError('Name and email are both required.');
      return;
    }
    setFormError(null);
    setSubmitting(true);
    try {
      const credential = await createGuestCredential(name.trim(), email.trim());
      setCreated((prev) => [credential, ...prev]);
      setName('');
      setEmail('');
      show(`Guest credential created for ${credential.email}.`, 'success');
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Could not create the guest credential.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!canManage) {
    return (
      <EmptyState
        title="Leader access required"
        description="Only a leader can generate guest credentials for this organization."
      />
    );
  }

  return (
    <div className="nx-page nx-view-enter">
      <div>
        <h2>Guest Invites</h2>
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>
          Guests sign in with a password instead of Google OAuth — the only exception to this org's
          usual login path. The temporary password below is shown exactly once; copy it and share it
          with the guest yourself, out of band. It can't be retrieved again after you leave this page.
        </p>
      </div>

      <Card>
        <h3 style={{ marginBottom: 12 }}>New guest</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 420 }}>
          <Input label="Name" placeholder="e.g. Dele Adeyemi" value={name} onChange={(e) => setName(e.target.value)} />
          <Input
            label="Email"
            type="email"
            placeholder="e.g. dele@partner-org.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={formError ?? undefined}
          />
          <div>
            <Button onClick={handleCreate} disabled={submitting}>
              {submitting ? 'Creating…' : 'Create guest credential'}
            </Button>
          </div>
        </div>
      </Card>

      {created.length > 0 && (
        <Card>
          <h3 style={{ marginBottom: 12 }}>Created this session</h3>
          <div className="nx-stack nx-stack--sm">
            {created.map((c) => (
              <div
                key={c.userId}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  padding: '10px 12px',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 8,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <strong>{c.name}</strong>
                  <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>{c.email}</span>
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                  Temp password: <span style={{ color: 'var(--accent2)' }}>{c.tempPassword}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
