import { useEffect, useState } from 'react';
import { Avatar, Badge, Button, Card, Input, LoadingState, ErrorState, Modal, Select, Table, useToast } from '../../components/ui';
import type { TableColumn } from '../../components/ui';
import { memberRoleOptions } from '../../components/admin/memberRoles';
import {
  addPlatformAdmin,
  fetchPlatformAdmins,
  removePlatformAdmin,
  searchOrganizations,
} from '../../services/superAdminService';
import type { CurrentUser } from '../../services/authService';
import type { MemberRole, Organization, PlatformAdminEntry } from '@nexus/shared';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

type State = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; admins: PlatformAdminEntry[] };

// Super Admin > Super Admins (Session 53). The people who run NEXUS
// itself: every organization, user, billing review and the audit log.
// Distinct from Group/Company Admins, who only manage their own
// organization. The server refuses to remove yourself or the last one.
export function SuperAdmins({ user }: { user: CurrentUser }) {
  const { show } = useToast();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [addOpen, setAddOpen] = useState(false);
  const [confirming, setConfirming] = useState<PlatformAdminEntry | null>(null);
  const [removing, setRemoving] = useState(false);

  function load() {
    setState({ status: 'loading' });
    fetchPlatformAdmins()
      .then((admins) => setState({ status: 'ready', admins }))
      .catch((err: unknown) => setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' }));
  }

  useEffect(load, []);

  async function handleRemove() {
    if (!confirming) return;
    setRemoving(true);
    try {
      await removePlatformAdmin(confirming.userId);
      show(`${confirming.name} is no longer a Super Admin.`, 'success');
      setConfirming(null);
      load();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Could not remove Super Admin access.', 'danger');
    } finally {
      setRemoving(false);
    }
  }

  const columns: TableColumn<PlatformAdminEntry>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (a) => (
        <div className="nx-row" style={{ gap: 10 }}>
          <Avatar name={a.name} size="sm" />
          <span>{a.name}</span>
          {a.userId === user.id && <Badge tone="info">You</Badge>}
        </div>
      ),
    },
    { key: 'email', header: 'Email', render: (a) => a.email },
    { key: 'since', header: 'Super Admin since', render: (a) => formatDate(a.grantedAt) },
    { key: 'by', header: 'Added by', render: (a) => a.grantedByName ?? <span style={{ color: 'var(--text-dim)' }}>—</span> },
    {
      key: 'actions',
      header: '',
      render: (a) =>
        a.userId === user.id ? null : (
          <Button size="sm" variant="ghost" onClick={() => setConfirming(a)}>
            Remove
          </Button>
        ),
    },
  ];

  if (state.status === 'loading') return <LoadingState label="Loading Super Admins…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load Super Admins" description={state.message} onRetry={load} />;

  return (
    <div className="nx-page nx-view-enter">
      <div className="nx-row nx-row--between" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2>Super Admins</h2>
          <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>
            The people who run NEXUS itself: every organization, user, billing review and the audit log. Group and Company Admins
            only manage their own organization.
          </p>
        </div>
        <Button onClick={() => setAddOpen(true)}>Add Super Admin</Button>
      </div>

      <Table columns={columns} rows={state.admins} rowKey={(a) => a.userId} />

      <AddSuperAdminModal
        open={addOpen}
        defaultOrgId={user.orgId}
        onClose={() => setAddOpen(false)}
        onDone={(message) => {
          show(message, 'success');
          setAddOpen(false);
          load();
        }}
      />

      <Modal open={confirming !== null} onClose={() => setConfirming(null)} title="Remove Super Admin access?">
        {confirming && (
          <div className="nx-stack nx-stack--md" style={{ maxWidth: 420 }}>
            <p style={{ margin: 0, fontSize: 14 }}>
              {confirming.name} ({confirming.email}) will keep their normal account and their role in their own organization, but
              will lose access to the Super Admin area.
            </p>
            <div className="nx-row" style={{ justifyContent: 'flex-end' }}>
              <Button variant="ghost" onClick={() => setConfirming(null)} disabled={removing}>Cancel</Button>
              <Button variant="danger" onClick={handleRemove} disabled={removing}>{removing ? 'Removing…' : 'Remove access'}</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function AddSuperAdminModal({
  open,
  defaultOrgId,
  onClose,
  onDone,
}: {
  open: boolean;
  defaultOrgId: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [email, setEmail] = useState('');
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [homeOrgId, setHomeOrgId] = useState(defaultOrgId);
  const [role, setRole] = useState<MemberRole>('leader');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEmail('');
    setHomeOrgId(defaultOrgId);
    setRole('leader');
    setError(null);
    searchOrganizations()
      .then((all) => setOrgs(all.filter((o) => o.active)))
      .catch(() => setOrgs([]));
  }, [open, defaultOrgId]);

  async function handleSubmit() {
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError('Enter a valid email address.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await addPlatformAdmin({ email: trimmed, homeOrgId, role });
      onDone(
        result.status === 'granted'
          ? `${result.admin.name} is now a Super Admin.`
          : `Invite sent to ${trimmed}. They become a Super Admin when they first sign in.`
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not add the Super Admin.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add a Super Admin">
      <div className="nx-stack nx-stack--md" style={{ minWidth: 320, maxWidth: 440 }}>
        <Input
          label="Email"
          type="email"
          placeholder="name@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
        />
        <Card>
          <div className="nx-stack nx-stack--sm">
            <p style={{ margin: 0, fontSize: 13 }}>
              Already on NEXUS? They get Super Admin access straight away and the fields below are ignored.
            </p>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-dim)' }}>
              New to NEXUS? They're invited into the organization below, and become a Super Admin when they first sign in with Google.
            </p>
          </div>
        </Card>
        <Select
          label="Organization they'll belong to"
          value={homeOrgId}
          onChange={(e) => setHomeOrgId(e.target.value)}
          options={orgs.map((o) => ({ value: o.id, label: `${o.name} (${o.orgType})` }))}
        />
        <Select label="Their role there" value={role} onChange={(e) => setRole(e.target.value as MemberRole)} options={memberRoleOptions(true)} />
        {error && <span className="nx-field__error">{error}</span>}
        <div className="nx-row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting}>{submitting ? 'Adding…' : 'Add Super Admin'}</Button>
        </div>
      </div>
    </Modal>
  );
}
