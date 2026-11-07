// Web-side knowledgeService — wraps apps/api/src/routes/knowledge.ts
// (PRD §8.6). GET /knowledge → { entries: KnowledgeEntry[] }, unwrapped
// here same as every other list-wrapping route (networkService.ts,
// peopleService.ts pattern).
import { apiClient } from './apiClient';
import type { KnowledgeEntry, KnowledgeEntryInput, KnowledgeListQuery } from '@nexus/shared';

export function fetchKnowledgeEntries(query: KnowledgeListQuery = {}): Promise<KnowledgeEntry[]> {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.category) params.set('category', query.category);
  if (query.includeArchived) params.set('includeArchived', 'true');
  const qs = params.toString();
  return apiClient.get<{ entries: KnowledgeEntry[] }>(`/knowledge${qs ? `?${qs}` : ''}`).then((res) => res.entries);
}

export function fetchKnowledgeEntry(id: string): Promise<KnowledgeEntry> {
  return apiClient.get<KnowledgeEntry>(`/knowledge/${id}`);
}

export function createKnowledgeEntry(input: KnowledgeEntryInput): Promise<KnowledgeEntry> {
  return apiClient.post<KnowledgeEntry>('/knowledge', input);
}

export function updateKnowledgeEntry(id: string, input: Partial<KnowledgeEntryInput>): Promise<KnowledgeEntry> {
  return apiClient.patch<KnowledgeEntry>(`/knowledge/${id}`, input);
}

// Archives, never hard-deletes (PRD §6.4.1) — same contract as
// goalService.archiveGoal / networkService.archivePartnership.
export function archiveKnowledgeEntry(id: string): Promise<KnowledgeEntry> {
  return apiClient.delete<KnowledgeEntry>(`/knowledge/${id}`);
}
