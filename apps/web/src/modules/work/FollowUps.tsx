import { TaskSection } from './TaskSection';
import { fetchBlockedTasks, fetchUpcomingDeadlines } from '../../services/analyticsService';
import type { CurrentUser } from '../../services/authService';
import type { Task } from '@nexus/shared';

// PRD §7.2 02 WORK → Follow-Ups. Not a new data source: reuses the same
// two task-based Failsafe categories Analytics already computes server-
// side (analyticsService.ts's getBlockedTasks / getUpcomingDeadlines,
// exposed at GET /analytics/failsafe/blocked and /deadlines) — "things
// that need a follow-up" is blocked tasks + tasks whose deadline has
// passed or is close, which is exactly what those two endpoints already
// return, scoped to the caller the same way /failsafe/* already is
// (full org for a `tasks.read` grant, own-record only otherwise). This
// view is the union of both lists, deduplicated by id (a task can be
// both blocked AND close to its deadline), rendered through the same
// TaskSection/CrudSection Work already uses for My Tasks/Team Tasks —
// so editing status or extending a deadline from here uses the exact
// same create/update/archive calls, not a second read-only code path.
function fetchFollowUps(): Promise<Task[]> {
  return Promise.all([fetchBlockedTasks(), fetchUpcomingDeadlines()]).then(([blocked, deadlines]) => {
    const byId = new Map<string, Task>();
    for (const task of [...blocked, ...deadlines]) byId.set(task.id, task);
    // Soonest/most-overdue deadline first; blocked tasks with no
    // deadline (not covered by /failsafe/deadlines) sort to the end
    // rather than the top, since there's no date to act on urgently.
    return Array.from(byId.values()).sort((a, b) => {
      if (!a.deadline && !b.deadline) return 0;
      if (!a.deadline) return 1;
      if (!b.deadline) return -1;
      return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
    });
  });
}

export function FollowUps({ user }: { user: CurrentUser }) {
  return (
    <TaskSection
      title="Follow-Ups"
      emptyTitle="Nothing needs a follow-up right now"
      newLabel="New task"
      user={user}
      fetchList={fetchFollowUps}
    />
  );
}
