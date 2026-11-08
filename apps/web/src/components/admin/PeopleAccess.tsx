// Session 53 — shared pieces for managing people and access: the invite
// form, the pending-invites list and the role picker. Used by Settings >
// Team & Roles (own org), Super Admin > Organizations (any org) and Super
// Admin > Super Admins, so all three behave and look the same.
import { useEffect, useState } from 'react';
import { Badge, Button, Input, Modal, Select } from '../ui';
import type { MemberRole, PendingInvite } from '@nexus/shared';
import { MEMBER_ROLE_HELP, MEMBER_ROLE_LABELS, memberRoleOptions } from './memberRoles';

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Email + role form in a modal. `onSubmit` should throw on failure; its
 * message is shown inline and the modal stays open. */
export function InviteMemberModal({
  open,
  title = 'Invite someone',
  description,
  defaultRole = 'team_member',
  allowLeader = true,
  submitLabel = 'Send invite',
  onClose,
  onSubmit,
}: {
  open: boolean;
  title?: string;
  description?: string;
  defaultRole?: MemberRole;
  allowLeader?: boolean;
  submitLabel?: string;
  onClose: () => void;
  onSubmit: (email: string, role: MemberRole) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberRole>(defaultRole);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setEmail('');
      setRole(defaultRole);
      setError(null);
    }
  }, [open, defaultRole]);

  async function handleSubmit() {
    const trimmed = email.trim();
    if (!EMAIL_SHAPE.test(trimmed)) {
      setError('Enter a valid email address.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmed, role);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not send the invite.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="nx-stack nx-stack--md" style={{ minWidth: 320, maxWidth: 440 }}>
        {description && <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 13 }}>{description}</p>}
        <Input
          label="Email"
          type="email"
          placeholder="name@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          autoFocus
        />
        <Select
          label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value as MemberRole)}
          options={memberRoleOptions(allowLeader)}
        />
        <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 12 }}>{MEMBER_ROLE_HELP[role]}</p>
        <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 12 }}>
          They'll get an email. To accept, they sign in to NEXUS with Google using this address. Invites expire after 14 days.
        </p>
        {error && <span className="nx-field__error">{error}</span>}
        <div className="nx-row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting}>{submitting ? 'Sending…' : submitLabel}</Button>
        </div>
      </div>
    </Modal>
  );
}

/** Compact list of pending invites with a Cancel action per row. */
export function PendingInvitesList({
  invites,
  cancellingId,
  onCancel,
  emptyText = 'No pending invites.',
}: {
  invites: PendingInvite[];
  cancellingId?: string | null;
  onCancel?: (invite: PendingInvite) => void;
  emptyText?: string;
}) {
  if (invites.length === 0) {
    return <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 13 }}>{emptyText}</p>;
  }
  return (
    <div className="nx-stack nx-stack--sm">
      {invites.map((inv) => (
        <div
          key={inv.id}
          className="nx-row nx-row--between"
          style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, gap: 12, flexWrap: 'wrap' }}
        >
          <div className="nx-stack nx-stack--xs" style={{ minWidth: 0 }}>
            <span style={{ fontSize: 14, overflowWrap: 'anywhere' }}>{inv.email}</span>
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Expires {formatDate(inv.expiresAt)}</span>
          </div>
          <div className="nx-row" style={{ gap: 8 }}>
            <Badge tone="neutral">{MEMBER_ROLE_LABELS[inv.role] ?? inv.role}</Badge>
            {inv.grantPlatformAdmin && <Badge tone="info">Super Admin</Badge>}
            {onCancel && (
              <Button size="sm" variant="ghost" onClick={() => onCancel(inv)} disabled={cancellingId === inv.id}>
                {cancellingId === inv.id ? 'Cancelling…' : 'Cancel'}
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Role dropdown that saves on change. `onChange` should throw on failure
 * (e.g. demoting the last leader); the select snaps back. */
export function RoleSelect({
  value,
  disabled,
  onChange,
  label,
}: {
  value: MemberRole;
  disabled?: boolean;
  onChange: (role: MemberRole) => Promise<void>;
  label?: string;
}) {
  const [current, setCurrent] = useState<MemberRole>(value);
  const [saving, setSaving] = useState(false);

  useEffect(() => setCurrent(value), [value]);

  async function handle(next: MemberRole) {
    const prev = current;
    setCurrent(next);
    setSaving(true);
    try {
      await onChange(next);
    } catch {
      setCurrent(prev);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Select
      label={label}
      aria-label={label ? undefined : 'Role'}
      value={current}
      onChange={(e) => handle(e.target.value as MemberRole)}
      options={memberRoleOptions(true)}
      disabled={disabled || saving}
    />
  );
}
