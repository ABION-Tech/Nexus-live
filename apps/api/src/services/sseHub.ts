// SSE fan-out hub for chat real-time delivery (PRD §7.2 08 / §8.11,
// Session 33). Chosen over WebSocket per the session plan: SSE is
// unidirectional (server → client), which is all chat needs here —
// clients still write via the existing `POST /chat`, they just don't
// poll for new messages anymore. Fastify supports this natively via
// `reply.hijack()` + `reply.raw` (a plain Node `ServerResponse`), no
// plugin or upgrade handshake required.
//
// Scale note (carried from the plan, not yet acted on): this map is
// single-process only. The moment a second API process exists, swap the
// `broadcast` body to publish on Redis instead of iterating this map —
// every subscriber's own connection stays exactly as it is, since each
// process would still hold its own local set of live `ServerResponse`
// objects and just needs to know when *another* process saw a new
// message. The public shape (subscribe/unsubscribe/broadcast) is
// designed so that swap doesn't touch routes/chat.ts at all.
import type { ServerResponse } from 'node:http';

// Session 35 — a connection now carries an optional `taskId` scope
// alongside its `ServerResponse`, not just an org. Without this, every
// org-wide subscriber (the AI Analyst "All" tab) would also receive
// every task-thread message fired by every open task drawer, and every
// task-thread subscriber would receive every other task's messages too
// — neither is a big security problem (both are already inside the same
// org, RLS's boundary), but it's wrong UX-wise: a thread should only
// ever see its own messages. `taskId: undefined` means "the org-wide 'ai'
// channel" — the Session 33 behavior, preserved as the default case.
interface Subscriber {
  res: ServerResponse;
  taskId?: string;
}

const connectionsByOrg = new Map<string, Set<Subscriber>>();

/** Registers a live connection for `orgId`, optionally scoped to a
 * single task's thread, and returns an unsubscribe function. Callers
 * (routes/chat.ts) call the returned function on `req.raw`'s `close`
 * event — the only reliable signal in Node's http module that a client
 * actually went away (browser tab closed, network drop, client-side
 * EventSource.close()). */
export function subscribeToChatStream(orgId: string, res: ServerResponse, taskId?: string): () => void {
  let set = connectionsByOrg.get(orgId);
  if (!set) {
    set = new Set();
    connectionsByOrg.set(orgId, set);
  }
  const subscriber: Subscriber = { res, taskId };
  set.add(subscriber);

  return () => {
    set!.delete(subscriber);
    if (set!.size === 0) connectionsByOrg.delete(orgId);
  };
}

/** Writes one SSE frame to every live connection for `orgId` whose scope
 * matches the message: org-wide ('ai' channel, no `taskId` on the
 * message) subscribers only get messages with no `taskId`; a
 * task-thread subscriber only gets messages carrying that same
 * `taskId`. A dead connection that hasn't fired `close` yet (rare, but
 * sockets can linger in TIME_WAIT-adjacent states) fails its `write()`
 * silently rather than throwing across the whole fan-out — one
 * slow/dead subscriber must never block or crash delivery to the rest. */
export function broadcastChatMessage(orgId: string, event: 'message', message: unknown): void {
  const set = connectionsByOrg.get(orgId);
  if (!set || set.size === 0) return;
  const messageTaskId = (message as { taskId?: string } | null)?.taskId;
  const frame = `event: ${event}\ndata: ${JSON.stringify(message)}\n\n`;
  for (const subscriber of set) {
    if (subscriber.taskId !== messageTaskId) continue;
    try {
      subscriber.res.write(frame);
    } catch {
      // Swallow — the connection's own `close` handler (registered by
      // the route) is what actually removes it from the set. A write
      // failure here just means this particular frame was missed; the
      // client's next reconnect (or its own GET /chat?before= catch-up)
      // fills the gap, same as any other SSE consumer's expected
      // reconnect behavior.
    }
  }
}

/** Test/diagnostic helper — not used by any route. */
export function chatStreamConnectionCount(orgId: string): number {
  return connectionsByOrg.get(orgId)?.size ?? 0;
}
