import { loadConfig, ConfigError } from './config.js';
import { createApp } from './app.js';
import { log, safe } from './redact.js';
import { exchangeSettings, makeAdapter } from './exchange/index.js';
import { LiveExecutor } from './live/executor.js';

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(`[trading-agent-mpu-gandring] ${(e as Error).message}`);
  process.exit(e instanceof ConfigError ? e.exitCode : 1);
}

let executor: LiveExecutor | null = null;
if (cfg.tradingMode === 'LIVE') {
  // The signed unlock passed. Ask the exchange again, right now, before anything starts.
  try {
    const ex = exchangeSettings(process.env);
    const adapter = makeAdapter(ex.name!, 'mainnet', ex.creds.mainnet!);
    const perm = await adapter.permissions();
    if (!perm.ok || !perm.verified || perm.canWithdraw !== false || !perm.canTrade) {
      console.error(`[trading-agent-mpu-gandring] LIVE refused at startup: ${safe(perm.detail)}. Back to PAPER.`);
      process.exit(2);
    }
    executor = new LiveExecutor(adapter);
    log(`LIVE on ${ex.name}${cfg.live?.experimental ? ' (EXPERIMENTAL adapter)' : ''}: ${perm.detail}`);
  } catch (e) {
    console.error(`[trading-agent-mpu-gandring] LIVE refused at startup: ${safe((e as Error).message)}`);
    process.exit(2);
  }
}

const { server, desk } = createApp(cfg, { executor });
server.listen(cfg.port, cfg.host, () => {
  log(`Trading Agent Mpu Gandring backend on http://${cfg.host}:${cfg.port} (mode ${cfg.tradingMode}, app ${cfg.appMode}, market ${cfg.marketSource}, bridge ${cfg.bridge.enabled ? 'on' : 'off'})`);
  if (cfg.tradingMode === 'LIVE') log('LIVE TRADING IS ON. Real money. Kill switch: POST /api/kill or the red button in the office.');
  for (const [id, a] of Object.entries(cfg.agents)) log(`  ${id.padEnd(10)} ${a.provider}/${a.model}${a.fellBackToMock ? '  (no key found, using mock)' : ''}`);
  desk.start();
});
const shutdown = () => { desk.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
