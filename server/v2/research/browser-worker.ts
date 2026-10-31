import dns from 'node:dns/promises';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';

export interface ResearchUrlPolicy {
  allowLoopbackPorts?: readonly number[];
  resolveAddresses?: (hostname: string) => Promise<string[]>;
}

export interface UrlValidationResult {
  ok: boolean;
  normalizedUrl: string | null;
  reason: string | null;
}

const SAFE_ENV_KEYS = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XDG_RUNTIME_DIR',
  'LANG',
  'LC_ALL',
  'TZ',
  'CHROME_PATH'
]);

const SECRET_NAME_RE = /(KEY|SECRET|TOKEN|PASS|PASSWORD|MNEMONIC|SEED|PRIVATE|CREDENTIAL|AUTH|WEBHOOK|COOKIE)/i;

export function buildIsolatedWorkerEnv(sourceEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (typeof value !== 'string') continue;
    const upper = key.toUpperCase();
    if (!SAFE_ENV_KEYS.has(upper)) continue;
    if (upper !== 'CHROME_PATH' && SECRET_NAME_RE.test(upper)) continue;
    out[key] = value;
  }
  return out;
}

export function detectBrowserExecutable(customPath?: string | null): string | null {
  const candidates = [
    customPath,
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter((item): item is string => typeof item === 'string' && item.trim().length > 0);

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return true;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = nums;

  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function expandIpv6Groups(raw: string): number[] | null {
  const zoneStripped = raw.split('%')[0]?.toLowerCase() ?? '';
  if (!zoneStripped) return null;

  let working = zoneStripped;
  const lastColon = working.lastIndexOf(':');
  if (lastColon !== -1 && working.slice(lastColon + 1).includes('.')) {
    const v4Part = working.slice(lastColon + 1);
    const octets = v4Part.split('.').map((p) => Number(p));
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    working = `${working.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const dblParts = working.split('::');
  if (dblParts.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const tokens = side.split(':');
    const out: number[] = [];
    for (const tok of tokens) {
      if (!/^[0-9a-f]{1,4}$/.test(tok)) return null;
      out.push(Number.parseInt(tok, 16));
    }
    return out;
  };

  if (dblParts.length === 1) {
    const full = parseSide(dblParts[0]!);
    return full && full.length === 8 ? full : null;
  }

  const left = parseSide(dblParts[0]!);
  const right = parseSide(dblParts[1]!);
  if (!left || !right || left.length + right.length >= 8) return null;
  const zeros = new Array<number>(8 - left.length - right.length).fill(0);
  return [...left, ...zeros, ...right];
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const groups = expandIpv6Groups(ip);
  if (!groups) return true;

  const allZeroPrefix5 = groups.slice(0, 5).every((g) => g === 0);
  const g0 = groups[0]!;
  const g1 = groups[1]!;
  const g5 = groups[5]!;
  const g6 = groups[6]!;
  const g7 = groups[7]!;

  // :: unspecified or ::1 loopback
  if (allZeroPrefix5 && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) {
    return true;
  }

  // IPv4-mapped ::ffff:a.b.c.d or IPv4-compatible ::a.b.c.d
  if (allZeroPrefix5 && (g5 === 0xffff || g5 === 0)) {
    const mappedV4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    return isPrivateOrReservedIpv4(mappedV4);
  }

  // 64:ff9b::/96 NAT64 well-known prefix
  if (g0 === 0x0064 && g1 === 0xff9b && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && g5 === 0) {
    const natV4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    return isPrivateOrReservedIpv4(natV4);
  }

  // fc00::/7 unique local
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfe80) return true;
  // ff00::/8 multicast
  if ((g0 & 0xff00) === 0xff00) return true;
  // 2001:db8::/32 documentation
  if (g0 === 0x2001 && g1 === 0x0db8) return true;

  return false;
}

export function isBlockedIpAddress(ip: string): boolean {
  const trimmed = ip.replace(/^\[|\]$/g, '').trim();
  const version = net.isIP(trimmed);
  if (version === 4) return isPrivateOrReservedIpv4(trimmed);
  if (version === 6) return isPrivateOrReservedIpv6(trimmed);
  return true;
}

async function defaultResolveAddresses(hostname: string): Promise<string[]> {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

function effectiveUrlPort(parsed: URL): number {
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === 'https:' ? 443 : 80;
}

export async function validateResearchUrl(
  rawUrl: string,
  policy: ResearchUrlPolicy = {}
): Promise<UrlValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, normalizedUrl: null, reason: 'Malformed URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      normalizedUrl: null,
      reason: `Unsupported URL scheme: ${parsed.protocol}`
    };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      normalizedUrl: null,
      reason: 'Credential-bearing URLs are prohibited'
    };
  }

  const hostRaw = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = effectiveUrlPort(parsed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, normalizedUrl: null, reason: 'Invalid target port' };
  }

  const allowLoopback = Boolean(
    policy.allowLoopbackPorts?.includes(port) &&
      (hostRaw === '127.0.0.1' || hostRaw === 'localhost' || hostRaw === '::1')
  );
  if (allowLoopback) {
    return { ok: true, normalizedUrl: parsed.toString(), reason: null };
  }

  if (
    hostRaw === 'localhost' ||
    hostRaw.endsWith('.localhost') ||
    hostRaw.endsWith('.local') ||
    hostRaw.endsWith('.internal') ||
    hostRaw === 'metadata' ||
    hostRaw === 'metadata.google.internal'
  ) {
    return {
      ok: false,
      normalizedUrl: null,
      reason: `Blocked internal/loopback hostname: ${hostRaw}`
    };
  }

  const ipVer = net.isIP(hostRaw);
  if (ipVer !== 0) {
    if (isBlockedIpAddress(hostRaw)) {
      return {
        ok: false,
        normalizedUrl: null,
        reason: `Blocked private, loopback or reserved IP: ${hostRaw}`
      };
    }
    return { ok: true, normalizedUrl: parsed.toString(), reason: null };
  }

  try {
    const resolver = policy.resolveAddresses ?? defaultResolveAddresses;
    const addresses = await resolver(hostRaw);
    if (!addresses || addresses.length === 0) {
      return { ok: false, normalizedUrl: null, reason: `DNS returned no records for ${hostRaw}` };
    }
    for (const addr of addresses) {
      if (isBlockedIpAddress(addr)) {
        return {
          ok: false,
          normalizedUrl: null,
          reason: `DNS resolved ${hostRaw} to blocked IP ${addr}`
        };
      }
    }
  } catch (err) {
    return {
      ok: false,
      normalizedUrl: null,
      reason: `DNS resolution failed for ${hostRaw}: ${err instanceof Error ? err.message : 'unavailable'}`
    };
  }

  return { ok: true, normalizedUrl: parsed.toString(), reason: null };
}

export interface BrowserExtractRequest {
  url: string;
  clickSelector?: string;
  waitForSelector?: string;
  timeoutMs?: number;
}

export interface BrowserExtractResult {
  ok: boolean;
  status: 'ok' | 'unavailable' | 'error';
  finalUrl: string;
  title: string | null;
  text: string;
  publishedAt: number | null;
  eventAt: number | null;
  blockedSubrequests: string[];
  error: string | null;
}

export interface BrowserResearchWorkerOptions {
  executablePath?: string | null;
  urlPolicy?: ResearchUrlPolicy;
}

function parseMaybeTimestamp(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d{10,13}$/.test(trimmed)) {
    const num = Number(trimmed);
    return trimmed.length === 10 ? num * 1000 : num;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export class BrowserResearchWorker {
  private readonly customExecutablePath: string | null;
  private readonly urlPolicy: ResearchUrlPolicy;
  private browser: Browser | null = null;
  private workdir: string | null = null;

  constructor(options: BrowserResearchWorkerOptions = {}) {
    this.customExecutablePath = options.executablePath ?? null;
    this.urlPolicy = options.urlPolicy ?? {};
  }

  private async ensureBrowser(): Promise<{ browser: Browser | null; error: string | null }> {
    if (this.browser && this.browser.isConnected()) {
      return { browser: this.browser, error: null };
    }

    const executablePath = detectBrowserExecutable(this.customExecutablePath);
    if (!executablePath) {
      return {
        browser: null,
        error: 'No Chrome/Chromium executable detected. Configure CHROME_PATH for DOM extraction.'
      };
    }

    if (!this.workdir) {
      this.workdir = mkdtempSync(path.join(os.tmpdir(), 'mpu-research-worker-'));
    }

    this.browser = await chromium.launch({
      executablePath,
      headless: true,
      downloadsPath: this.workdir,
      env: buildIsolatedWorkerEnv(process.env),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-background-networking'
      ]
    });

    return { browser: this.browser, error: null };
  }

  async extractPage(request: BrowserExtractRequest): Promise<BrowserExtractResult> {
    const initialCheck = await validateResearchUrl(request.url, this.urlPolicy);
    if (!initialCheck.ok || !initialCheck.normalizedUrl) {
      return {
        ok: false,
        status: 'unavailable',
        finalUrl: request.url,
        title: null,
        text: '',
        publishedAt: null,
        eventAt: null,
        blockedSubrequests: [],
        error: initialCheck.reason ?? 'Blocked URL'
      };
    }

    const { browser, error } = await this.ensureBrowser();
    if (!browser) {
      return {
        ok: false,
        status: 'unavailable',
        finalUrl: initialCheck.normalizedUrl,
        title: null,
        text: '',
        publishedAt: null,
        eventAt: null,
        blockedSubrequests: [],
        error: error ?? 'Browser unavailable'
      };
    }

    const blockedSubrequests: string[] = [];
    const timeoutMs = request.timeoutMs ?? 15_000;
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: 'block'
    });

    try {
      await context.route('**/*', async (route) => {
        const subUrl = route.request().url();
        const verdict = await validateResearchUrl(subUrl, this.urlPolicy);
        if (!verdict.ok) {
          blockedSubrequests.push(subUrl);
          await route.abort('blockedbyclient');
          return;
        }
        await route.continue();
      });

      const page = await context.newPage();
      const response = await page.goto(initialCheck.normalizedUrl, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs
      });

      const status = response?.status() ?? 0;
      if (status === 401 || status === 403 || status === 429 || status >= 500) {
        return {
          ok: false,
          status: 'unavailable',
          finalUrl: page.url() || initialCheck.normalizedUrl,
          title: null,
          text: '',
          publishedAt: null,
          eventAt: null,
          blockedSubrequests,
          error: `Upstream returned HTTP ${status}`
        };
      }

      if (request.clickSelector) {
        await page.click(request.clickSelector, { timeout: timeoutMs });
      }
      if (request.waitForSelector) {
        await page.waitForSelector(request.waitForSelector, { timeout: timeoutMs });
      } else {
        await page.waitForLoadState('networkidle', { timeout: 2_500 }).catch(() => {});
      }

      const domSnapshot = await page.evaluate(`(() => {
        const metaPub =
          document.querySelector('meta[property="article:published_time"]')?.getAttribute('content') ||
          document.querySelector('meta[name="pubdate"]')?.getAttribute('content') ||
          document.querySelector('time[datetime]')?.getAttribute('datetime') ||
          null;
        const eventAttr =
          document.querySelector('[data-event-time]')?.getAttribute('data-event-time') ||
          document.querySelector('[data-event-at]')?.getAttribute('data-event-at') ||
          null;
        const text = (document.body?.innerText || '').trim();
        return {
          title: document.title || null,
          publishedRaw: metaPub,
          eventRaw: eventAttr,
          text
        };
      })()`) as {
        title: string | null;
        publishedRaw: string | null;
        eventRaw: string | null;
        text: string;
      };

      return {
        ok: true,
        status: 'ok',
        finalUrl: page.url() || initialCheck.normalizedUrl,
        title: domSnapshot.title,
        text: domSnapshot.text,
        publishedAt: parseMaybeTimestamp(domSnapshot.publishedRaw),
        eventAt: parseMaybeTimestamp(domSnapshot.eventRaw),
        blockedSubrequests,
        error: null
      };
    } catch (err) {
      return {
        ok: false,
        status: 'unavailable',
        finalUrl: initialCheck.normalizedUrl,
        title: null,
        text: '',
        publishedAt: null,
        eventAt: null,
        blockedSubrequests,
        error: err instanceof Error ? err.message : 'Browser extraction failed'
      };
    } finally {
      await context.close().catch(() => {});
    }
  }

  async simulateCrash(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    if (this.workdir) {
      try {
        rmSync(this.workdir, { recursive: true, force: true });
      } catch {
        // Ignore transient Windows directory lock on browser exit.
      }
      this.workdir = null;
    }
  }
}
