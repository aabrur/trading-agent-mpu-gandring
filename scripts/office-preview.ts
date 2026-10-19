// Isolated PAPER/mock preview. Never import the production startup or owner configuration.
const keep = new Set(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA']);
for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
process.env.DOTENV_CONFIG_PATH = '__isolated_no_env__';
const { loadConfig } = await import('../server/config.js');
const { createApp } = await import('../server/app.js');
const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_PROVIDER: 'mock', AUTO_TRADING: 'off', DEBATE_PACE_MS: '0', NEWS_PROVIDER: 'sample' });
const preview = createApp(cfg, { reportsDir: null, learningsPath: null, killFile: null, envFile: '.superpowers/qa-settings.env' });
await preview.desk.refreshTickers();
preview.server.listen(0, '127.0.0.1', () => {
  const address = preview.server.address();
  if (address && typeof address !== 'string') console.log('ISOLATED PAPER MOCK PREVIEW http://127.0.0.1:' + address.port);
});
