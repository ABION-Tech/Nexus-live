import { useEffect, useState } from 'react';
import { Avatar, Badge, Button, Card, Drawer, Select, Table, LoadingState, ErrorState, EmptyState, useToast } from '../../components/ui';
import { InviteMemberModal, PendingInvitesList, RoleSelect } from '../../components/admin/PeopleAccess';
import { MEMBER_ROLE_HELP } from '../../components/admin/memberRoles';
import type { TableColumn } from '../../components/ui';
import { changeMemberRole, fetchPeople } from '../../services/peopleService';
import { cancelInvite, fetchPendingInvites, sendInvite } from '../../services/inviteService';
import { fetchPermissionsForUser, grantPermission, revokePermission } from '../../services/permissionService';
import type { CurrentUser } from '../../services/authService';
import type { MemberRole, PendingInvite, Permission, PermissionAction, Person } from '@nexus/shared';
import { PERMISSION_RESOURCE_ACTIONS } from '@nexus/shared';

const ROLE_LABELS: Record<Person['role'], string> = {
  leader: 'Leader',
  team_member: 'Team member',
  intern: 'Intern',
  // Session 37: guest grant management is out of scope for this screen
  // for now (guests get project-scoped visibility, not resource+action
  // grants, per ADMIN_BUILD_GUIDE.md §1/§2) — label included only to
  // satisfy Record<Person['role'], ...>.
  guest: 'Guest',
};

const ROLE_TONE: Record<Person['role'], 'info' | 'neutral' | 'success'> = {
  leader: 'info',
  team_member: 'neutral',
  intern: 'success',
  guest: 'neutral',
};

const RESOURCE_OPTIONS = Object.keys(PERMISSION_RESOURCE_ACTIONS)
  .sort()
  .map((resource) => ({ value: resource, label: resource }));

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; people: Person[] };

// Settings > Team & Roles (PRD §7.2 11 / §13.3). Session 36 finally
// builds the "editable per-resource trust grants" ia.ts's own comment on
// this route flagged as missing — until now this route rendered the
// exact same read-only roster as People > Team Members. It still starts
// from that same roster (GET /people), but a row click now opens a
// drawer onto that person's own `permissions` rows (routes/permissions.ts),
// so this file is now a distinct component from TeamMembers.tsx rather
// than an alias for it — same reasoning TaskSection.tsx gives for owning
// its own state once one caller needed something CrudSection had no
// concept of.
export function TeamRoles({ user }: { user: CurrentUser }) {
  const { show } = useToast();
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [drawerPerson, setDrawerPerson] = useState<Person | null>(null);
  // Session 53: invites + role changes live here too, so a leader can
  // bring people in and set what they are without leaving this screen.
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  function load() {
    setState({ status: 'loading' });
    fetchPeople()
      .then((people) => setState({ status: 'ready', people }))
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  function loadInvites() {
    if (user.role !== 'leader') return;
    fetchPendingInvites()
      .then(setInvites)
      .catch(() => setInvites([]));
  }

  useEffect(() => {
    load();
    loadInvites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleInvite(email: string, role: MemberRole) {
    await sendInvite(email, role);
    show(`Invite sent to ${email}.`, 'success');
    setInviteOpen(false);
    loadInvites();
  }

  async function handleCancelInvite(invite: PendingInvite) {
    setCancellingId(invite.id);
    try {
      await cancelInvite(invite.id);
      show(`Invite to ${invite.email} cancelled.`, 'success');
      loadInvites();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Could not cancel the invite.', 'danger');
    } finally {
      setCancellingId(null);
    }
  }

  // Convenience gate only — same posture as every other `role ===
  // 'leader'` client-side check in this codebase (Chat.tsx's export
  // button, AutomationToggles.tsx). The real boundary is routes/
  // permissions.ts's own `hasPermission(user, 'permissions', action)`,
  // which a leader passes via rbac.ts's role bypass and a delegated
  // non-leader passes via an explicit `permissions` grant this same
  // drawer could have given them.
  const canManage = user.role === 'leader';

  const columns: TableColumn<Person>[] = [
    {
      key: 'name',
      header: 'Name',
      render: (p) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Avatar name={p.name} src={p.avatarUrl} size="sm" />
          <span>{p.name}</span>
        </div>
      ),
    },
    { key: 'email', header: 'Email', render: (p) => p.email },
    {
      key: 'role',
      header: 'Role',
      render: (p) => <Badge tone={ROLE_TONE[p.role]}>{ROLE_LABELS[p.role]}</Badge>,
    },
    {
      key: 'access',
      header: 'Access',
      render: (p) =>
        canManage ? (
          <span style={{ color: 'var(--accent)' }}>{p.role === 'leader' ? 'Full access · Change role →' : 'Manage →'}</span>
        ) : p.role === 'leader' ? (
          <span style={{ color: 'var(--text-dim)' }}>Full access (role)</span>
        ) : (
          <span style={{ color: 'var(--accent)' }}>View →</span>
        ),
    },
  ];

  if (state.status === 'loading') return <LoadingState label="Loading team roster…" />;
  if (state.status === 'error') return <ErrorState description={state.message} onRetry={load} />;

  return (
    <div className="nx-page nx-view-enter">
      <div className="nx-row nx-row--between" style={{ alignItems: 'flex-end', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2>Team &amp; Roles</h2>
          <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>
            {canManage
              ? 'Invite people, set their role, and grant extra permissions. Leaders always have full access.'
              : 'Leaders always have full access to every resource; everyone else needs an explicit grant per resource.'}
          </p>
        </div>
        {canManage && <Button onClick={() => setInviteOpen(true)}>Invite member</Button>}
      </div>

      {canManage && invites.length > 0 && (
        <Card>
          <div className="nx-stack nx-stack--sm">
            <h4 style={{ margin: 0 }}>Pending invites</h4>
            <PendingInvitesList invites={invites} cancellingId={cancellingId} onCancel={handleCancelInvite} />
          </div>
        </Card>
      )}

      <Table
        columns={columns}
        rows={state.people}
        rowKey={(p) => p.id}
        onRowClick={(p) => (p.role === 'guest' ? undefined : canManage || p.role !== 'leader' ? setDrawerPerson(p) : undefined)}
      />

      <PermissionsDrawer
        person={drawerPerson}
        onClose={() => setDrawerPerson(null)}
        canManage={canManage}
        onRoleChanged={(updated) => {
          setDrawerPerson(updated);
          load();
        }}
      />

      <InviteMemberModal
        open={inviteOpen}
        title="Invite a team member"
        onClose={() => setInviteOpen(false)}
        onSubmit={handleInvite}
      />
    </div>
  );
}

function PermissionsDrawer({
  person,
  onClose,
  canManage,
  onRoleChanged,
}: {
  person: Person | null;
  onClose: () => void;
  canManage: boolean;
  onRoleChanged: (person: Person) => void;
}) {
  const { show } = useToast();
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; permissions: Permission[] }
  >({ status: 'loading' });
  const [resource, setResource] = useState<string>('');
  const [action, setAction] = useState<string>('');
  const [granting, setGranting] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  function load(personId: string) {
    setState({ status: 'loading' });
    fetchPermissionsForUser(personId)
      .then((permissions) => setState({ status: 'ready', permissions }))
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  useEffect(() => {
    if (!person) return;
    setResource('');
    setAction('');
    load(person.id);
    // Only re-load when the drawer switches to a different person, not
    // on every render — same posture as TaskDrawer's own `[task?.id]`
    // dependency array before its thread moved into ChatThread.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [person?.id]);

  const actionOptions = resource
    ? (PERMISSION_RESOURCE_ACTIONS[resource] ?? []).map((a) => ({ value: a, label: a }))
    : [];

  async function handleGrant() {
    if (!person || !resource || !action) return;
    setGranting(true);
    try {
      await grantPermission(person.id, resource, action as PermissionAction);
      show(`Granted ${resource}:${action}.`, 'success');
      setResource('');
      setAction('');
      load(person.id);
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Grant failed.', 'danger');
    } finally {
      setGranting(false);
    }
  }

  async function handleRevoke(permission: Permission) {
    if (!person) return;
    setRevokingId(permission.id);
    try {
      await revokePermission(permission.id);
      show(`Revoked ${permission.resource}:${permission.action}.`, 'success');
      load(person.id);
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Revoke failed.', 'danger');
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <Drawer open={person !== null} onClose={onClose} title={person ? `${person.name} — Access` : undefined}>
      {person && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{person.email}</div>
          </div>

          {canManage && person.role !== 'guest' && (
            <div className="nx-stack nx-stack--sm">
              <h4 style={{ margin: 0 }}>Role</h4>
              <RoleSelect
                value={person.role as MemberRole}
                onChange={async (role) => {
                  try {
                    await changeMemberRole(person.id, role);
                    show(`${person.name}'s role is now ${ROLE_LABELS[role]}.`, 'success');
                    onRoleChanged({ ...person, role });
                  } catch (err: unknown) {
                    show(err instanceof Error ? err.message : 'Could not change the role.', 'danger');
                    throw err;
                  }
                }}
              />
              <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 12 }}>{MEMBER_ROLE_HELP[person.role as MemberRole]}</p>
            </div>
          )}

          {person.role === 'leader' ? (
            <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 13 }}>
              Leaders have full access to everything, so there are no individual permissions to manage.
            </p>
          ) : (
          <>

          <div className="nx-stack nx-stack--sm">
            <h4 style={{ margin: 0 }}>Current grants</h4>
            {state.status === 'loading' && <LoadingState label="Loading grants…" />}
            {state.status === 'error' && <ErrorState description={state.message} onRetry={() => load(person.id)} />}
            {state.status === 'ready' && state.permissions.length === 0 && (
              <EmptyState title="No explicit grants" description="This person has no permissions beyond what their role gives everyone." />
            )}
            {state.status === 'ready' && state.permissions.length > 0 && (
              <div className="nx-stack nx-stack--sm">
                {state.permissions.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      padding: '8px 10px',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                    }}
                  >
                    <Badge tone="info">
                      {p.resource}:{p.action}
                    </Badge>
                    {canManage && (
                      <Button size="sm" variant="ghost" onClick={() => handleRevoke(p)} disabled={revokingId === p.id}>
                        {revokingId === p.id ? 'Revoking…' : 'Revoke'}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {canManage && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
              <h4 style={{ margin: 0 }}>Grant a permission</h4>
              <Select
                label="Resource"
                placeholder="Choose a resource…"
                options={RESOURCE_OPTIONS}
                value={resource}
                onChange={(e) => {
                  setResource(e.target.value);
                  setAction('');
                }}
              />
              <Select
                label="Action"
                placeholder={resource ? 'Choose an action…' : 'Choose a resource first'}
                options={actionOptions}
                value={action}
                onChange={(e) => setAction(e.target.value)}
                disabled={!resource}
              />
              <Button onClick={handleGrant} disabled={!resource || !action || granting}>
                {granting ? 'Granting…' : 'Grant'}
              </Button>
            </div>
          )}
          </>
          )}
        </div>
      )}
    </Drawer>
  );
}
