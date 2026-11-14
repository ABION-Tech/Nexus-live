import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { TaskSection } from './TaskSection';
import { Card } from '../../components/ui';
import { fetchAllTasks } from '../../services/taskService';
import { fetchPartnerships } from '../../services/networkService';
import { fetchPeople } from '../../services/peopleService';
import type { CurrentUser } from '../../services/authService';
import type { Partnership, Task } from '@nexus/shared';

// PRD §7.2 02 WORK → Follow-Ups. Session 58: rebuilt as the original HTML
// app's "Follow-Up Tracker": who is behind (open tasks with no update for
// 2+ days, per person), partnerships past their follow-up date, and every
// task that needs chasing — stale, blocked, overdue or due within 48h —
// with how many days it's gone without an update.
const STALE_MS = 2 * 86_400_000;

function needsFollowUp(t: Task): boolean {
  if (t.status === 'done') return false;
  if (t.status === 'blocked') return true;
  if (Date.now() - new Date(t.updatedAt).getTime() >= STALE_MS) return true;
  return !!t.deadline && new Date(t.deadline).getTime() - Date.now() < 48 * 3_600_000;
}

const fetchFollowUps = () =>
  fetchAllTasks({}).then((all) =>
    all.filter(needsFollowUp).sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())
  );

function TrackerPanels() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [partners, setPartners] = useState<Partnership[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    fetchAllTasks({}).then(setTasks).catch(() => undefined);
    fetchPartnerships({}).then(setPartners).catch(() => undefined);
    fetchPeople().then((p) => setNames(new Map(p.map((x) => [x.id, x.name])))).catch(() => undefined);
  }, []);

  const behind = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) {
      if (t.status === 'done' || !t.assignedToUserId) continue;
      if (Date.now() - new Date(t.updatedAt).getTime() >= STALE_MS) m.set(t.assignedToUserId, (m.get(t.assignedToUserId) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [tasks]);
  const unassignedStale = tasks.filter((t) => t.status !== 'done' && !t.assignedToUserId && Date.now() - new Date(t.updatedAt).getTime() >= STALE_MS).length;

  const today = new Date().toISOString().slice(0, 10);
  const pending = partners
    .filter((p) => p.currentStatus !== 'active' && p.currentStatus !== 'declined' && p.followUpDate && p.followUpDate.slice(0, 10) <= today)
    .sort((a, b) => (a.followUpDate ?? '').localeCompare(b.followUpDate ?? ''));

  return (
    <div className="nx-tracker">
      <Card>
        <h2 className="nx-adminhome__h2">Behind — 2+ days with no update</h2>
        {behind.length === 0 && unassignedStale === 0 ? (
          <p className="nx-cell-dim">Everyone's up to date.</p>
        ) : (
          <ul className="nx-tracker__list">
            {behind.map(([id, n]) => (
              <li key={id}>
                <b>{names.get(id) ?? 'Someone'}</b>
                <span className="nx-tchip nx-tchip--red">{n} task{n > 1 ? 's' : ''}</span>
              </li>
            ))}
            {unassignedStale > 0 && (
              <li>
                <b className="nx-cell-dim">Not assigned</b>
                <span className="nx-tchip">{unassignedStale} task{unassignedStale > 1 ? 's' : ''}</span>
              </li>
            )}
          </ul>
        )}
      </Card>
      <Card>
        <div className="nx-adminhome__feedhead">
          <h2 className="nx-adminhome__h2">Partnerships due for follow-up</h2>
          <Link className="nx-chipbtn" to="/network/partnerships">Open</Link>
        </div>
        {pending.length === 0 ? (
          <p className="nx-cell-dim">No partnership is past its follow-up date.</p>
        ) : (
          <ul className="nx-tracker__list">
            {pending.slice(0, 8).map((p) => (
              <li key={p.id}>
                <b>{p.organisation}</b>
                <span className="nx-cell-dim">{p.assignedToUserId ? names.get(p.assignedToUserId) ?? '' : 'Unassigned'}</span>
                <span className="nx-tchip nx-tchip--red">
                  {new Date(p.followUpDate!).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

export function FollowUps({ user }: { user: CurrentUser }) {
  return (
    <TaskSection
      title="Follow-Up Tracker"
      emptyTitle="Nothing needs a follow-up right now"
      newLabel="New task"
      user={user}
      fetchList={fetchFollowUps}
      header={<TrackerPanels />}
      showStale
    />
  );
}
