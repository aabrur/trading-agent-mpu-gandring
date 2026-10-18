// Connect wallet (EXPERIMENTAL, untested on real wallets). Local mode only, office bound to 127.0.0.1.
// The browser wallet (EIP-1193, e.g. MetaMask or Rabby) is used for two things only:
//   1. reading the MAIN wallet address (public, for display and for .env), and
//   2. signing ONE approval that lets a fresh, locally generated agent key trade for that address.
// The main wallet private key or seed is never requested, exported, sent or stored. The agent key is
// generated here, on the server, kept in memory until the approval succeeds, then written to .env (chmod 600).
// Agents approved this way can trade but cannot withdraw (Hyperliquid agent wallets by design,
// Aster with canWithdraw=false forced). Other venues get manual steps.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData, type Hex } from 'viem';
import { randomBytes } from 'node:crypto';
import { envNames, makeAdapter, VENUE_KIND, VENUE_LABEL, httpJson, type ExchangeName, type FetchLike, type Network } from './exchange/index.js';
import { readEnv, setEnv } from '../cli/envfile.js';
import { registerSecrets } from './redact.js';
import { looksLikeSeed } from './live/steps.js';
import { HyperliquidAdapter } from './exchange/hyperliquid.js';
import { AsterAdapter } from './exchange/aster.js';

export type WalletSupport = 'signature' | 'manual' | 'cex';
export interface VenueWalletInfo { venue: ExchangeName; label: string; kind: 'CEX' | 'DEX'; support: WalletSupport; steps: string[]; revokeUrl: string | null; docsUrl: string; depositUrl: string }

const ZERO = '0x0000000000000000000000000000000000000000' as const;
const AGENT_NAME = 'mpugandring';
export const ASTER_SIGNATURE_CHAIN_ID = 56; // per Aster docs: signatureChainId 56 for EVM addresses
const PENDING_TTL_MS = 10 * 60_000;

export const WALLET_GUIDE: Record<ExchangeName, Omit<VenueWalletInfo, 'venue' | 'label' | 'kind'>> = {
  hyperliquid: { support: 'signature', revokeUrl: 'https://app.hyperliquid.xyz/API', docsUrl: 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets', depositUrl: 'https://app.hyperliquid.xyz/portfolio',
    steps: ['Connect your wallet: main address is read for display only.', 'The app makes a fresh agent key on this computer and shows its address.', 'Sign "ApproveAgent" in your wallet. Agent wallets can trade but cannot withdraw.', 'The agent key and your main address are saved to .env with chmod 600. Restart the office to use them.'] },
  aster: { support: 'signature', revokeUrl: 'https://www.asterdex.com/en/api-wallet', docsUrl: 'https://github.com/asterdex/api-docs', depositUrl: 'https://www.asterdex.com/en/portfolio',
    steps: ['Connect your wallet on BNB Chain: Aster signs approvals with chain id 56.', 'The app makes a fresh agent key on this computer and shows its address.', 'Sign the registerAndApproveAgent message: perp trading on, spot off, withdraw OFF forced.', 'The agent key and your main address are saved to .env with chmod 600. Restart the office to use them.'] },
  dydx: { support: 'manual', revokeUrl: 'https://dydx.trade', docsUrl: 'https://help.dydx.trade/en/articles/267486-api-trading-keys-creating-a-new-key-on-the-front-end', depositUrl: 'https://dydx.trade/portfolio',
    steps: ['dYdX has no browser-signature agent approval this app can use.', 'In the dYdX app open More, API Trading Keys, and create a key: trade only.', 'Copy your dydx1 address, the API key private key and the authenticator id.', 'Run npm run setup, pick dydx, paste them. Also run npm install @dydxprotocol/v4-client-js.'] },
  paradex: { support: 'manual', revokeUrl: 'https://app.paradex.trade', docsUrl: 'https://docs.paradex.trade/api/general-information/api-authentication', depositUrl: 'https://app.paradex.trade/portfolio',
    steps: ['Paradex uses Starknet subkeys, not an EVM wallet approval.', 'In the Paradex app create a subkey. Subkeys can trade but cannot withdraw or transfer.', 'Copy your Paradex account address and the subkey private key.', 'Run npm run setup, pick paradex, paste them.'] },
  orderly: { support: 'manual', revokeUrl: 'https://orderly.network/docs/build-on-omnichain/user-flows/wallet-authentication', docsUrl: 'https://orderly.network/docs/build-on-omnichain/user-flows/wallet-authentication', depositUrl: 'https://app.orderly.network',
    steps: ['Create an Orderly key with scope read,trading in an Orderly-based app or with the add-orderly-key flow.', 'Orderly keys cannot withdraw; withdrawals need your wallet signature.', 'Copy your Orderly account id and the Orderly key secret: base58.', 'Run npm run setup, pick orderly, paste them.'] },
  bybit: { support: 'cex', revokeUrl: null, docsUrl: 'https://www.bybit.com/app/user/api-management', depositUrl: 'https://www.bybit.com/user/assets/deposit', steps: ['No wallet for a CEX.', 'Create an API key: Contract trade only, withdrawals OFF, IP whitelist recommended.', 'Run npm run setup, pick bybit, paste the key and secret.'] },
  binance: { support: 'cex', revokeUrl: null, docsUrl: 'https://www.binance.com/en/my/settings/api-management', depositUrl: 'https://www.binance.com/en/my/wallet/account/main/deposit/crypto/USDT', steps: ['No wallet for a CEX.', 'Create an API key: futures on, withdrawals OFF, IP restriction recommended.', 'Run npm run setup, pick binance, paste the key and secret.'] },
  okx: { support: 'cex', revokeUrl: null, docsUrl: 'https://www.okx.com/account/my-api', depositUrl: 'https://www.okx.com/balance/recharge', steps: ['No wallet for a CEX.', 'Create an API key with Trade permission only, no Withdraw, IP whitelist recommended.', 'Run npm run setup, pick okx, paste key, secret and passphrase.'] }
};
export const walletInfo = (venue: ExchangeName): VenueWalletInfo => ({ venue, label: VENUE_LABEL[venue], kind: VENUE_KIND[venue], ...WALLET_GUIDE[venue] });

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** Connect wallet works only in local mode, with the office bound to loopback, for a loopback client with a localhost Host header. */
export function walletAccess(o: { appMode: string; host: string; remoteAddress?: string | null; hostHeader?: string | null; origin?: string | null }): { ok: boolean; reason: string } {
  if (o.appMode === 'grokbot') return { ok: false, reason: 'Grok Bot mode: keys go in through the Grok Bot secret card, not the browser. Connect wallet is off.' };
  if (!(o.host === '127.0.0.1' || o.host === 'localhost' || o.host === '::1')) return { ok: false, reason: `the office is bound to ${o.host}. Connect wallet works only when it is bound to 127.0.0.1 (set HOST=127.0.0.1).` };
  if (!o.remoteAddress || !LOOPBACK.has(o.remoteAddress)) return { ok: false, reason: 'only available from this computer (localhost).' };
  const hostOk = (h: string) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(h);
  if (!o.hostHeader || !hostOk(o.hostHeader)) return { ok: false, reason: 'open the office at http://127.0.0.1 or http://localhost to use Connect wallet.' };
  if (o.origin && !hostOk(o.origin.replace(/^https?:\/\//, ''))) return { ok: false, reason: 'cross-origin request refused.' };
  return { ok: true, reason: 'local' };
}

/** Anything in a request body that looks like a private key or a seed phrase is refused outright. */
export function findSecretLike(v: unknown, depth = 0): string | null {
  if (depth > 4 || v == null) return null;
  if (typeof v === 'string') {
    if (/(^|[^0-9a-fA-F])(0x)?[0-9a-fA-F]{64}([^0-9a-fA-F]|$)/.test(v) && !/^0x[0-9a-fA-F]{130}$/.test(v)) return 'a private key';
    if (looksLikeSeed(v)) return 'a seed phrase';
    return null;
  }
  if (Array.isArray(v)) { for (const x of v) { const r = findSecretLike(x, depth + 1); if (r) return r; } return null; }
  if (typeof v === 'object') { for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (/private|secret|seed|mnemonic/i.test(k)) return `a field named ${k}`; const r = findSecretLike(x, depth + 1); if (r) return r; } }
  return null;
}

export interface TypedData { domain: { name: string; version: string; chainId: number; verifyingContract: typeof ZERO }; types: Record<string, { name: string; type: string }[]>; primaryType: string; message: Record<string, unknown> }
interface Pending { id: string; venue: 'hyperliquid' | 'aster'; network: Network; main: Hex; agentKey: Hex; agentAddress: Hex; typedData: TypedData; submit: Record<string, unknown>; until: number }

/** Hyperliquid approveAgent (user-signed action, HyperliquidSignTransaction domain). */
export function hyperliquidApproval(network: Network, agentAddress: string, chainId: number, nonce = Date.now()) {
  const action = { type: 'approveAgent', signatureChainId: `0x${chainId.toString(16)}`, hyperliquidChain: network === 'mainnet' ? 'Mainnet' : 'Testnet', agentAddress, agentName: AGENT_NAME, nonce };
  const typedData: TypedData = {
    domain: { name: 'HyperliquidSignTransaction', version: '1', chainId, verifyingContract: ZERO },
    types: { 'HyperliquidTransaction:ApproveAgent': [{ name: 'hyperliquidChain', type: 'string' }, { name: 'agentAddress', type: 'address' }, { name: 'agentName', type: 'string' }, { name: 'nonce', type: 'uint64' }] },
    primaryType: 'HyperliquidTransaction:ApproveAgent',
    message: { hyperliquidChain: action.hyperliquidChain, agentAddress, agentName: AGENT_NAME, nonce }
  };
  return { action, typedData, nonce };
}

/** Aster registerAndApproveAgent: canWithdraw is always false, spot off, perp on. */
export function asterApproval(user: string, agentAddress: string, nonce = Date.now() * 1000, expiredMs = Date.now() + 180 * 86_400_000) {
  const params: [string, string][] = [
    ['user', user], ['nonce', String(nonce)], ['agentName', AGENT_NAME], ['agentAddress', agentAddress], ['expired', String(expiredMs)],
    ['signatureChainId', String(ASTER_SIGNATURE_CHAIN_ID)], ['canSpotTrade', 'false'], ['canPerpTrade', 'true'], ['canWithdraw', 'false'], ['ipWhitelist', '']
  ];
  const msg = params.map(([k, v]) => `${k}=${v}`).join('&');
  const typedData: TypedData = { domain: { name: 'AsterSignTransaction', version: '1', chainId: ASTER_SIGNATURE_CHAIN_ID, verifyingContract: ZERO }, types: { Message: [{ name: 'msg', type: 'string' }] }, primaryType: 'Message', message: { msg } };
  return { params, msg, typedData };
}

const HL_BASE: Record<Network, string> = { mainnet: 'https://api.hyperliquid.xyz', testnet: 'https://api.hyperliquid-testnet.xyz' };
const ASTER_BASE: Record<Network, string> = { mainnet: 'https://fapi.asterdex.com', testnet: 'https://fapi.asterdex-testnet.com' };

export class WalletConnector {
  private pending = new Map<string, Pending>();
  constructor(private opts: { envFile: string; fetchImpl?: FetchLike; now?: () => number; sleep?: (ms: number) => Promise<void>; verifyTries?: number } = { envFile: '.env' }) {}
  private now() { return this.opts.now?.() ?? Date.now(); }

  /** Step 1: fresh agent key on this computer, typed data for the wallet to sign. The agent key never leaves the server. */
  start(venue: ExchangeName, network: Network, mainAddress: string, chainId: number) {
    if (WALLET_GUIDE[venue].support !== 'signature') throw new Error(`${VENUE_LABEL[venue]} has no signature-based agent approval here. Follow the manual steps.`);
    if (!/^0x[0-9a-fA-F]{40}$/.test(mainAddress)) throw new Error('main wallet address must be a 0x address');
    for (const [id, p] of this.pending) if (p.until < this.now()) this.pending.delete(id);
    const agentKey = generatePrivateKey();
    const agentAddress = privateKeyToAccount(agentKey).address;
    const id = randomBytes(16).toString('hex');
    let typedData: TypedData, submit: Record<string, unknown>;
    if (venue === 'hyperliquid') {
      if (!Number.isInteger(chainId) || chainId <= 0) throw new Error('wallet chain id missing');
      const a = hyperliquidApproval(network, agentAddress, chainId, this.now());
      typedData = a.typedData; submit = { action: a.action, nonce: a.nonce };
    } else {
      const a = asterApproval(mainAddress, agentAddress, this.now() * 1000);
      typedData = a.typedData; submit = { params: a.params };
    }
    this.pending.set(id, { id, venue: venue as 'hyperliquid' | 'aster', network, main: mainAddress as Hex, agentKey, agentAddress, typedData, submit, until: this.now() + PENDING_TTL_MS });
    return { id, agentAddress, typedData, expiresInSec: PENDING_TTL_MS / 1000, note: 'Trade only, cannot withdraw. Your main wallet key never leaves your wallet.' };
  }

  /** Step 2: check the signature is from the main address, submit it to the venue, then save the agent key to .env. */
  async approve(id: string, signature: string) {
    const p = this.pending.get(id);
    if (!p || p.until < this.now()) { this.pending.delete(id); throw new Error('approval expired or unknown. Start again.'); }
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('signature must be a 65-byte hex signature');
    const valid = await verifyTypedData({ address: p.main, domain: p.typedData.domain, types: p.typedData.types, primaryType: p.typedData.primaryType, message: p.typedData.message, signature: signature as Hex } as never);
    if (!valid) throw new Error('signature does not match the connected main wallet address');
    const f = this.opts.fetchImpl ?? fetch;
    if (p.venue === 'hyperliquid') {
      const sig = { r: `0x${signature.slice(2, 66)}`, s: `0x${signature.slice(66, 130)}`, v: parseInt(signature.slice(130, 132), 16) };
      const r = await httpJson(f, `${HL_BASE[p.network]}/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...p.submit, signature: sig }) });
      if (r?.status !== 'ok') throw new Error(`Hyperliquid refused the approval: ${typeof r?.response === 'string' ? r.response : JSON.stringify(r).slice(0, 160)}`);
    } else {
      const body = new URLSearchParams([...(p.submit.params as [string, string][]), ['signature', signature]]);
      const r = await httpJson(f, `${process.env[p.network === 'testnet' ? 'ASTER_TESTNET_BASE_URL' : 'ASTER_BASE_URL'] || ASTER_BASE[p.network]}/fapi/v3/registerAndApproveAgent`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
      if (r && typeof r.code === 'number' && r.code < 0) throw new Error(`Aster refused the approval: ${r.msg ?? r.code}`);
    }
    // The venue saying "success" is not enough: prove the new agent key works with a signed read before saving anything.
    const check = await this.verifyAgent(p, f);
    if (!check.ok) throw new Error(`the venue accepted the approval, but the new agent key does not work yet (${check.detail}). Nothing was saved. Make sure the main account exists and has a deposit on ${p.network}, then try again.`);
    const n = envNames(p.venue, p.network);
    registerSecrets([p.agentKey]);
    const extra: Record<string, string> = {};
    if (p.venue === 'aster') {
      const pinKey = p.network === 'testnet' ? 'ASTER_TESTNET_AGENT_WITHDRAW_OFF_VERIFIED' : 'ASTER_AGENT_WITHDRAW_OFF_VERIFIED';
      extra[pinKey] = p.agentAddress;
    }
    setEnv(this.opts.envFile, { [n.key]: p.main, [n.secret]: p.agentKey, EXCHANGE: p.venue, ...extra });
    this.pending.delete(id);
    return { ok: true, venue: p.venue, network: p.network, agentAddress: p.agentAddress, mainAddress: p.main, saved: [n.key, n.secret, 'EXCHANGE', ...Object.keys(extra)], note: `Saved to ${this.opts.envFile} (chmod 600). Restart the office (or npm run trade) to use it. Revoke any time: ${WALLET_GUIDE[p.venue].revokeUrl}` };
  }
  /** Signed read with the NEW agent key (Hyperliquid: approved agent list; Aster: signed balance read, then the withdraw flag). */
  private async verifyAgent(p: Pending, f: FetchLike): Promise<{ ok: boolean; detail: string; guard?: string }> {
    const tries = Math.max(1, this.opts.verifyTries ?? 3);
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let last = 'not checked';
    for (let i = 0; i < tries; i++) {
      if (i) await sleep(1000);
      try {
        if (p.venue === 'hyperliquid') {
          const perm = await new HyperliquidAdapter(p.network, p.main, p.agentKey, f).permissions();
          if (perm.ok) return { ok: true, detail: perm.detail };
          last = perm.detail;
        } else {
          const a = new AsterAdapter(p.network, p.main, p.agentKey, f, process.env[p.network === 'testnet' ? 'ASTER_TESTNET_BASE_URL' : 'ASTER_BASE_URL']);
          const ping = await a.ping();
          if (ping.ok) return { ok: true, detail: ping.detail };
          last = ping.detail;
        }
      } catch (e) { last = (e as Error).message; }
    }
    return { ok: false, detail: last.slice(0, 160) };
  }
  /** Read live USDT balance from a DEX or CEX venue using saved trade-only credentials or a public wallet address. */
  async readVenueBalance(venue: ExchangeName, network: Network, address?: string): Promise<{ ok: boolean; venue: ExchangeName; label: string; kind: 'CEX' | 'DEX'; network: Network; configured: boolean; address: string | null; equityUsdt: number | null; availableUsdt: number | null; depositUrl: string; note?: string; error?: string }> {
    const f = this.opts.fetchImpl ?? fetch;
    const fileEnv = readEnv(this.opts.envFile);
    const getVar = (k?: string) => (k ? (fileEnv[k] || process.env[k] || '').trim() : '');
    let activeNet: Network = network;
    let n = envNames(venue, activeNet);
    let savedKey = getVar(n.key);
    let savedSecret = getVar(n.secret);
    let savedPass = getVar(n.passphrase);
    if (!(savedKey && savedSecret)) {
      const altNet: Network = network === 'mainnet' ? 'testnet' : 'mainnet';
      const altNames = envNames(venue, altNet);
      const altKey = getVar(altNames.key);
      const altSecret = getVar(altNames.secret);
      if ((altKey && altSecret) || (!savedKey && altKey)) {
        activeNet = altNet;
        n = altNames;
        savedKey = altKey;
        savedSecret = altSecret;
        savedPass = getVar(altNames.passphrase);
      }
    }
    const addr = (address || '').trim() || (VENUE_KIND[venue] === 'DEX' ? savedKey : '');
    const depositUrl = WALLET_GUIDE[venue].depositUrl;
    const base = { venue, label: VENUE_LABEL[venue], kind: VENUE_KIND[venue], network: activeNet, depositUrl };

    if (venue === 'hyperliquid' && /^0x[0-9a-fA-F]{40}$/.test(addr)) {
      try {
        const s = await httpJson(f, `${HL_BASE[activeNet]}/info`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'clearinghouseState', user: addr }) });
        if (s?.marginSummary?.accountValue == null || s?.withdrawable == null) throw new Error('Incomplete venue balance response');
        const equityUsdt = Number(s.marginSummary.accountValue);
        const availableUsdt = Number(s?.withdrawable ?? 0);
        return { ok: true, ...base, configured: true, address: addr, equityUsdt, availableUsdt };
      } catch (e) {
        return { ok: true, ...base, configured: true, address: addr, equityUsdt: null, availableUsdt: null, note: (e as Error).message };
      }
    }

    if (savedKey && savedSecret) {
      try {
        const adapter = makeAdapter(venue, activeNet, { key: savedKey, secret: savedSecret, passphrase: savedPass || undefined }, f);
        const b = await adapter.balance();
        return { ok: true, ...base, configured: true, address: VENUE_KIND[venue] === 'DEX' ? savedKey : null, equityUsdt: b.equityUsdt, availableUsdt: b.availableUsdt };
      } catch (e) {
        return { ok: true, ...base, configured: true, address: VENUE_KIND[venue] === 'DEX' ? savedKey : null, equityUsdt: null, availableUsdt: null, note: (e as Error).message };
      }
    }

    if (VENUE_KIND[venue] === 'DEX' && addr.length >= 10) {
      return {
        ok: true,
        ...base,
        configured: true,
        address: addr,
        equityUsdt: null,
        availableUsdt: null,
        note: 'Wallet connected. Approve agent key or deposit funds on this venue to trade.'
      };
    }

    return {
      ok: true,
      ...base,
      configured: false,
      address: addr || null,
      equityUsdt: null,
      availableUsdt: null,
      note: VENUE_KIND[venue] === 'DEX'
        ? 'Connect wallet or configure your agent key in Setup to read live balance on this DEX.'
        : 'Configure your trade-only API key in Setup to read live balance on this exchange.'
    };
  }
  /** For tests only. */
  peek(id: string) { const p = this.pending.get(id); return p ? { agentAddress: p.agentAddress, main: p.main, typedData: p.typedData, submit: p.submit } : null; }
}
