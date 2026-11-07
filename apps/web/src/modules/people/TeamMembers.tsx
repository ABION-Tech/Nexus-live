// PRD §7.2 03 PEOPLE → Team Members. Backed by the existing GET /people
// endpoint (routes/people.ts / peopleService.ts's listOrgPeople) — the
// same read-only org roster Network's assignee/owner pickers already
// call via services/peopleService.ts's fetchPeople(). Not a new data
// source, just this section's first real UI: adding/removing team
// members stays on the invite flow (Invites), matching people.ts's own
// header note that this is deliberately not a CRUD module.
//
// Overview/Attendance/Leave/Onboarding stay ComingSoon (ia.ts) — none of
// them have a backend yet worth building UI against: Attendance would
// need new aggregation on top of eod_logs, Leave has a DB table
// (0009_remaining_entities.sql's leave_requests) but no route/service,
// and Onboarding has no team-onboarding schema at all (only the
// unrelated org_contacts.onboarding_status Network already uses).
import { useEffect, useMemo, useState } from 'react';
import { Avatar, Badge, Input, Select, DataGrid, LoadingState, ErrorState } from '../../components/ui';
import type { DataGridColumn } from '../../components/ui';
import { fetchPeople } from '../../services/peopleService';
import type { Person, Role } from '@nexus/shared';

type ListState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; people: Person[] };

// Same three values as shared's Role type — kept local rather than
// exported from @nexus/shared since this is purely a display-label
// concern, the same reasoning statusTone()/formatStatusLabel() in
// components/network use for their own local label maps.
const ROLE_LABELS: Record<Role, string> = {
  leader: 'Leader',
  team_member: 'Team member',
  intern: 'Intern',
  // Session 37: guests are provisioned via guestService.ts's separate
  // credential flow, not this directory's invite-based roster — kept
  // here only to satisfy Record<Role, ...>, same note as Overview.tsx.
  guest: 'Guest',
};

const ROLE_TONE: Record<Role, 'info' | 'neutral' | 'success'> = {
  leader: 'info',
  team_member: 'neutral',
  intern: 'success',
  guest: 'neutral',
};

const ROLE_FILTER_OPTIONS = [
  { value: '', label: 'All roles' },
  { value: 'leader', label: 'Leader' },
  { value: 'team_member', label: 'Team member' },
  { value: 'intern', label: 'Intern' },
];

const COLUMNS: DataGridColumn<Person>[] = [
  {
    key: 'name',
    header: 'Name',
    sortValue: (p) => p.name.toLowerCase(),
    render: (p) => (
      <div className="nx-people__name-cell">
        <Avatar name={p.name} src={p.avatarUrl} size="sm" />
        <span>{p.name}</span>
      </div>
    ),
  },
  { key: 'email', header: 'Email', sortValue: (p) => p.email.toLowerCase(), render: (p) => p.email },
  {
    key: 'role',
    header: 'Role',
    sortValue: (p) => p.role,
    render: (p) => <Badge tone={ROLE_TONE[p.role]}>{ROLE_LABELS[p.role]}</Badge>,
  },
];

export function TeamMembers() {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');

  function load() {
    setState({ status: 'loading' });
    fetchPeople()
      .then((people) => setState({ status: 'ready', people }))
      .catch((err: unknown) => {
        setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' });
      });
  }

  useEffect(load, []);

  const filtered = useMemo(() => {
    if (state.status !== 'ready') return [];
    const q = search.trim().toLowerCase();
    return state.people.filter((p) => {
      if (role && p.role !== role) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q);
    });
  }, [state, search, role]);

  if (state.status === 'loading') return <LoadingState label="Loading team members…" />;
  if (state.status === 'error') return <ErrorState description={state.message} onRetry={load} />;

  return (
    <div className="nx-people">
      <div className="nx-people__toolbar">
        <Input
          placeholder="Search by name or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="nx-people__search"
        />
        <Select value={role} onChange={(e) => setRole(e.target.value)} options={ROLE_FILTER_OPTIONS} />
        <span className="nx-people__count">
          {filtered.length} of {state.people.length}
        </span>
      </div>

      <DataGrid columns={COLUMNS} rows={filtered} rowKey={(p) => p.id} emptyLabel="No team members match that search." />
    </div>
  );
}
