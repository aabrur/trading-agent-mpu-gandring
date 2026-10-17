// Connect wallet, server side. The "wallet" here is a mocked signer (a throwaway viem account).
// Never tested against a real browser wallet or a real venue.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { WalletConnector, walletAccess, findSecretLike, asterApproval, hyperliquidApproval, ASTER_SIGNATURE_CHAIN_ID } from '../server/wallet.js';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';

const dir = mkdtempSync(path.join(tmpdir(), 'mg-wallet-'));
const mainWallet = privateKeyToAccount(generatePrivateKey()); // stands in for MetaMask / Rabby
const sign = (td: any, who = mainWallet) => who.signTypedData(td);
function fakeVenue() {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: String(init.body) });
    if (url.endsWith('/exchange')) return new Response(JSON.stringify({ status: 'ok', response: { type: 'default' } }));
    return new Response(JSON.stringify({ code: 200, msg: 'success' }));
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('access rules', () => {
  const base = { appMode: 'local', host: '127.0.0.1', remoteAddress: '127.0.0.1', hostHeader: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' };
  it('works only locally, bound to loopback, from loopback, with a localhost Host header', () => {
    expect(walletAccess(base).ok).toBe(true);
    expect(walletAccess({ ...base, appMode: 'grokbot' }).reason).toMatch(/secret card/);
    expect(walletAccess({ ...base, host: '0.0.0.0' }).ok).toBe(false);
    expect(walletAccess({ ...base, remoteAddress: '192.168.1.5' }).ok).toBe(false);
    expect(walletAccess({ ...base, hostHeader: 'evil.example:8787' }).ok).toBe(false); // DNS rebinding
    expect(walletAccess({ ...base, origin: 'https://evil.example' }).ok).toBe(false);
  });
});

describe('refuses anything that looks like a main key', () => {
  it('flags private keys, seed phrases and secret-named fields; allows addresses and signatures', () => {
    expect(findSecretLike({ mainAddress: generatePrivateKey() })).toBe('a private key');
    expect(findSecretLike({ note: 'abandon '.repeat(11) + 'about' })).toBe('a seed phrase');
    expect(findSecretLike({ privateKey: 'x' })).toMatch(/field named privateKey/);
    expect(findSecretLike({ mainAddress: mainWallet.address, chainId: 42161, signature: `0x${'ab'.repeat(65)}` })).toBeNull();
  });
});

describe('Hyperliquid approveAgent', () => {
  it('builds the user-signed ApproveAgent typed data', () => {
    const { action, typedData } = hyperliquidApproval('mainnet', '0x' + '1'.repeat(40), 42161, 1700000000000);
    expect(action).toMatchObject({ type: 'approveAgent', signatureChainId: '0xa4b1', hyperliquidChain: 'Mainnet', agentName: 'mpugandring', nonce: 1700000000000 });
    expect(typedData.domain).toMatchObject({ name: 'HyperliquidSignTransaction', chainId: 42161 });
    expect(typedData.primaryType).toBe('HyperliquidTransaction:ApproveAgent');
  });
  it('generates a fresh agent key, verifies the wallet signature, submits, saves to .env with chmod 600', async () => {
    const envFile = path.join(dir, 'hl.env'); writeFileSync(envFile, 'TRADING_MODE=PAPER\n');
    const v = fakeVenue();
    const w = new WalletConnector({ envFile, fetchImpl: v.fetchImpl });
    const s = w.start('hyperliquid', 'testnet', mainWallet.address, 421614);
    expect(s.agentAddress).not.toBe(mainWallet.address);
    expect(JSON.stringify(s)).not.toMatch(/[0-9a-f]{64}/i); // the agent key is never sent to the browser
    const r = await w.approve(s.id, await sign(s.typedData));
    expect(r.ok).toBe(true);
    const body = JSON.parse(v.calls[0].body);
    expect(v.calls[0].url).toBe('https://api.hyperliquid-testnet.xyz/exchange');
    expect(body.action).toMatchObject({ type: 'approveAgent', agentAddress: s.agentAddress, hyperliquidChain: 'Testnet' });
    expect(body.signature).toHaveProperty('r');
    const env = readFileSync(envFile, 'utf8');
    expect(env).toContain(`HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS=${mainWallet.address}`);
    const key = env.match(/HYPERLIQUID_TESTNET_AGENT_PRIVATE_KEY=(0x[0-9a-f]{64})/)![1];
    expect(privateKeyToAccount(key as `0x${string}`).address).toBe(s.agentAddress);
    if (process.platform !== 'win32') expect(statSync(envFile).mode & 0o777).toBe(0o600);
    await expect(w.approve(s.id, await sign(s.typedData))).rejects.toThrow(/expired or unknown/); // one use
  });
  it('refuses a signature from a different wallet and never submits it', async () => {
    const v = fakeVenue();
    const w = new WalletConnector({ envFile: path.join(dir, 'x.env'), fetchImpl: v.fetchImpl });
    const s = w.start('hyperliquid', 'mainnet', mainWallet.address, 1);
    await expect(w.approve(s.id, await sign(s.typedData, privateKeyToAccount(generatePrivateKey())))).rejects.toThrow(/does not match/);
    expect(v.calls).toHaveLength(0);
  });
});

describe('Aster registerAndApproveAgent', () => {
  it('signs the documented message with canWithdraw=false, chain id 56', () => {
    const a = asterApproval(mainWallet.address, '0x' + '2'.repeat(40), 1700000000000000, 1800000000000);
    expect(a.msg).toBe(`user=${mainWallet.address}&nonce=1700000000000000&agentName=mpugandring&agentAddress=0x${'2'.repeat(40)}&expired=1800000000000&signatureChainId=56&canSpotTrade=false&canPerpTrade=true&canWithdraw=false&ipWhitelist=`);
    expect(a.typedData.domain.chainId).toBe(ASTER_SIGNATURE_CHAIN_ID);
  });
  it('submits the form and saves ASTER_USER_ADDRESS / ASTER_SIGNER_PRIVATE_KEY', async () => {
    const envFile = path.join(dir, 'aster.env');
    const v = fakeVenue();
    const w = new WalletConnector({ envFile, fetchImpl: v.fetchImpl });
    const s = w.start('aster', 'mainnet', mainWallet.address, 56);
    await w.approve(s.id, await sign(s.typedData));
    expect(v.calls[0].url).toBe('https://fapi.asterdex.com/fapi/v3/registerAndApproveAgent');
    const form = new URLSearchParams(v.calls[0].body);
    expect(form.get('canWithdraw')).toBe('false');
    expect(form.get('agentAddress')).toBe(s.agentAddress);
    expect(form.get('signature')).toMatch(/^0x[0-9a-f]{130}$/);
    expect(readFileSync(envFile, 'utf8')).toMatch(/ASTER_SIGNER_PRIVATE_KEY=0x[0-9a-f]{64}/);
  });
  it('manual venues and CEXes have no signature flow', () => {
    const w = new WalletConnector({ envFile: path.join(dir, 'm.env') });
    for (const v of ['dydx', 'paradex', 'orderly', 'bybit'] as const) expect(() => w.start(v, 'mainnet', mainWallet.address, 1)).toThrow(/manual steps/);
  });
});

describe('HTTP routes', () => {
  const servers: { close: () => void }[] = [];
  afterAll(() => servers.forEach((s) => s.close()));
  async function up(env: Record<string, string>) {
    const built = createApp(loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', HOST: '127.0.0.1', ...env }), { reportsDir: null, learningsPath: null, envFile: path.join(dir, 'route.env') });
    await new Promise<void>((r) => built.server.listen(0, '127.0.0.1', () => r()));
    servers.push(built.server);
    return `http://127.0.0.1:${(built.server.address() as AddressInfo).port}`;
  }
  const post = (u: string, body: unknown) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  it('is disabled in Grok Bot mode', async () => {
    const u = await up({ APP_MODE: 'grokbot', AGENT_EVENT_SECRET: 'gbSECRET-0123456789abcdefghij' });
    expect((await (await fetch(`${u}/api/wallet`)).json()).available).toBe(false);
    expect((await post(`${u}/api/wallet/start`, { venue: 'hyperliquid', network: 'testnet', mainAddress: mainWallet.address, chainId: 1 })).status).toBe(403);
  });
  it('refuses a body carrying a private key, accepts a clean start in local mode', async () => {
    const u = await up({ APP_MODE: 'local' });
    const bad = await post(`${u}/api/wallet/start`, { venue: 'hyperliquid', network: 'testnet', mainAddress: mainWallet.address, chainId: 1, extra: generatePrivateKey() });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/private key/);
    const ok = await (await post(`${u}/api/wallet/start`, { venue: 'hyperliquid', network: 'testnet', mainAddress: mainWallet.address, chainId: 1 })).json();
    expect(ok.ok).toBe(true);
    expect(ok.agentAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    const info = await (await fetch(`${u}/api/wallet`)).json();
    expect(info.venues.find((v: any) => v.venue === 'bybit').support).toBe('cex');
  });
});
