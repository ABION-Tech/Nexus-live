import { TaskSection } from './TaskSection';
import { fetchTasks } from '../../services/taskService';
import type { CurrentUser } from '../../services/authService';

// PRD §7.2 02 WORK → Completed. Same TaskSection/CrudSection every other
// Work view uses, just pre-filtered to status=done server-side (GET
// /tasks?status=done — tasks.ts's existing list route, no new endpoint
// needed). Not scoped to "my" vs "team" the way My Tasks/Team Tasks are:
// the API's own tasks.read-vs-own-record fallback (same one Team Tasks
// relies on) already narrows this to the caller's own completed tasks
// when they don't have a general tasks.read grant, so this component
// doesn't need to branch on it either.
export function Completed({ user }: { user: CurrentUser }) {
  return (
    <TaskSection
      title="Completed"
      emptyTitle="No completed tasks yet"
      newLabel="New task"
      user={user}
      fetchList={() => fetchTasks({ status: 'done' })}
    />
  );
}
