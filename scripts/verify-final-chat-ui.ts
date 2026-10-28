// Isolated PAPER UI acceptance. No production startup, settings, journal or provider process.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import type { ModelRequest } from '../server/providers/index.js';

const keep = new Set(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA']);
for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
process.env.DOTENV_CONFIG_PATH = '__isolated_no_env__';
const output = mkdtempSync(path.join(tmpdir(), 'mpu-final-chat-ui-'));
const envFile = path.join(output, 'settings.env'); writeFileSync(envFile, '');
const { loadConfig } = await import('../server/config.js');
const { Desk } = await import('../server/desk.js');
const { createApp } = await import('../server/app.js');
const { createServer } = await import('vite');
const { default: react } = await import('@vitejs/plugin-react');
const { chromium } = await import('playwright-core');
const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_PROVIDER: 'mock', AUTO_TRADING: 'off', DEBATE_PACE_MS: '0', LEARNING: 'off' });
const conversationsPath = path.join(output, 'conversations.json');
let failureSent = false;
let releaseLateFailure: (() => void) | undefined;
let signalLateFailure: (() => void) | undefined;
const lateFailureStarted = new Promise<void>(resolve => { signalLateFailure = resolve; });
const caller = async (request: ModelRequest) => {
  if (request.context.message === 'Delayed role failure') {
    await new Promise<void>(resolve => { releaseLateFailure = resolve; signalLateFailure?.(); });
    throw new Error('provider HTTP 401');
  }
  if (request.context.message === 'Force failure' && !failureSent) { failureSent = true; throw new Error('provider HTTP 401'); }
  return '{"reply":"Isolated fixture response."}';
};
const previous = new Desk(cfg, caller, { operationalSessionId: 'previous-run', conversationsPath, reportsDir: null, learningsPath: null, killFile: null, opportunityReviewsPath: null });
await previous.command('Previous run private message', 'lead');
await previous.command('Risk archive remains', 'risk');
previous.closeOperationalSession();
const built = createApp(cfg, { caller, conversationsPath, reportsDir: null, learningsPath: null, envFile, killFile: null, sessionLog: null, jevEnv: {} });
await built.desk.refreshTickers();
await new Promise<void>(resolve => built.server.listen(0, '127.0.0.1', resolve));
const api = `http://127.0.0.1:${(built.server.address() as { port: number }).port}`;
const vite = await createServer({ configFile: false, envDir: output, root: path.resolve('web'), plugins: [react()], server: { host: '127.0.0.1', port: 0, proxy: { '/api': api, '/ws': { target: api.replace('http:', 'ws:'), ws: true } } } });
await vite.listen();
const url = vite.resolvedUrls!.local[0];
const browser = await chromium.launch({ executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await page.addInitScript(() => { localStorage.setItem('mpu_tour_done_v1', '1'); localStorage.setItem('mg-lang', 'en'); });
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto(url); await page.locator('.agent-anchor').first().waitFor();
  await page.locator('.tour-skip-btn').click();
  // Close the existing support popup without interacting with its remote provider.
  const supportClose = page.locator('.trakteer-dialog .trakteer-close-x');
  await supportClose.waitFor(); await supportClose.click();
  for (const role of ['lead', 'market', 'research', 'strategist', 'risk', 'execution']) {
    await page.locator(`.agent-anchor[data-agent="${role}"] button.agent`).click();
    await page.locator('.agent-panel').waitFor();
    assert.equal(await page.locator('.agent-panel .msg').count(), 0, `${role}: new run must be empty`);
    assert.equal(await page.locator('.ap-desk-speech').count(), 0);
    await page.locator('.agent-panel button.close').click();
  }
  await page.locator('.agent-anchor[data-agent="lead"] button.agent').click();
  const panel = page.locator('.agent-panel');
  await panel.locator('textarea').fill('Hello fixture'); await panel.locator('textarea').press('Enter');
  await panel.locator('.msg.them:not([role="status"])').waitFor();
  await panel.locator('.msg[role="status"]').waitFor({ state: 'hidden' });
  assert.equal(await panel.locator('.msg.me').count(), 1); assert.equal(await panel.locator('.msg.them:not([role="status"])').count(), 1);
  await page.screenshot({ path: path.join(output, 'desktop-active.png') });
  await page.reload();
  await page.locator('.tour-skip-btn').click();
  await supportClose.waitFor(); await supportClose.click();
  await page.locator('.agent-anchor[data-agent="lead"] button.agent').click();
  await panel.locator('.msg.them:not([role="status"])').waitFor();
  assert.equal(await panel.locator('.msg').count(), 2, 'Reload continues current run');
  const historyUrl = '**/api/chat/history/lead?*';
  let releaseHistory: (() => void) | undefined;
  const historyPaused = new Promise<void>(resolve => { releaseHistory = resolve; });
  await page.route(historyUrl, async route => { await historyPaused; await route.continue(); });
  const historyRequest = page.waitForRequest(request => request.url().includes('/api/chat/history/lead?'));
  await panel.getByRole('button', { name: /session history|riwayat sesi/i }).click();
  await historyRequest;
  await page.locator('.agent-anchor[data-agent="risk"] button.agent').click();
  const lateHistory = page.waitForResponse(response => response.url().includes('/api/chat/history/lead?'));
  releaseHistory?.(); await lateHistory;
  assert.equal(await panel.getByRole('button', { name: /session history|riwayat sesi/i }).isEnabled(), true, 'Role change clears the previous history request busy state');
  assert.equal(await panel.locator('.ap-history-entry').count(), 0, 'Late Lead history stays out of Risk panel');
  await page.unroute(historyUrl);
  await page.locator('.agent-anchor[data-agent="lead"] button.agent').click();
  await panel.getByRole('button', { name: /session history|riwayat sesi/i }).click();
  await panel.locator('.ap-history-entry').first().click();
  await panel.getByText('Previous run private message', { exact: true }).waitFor();
  assert.equal(await panel.locator('textarea').isVisible(), false, 'Archive is read only');
  await page.screenshot({ path: path.join(output, 'desktop-history.png') });
  page.once('dialog', dialog => dialog.accept());
  await panel.getByRole('button', { name: /delete session|hapus sesi/i }).click();
  await panel.getByText(/no archived sessions|belum ada arsip/i).waitFor();
  assert.equal(built.desk.listChatHistory('lead').length, 0);
  assert.equal(built.desk.listChatHistory('risk').length, 1);
  await panel.getByRole('button', { name: /back to active chat|kembali ke chat aktif/i }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No mobile horizontal overflow');
  await page.screenshot({ path: path.join(output, 'mobile-active.png') });
  await panel.locator('textarea').fill('Force failure'); await panel.locator('textarea').press('Enter');
  await panel.getByRole('alert').waitFor();
  await panel.getByRole('button', { name: 'Retry message', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.agent-panel .msg.me').length === 3 && document.querySelectorAll('.agent-panel .msg.them:not([role="status"])').length === 3);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await panel.locator('button.close').click();
  await page.locator('.agent-anchor[data-agent="research"] button.agent').click();
  const lateReply = page.waitForResponse(response => response.url().endsWith('/api/command') && response.request().postDataJSON()?.text === 'Delayed role failure');
  await panel.locator('textarea').fill('Delayed role failure'); await panel.locator('textarea').press('Enter');
  await lateFailureStarted;
  await page.locator('.agent-anchor[data-agent="risk"] button.agent').click();
  releaseLateFailure?.(); await lateReply;
  await page.waitForFunction(() => !document.querySelector('.agent-panel [role="alert"]'));
  assert.equal(await panel.getByRole('button', { name: /retry message|check or retry request/i }).count(), 0, 'Late Research failure cannot add a retry to Risk panel');
  assert.equal(await panel.locator('textarea').isEnabled(), true);
  await panel.locator('button.close').click();
  const killButton = page.locator('.commandbar button.kill');
  const on = page.waitForResponse(response => response.url().endsWith('/api/ops/kill') && response.request().method() === 'POST');
  await killButton.click(); assert.equal((await (await on).json()).killed, true);
  const off = page.waitForResponse(response => response.url().endsWith('/api/ops/kill') && response.request().method() === 'POST');
  await killButton.click(); assert.equal((await (await off).json()).killed, false);
  assert.equal(built.desk.cfg.auto.on, false); assert.equal(built.desk.book.positions.length, 0);
  writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify({ status: 'PASS', mode: 'PAPER', provider: 'fixture', checks: ['six empty panels', 'one send one user and response', 'reload continuity', 'late history role-switch isolation', 'late chat failure role-switch isolation', 'read-only archive', 'confirmed role-only delete', 'mobile overflow', 'reduced motion', 'provider failure and explicit retry', 'one-click local kill ON/OFF preserves auto OFF'], screenshots: ['desktop-active.png', 'desktop-history.png', 'mobile-active.png'] }, null, 2));
  console.log(`PASS isolated UI acceptance: ${output}`);
} finally {
  await browser.close(); await vite.close();
  await new Promise<void>(resolve => built.close(() => resolve()));
}
