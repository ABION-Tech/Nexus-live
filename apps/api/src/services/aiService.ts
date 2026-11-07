// AIService — PRD §10.2 / §8.5 ("AI decomposes into 4–10 tasks"). This is
// the Service layer over aiProvider.ts's Provider layer (PRD §6: UI →
// Service → Provider → External API) — it owns the prompt, the JSON
// contract, and validating the provider's response into a
// `ProposedTaskInput[]` goalService already knows how to insert. Nothing
// downstream of this file needs to know whether the provider behind it is
// the stub or a real model.
//
// Deliberately narrow for now: one method, goal decomposition, since
// that's the only AIService caller that exists (goals.ts). Other §10.2
// AI features (report/attention/predictions — see the GAS backend's
// AI Analyst modes for the shape those would take) are out of scope here
// until something actually calls them.
import type { ProposedTaskInput, AiReportMode, AiReportSignals, AiUsageFeature } from '@nexus/shared';
import { resolveProviderForOrg } from './aiSettingsService.js';
import { recordAiUsageSafely } from './aiUsageService.js';
import { checkAiUsageLimit } from './billingService.js';
import type { ChatCrossReferenceContext } from './chatContextService.js';

export class AIDecompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AIDecompositionError';
  }
}

// Same anti-fabrication posture as the GAS backend's AI Analyst system
// prompts (AI_CHAT_SYSTEM_PROMPT et al.) — plain, direct, and explicit
// that inventing detail not implied by the goal title is worse than
// leaving a field blank. JSON-only output is enforced by instruction here
// AND by parseDecompositionResponse below refusing to guess at malformed
// output rather than trying to salvage it.
const GOAL_DECOMPOSITION_SYSTEM_PROMPT = `You are NEXUS AI, breaking a single operations goal down into 4-10 concrete, actionable tasks.
Respond with ONLY a JSON array — no markdown, no prose, no code fences before or after it.
Each element must be an object with exactly these fields:
  "title" (string, required, under 100 characters, an imperative action)
  "description" (string, optional, one or two sentences of concrete detail)
  "reasoning" (string, optional, why this task matters or how it fits the goal)
  "dependsOnIndex" (integer, optional, the 0-based index of an EARLIER element in this same array that must finish first)
Order tasks so anything else depends on comes before it in the array — dependsOnIndex can only point backward, never forward.
Never invent names, dates, or numbers that weren't implied by the goal itself.
Produce between 4 and 10 tasks. Do not include anything outside the JSON array.`;

function buildUserPrompt(goalTitle: string, context?: string): string {
  return context
    ? `GOAL: ${goalTitle}\n\nADDITIONAL CONTEXT FROM THE REQUESTER:\n${context}`
    : `GOAL: ${goalTitle}`;
}

/** Parses and validates a provider's raw text response into
 * `ProposedTaskInput[]`. Deliberately strict — malformed JSON, a
 * non-array, a missing title, or a forward/self-referencing
 * `dependsOnIndex` all throw rather than get silently dropped or
 * coerced, since a silently-wrong decomposition is worse than a visible
 * failure the leader can retry or fill in by hand. (The forward-reference
 * check is intentionally duplicated here and in goalService's
 * insertProposedTasks — this one fails fast with a message about the AI's
 * output specifically; that one is the DB-layer invariant regardless of
 * where the input came from.) */
export function parseDecompositionResponse(raw: string): ProposedTaskInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AIDecompositionError('AI provider did not return valid JSON for goal decomposition.');
  }
  if (!Array.isArray(parsed)) {
    throw new AIDecompositionError('AI provider response was not a JSON array.');
  }
  if (parsed.length < 1) {
    throw new AIDecompositionError('AI provider returned zero tasks.');
  }

  const tasks: ProposedTaskInput[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i] as Record<string, unknown>;
    if (!item || typeof item.title !== 'string' || !item.title.trim()) {
      throw new AIDecompositionError(`Task ${i} in the AI response is missing a valid "title".`);
    }
    if (item.dependsOnIndex !== undefined) {
      if (typeof item.dependsOnIndex !== 'number' || item.dependsOnIndex < 0 || item.dependsOnIndex >= i) {
        throw new AIDecompositionError(
          `Task ${i} ("${item.title}") has an invalid dependsOnIndex — it must be a number referring to an earlier task.`
        );
      }
    }
    tasks.push({
      title: item.title,
      description: typeof item.description === 'string' ? item.description : undefined,
      reasoning: typeof item.reasoning === 'string' ? item.reasoning : undefined,
      dependsOnIndex: typeof item.dependsOnIndex === 'number' ? item.dependsOnIndex : undefined,
    });
  }
  return tasks;
}

// AI Analyst > Chat (PRD §7.2 08) system prompt. Same anti-fabrication
// posture as GOAL_DECOMPOSITION_SYSTEM_PROMPT above, with one addition
// specific to chat: Reports (the other §7.2 08 subsection) isn't built
// yet, so this assistant has no live read access to NEXUS's own
// tasks/goals/people data — it must say so rather than invent numbers
// that sound plausible for an "ops assistant" persona to know.
const CHAT_SYSTEM_PROMPT = `You are NEXUS AI, ABION Industries' AI Analyst assistant, chatting with a team leader inside the NEXUS operations platform.
Answer clearly and concisely. If you don't know something, say so rather than guessing.
You do NOT currently have live access to this org's actual tasks, goals, people, or reports data — that integration isn't built yet. If asked about the org's real current numbers or specific records, say plainly that you don't have that data connected yet, rather than inventing a plausible-sounding answer.
The conversation so far is provided below as a transcript. Reply only as "NEXUS AI" to the final "User:" turn — do not repeat earlier turns back, and do not prefix your reply with "NEXUS AI:".`;

// AI chat cross-referencing (ADMIN_BUILD_GUIDE.md "AI chat
// cross-referencing" — repo Session 7 in the guide's numbering). Only
// used when routes/chat.ts has already confirmed the caller holds the
// `ai_cross_reference`+`read` grant (chatService.ts is what decides
// which prompt this file gets called with — this file just owns the two
// prompt variants). Same anti-fabrication posture as
// AI_REPORT_SYSTEM_PROMPT: the snapshot is deterministic
// (chatContextService.ts), this prompt's only new permission relative to
// CHAT_SYSTEM_PROMPT above is "you may cite the numbers in this
// snapshot" — it does not relax the "never invent a number" rule, it
// just changes what counts as a real number to reference.
const CHAT_CROSS_REFERENCE_SYSTEM_PROMPT = `You are NEXUS AI, ABION Industries' AI Analyst assistant, chatting with a team leader inside the NEXUS operations platform.
Answer clearly and concisely. If you don't know something, say so rather than guessing.
Unlike your default mode, you HAVE been given a live, bounded snapshot of this org's own current tasks/goals/roster data below (ORG SNAPSHOT), refreshed for this reply. You may use it to answer questions about the org's real current state.
Only state a figure or task detail that appears in the ORG SNAPSHOT. It is a partial snapshot, not the full record set — if something isn't in it (e.g. a specific task or person by name that the snapshot doesn't list), say you don't see that in the current snapshot rather than guessing or inventing it. Never present a number you computed yourself instead of one given directly in the snapshot.
The conversation so far is provided below as a transcript, followed by the snapshot. Reply only as "NEXUS AI" to the final "User:" turn — do not repeat earlier turns back, and do not prefix your reply with "NEXUS AI:".`;

/** Folds recent turns into a single prompt string — AIProvider.complete()
 * is deliberately a flat (systemPrompt, userPrompt) shape (see its own
 * doc comment: "Callers own their own prompt format"), not a multi-turn
 * messages array, so conversation history has to travel as plain text
 * here rather than as a `messages[]` OpenAICompatibleProvider builds
 * itself. `history` is already in chronological order (oldest first) —
 * see chatService.ts's query — so this just labels each turn and joins
 * them. `context`, when given, is appended as its own labeled JSON block
 * after the transcript — same "payload as JSON, prose stays in the
 * system prompt's instructions" shape buildReportUserPrompt below uses,
 * not folded into the transcript itself so the model can't confuse it
 * for something a person actually typed. */
function buildChatUserPrompt(history: ChatHistoryTurn[], context?: ChatCrossReferenceContext): string {
  const transcript = history.map((turn) => `${turn.role === 'user' ? 'User' : 'NEXUS AI'}: ${turn.content}`).join('\n');
  return context ? `${transcript}\n\nORG SNAPSHOT:\n${JSON.stringify(context, null, 2)}` : transcript;
}

export interface ChatHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatReplyInput {
  orgId: string;
  /** Chronological, oldest first, ending with the newest user turn — the
   * thing this call is actually replying to. */
  history: ChatHistoryTurn[];
  /** Session 39 — see DecomposeGoalInput.actorUserId's own comment. */
  actorUserId?: string;
  /** Present only when the caller holds `ai_cross_reference`+`read` —
   * chatService.ts builds this via chatContextService.ts and passes it
   * through; this file never fetches it itself (no data-access
   * happening in aiService.ts elsewhere either, same "Service owns the
   * prompt, not the query" split generateReport already keeps against
   * aiReportService.ts's buildSignals). Its presence, not a separate
   * boolean, is what switches which system prompt is used below. */
  crossReferenceContext?: ChatCrossReferenceContext;
}

export interface DecomposeGoalInput {
  /** Which org's Settings > Integrations connection to use — the provider
   * is resolved per-call now (aiSettingsService.resolveProviderForOrg),
   * not a single process-wide singleton, since each org can point at a
   * different endpoint/model. */
  orgId: string;
  goalTitle: string;
  /** Optional freeform detail the requester typed alongside the goal
   * title — folded into the prompt, never fabricated if absent. */
  context?: string;
  /** Session 39 — who to attribute this call's ai_usage row to. Optional
   * (mirrors ai_usage.actor_user_id's own nullability) because a future
   * automation-triggered caller may have no human actor at all, even
   * though every real caller today (routes/goals.ts) does have one. */
  actorUserId?: string;
}

// AI Analyst > Reports (PRD §8.8, Appendix B prompts #3/#4). Same
// "narrates, doesn't invent" contract as computePredictionSignals_
// (Appendix C: "Deterministic signal computation — AI narrates these,
// not invents them. Keep computation in code.") — the counts themselves
// come from aiReportService.ts's deterministic queries; this prompt's one
// job is to turn those counts into prose without adding numbers that
// aren't in the payload it's given.
const AI_REPORT_SYSTEM_PROMPT = `You are NEXUS AI, ABION Industries' AI Analyst, writing a short operations report for a team leader.
You will be given a JSON payload of deterministic counts and, for the "custom" mode, a date-ranged trend series. The payload includes a priorityBreakdown of open tasks by urgency (urgent/high/medium/low) — weigh urgent and high items first when deciding what needs attention. Write a brief, plain-English narrative (3-6 sentences, no markdown headers, no bullet lists) that explains what the numbers mean and what — if anything — needs attention.
Only reference figures present in the payload. Never invent a count, a name, or a date that isn't in it. If a figure is zero, say so plainly rather than omitting it.`;

function buildReportUserPrompt(mode: AiReportMode, signals: AiReportSignals): string {
  const label =
    mode === 'attention'
      ? 'ATTENTION QUEUE — flagged items needing leader attention right now.'
      : mode === 'predictions'
        ? 'PREDICTIONS — narrate these deterministic signals; do not invent a forecast beyond what they imply.'
        : 'CUSTOM REPORT — summarize this date-ranged window.';
  return `${label}\n\nDATA:\n${JSON.stringify(signals, null, 2)}`;
}

// Agent Handoff direct-AI-fallback path (PRD §10.6 / Appendix B prompt
// #5). Only reached when N8N_AGENT_WEBHOOK_URL isn't set or n8n itself
// errors (agentHandoffService.ts) — "a deliberate resilience decision,
// not a placeholder" per PRD §8.8.
const AGENT_HANDOFF_SYSTEM_PROMPT = `You are NEXUS AI, standing in for an operations agent because no n8n workflow is configured (or it failed) for this handoff.
You will be given a task's title/description (if any) and the leader's custom instructions. Do the best you reasonably can as a text response: draft the requested content, outline the requested steps, or answer the request directly.
Do not claim to have taken any real-world action (you cannot send emails, edit records, or call external systems from here) — describe what you produced, not what you "did".`;

function buildAgentHandoffUserPrompt(taskContext: string | undefined, instructions: string): string {
  return taskContext
    ? `TASK CONTEXT:\n${taskContext}\n\nINSTRUCTIONS FROM THE LEADER:\n${instructions}`
    : `INSTRUCTIONS FROM THE LEADER:\n${instructions}`;
}

export interface GenerateReportInput {
  orgId: string;
  mode: AiReportMode;
  signals: AiReportSignals;
  /** Session 39 — see DecomposeGoalInput.actorUserId's own comment. */
  actorUserId?: string;
}

export interface AgentHandoffFallbackInput {
  orgId: string;
  taskContext?: string;
  instructions: string;
  /** Session 39 — see DecomposeGoalInput.actorUserId's own comment. */
  actorUserId?: string;
}

export interface AIService {
  decomposeGoal(input: DecomposeGoalInput): Promise<ProposedTaskInput[]>;
  /** AI Analyst > Chat's one call — a raw, trimmed text reply, no JSON
   * contract to validate (unlike decomposeGoal). Errors (network,
   * non-2xx, empty response — all thrown by the provider layer, see
   * aiProvider.ts) are left to propagate; chatService.ts is what decides
   * how to surface a failed reply to the caller, same layering as
   * decomposeGoal leaving AIDecompositionError-vs-provider-error
   * decisions to routes/goals.ts. Session 7: `input.crossReferenceContext`
   * present switches the system prompt to
   * CHAT_CROSS_REFERENCE_SYSTEM_PROMPT and folds the snapshot into the
   * user prompt; absent, behavior is byte-for-byte what it was before
   * this session. */
  chatReply(input: ChatReplyInput): Promise<string>;
  /** AI Analyst > Reports — narrates deterministic signals computed by
   * aiReportService.ts. Uses the 'report' provider target (a leader can
   * configure a separate, e.g. stronger, model for reports vs chat in
   * Settings > Integrations). */
  generateReport(input: GenerateReportInput): Promise<string>;
  /** Agent Handoff's direct-AI-fallback leg (PRD §10.6 step 3). */
  agentHandoffFallback(input: AgentHandoffFallbackInput): Promise<string>;
}

// Session 39 — the one place all four AIService methods route their
// actual provider.complete() call through. Handles resolving the
// provider+model, timing/token bookkeeping already living on the
// provider's own AICompletionResult (see aiProvider.ts), and writing the
// ai_usage row — success or failure — via recordAiUsageSafely (which
// itself never throws, so a usage-logging problem can't turn into a
// user-facing feature failure). Kept private to this file rather than
// exported: every current AIService method needs exactly this sequence
// (resolve → complete → record → return-or-rethrow), and a caller
// outside this file that wanted the same sequence would really be a
// fifth AIService method, not a reason to widen this helper's surface.
async function completeAndRecord(params: {
  orgId: string;
  actorUserId?: string;
  feature: AiUsageFeature;
  providerTarget: 'chat' | 'report';
  systemPrompt: string;
  userPrompt: string;
}): Promise<string> {
  const { orgId, actorUserId, feature, providerTarget, systemPrompt, userPrompt } = params;
  // Session 47: checked before resolveProviderForOrg, deliberately — a
  // capped org should never reach a real provider call (and pay its
  // latency/cost) for a request that's about to be rejected. Lets the
  // BillingLimitError propagate uncaught to this function's own callers
  // (decomposeGoal etc.), same as AIDecompositionError already does for
  // a malformed provider response — no ai_usage row is written for a
  // request that never actually called a provider.
  await checkAiUsageLimit(orgId);
  const { provider, model } = await resolveProviderForOrg(orgId, providerTarget);
  try {
    const result = await provider.complete(systemPrompt, userPrompt);
    await recordAiUsageSafely({
      orgId,
      actorUserId,
      feature,
      providerTarget,
      model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalTokens: result.totalTokens,
      latencyMs: result.latencyMs,
      success: true,
    });
    return result.text;
  } catch (err) {
    // Latency for a thrown call is still worth recording (a timeout is
    // itself a meaningful ~30s latency data point, not a null one) —
    // but the provider layer doesn't hand back a latencyMs on throw the
    // way it does on success (AICompletionResult is never constructed
    // for a rejected promise), so this is measured here instead, from
    // the same `resolveProviderForOrg` call onward, as the closest
    // available approximation.
    await recordAiUsageSafely({
      orgId,
      actorUserId,
      feature,
      providerTarget,
      model,
      latencyMs: 0,
      success: false,
      errorMessage: err instanceof Error ? err.message : 'Unknown AI provider error.',
    });
    throw err;
  }
}

export class DefaultAIService implements AIService {
  async decomposeGoal({ orgId, goalTitle, context, actorUserId }: DecomposeGoalInput): Promise<ProposedTaskInput[]> {
    const raw = await completeAndRecord({
      orgId,
      actorUserId,
      feature: 'goal_decomposition',
      providerTarget: 'chat',
      systemPrompt: GOAL_DECOMPOSITION_SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(goalTitle, context),
    });
    return parseDecompositionResponse(raw);
  }

  async chatReply({ orgId, history, actorUserId, crossReferenceContext }: ChatReplyInput): Promise<string> {
    const raw = await completeAndRecord({
      orgId,
      actorUserId,
      feature: 'chat',
      providerTarget: 'chat',
      systemPrompt: crossReferenceContext ? CHAT_CROSS_REFERENCE_SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT,
      userPrompt: buildChatUserPrompt(history, crossReferenceContext),
    });
    return raw.trim();
  }

  async generateReport({ orgId, mode, signals, actorUserId }: GenerateReportInput): Promise<string> {
    const raw = await completeAndRecord({
      orgId,
      actorUserId,
      feature: 'report',
      providerTarget: 'report',
      systemPrompt: AI_REPORT_SYSTEM_PROMPT,
      userPrompt: buildReportUserPrompt(mode, signals),
    });
    return raw.trim();
  }

  async agentHandoffFallback({ orgId, taskContext, instructions, actorUserId }: AgentHandoffFallbackInput): Promise<string> {
    const raw = await completeAndRecord({
      orgId,
      actorUserId,
      // 'chat' provider target — same choice the pre-Session-39 code
      // already made (agentHandoffFallback always resolved 'chat', never
      // 'report'), preserved exactly rather than revisited here.
      feature: 'agent_handoff',
      providerTarget: 'chat',
      systemPrompt: AGENT_HANDOFF_SYSTEM_PROMPT,
      userPrompt: buildAgentHandoffUserPrompt(taskContext, instructions),
    });
    return raw.trim();
  }
}

let cached: AIService | null = null;

/** Module-level singleton, same pattern as getAIProvider() — routes call
 * this rather than constructing DefaultAIService themselves, so tests can
 * substitute a fake AIService wholesale via __setAIServiceForTesting
 * instead of reaching through to the provider layer. */
export function getAIService(): AIService {
  if (!cached) cached = new DefaultAIService();
  return cached;
}

export function __setAIServiceForTesting(service: AIService | null): void {
  cached = service;
}
