import { randomUUID } from 'node:crypto';
import { AGENT_IDS } from './config.js';
import type { AgentId, ChatLine } from './types.js';
import type { Command } from './commands.js';

export interface ChatResult { ok: boolean; reply: string; command: Command['type']; requestId?: string; failureKind?: string }
export interface ChatRequest {
  id: string; agentId: AgentId; conversationId: string; messageId: string; text: string;
  startedAt: number; completedAt?: number; status: 'pending' | 'model_working' | 'waiting_on_venue' | 'consulting' | 'completed' | 'failed' | 'cancelled';
  result?: ChatResult;
}
export interface ChatRun {
  id: string; runtimeId: string; accountScope: string; startedAt: number; endedAt: number | null;
  recovered?: boolean; legacy?: boolean;
  chats: Record<AgentId, ChatLine[]>; requests: ChatRequest[];
}
export function emptyChats(): Record<AgentId, ChatLine[]> {
  return Object.fromEntries(AGENT_IDS.map(id => [id, [] as ChatLine[]])) as Record<AgentId, ChatLine[]>;
}
export function newChatRun(runtimeId: string, accountScope: string): ChatRun {
  return { id: `run-${randomUUID()}`, runtimeId, accountScope, startedAt: Date.now(), endedAt: null, chats: emptyChats(), requests: [] };
}

/** Recover interrupted requests as failures. A restart never silently replays a command. */
export function recoverChatRun(run: ChatRun, unclean = true) {
  if (unclean) run.recovered = true;
  for (const request of run.requests) {
    if (request.result) continue;
    request.status = 'cancelled'; request.completedAt = Date.now();
    request.result = { ok: false, reply: 'Application stopped before this request completed. Check any order result before sending a new request.', command: 'chat', requestId: request.id, failureKind: 'cancelled' };
    if (!run.chats[request.agentId].some(m => m.id === `${request.id}:result`)) run.chats[request.agentId].push({ id: `${request.id}:result`, from: 'system', text: request.result.reply, at: request.completedAt, conversationId: request.conversationId, clientRequestId: request.id, operationalSessionId: run.id, status: 'cancelled' });
  }
}
