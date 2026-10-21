// Offline browser checks. Every API and WebSocket response is simulated; no trading server is contacted.
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Desk } from '../server/desk.js';
import { loadConfig } from '../server/config.js';
import { makeCaller } from '../server/providers/index.js';
import { buildReport } from '../server/reports.js';
import type { WebSocketRoute } from 'playwright-core';

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
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let socket: WebSocketRoute;
  let restartFails = false;
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/setup/restart' && restartFails) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, detail: 'Restart unavailable' }) });
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
  await page.locator('.tour-skip-btn').click();
  await page.locator('.trakteer-close-x').click();
  await page.waitForFunction(() => document.querySelector('#venue-keys-trigger')?.textContent?.includes('Connected'));
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
  assert.equal(await page.locator('.studio-meeting-label').count(), 0);
  assert.equal(await page.locator('.coffee-machine, .meeting-book, .meeting-plant').count(), 3);
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
      const shelves = [...document.querySelectorAll('.studio-books')];
      if (shelves.length !== 4) errors.push('Bookshelf must have four stocked levels');
      for (const shelf of shelves) {
        const books = [...shelf.children];
        for (let i = 1; i < books.length; i++) if (overlaps(books[i - 1].getBoundingClientRect(), books[i].getBoundingClientRect())) errors.push('Bookshelf groups overlap');
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
    assert(await page.locator('.office-world .agent .bot').evaluateAll((bots) => bots.every((bot) => bot.getBoundingClientRect().width <= 40)), 'Scene agents stay small');
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
  await page.evaluate(() => { document.documentElement.dataset.theme = 'night'; });
  await page.screenshot({ path: path.join(output, 'office-night.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`Office layout and wallet session checks passed. Screenshots: ${output}`);
} finally { await browser.close(); }
