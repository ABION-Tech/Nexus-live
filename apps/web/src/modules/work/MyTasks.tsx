import { TaskSection } from './TaskSection';
import { fetchTasks } from '../../services/taskService';
import type { CurrentUser } from '../../services/authService';

// PRD §7.2 02 WORK → My Tasks. Explicitly filtered to the caller's own
// `assignedToUserId`, regardless of role — unlike Team Tasks, this is a
// real, deliberate filter even for a leader (who otherwise sees
// everything everywhere else). Matches PRD §8.2: "Personal filtered view
// of assigned tasks."
export function MyTasks({ user }: { user: CurrentUser }) {
  return (
    <TaskSection
      title="My Tasks"
      emptyTitle="Nothing assigned to you yet"
      newLabel="New task"
      user={user}
      fetchList={() => fetchTasks({ assignedToUserId: user.id })}
    />
  );
}
