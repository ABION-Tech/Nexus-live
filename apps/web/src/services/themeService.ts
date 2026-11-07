// Session 50 — PRD §14 light/dark toggle. Split from authService.ts on
// purpose: authService.ts owns session identity/login, this owns a
// self-service setting — same file boundary the API side draws between
// routes/auth.ts and routes/userPreferences.ts.
import { apiClient } from './apiClient';
import type { ThemePreference } from '@nexus/shared';

export function patchThemePreference(themePreference: ThemePreference): Promise<{ themePreference: ThemePreference }> {
  return apiClient.patch<{ themePreference: ThemePreference }>('/preferences/theme', { themePreference });
}
