// Web-side reportService — wraps apps/api/src/routes/aiReports.ts
// (PRD §8.8 AI Analyst > Reports). POST /ai/reports/generate returns the
// AiReportResult directly, same "no wrapper key on a single-resource
// response" convention as chatService.ts's sendChatMessage.
import { apiClient } from './apiClient';
import type { AiReportMode, AiReportResult } from '@nexus/shared';

export function generateAiReport(mode: AiReportMode, from?: string, to?: string): Promise<AiReportResult> {
  return apiClient.post<AiReportResult>('/ai/reports/generate', { mode, from, to });
}
