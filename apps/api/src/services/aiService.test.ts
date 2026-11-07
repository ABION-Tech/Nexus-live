// Tests the completeAndRecord wiring aiService.ts's top-of-file comment
// describes for Session 39 — that every DefaultAIService method resolves
// a provider, calls it, and logs exactly one ai_usage row via
// recordAiUsageSafely, on both the success and failure path. Not a
// aiProvider.ts/aiUsageService.ts integration test — both are mocked, so
// this is purely "does aiService.ts wire the pieces together correctly."
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factories run at import time, before any top-level `const` in
// this file would otherwise be initialized (ESM import execution order,
// not vi.mock's own hoisting) — vi.hoisted is what makes these safely
// referenceable inside the factories below, per vitest's own documented
// pattern for exactly this "Cannot access X before initialization" case.
const { resolveProviderForOrg, recordAiUsageSafely, checkAiUsageLimit } = vi.hoisted(() => ({
  resolveProviderForOrg: vi.fn(),
  recordAiUsageSafely: vi.fn(),
  // Session 47: completeAndRecord now calls checkAiUsageLimit before
  // resolveProviderForOrg (see aiService.ts's own comment on why —
  // capped orgs shouldn't reach a provider at all). Mocked as a no-op
  // resolve here since this file is purely about the pre-existing
  // provider/logging wiring, not billing enforcement — that gets its
  // own coverage wherever billingService.ts's tests live.
  checkAiUsageLimit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./aiSettingsService.js', () => ({ resolveProviderForOrg }));
vi.mock('./aiUsageService.js', () => ({ recordAiUsageSafely }));
vi.mock('./billingService.js', () => ({ checkAiUsageLimit }));

import { DefaultAIService } from './aiService.js';

function fakeProvider(complete: ReturnType<typeof vi.fn>) {
  return { complete };
}

beforeEach(() => {
  resolveProviderForOrg.mockReset();
  recordAiUsageSafely.mockReset();
  checkAiUsageLimit.mockReset();
  checkAiUsageLimit.mockResolvedValue(undefined);
});

describe('DefaultAIService — usage logging (Session 39)', () => {
  it('decomposeGoal logs a successful ai_usage row with the provider-reported tokens/latency', async () => {
    const complete = vi.fn().mockResolvedValue({
      text: JSON.stringify([{ title: 'Do the thing' }, { title: 'Do the next thing', dependsOnIndex: 0 }, { title: 'A' }, { title: 'B' }]),
      promptTokens: 120,
      completionTokens: 45,
      totalTokens: 165,
      latencyMs: 812,
    });
    resolveProviderForOrg.mockResolvedValue({ provider: fakeProvider(complete), model: 'GLM 5.2' });

    const service = new DefaultAIService();
    await service.decomposeGoal({ orgId: 'org-1', goalTitle: 'Ship the thing', actorUserId: 'user-1' });

    expect(resolveProviderForOrg).toHaveBeenCalledWith('org-1', 'chat');
    expect(recordAiUsageSafely).toHaveBeenCalledTimes(1);
    expect(recordAiUsageSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: 'org-1',
        actorUserId: 'user-1',
        feature: 'goal_decomposition',
        providerTarget: 'chat',
        model: 'GLM 5.2',
        promptTokens: 120,
        completionTokens: 45,
        totalTokens: 165,
        latencyMs: 812,
        success: true,
      })
    );
  });

  it('chatReply resolves the "chat" provider target and logs feature "chat"', async () => {
    const complete = vi.fn().mockResolvedValue({ text: 'Hi there.', latencyMs: 50 });
    resolveProviderForOrg.mockResolvedValue({ provider: fakeProvider(complete), model: 'stub' });

    const service = new DefaultAIService();
    await service.chatReply({ orgId: 'org-1', history: [{ role: 'user', content: 'Hi' }] });

    expect(resolveProviderForOrg).toHaveBeenCalledWith('org-1', 'chat');
    expect(recordAiUsageSafely).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'chat', providerTarget: 'chat', model: 'stub', success: true })
    );
  });

  it('chatReply without crossReferenceContext never mentions the org snapshot in the prompt sent to the provider', async () => {
    const complete = vi.fn().mockResolvedValue({ text: 'I don\u2019t have that data connected.', latencyMs: 40 });
    resolveProviderForOrg.mockResolvedValue({ provider: fakeProvider(complete), model: 'stub' });

    const service = new DefaultAIService();
    await service.chatReply({ orgId: 'org-1', history: [{ role: 'user', content: 'How many tasks are blocked?' }] });

    const [systemPrompt, userPrompt] = complete.mock.calls[0]!;
    expect(systemPrompt).toContain('do NOT currently have live access');
    expect(userPrompt).not.toContain('ORG SNAPSHOT');
  });

  it('chatReply with crossReferenceContext (Session 7) switches the system prompt and folds the snapshot into the user prompt as JSON, still logging feature "chat"/target "chat"', async () => {
    const complete = vi.fn().mockResolvedValue({ text: 'You have 2 blocked tasks.', latencyMs: 60 });
    resolveProviderForOrg.mockResolvedValue({ provider: fakeProvider(complete), model: 'stub' });

    const service = new DefaultAIService();
    await service.chatReply({
      orgId: 'org-1',
      history: [{ role: 'user', content: 'How many tasks are blocked?' }],
      actorUserId: 'user-3',
      crossReferenceContext: {
        organizationName: 'ABION Industries',
        peopleCount: 12,
        activeGoalCount: 3,
        openTaskCount: 9,
        blockedTaskCount: 2,
        upcomingDeadlineCount: 4,
        recentOpenTasks: [],
        blockedTasks: [],
      },
    });

    const [systemPrompt, userPrompt] = complete.mock.calls[0]!;
    expect(systemPrompt).toContain('HAVE been given a live, bounded snapshot');
    expect(userPrompt).toContain('ORG SNAPSHOT');
    expect(userPrompt).toContain('"blockedTaskCount": 2');
    expect(resolveProviderForOrg).toHaveBeenCalledWith('org-1', 'chat'); // same provider target as plain chat
    expect(recordAiUsageSafely).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'chat', providerTarget: 'chat', actorUserId: 'user-3', success: true })
    );
  });

  it('generateReport resolves the "report" provider target, distinct from chat', async () => {
    const complete = vi.fn().mockResolvedValue({ text: 'Everything looks fine.', latencyMs: 300 });
    resolveProviderForOrg.mockResolvedValue({ provider: fakeProvider(complete), model: 'Kimi K2.5' });

    const service = new DefaultAIService();
    await service.generateReport({
      orgId: 'org-1',
      mode: 'attention',
      signals: {
        blockedCount: 0,
        upcomingDeadlineCount: 0,
        stalePartnerCount: 0,
        trendPoints: [],
        priorityBreakdown: { urgent: 0, high: 0, medium: 0, low: 0 },
      },
      actorUserId: 'user-2',
    });

    expect(resolveProviderForOrg).toHaveBeenCalledWith('org-1', 'report');
    expect(recordAiUsageSafely).toHaveBeenCalledWith(
      expect.objectContaining({ feature: 'report', providerTarget: 'report', model: 'Kimi K2.5', actorUserId: 'user-2' })
    );
  });

  it('agentHandoffFallback still resolves "chat" (unchanged from pre-Session-39 behavior) and logs feature "agent_handoff"', async () => {
    const complete = vi.fn().mockResolvedValue({ text: 'Drafted the reply.', latencyMs: 200 });
    resolveProviderForOrg.mockResolvedValue({ provider: fakeProvider(complete), model: 'stub' });

    const service = new DefaultAIService();
    await service.agentHandoffFallback({ orgId: 'org-1', instructions: 'Draft a reply' });

    expect(resolveProviderForOrg).toHaveBeenCalledWith('org-1', 'chat');
    expect(recordAiUsageSafely).toHaveBeenCalledWith(expect.objectContaining({ feature: 'agent_handoff', providerTarget: 'chat' }));
  });

  it('logs success: false with the error message when the provider throws, and still rethrows', async () => {
    const complete = vi.fn().mockRejectedValue(new Error('AI provider error 503: overloaded'));
    resolveProviderForOrg.mockResolvedValue({ provider: fakeProvider(complete), model: 'GLM 5.2' });

    const service = new DefaultAIService();
    await expect(service.chatReply({ orgId: 'org-1', history: [] })).rejects.toThrow('AI provider error 503: overloaded');

    expect(recordAiUsageSafely).toHaveBeenCalledTimes(1);
    expect(recordAiUsageSafely).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        errorMessage: 'AI provider error 503: overloaded',
        model: 'GLM 5.2',
      })
    );
    // No promptTokens/completionTokens/totalTokens on the failure path —
    // there's no AICompletionResult to have reported them (see
    // completeAndRecord's own comment on why latencyMs is approximated
    // as 0 here rather than fabricated).
    const loggedArg = recordAiUsageSafely.mock.calls[0]![0];
    expect(loggedArg.promptTokens).toBeUndefined();
    expect(loggedArg.totalTokens).toBeUndefined();
  });

  it('a malformed decomposition response still logs success: true (the provider call itself succeeded) and throws AIDecompositionError from parsing, not from completeAndRecord', async () => {
    const complete = vi.fn().mockResolvedValue({ text: 'not json at all', latencyMs: 100 });
    resolveProviderForOrg.mockResolvedValue({ provider: fakeProvider(complete), model: 'GLM 5.2' });

    const service = new DefaultAIService();
    await expect(service.decomposeGoal({ orgId: 'org-1', goalTitle: 'X' })).rejects.toThrow(/valid JSON/);

    // completeAndRecord already recorded success before parseDecompositionResponse
    // ever ran — the provider call itself didn't fail, parsing did, and that
    // failure happens after completeAndRecord has already returned.
    expect(recordAiUsageSafely).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
