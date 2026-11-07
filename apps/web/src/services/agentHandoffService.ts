// Web-side agentHandoffService — wraps apps/api/src/routes/agentHandoffs.ts
// (PRD §8.8 / §10.6 AI Analyst > Agent Handoff). GET unwraps `.handoffs`
// (list-wrapping convention, matches goalService/networkService); POST
// returns the created AgentHandoff directly (single-resource convention,
// matches chatService.ts's sendChatMessage).
import { apiClient } from './apiClient';
import type { AgentHandoff, CreateAgentHandoffInput } from '@nexus/shared';

export function fetchAgentHandoffs(): Promise<AgentHandoff[]> {
  return apiClient.get<{ handoffs: AgentHandoff[] }>('/agent-handoffs').then((res) => res.handoffs);
}

export function createAgentHandoff(input: CreateAgentHandoffInput): Promise<AgentHandoff> {
  return apiClient.post<AgentHandoff>('/agent-handoffs', input);
}
