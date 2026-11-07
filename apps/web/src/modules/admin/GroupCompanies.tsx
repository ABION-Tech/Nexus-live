import { useEffect, useState } from 'react';
import { Badge, DataGrid, LoadingState, ErrorState } from '../../components/ui';
import type { DataGridColumn } from '../../components/ui';
import { fetchGroupCompanies } from '../../services/groupAdminService';
import type { Organization } from '@nexus/shared';

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; companies: Organization[] };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const COLUMNS: DataGridColumn<Organization>[] = [
  { key: 'name', header: 'Company', sortValue: (o) => o.name.toLowerCase(), render: (o) => o.name },
  {
    key: 'plan',
    header: 'Plan',
    sortValue: (o) => o.plan,
    render: (o) => <Badge tone={o.plan === 'paid' ? 'info' : 'neutral'}>{o.plan}</Badge>,
  },
  {
    key: 'active',
    header: 'Status',
    sortValue: (o) => (o.active ? 1 : 0),
    render: (o) => <Badge tone={o.active ? 'success' : 'neutral'}>{o.active ? 'Active' : 'Inactive'}</Badge>,
  },
  { key: 'createdAt', header: 'Created', sortValue: (o) => o.createdAt, render: (o) => formatDate(o.createdAt) },
];

// Group Admin > Companies — GET /admin/group/companies, read-only.
// Creating/deactivating/reassigning a company's group is a Super Admin
// action (routes/admin/superAdmin.ts's organizations CRUD); a Group
// Admin only ever reads the companies already assigned to their own
// group, same read-only-roster posture People > Team Members takes for
// invite-created accounts.
export function GroupCompanies() {
  const [state, setState] = useState<ListState>({ status: 'loading' });

  function load() {
    setState({ status: 'loading' });
    fetchGroupCompanies()
      .then((companies) => setState({ status: 'ready', companies }))
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  useEffect(load, []);

  if (state.status === 'loading') return <LoadingState label="Loading companies…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load companies" description={state.message} onRetry={load} />;

  return (
    <div className="nx-page nx-view-enter">
      <h2>Companies</h2>
      <DataGrid
        columns={COLUMNS}
        rows={state.companies}
        rowKey={(o) => o.id}
        rowClassName={(o) => (o.active ? undefined : 'nx-table__row--inactive')}
      />
    </div>
  );
}
