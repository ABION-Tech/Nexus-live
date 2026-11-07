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
  createOrganization,
  deactivateOrganization,
  searchOrganizations,
  updateOrganization,
} from '../../services/superAdminService';
import type { Organization, OrgType } from '@nexus/shared';

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
      key: 'plan',
      header: 'Plan',
      render: (o) => <Badge tone={o.plan === 'paid' ? 'success' : 'neutral'}>{o.plan}</Badge>,
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
  const [plan, setPlan] = useState<'free' | 'paid'>('free');
  const [groupOrgId, setGroupOrgId] = useState('');
  const [saving, setSaving] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (organization) {
      setName(organization.name);
      setPlan(organization.plan);
      setGroupOrgId(organization.parentOrgId ?? '');
      setError(null);
    }
  }, [organization?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSave() {
    if (!organization) return;
    setSaving(true);
    setError(null);
    try {
      const patch: { name?: string; plan?: 'free' | 'paid' } = {};
      if (name.trim() && name.trim() !== organization.name) patch.name = name.trim();
      if (plan !== organization.plan) patch.plan = plan;
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
            value={plan}
            onChange={(e) => setPlan(e.target.value as 'free' | 'paid')}
            options={[
              { value: 'free', label: 'Free' },
              { value: 'paid', label: 'Paid' },
            ]}
          />
          <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 12 }}>
            Plan is a hook only for now — no billing enforcement yet (ADMIN_BUILD_GUIDE.md §1). This just moves the value.
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
        </div>
      )}
    </Drawer>
  );
}
