import { describe, expect, it } from 'vitest';
import {
  buildSessionContext,
  getRegistryConfig,
  readRegistrySession,
  prepareAuthorizeTransaction,
  prepareRevokeTransaction,
  prepareRevokeAllTransaction
} from '../../server/v2/wallet/registry-consumer.js';

describe('Solidity WalletSessionRegistry Consumer', () => {
  it('builds session context with defaults when unconfigured', () => {
    const config = getRegistryConfig({});
    expect(config.configured).toBe(false);
    expect(config.contractAddress).toBeNull();
    expect(config.chainId).toBeNull();

    const context = buildSessionContext('aster', 'testnet');
    expect(context).toMatch(/^0x[0-9a-fA-F]{64}$/);
  });

  it('builds session context with valid address and chain ID', () => {
    const config = getRegistryConfig({
      REGISTRY_CONTRACT_ADDRESS: '0x1111111111111111111111111111111111111111',
      REGISTRY_CHAIN_ID: '56'
    });
    expect(config.configured).toBe(true);
    expect(config.chainId).toBe(56);
    expect(config.contractAddress).toBe('0x1111111111111111111111111111111111111111');
  });

  it('reads session record and flags expired session', async () => {
    const mockClient = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'isAuthorized') return false;
        if (functionName === 'sessions') return [BigInt(1000), BigInt(1)] as const;
        if (functionName === 'epochs') return BigInt(1);
        return null;
      }
    };

    const session = await readRegistrySession(mockClient as any, {
      contractAddress: '0x1111111111111111111111111111111111111111',
      owner: '0x3333333333333333333333333333333333333333',
      agent: '0x2222222222222222222222222222222222222222',
      context: buildSessionContext('aster', 'testnet')
    });

    expect(session.configured).toBe(true);
    expect(session.isAuthorized).toBe(false);
    expect(session.isExpired).toBe(true);
  });

  it('prepares transaction payloads for authorize and revoke', () => {
    const context = buildSessionContext('hyperliquid', 'testnet');
    const authTx = prepareAuthorizeTransaction({
      contractAddress: '0x1111111111111111111111111111111111111111',
      agent: '0x2222222222222222222222222222222222222222',
      context,
      durationSec: 86400
    });
    expect(authTx.to).toBe('0x1111111111111111111111111111111111111111');
    expect(authTx.functionName).toBe('authorize');
    expect(authTx.args[0]).toBe('0x2222222222222222222222222222222222222222');

    const revokeTx = prepareRevokeTransaction({
      contractAddress: '0x1111111111111111111111111111111111111111',
      agent: '0x2222222222222222222222222222222222222222',
      context
    });
    expect(revokeTx.to).toBe('0x1111111111111111111111111111111111111111');
    expect(revokeTx.functionName).toBe('revoke');

    const revokeAllTx = prepareRevokeAllTransaction({
      contractAddress: '0x1111111111111111111111111111111111111111'
    });
    expect(revokeAllTx.to).toBe('0x1111111111111111111111111111111111111111');
    expect(revokeAllTx.functionName).toBe('revokeAll');
  });
});
