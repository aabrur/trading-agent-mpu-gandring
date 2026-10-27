import { exchangeSettings, ADAPTER_STATUS, type ExchangeAdapter, type ExchangeName, type Network, type PermissionReport } from '../exchange/index.js';
import { safe } from '../redact.js';

// Automatic guards for TESTNET and LIVE. No human input, and no config value turns them off.
// Sync part (config time): exchange chosen, keys present, experimental flag, safety net above zero.
// Async part (setup and every start): the exchange itself says the key cannot withdraw.

export type TradingMode = 'PAPER' | 'TESTNET' | 'LIVE';
export const networkFor = (mode: TradingMode): Network | null => (mode === 'LIVE' ? 'mainnet' : mode === 'TESTNET' ? 'testnet' : null);

export interface ModeCheck { ok: boolean; reasons: string[]; exchange: ExchangeName | null; experimental: boolean }

export function checkTradingMode(env: NodeJS.ProcessEnv, mode: TradingMode): ModeCheck {
  const net = networkFor(mode);
  if (!net) return { ok: true, reasons: [], exchange: null, experimental: false };
  const reasons: string[] = [];
  let ex: ReturnType<typeof exchangeSettings>;
  try { ex = exchangeSettings(env); } catch (e) { return { ok: false, reasons: [(e as Error).message], exchange: null, experimental: false }; }
  if (!ex.name) reasons.push('EXCHANGE is not set');
  else if (!ex.creds[net]) reasons.push(`${net} ${ex.name} keys are missing in .env`);
  const experimental = !!ex.name && ADAPTER_STATUS[ex.name] === 'experimental';
  if (mode === 'LIVE' && experimental && (env.ALLOW_EXPERIMENTAL_LIVE ?? '').trim() !== 'yes') {
    reasons.push(`the ${ex.name} adapter is experimental and unverified; LIVE on it needs ALLOW_EXPERIMENTAL_LIVE=yes`);
  }
  const safety = Number(env.SAFETY_NET ?? 200);
  if (!(safety > 0)) reasons.push('SAFETY_NET must be above zero outside PAPER');
  return { ok: reasons.length === 0, reasons, exchange: ex.name, experimental };
}

/** Aster looked up this signer and does not have it. The office can open so the owner can approve the agent. Trading stays off. */
export function opensOfficeForApproval(detail: string): boolean {
  return /No agent found/i.test(detail);
}

/** Asks the exchange. LIVE needs a verified answer; any key that can withdraw is refused in every mode. */
export async function verifyKey(adapter: ExchangeAdapter): Promise<{ ok: boolean; detail: string; perm: PermissionReport | null }> {
  let perm: PermissionReport;
  try { perm = await adapter.permissions(); } catch (e) { return { ok: false, detail: `could not read key permissions: ${safe((e as Error).message)}`, perm: null }; }
  const detail = safe(perm.detail);
  if (perm.canWithdraw === true || !perm.ok) return { ok: false, detail: `REFUSED: ${detail.replace(/[.\s]+$/, '')}. Use a key with trading only, withdrawals off.`, perm };
  if (adapter.network === 'mainnet' && (!perm.verified || perm.canWithdraw !== false)) return { ok: false, detail: `could not verify that the key cannot withdraw: ${detail}`, perm };
  if (!perm.canTrade) return { ok: false, detail: `key cannot trade: ${detail}`, perm };
  return { ok: true, detail, perm };
}
