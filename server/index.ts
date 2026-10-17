import { loadConfig, ConfigError } from './config.js';
import { createApp } from './app.js';
import { log, safe } from './redact.js';
import { exchangeSettings, makeAdapter } from './exchange/index.js';
import { LiveExecutor } from './live/executor.js';
import { verifyKey, networkFor } from './live/guard.js';
import { DEFAULT_KILL_FILE, readKill } from './killswitch.js';

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
    if (v.perm?.exception) log(`[withdraw guard] ${safe(v.perm.exception)}`);
    log(`${cfg.tradingMode} on ${ex.name}${cfg.live?.experimental ? ' (EXPERIMENTAL adapter)' : ''}: ${v.detail}`);
    // Every open position must have its stop resting ON THE EXCHANGE, so it stays protected while this computer is off.
    const pct = Math.min(20, Math.max(0.5, Number(process.env.PROTECT_STOP_PCT ?? 3) || 3));
    for (const n of await executor.ensureProtection({}, pct)) log(`[startup protection] ${n}`);
  } catch (e) {
    console.error(`[trading-agent-mpu-gandring] ${cfg.tradingMode} refused at startup: ${safe((e as Error).message)}`);
    process.exit(2);
  }
}

const killFile = process.env.KILL_SWITCH_FILE || DEFAULT_KILL_FILE;
const { server, desk, auto, reporter, lead, inbound } = createApp(cfg, { executor, killFile });
const killRec = readKill(killFile);
if (killRec) log(`KILL SWITCH IS ON (saved ${killRec.at ? new Date(killRec.at).toISOString() : 'earlier'}). No new orders. Release it with: npm run unkill -- --yes, then restart.`);
server.listen(cfg.port, cfg.host, () => {
  log(`Trading Agent Mpu Gandring backend on http://${cfg.host}:${cfg.port} (mode ${cfg.tradingMode}, app ${cfg.appMode}, market ${cfg.marketSource}, bridge ${cfg.bridge.enabled ? 'on' : 'off'})`);
  if (cfg.tradingMode === 'LIVE') log('LIVE TRADING IS ON. Real money, full auto. Kill switch: POST /api/kill or the red button in the office.');
  for (const [id, a] of Object.entries(cfg.agents)) log(`  ${id.padEnd(10)} ${a.provider}/${a.model}${a.fellBackToMock ? '  (no key found, using mock)' : ''}`);
  desk.start();
  auto.start();
  reporter.start();
  lead.start();
  log(`reports every ${cfg.reports.intervalMin} min${cfg.reports.telegram.enabled ? ' (also to Telegram)' : ''}; auto trading ${cfg.auto.on ? `on, every ${cfg.auto.intervalMin} min` : 'off'}`);
});
const ch = cfg.channels;
const inboundServer = (ch.discord.inbound || ch.slack.inbound || ch.whatsapp.inbound) && ch.commands
  ? inbound.listen(ch.inbound.port, ch.inbound.host, () => log(`chat command webhooks on http://${ch.inbound.host}:${ch.inbound.port}/api/channels/* (point your tunnel at this port only)`))
  : null;
const shutdown = () => { auto.stop(); reporter.stop(); lead.stop(); inboundServer?.close(); desk.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
