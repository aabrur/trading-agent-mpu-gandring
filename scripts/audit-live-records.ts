import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FinancialEvidence } from '../server/live/financial-evidence.js';
import type { ExecutionIntent } from '../server/live/journal.js';
import type { FinancialRecord } from '../server/exchange/types.js';
import type { ClosedTrade } from '../server/types.js';

/** Read local evidence only. Never connect to a venue or output account/trade identifiers or amounts. */
export async function auditLiveRecords(root = path.resolve('data')) {
  let mainnetRecordsObserved = false, positiveMatchedClosePnlObserved = false;
  let closedJournals = 0, allClosedEvidenceComplete = true, verifiedNet = 0;
  let unreadableEvidence = false;
  for (const name of await readdir(root).catch(() => [] as string[])) {
    if (!/^execution-.*\.json$/.test(name) || /financial|testnet|paper|fixture|sample/i.test(name)) continue;
    try {
      const journal = JSON.parse(await readFile(path.join(root, name), 'utf8')) as { venue?: string; intents?: ExecutionIntent[]; closed?: ClosedTrade[] };
      if (!/^[a-z0-9_-]+:mainnet$/i.test(journal.venue ?? '')) continue;
      const intents = journal.intents ?? [], trades = journal.closed ?? [];
      const filled = intents.filter(intent => intent.record?.status === 'filled' && Number.isFinite(intent.record.filledQty) && intent.record.filledQty > 0);
      mainnetRecordsObserved ||= filled.length > 0;
      const financialPath = path.join(root, name + '.financial.json');
      const financial = JSON.parse(await readFile(financialPath, 'utf8').catch(() => '{}')) as { records?: FinancialRecord[] };
      for (const record of financial.records ?? []) {
        if (record.kind !== 'fill' || !Number.isFinite(record.qty) || !(record.qty > 0) || record.realizedPnl?.currency !== 'USDT' || !Number.isFinite(record.realizedPnl.amount) || !(record.realizedPnl.amount > 0)) continue;
        const matches = filled.filter(intent => intent.kind === 'close' && intent.positionId && intent.symbol === record.symbol && (!record.side || record.side === intent.side) && ((record.clientId && record.clientId === intent.clientId) || (record.orderId && record.orderId === intent.record?.orderId)));
        positiveMatchedClosePnlObserved ||= matches.length === 1;
      }
      if (trades.length) closedJournals++;
      if (trades.length && trades.every(trade => trade.remainingQty === 0)) {
        const evidence = new FinancialEvidence(financialPath);
        evidence.attribute(intents, trades);
        const since = Math.min(...trades.map(trade => trade.openedAt));
        const until = Math.max(...trades.map(trade => trade.closedAt));
        const summary = evidence.summary(since, until);
        if (summary.coverage === 'complete' && summary.confirmedNetRealized !== null) verifiedNet += summary.confirmedNetRealized;
        else allClosedEvidenceComplete = false;
      } else if (trades.length) allClosedEvidenceComplete = false;
    } catch { unreadableEvidence = true; allClosedEvidenceComplete = false; }
  }
  return { provenance: 'owner-retained local mainnet records', independentExchangeAttestation: false,
    mainnetRecordsObserved, positiveMatchedClosePnlObserved, completeNetRealizedProfitVerified: closedJournals > 0 && allClosedEvidenceComplete && verifiedNet > 0, unreadableEvidence,
    privacy: 'No credentials, account identifiers, balances, amounts, positions or raw records included.' };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
  console.log(JSON.stringify(await auditLiveRecords(root), null, 2));
}
