import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { auditLiveRecords } from '../scripts/audit-live-records.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('reports matched positive gross close records without exposing private data or inventing complete net profit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mpu-audit-fixture-')); roots.push(root);
  const file = path.join(root, 'execution-bybit-mainnet.json');
  const privateMarker = 'private-account-and-trade-identity';
  await writeFile(file, JSON.stringify({ venue: 'bybit:mainnet', intents: [{ kind: 'close', positionId: privateMarker, symbol: 'BTCUSDT', side: 'LONG', clientId: 'fixture-close', record: { orderId: privateMarker, status: 'filled', filledQty: 1 } }], closed: [] }));
  await writeFile(file + '.financial.json', JSON.stringify({ records: [{ kind: 'fill', id: privateMarker, orderId: privateMarker, symbol: 'BTCUSDT', side: 'LONG', qty: 1, price: 100, at: 1000, realizedPnl: { amount: 5, currency: 'USDT' } }] }));
  const audit = await auditLiveRecords(root);
  expect(audit).toMatchObject({ mainnetRecordsObserved: true, positiveMatchedClosePnlObserved: true, completeNetRealizedProfitVerified: false, independentExchangeAttestation: false });
  expect(JSON.stringify(audit)).not.toContain(privateMarker);
  expect(JSON.stringify(audit)).not.toContain('BTCUSDT');
  expect(audit).not.toHaveProperty('amount');
  expect(audit).not.toHaveProperty('records');
});

it('does not promote unmatched income or testnet records into positive mainnet proof', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mpu-audit-fixture-')); roots.push(root);
  await writeFile(path.join(root, 'execution-bybit-mainnet.json'), JSON.stringify({ venue: 'bybit:mainnet', intents: [], closed: [] }));
  await writeFile(path.join(root, 'execution-bybit-mainnet.json.financial.json'), JSON.stringify({ records: [{ kind: 'fill', orderId: 'unmatched', realizedPnl: { amount: 5, currency: 'USDT' } }] }));
  await writeFile(path.join(root, 'execution-bybit-testnet.json'), JSON.stringify({ venue: 'bybit:testnet', intents: [{ record: { status: 'filled', filledQty: 1 } }] }));
  expect(await auditLiveRecords(root)).toMatchObject({ mainnetRecordsObserved: false, positiveMatchedClosePnlObserved: false, completeNetRealizedProfitVerified: false });
});
