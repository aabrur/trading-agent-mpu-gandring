// Takes real screenshots of the running office:
//   node scripts/screenshot.mjs [url] [overview.png] [chat.png]
// Needs `npm run dev` running and Chrome or Chromium installed (set CHROME_PATH if it is not found).
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5173/';
const out = process.argv[3] ?? 'docs/screenshot.png';
const outChat = process.argv[4] ?? 'docs/screenshot-chat.png';
const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean);
const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(1); }

const api = (p, body) => fetch(new URL(p, url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1280 }, deviceScaleFactor: 1.5 });
if (process.env.SHOT_THEME) await page.addInitScript((t) => localStorage.setItem('mg-theme', t), process.env.SHOT_THEME);
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('.office');

// one debate so the verdict panel, chart lines and paper book have something in them
const first = process.env.SHOT_FIRST ?? 'ETHUSDT';
console.log('warm-up debate', first, (await api('/api/debate', { symbol: first })).verdict?.action);

// second debate: catch it mid-argument, ideally with a punch on screen
await api('/api/command', { text: `analyze ${process.env.SHOT_SYMBOL ?? 'BTCUSDT'}` });
let shot = false;
for (let i = 0; i < 160 && !shot; i++) {
  await page.waitForTimeout(200);
  const pow = await page.$('.pow');
  const bubbles = await page.$$('.bubble');
  if (pow && bubbles.length >= 1) { await page.waitForTimeout(300); shot = true; }
}
if (!shot) console.log('no punch caught, taking the frame as is');
await page.screenshot({ path: out });
console.log('saved', out);

// chat shot: wait for the debate to end, show the first symbol's chart, open an agent and talk
for (let i = 0; i < 200; i++) { const s = await (await fetch(new URL('/api/state', url))).json(); if (!s.debate) break; await page.waitForTimeout(250); }
const agent = process.env.SHOT_AGENT ?? 'Risk Manager';
await page.click(`.seg button:has-text("${first.replace('USDT', '')}")`).catch(() => {});
await page.click(`.roster-item:has-text("${agent}")`);
await page.fill('.ap-input input', 'How much would we lose if the stop hits?');
await page.click('.ap-input button');
await page.waitForTimeout(900);
await page.fill('.ap-input input', 'be more cautious');
await page.click('.ap-input button');
await page.waitForTimeout(900);
await page.evaluate(() => document.querySelector('.chart-panel')?.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(600);
await page.screenshot({ path: outChat });
console.log('saved', outChat);
await browser.close();
