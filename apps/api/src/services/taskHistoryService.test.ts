// Session 60 (C-12) — turning activity_log's one-row-per-column into
// readable history entries.
import { describe, expect, it } from 'vitest';
import { groupHistory } from './taskHistoryService.js';

const t1 = new Date('2026-11-15T10:00:00Z');
const t2 = new Date('2026-11-15T11:00:00Z');
const row = (at: Date, field: string | null, oldValue: string | null, newValue: string | null, actor: string | null = 'u1') => ({
  changed_at: at, actor_user_id: actor, actor_name: actor ? 'Ayo' : null, field, old_value: oldValue, new_value: newValue,
});

describe('groupHistory', () => {
  it('one change to several fields becomes one entry, before → after', () => {
    const [e] = groupHistory([row(t2, 'status', 'not_started', 'done'), row(t2, 'priority', 'medium', 'high')]);
    expect(e).toMatchObject({ action: 'task.updated', userName: 'Ayo', previous: { status: 'not_started', priority: 'medium' }, next: { status: 'done', priority: 'high' } });
  });

  it('separate changes stay separate', () => {
    expect(groupHistory([row(t2, 'status', 'in_progress', 'done'), row(t1, 'status', 'not_started', 'in_progress')])).toHaveLength(2);
  });

  it('created, archived and people changes read as their own events', () => {
    const out = groupHistory([
      row(t2, 'archived_at', null, '2026-11-15T11:00:00Z'),
      row(t1, 'people:support', null, 'u9'),
      row(t1, null, null, 'created'),
    ]);
    expect(out.map((e) => e.action)).toEqual(['task.archived', 'task.assignee_added', 'task.created']);
    expect(out[1]!.next).toEqual({ userId: 'u9', role: 'support' });
  });

  it('column names become the field names the app uses; bookkeeping is hidden', () => {
    const [e] = groupHistory([row(t2, 'assigned_to_user_id', null, 'u2'), row(t2, 'pre_block_status', null, 'in_progress')]);
    expect(e!.next).toEqual({ assignedToUserId: 'u2' });
  });

  it('automation changes have no person', () => {
    const [e] = groupHistory([row(t2, 'status', 'in_progress', 'blocked', null)]);
    expect(e!.userName).toBeUndefined();
  });
});
