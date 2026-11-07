// Web-side automationService — wraps apps/api/src/routes/automation.ts.
// Three endpoints: list controls, toggle one control, list audit log.
// Same unwrap convention as aiSettingsService.ts / networkService.ts:
// the server envelopes in { controls } / { entries }; unwrap here so
// callers receive the array directly.
import { apiClient } from './apiClient';
import type { AutomationControl, AutomationControlKey, AutomationHealthEntry, AutomationLogEntry } from '@nexus/shared';

export function fetchAutomationControls(): Promise<AutomationControl[]> {
  return apiClient
    .get<{ controls: AutomationControl[] }>('/automation')
    .then((r) => r.controls);
}

export function toggleAutomationControl(
  key: AutomationControlKey,
  enabled: boolean,
): Promise<AutomationControl> {
  return apiClient.patch<AutomationControl>(`/automation/${key}`, { enabled });
}

export function fetchAutomationLog(limit?: number): Promise<AutomationLogEntry[]> {
  const qs = limit !== undefined ? `?limit=${limit}` : '';
  return apiClient
    .get<{ entries: AutomationLogEntry[] }>(`/automation/log${qs}`)
    .then((r) => r.entries);
}

// Phase H — cron job health (§8.10's other half), backed by real
// automation_run_log rows now that routes/automationMaintenance.ts
// exists. Failing to load this should never block the toggle panel
// itself rendering — callers treat this as best-effort supplementary
// data, same posture AutomationToggles.tsx takes toward it.
export function fetchAutomationHealth(): Promise<AutomationHealthEntry[]> {
  return apiClient
    .get<{ runs: AutomationHealthEntry[] }>('/automation/health')
    .then((r) => r.runs);
}
