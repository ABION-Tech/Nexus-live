import { TaskSection } from './TaskSection';
import { fetchTasks } from '../../services/taskService';
import type { CurrentUser } from '../../services/authService';

// PRD §7.2 02 WORK → Team Tasks (Master Tasks). No filter applied here —
// the API itself decides what "unfiltered" actually returns per caller
// (routes/tasks.ts: full org list for a `tasks.read` grant, silently
// narrowed to the caller's own assignments otherwise, per PRD §13.3's
// `tasks.own` example grant). This component doesn't need to know which
// case applies; that's exactly the point of the server enforcing it
// rather than the UI branching on role.
export function TeamTasks({ user }: { user: CurrentUser }) {
  return (
    <TaskSection
      title="Team Tasks"
      emptyTitle="No tasks yet"
      newLabel="New task"
      user={user}
      fetchList={() => fetchTasks({})}
    />
  );
}
