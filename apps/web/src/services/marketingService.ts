// Web-side marketingService — wraps apps/api/src/routes/marketing.ts
// (PRD §8.9). GET /marketing → { items }, unwrapped here same as
// knowledgeService.ts's { entries } pattern. GET /marketing/:id returns
// the calendar entry plus its three stage tasks directly (no wrapper),
// same shape as goalService's getGoalWithProgress.
import { apiClient } from './apiClient';
import type {
  CreateMarketingContentInput,
  MarketingContentInput,
  MarketingContentItem,
  MarketingContentListQuery,
  MarketingContentWithStages,
  MarketingStage,
  Task,
  TaskStatus,
} from '@nexus/shared';

export function fetchMarketingContent(query: MarketingContentListQuery = {}): Promise<MarketingContentItem[]> {
  const params = new URLSearchParams();
  if (query.status) params.set('status', query.status);
  if (query.platform) params.set('platform', query.platform);
  if (query.includeArchived) params.set('includeArchived', 'true');
  const qs = params.toString();
  return apiClient.get<{ items: MarketingContentItem[] }>(`/marketing${qs ? `?${qs}` : ''}`).then((res) => res.items);
}

export function fetchMarketingContentItem(id: string): Promise<MarketingContentWithStages> {
  return apiClient.get<MarketingContentWithStages>(`/marketing/${id}`);
}

export function createMarketingContentItem(
  input: CreateMarketingContentInput
): Promise<MarketingContentWithStages> {
  return apiClient.post<MarketingContentWithStages>('/marketing', input);
}

export function updateMarketingContentItem(
  id: string,
  input: Partial<MarketingContentInput>
): Promise<MarketingContentItem> {
  return apiClient.patch<MarketingContentItem>(`/marketing/${id}`, input);
}

// Reassign/reschedule/re-status a single stage without touching the
// other two — the "swap the editor" / "mark script done" case.
export function updateMarketingStage(
  contentId: string,
  stage: MarketingStage,
  input: { assignedToUserId?: string; deadline?: string; status?: TaskStatus }
): Promise<Task> {
  return apiClient.patch<Task>(`/marketing/${contentId}/stages/${stage}`, input);
}

// Archives, never hard-deletes — same contract as archiveKnowledgeEntry.
export function archiveMarketingContentItem(id: string): Promise<MarketingContentItem> {
  return apiClient.delete<MarketingContentItem>(`/marketing/${id}`);
}
