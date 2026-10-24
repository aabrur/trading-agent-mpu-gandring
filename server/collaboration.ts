import type { AgentId } from './types.js';
import { AGENT_IDS } from './config.js';
import { normSymbol } from './commands.js';

export interface TeammateRequest { to: AgentId; question: string; symbol?: string | null }
export interface HandoffResult { agent: AgentId; reply: string; status: 'completed' | 'failed' | 'cancelled'; durationMs: number; error?: string }

/** Only current authored prose is eligible, never quoted examples or fenced data. */
function authored(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').replace(/"[^"\n]*"|“[^”\n]*”/g, '')
    .split('\n').filter(line => !/^\s*>/.test(line)).join('\n');
}

export function ownerTargets(message: string): (AgentId | 'all')[] {
  if (/\b(contoh|example|quoted|kutipan|jangan|don't|do not)\b/i.test(message)) return [];
  const text = authored(message);
  const mentions = [...text.matchAll(/@(all|desk|lead|market|research|strategist|risk|execution)\b/gi)]
    .map(match => /^(all|desk)$/i.test(match[1]) ? 'all' as const : match[1].toLowerCase() as AgentId);
  if (mentions.length) return [...new Set(mentions)];
  if (!/\b(tanya\w*|diskusi\w*|minta|consult|ask|discuss|menurut)\b/i.test(text)) return [];
  if (/\b(semua\s+agen[ts]?|semua\s+agent|seluruh\s+tim|all\s+(agents|team))\b/i.test(text)) return ['all'];
  return AGENT_IDS.filter(id => new RegExp(`\\b${id}\\b`, 'i').test(text));
}

export function teammateRequests(output: { reply: string; askTeammate?: TeammateRequest | null; askTeammates?: TeammateRequest[] | null }, from: AgentId): TeammateRequest[] {
  const structured = [...(output.askTeammates ?? []), ...(output.askTeammate ? [output.askTeammate] : [])];
  const requests: TeammateRequest[] = structured.length ? structured : [...authored(output.reply).matchAll(/^\s*@(lead|market|research|strategist|risk|execution):\s*(.{1,2000})$/gm)]
    .map(match => ({ to: match[1] as AgentId, question: match[2].trim() }));
  const targets = new Set<AgentId>();
  return requests.filter(request => {
    if (!AGENT_IDS.includes(request.to) || request.to === from || !request.question.trim() || targets.has(request.to)) return false;
    targets.add(request.to); return true;
  }).slice(0, 5);
}

const names: Record<string, string> = { bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', cardano: 'ADA', dogecoin: 'DOGE', avalanche: 'AVAX', ripple: 'XRP', chainlink: 'LINK', sui: 'SUI', bnb: 'BNB', near: 'NEAR', aptos: 'APT', pepe: 'PEPE' };
export function conversationSymbols(message: string, known: string[]): string[] {
  const allowed = new Set([...known.map(normSymbol), ...Object.values(names).map(normSymbol)]);
  const words = authored(message).match(/\b[A-Za-z0-9]{2,24}\b/g) ?? [];
  return [...new Set(words.flatMap(word => {
    const symbol = normSymbol(names[word.toLowerCase()] ?? word);
    return allowed.has(symbol) || /^[A-Z0-9]{2,20}(USDT|USDC)$/i.test(word) ? [symbol] : [];
  }))];
}

export function capitalAndSlots(canOpen: boolean | null, count: number, maxPositions: number) {
  const freeSlots = Math.max(0, maxPositions - count);
  return { hasTradableCapital: canOpen, openPositionsCount: count, maxPositions, freeSlots, canOpenNewSlot: freeSlots > 0 };
}
