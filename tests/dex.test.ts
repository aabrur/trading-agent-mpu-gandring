// Experimental perp DEX adapters against mocked APIs. Real DEX accounts are never used here.
import { describe, it, expect } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { verifyTypedData } from 'viem';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { ec, typedData, shortString } from 'starknet';
import { AsterAdapter, ASTER_CHAIN_ID } from '../server/exchange/aster.js';
import { OrderlyAdapter, parseOrderlySecret } from '../server/exchange/orderly.js';
import { ParadexAdapter, chainNumber } from '../server/exchange/paradex.js';
import { DydxAdapter, dydxAddressOf, dydxClientId, flattenAuthenticator } from '../server/exchange/dydx.js';
import { verifyKey } from '../server/live/guard.js';
import { LiveExecutor } from '../server/live/executor.js';
import { fakeAster, fakeOrderly, fakeParadex, fakeDydx } from './dexfakes.js';

const MAIN = privateKeyToAccount(generatePrivateKey());
const AGENT_KEY = generatePrivateKey();
const order = { symbol: 'BTCUSDT', side: 'LONG' as const, qty: 0.01, stop: 58800, tp: 63000, leverage: 3 };

describe('Aster (EXPERIMENTAL, mocked)', () => {
  const make = (f = fakeAster(), key = AGENT_KEY, net: 'mainnet' | 'testnet' = 'testnet') => new AsterAdapter(net, MAIN.address, key, f.fetchImpl, 'https://aster.test');
  it('signs the exact query string with EIP-712 (AsterSignTransaction v1, Message{msg})', async () => {
    const a = make();
    const { msg, signature, query } = await a.signedQuery({ symbol: 'BTCUSDT', side: 'BUY' }, 1700000000000000);
    expect(msg).toBe(`symbol=BTCUSDT&side=BUY&nonce=1700000000000000&user=${MAIN.address}&signer=${a.signerAddress}`);
    expect(query).toBe(`${msg}&signature=${signature}`);
    const valid = await verifyTypedData({ address: a.signerAddress, domain: { name: 'AsterSignTransaction', version: '1', chainId: ASTER_CHAIN_ID.testnet, verifyingContract: '0x0000000000000000000000000000000000000000' }, types: { Message: [{ name: 'msg', type: 'string' }] }, primaryType: 'Message', message: { msg }, signature });
    expect(valid).toBe(true);
    expect(ASTER_CHAIN_ID.mainnet).toBe(1666);
  });
  it('refuses the main wallet key and any account that does not report canWithdraw false', async () => {
    const mainKey = generatePrivateKey();
    const own = new AsterAdapter('mainnet', privateKeyToAccount(mainKey).address, mainKey, fakeAster().fetchImpl, 'https://aster.test');
    expect((await verifyKey(own)).ok).toBe(false);
    expect((await verifyKey(make(fakeAster({ canWithdraw: true }), AGENT_KEY, 'mainnet'))).ok).toBe(false);
    expect((await verifyKey(make(fakeAster({ canWithdraw: null }), AGENT_KEY, 'mainnet'))).ok).toBe(false);
    expect((await verifyKey(make(fakeAster(), AGENT_KEY, 'mainnet'))).ok).toBe(true);
  });
  it('opens with a closePosition STOP_MARKET (and TP) resting on the exchange, reconciled from the order record', async () => {
    const f = fakeAster();
    const fill = await new LiveExecutor(make(f), 0).open(order);
    expect(fill.ok).toBe(true);
    expect(fill.avgPrice).toBe(60010);
    expect(f.open.map((o) => o.type)).toEqual(['STOP_MARKET', 'TAKE_PROFIT_MARKET']);
    expect(f.open[0]).toMatchObject({ side: 'SELL', stopPrice: '58800', closePosition: 'true' });
    expect(f.calls.filter((c) => c.path === '/fapi/v3/order' && c.method === 'POST' && c.query.get('type') === 'MARKET').length).toBe(1); // sent once
  });
  it('fails closed when the stop is rejected: entry closed, open reported as not ok', async () => {
    const f = fakeAster({ rejectStop: true });
    const fill = await new LiveExecutor(make(f), 0).open(order);
    expect(fill.ok).toBe(false);
    expect(await make(f).positions()).toEqual([]);
  });
  it('fails closed when the venue accepts but does not hold the stop', async () => {
    const f = fakeAster({ dropStops: true });
    const fill = await new LiveExecutor(make(f), 0).open(order);
    expect(fill.ok).toBe(false);
    expect(fill.note).toMatch(/FAIL CLOSED/);
    expect(await make(f).positions()).toEqual([]);
  });
  it('startup reconcile re-places a missing exchange-side stop', async () => {
    const f = fakeAster();
    f.setPosition(0.01, 60000);
    const notes = await new LiveExecutor(make(f), 0).ensureProtection({}, 3);
    expect(notes[0]).toMatch(/protected on the exchange, stop 58200/);
    expect(f.open[0]).toMatchObject({ type: 'STOP_MARKET', side: 'SELL' });
  });
});

describe('Orderly (EXPERIMENTAL, mocked)', () => {
  const seed = ed25519.utils.randomSecretKey();
  const secret = base58.encode(seed);
  const ACCOUNT = `0x${'ab'.repeat(32)}`;
  const make = (f = fakeOrderly()) => new OrderlyAdapter('testnet', ACCOUNT, secret, f.fetchImpl, 'https://orderly.test');
  it('signs timestamp+method+path+body with ed25519, base64url, and sends the Orderly headers', async () => {
    const a = make();
    const { message, signature } = a.sign(1700000000000, 'POST', '/v1/order', '{"a":1}');
    expect(message).toBe('1700000000000POST/v1/order{"a":1}');
    expect(ed25519.verify(Buffer.from(signature, 'base64url'), new TextEncoder().encode(message), ed25519.getPublicKey(seed))).toBe(true);
    expect(a.orderlyKey).toBe(`ed25519:${base58.encode(ed25519.getPublicKey(seed))}`);
    const f = fakeOrderly();
    await make(f).balance();
    expect(Object.keys(f.calls[0].headers)).toEqual(expect.arrayContaining(['orderly-account-id', 'orderly-key', 'orderly-timestamp', 'orderly-signature']));
  });
  it('refuses wallet keys, unknown keys, inactive keys and scopes beyond read,trading', async () => {
    expect(() => parseOrderlySecret(generatePrivateKey())).toThrow(/wallet private key/);
    expect((await verifyKey(make(fakeOrderly({ keyRow: null })))).ok).toBe(false);
    expect((await verifyKey(make(fakeOrderly({ keyRow: { key_status: 'REMOVING' } })))).ok).toBe(false);
    expect((await verifyKey(make(fakeOrderly({ keyRow: { scope: 'read,trading,asset' } })))).ok).toBe(false);
    expect((await verifyKey(make())).ok).toBe(true);
  });
  it('opens with a POSITIONAL_TP_SL stop on the exchange', async () => {
    const f = fakeOrderly();
    const fill = await new LiveExecutor(make(f), 0).open(order);
    expect(fill.ok).toBe(true);
    const kids = f.algos[0].child_orders;
    expect(kids.map((k: any) => k.algo_type).sort()).toEqual(['STOP_LOSS', 'TAKE_PROFIT']);
    expect(kids.find((k: any) => k.algo_type === 'STOP_LOSS')).toMatchObject({ side: 'SELL', type: 'CLOSE_POSITION', trigger_price: 58800 });
  });
  it('fails closed when the stop is rejected', async () => {
    const f = fakeOrderly({ rejectStop: true });
    expect((await new LiveExecutor(make(f), 0).open(order)).ok).toBe(false);
    expect(await make(f).positions()).toEqual([]);
  });
  it('startup reconcile re-places a missing stop', async () => {
    const f = fakeOrderly();
    f.setPosition(-0.02, 60000);
    const notes = await new LiveExecutor(make(f), 0).ensureProtection({ BTCUSDT: { stop: 61500, tp: null } }, 3);
    expect(notes[0]).toMatch(/protected on the exchange, stop 61500/);
    expect(f.algos[0].child_orders[0]).toMatchObject({ algo_type: 'STOP_LOSS', side: 'BUY' });
  });
});

describe('Paradex (EXPERIMENTAL, mocked)', () => {
  const ACCOUNT = '0x' + '1'.repeat(63);
  const SUB = '0x' + '2'.repeat(63);
  const make = (f = fakeParadex()) => new ParadexAdapter('testnet', ACCOUNT, SUB, f.fetchImpl, 'https://paradex.test/v1');
  it('auth and order signatures are Starknet typed data signed by the subkey for the main account', async () => {
    const a = make();
    const h = await a.authHeaders(1700000000);
    expect(h['PARADEX-STARKNET-ACCOUNT']).toBe(ACCOUNT);
    expect(h['PARADEX-SIGNATURE-EXPIRATION']).toBe(String(1700000000 + 1800));
    const [r, s] = JSON.parse(h['PARADEX-STARKNET-SIGNATURE']);
    const td = { domain: { name: 'Paradex', chainId: shortString.encodeShortString('PRIVATE_SN_PARACLEAR_TESTNET'), version: '1' }, primaryType: 'Request', types: { StarkNetDomain: [{ name: 'name', type: 'felt' }, { name: 'chainId', type: 'felt' }, { name: 'version', type: 'felt' }], Request: [{ name: 'method', type: 'felt' }, { name: 'path', type: 'felt' }, { name: 'body', type: 'felt' }, { name: 'timestamp', type: 'felt' }, { name: 'expiration', type: 'felt' }] }, message: { method: 'POST', path: '/v1/auth', body: '', timestamp: 1700000000, expiration: 1700001800 } };
    const hash = typedData.getMessageHash(td as any, ACCOUNT);
    const pk = '0x' + SUB.slice(2).padStart(64, '0');
    expect(ec.starkCurve.verify(new ec.starkCurve.Signature(BigInt(r), BigInt(s)), hash, ec.starkCurve.getPublicKey(pk))).toBe(true);
    const body = await a.orderBody({ market: 'BTC-USD-PERP', side: 'SELL', type: 'STOP_MARKET', size: 0.01, clientId: 'c1', trigger: 58800, reduceOnly: true }, 1700000000123);
    expect(body).toMatchObject({ type: 'STOP_MARKET', trigger_price: '58800', flags: ['REDUCE_ONLY'], signature_timestamp: 1700000000123 });
    expect(chainNumber(0.01)).toBe('1000000');
  });
  it('refuses a key that is not a registered subkey (main key) or a revoked subkey', async () => {
    expect((await verifyKey(make(fakeParadex({ subkey: null })))).ok).toBe(false);
    expect((await verifyKey(make(fakeParadex({ subkey: { state: 'revoked' } })))).ok).toBe(false);
    expect((await verifyKey(make())).ok).toBe(true);
  });
  it('opens with a reduce-only STOP_MARKET on the exchange', async () => {
    const f = fakeParadex();
    const fill = await new LiveExecutor(make(f), 0).open(order);
    expect(fill.ok).toBe(true);
    expect(f.open.map((o) => o.type)).toEqual(['STOP_MARKET', 'TAKE_PROFIT_MARKET']);
    expect(f.calls.find((c) => c.method === 'POST' && c.body?.type === 'STOP_MARKET')!.headers.Authorization).toBe('Bearer jwt-test');
  });
  it('fails closed when the stop is rejected', async () => {
    const f = fakeParadex({ rejectStop: true });
    expect((await new LiveExecutor(make(f), 0).open(order)).ok).toBe(false);
    expect(await make(f).positions()).toEqual([]);
  });
  it('startup reconcile re-places a missing stop', async () => {
    const f = fakeParadex();
    f.setPosition('LONG', 0.01, 60000);
    await new LiveExecutor(make(f), 0).ensureProtection({}, 3);
    expect(f.open[0]).toMatchObject({ type: 'STOP_MARKET', side: 'SELL', trigger_price: '58200' });
  });
});

describe('dYdX v4 (EXPERIMENTAL, mocked)', () => {
  const OWNER_KEY = generatePrivateKey().slice(2);
  const OWNER = dydxAddressOf(OWNER_KEY).address;
  const API_KEY = generatePrivateKey().slice(2);
  const api = dydxAddressOf(API_KEY);
  const auth = (messages: string[], type = 'AllOf', key = api.pubKey) => ({ id: '7', type, config: Buffer.from(JSON.stringify([
    { type: 'SignatureVerification', config: key.toString('base64') },
    ...(messages.length ? [{ type: 'MessageFilter', config: Buffer.from(messages.join(',')).toString('base64') }] : [])
  ])) });
  const TRADE = ['/dydxprotocol.clob.MsgPlaceOrder', '/dydxprotocol.clob.MsgCancelOrder'];
  const make = (f = fakeDydx({ authenticators: [auth(TRADE)] }), key = API_KEY) => new DydxAdapter('testnet', OWNER, key, '7', f.fetchImpl, f.chain, 0);
  it('derives bech32 dydx addresses and uint32 client ids; parses authenticator trees', () => {
    expect(OWNER).toMatch(/^dydx1[02-9ac-hj-np-z]{38}$/);
    const id = dydxClientId('mge123');
    expect(id).toBe(dydxClientId('mge123'));
    expect(id).toBeLessThan(2 ** 32);
    const flat = flattenAuthenticator('AllOf', auth(TRADE).config);
    expect(flat.messages).toEqual(TRADE);
    expect(flat.pubKeys[0].equals(api.pubKey)).toBe(true);
  });
  it('refuses the owner key and any authenticator that is not trade only', async () => {
    expect((await verifyKey(make(fakeDydx({ authenticators: [auth(TRADE, 'AllOf', dydxAddressOf(OWNER_KEY).pubKey)] }), OWNER_KEY))).ok).toBe(false);
    expect((await verifyKey(make(fakeDydx({ authenticators: [auth([])] })))).ok).toBe(false); // no message filter
    expect((await verifyKey(make(fakeDydx({ authenticators: [auth([...TRADE, '/dydxprotocol.sending.MsgCreateTransfer'])] })))).ok).toBe(false);
    expect((await verifyKey(make(fakeDydx({ authenticators: [auth(TRADE, 'AnyOf')] })))).ok).toBe(false);
    expect((await verifyKey(make(fakeDydx({ authenticators: [] })))).ok).toBe(false);
    expect((await verifyKey(make())).ok).toBe(true);
  });
  it('opens with a conditional reduce-only STOP_MARKET resting on chain', async () => {
    const f = fakeDydx({ authenticators: [auth(TRADE)] });
    const fill = await new LiveExecutor(make(f), 0).open(order);
    expect(fill.ok).toBe(true);
    expect(fill.avgPrice).toBe(60010);
    expect(f.placed.map((p) => p.type)).toEqual(['MARKET', 'STOP_MARKET', 'TAKE_PROFIT_MARKET']);
    expect(f.placed[1]).toMatchObject({ side: 'SELL', reduceOnly: true, triggerPrice: 58800 });
    expect(f.placed[0].price).toBe(61200); // 2% worst price on a market order
  });
  it('fails closed when the stop is rejected', async () => {
    const f = fakeDydx({ authenticators: [auth(TRADE)], rejectStop: true });
    expect((await new LiveExecutor(make(f), 0).open(order)).ok).toBe(false);
    expect(await make(f).positions()).toEqual([]);
  });
  it('startup reconcile re-places a missing stop', async () => {
    const f = fakeDydx({ authenticators: [auth(TRADE)] });
    f.setPosition('SHORT', 0.01, 60000);
    await new LiveExecutor(make(f), 0).ensureProtection({}, 3);
    expect(f.placed[0]).toMatchObject({ type: 'STOP_MARKET', side: 'BUY', triggerPrice: 61800, reduceOnly: true });
  });
});
