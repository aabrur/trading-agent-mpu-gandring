import { randomBytes } from 'node:crypto';
import { verifyTypedData, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { registerSecrets, safe } from '../redact.js';
import type { Network, Venue } from './contracts.js';
import { fetchVenueJson, looksLikeMnemonicSeed, VENUE_LABELS } from './execution/adapters/types.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
const AGENT_NAME = 'mpugandring';
export const ASTER_BNB_CHAIN_ID = 56;
const CHALLENGE_TTL_MS = 10 * 60_000;

export interface ApprovalTypedData {
  domain: {
    name: string;
    version: string;
    chainId: number;
    verifyingContract: typeof ZERO_ADDRESS;
  };
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface ApprovalChallenge {
  challengeId: string;
  venue: 'aster' | 'hyperliquid';
  network: Network;
  mainAddress: string;
  agentAddress: string;
  typedData: ApprovalTypedData;
  expiresInSec: number;
  note: string;
}

export interface WalletResult {
  ok: boolean;
  venue: 'aster' | 'hyperliquid';
  network: Network;
  mainAddress: string;
  agentAddress: string;
  note: string;
}

export interface WalletStartParams {
  network?: Network;
  mainAddress: string;
  chainId: number;
}

export interface PersistedDelegatedSecret {
  venue: 'aster' | 'hyperliquid';
  network: Network;
  mainAddress: string;
  agentAddress: string;
  agentPrivateKey: string;
}

export interface WalletServiceOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  verifyDelegatedAgent?: (params: {
    venue: 'aster' | 'hyperliquid';
    network: Network;
    mainAddress: string;
    agentAddress: string;
    agentPrivateKey: string;
  }) => Promise<{ ok: boolean; detail: string }>;
  persistDelegatedSecret?: (record: PersistedDelegatedSecret) => Promise<void>;
}

interface PendingWalletChallenge {
  challengeId: string;
  venue: 'aster' | 'hyperliquid';
  network: Network;
  mainAddress: Hex;
  agentAddress: Hex;
  agentPrivateKey: Hex;
  typedData: ApprovalTypedData;
  submitPayload: Record<string, unknown>;
  expiresAt: number;
}

export function findSecretLikePayload(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (
      /(^|[^0-9a-fA-F])(0x)?[0-9a-fA-F]{64}([^0-9a-fA-F]|$)/.test(value) &&
      !/^0x[0-9a-fA-F]{130}$/.test(value)
    ) {
      return 'a raw 32-byte private key';
    }
    if (looksLikeMnemonicSeed(value)) {
      return 'a mnemonic seed phrase';
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findSecretLikePayload(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/private|secret|seed|mnemonic/i.test(k)) {
        return `a prohibited secret field named ${k}`;
      }
      const hit = findSecretLikePayload(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export function buildHyperliquidApproval(
  network: Network,
  agentAddress: string,
  chainId: number,
  nonce: number
): { action: Record<string, unknown>; typedData: ApprovalTypedData; nonce: number } {
  const hyperliquidChain = network === 'mainnet' ? 'Mainnet' : 'Testnet';
  const action = {
    type: 'approveAgent',
    signatureChainId: `0x${chainId.toString(16)}`,
    hyperliquidChain,
    agentAddress,
    agentName: AGENT_NAME,
    nonce
  };
  const typedData: ApprovalTypedData = {
    domain: {
      name: 'HyperliquidSignTransaction',
      version: '1',
      chainId,
      verifyingContract: ZERO_ADDRESS
    },
    types: {
      'HyperliquidTransaction:ApproveAgent': [
        { name: 'hyperliquidChain', type: 'string' },
        { name: 'agentAddress', type: 'address' },
        { name: 'agentName', type: 'string' },
        { name: 'nonce', type: 'uint64' }
      ]
    },
    primaryType: 'HyperliquidTransaction:ApproveAgent',
    message: {
      hyperliquidChain,
      agentAddress,
      agentName: AGENT_NAME,
      nonce
    }
  };
  return { action, typedData, nonce };
}

export function buildAsterApproval(
  mainAddress: string,
  agentAddress: string,
  nonce: number,
  expiredMs: number,
  network: Network
): { params: Array<[string, string]>; typedData: ApprovalTypedData } {
  const asterChain = network === 'mainnet' ? 'Mainnet' : 'Testnet';
  const params: Array<[string, string]> = [
    ['agentName', AGENT_NAME],
    ['agentAddress', agentAddress],
    ['ipWhitelist', ''],
    ['expired', String(expiredMs)],
    ['canSpotTrade', 'false'],
    ['canPerpTrade', 'true'],
    ['canWithdraw', 'false'],
    ['asterChain', asterChain],
    ['user', mainAddress],
    ['nonce', String(nonce)]
  ];
  const typedData: ApprovalTypedData = {
    domain: {
      name: 'AsterSignTransaction',
      version: '1',
      chainId: ASTER_BNB_CHAIN_ID,
      verifyingContract: ZERO_ADDRESS
    },
    types: {
      ApproveAgent: [
        { name: 'AgentName', type: 'string' },
        { name: 'AgentAddress', type: 'string' },
        { name: 'IpWhitelist', type: 'string' },
        { name: 'Expired', type: 'uint256' },
        { name: 'CanSpotTrade', type: 'bool' },
        { name: 'CanPerpTrade', type: 'bool' },
        { name: 'CanWithdraw', type: 'bool' },
        { name: 'AsterChain', type: 'string' },
        { name: 'User', type: 'string' },
        { name: 'Nonce', type: 'uint256' }
      ]
    },
    primaryType: 'ApproveAgent',
    message: {
      AgentName: AGENT_NAME,
      AgentAddress: agentAddress,
      IpWhitelist: '',
      Expired: expiredMs,
      CanSpotTrade: false,
      CanPerpTrade: true,
      CanWithdraw: false,
      AsterChain: asterChain,
      User: mainAddress,
      Nonce: nonce
    }
  };
  return { params, typedData };
}

const HL_BASE_URL: Record<Network, string> = {
  mainnet: 'https://api.hyperliquid.xyz',
  testnet: 'https://api.hyperliquid-testnet.xyz'
};

const ASTER_BASE_URL: Record<Network, string> = {
  mainnet: 'https://fapi.asterdex.com',
  testnet: 'https://fapi.asterdex-testnet.com'
};

export class WalletService {
  private readonly pending = new Map<string, PendingWalletChallenge>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly verifyDelegatedAgent?: WalletServiceOptions['verifyDelegatedAgent'];
  private readonly persistDelegatedSecret?: WalletServiceOptions['persistDelegatedSecret'];

  constructor(options: WalletServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => Date.now());
    this.verifyDelegatedAgent = options.verifyDelegatedAgent;
    this.persistDelegatedSecret = options.persistDelegatedSecret;
  }

  private pruneExpired(): void {
    const nowMs = this.now();
    for (const [id, entry] of this.pending.entries()) {
      if (entry.expiresAt <= nowMs) {
        this.pending.delete(id);
      }
    }
  }

  async start(
    venue: 'aster' | 'hyperliquid',
    params?: WalletStartParams
  ): Promise<ApprovalChallenge> {
    this.pruneExpired();

    if (venue !== 'aster' && venue !== 'hyperliquid') {
      throw new Error(`${VENUE_LABELS[venue as Venue] ?? venue} does not support browser signature agent approval`);
    }

    const mainAddress = params?.mainAddress?.trim() ?? '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(mainAddress)) {
      throw new Error('Main wallet address must be a valid 20-byte 0x EVM address');
    }

    const chainId = params?.chainId ?? 0;
    if (!Number.isInteger(chainId) || chainId <= 0) {
      throw new Error('Connected wallet chainId is required');
    }

    if (venue === 'aster' && chainId !== ASTER_BNB_CHAIN_ID) {
      throw new Error(`Aster agent approval requires BNB Chain (chainId ${ASTER_BNB_CHAIN_ID}), got ${chainId}`);
    }

    const network: Network = params?.network ?? 'testnet';
    const agentPrivateKey = generatePrivateKey();
    registerSecrets([agentPrivateKey]);
    const agentAddress = privateKeyToAccount(agentPrivateKey).address;
    const challengeId = randomBytes(16).toString('hex');
    const nowMs = this.now();

    let typedData: ApprovalTypedData;
    let submitPayload: Record<string, unknown>;

    if (venue === 'hyperliquid') {
      const built = buildHyperliquidApproval(network, agentAddress, chainId, nowMs);
      typedData = built.typedData;
      submitPayload = { action: built.action, nonce: built.nonce };
    } else {
      const built = buildAsterApproval(
        mainAddress,
        agentAddress,
        nowMs * 1000,
        nowMs + 180 * 86_400_000,
        network
      );
      typedData = built.typedData;
      submitPayload = { params: built.params };
    }

    this.pending.set(challengeId, {
      challengeId,
      venue,
      network,
      mainAddress: mainAddress as Hex,
      agentAddress,
      agentPrivateKey,
      typedData,
      submitPayload,
      expiresAt: nowMs + CHALLENGE_TTL_MS
    });

    // Never include agentPrivateKey in the returned challenge object.
    return {
      challengeId,
      venue,
      network,
      mainAddress,
      agentAddress,
      typedData,
      expiresInSec: CHALLENGE_TTL_MS / 1000,
      note: 'Trade-only delegated agent key generated locally. Cannot withdraw; main wallet key stays in your wallet.'
    };
  }

  async approve(challengeId: string, signature: string): Promise<WalletResult> {
    const entry = this.pending.get(challengeId);
    if (!entry || entry.expiresAt <= this.now()) {
      this.pending.delete(challengeId);
      throw new Error('Approval challenge expired, already used, or unknown');
    }

    if (!/^0x[0-9a-fA-F]{130}$/.test(signature.trim())) {
      throw new Error('Signature must be a 65-byte 0x hex string');
    }

    const sigHex = signature.trim() as Hex;
    const valid = await verifyTypedData({
      address: entry.mainAddress,
      domain: entry.typedData.domain,
      types: entry.typedData.types,
      primaryType: entry.typedData.primaryType,
      message: entry.typedData.message,
      signature: sigHex
    } as never);

    if (!valid) {
      throw new Error('Signature does not match the connected main owner wallet address');
    }

    // Consume challenge before network submission to prevent concurrent replay.
    this.pending.delete(challengeId);

    if (entry.venue === 'hyperliquid') {
      const sigObj = {
        r: `0x${sigHex.slice(2, 66)}`,
        s: `0x${sigHex.slice(66, 130)}`,
        v: Number.parseInt(sigHex.slice(130, 132), 16)
      };
      const resp = (await fetchVenueJson(
        this.fetchImpl,
        `${HL_BASE_URL[entry.network]}/exchange`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...entry.submitPayload, signature: sigObj })
        }
      )) as { status?: string; response?: unknown };
      if (resp?.status !== 'ok') {
        throw new Error(safe(`Hyperliquid refused agent approval: ${JSON.stringify(resp).slice(0, 140)}`));
      }
    } else {
      const query = new URLSearchParams([
        ...(entry.submitPayload.params as Array<[string, string]>),
        ['signature', sigHex],
        ['signatureChainId', String(ASTER_BNB_CHAIN_ID)]
      ]);
      const resp = (await fetchVenueJson(
        this.fetchImpl,
        `${ASTER_BASE_URL[entry.network]}/fapi/v3/approveAgent?${query.toString()}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' }
        }
      )) as { code?: number; msg?: string };
      if (resp && typeof resp.code === 'number' && resp.code < 0) {
        throw new Error(safe(`Aster refused agent approval: ${resp.msg ?? resp.code}`));
      }
    }

    if (this.verifyDelegatedAgent) {
      const verified = await this.verifyDelegatedAgent({
        venue: entry.venue,
        network: entry.network,
        mainAddress: entry.mainAddress,
        agentAddress: entry.agentAddress,
        agentPrivateKey: entry.agentPrivateKey
      });
      if (!verified.ok) {
        throw new Error(safe(`Delegated agent verification failed after venue accept: ${verified.detail}`));
      }
    }

    if (this.persistDelegatedSecret) {
      await this.persistDelegatedSecret({
        venue: entry.venue,
        network: entry.network,
        mainAddress: entry.mainAddress,
        agentAddress: entry.agentAddress,
        agentPrivateKey: entry.agentPrivateKey
      });
    }

    return {
      ok: true,
      venue: entry.venue,
      network: entry.network,
      mainAddress: entry.mainAddress,
      agentAddress: entry.agentAddress,
      note: 'Delegated trade-only agent key verified and stored server-side.'
    };
  }
}
