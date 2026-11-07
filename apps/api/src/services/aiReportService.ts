// AI Analyst > Reports (PRD §8.8). "Predictions (deterministic signals
// computed in code, narrated by AI — preserve this pattern: AI narrates,
// doesn't invent)" — this file owns the deterministic half; aiService.ts's
// generateReport owns the narration half. Reuses analyticsService.ts and
// networkService.ts's existing queries rather than duplicating them —
// same underlying data PRD §8.7 Analytics and §8.9 Failsafe Alerts both
// already surface, just packaged for the AI to read.
import type { AiReportMode, AiReportRequest, AiReportResult, AiReportSignals } from '@nexus/shared';
import { getBlockedTasks, getOpenTaskPriorityBreakdown, getTaskTrends, getUpcomingDeadlines } from './analyticsService.js';
import { getStalePartnerFollowUps } from './networkService.js';
import { getAIService } from './aiService.js';

const CUSTOM_REPORT_DEFAULT_DAYS = 30;

function defaultRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - CUSTOM_REPORT_DEFAULT_DAYS);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

async function buildSignals(orgId: string, mode: AiReportMode, from?: string, to?: string): Promise<AiReportSignals> {
  const range = mode === 'custom' ? { from: from ?? defaultRange().from, to: to ?? defaultRange().to } : undefined;

  const [blocked, deadlines, partners, trendPoints, priorityBreakdown] = await Promise.all([
    getBlockedTasks(orgId, {}),
    getUpcomingDeadlines(orgId, {}),
    getStalePartnerFollowUps(orgId, undefined),
    getTaskTrends(orgId, range ? { from: range.from, to: range.to } : {}),
    getOpenTaskPriorityBreakdown(orgId), // 0033_task_priority.sql
  ]);

  return {
    blockedCount: blocked.length,
    upcomingDeadlineCount: deadlines.length,
    stalePartnerCount: partners.length,
    trendPoints,
    priorityBreakdown,
  };
}

/** POST /ai/reports. Always computes fresh signals (no caching layer
 * yet — PRD §8.8 flags `getCachedOrFetch_`'s TTL strategy as something to
 * "check ... and carry into the production AIService", not something
 * this first cut needs to reproduce) and always attempts narration; a
 * narration failure still returns the signals with an empty narrative
 * plus the underlying error, same "never lose what's real" posture as
 * chatService.ts's aiError handling. */
export async function generateAiReport(orgId: string, request: AiReportRequest, actorUserId?: string): Promise<AiReportResult> {
  const signals = await buildSignals(orgId, request.mode, request.from, request.to);

  let narrative: string;
  try {
    narrative = await getAIService().generateReport({ orgId, mode: request.mode, signals, actorUserId });
  } catch (err) {
    narrative = err instanceof Error
      ? `NEXUS AI could not generate a narrative: ${err.message}`
      : 'NEXUS AI could not generate a narrative.';
  }

  return { mode: request.mode, narrative, signals, generatedAt: new Date().toISOString() };
}
