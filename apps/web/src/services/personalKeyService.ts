import { apiClient } from './apiClient';

// Session 56 — personal API keys (apps/api/src/routes/personalKeys.ts).
export interface PersonalKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export const listPersonalKeys = () => apiClient.get<{ keys: PersonalKey[] }>('/me/keys').then((r) => r.keys);
export const createPersonalKey = (name: string) => apiClient.post<{ key: PersonalKey; secret: string }>('/me/keys', { name });
export const revokePersonalKey = (id: string) => apiClient.delete<{ ok: true }>(`/me/keys/${id}`);
