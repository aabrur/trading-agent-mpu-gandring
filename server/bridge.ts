import { appendFileSync } from 'node:fs';
import type { AppConfig } from './config.js';
import { log, safe } from './redact.js';

// Optional Grok Bot bridge. Server side only. One POST, 8 second timeout, no retry.
// On failure the JSON goes to outbox.jsonl so a routine can drain it later.
export interface BridgeEvent { kind: 'verdict' | 'command' | 'trade' | 'probe' | 'signal' | 'report'; at: number; app: 'trading-agent-mpu-gandring'; mode: 'PAPER' | 'TESTNET' | 'LIVE'; data: Record<string, unknown> }

export async function sendToGrokBot(cfg: AppConfig, kind: BridgeEvent['kind'], data: Record<string, unknown>, outboxPath = 'outbox.jsonl', fetchImpl: typeof fetch = fetch): Promise<'sent' | 'queued' | 'off'> {
  if (!cfg.bridge.enabled) return 'off';
  const event: BridgeEvent = { kind, at: Date.now(), app: 'trading-agent-mpu-gandring', mode: cfg.tradingMode, data: JSON.parse(safe(data)) };
  const body = JSON.stringify(event);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetchImpl(cfg.bridge.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.bridge.key}`, 'X-Automation-Key': cfg.bridge.key },
      body, signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
    return 'sent';
  } catch (e) {
    appendFileSync(outboxPath, body + '\n');
    log(`[bridge] ${kind} not delivered (${safe((e as Error).message)}), queued to ${outboxPath}`);
    return 'queued';
  } finally { clearTimeout(timer); }
}
