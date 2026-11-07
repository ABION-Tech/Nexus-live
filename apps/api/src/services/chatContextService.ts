// AI chat cross-referencing (ADMIN_BUILD_GUIDE.md "AI chat
// cross-referencing" / repo Session 7 in the guide's own numbering).
//
// Locked decisions for this session (guide's own three bullets):
//   - Default stays scoped to current chat — this file is never called
//     unless the caller already holds the `ai_cross_reference`+`read`
//     grant (routes/chat.ts decides that, this file just builds the
//     payload once asked).
//   - Cross-referencing is its own, explicit, grantable permission —
//     see `ai_cross_reference` in packages/shared's
//     PERMISSION_RESOURCE_ACTIONS, not an implicit widening of `chat`
//     or `ai_reports` access.
//   - Grant level: **org (company), not group.** Decided here rather
//     than left open: `permissions` is `unique(user_id, org_id,
//     resource, action)` (DECISIONS.md §5) — every existing grant in
//     this table is already org-scoped, and DECISIONS.md's own
//     corollary is that a cross-org view is N separately-scoped
//     queries merged at the API layer, never a single widened read.
//     Chat cross-referencing has no such merge step (it's one org's
//     assistant answering about that one org), so there's no case here
//     that isn't already served by the plain `hasPermission(user,
//     'ai_cross_reference', 'read')` check against the caller's current
//     `org_id` — a group-level variant would mean resolving "which
//     companies does this grant see" on every chat send for a
//     capability nothing has asked for yet. Revisit only if a real
//     group-rollup chat use case shows up (same "not preemptively"
//     posture DECISIONS.md #2 takes for task_trends/TimescaleDB).
//
// Same "AI narrates, doesn't invent" doctrine as aiReportService.ts's
// buildSignals: every number here comes from a deterministic query, this
// file's only job is to package a bounded snapshot for aiService.ts to
// fold into the prompt — it is never itself responsible for phrasing.
import { withOrgContext } from '../db.js';
import { listTasks } from './taskService.js';
import { getBlockedTasks, getUpcomingDeadlines } from './analyticsService.js';
import { listGoals } from './goalService.js';
import { listOrgPeople } from './peopleService.js';
import type { Task } from '@nexus/shared';

// Caps on every list below — this is a chat-prompt payload, not a report
// export (exportChatThread's own "give a leader everything" reasoning
// doesn't apply here): every extra row is tokens spent on every single
// chat turn for as long as the conversation continues, not a one-time
// cost. 15 is generous enough to answer "what's open right now" without
// approaching HISTORY_LIMIT-sized prompt bloat (chatService.ts's own
// constant for the *conversation* half of this same prompt).
const TASK_SNAPSHOT_LIMIT = 15;

function toTaskSummary(t: Task) {
  return {
    title: t.title,
    status: t.status,
    deadline: t.deadline,
    business: t.business,
    department: t.department,
  };
}

export interface ChatCrossReferenceContext {
  organizationName: string;
  peopleCount: number;
  activeGoalCount: number;
  openTaskCount: number;
  blockedTaskCount: number;
  upcomingDeadlineCount: number;
  /** Bounded, most-recent-first — same shape as `toTaskSummary`, no
   * assignee names (people/roster is summarized as a count only, not
   * individually named, to keep the snapshot from reading like a
   * personnel dossier for a feature whose ask was "task/company data",
   * not "who is doing what"). */
  recentOpenTasks: ReturnType<typeof toTaskSummary>[];
  blockedTasks: ReturnType<typeof toTaskSummary>[];
}

/** Builds the bounded org snapshot handed to aiService.ts's
 * cross-reference-enabled chat prompt. Reuses the same deterministic
 * queries aiReportService.ts's buildSignals already established
 * (getBlockedTasks/getUpcomingDeadlines) rather than duplicating them —
 * this is the second caller of that "AI Analyst 08" precedent, not a
 * one-off. Every query here is org-scoped via withOrgContext/listTasks's
 * own RLS-backed isolation (DECISIONS.md §3); nothing crosses org_id. */
export async function buildChatCrossReferenceContext(orgId: string): Promise<ChatCrossReferenceContext> {
  const [orgRow, openTasksPage, goals, people, blocked, deadlines] = await Promise.all([
    withOrgContext(orgId, async (client) => {
      const { rows } = await client.query<{ name: string }>(`select name from organizations where id = $1`, [orgId]);
      return rows[0];
    }),
    listTasks(orgId, { pageSize: TASK_SNAPSHOT_LIMIT }), // default excludes archived — "open" here means "not archived", same as every other list route's default
    listGoals(orgId, 'active'),
    listOrgPeople(orgId),
    getBlockedTasks(orgId, {}),
    getUpcomingDeadlines(orgId, {}),
  ]);

  return {
    organizationName: orgRow?.name ?? 'this organization',
    peopleCount: people.length,
    activeGoalCount: goals.length,
    openTaskCount: openTasksPage.total,
    blockedTaskCount: blocked.length,
    upcomingDeadlineCount: deadlines.length,
    recentOpenTasks: openTasksPage.tasks.slice(0, TASK_SNAPSHOT_LIMIT).map(toTaskSummary),
    blockedTasks: blocked.slice(0, TASK_SNAPSHOT_LIMIT).map(toTaskSummary),
  };
}
