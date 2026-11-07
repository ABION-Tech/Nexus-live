// Web-side chatService — wraps apps/api/src/routes/chat.ts (PRD §7.2 08
// AI Analyst > Chat). GET /chat now returns a cursor page
// (ChatMessagePage) rather than a flat array (Session 33/34 — WhatsApp-
// style scroll-up). POST /chat returns SendChatMessageResult directly,
// no wrapper key — matches routes/chat.ts's `reply.send(result)`.
//
// Session 35: every function here now takes an optional `taskId`,
// which switches the request to that task's own thread (task drawer +
// AI Analyst "My Tasks"/task-picker tabs) instead of the shared
// org-wide 'ai' thread. Kept as one extra optional param on the
// existing functions rather than a parallel set of taskChatService.ts
// functions — the request/response shapes are identical either way,
// only the server-side permission gate and channel differ (routes/
// chat.ts's own `authorizeTaskThread`).
import { apiClient, API_BASE } from './apiClient';
import type { ChatMessage, ChatMessagePage, SendChatMessageResult } from '@nexus/shared';

export function fetchChatMessages(opts: { before?: string; limit?: number; taskId?: string } = {}): Promise<ChatMessagePage> {
  const params = new URLSearchParams();
  if (opts.before) params.set('before', opts.before);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.taskId) params.set('taskId', opts.taskId);
  const qs = params.toString();
  return apiClient.get<ChatMessagePage>(`/chat${qs ? `?${qs}` : ''}`);
}

export function sendChatMessage(body: string, taskId?: string): Promise<SendChatMessageResult> {
  return apiClient.post<SendChatMessageResult>('/chat', taskId ? { body, taskId } : { body });
}

/** Leader-only (or explicit `chat`+`export` grant) full-thread download.
 * A plain browser navigation rather than a `fetch()` — the response is
 * `Content-Disposition: attachment`, so the browser handles the save
 * dialog itself; a `fetch()` would just hand back text this module
 * would then have to manually turn into a Blob + object URL for no
 * benefit. Cookies travel with a normal cross-origin navigation the
 * same as any other browser request, no `credentials` option needed
 * here the way apiClient.ts's `fetch()` calls require it.
 *
 * Org-wide thread only — task threads don't have their own export
 * route (the plan's export decision was scoped to the one shared AI
 * thread; a per-task export wasn't asked for). */
export function downloadChatExport(): void {
  window.open(`${API_BASE}/chat/export`, '_blank');
}

/** SSE connection for real-time delivery (Session 33; Session 35 added
 * `taskId` scoping). Returns a cleanup function; callers invoke it on
 * unmount. `withCredentials` is the EventSource equivalent of
 * apiClient.ts's `credentials: 'include'` — required for the httpOnly
 * session cookie to be sent cross-origin, same as every other request
 * in this app. */
export function connectChatStream(onMessage: (message: ChatMessage) => void, taskId?: string): () => void {
  const qs = taskId ? `?taskId=${encodeURIComponent(taskId)}` : '';
  const source = new EventSource(`${API_BASE}/chat/stream${qs}`, { withCredentials: true });
  source.addEventListener('message', (event) => {
    try {
      const message = JSON.parse((event as MessageEvent<string>).data) as ChatMessage;
      onMessage(message);
    } catch {
      // Malformed frame — same "skip and move on" posture as sseHub.ts's
      // own broadcast error handling; a browser-side EventSource
      // reconnects automatically on real connection loss regardless.
    }
  });
  return () => source.close();
}
