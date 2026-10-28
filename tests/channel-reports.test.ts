import { describe, expect, it } from 'vitest';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import { makeCaller } from '../server/providers/index.js';
import { parseCommand, runCommand } from '../server/channels/commands.js';
import { ChannelHub } from '../server/channels/adapters.js';
import { channelConfig } from '../server/channels/config.js';

function fixture() {
  const cfg = loadConfig({ TRADING_MODE: 'PAPER', DEFAULT_PROVIDER: 'mock', MARKET_SOURCE: 'sample', PAPER_BALANCE: '1234.56', SAFETY_NET: '200', OPEN_ORDERS_N: '2' });
  return new Desk(cfg, makeCaller(cfg), { reportsDir: null, learningsPath: null, conversationsPath: null, opportunityReviewsPath: null, killFile: null, jevEnv: {} });
}

describe('shared channel command reports', () => {
  it('separates status, capital and guards without changing settings or claiming an unrun scan is clear', async () => {
    const desk = fixture(), before = structuredClone(desk.cfg.risk);
    const report = await runCommand(desk, parseCommand('/status'));
    expect(report).toContain('Desk Lead status: PAPER');
    expect(report).toContain('CAPITAL · USDT\nEquity: 1,234.56 · Balance: 1,234.56');
    expect(report).toContain('Safety net: 200.00');
    expect(report).toContain('Occupied slots: 0/2 · Free: 2');
    expect(report).toContain('Kill switch: OFF');
    expect(report).toContain('Not run yet. Use /scan');
    expect(desk.cfg.risk).toEqual(before);
    desk.killed = true;
    const stopped = await runCommand(desk, parseCommand('/status'));
    expect(stopped).toContain('Desk: STOPPED');
    expect(stopped).toContain('Kill switch: ON');
  });

  it('keeps precise prices, explicit protection state, and signed PnL in position cards', async () => {
    const desk = fixture();
    desk.book.open({ symbol: 'PEPEUSDT', side: 'LONG', qty: 1000000, entry: .00000123, stop: .0000011, tp: .0000015, margin: 1.23, leverage: 1 });
    desk.cfg.tradingMode = 'LIVE';
    desk.book.positions[0].unrealizedPnl = -.12;
    const report = await runCommand(desk, parseCommand('/positions'));
    expect(report).toContain('1. PEPEUSDT · LONG · 1x');
    expect(report).toContain('Entry: 0.00000123');
    expect(report).toContain('SL: 0.0000011 · TP: 0.0000015');
    expect(report).toContain('Protection: Unverified on exchange');
    expect(report).toContain('Unrealized PnL: -0.12 USDT');
    desk.book.positions[0].stop = 0;
    expect(await runCommand(desk, parseCommand('/positions'))).toContain('SL: NONE (alert)');
  });

  it('puts urgent scan findings before information and preserves all original finding text', async () => {
    const desk = fixture();
    desk.book.open({ symbol: 'BTCUSDT', side: 'LONG', qty: .01, entry: 100, stop: 90, tp: 120, margin: 1, leverage: 1 });
    desk.book.positions[0].stop = 0;
    const report = await runCommand(desk, parseCommand('/scan'));
    expect(report).toContain('Alerts: 1 · Warnings: 0');
    expect(report).toContain('🚨 ALERTS\n• BTCUSDT LONG has no stop loss.');
    expect(report.indexOf('🚨 ALERTS')).toBeLessThan(report.indexOf('ℹ INFORMATION'));
    expect(desk.book.positions).toHaveLength(1);
  });

  it('shows all six actual score rows and delivers each report intact through every mocked channel', async () => {
    const desk = fixture();
    desk.scorecard.verdict(); desk.scorecard.riskDecision('REJECT'); desk.scorecard.fill(false);
    const reports = await Promise.all(['/status', '/positions', '/scan', '/scorecard'].map(command => runCommand(desk, parseCommand(command))));
    const scorecard = reports[3];
    for (const row of desk.scorecard.rows()) {
      expect(scorecard).toContain(`${row.name}\nCalls: ${row.calls} · Right: ${row.right} · Wrong: ${row.wrong}\n${row.note}`);
    }
    const delivered: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { text?: string | { body: string }; content?: string };
      delivered.push(typeof body.text === 'string' ? body.text : body.content ?? body.text?.body ?? '');
      return new Response('{"ok":true}');
    };
    const hub = new ChannelHub(channelConfig({
      TELEGRAM_BOT_TOKEN: '123456789:' + 'A'.repeat(35), TELEGRAM_CHAT_ID: '1111',
      DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/123456789012345678/' + 'h'.repeat(60),
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T000/B000/' + 's'.repeat(24),
      WHATSAPP_ACCESS_TOKEN: 'fixture-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: '1234567890', WHATSAPP_TO: '6281200000000'
    }), fetchImpl);
    expect(hub.enabled()).toHaveLength(4);
    for (const report of reports) {
      delivered.length = 0;
      expect(report.length).toBeLessThan(1990);
      expect(Object.values(await hub.broadcast(report))).toEqual(['sent', 'sent', 'sent', 'sent']);
      expect(delivered).toEqual([report, report, report, report]);
    }
  });
});
