// Opt-in Aster exception: ASTER_AGENT_WITHDRAW_OFF_VERIFIED. Mocked API only, no real account.
import { describe, it, expect } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { AsterAdapter } from '../server/exchange/aster.js';
import { verifyKey } from '../server/live/guard.js';
import { fakeAster } from './dexfakes.js';

const MAIN = privateKeyToAccount(generatePrivateKey());
const AGENT_KEY = generatePrivateKey();
const AGENT = privateKeyToAccount(AGENT_KEY).address;
const OTHER = privateKeyToAccount(generatePrivateKey()).address;
const future = Date.now() + 86_400_000;
const row = (o: Record<string, unknown> = {}) => ({ agentAddress: AGENT.toLowerCase(), agentName: 'desk', ipWhitelist: '', expired: future, canRead: true, canSpotTrade: false, canPerpTrade: true, canWithdraw: false, ...o });
type Opts = Parameters<typeof fakeAster>[0];
const make = (opts: Opts, pin: string | null = AGENT, key = AGENT_KEY, user = MAIN.address) =>
  new AsterAdapter('mainnet', user, key, fakeAster({ canWithdraw: true, agents: [row()], ...opts }).fetchImpl, 'https://aster.test', pin ?? '');

describe('Aster pinned agent exception (ASTER_AGENT_WITHDRAW_OFF_VERIFIED)', () => {
  it('accepts only when the pinned signer is a registered agent with canWithdraw false, and keeps the account reading', async () => {
    const a = make({});
    const v = await verifyKey(a);
    expect(v.ok).toBe(true);
    expect(v.perm?.canWithdraw).toBe(false);
    expect(v.perm?.exception).toMatch(/ASTER_AGENT_WITHDRAW_OFF_VERIFIED accepted: account canWithdraw true/);
    expect(v.detail).toMatch(/account reports canTrade true, canWithdraw true/);
    expect(v.detail).toMatch(/accepted because signer/);
  });
  it('pin matching is case-insensitive', async () => {
    expect((await verifyKey(make({}, AGENT.toLowerCase()))).ok).toBe(true);
    expect((await verifyKey(make({}, AGENT.toUpperCase().replace('0X', '0x')))).ok).toBe(true);
  });
  it('is off by default: no pin means the account flag decides (refused)', async () => {
    for (const pin of [null, '', '   ']) {
      const v = await verifyKey(make({}, pin));
      expect(v.ok).toBe(false);
      expect(v.perm?.exception).toBeUndefined();
    }
  });
  it('refuses the main wallet key first, even when it is pinned', async () => {
    const mainKey = generatePrivateKey(), main = privateKeyToAccount(mainKey).address;
    const v = await verifyKey(make({ agents: [row({ agentAddress: main })] }, main, mainKey, main));
    expect(v.ok).toBe(false);
    expect(v.detail).toMatch(/MAIN wallet key/);
  });
  it('refuses when the signer is not the pinned address, or the pin is malformed', async () => {
    expect((await verifyKey(make({}, OTHER))).detail).toMatch(/not the pinned agent/);
    expect((await verifyKey(make({}, 'yes'))).detail).toMatch(/not a 0x address/);
  });
  it('refuses when canTrade is false, missing or not a boolean true', async () => {
    for (const canTrade of [false, 'missing', null, 'true']) expect((await verifyKey(make({ canTrade }))).ok).toBe(false);
  });
  it('refuses when the signer is not registered for the user', async () => {
    expect((await verifyKey(make({ agents: [] }))).detail).toMatch(/not registered/);
    expect((await verifyKey(make({ agents: [row({ agentAddress: OTHER })] }))).detail).toMatch(/not registered/);
    expect((await verifyKey(make({ agents: [row(), row()] }))).ok).toBe(false);
    expect((await verifyKey(make({ agents: { not: 'a list' } }))).detail).toMatch(/not readable/);
    expect((await verifyKey(make({ agentsError: true }))).detail).toMatch(/could not read the agent list/);
  });
  it('refuses when the agent itself can withdraw, or its flag is missing', async () => {
    for (const canWithdraw of [true, null, undefined, 'false', 0]) {
      const v = await verifyKey(make({ agents: [row({ canWithdraw })] }));
      expect(v.ok).toBe(false);
    }
  });
  it('refuses when the agent cannot perp trade, or the approval is expired', async () => {
    expect((await verifyKey(make({ agents: [row({ canPerpTrade: false })] }))).detail).toMatch(/canPerpTrade false/);
    expect((await verifyKey(make({ agents: [row({ expired: Date.now() - 1000 })] }))).detail).toMatch(/expired/);
    expect((await verifyKey(make({ agents: [row({ expired: undefined })] }))).ok).toBe(false);
  });
  it('the normal path is unchanged: account canWithdraw false is accepted without the exception', async () => {
    const v = await verifyKey(make({ canWithdraw: false }, null));
    expect(v.ok).toBe(true);
    expect(v.perm?.exception).toBeUndefined();
  });
});
