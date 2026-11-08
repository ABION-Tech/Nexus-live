import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  Drawer,
  Input,
  Modal,
  Select,
  Table,
  LoadingState,
  ErrorState,
  useToast,
} from '../../components/ui';
import type { TableColumn } from '../../components/ui';
import {
  assignCompanyToGroup,
  cancelOrganizationInvite,
  changeOrganizationMemberRole,
  createOrganization,
  deactivateOrganization,
  fetchOrgMembers,
  fetchOrganizationBilling,
  setOrganizationBillingTier,
  inviteToOrganization,
  searchOrganizations,
  updateOrganization,
} from '../../services/superAdminService';
import { InviteMemberModal, PendingInvitesList, RoleSelect } from '../../components/admin/PeopleAccess';
import { MEMBER_ROLE_LABELS } from '../../components/admin/memberRoles';
import type { BillingTierKey, MemberRole, Organization, OrgType, PendingInvite, Person } from '@nexus/shared';

const TIER_OPTIONS: { value: BillingTierKey; label: string }[] = [
  { value: 'free', label: 'Free (up to 5 people)' },
  { value: 'starter', label: 'Starter (up to 25 people)' },
  { value: 'pro', label: 'Pro (unlimited people)' },
];

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; organizations: Organization[] };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Super Admin > Organizations (ADMIN_BUILD_GUIDE.md §3 "Session 5"). One
// tab covering both Groups and Companies from the guide's own dashboard
// list — PlatformUserSummary/Organization are the same shape for either
// org_type, and every action here (create, rename, plan change,
// deactivate, group assignment) is genuinely one CRUD surface, not two;
// splitting it into separate "Groups" and "Companies" tabs the way the
// guide's own outline names them would just be the same table filtered
// twice with no different behavior behind either filter. A client-side
// org-type filter covers the guide's own two-tab framing without a
// second component.
export function SuperOrganizations() {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'' | OrgType>('');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Organization | null>(null);

  function load(q?: string) {
    setState({ status: 'loading' });
    searchOrganizations(q)
      .then((organizations) => setState({ status: 'ready', organizations }))
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  useEffect(() => load(), []);

  function handleSearch() {
    load(query.trim() || undefined);
  }

  const columns: TableColumn<Organization>[] = [
    { key: 'name', header: 'Name', render: (o) => o.name },
    {
      key: 'orgType',
      header: 'Type',
      render: (o) => <Badge tone={o.orgType === 'group' ? 'info' : 'neutral'}>{o.orgType}</Badge>,
    },
    {
      key: 'active',
      header: 'Status',
      render: (o) => <Badge tone={o.active ? 'success' : 'warning'}>{o.active ? 'Active' : 'Inactive'}</Badge>,
    },
    { key: 'createdAt', header: 'Created', render: (o) => formatDate(o.createdAt) },
  ];

  if (state.status === 'loading') return <LoadingState label="Loading organizations…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load organizations" description={state.message} onRetry={() => load()} />;

  const filtered = typeFilter ? state.organizations.filter((o) => o.orgType === typeFilter) : state.organizations;
  const groupOptions = state.organizations
    .filter((o) => o.orgType === 'group')
    .map((g) => ({ value: g.id, label: g.name }));

  return (
    <div className="nx-page nx-view-enter">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2>Organizations</h2>
          <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>
            Every Group and Company on the platform. Creating, renaming, changing plan tier, deactivating, and (re)assigning a
            company to a group are all Super Admin-only actions.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>New organization</Button>
      </div>

      <Card>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 240px' }}>
            <Input
              label="Search"
              placeholder="Search by name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            />
          </div>
          <div style={{ width: 180 }}>
            <Select
              label="Type"
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value as '' | OrgType)}
              options={[
                { value: 'group', label: 'Groups' },
                { value: 'company', label: 'Companies' },
              ]}
              placeholder="All types"
            />
          </div>
          <Button variant="secondary" onClick={handleSearch}>Search</Button>
        </div>
      </Card>

      <Table columns={columns} rows={filtered} rowKey={(o) => o.id} onRowClick={(o) => setEditing(o)} rowClassName={(o) => (o.active ? undefined : 'nx-table__row--inactive')} />

      <CreateOrganizationModal
        open={createOpen}
        groupOptions={groupOptions}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          load(query.trim() || undefined);
        }}
      />

      <EditOrganizationDrawer
        organization={editing}
        groupOptions={groupOptions}
        onClose={() => setEditing(null)}
        onChanged={() => {
          setEditing(null);
          load(query.trim() || undefined);
        }}
      />
    </div>
  );
}

function CreateOrganizationModal({
  open,
  groupOptions,
  onClose,
  onCreated,
}: {
  open: boolean;
  groupOptions: { value: string; label: string }[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { show } = useToast();
  const [name, setName] = useState('');
  const [orgType, setOrgType] = useState<OrgType>('company');
  const [parentOrgId, setParentOrgId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setOrgType('company');
      setParentOrgId('');
      setError(null);
    }
  }, [open]);

  async function handleSubmit() {
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const org = await createOrganization({
        name: name.trim(),
        orgType,
        parentOrgId: orgType === 'company' && parentOrgId ? parentOrgId : undefined,
      });
      show(`${org.orgType === 'group' ? 'Group' : 'Company'} "${org.name}" created.`, 'success');
      onCreated();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not create the organization.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New organization">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 320 }}>
        <Input label="Name" placeholder="e.g. ABION Industries" value={name} onChange={(e) => setName(e.target.value)} />
        <Select
          label="Type"
          value={orgType}
          onChange={(e) => setOrgType(e.target.value as OrgType)}
          options={[
            { value: 'company', label: 'Company' },
            { value: 'group', label: 'Group' },
          ]}
        />
        {orgType === 'company' && (
          <Select
            label="Parent group (optional)"
            value={parentOrgId}
            onChange={(e) => setParentOrgId(e.target.value)}
            options={groupOptions}
            placeholder="Independent company — no group"
          />
        )}
        {error && <span className="nx-field__error">{error}</span>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitting}>{submitting ? 'Creating…' : 'Create'}</Button>
        </div>
      </div>
    </Modal>
  );
}

function EditOrganizationDrawer({
  organization,
  groupOptions,
  onClose,
  onChanged,
}: {
  organization: Organization | null;
  groupOptions: { value: string; label: string }[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { show } = useToast();
  const [name, setName] = useState('');
  // Session 53: the real billing plan (org_billing.tier, which sets the
  // seat limit), replacing the old unenforced organizations.plan label.
  const [tier, setTier] = useState<BillingTierKey | ''>('');
  const [savedTier, setSavedTier] = useState<BillingTierKey | ''>('');
  const [seatInfo, setSeatInfo] = useState<string>('');
  const [groupOrgId, setGroupOrgId] = useState('');
  const [saving, setSaving] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (organization) {
      setName(organization.name);
      setTier('');
      setSavedTier('');
      setSeatInfo('');
      fetchOrganizationBilling(organization.id)
        .then((b) => {
          setTier(b.tier);
          setSavedTier(b.tier);
          setSeatInfo(`${b.seatCount} of ${b.seatLimit ?? 'unlimited'} seats used${b.effectiveSourceOrgId !== organization.id ? ' (plan inherited from its group)' : ''}`);
        })
        .catch(() => setSeatInfo('Could not load the current plan.'));
      setGroupOrgId(organization.parentOrgId ?? '');
      setError(null);
    }
  }, [organization?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    if (!organization) return;
    setSaving(true);
    setError(null);
    try {
      const patch: { name?: string } = {};
      if (name.trim() && name.trim() !== organization.name) patch.name = name.trim();
      if (tier && tier !== savedTier) {
        await setOrganizationBillingTier(organization.id, tier);
      }
      if (Object.keys(patch).length > 0) {
        await updateOrganization(organization.id, patch);
      }
      if (organization.orgType === 'company' && (groupOrgId || undefined) !== organization.parentOrgId) {
        await assignCompanyToGroup(organization.id, groupOrgId || null);
      }
      show(`"${organization.name}" updated.`, 'success');
      onChanged();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Could not save changes.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivate() {
    if (!organization) return;
    setDeactivating(true);
    try {
      await deactivateOrganization(organization.id);
      show(`"${organization.name}" deactivated.`, 'success');
      onChanged();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Could not deactivate.', 'danger');
    } finally {
      setDeactivating(false);
    }
  }

  return (
    <Drawer open={organization !== null} onClose={onClose} title={organization?.name}>
      {organization && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Badge tone={organization.orgType === 'group' ? 'info' : 'neutral'}>{organization.orgType}</Badge>
            <Badge tone={organization.active ? 'success' : 'warning'}>{organization.active ? 'Active' : 'Inactive'}</Badge>
          </div>

          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} />

          <Select
            label="Plan"
            value={tier}
            onChange={(e) => setTier(e.target.value as BillingTierKey)}
            options={TIER_OPTIONS}
            placeholder="Loading…"
            disabled={!savedTier}
          />
          <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 12 }}>
            {seatInfo || 'Sets how many people this organization can have. Changing it here marks the plan as set by a Super Admin (no charge).'}
          </p>

          {organization.orgType === 'company' && (
            <Select
              label="Group"
              value={groupOrgId}
              onChange={(e) => setGroupOrgId(e.target.value)}
              options={groupOptions}
              placeholder="Independent — no group"
            />
          )}

          {error && <span className="nx-field__error">{error}</span>}

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginTop: 8 }}>
            <Button variant="danger" onClick={handleDeactivate} disabled={deactivating || !organization.active}>
              {deactivating ? 'Deactivating…' : organization.active ? 'Deactivate' : 'Already inactive'}
            </Button>
            <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
          </div>

          <OrganizationPeoplePanel organization={organization} />
        </div>
      )}
    </Drawer>
  );
}

// Session 53 — who is in this organization, what role they hold, and who
// has been invited. This is how a new company gets its first admin:
// create the company, open it here, and invite its leader. (Ordinary
// invites only ever go into the inviter's own organization.)
function OrganizationPeoplePanel({ organization }: { organization: Organization }) {
  const { show } = useToast();
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; people: Person[]; invites: PendingInvite[] }
  >({ status: 'loading' });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  function load() {
    setState({ status: 'loading' });
    fetchOrgMembers(organization.id)
      .then(({ people, invites }) => setState({ status: 'ready', people, invites }))
      .catch((err: unknown) => setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' }));
  }

  useEffect(load, [organization.id]);

  async function handleInvite(email: string, role: MemberRole) {
    await inviteToOrganization(organization.id, email, role);
    show(`Invite sent to ${email}.`, 'success');
    setInviteOpen(false);
    load();
  }

  async function handleCancel(invite: PendingInvite) {
    setCancellingId(invite.id);
    try {
      await cancelOrganizationInvite(organization.id, invite.id);
      show(`Invite to ${invite.email} cancelled.`, 'success');
      load();
    } catch (err: unknown) {
      show(err instanceof Error ? err.message : 'Could not cancel the invite.', 'danger');
    } finally {
      setCancellingId(null);
    }
  }

  const leaders = state.status === 'ready' ? state.people.filter((p) => p.role === 'leader').length : 0;
  const adminLabel = organization.orgType === 'group' ? 'Group Admin' : 'Company Admin';

  return (
    <div className="nx-stack nx-stack--md" style={{ paddingTop: 16, borderTop: '1px solid var(--border)' }}>
      <div className="nx-row nx-row--between" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h4 style={{ margin: 0 }}>People</h4>
          <p style={{ margin: '4px 0 0', color: 'var(--text-dim)', fontSize: 12 }}>
            A leader here is this {organization.orgType}'s {adminLabel}.
          </p>
        </div>
        <Button size="sm" onClick={() => setInviteOpen(true)}>Invite</Button>
      </div>

      {state.status === 'loading' && <LoadingState label="Loading people…" />}
      {state.status === 'error' && <ErrorState description={state.message} onRetry={load} />}
      {state.status === 'ready' && (
        <>
          {leaders === 0 && (
            <Card>
              <div className="nx-stack nx-stack--sm">
                <Badge tone="warning">No admin yet</Badge>
                <p style={{ margin: 0, fontSize: 13 }}>
                  Nobody can manage this {organization.orgType} yet. Invite its {adminLabel} as a Leader to get it started.
                </p>
              </div>
            </Card>
          )}

          {state.people.length > 0 && (
            <div className="nx-stack nx-stack--sm">
              {state.people.map((p) => (
                <div
                  key={p.id}
                  className="nx-row nx-row--between"
                  style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8, gap: 12, flexWrap: 'wrap' }}
                >
                  <div className="nx-stack nx-stack--xs" style={{ minWidth: 0 }}>
                    <span style={{ fontSize: 14 }}>{p.name}</span>
                    <span style={{ fontSize: 12, color: 'var(--text-dim)', overflowWrap: 'anywhere' }}>{p.email}</span>
                  </div>
                  <div style={{ width: 150 }}>
                    <RoleSelect
                      value={p.role as MemberRole}
                      onChange={async (role) => {
                        try {
                          await changeOrganizationMemberRole(organization.id, p.id, role);
                          show(`${p.name}'s role is now ${MEMBER_ROLE_LABELS[role]}.`, 'success');
                          load();
                        } catch (err: unknown) {
                          show(err instanceof Error ? err.message : 'Could not change the role.', 'danger');
                          throw err;
                        }
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="nx-stack nx-stack--sm">
            <h4 style={{ margin: 0, fontSize: 13 }}>Pending invites</h4>
            <PendingInvitesList invites={state.invites} cancellingId={cancellingId} onCancel={handleCancel} />
          </div>
        </>
      )}

      <InviteMemberModal
        open={inviteOpen}
        title={`Invite to ${organization.name}`}
        description={leaders === 0 ? `Start with this ${organization.orgType}'s ${adminLabel}: invite them as a Leader.` : undefined}
        defaultRole={leaders === 0 ? 'leader' : 'team_member'}
        onClose={() => setInviteOpen(false)}
        onSubmit={handleInvite}
      />
    </div>
  );
}
