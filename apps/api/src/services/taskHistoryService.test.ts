// Session 60 (C-12) — which changes make it into a task's history.
import { describe, expect, it } from 'vitest';
import { diffTask } from './taskHistoryService.js';
import type { Task } from '@nexus/shared';

const base = { id: 't', orgId: 'o', title: 'Deck', status: 'not_started', priority: 'medium', createdAt: '', updatedAt: '' } as Task;

describe('diffTask', () => {
  it('records only the fields that changed, before and after', () => {
    expect(diffTask(base, { ...base, status: 'done', priority: 'high' })).toEqual({
      previous: { status: 'not_started', priority: 'medium' },
      next: { status: 'done', priority: 'high' },
    });
  });

  it('nothing changed → nothing to record', () => {
    expect(diffTask(base, { ...base, updatedAt: 'later' })).toBeNull();
  });

  it('treats empty, missing and null as the same (no phantom changes)', () => {
    expect(diffTask({ ...base, description: '' }, { ...base, description: undefined })).toBeNull();
  });

  it('a new task lists what it was created with', () => {
    expect(diffTask({}, { ...base, deadline: '2026-11-20T16:00:00.000Z' })?.next).toMatchObject({ title: 'Deck', deadline: '2026-11-20T16:00:00.000Z' });
  });

  it('ignores fields people do not edit (ids, timestamps, counts)', () => {
    expect(diffTask(base, { ...base, checklistDone: 3, ref: 'T-9' } as Task)).toBeNull();
  });
});
