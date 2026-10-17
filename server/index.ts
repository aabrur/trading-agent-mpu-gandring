import { loadConfig, ConfigError } from './config.js';
import { createApp } from './app.js';
import { log } from './redact.js';

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(`[trading-agent-mpu-gandring] ${(e as Error).message}`);
  process.exit(e instanceof ConfigError ? e.exitCode : 1);
}

const { server, desk } = createApp(cfg);
server.listen(cfg.port, '0.0.0.0', () => {
  log(`Trading Agent Mpu Gandring backend on http://0.0.0.0:${cfg.port} (mode PAPER, market ${cfg.marketSource}, bridge ${cfg.bridge.enabled ? 'on' : 'off'})`);
  for (const [id, a] of Object.entries(cfg.agents)) log(`  ${id.padEnd(10)} ${a.provider}/${a.model}${a.fellBackToMock ? '  (no key found, using mock)' : ''}`);
  desk.start();
});
const shutdown = () => { desk.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1500).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
