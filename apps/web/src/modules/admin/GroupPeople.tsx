import { useEffect, useState } from 'react';
import { Avatar, Badge, DataGrid, LoadingState, ErrorState } from '../../components/ui';
import type { DataGridColumn } from '../../components/ui';
import { fetchPeople } from '../../services/peopleService';
import type { Person, Role } from '@nexus/shared';

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; people: Person[] };

const ROLE_LABELS: Record<Role, string> = {
  leader: 'Leader',
  team_member: 'Team member',
  intern: 'Intern',
  guest: 'Guest',
};

// Group Admin > People — deliberately NOT a new admin-scoped route. A
// Group Admin's session orgId *is* their group org, so the existing
// GET /people (already RLS-scoped to the caller's own org) returns
// exactly this group's own roster with no group-specific backend code
// needed — same reuse posture the guide calls out for Company Admin's
// shell ("mostly reuse"), just applying it to a Group Admin tab too
// since the underlying mechanism (session-cookie org scoping) is
// identical for either org type.
export function GroupPeople() {
  const [state, setState] = useState<ListState>({ status: 'loading' });

  function load() {
    setState({ status: 'loading' });
    fetchPeople()
      .then((people) => setState({ status: 'ready', people }))
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  useEffect(load, []);

  if (state.status === 'loading') return <LoadingState label="Loading people…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load people" description={state.message} onRetry={load} />;

  const columns: DataGridColumn<Person>[] = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (p) => p.name.toLowerCase(),
      render: (p) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Avatar name={p.name} src={p.avatarUrl} size="sm" />
          <span>{p.name}</span>
        </div>
      ),
    },
    { key: 'email', header: 'Email', render: (p) => p.email },
    { key: 'role', header: 'Role', sortValue: (p) => p.role, render: (p) => <Badge tone="neutral">{ROLE_LABELS[p.role]}</Badge> },
  ];

  return (
    <div className="nx-page nx-view-enter">
      <h2>People</h2>
      <p style={{ color: 'var(--text-dim)', fontSize: 13 }}>This group's own roster — not a merge across companies.</p>
      <DataGrid columns={columns} rows={state.people} rowKey={(p) => p.id} />
    </div>
  );
}
