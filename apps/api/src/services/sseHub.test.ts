// Session 33 — sseHub.ts unit tests. Exercises subscribe/broadcast/
// unsubscribe directly against fake `ServerResponse`-shaped objects
// rather than a real HTTP connection (route-level SSE behavior is
// exercised via chat.test.ts's 403/permission-gating cases only — a
// live, never-ending stream connection isn't something `app.inject` can
// cleanly assert against; this file covers the actual fan-out logic
// under test, real HTTP framing included).
import { describe, expect, it } from 'vitest';
import { broadcastChatMessage, chatStreamConnectionCount, subscribeToChatStream } from './sseHub.js';

function fakeResponse() {
  const writes: string[] = [];
  return {
    writes,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  } as unknown as import('node:http').ServerResponse;
}

describe('sseHub', () => {
  it('delivers a broadcast to every subscriber of the same org, correctly framed', () => {
    const a = fakeResponse();
    const b = fakeResponse();
    subscribeToChatStream('org-1', a);
    subscribeToChatStream('org-1', b);

    broadcastChatMessage('org-1', 'message', { id: 'msg-1', body: 'hello' });

    const expected = `event: message\ndata: ${JSON.stringify({ id: 'msg-1', body: 'hello' })}\n\n`;
    expect((a as unknown as { writes: string[] }).writes).toEqual([expected]);
    expect((b as unknown as { writes: string[] }).writes).toEqual([expected]);
  });

  it('never delivers across orgs (tenant isolation, PRD §13.5)', () => {
    const a = fakeResponse();
    subscribeToChatStream('org-1', a);

    broadcastChatMessage('org-2', 'message', { id: 'msg-2' });

    expect((a as unknown as { writes: string[] }).writes).toEqual([]);
  });

  it('stops delivering after unsubscribe, and cleans up an emptied org', () => {
    const a = fakeResponse();
    const unsubscribe = subscribeToChatStream('org-3', a);
    expect(chatStreamConnectionCount('org-3')).toBe(1);

    unsubscribe();
    expect(chatStreamConnectionCount('org-3')).toBe(0);

    broadcastChatMessage('org-3', 'message', { id: 'msg-3' });
    expect((a as unknown as { writes: string[] }).writes).toEqual([]);
  });

  it('a broadcast to an org with no subscribers is a silent no-op', () => {
    expect(() => broadcastChatMessage('org-nobody', 'message', { id: 'x' })).not.toThrow();
  });

  // Session 35 — task-thread scoping. Org-wide ('ai' channel) and
  // task-thread subscribers now share the same per-org Set, so a
  // broadcast has to route to the right slice of it.
  it('only delivers a task-scoped message to subscribers of that same taskId', () => {
    const orgWide = fakeResponse();
    const taskA = fakeResponse();
    const taskB = fakeResponse();
    subscribeToChatStream('org-5', orgWide); // no taskId → org-wide 'ai' scope
    subscribeToChatStream('org-5', taskA, 'task-a');
    subscribeToChatStream('org-5', taskB, 'task-b');

    broadcastChatMessage('org-5', 'message', { id: 'msg-1', taskId: 'task-a' });

    expect((taskA as unknown as { writes: string[] }).writes).toHaveLength(1);
    expect((taskB as unknown as { writes: string[] }).writes).toHaveLength(0);
    expect((orgWide as unknown as { writes: string[] }).writes).toHaveLength(0);
  });

  it("doesn't leak a taskless (org-wide 'ai') broadcast into a task-thread subscriber", () => {
    const orgWide = fakeResponse();
    const task = fakeResponse();
    subscribeToChatStream('org-6', orgWide);
    subscribeToChatStream('org-6', task, 'task-c');

    broadcastChatMessage('org-6', 'message', { id: 'msg-2' }); // no taskId → 'ai' channel

    expect((orgWide as unknown as { writes: string[] }).writes).toHaveLength(1);
    expect((task as unknown as { writes: string[] }).writes).toHaveLength(0);
  });

  it("one subscriber's write failure doesn't block delivery to the rest", () => {
    const broken = {
      write: () => {
        throw new Error('socket hang up');
      },
    } as unknown as import('node:http').ServerResponse;
    const healthy = fakeResponse();
    subscribeToChatStream('org-4', broken);
    subscribeToChatStream('org-4', healthy);

    expect(() => broadcastChatMessage('org-4', 'message', { id: 'msg-4' })).not.toThrow();
    expect((healthy as unknown as { writes: string[] }).writes).toHaveLength(1);
  });
});
