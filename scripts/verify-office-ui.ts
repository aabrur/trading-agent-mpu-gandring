// Offline checks: fixture office feeds and a disposable PAPER Setup server with a temporary config.
// No configured trading server or venue is contacted.
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import { makeCaller } from '../server/providers/index.js';
import { buildReport } from '../server/reports.js';
import type { WebSocketRoute } from 'playwright-core';
import { createApp } from '../server/app.js';
import { readEnv } from '../cli/envfile.js';

const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_PROVIDER: 'mock', AUTO_TRADING: 'off' });
const desk = new Desk(cfg, makeCaller(cfg), { reportsDir: null, learningsPath: null });
const at = Date.now();
for (let i = 0; i < 50; i++) desk.activity.push({ at: at - i - 1, kind: 'skipped', symbol: 'ETHUSDT', detail: 'Waiting for a closed candle above resistance.' });
const report = buildReport(desk, at - 60_000, at);
desk.reports = Array.from({ length: 8 }, (_, i) => ({ ...report, id: `report-${i}`, at: at - i * 60_000 }));
const snapshot = desk.snapshot();
snapshot.verdicts = [{ id: 'preview-hold', at, symbol: 'ETHUSDT', action: 'HOLD', riskDecision: 'REJECT', executed: false, reason: 'Waiting for a closed candle. No valid entry is available.', disagreement: 0.1, weighted: 0, camps: { bull: [], bear: [], neutral: [] }, order: null, example: true }];

const executablePath = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => p && existsSync(p));
if (!executablePath) throw new Error('Set CHROME_PATH to a Chromium browser.');
const output = process.env.OFFICE_CHECK_OUTPUT ?? path.join(process.env.TEMP ?? '.', 'mpu-office-ui');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
async function verifyOffice() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let socket: WebSocketRoute;
  let restartFails = false;
  const sessionLogRequests: URL[] = [];
  const sessionId = 'mpu-2026-10-26T040000000Z-fixture';
  const childSessionId = 'mpu-2026-10-26T040001000Z-childfix';
  const sessionSummary = { sessionId, parentSessionId: null, startedAt: '2026-10-26T04:00:00.000Z', endedAt: null, version: '0.0.0.4.0', gitRevision: null, pid: 1234, entrypoint: 'server/index.ts', mode: 'PAPER', appMode: 'local', exchange: null, outcome: null, exitReason: null, durationMs: null, lastSequence: 2, storageErrors: 0 };
  const childSessionSummary = { ...sessionSummary, sessionId: childSessionId, parentSessionId: sessionId, startedAt: '2026-10-26T04:00:01.000Z', gitRevision: 'child12345678', pid: 1235, lastSequence: 1 };
  const latestSessionEvent = { timestamp: '2026-10-26T04:00:02.000Z', sessionId, sequence: 2, level: 'ERROR', category: 'execution', source: 'server', eventName: 'stop_check', status: 'failed', message: 'Exchange stop was not confirmed', correlationId: 'corr-fixture-1', durationMs: 12, details: { fixture: true, cause: 'missing stop' } };
  const olderSessionEvent = { ...latestSessionEvent, timestamp: '2026-10-26T04:00:01.000Z', sequence: 1, level: 'INFO', eventName: 'session_start', status: 'started', message: 'Session started', durationMs: undefined, details: {} };
  const childSessionEvent = { ...latestSessionEvent, sessionId: childSessionId, sequence: 1, level: 'INFO', message: 'Child session event', details: {} };
  const staleChildEvent = { ...childSessionEvent, sequence: 0, message: 'Child older event' };
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/setup/restart' && restartFails) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, detail: 'Restart unavailable' }) });
    if (url.pathname === '/api/logs/sessions') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, activeSessionId: sessionId, sessions: [childSessionSummary], nextCursor: null }) });
    if (url.pathname === `/api/logs/sessions/${sessionId}`) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, session: sessionSummary }) });
    if (url.pathname.endsWith('/events') && url.pathname.includes('/api/logs/sessions/')) {
      sessionLogRequests.push(url);
      const selectedSession = decodeURIComponent(url.pathname.split('/').at(-2) ?? '');
      const pageCursor = url.searchParams.get('cursor');
      if (pageCursor) await new Promise((resolve) => setTimeout(resolve, 250));
      const events = pageCursor === 'older-fixture-page' ? [olderSessionEvent]
        : pageCursor === 'older-child-page' ? [staleChildEvent]
          : selectedSession === childSessionId ? [childSessionEvent] : [latestSessionEvent];
      const nextCursor = pageCursor ? null : selectedSession === childSessionId ? 'older-child-page' : 'older-fixture-page';
      try { return await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, events, nextCursor }) }); }
      catch { return; }
    }
    const data = url.pathname === '/api/wallet' ? { available: true, current: 'hyperliquid', venues: [{ venue: 'hyperliquid', label: 'Hyperliquid', kind: 'DEX', support: 'signature', steps: [], depositUrl: 'https://app.hyperliquid.xyz', revokeUrl: 'https://app.hyperliquid.xyz/API', docsUrl: 'https://hyperliquid.gitbook.io' }] }
      : url.pathname === '/api/wallet/balance' ? { ok: true, equityUsdt: null }
      : url.pathname === '/api/setup/trading' ? { ok: true, networks: { testnet: { profile: 'default' } } }
      : url.pathname === '/api/candles' ? { symbol: snapshot.watchlist[0], source: 'sample', example: true, last: 100, change24hPct: 0, candles: [] }
      : { ok: true, killed: false };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.routeWebSocket('**/ws', (ws) => { socket = ws; ws.send(JSON.stringify({ type: 'state', payload: snapshot })); });
  await page.addInitScript('window.__name = (target) => target;');
  await page.addInitScript(() => {
    const account = '0x1111111111111111111111111111111111111111';
    let activeAccount = account;
    const listeners: Record<string, (() => void)[]> = {};
    localStorage.setItem('mg-wallet-address', account);
    Object.assign(window, { ethereum: {
      request: async ({ method }: { method: string }) => {
        if (method === 'eth_requestAccounts') { activeAccount = account; return [account]; }
        if (method === 'eth_accounts') return activeAccount ? [activeAccount] : [];
        if (method === 'eth_chainId') return '0xa4b1';
        if (method === 'wallet_revokePermissions') return null;
        throw new Error(`Unexpected wallet method: ${method}`);
      },
      on: (event: string, listener: () => void) => { (listeners[event] ??= []).push(listener); },
      removeListener: (event: string, listener: () => void) => { listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener); }
    }, emitWalletEvent: (event: string) => { if (event === 'accountsChanged') activeAccount = ''; listeners[event]?.forEach((fn) => fn()); } });
  });
  await page.goto(process.env.OFFICE_CHECK_URL ?? 'http://127.0.0.1:5178');
  await page.waitForSelector('.office');
  if (!process.env.OFFICE_SETTINGS_ONLY) {
  await page.locator('.tour-skip-btn').click();
  await page.locator('.trakteer-close-x').click();
  await page.waitForFunction(() => document.querySelector('#venue-keys-trigger')?.textContent?.includes('Connected'));
  await page.locator('#tool-log').click();
  await page.getByRole('button', { name: 'Archived sessions', exact: true }).click();
  await page.getByLabel('Choose archived session').selectOption(sessionId);
  await page.getByText('Exchange stop was not confirmed', { exact: true }).waitFor();
  assert((await page.getByLabel('Choose archived session').locator('option:checked').innerText()).includes('ACTIVE'));
  assert((await page.locator('.session-summary').innerText()).includes('revision unavailable'), 'null Git revision displays a fallback instead of throwing');
  assert.equal(await page.locator('.session-downloads a').count(), 4);
  await page.locator('.session-event-details summary').click();
  assert((await page.locator('.session-event-details pre').innerText()).includes('missing stop'));
  await page.locator('.session-filters select').selectOption('ERROR');
  await page.locator('.session-filters input').nth(0).fill('server');
  const correlationResponse = page.waitForResponse((response) => response.url().includes('correlationId=corr-fixture-1'));
  await page.getByRole('button', { name: 'corr-fixture-1', exact: true }).click();
  await correlationResponse;
  await page.waitForFunction(() => document.querySelector<HTMLInputElement>('.session-filters label:last-child input')?.value === 'corr-fixture-1');
  assert(sessionLogRequests.some((request) => request.searchParams.get('level') === 'ERROR' && request.searchParams.get('source') === 'server' && request.searchParams.get('correlationId') === 'corr-fixture-1'));
  await page.getByRole('button', { name: 'Older events', exact: true }).click();
  await page.getByText('Session started', { exact: true }).waitFor();
  const eventTimes = await page.locator('.session-event').evaluateAll((events) => events.map((event) => Date.parse(event.querySelector('time')?.getAttribute('datetime') ?? '')));
  assert.equal(eventTimes.length, 2, 'older events append without losing the newer page');
  assert(eventTimes[0] < eventTimes[1], 'older chronological page is prepended');
  await page.getByLabel('Choose archived session').selectOption(childSessionId);
  await page.getByText('Child session event', { exact: true }).waitFor();
  const stalePageRequest = page.waitForRequest((request) => request.url().includes('cursor=older-child-page'));
  await page.getByRole('button', { name: 'Older events', exact: true }).click();
  await stalePageRequest;
  await page.getByLabel('Choose archived session').selectOption(sessionId);
  await page.getByText('Exchange stop was not confirmed', { exact: true }).waitFor();
  await page.waitForTimeout(300);
  assert.equal(await page.getByText('Child older event', { exact: true }).count(), 0, 'late page from the previous session cannot enter the selected session');
  await page.getByRole('button', { name: 'Live', exact: true }).click();
  assert.equal(await page.locator('#pane-log .activity-log-controls').count(), 1, 'live System Log remains available');
  await page.locator('#tool-history').click();
  assert.equal(await page.locator('.activity-log-controls select[aria-label="History filter"]').count(), 1, 'History remains a separate view');
  if (process.env.OFFICE_ARCHIVE_ONLY) {
    assert.deepEqual(errors, []);
    console.log('Session archive fixture checks passed, including delayed-response isolation and live/history separation.');
    return;
  }
  await page.locator('.tool-close').click();
  assert.equal(await page.locator('.desk-ops .ops-setup-link').count(), 0);
  assert.equal(await page.locator('.side .verdicts').count(), 0);
  assert.equal(await page.locator('.office-hud .verdicts').count(), 1);
  assert.equal(await page.locator('.workspace-heading, .desk-overview').count(), 0);
  assert.equal(await page.getByRole('heading', { name: 'Around the office', exact: true }).count(), 0);
  assert.equal(await page.locator('.office-hud .office-orders .n-picker').count(), 1);
  assert.equal(await page.locator('.portfolio .n-picker').count(), 0);
  assert.equal(await page.locator('.office-orders .mini-chart, .office-orders .formula, .office-orders .positions').count(), 0);
  assert.equal(await page.locator('.portfolio .order-details .mini-chart').count(), 2);
  assert.equal(await page.locator('.studio-sign img[src="/mpu-gandring-logo.webp"]').count(), 1);
  assert.equal(await page.locator('.studio-desk-wood').evaluateAll((desks) => new Set(desks.map((desk) => (desk as HTMLImageElement).getAttribute('src'))).size), 6, 'Each agent has a distinct supplied desk set');
  assert.equal(await page.locator('.studio-meeting-label').count(), 0);
  assert.equal(await page.locator('.studio-coffee > img[src="/office-assets/mg_prop_coffee_counter.webp"]').count(), 1);
  assert.equal(await page.locator('.meeting-book, .meeting-plant').count(), 2);
  assert(await page.locator('[data-desk="risk"] .studio-desk-wood').getAttribute('src') === '/office-assets/mg_prop_risk_desk.webp');
  assert(await page.locator('[data-desk="execution"] .studio-desk-wood').getAttribute('src') === '/office-assets/mg_prop_execution_terminal.webp');
  assert.equal((await page.locator('.office-pnl').innerText()).includes('PAPER'), false);
  assert.equal(await page.locator('.report').count(), 5);
  assert.equal(await page.locator('.report-evidence[open]').count(), 0);
  async function assertOfficeSpace() {
    const problems = await page.evaluate(() => {
      const world = document.querySelector('.office-world')!.getBoundingClientRect();
      const hud = document.querySelector('.office-hud')!.getBoundingClientRect();
      const pnl = document.querySelector('.office-pnl')!.getBoundingClientRect();
      const overlaps = (a: DOMRect, b: DOMRect) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
      const errors: string[] = [];
      for (const panel of document.querySelectorAll<HTMLElement>('.office-hud, .office-hud .verdict-list, .office-orders')) {
        if (panel.scrollHeight > panel.clientHeight + 1) errors.push(`Map indicator content overflows vertically: ${panel.className} ${panel.scrollHeight}/${panel.clientHeight}`);
        if (panel.scrollWidth > panel.clientWidth + 1) errors.push('Map indicator content overflows horizontally');
        if (['auto', 'scroll'].includes(getComputedStyle(panel).overflowY)) errors.push('Map indicators still scroll');
      }
      if (innerWidth > 768 && innerHeight >= 600 && hud.bottom > world.bottom + 1) errors.push('Map indicators extend below the room');
      const table = document.querySelector('.studio-meeting')!.getBoundingClientRect();
      if (Math.abs(table.x + table.width / 2 - (world.x + world.width / 2)) > 1 || Math.abs(table.y + table.height / 2 - (world.y + world.height * .65)) > 1) errors.push('Table is not centered on the floor');
      const decor = [...document.querySelectorAll('.studio-table-inlay, .meeting-cup, .meeting-book, .meeting-plant')];
      for (let i = 0; i < decor.length; i++) for (let j = i + 1; j < decor.length; j++) {
        if (overlaps(decor[i].getBoundingClientRect(), decor[j].getBoundingClientRect())) errors.push('Table decorations overlap');
      }
      if (document.querySelectorAll('.studio-library img').length !== 1 || !document.querySelector('.studio-library img[src="/office-assets/mg_prop_bookshelf.webp"]')) errors.push('Bookshelf must use the complete stocked bundle');
      for (const img of document.querySelectorAll('.studio-room img, .studio-desk img, .studio-meeting img, .studio-chair')) {
        const bounds = img.getBoundingClientRect();
        if (bounds.left < world.left - 1 || bounds.right > world.right + 1 || bounds.top < world.top - 1 || bounds.bottom > world.bottom + 1) errors.push('Furniture is clipped by the room');
      }
      if (overlaps(world, hud)) errors.push('HUD covers the room');
      if (overlaps(world, pnl)) errors.push('PnL covers the room');
      for (const element of document.querySelectorAll('.office-world .agent .bot')) {
        const box = element.getBoundingClientRect();
        if (box.left < world.left || box.right > world.right || box.top < world.top || box.bottom > world.bottom) errors.push('Agent outside room');
        if (overlaps(box, hud)) errors.push('Agent hidden behind HUD');
      }
      if (!document.querySelector('.brawl-zone')) {
        const avatars = [...document.querySelectorAll('.office-world .agent .bot')];
        for (let i = 0; i < avatars.length; i++) for (let j = i + 1; j < avatars.length; j++) {
          if (overlaps(avatars[i].getBoundingClientRect(), avatars[j].getBoundingClientRect())) errors.push('Agents overlap outside a fight');
        }
      }
      if (document.querySelector('.office-world .bubble')) errors.push('Speech still overlays the room');
      return errors;
    });
    assert.deepEqual(problems, []);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('.office-world img')].every((img) => img.complete && img.naturalWidth > 0));
  await assertOfficeSpace();
  for (const id of ['lead', 'market', 'research', 'strategist', 'risk', 'execution']) {
    const agent = page.locator(`[data-agent="${id}"] > button`);
    const before = await agent.boundingBox();
    assert(before);
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    const pressed = await agent.boundingBox();
    assert(pressed && Math.abs(pressed.x - before.x) < 1 && Math.abs(pressed.y - before.y) < 1, `${id} stays in place while pressed`);
    await page.mouse.up();
    await page.waitForSelector('.agent-panel');
    const input = page.locator('.ap-input textarea');
    await input.fill('First paragraph');
    await input.press('Shift+Enter');
    await input.pressSequentially('Second paragraph');
    assert.equal(await input.inputValue(), 'First paragraph\nSecond paragraph');
    await page.locator('.agent-panel > .close').click();
  }
  for (const viewport of [{ width: 1920, height: 936 }, { width: 1366, height: 768 }, { width: 1024, height: 600 }]) {
    await page.setViewportSize(viewport);
    await page.waitForFunction(() => document.querySelector('.desk-team')!.getBoundingClientRect().bottom <= innerHeight);
    await assertOfficeSpace();
    const geometry = await page.evaluate(() => ({
      office: document.querySelector('.office')!.getBoundingClientRect().toJSON(),
      stage: document.querySelector('.stage')!.getBoundingClientRect().toJSON(),
      roster: document.querySelector('.desk-team')!.getBoundingClientRect().toJSON()
    }));
    assert(Math.abs(geometry.office.width - geometry.stage.width) < 1, 'Office keeps the full stage width');
    assert(geometry.office.top >= 0 && geometry.roster.bottom <= viewport.height, 'Complete office and agent row fit the viewport');
    assert(await page.locator('.roster').evaluate((roster) => roster.scrollWidth <= roster.clientWidth), 'All six desktop agent buttons fit the row');
    assert(geometry.office.height >= viewport.height * .6, 'Room must retain most of the viewport height');
    assert(await page.locator('.office-hud').evaluate((hud) => hud.getBoundingClientRect().width <= 200), 'Map indicators remain compact');
    assert(await page.locator('.office-world .agent .bot').evaluateAll((bots) => bots.every((bot) => bot.getBoundingClientRect().width >= 48 && bot.getBoundingClientRect().width <= 60)), 'Scene agents stay readable at 48 to 60px');
    await page.screenshot({ path: path.join(output, `office-fit-${viewport.width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator('.verdict-reason-trigger').click();
  assert(await page.locator('.office-verdict-popover:popover-open').isVisible());
  await assertOfficeSpace();
  await page.locator('.office-verdict-popover button').click();
  const nRequest = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/ops/auto' && request.method() === 'POST');
  await page.locator('.office-orders .n-picker button').filter({ hasText: /^2$/ }).click();
  assert.deepEqual((await nRequest).postDataJSON(), { n: 2 });
  await page.locator('#tool-ops').click();
  await page.locator('.tool-flyout').hover();
  await page.waitForFunction(() => document.documentElement.style.overflow === 'hidden');
  const backgroundScroll = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 800);
  assert.equal(await page.evaluate(() => window.scrollY), backgroundScroll, 'Page must not scroll while inside an open tool.');
  await page.mouse.move(1, 1);
  await page.waitForFunction(() => document.documentElement.style.overflow !== 'hidden');
  const preset = await page.locator('.auto-preset-select').boundingBox();
  const cycle = await page.locator('.auto-run-btn').boundingBox();
  assert(preset && cycle && preset.y + preset.height <= cycle.y, 'Preset must sit above Cycle now.');
  assert(preset.width < 220, 'Preset must not span the panel.');
  await page.getByRole('button', { name: 'Close tool panel' }).click();
  await page.locator('#setup-trigger').click();
  assert(await page.locator('.settings-popover .tour-trigger-btn').isVisible());
  assert.equal(await page.locator('.settings-popover .lang-toggle-btn').count(), 1);
  assert.equal(await page.locator('.badges > .lang-toggle-btn').count(), 0);
  await page.locator('.settings-popover .lang-toggle-btn').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('mg-lang')), 'id');
  await page.locator('.settings-popover .lang-toggle-btn').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('mg-lang')), 'en');
  await page.locator('#setup-trigger').click();
  const restartRequest = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/setup/restart' && request.method() === 'POST');
  await page.locator('#header-restart').click();
  await restartRequest;
  await page.waitForFunction(() => document.querySelector('.topbar-restart-feedback')?.textContent?.includes('synchronized'));
  await page.waitForSelector('.topbar-restart-feedback', { state: 'detached' });
  restartFails = true;
  await page.locator('#header-restart').click();
  await page.waitForFunction(() => document.querySelector('.topbar-restart-feedback')?.textContent === 'Restart unavailable');
  restartFails = false;
  await page.waitForSelector('.topbar-restart-feedback', { state: 'detached' });
  await page.screenshot({ path: path.join(output, 'office-desktop.png'), fullPage: true });
  await page.locator('.office').screenshot({ path: path.join(output, 'office-room.png') });
  await page.getByRole('button', { name: 'Show older reports', exact: true }).click();
  assert.equal(await page.locator('.report').count(), 8);
  await page.locator('#venue-keys-trigger').click();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#venue-keys-trigger')?.textContent?.includes('Connect Wallet'));
  assert.equal(await page.evaluate(() => localStorage.getItem('mg-wallet-address')), null);
  await page.getByRole('button', { name: 'Connect browser wallet', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#venue-keys-trigger')?.textContent?.includes('Connected'));
  await page.evaluate(() => (window as unknown as { emitWalletEvent(event: string): void }).emitWalletEvent('accountsChanged'));
  await page.waitForFunction(() => document.querySelector('#venue-keys-trigger')?.textContent?.includes('Connect Wallet'));
  await page.getByRole('button', { name: 'Close wallet', exact: true }).click();
  await page.waitForSelector('.wallet-dropdown', { state: 'detached' });
  const live = structuredClone(snapshot);
  live.mode = 'LIVE';
  socket!.send(JSON.stringify({ type: 'state', payload: live }));
  await page.waitForFunction(() => document.querySelector('.live-badge') != null);
  assert(!/LIVE|Exchange/.test(await page.locator('.office-pnl').innerText()), 'Map PnL omits mode and exchange source labels.');
  const reading = structuredClone(snapshot);
  reading.debate = { id: 'test-reading', symbol: 'ETHUSDT', phase: 'reading', round: 0, disagreement: 0, weighted: 0, camps: { bull: [], bear: [], neutral: [] } };
  reading.agents.research.status = 'reading';
  socket!.send(JSON.stringify({ type: 'state', payload: reading }));
  await page.waitForSelector('[data-agent="research"] [data-activity="read"]');
  await assertOfficeSpace();
  await page.locator('.office').screenshot({ path: path.join(output, 'office-analysis.png') });
  const hot = structuredClone(snapshot);
  hot.paper.unrealized = -7.5;
  hot.paper.positions = Array.from({ length: 4 }, (_, i) => ({ id: `position-${i}`, symbol: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'][i], side: 'LONG' as const, qty: 1, entry: 100, stop: 95, tp: 110, margin: 200, leverage: 1, openedAt: Date.now(), mark: 101, unrealizedPnl: 1 }));
  hot.debate = { id: 'test-hot', symbol: 'ETHUSDT', phase: 'round 1', round: 1, disagreement: 0.9, weighted: 0, camps: { bull: ['market', 'strategist'], bear: ['research', 'risk'], neutral: ['lead', 'execution'] } };
  hot.agents.market.stance = 'LONG'; hot.agents.research.stance = 'SHORT';
  socket!.send(JSON.stringify({ type: 'state', payload: hot }));
  socket!.send(JSON.stringify({ type: 'speech', payload: { agent: 'risk', at: Date.now(), text: 'Long debate text. '.repeat(30), done: true, example: true } }));
  await page.waitForSelector('.discussion-bubble i');
  assert.equal(await page.locator('.office-dialogue').count(), 0);
  await page.locator('.discussion-bubble').click();
  assert(await page.locator('.discussion-popover').isVisible());
  await page.getByRole('button', { name: 'Close discussion' }).click();
  await page.waitForFunction(() => document.querySelector('.office-pnl strong')?.textContent?.includes('-7.50'));
  await assertOfficeSpace();
  assert.equal(await page.locator('.brawl-zone').count(), 0, 'Reduced motion suppresses fights');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForSelector('.brawl-zone', { timeout: 8000 });
  assert.equal(await page.locator('.brawl-zone .combat-cloud').count(), 2);
  assert.equal(await page.locator('.brawl-zone .brawl-limb').evaluateAll((limbs) => limbs.every((limb) => limb.tagName === 'IMG')), true);
  assert.equal(await page.locator('[data-activity="punch"], [data-activity="guard"]').count(), 2);
  await page.locator('.office').screenshot({ path: path.join(output, 'office-hot-debate.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForSelector('.brawl-zone', { state: 'detached' });
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.screenshot({ path: path.join(output, 'office-busy-1024.png') });
  await assertOfficeSpace();
  await page.locator('#tool-book').click();
  assert.equal(await page.locator('.portfolio .order-details .pos').count(), 4);
  await page.getByRole('button', { name: 'Close tool panel' }).click();
  for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }]) {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.screenshot({ path: path.join(output, `office-${viewport.width}.png`), fullPage: true });
    if (viewport.width === 375) await page.screenshot({ path: path.join(output, 'office-mobile-top.png') });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow at ${viewport.width}px`);
    const roster = await page.locator('.roster-item').evaluateAll((items) => items.map((item) => ({ y: item.getBoundingClientRect().y, h: item.getBoundingClientRect().height })));
    assert(roster.every((item) => Math.abs(item.y - roster[0].y) < 1 && item.h === 44), 'Roster stays equal height in a single row.');
    await assertOfficeSpace();
    if (viewport.width === 375) await page.locator('.office-pnl').screenshot({ path: path.join(output, 'office-pnl-mobile.png') });
    await page.locator('.office').screenshot({ path: path.join(output, `office-room-${viewport.width}.png`) });
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  socket!.send(JSON.stringify({ type: 'state', payload: snapshot }));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => document.querySelectorAll('[data-activity="sit"]').length === 6);
  await page.locator('.office').screenshot({ path: path.join(output, 'office-idle-activities.png') });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'night'; });
  await page.screenshot({ path: path.join(output, 'office-night.png'), fullPage: true });
  await page.locator('.office').screenshot({ path: path.join(output, 'office-night-room.png') });
  }
  const settingsDir = mkdtempSync(path.join(tmpdir(), 'mpu-office-settings-'));
  const settingsFile = path.join(settingsDir, 'fixture.env');
  writeFileSync(settingsFile, 'TRADING_MODE=PAPER\nMARKET_SOURCE=sample\nDEFAULT_PROVIDER=mock\nAUTO_TRADING=off\nSAFETY_NET=200\nTESTNET_DESK_PROFILE=default\n');
  const fixtureApp = createApp(cfg, { envFile: settingsFile, reportsDir: null, learningsPath: null });
  await new Promise<void>((resolve) => fixtureApp.server.listen(0, '127.0.0.1', resolve));
  const fixtureBase = `http://127.0.0.1:${(fixtureApp.server.address() as AddressInfo).port}`;
  try {
    await page.route((url) => url.pathname.startsWith('/api/setup'), async (route) => {
      const request = route.request(), url = new URL(request.url());
      const response = await fetch(fixtureBase + url.pathname + url.search, { method: request.method(), headers: { 'content-type': 'application/json' }, ...(request.method() !== 'GET' ? { body: request.postData() } : {}) });
      await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
    });
    await page.evaluate(() => { window.location.hash = 'setup-trading-manual'; });
    const settings = page.locator('.trading-setup');
    await settings.getByLabel('Settings profile', { exact: true }).waitFor();
    const cases = [['default', 50, 20, 5], ['balance', 60, 30, 10], ['profit', 70, 40, 15], ['aggressive', 80, 50, 20]] as const;
    for (const [profile, confidence, loss, leverage] of cases) {
      await settings.getByLabel('Settings profile', { exact: true }).selectOption(profile);
      assert.equal(await settings.getByLabel('Minimum entry confidence (%)', { exact: true }).inputValue(), String(confidence));
      assert.equal(await settings.getByLabel('Risk per trade (%)', { exact: true }).inputValue(), String(loss));
      assert.equal(await settings.getByLabel('Maximum leverage (x)', { exact: true }).inputValue(), String(leverage));
    }
    const size = settings.getByLabel('Order size (% of Money Trade)', { exact: true });
    await size.fill('5');
    await settings.locator('button[type="submit"]').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.trading-setup [role="status"]')].some((node) => node.textContent?.toLowerCase().includes('saved')));
    assert.equal(readEnv(settingsFile).TESTNET_DESK_SAVED_ORDER_SIZE_PCT, '5');
    await size.fill('100');
    await settings.getByRole('button', { name: 'Discard edits', exact: true }).click();
    assert.equal(await size.inputValue(), '5', 'Discard restores the loaded percentage, including a saved preset');
    await settings.screenshot({ path: path.join(output, 'trading-profiles.png') });
    await page.getByRole('dialog', { name: 'Setup', exact: true }).getByRole('button', { name: 'Close', exact: true }).click();
  } finally {
    fixtureApp.desk.stop();
    await new Promise<void>((resolve) => fixtureApp.server.close(() => resolve()));
    rmSync(settingsDir, { recursive: true, force: true });
  }
  assert.deepEqual(errors, []);
  console.log(`Office, chat, profile and wallet session checks passed. Screenshots: ${output}`);
}
try { await verifyOffice(); } finally { await browser.close(); }
