// Tier 4 (PRD §6.3) — apps/web's APIService. httpOnly session cookie
// (PRD §13.2) → `credentials: 'include'` is load bearing, not a default
// left in place. API_BASE is also exported directly (not just used
// internally) so authService.ts's Google sign-in link can point at
// `${API_BASE}/auth/google/start` — that's a full browser navigation to
// start the OAuth redirect flow (routes/auth.ts), not a fetch() call, so
// it can't go through `request()` below.
import { enqueueWrite } from './offlineQueue';

export const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3001/api/v1';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// PRD §15 Phase J offline write queue. Thrown by `postQueueable` instead
// of a real ApiError/network error when a write got queued rather than
// sent — callers that opt into queueing (taskService.ts's createTask,
// eodService.ts's submitEodLog) catch this specifically and show "saved
// offline, will sync" messaging instead of treating it as a failure.
// Anything that doesn't catch it will still fail loudly (it's an Error,
// `.message` is a real user-facing sentence) rather than silently doing
// nothing, which matters for any future caller of `postQueueable` that
// forgets to add the special case.
export class QueuedOfflineError extends Error {
  constructor(public queueId: string) {
    super("Saved offline — it'll sync automatically once you're back online.");
    this.name = 'QueuedOfflineError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });

  if (!res.ok) {
    // server.ts's error handler (PRD §13.4) always sends {error, message}
    // JSON, even for 500s — safe to assume shape, but still guard the
    // parse in case something upstream (a proxy, a network failure) hands
    // back a non-JSON body instead.
    let body: { error?: string; message?: string } = {};
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body — fall through to the generic message below */
    }
    throw new ApiError(res.status, body.error ?? 'error', body.message ?? 'Request failed.');
  }

  // 204 No Content (routes/invites.ts, routes/permissions.ts's revoke) has
  // no body at all — `res.json()` throws a SyntaxError on it rather than
  // returning anything sensible. Every other response in this app is a
  // real JSON body, so this is a targeted guard for the empty case, not a
  // general "maybe there's no body" fallback masking a real parse error.
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const apiClient = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/** Re-sends a queued write exactly as it was originally made — used only
 * by offlineQueue.ts's `drainQueue`, via `replayQueuedWrite` below, never
 * called directly by a service. Left as a plain `request` call (not
 * routed back through `postQueueable`) so a still-offline replay attempt
 * throws its normal network error straight to `drainQueue` instead of
 * re-queueing a write that's already in the queue. */
function replay<T>(write: { method: 'POST' | 'PATCH' | 'PUT'; path: string; body: unknown }): Promise<T> {
  return request<T>(write.path, { method: write.method, body: JSON.stringify(write.body) });
}

// Imported by offlineQueue.ts's `online` listener and by App.tsx's
// initial drain-on-mount — see offlineQueue.ts's own comment on why the
// resulting apiClient.ts ↔ offlineQueue.ts circular import is safe here
// (both sides only touch the other's export from inside a function
// body, never at module-evaluation time).
export function replayQueuedWrite(write: { method: 'POST' | 'PATCH' | 'PUT'; path: string; body: unknown }): Promise<unknown> {
  return replay(write);
}

/** Like `apiClient.post`, but for writes PRD §15's offline queue covers:
 * if the browser is already known offline, or the POST fails with a
 * genuine network-level error (not a real server rejection — see
 * `ApiError` check below), the write is queued in IndexedDB instead of
 * failing, and this throws `QueuedOfflineError` so the caller can tell
 * the difference. A real server rejection (validation failure, 403,
 * etc.) is rethrown unchanged — only a connectivity problem should ever
 * result in a write landing in the queue. `kind` is a short human label
 * (e.g. 'Task', 'EOD report') stored alongside the queued write for any
 * future "pending sync" UI; it plays no role in the retry logic itself. */
export async function postQueueable<T>(path: string, body: unknown, kind: string): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const queueId = await enqueueWrite({ method: 'POST', path, body, kind });
    throw new QueuedOfflineError(queueId);
  }

  try {
    return await request<T>(path, { method: 'POST', body: JSON.stringify(body) });
  } catch (err) {
    if (err instanceof ApiError) throw err; // a real server response — not a connectivity problem, don't queue it
    const queueId = await enqueueWrite({ method: 'POST', path, body, kind });
    throw new QueuedOfflineError(queueId);
  }
}
