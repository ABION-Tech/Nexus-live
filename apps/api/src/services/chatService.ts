// Chat — backs AI Analyst > Chat (PRD §7.2 08). Table is 0009's
// chat_messages (PRD §8.11), which models three channels — task-scoped
// threads, team-wide, and AI — but this file only ever writes/reads the
// 'ai' channel: it's the only one with a page in the IA today. Treated
// as one shared, org-wide thread (task_id always null here), not a
// per-user DM — the table has no recipient/participant column, only
// org_id + channel, so a shared thread per org is the shape the schema
// actually supports.
import { withOrgContext } from '../db.js';
import type { ChatMessage, ChatMessagePage, SendChatMessageResult } from '@nexus/shared';
import { getAIService, type ChatHistoryTurn } from './aiService.js';
import { buildChatCrossReferenceContext } from './chatContextService.js';
import { broadcastChatMessage } from './sseHub.js';

interface ChatMessageRow {
  id: string;
  org_id: string;
  channel: 'task' | 'team' | 'ai';
  task_id: string | null;
  author_user_id: string | null;
  body: string;
  created_at: Date;
}

function toChatMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    orgId: row.org_id,
    channel: row.channel,
    taskId: row.task_id ?? undefined,
    authorUserId: row.author_user_id ?? undefined,
    body: row.body,
    createdAt: row.created_at.toISOString(),
  };
}

// How many prior turns to hand the AI as context. Not the full thread —
// an org's AI channel accumulates indefinitely, and every extra turn is
// tokens spent on every single future reply. 20 is generous for a chat
// UI (most exchanges are a handful of turns) without the prompt growing
// unbounded as the thread ages.
const HISTORY_LIMIT = 20;

async function listRecentMessages(orgId: string, limit: number): Promise<ChatMessage[]> {
  return withOrgContext(orgId, async (client) => {
    // Fetch newest-first (so LIMIT actually caps to the most recent N),
    // then reverse in JS back to chronological order — same trick
    // needed anywhere "last N, oldest first" is wanted from a
    // created_at-indexed table.
    const { rows } = await client.query<ChatMessageRow>(
      `select * from chat_messages where org_id = $1 and channel = 'ai' order by created_at desc limit $2`,
      [orgId, limit]
    );
    return rows.map(toChatMessage).reverse();
  });
}

/** GET /chat. No pagination yet — same MVP scope as every other list
 * route in this codebase (fetchGoals, fetchTasks) — capped at
 * HISTORY_LIMIT purely to bound the page's initial load, same number the
 * AI itself gets as context so the UI never shows the user a message the
 * AI's next reply can't already see. */
export async function listChatMessages(orgId: string): Promise<ChatMessage[]> {
  return listRecentMessages(orgId, HISTORY_LIMIT);
}

// PRD §13.4 pagination enforcement — no `?limit=999999`. 200 mirrors
// automationService.ts's own log cap; there's no PRD-specified number
// for chat, so it's kept consistent with the one other cursor-style cap
// already in this codebase rather than inventing a new constant.
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

/** GET /chat with WhatsApp-style scroll-up (Session 33/34). Same table,
 * same 'ai' channel as listChatMessages above, but cursor-driven instead
 * of a flat "last N": `before`, when given, is a message *id* rather
 * than a timestamp. `created_at` has no uniqueness guarantee — two
 * messages can land in the same millisecond — so cursoring on id (via a
 * subquery back to that row's own created_at) avoids the classic
 * skipped-or-duplicated-row bug a raw `created_at < :ts` cursor has at
 * a page boundary shared by same-millisecond rows.
 *
 * No artificial history cap for new members: RLS already scopes every
 * row to `org_id`, and there's no date filter anywhere in this query —
 * a member who joins today can page all the way back to message one,
 * per the plan's own "new members get full history from day 1" call. */
export async function listChatMessagesPage(
  orgId: string,
  opts: { before?: string; limit?: number; taskId?: string } = {}
): Promise<ChatMessagePage> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);

  return withOrgContext(orgId, async (client) => {
    const params: unknown[] = [orgId];
    let cursorClause = '';
    if (opts.before) {
      params.push(opts.before);
      cursorClause = `and created_at < (select created_at from chat_messages where id = $${params.length} and org_id = $1)`;
    }
    // Session 35 — a taskId switches this from the shared 'ai' channel
    // to that task's own 'task' thread. Two different columns
    // (`channel` + `task_id`) rather than overloading `channel` alone:
    // every task thread shares the literal channel value 'task', it's
    // task_id that actually distinguishes one thread from another.
    const channelClause = opts.taskId
      ? (params.push(opts.taskId), `channel = 'task' and task_id = $${params.length}`)
      : `channel = 'ai'`;
    // Fetch one extra row beyond `limit` purely to answer "is there
    // more?" without a second COUNT(*) query — sliced back off below
    // before returning.
    params.push(limit + 1);
    const { rows } = await client.query<ChatMessageRow>(
      `select * from chat_messages
        where org_id = $1 and ${channelClause} ${cursorClause}
        order by created_at desc
        limit $${params.length}`,
      params
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse(); // chronological, same convention as listRecentMessages
    return { messages: page.map(toChatMessage), hasMore };
  });
}

/** GET /chat/export (Session 34). Full thread, no HISTORY_LIMIT/page cap
 * — export exists specifically so a leader can get *everything*, not
 * the same bounded page the live UI shows. Plain text, one line per
 * message, oldest-first (natural reading order for a document someone
 * downloads to read top-to-bottom, unlike the UI's newest-at-bottom
 * scroll convention). Names resolved via a join rather than a second
 * round trip through peopleService.listOrgPeople — this is the only
 * place in the chat path that needs a human-readable name instead of a
 * bare user_id, so it's kept local instead of promoting a shared helper
 * for one caller. */
export async function exportChatThread(orgId: string): Promise<string> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<{ created_at: Date; author_name: string | null; body: string }>(
      `select cm.created_at, u.name as author_name, cm.body
         from chat_messages cm
         left join users u on u.id = cm.author_user_id
        where cm.org_id = $1 and cm.channel = 'ai'
        order by cm.created_at asc`,
      [orgId]
    );
    if (rows.length === 0) return '(no messages yet)';
    return rows
      .map((row) => `[${row.created_at.toISOString()}] ${row.author_name ?? 'NEXUS AI'}: ${row.body}`)
      .join('\n');
  });
}

async function insertMessage(
  orgId: string,
  authorUserId: string | null,
  body: string,
  taskId?: string
): Promise<ChatMessage> {
  const message = await withOrgContext(orgId, async (client) => {
    const { rows } = taskId
      ? await client.query<ChatMessageRow>(
          `insert into chat_messages (org_id, channel, task_id, author_user_id, body) values ($1, 'task', $2, $3, $4) returning *`,
          [orgId, taskId, authorUserId, body]
        )
      : await client.query<ChatMessageRow>(
          `insert into chat_messages (org_id, channel, author_user_id, body) values ($1, 'ai', $2, $3) returning *`,
          [orgId, authorUserId, body]
        );
    return toChatMessage(rows[0]!);
  });
  // Fan out only after withOrgContext's COMMIT has actually returned —
  // broadcasting from inside the still-open transaction would let a
  // subscriber receive (and possibly re-query) a row that isn't durably
  // committed yet. Fired from inside insertMessage — the one function
  // every write path (user message, AI reply) already funnels through —
  // rather than from sendChatMessage, so no future caller of
  // insertMessage can accidentally skip the broadcast. The sender's own
  // tab already has this message from POST /chat's response; it's on
  // the client (Chat.tsx) to de-dupe by id, same as any SSE consumer
  // that also gets an optimistic local copy.
  broadcastChatMessage(orgId, 'message', message);
  return message;
}

/** POST /chat. Always saves the user's message first, as its own insert
 * — if the AI call below then fails, what the user typed is still
 * persisted and returned, never lost behind a failed round-trip. The AI
 * reply is a second, separate insert only on success; a failed AI call
 * produces `aiMessage: null` + `aiError`, not a fabricated placeholder
 * row claiming NEXUS AI said something it didn't.
 *
 * `crossReferenceEnabled` (Session 7 — AI chat cross-referencing) is
 * decided by the caller (routes/chat.ts, via `hasPermission(user,
 * 'ai_cross_reference', 'read')`), not this file — same "no permission
 * logic in service files" split every other service here already keeps.
 * Meaningless when `taskId` is set (task threads get no AI reply at
 * all, see the early return below) — routes/chat.ts doesn't even bother
 * checking the grant in that case, but this function ignores it too,
 * defensively, rather than trusting every future caller to remember. */
export async function sendChatMessage(
  orgId: string,
  authorUserId: string,
  body: string,
  taskId?: string,
  crossReferenceEnabled = false
): Promise<SendChatMessageResult> {
  const userMessage = await insertMessage(orgId, authorUserId, body, taskId);

  // Session 35 — task threads are plain human discussion (assignee/
  // support/supervisor talking about that one task), no AI auto-reply.
  // Returning early here rather than threading a taskId condition
  // through the AI call below keeps that call's own contract (always
  // 'ai'-channel history, per ChatReplyInput) unchanged for its one
  // existing caller.
  if (taskId) {
    return { userMessage, aiMessage: null };
  }

  // History for the AI call includes the message just saved — recent
  // turns, oldest first, per ChatReplyInput's contract (aiService.ts).
  const recent = await listRecentMessages(orgId, HISTORY_LIMIT);
  const history: ChatHistoryTurn[] = recent.map((m) => ({
    role: m.authorUserId ? 'user' : 'assistant',
    content: m.body,
  }));

  // Built fresh per send, never cached across turns — a snapshot from
  // three messages ago could already be stale (a task got unblocked, a
  // goal archived), and this is a bounded, cheap set of queries
  // (chatContextService.ts's own TASK_SNAPSHOT_LIMIT), not an expensive
  // one worth memoizing at the cost of staleness.
  const crossReferenceContext = crossReferenceEnabled ? await buildChatCrossReferenceContext(orgId) : undefined;

  try {
    const reply = await getAIService().chatReply({ orgId, history, actorUserId: authorUserId, crossReferenceContext });
    const aiMessage = await insertMessage(orgId, null, reply);
    return { userMessage, aiMessage, crossReferenced: crossReferenceContext ? true : undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'AI reply failed.';
    return { userMessage, aiMessage: null, aiError: message };
  }
}
