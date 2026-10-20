// Isolated PAPER preview for browser verification. No .env, exchange calls, or trading routes.
import express from 'express';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import { makeCaller } from '../server/providers/index.js';
import { buildReport } from '../server/reports.js';

const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_PROVIDER: 'mock', AUTO_TRADING: 'off', DEBATE_PACE_MS: '0' });
const desk = new Desk(cfg, makeCaller(cfg), { reportsDir: null, learningsPath: null });
const now = Date.now();
desk.agents.risk.lastLine = 'EXAMPLE: Wait for a closed candle and verify the stop before opening a position.';
desk.addLog({ kind: 'speech', agent: 'risk', example: true, text: desk.agents.risk.lastLine });
desk.reports = [buildReport(desk, now - 60_000, now)];
const snapshot = desk.snapshot();
snapshot.paper.unrealized = -1.25;
const app = express();
app.get('/api/wallet', (_req, res) => res.json({ available: true, current: 'aster', venues: [{ venue: 'aster', label: 'Aster', kind: 'DEX', support: 'signature', steps: ['Preview only. No venue authorization is submitted.'], docsUrl: 'https://www.asterdex.com', depositUrl: 'https://www.asterdex.com', revokeUrl: 'https://www.asterdex.com' }] }));
app.get('/api/wallet/balance', (_req, res) => res.json({ ok: true, configured: false, equityUsdt: null, availableUsdt: null, note: 'PAPER preview. Exchange balance unavailable.' }));
app.get('/api/ops/kill', (_req, res) => res.json({ killed: false }));
app.get('/api/setup/trading', (_req, res) => res.json({ ok: true, networks: { testnet: { profile: 'default' } } }));
app.get('/api/candles', (req, res) => res.json({ symbol: req.query.symbol, source: 'sample', example: true, last: 100, change24hPct: 0, candles: Array.from({ length: 32 }, (_, i) => ({ time: Math.floor(now / 1000) - (32 - i) * 900, open: 100 + Math.sin(i), high: 102 + Math.sin(i), low: 98 + Math.sin(i), close: 100 + Math.cos(i) })) }));
app.get('/api/update/status', (_req, res) => res.json({ ok: true, currentVersion: '0.0.0.3.4', latestVersion: '0.0.0.3.4', updateAvailable: false }));
app.use('/api', (_req, res) => res.status(403).json({ ok: false, error: 'PAPER preview: this action is disabled.' }));
app.get('/', (req, res) => {
  const mode = ['none', 'pending', 'reject'].includes(String(req.query.wallet)) ? String(req.query.wallet) : 'multi';
  const providerScript = `(() => {
    const mode = ${JSON.stringify(mode)};
    if (mode === 'none') return;
    function provider(name, rdns, address) {
      let connected = false;
      const listeners = {};
      const emit = (event, value) => (listeners[event] || []).forEach((fn) => fn(value));
      const wallet = {
        request: async ({method}) => {
          if (method === 'eth_accounts') return connected ? [address] : [];
          if (method === 'eth_requestAccounts') {
            if (mode === 'pending') throw {code: -32002, message: 'Pending request'};
            if (mode === 'reject') throw {code: 4001, message: 'User rejected'};
            connected = true; emit('accountsChanged', [address]);
            setTimeout(() => emit('accountsChanged', [address]), 0);
            return [address];
          }
          if (method === 'eth_chainId') return '0x38';
          if (method === 'wallet_revokePermissions') { connected = false; emit('accountsChanged', []); return null; }
          throw {message: 'Unsupported PAPER preview request'};
        },
        on: (event, fn) => (listeners[event] ||= []).push(fn),
        removeListener: (event, fn) => { listeners[event] = (listeners[event] || []).filter((item) => item !== fn); }
      };
      const announce = () => dispatchEvent(new CustomEvent('eip6963:announceProvider', {detail: { info: {uuid: rdns, rdns, name}, provider: wallet }}));
      addEventListener('eip6963:requestProvider', announce);
      announce();
    }
    provider('MetaMask (simulation)', 'io.metamask.preview', '0x1111111111111111111111111111111111111111');
    provider('Rabby (simulation)', 'io.rabby.preview', '0x2222222222222222222222222222222222222222');
  })();`;
  const html = readFileSync(path.resolve('dist/web/index.html'), 'utf8').replace('<head>', `<head><script>${providerScript}</script>`);
  res.type('html').send(html);
});
app.use(express.static(path.resolve('dist/web')));
const server = createServer(app);
const sockets = new WebSocketServer({ server, path: '/ws' });
sockets.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'state', payload: snapshot }));
  socket.send(JSON.stringify({ type: 'speech', payload: { agent: 'risk', at: now, text: desk.agents.risk.lastLine, done: true, example: true } }));
});
server.listen(5180, '127.0.0.1', () => console.log('Isolated PAPER preview: http://127.0.0.1:5180'));
