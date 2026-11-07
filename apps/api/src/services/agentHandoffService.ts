// Agent Handoff (PRD §8.8 / §10.6, Appendix C: "callN8NAgentWebhook_ +
// async callback contract — Reference implementation of the n8n-first /
// direct-AI-fallback / async-tracking pattern"). This is the first
// AutomationService-shaped piece of code in the codebase — §10.6's exact
// contract, reproduced:
//   1. N8N_AGENT_WEBHOOK_URL not set → skip straight to direct-AI fallback.
//   2. Set → POST to n8n; a synchronous non-pending reply completes the
//      handoff immediately; {status:"pending"} leaves it 'running' for a
//      callback to close out later (see completeHandoffFromCallback).
//   3. On error/timeout → fall back to direct AI call.
import { withOrgContext } from '../db.js';
import type { AgentHandoff, AgentHandoffStatus, CreateAgentHandoffInput } from '@nexus/shared';
import { getTaskById } from './taskService.js';
import { getAIService } from './aiService.js';

interface AgentHandoffRow {
  id: string;
  org_id: string;
  task_id: string | null;
  requested_by_user_id: string | null;
  instructions: string | null;
  status: AgentHandoffStatus;
  n8n_execution_ref: string | null;
  result: string | null;
  created_at: Date;
  completed_at: Date | null;
}

function toAgentHandoff(row: AgentHandoffRow): AgentHandoff {
  return {
    id: row.id,
    orgId: row.org_id,
    taskId: row.task_id ?? undefined,
    requestedByUserId: row.requested_by_user_id ?? undefined,
    instructions: row.instructions ?? undefined,
    status: row.status,
    n8nExecutionRef: row.n8n_execution_ref ?? undefined,
    result: row.result ?? undefined,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString(),
  };
}

const HANDOFF_LIST_LIMIT = 50; // same alert/log-list cap as analyticsService.ts's Failsafe lists

export async function listAgentHandoffs(orgId: string): Promise<AgentHandoff[]> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<AgentHandoffRow>(
      `select * from agent_handoffs where org_id = $1 order by created_at desc limit ${HANDOFF_LIST_LIMIT}`,
      [orgId]
    );
    return rows.map(toAgentHandoff);
  });
}

async function insertHandoff(
  orgId: string,
  userId: string,
  taskId: string | undefined,
  instructions: string,
  status: AgentHandoffStatus
): Promise<AgentHandoffRow> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<AgentHandoffRow>(
      `insert into agent_handoffs (org_id, task_id, requested_by_user_id, instructions, status)
       values ($1, $2, $3, $4, $5) returning *`,
      [orgId, taskId ?? null, userId, instructions, status]
    );
    return rows[0]!;
  });
}

async function completeHandoff(
  orgId: string,
  id: string,
  status: AgentHandoffStatus,
  result: string | undefined,
  n8nExecutionRef?: string
): Promise<AgentHandoffRow> {
  return withOrgContext(orgId, async (client) => {
    const { rows } = await client.query<AgentHandoffRow>(
      `update agent_handoffs
          set status = $2, result = $3, n8n_execution_ref = coalesce($4, n8n_execution_ref),
              completed_at = case when $2 in ('complete','failed','cancelled') then now() else completed_at end
        where id = $1 and org_id = $5
        returning *`,
      [id, status, result ?? null, n8nExecutionRef ?? null, orgId]
    );
    return rows[0]!;
  });
}

// n8n POST timeout — same "enforced timeouts on all external calls"
// requirement PRD §13.4 lists for every provider, not just AI.
const N8N_TIMEOUT_MS = 15_000;

interface N8nReply {
  status?: 'pending' | 'complete' | string;
  result?: string;
  executionId?: string;
}

async function tryN8n(webhookUrl: string, taskContext: string | undefined, instructions: string): Promise<N8nReply> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), N8N_TIMEOUT_MS);
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskContext, instructions }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`n8n webhook responded ${res.status}`);
    return (await res.json()) as N8nReply;
  } finally {
    clearTimeout(timeout);
  }
}

async function buildTaskContext(orgId: string, taskId: string | undefined): Promise<string | undefined> {
  if (!taskId) return undefined;
  const task = await getTaskById(orgId, taskId);
  if (!task) return undefined;
  return [task.title, task.description].filter(Boolean).join('\n');
}

/** POST /agent-handoffs. Follows PRD §10.6's contract exactly — see the
 * file header. Never throws for a downstream failure: n8n and direct-AI
 * errors both resolve to a 'failed' handoff row with the error message as
 * `result`, same "record what happened, don't lose the request" posture
 * as chatService.ts's aiError handling. */
export async function createAgentHandoff(
  orgId: string,
  userId: string,
  input: CreateAgentHandoffInput
): Promise<AgentHandoff> {
  const taskContext = await buildTaskContext(orgId, input.taskId);
  const webhookUrl = process.env.N8N_AGENT_WEBHOOK_URL;

  // Step 1: no n8n configured → straight to direct-AI fallback, row
  // created already 'running' so it appears in history immediately.
  const row = await insertHandoff(orgId, userId, input.taskId, input.instructions, 'running');

  if (webhookUrl) {
    // Step 2: n8n-first.
    try {
      const reply = await tryN8n(webhookUrl, taskContext, input.instructions);
      if (reply.status === 'pending') {
        // Async — leave 'running', record n8n's own execution ref for the
        // callback (not built yet — no /agent-handoffs/:id/callback route
        // exists until n8n is actually wired, PRD §10.6's own note that
        // the three scheduled-ping webhooks and this path are "two
        // separate efforts") to match against later.
        return toAgentHandoff(await completeHandoff(orgId, row.id, 'running', undefined, reply.executionId));
      }
      const result = reply.result ?? 'n8n completed the handoff with no result text.';
      return toAgentHandoff(await completeHandoff(orgId, row.id, 'complete', result, reply.executionId));
    } catch {
      // Step 3: n8n error/timeout → fall through to direct-AI fallback
      // below, same row.
    }
  }

  try {
    const result = await getAIService().agentHandoffFallback({ orgId, taskContext, instructions: input.instructions, actorUserId: userId });
    return toAgentHandoff(await completeHandoff(orgId, row.id, 'complete', result));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Agent handoff failed.';
    return toAgentHandoff(await completeHandoff(orgId, row.id, 'failed', message));
  }
}
