import { loadConfig, ConfigError } from './config.js';
import { createApp } from './app.js';
import { log, safe } from './redact.js';
import { exchangeSettings, makeAdapter } from './exchange/index.js';
import { LiveExecutor } from './live/executor.js';
import { verifyKey, networkFor } from './live/guard.js';

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(`[trading-agent-mpu-gandring] ${(e as Error).message}`);
  process.exit(e instanceof ConfigError ? e.exitCode : 1);
}

let executor: LiveExecutor | null = null;
const net = networkFor(cfg.tradingMode);
if (net) {
  // Automatic guard on every start: the exchange must say this key cannot withdraw.
  try {
    const ex = exchangeSettings(process.env);
    const adapter = makeAdapter(ex.name!, net, ex.creds[net]!);
    const v = await verifyKey(adapter);
    if (!v.ok) {
      console.error(`[trading-agent-mpu-gandring] ${cfg.tradingMode} refused at startup: ${v.detail}`);
      process.exit(2);
    }
    executor = new LiveExecutor(adapter);
    log(`${cfg.tradingMode} on ${ex.name}${cfg.live?.experimental ? ' (EXPERIMENTAL adapter)' : ''}: ${v.detail}`);
  } catch (e) {
    console.error(`[trading-agent-mpu-gandring] ${cfg.tradingMode} refused at startup: ${safe((e as Error).message)}`);
    process.exit(2);
  }
}

const { server, desk, auto, reporter } = createApp(cfg, { executor });
server.listen(cfg.port, cfg.host, () => {
  log(`Trading Agent Mpu Gandring backend on http://${cfg.host}:${cfg.port} (mode ${cfg.tradingMode}, app ${cfg.appMode}, market ${cfg.marketSource}, bridge ${cfg.bridge.enabled ? 'on' : 'off'})`);
  if (cfg.tradingMode === 'LIVE') log('LIVE TRADING IS ON. Real money, full auto. Kill switch: POST /api/kill or the red button in the office.');
  for (const [id, a] of Object.entries(cfg.agents)) log(`  ${id.padEnd(10)} ${a.provider}/${a.model}${a.fellBackToMock ? '  (no key found, using mock)' : ''}`);
  desk.start();
  auto.start();
  reporter.start();
  log(`reports every ${cfg.reports.intervalMin} min${cfg.reports.telegram.enabled ? ' (also to Telegram)' : ''}; auto trading ${cfg.auto.on ? `on, every ${cfg.auto.intervalMin} min` : 'off'}`);
});
const shutdown = () => { auto.stop(); reporter.stop(); desk.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
