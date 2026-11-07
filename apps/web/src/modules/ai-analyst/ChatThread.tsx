import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Card, Button, Avatar, LoadingState, ErrorState, EmptyState, useToast } from '../../components/ui';
import { connectChatStream, fetchChatMessages, sendChatMessage } from '../../services/chatService';
import type { CurrentUser } from '../../services/authService';
import type { ChatMessage } from '@nexus/shared';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready' };

const AI_NAME = 'NEXUS AI';

export interface ChatThreadProps {
  user: CurrentUser;
  /** Switches this thread to a task's own 'task' channel (chatService.ts's
   * own taskId param) instead of the shared org-wide 'ai' channel. Task
   * threads get no AI auto-reply (services/chatService.ts's `sendChatMessage`
   * returns early on a taskId), so `aiEnabled` below is derived from this
   * rather than passed separately — there's nothing for a caller to
   * meaningfully override. */
  taskId?: string;
  /** Resolves an authorUserId to a display name (e.g. TaskDrawer's
   * peopleById). Without it, another person's message just reads
   * "A teammate" — fine for the org-wide thread where that's the existing,
   * deliberate convention, but a task thread has a small, known cast
   * (assignee/support/supervisor) worth naming. */
  resolveName?: (authorUserId: string) => string | undefined;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Tighter padding/height for embedding inside TaskDrawer's fixed-width
   * panel, vs. the full-page Card the AI Analyst > Chat route renders. */
  compact?: boolean;
}

// PRD §7.2 08 AI ANALYST → Chat's thread UI (SSE delivery, cursor "Load
// earlier" pagination, WhatsApp-style date separators), extracted out of
// Chat.tsx in the Session 35 frontend pass so TaskDrawer's embedded
// per-task thread doesn't hand-roll a second, unstyled copy of the same
// message list. `taskId` is the only thing that changes which channel
// this reads/writes/subscribes to (chatService.ts) — everything else
// (scroll handling, de-dupe, date grouping) is channel-agnostic.
export function ChatThread({ user, taskId, resolveName, emptyTitle, emptyDescription, compact = false }: ChatThreadProps) {
  const { show } = useToast();
  const aiEnabled = !taskId;
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Session 7 — AI chat cross-referencing. Set only for the AI messages
  // this tab itself just received a `crossReferenced: true` response
  // for (SendChatMessageResult, never persisted on ChatMessage/the DB
  // row — see its own doc comment in @nexus/shared) — a page reload or
  // another tab's SSE-delivered copy of the same message has no way to
  // know, and doesn't need to; this is purely "did *this* reply just
  // use live org data" feedback for the person who sent it.
  const [crossReferencedIds, setCrossReferencedIds] = useState<Set<string>>(new Set());

  // Distinguishes "a new message arrived, scroll to bottom" from "the
  // user just clicked Load earlier, preserve their scroll position" —
  // both mutate `messages` and would otherwise trigger the same effect.
  const scrollIntentRef = useRef<'bottom' | 'preserve'>('bottom');
  const prevScrollHeightRef = useRef(0);

  function loadInitial() {
    setLoad({ status: 'loading' });
    fetchChatMessages({ taskId })
      .then((page) => {
        scrollIntentRef.current = 'bottom';
        setMessages(page.messages);
        setHasMore(page.hasMore);
        setLoad({ status: 'ready' });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Something went wrong.';
        setLoad({ status: 'error', message });
      });
  }

  // Re-loads (and re-subscribes below) whenever the caller switches
  // threads — the task picker in Chat.tsx's "My Tasks" tab and a drawer
  // reopening on a different task both change `taskId` without this
  // component unmounting.
  useEffect(loadInitial, [taskId]);

  useEffect(() => {
    return connectChatStream((incoming) => {
      setMessages((prev) => {
        // De-dupe: the sender's own tab already appended this message
        // from POST /chat's own response — every *other* tab/session
        // sees it for the first time here.
        if (prev.some((m) => m.id === incoming.id)) return prev;
        scrollIntentRef.current = 'bottom';
        return [...prev, incoming];
      });
    }, taskId);
  }, [taskId]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (scrollIntentRef.current === 'preserve') {
      el.scrollTop = el.scrollHeight - prevScrollHeightRef.current + el.scrollTop;
    } else {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [messages]);

  async function handleLoadEarlier() {
    if (loadingMore || messages.length === 0) return;
    setLoadingMore(true);
    const el = scrollRef.current;
    prevScrollHeightRef.current = el?.scrollHeight ?? 0;
    try {
      const page = await fetchChatMessages({ before: messages[0]!.id, taskId });
      scrollIntentRef.current = 'preserve';
      setMessages((prev) => [...page.messages, ...prev]);
      setHasMore(page.hasMore);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Couldn't load earlier messages.";
      show(message, 'danger');
    } finally {
      setLoadingMore(false);
    }
  }

  async function handleSend() {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setDraft('');
    try {
      const result = await sendChatMessage(body, taskId);
      scrollIntentRef.current = 'bottom';
      setMessages((prev) => [...prev, result.userMessage, ...(result.aiMessage ? [result.aiMessage] : [])]);
      if (result.crossReferenced && result.aiMessage) {
        const aiMessageId = result.aiMessage.id;
        setCrossReferencedIds((prev) => new Set(prev).add(aiMessageId));
      }
      if (result.aiError) {
        show(`${AI_NAME} didn't reply: ${result.aiError}`, 'danger');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Message failed to send.';
      show(message, 'danger');
      setDraft(body); // give the text back so it isn't lost on failure
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function nameFor(authorUserId: string | undefined, isSelf: boolean): string {
    if (!authorUserId) return AI_NAME;
    if (isSelf) return 'You';
    return resolveName?.(authorUserId) ?? 'A teammate';
  }

  if (load.status === 'loading') return <LoadingState label="Loading conversation…" />;
  if (load.status === 'error') {
    return <ErrorState title="Couldn't load the conversation" description={load.message} onRetry={loadInitial} />;
  }

  return (
    <Card style={{ display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: compact ? 12 : 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          minHeight: compact ? 200 : 320,
          maxHeight: compact ? 360 : '60vh',
        }}
      >
        {messages.length === 0 && (
          <EmptyState
            title={emptyTitle ?? (aiEnabled ? 'Ask NEXUS AI anything' : 'No messages yet')}
            description={
              emptyDescription ?? (aiEnabled ? 'This is a shared conversation — every leader in your org sees the same thread.' : undefined)
            }
          />
        )}

        {hasMore && messages.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <Button variant="ghost" onClick={handleLoadEarlier} disabled={loadingMore}>
              {loadingMore ? 'Loading…' : 'Load earlier'}
            </Button>
          </div>
        )}

        {messages.map((msg, i) => {
          const isSelf = msg.authorUserId === user.id;
          const isAi = !msg.authorUserId;
          const name = nameFor(msg.authorUserId, isSelf);
          const prev = messages[i - 1];
          const showDateSeparator = !prev || !isSameDay(prev.createdAt, msg.createdAt);
          return (
            <div key={msg.id} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {showDateSeparator && <DateSeparator iso={msg.createdAt} />}
              <div style={{ display: 'flex', gap: 10, flexDirection: isSelf ? 'row-reverse' : 'row' }}>
                <Avatar name={name} size="sm" />
                <div style={{ maxWidth: '78%', display: 'flex', flexDirection: 'column', gap: 4, alignItems: isSelf ? 'flex-end' : 'flex-start' }}>
                  <span style={{ fontSize: 12, opacity: 0.7 }}>
                    {name} · {new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <div
                    style={{
                      padding: '8px 12px',
                      borderRadius: 12,
                      background: isSelf ? 'var(--accent)' : isAi ? 'var(--surface-raised)' : 'var(--surface)',
                      color: isSelf ? '#fff' : 'var(--text)',
                      border: isSelf ? 'none' : '1px solid var(--border-strong)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {msg.body}
                  </div>
                  {isAi && crossReferencedIds.has(msg.id) && (
                    <span style={{ fontSize: 11, opacity: 0.6 }}>Answered using your org's live task/goal data</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {sending && aiEnabled && (
          <div style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 8 }}>
            {/* nx-loader-dots instead of nx-spinner — a chat "thinking"
                moment reads more naturally as the three-dot idiom every
                chat product uses than a generic spinner (this was its
                first real usage anywhere in the app). */}
            <div className="nx-loader-dots" style={{ padding: 0 }}>
              <span className="nx-loader-dots__dot" />
              <span className="nx-loader-dots__dot" />
              <span className="nx-loader-dots__dot" />
            </div>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{AI_NAME} is thinking…</span>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, padding: compact ? 10 : 12, borderTop: '1px solid var(--border)' }}>
        <textarea
          className="nx-input"
          placeholder={aiEnabled ? 'Message NEXUS AI…' : 'Add a message…'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={sending}
          rows={compact ? 2 : 2}
          style={{ flex: 1, resize: 'none' }}
        />
        <Button onClick={handleSend} disabled={sending || !draft.trim()}>
          Send
        </Button>
      </div>
    </Card>
  );
}

function isSameDay(aIso: string, bIso: string): boolean {
  const a = new Date(aIso);
  const b = new Date(bIso);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function DateSeparator({ iso }: { iso: string }) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  let label: string;
  if (isSameDay(iso, today.toISOString())) {
    label = 'Today';
  } else if (isSameDay(iso, yesterday.toISOString())) {
    label = 'Yesterday';
  } else {
    label = date.toLocaleDateString([], {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
    });
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0' }}>
      <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
      <span style={{ fontSize: 12, opacity: 0.6, whiteSpace: 'nowrap' }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
    </div>
  );
}
