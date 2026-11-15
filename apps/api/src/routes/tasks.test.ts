// Session 60 — PATCH /tasks/:id: what a person may change. The edit form
// sent the whole task (id, createdAt, ref …) and every save failed with a
// 500; recurrence and follow-up hours (0047) are validated here too.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const LEADER = { sessionId: 's1', userId: 'u-lead', orgId: 'o1', role: 'leader', name: 'Lead', email: 'lead@abion.test' };
const MEMBER = { sessionId: 's2', userId: 'u-mem', orgId: 'o1', role: 'team_member', name: 'Mem', email: 'mem@abion.test' };
const TASK = { id: 't1', orgId: 'o1', title: 'Deck', status: 'not_started', priority: 'medium', assignedToUserId: 'u-mem', createdAt: 'x', updatedAt: 'y', ref: 'T-1' };

vi.mock('../services/sessionService.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/sessionService.js');
  return { ...actual, verifySession: vi.fn(async (t: string) => (t === 'lead' ? LEADER : t === 'mem' ? MEMBER : null)) };
});
vi.mock('../plugins/rbac.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../plugins/rbac.js');
  return { ...actual, hasPermission: vi.fn(async (user: { role: string }) => user.role === 'leader') };
});
vi.mock('../services/taskService.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../services/taskService.js');
  return {
    ...actual,
    getTaskById: vi.fn(async (_o: string, id: string) => (id === 't1' ? TASK : null)),
    updateTask: vi.fn(async (_o: string, _id: string, input: Record<string, unknown>) => ({ ...TASK, ...input })),
    createTask: vi.fn(async (_o: string, input: Record<string, unknown>) => ({ ...TASK, ...input, id: 't2' })),
  };
});

import { updateTask, createTask } from '../services/taskService.js';

describe('Session 60 — task edits', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    process.env.COOKIE_SECRET = 'test-secret';
    const { buildServer } = await import('../server.js');
    app = buildServer({ logger: false });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    vi.clearAllMocks();
  });
  const patch = (who: string, payload: object) =>
    app.inject({ method: 'PATCH', url: '/api/v1/tasks/t1', cookies: { nexus_session: who }, payload });

  it('saving the whole task (as the edit form does) only sends editable fields on', async () => {
    const res = await patch('lead', { ...TASK, title: 'Deck v2', preBlockStatus: 'in_progress' });
    expect(res.statusCode).toBe(200);
    const sent = vi.mocked(updateTask).mock.calls[0]![2];
    expect(sent).toMatchObject({ title: 'Deck v2', status: 'not_started' });
    for (const k of ['id', 'orgId', 'createdAt', 'updatedAt', 'ref', 'preBlockStatus']) expect(sent).not.toHaveProperty(k);
  });

  it("a team member on their own task may change status and notes, nothing else", async () => {
    await patch('mem', { status: 'done', description: 'sent', title: 'renamed', recurrence: 'daily' });
    expect(vi.mocked(updateTask).mock.calls[0]![2]).toEqual({ status: 'done', description: 'sent' });
  });

  it('sets, validates and clears repeats and follow-up hours (C-11)', async () => {
    expect((await patch('lead', { recurrence: 'weekly', followUpHours: 24 })).statusCode).toBe(200);
    expect(vi.mocked(updateTask).mock.calls[0]![2]).toEqual({ recurrence: 'weekly', followUpHours: 24 });
    expect((await patch('lead', { recurrence: 'hourly' })).statusCode).toBe(400);
    expect((await patch('lead', { followUpHours: 0 })).statusCode).toBe(400);
    expect((await patch('lead', { followUpHours: 2.5 })).statusCode).toBe(400);
    expect((await patch('lead', { recurrence: null, followUpHours: null })).statusCode).toBe(200);
  });

  it('create validates the same fields', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/v1/tasks', cookies: { nexus_session: 'lead' }, payload: { title: 'x', recurrence: 'yearly' } });
    expect(bad.statusCode).toBe(400);
    expect(createTask).not.toHaveBeenCalled();
    const ok = await app.inject({ method: 'POST', url: '/api/v1/tasks', cookies: { nexus_session: 'lead' }, payload: { title: 'Standup notes', recurrence: 'weekdays' } });
    expect(ok.statusCode).toBe(201);
  });
});
