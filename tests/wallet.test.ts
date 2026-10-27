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
/** Fake venue. agentWorks=false: the venue says "success" to the approval but the new agent key then fails every signed read. */
function fakeVenue(agentWorks = true) {
  const calls: { url: string; body: string }[] = [];
  let approved = '';
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, body: String(init.body) });
    if (url.endsWith('/exchange')) { approved = JSON.parse(String(init.body)).action.agentAddress; return new Response(JSON.stringify({ status: 'ok', response: { type: 'default' } })); }
    if (url.endsWith('/info')) return new Response(JSON.stringify(agentWorks ? [{ address: approved, name: 'mpugandring', validUntil: null }] : []));
    if (url.includes('/fapi/v3/approveAgent')) return new Response(JSON.stringify({ code: 200, msg: 'success' }));
    if (url.includes('/fapi/v3/account')) return agentWorks ? new Response(JSON.stringify({ canTrade: true, canWithdraw: false, totalMarginBalance: '0', availableBalance: '0' })) : new Response(JSON.stringify({ code: -1000, msg: 'No agent found' }), { status: 400 });
    if (url.includes('/fapi/v3/balance')) return agentWorks ? new Response(JSON.stringify([{ asset: 'USDT', balance: '0' }])) : new Response(JSON.stringify({ code: -1000, msg: 'No agent found' }), { status: 400 });
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
  it('venue says ok but the agent is not in the approved list: nothing saved, not reported ok', async () => {
    const envFile = path.join(dir, 'hl-dead.env'); writeFileSync(envFile, 'TRADING_MODE=PAPER\n');
    const v = fakeVenue(false);
    const w = new WalletConnector({ envFile, fetchImpl: v.fetchImpl, sleep: async () => {} });
    const s = w.start('hyperliquid', 'testnet', mainWallet.address, 421614);
    await expect(w.approve(s.id, await sign(s.typedData))).rejects.toThrow(/does not work yet.*Nothing was saved/);
    expect(readFileSync(envFile, 'utf8')).not.toMatch(/HYPERLIQUID_TESTNET_AGENT_PRIVATE_KEY/);
    expect(v.calls.filter((c) => c.url.endsWith('/info')).length).toBe(3); // retried, then gave up
  });
  it('refuses a signature from a different wallet and never submits it', async () => {
    const v = fakeVenue();
    const w = new WalletConnector({ envFile: path.join(dir, 'x.env'), fetchImpl: v.fetchImpl });
    const s = w.start('hyperliquid', 'mainnet', mainWallet.address, 1);
    await expect(w.approve(s.id, await sign(s.typedData, privateKeyToAccount(generatePrivateKey())))).rejects.toThrow(/does not match/);
    expect(v.calls).toHaveLength(0);
  });
});

describe('Aster approveAgent', () => {
  it('signs ApproveAgent with canWithdraw false and chain id 56; signatureChainId is not inside the signature', () => {
    const agent = '0x' + '2'.repeat(40);
    const a = asterApproval(mainWallet.address, agent, 1700000000000000, 1800000000000, 'mainnet');
    expect(a.params.map(([k]) => k)).toEqual(['agentName', 'agentAddress', 'ipWhitelist', 'expired', 'canSpotTrade', 'canPerpTrade', 'canWithdraw', 'asterChain', 'user', 'nonce']);
    expect(a.typedData.primaryType).toBe('ApproveAgent');
    expect(a.typedData.domain.chainId).toBe(ASTER_SIGNATURE_CHAIN_ID);
    expect(a.typedData.message).toMatchObject({ AgentName: 'mpugandring', AgentAddress: agent, CanWithdraw: false, CanPerpTrade: true, CanSpotTrade: false, AsterChain: 'Mainnet', User: mainWallet.address, Nonce: 1700000000000000, Expired: 1800000000000 });
    expect(a.typedData.message).not.toHaveProperty('signatureChainId');
    expect(asterApproval(mainWallet.address, agent, 1, 2, 'testnet').typedData.message).toMatchObject({ AsterChain: 'Testnet' });
  });
  it('submits approveAgent and saves ASTER_USER_ADDRESS / ASTER_SIGNER_PRIVATE_KEY only after permissions pass', async () => {
    const envFile = path.join(dir, 'aster.env');
    const v = fakeVenue();
    const w = new WalletConnector({ envFile, fetchImpl: v.fetchImpl });
    const s = w.start('aster', 'mainnet', mainWallet.address, 56);
    await w.approve(s.id, await sign(s.typedData));
    const submitted = new URL(v.calls[0].url);
    expect(submitted.pathname).toBe('/fapi/v3/approveAgent');
    expect(submitted.searchParams.get('canWithdraw')).toBe('false');
    expect(submitted.searchParams.get('agentAddress')).toBe(s.agentAddress);
    expect(submitted.searchParams.get('asterChain')).toBe('Mainnet');
    expect(submitted.searchParams.get('signatureChainId')).toBe('56');
    expect(submitted.searchParams.get('signature')).toMatch(/^0x[0-9a-f]{130}$/);
    expect(readFileSync(envFile, 'utf8')).toMatch(/ASTER_SIGNER_PRIVATE_KEY=0x[0-9a-f]{64}/);
    expect(v.calls.some((c) => c.url.includes('/fapi/v3/account') && c.url.includes('asterChain=Mainnet') && c.url.includes(`signer=${s.agentAddress}`))).toBe(true);
  });
  it('reads public Aster USDT when no agent key is saved, and drops a non-finite balance', async () => {
    const envFile = path.join(dir, 'aster-public.env');
    writeFileSync(envFile, 'TRADING_MODE=PAPER\n');
    const fetchImpl = (async (url: string) => {
      expect(String(url)).toBe('https://tapi.asterdex.com/info');
      return new Response(JSON.stringify({ result: { perpAssets: [{ asset: 'USDT', walletBalance: '12.5' }] } }));
    }) as typeof fetch;
    const w = new WalletConnector({ envFile, fetchImpl });
    const res = await w.readVenueBalance('aster', 'mainnet', mainWallet.address);
    expect(res.equityUsdt).toBe(12.5);
    expect(res.availableUsdt).toBe(12.5);
    const bad = new WalletConnector({ envFile, fetchImpl: (async () => new Response(JSON.stringify({ result: { perpAssets: [{ asset: 'USDT', walletBalance: 'nope' }] } }))) as typeof fetch });
    expect((await bad.readVenueBalance('aster', 'mainnet', mainWallet.address)).equityUsdt).toBeNull();
  });
  it('Aster answers {"code":200,"msg":"success"} but then "No agent found": nothing saved, error says so', async () => {
    const envFile = path.join(dir, 'aster-dead.env'); writeFileSync(envFile, 'TRADING_MODE=PAPER\n');
    const w = new WalletConnector({ envFile, fetchImpl: fakeVenue(false).fetchImpl, sleep: async () => {} });
    const s = w.start('aster', 'testnet', mainWallet.address, 56);
    await expect(w.approve(s.id, await sign(s.typedData))).rejects.toThrow(/No agent found.*Nothing was saved/);
    expect(readFileSync(envFile, 'utf8')).not.toMatch(/ASTER_TESTNET_SIGNER_PRIVATE_KEY/);
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
