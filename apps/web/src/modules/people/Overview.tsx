// PRD §7.2 04 PEOPLE → Overview ("HR"). Session 58: rebuilt as the
// original HTML app's team directory — a card per person with their role,
// email, open tasks and whether today's EOD is in — under the role counts
// and today's EOD compliance. Search by name, email or role.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar, Badge, Card, ErrorState, LoadingState } from '../../components/ui';
import { fetchPeople } from '../../services/peopleService';
import { fetchEodCompliance, fetchEodLogs } from '../../services/eodService';
import { fetchAllTasks } from '../../services/taskService';
import type { EodComplianceSummary, Person, Role } from '@nexus/shared';

const ROLE_LABELS: Record<Role, string> = { leader: 'Leader', team_member: 'Team member', intern: 'Intern', guest: 'Guest' } as Record<Role, string>;
const ROLE_ORDER: Role[] = ['leader', 'team_member', 'intern'] as Role[];

export function Overview() {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; people: Person[] }>({ status: 'loading' });
  const [compliance, setCompliance] = useState<EodComplianceSummary | null>(null);
  const [open, setOpen] = useState<Map<string, number>>(new Map());
  const [filed, setFiled] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [role, setRole] = useState<string>('');

  function load() {
    setState({ status: 'loading' });
    fetchPeople()
      .then((people) => setState({ status: 'ready', people }))
      .catch((err: unknown) => setState({ status: 'error', message: err instanceof Error ? err.message : 'Something went wrong.' }));
    fetchEodCompliance().then(setCompliance).catch(() => setCompliance(null));
    fetchEodLogs().then((logs) => setFiled(new Set(logs.map((l) => l.userId)))).catch(() => undefined);
    fetchAllTasks({})
      .then((tasks) => {
        const m = new Map<string, number>();
        for (const t of tasks) if (t.status !== 'done' && t.assignedToUserId) m.set(t.assignedToUserId, (m.get(t.assignedToUserId) ?? 0) + 1);
        setOpen(m);
      })
      .catch(() => undefined);
  }
  useEffect(load, []);

  const people = useMemo(() => (state.status === 'ready' ? state.people : []), [state]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return people
      .filter((p) => (!role || p.role === role) && (!s || [p.name, p.email, ROLE_LABELS[p.role]].some((x) => x?.toLowerCase().includes(s))))
      .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name));
  }, [people, q, role]);

  if (state.status === 'loading') return <LoadingState label="Loading people…" />;
  if (state.status === 'error') return <ErrorState title="Couldn't load people" description={state.message} onRetry={load} />;

  const counts = ROLE_ORDER.map((r) => ({ role: r, n: people.filter((p) => p.role === r).length }));
  const pct = compliance && compliance.expectedCount > 0 ? compliance.compliancePercent : null;

  return (
    <div className="nx-dashboard-overview nx-view-enter">
      <div className="nx-adminhome__stats">
        <div className="nx-adminhome__stat"><span className="nx-adminhome__n">{people.length}</span><span className="nx-adminhome__l">People</span></div>
        {counts.map((c) => (
          <button key={c.role} type="button" className="nx-adminhome__stat nx-hr__statbtn" onClick={() => setRole(role === c.role ? '' : c.role)} aria-pressed={role === c.role}>
            <span className="nx-adminhome__n">{c.n}</span>
            <span className="nx-adminhome__l">{ROLE_LABELS[c.role]}s</span>
          </button>
        ))}
        <Link className={`nx-adminhome__stat nx-adminhome__stat--${pct === null ? 'accent' : pct >= 80 ? 'green' : pct >= 50 ? 'amber' : 'red'}`} to="/people/attendance">
          <span className="nx-adminhome__n">{pct === null ? '—' : `${pct}%`}</span>
          <span className="nx-adminhome__l">EOD filed today{compliance ? ` · ${compliance.filedCount}/${compliance.expectedCount}` : ''}</span>
        </Link>
      </div>

      <Card className="nx-filterbar">
        <label className="nx-filterbar__search">
          <span>Search the team</span>
          <input className="nx-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, email or role…" />
        </label>
        <label>
          <span>Role</span>
          <select className="nx-select" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">Everyone</option>
            {ROLE_ORDER.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}s</option>)}
          </select>
        </label>
        <Link className="nx-qbtn nx-qbtn--add" style={{ height: 36, textDecoration: 'none' }} to="/settings/team">+ Invite</Link>
      </Card>

      {shown.length === 0 ? (
        <p className="nx-cell-dim">No one matches.</p>
      ) : (
        <div className="nx-hr">
          {shown.map((p) => {
            const n = open.get(p.id) ?? 0;
            return (
              <article key={p.id} className="nx-hr__card">
                <div className="nx-hr__top">
                  <Avatar name={p.name} src={p.avatarUrl} size="md" />
                  <div className="nx-hr__who">
                    <b>{p.name}</b>
                    <a className="nx-link" href={`mailto:${p.email}`}>{p.email}</a>
                  </div>
                </div>
                <div className="nx-hr__meta">
                  <Badge tone={p.role === 'leader' ? 'info' : p.role === 'intern' ? 'warning' : 'neutral'}>{ROLE_LABELS[p.role] ?? p.role}</Badge>
                  <span className="nx-tchip">{n} open task{n === 1 ? '' : 's'}</span>
                  <span className={'nx-tchip' + (filed.has(p.id) ? ' nx-hr__ok' : '')}>{filed.has(p.id) ? '✓ EOD in' : 'No EOD yet'}</span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
