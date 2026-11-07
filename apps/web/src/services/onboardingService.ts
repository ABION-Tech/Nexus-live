// Web-side onboardingService — wraps apps/api/src/routes/onboarding.ts
// (PRD §7.2 04 PEOPLE → Onboarding). Same unwrap-the-named-key pattern as
// the rest of services/.
import { apiClient } from './apiClient';
import type { OnboardingChecklistItem, OnboardingStep, OnboardingStepInput } from '@nexus/shared';

export function fetchOnboardingSteps(includeInactive = false): Promise<OnboardingStep[]> {
  const qs = includeInactive ? '?includeInactive=true' : '';
  return apiClient.get<{ steps: OnboardingStep[] }>(`/onboarding/steps${qs}`).then((res) => res.steps);
}

export function createOnboardingStep(input: OnboardingStepInput): Promise<OnboardingStep> {
  return apiClient.post<OnboardingStep>('/onboarding/steps', input);
}

export function updateOnboardingStep(id: string, input: Partial<OnboardingStepInput>): Promise<OnboardingStep> {
  return apiClient.patch<OnboardingStep>(`/onboarding/steps/${id}`, input);
}

export function archiveOnboardingStep(id: string): Promise<OnboardingStep> {
  return apiClient.delete<OnboardingStep>(`/onboarding/steps/${id}`);
}

export function fetchOnboardingChecklist(userId?: string): Promise<OnboardingChecklistItem[]> {
  const qs = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  return apiClient.get<{ checklist: OnboardingChecklistItem[] }>(`/onboarding/checklist${qs}`).then((res) => res.checklist);
}

export function setOnboardingStepCompletion(
  stepId: string,
  completed: boolean,
  userId?: string
): Promise<OnboardingChecklistItem> {
  return apiClient.patch<OnboardingChecklistItem>(`/onboarding/checklist/${stepId}`, { userId, completed });
}
