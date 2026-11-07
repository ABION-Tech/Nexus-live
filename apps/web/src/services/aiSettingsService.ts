// Web-side aiSettingsService — wraps apps/api/src/routes/aiSettings.ts.
// Same unwrap convention as knowledgeService.ts / networkService.ts.
import { apiClient } from './apiClient';
import type { AiSettings, AiSettingsInput, AiTestResult, AiTestTarget } from '@nexus/shared';

export function fetchAiSettings(): Promise<AiSettings> {
  return apiClient.get<AiSettings>('/settings/ai');
}

export function saveAiSettings(input: AiSettingsInput): Promise<AiSettings> {
  return apiClient.put<AiSettings>('/settings/ai', input);
}

export function testAiConnection(target: AiTestTarget): Promise<AiTestResult> {
  return apiClient.post<AiTestResult>('/settings/ai/test', { target });
}
