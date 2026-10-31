import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { WalletService, findSecretLikePayload } from '../../server/v2/wallet.js';

describe('T10 delegated WalletService challenge/approve, expiry, replay, chain/owner checks and server-only agent key', () => {
  it('verifies main wallet EIP-712 signature, blocks replay/expiry/wrong owner/wrong chain, and never returns raw agent private key', async () => {
    const mainPrivKey = generatePrivateKey();
    const mainAccount = privateKeyToAccount(mainPrivKey);
    const wrongAccount = privateKeyToAccount(generatePrivateKey());

    let clockMs = 1_761_900_000_000;
    const savedSecrets: Array<{ venue: string; agentKey: string; agentAddress: string }> = [];

    const service = new WalletService({
      now: () => clockMs,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes('/fapi/v3/approveAgent')) {
          return new Response(JSON.stringify({ code: 0, msg: 'success' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/exchange')) {
          return new Response(JSON.stringify({ status: 'ok' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      verifyDelegatedAgent: async () => ({
        ok: true,
        detail: 'Verified trade-only agent wallet (canWithdraw=false)'
      }),
      persistDelegatedSecret: async (record) => {
        savedSecrets.push({
          venue: record.venue,
          agentKey: record.agentPrivateKey,
          agentAddress: record.agentAddress
        });
      }
    });

    // Wrong chain for Aster (requires chainId 56)
    await expect(
      service.start('aster', {
        network: 'testnet',
        mainAddress: mainAccount.address,
        chainId: 1
      })
    ).rejects.toThrow(/56|BNB/i);

    const challenge = await service.start('aster', {
      network: 'testnet',
      mainAddress: mainAccount.address,
      chainId: 56
    });

    // No raw private key in challenge response
    expect(JSON.stringify(challenge)).not.toMatch(/0x[0-9a-fA-F]{64}/);
    expect(challenge.typedData.message.CanWithdraw).toBe(false);

    // Wrong owner signature rejected
    const wrongSig = await wrongAccount.signTypedData(challenge.typedData as never);
    await expect(service.approve(challenge.challengeId, wrongSig)).rejects.toThrow(/match|owner|wallet/i);

    // Valid owner signature succeeds once and stores agent key server-side without returning it
    const validSig = await mainAccount.signTypedData(challenge.typedData as never);
    const approved = await service.approve(challenge.challengeId, validSig);
    expect(approved.ok).toBe(true);
    expect(approved.agentAddress).toBe(challenge.agentAddress);
    expect(savedSecrets).toHaveLength(1);
    expect(JSON.stringify(approved)).not.toContain(savedSecrets[0]!.agentKey);

    // Replay of same challengeId is rejected
    await expect(service.approve(challenge.challengeId, validSig)).rejects.toThrow(/expired|unknown|used/i);

    // Expired challenge is rejected
    const hlChallenge = await service.start('hyperliquid', {
      network: 'testnet',
      mainAddress: mainAccount.address,
      chainId: 421614
    });
    clockMs += 11 * 60_000;
    const hlSig = await mainAccount.signTypedData(hlChallenge.typedData as never);
    await expect(service.approve(hlChallenge.challengeId, hlSig)).rejects.toThrow(/expired/i);

    // Secret-like field detection refuses raw private keys or seed phrases in request payloads
    expect(findSecretLikePayload({ privateKey: mainPrivKey })).toMatch(/privateKey/i);
    expect(
      findSecretLikePayload({
        note: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
      })
    ).toMatch(/seed/i);
  });
});
