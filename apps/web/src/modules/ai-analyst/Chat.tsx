import { useEffect, useState } from 'react';
import { Button, Select, Tabs, LoadingState, ErrorState, EmptyState, type TabItem } from '../../components/ui';
import { downloadChatExport } from '../../services/chatService';
import { fetchTasks } from '../../services/taskService';
import type { CurrentUser } from '../../services/authService';
import type { Task } from '@nexus/shared';
import { ChatThread } from './ChatThread';

// PRD §7.2 08 AI ANALYST → Chat. One shared, org-wide 'ai'-channel thread
// (chatService.ts's own scope note) plus, as of Session 35, a "My Tasks"
// tab that switches the same thread UI over to a per-task 'task'-channel
// thread — not a per-user DM either way, so every leader in the org sees
// the same 'ai' thread, and every person on a given task sees that
// task's own thread. Reports and Agent Handoff (the other two 08
// subsections) are still ComingSoon; this file is only the Chat third.
//
// The thread UI itself (SSE delivery, cursor pagination, date
// separators, composer) lives in ChatThread.tsx — extracted out of this
// file in the same Session 35 pass so TaskDrawer's embedded per-task
// thread isn't a second, hand-rolled copy of it.
const TABS: TabItem[] = [
  { key: 'all', label: 'All' },
  { key: 'my-tasks', label: 'My Tasks' },
];

type TaskListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; tasks: Task[] };

export function Chat({ user }: { user: CurrentUser }) {
  const [tab, setTab] = useState<'all' | 'my-tasks'>('all');
  const [taskList, setTaskList] = useState<TaskListState>({ status: 'loading' });
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // Lazy-loaded on first switch to "My Tasks" rather than alongside the
  // org-wide thread on mount — a caller who never opens the tab
  // shouldn't pay for a tasks round trip the "All" tab has no use for.
  function loadMyTasks() {
    setTaskList({ status: 'loading' });
    // involvingUserId — "assigned to me OR I'm support OR I'm supervisor"
    // (taskService.ts's own note on this param) — is the same visibility
    // rule TaskDrawer's thread access is gated on server-side
    // (authorizeTaskThread's canViewTaskThread), so this picker never
    // offers a task whose thread the caller can't actually open.
    fetchTasks({ involvingUserId: user.id })
      .then((tasks) => {
        setTaskList({ status: 'ready', tasks });
        setSelectedTaskId((prev) => prev ?? tasks[0]?.id ?? null);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setTaskList({ status: 'error', message });
      });
  }

  useEffect(() => {
    if (tab === 'my-tasks') {
      loadMyTasks();
    }
    // Only re-fetch on the my-tasks/all toggle, not on every render — a
    // task created/archived elsewhere while this tab is open will show
    // up next time the tab is (re)selected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const taskOptions =
    taskList.status === 'ready' ? taskList.tasks.map((t) => ({ value: t.id, label: t.title })) : [];

  return (
    <div className="nx-page nx-view-enter" style={{ height: '100%' }}>
      <div className="nx-row nx-row--between">
        <h2>Chat</h2>
        {/* Leaders bypass the permissions table entirely (rbac.ts), so
            this is a reliable enough client-side gate for the plan's
            "leaders only" export button without an extra round trip to
            check for an explicit chat.export grant — the same posture
            AutomationToggles.tsx takes for its own update control. Export
            is scoped to the shared org-wide thread only (chatService.ts's
            own note — no per-task export route), so it only makes sense
            on the "All" tab. */}
        {tab === 'all' && user.role === 'leader' && (
          <Button variant="ghost" onClick={downloadChatExport}>
            Export thread
          </Button>
        )}
      </div>

      <Tabs items={TABS} active={tab} onChange={(key) => setTab(key as 'all' | 'my-tasks')} />

      {tab === 'all' && <ChatThread user={user} />}

      {tab === 'my-tasks' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
          {taskList.status === 'loading' && <LoadingState label="Loading your tasks…" />}
          {taskList.status === 'error' && (
            <ErrorState title="Couldn't load your tasks" description={taskList.message} onRetry={loadMyTasks} />
          )}
          {taskList.status === 'ready' && taskList.tasks.length === 0 && (
            <EmptyState
              title="No tasks yet"
              description="Threads here are scoped to tasks you're assigned to, supporting, or supervising."
            />
          )}
          {taskList.status === 'ready' && taskList.tasks.length > 0 && (
            <>
              <Select
                aria-label="Task"
                value={selectedTaskId ?? ''}
                options={taskOptions}
                onChange={(e) => setSelectedTaskId(e.target.value)}
              />
              {selectedTaskId && (
                <ChatThread
                  key={selectedTaskId}
                  user={user}
                  taskId={selectedTaskId}
                  emptyTitle="No messages on this task yet"
                  emptyDescription="Only the assignee, support, and supervisor (or anyone with tasks.read) can see this thread."
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
