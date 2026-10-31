import {
  encodeAbiParameters,
  keccak256,
  stringToBytes,
  type Address,
  type Hex,
  type PublicClient
} from 'viem';

export const WALLET_SESSION_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'MAX_SESSION_DURATION',
    inputs: [],
    outputs: [{ name: '', type: 'uint64' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'epochs',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'sessions',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'agent', type: 'address' },
      { name: 'context', type: 'bytes32' }
    ],
    outputs: [
      { name: 'expiresAt', type: 'uint64' },
      { name: 'epoch', type: 'uint256' }
    ],
    stateMutability: 'view'
  },
  {
    type: 'function',
    name: 'authorize',
    inputs: [
      { name: 'agent', type: 'address' },
      { name: 'context', type: 'bytes32' },
      { name: 'expiresAt', type: 'uint64' }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'revoke',
    inputs: [
      { name: 'agent', type: 'address' },
      { name: 'context', type: 'bytes32' }
    ],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'revokeAll',
    inputs: [],
    outputs: [],
    stateMutability: 'nonpayable'
  },
  {
    type: 'function',
    name: 'isAuthorized',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'agent', type: 'address' },
      { name: 'context', type: 'bytes32' }
    ],
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view'
  }
] as const;

export interface RegistrySessionStatus {
  configured: boolean;
  contractAddress: Address | null;
  chainId: number | null;
  isAuthorized: boolean;
  expiresAt: number | null;
  epoch: bigint | null;
  currentOwnerEpoch: bigint | null;
  isExpired: boolean;
}

export function buildSessionContext(venue: string, network: string, applicationOrigin = 'http://127.0.0.1:8787'): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }, { type: 'string' }],
      [venue.toLowerCase(), network.toLowerCase(), applicationOrigin.toLowerCase()]
    )
  );
}

export function getRegistryConfig(env: Record<string, string | undefined> = process.env): {
  configured: boolean;
  contractAddress: Address | null;
  chainId: number | null;
} {
  const addr = (env.REGISTRY_CONTRACT_ADDRESS ?? '').trim();
  const rawChainId = (env.REGISTRY_CHAIN_ID ?? '').trim();
  const chainId = rawChainId ? Number(rawChainId) : null;

  if (/^0x[0-9a-fA-F]{40}$/.test(addr) && chainId && Number.isInteger(chainId) && chainId > 0) {
    return {
      configured: true,
      contractAddress: addr as Address,
      chainId
    };
  }

  return {
    configured: false,
    contractAddress: null,
    chainId: null
  };
}

export async function readRegistrySession(
  publicClient: PublicClient,
  params: {
    contractAddress: Address;
    owner: Address;
    agent: Address;
    context: Hex;
  }
): Promise<RegistrySessionStatus> {
  const { contractAddress, owner, agent, context } = params;

  try {
    const isAuth = (await publicClient.readContract({
      address: contractAddress,
      abi: WALLET_SESSION_REGISTRY_ABI,
      functionName: 'isAuthorized',
      args: [owner, agent, context]
    })) as boolean;

    const sessionData = (await publicClient.readContract({
      address: contractAddress,
      abi: WALLET_SESSION_REGISTRY_ABI,
      functionName: 'sessions',
      args: [owner, agent, context]
    })) as readonly [bigint, bigint];

    const ownerEpoch = (await publicClient.readContract({
      address: contractAddress,
      abi: WALLET_SESSION_REGISTRY_ABI,
      functionName: 'epochs',
      args: [owner]
    })) as bigint;

    const expiresAtSec = Number(sessionData[0]);
    const sessionEpoch = sessionData[1];
    const nowSec = Math.floor(Date.now() / 1000);
    const isExpired = expiresAtSec <= nowSec;

    return {
      configured: true,
      contractAddress,
      chainId: publicClient.chain?.id ?? null,
      isAuthorized: Boolean(isAuth),
      expiresAt: expiresAtSec > 0 ? expiresAtSec * 1000 : null,
      epoch: sessionEpoch,
      currentOwnerEpoch: ownerEpoch,
      isExpired
    };
  } catch {
    return {
      configured: true,
      contractAddress,
      chainId: publicClient.chain?.id ?? null,
      isAuthorized: false,
      expiresAt: null,
      epoch: null,
      currentOwnerEpoch: null,
      isExpired: true
    };
  }
}

export function prepareAuthorizeTransaction(params: {
  contractAddress: Address;
  agent: Address;
  context: Hex;
  durationSec: number;
  currentTimestampSec?: number;
}): {
  to: Address;
  abi: typeof WALLET_SESSION_REGISTRY_ABI;
  functionName: 'authorize';
  args: [Address, Hex, bigint];
} {
  const now = params.currentTimestampSec ?? Math.floor(Date.now() / 1000);
  const maxDuration = 7 * 86400;
  const duration = Math.min(Math.max(60, params.durationSec), maxDuration);
  const expiresAt = BigInt(now + duration);

  return {
    to: params.contractAddress,
    abi: WALLET_SESSION_REGISTRY_ABI,
    functionName: 'authorize',
    args: [params.agent, params.context, expiresAt]
  };
}

export function prepareRevokeTransaction(params: {
  contractAddress: Address;
  agent: Address;
  context: Hex;
}): {
  to: Address;
  abi: typeof WALLET_SESSION_REGISTRY_ABI;
  functionName: 'revoke';
  args: [Address, Hex];
} {
  return {
    to: params.contractAddress,
    abi: WALLET_SESSION_REGISTRY_ABI,
    functionName: 'revoke',
    args: [params.agent, params.context]
  };
}

export function prepareRevokeAllTransaction(params: {
  contractAddress: Address;
}): {
  to: Address;
  abi: typeof WALLET_SESSION_REGISTRY_ABI;
  functionName: 'revokeAll';
} {
  return {
    to: params.contractAddress,
    abi: WALLET_SESSION_REGISTRY_ABI,
    functionName: 'revokeAll'
  };
}
