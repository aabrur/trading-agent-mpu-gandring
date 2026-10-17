// Takes a real screenshot of the running office: node scripts/screenshot.mjs [url] [out]
// Needs `npm run dev` running and a Chrome or Chromium on the machine
// (set CHROME_PATH if it is not found automatically).
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5173/';
const out = process.argv[3] ?? 'docs/screenshot.png';
const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].filter(Boolean);
const executablePath = candidates.find((p) => existsSync(p));
if (!executablePath) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(1); }

const api = (p, body) => fetch(new URL(p, url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('.office');

// one debate so the verdict panel and paper book have something in them
const first = process.env.SHOT_FIRST ?? 'ETHUSDT';
console.log('warm-up debate', first, (await api('/api/debate', { symbol: first })).verdict?.action);

// second debate: catch it mid-argument, ideally with a punch on screen
await api('/api/command', { text: `analyze ${process.env.SHOT_SYMBOL ?? 'BTCUSDT'}` });
let shot = false;
for (let i = 0; i < 120 && !shot; i++) {
  await page.waitForTimeout(250);
  const pow = await page.$('.pow');
  const bubbles = await page.$$('.bubble');
  if (pow && bubbles.length >= 2) { await page.waitForTimeout(350); shot = true; }
}
if (!shot) console.log('no punch caught, taking the frame as is');
await page.screenshot({ path: out });
console.log('saved', out);
await browser.close();
