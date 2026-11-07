import { useEffect, useState } from 'react';
import { Badge, Button, Card, Input, DataGrid, LoadingState, ErrorState } from '../../components/ui';
import type { DataGridColumn } from '../../components/ui';
import { searchPlatformUsers } from '../../services/superAdminService';
import type { PlatformUserSummary } from '@nexus/shared';

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; users: PlatformUserSummary[] };

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const COLUMNS: DataGridColumn<PlatformUserSummary>[] = [
  { key: 'name', header: 'Name', sortValue: (u) => u.name.toLowerCase(), render: (u) => u.name },
  { key: 'email', header: 'Email', sortValue: (u) => u.email.toLowerCase(), render: (u) => u.email },
  {
    key: 'homeOrg',
    header: 'Home organization',
    sortValue: (u) => (u.homeOrgName ?? '').toLowerCase(),
    render: (u) => u.homeOrgName ?? <span style={{ color: 'var(--text-dim)' }}>—</span>,
  },
  {
    key: 'role',
    header: 'Role',
    sortValue: (u) => u.role ?? '',
    render: (u) => (u.role ? <Badge tone="neutral">{u.role}</Badge> : <span style={{ color: 'var(--text-dim)' }}>—</span>),
  },
  { key: 'createdAt', header: 'Joined', sortValue: (u) => u.createdAt, render: (u) => formatDate(u.createdAt) },
];

// Super Admin > Users (ADMIN_BUILD_GUIDE.md §3 "Session 5", "Investigation
// UI: search + ... drill-down"). Drill-down into a specific user's own
// org (Group→Company→User breadcrumb the guide names) isn't built here —
// `homeOrgName` on each row already answers "which org is this person
// in," which is the actual question this search exists to answer; a
// separate click-through view onto that org's own detail page would just
// re-render the Organizations tab's own row for one org, so results here
// link nowhere rather than duplicating that screen. Read-only, same as
// every other Super Admin investigation surface per the guide
// ("Read-only by default").
export function SuperUsers() {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [query, setQuery] = useState('');

  function load(q?: string) {
    setState({ status: 'loading' });
    searchPlatformUsers(q)
      .then((users) => setState({ status: 'ready', users }))
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  useEffect(() => load(), []);

  return (
    <div className="nx-page nx-view-enter">
      <div>
        <h2>Users</h2>
        <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 4 }}>
          Every user on the platform, in any organization. Search by name or email.
        </p>
      </div>

      <Card>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 320px' }}>
            <Input
              label="Search"
              placeholder="Search by name or email…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load(query.trim() || undefined)}
            />
          </div>
          <Button variant="secondary" onClick={() => load(query.trim() || undefined)}>Search</Button>
        </div>
      </Card>

      {state.status === 'loading' && <LoadingState label="Loading users…" />}
      {state.status === 'error' && <ErrorState title="Couldn't load users" description={state.message} onRetry={() => load(query.trim() || undefined)} />}
      {state.status === 'ready' && <DataGrid columns={COLUMNS} rows={state.users} rowKey={(u) => u.id} emptyLabel="No users match that search." />}
    </div>
  );
}
