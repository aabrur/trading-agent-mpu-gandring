import { describe, expect, it } from 'vitest';
import { en, id, DICTIONARIES } from '../web/src/i18n.js';
import { APP_VERSION, compareVersions, checkUpdate, applyUpdate } from '../server/updater.js';
import { WALLET_GUIDE, WalletConnector } from '../server/wallet.js';
import { EXCHANGES } from '../server/exchange/index.js';

describe('Dual language i18n parity and updater adapter', () => {
  it('keeps strict 1:1 key parity between EN and ID with non-empty values and zero em dashes', () => {
    const enKeys = Object.keys(en).sort();
    const idKeys = Object.keys(id).sort();
    expect(idKeys).toEqual(enKeys);
    expect(DICTIONARIES.en).toBe(en);
    expect(DICTIONARIES.id).toBe(id);

    for (const k of enKeys) {
      const enVal = en[k as keyof typeof en];
      const idVal = id[k as keyof typeof en];
      expect(typeof enVal).toBe('string');
      expect(typeof idVal).toBe('string');
      expect(enVal.trim().length).toBeGreaterThan(0);
      expect(idVal.trim().length).toBeGreaterThan(0);
      expect(enVal.includes('\u2014')).toBe(false);
      expect(idVal.includes('\u2014')).toBe(false);
    }
  });

  it('provides official depositUrl for every DEX and CEX venue in WALLET_GUIDE', () => {
    for (const v of EXCHANGES) {
      const g = WALLET_GUIDE[v];
      expect(g.depositUrl).toMatch(/^https:\/\//);
    }
  });

  it('reads live Hyperliquid balance via public clearinghouseState when a 0x address is provided', async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ marginSummary: { accountValue: '1250.5' }, withdrawable: '980.25' }), { status: 200 });
    const wc = new WalletConnector({ envFile: '.env.nonexistent', fetchImpl: fakeFetch as unknown as typeof fetch });
    const res = await wc.readVenueBalance('hyperliquid', 'testnet', '0x1111111111111111111111111111111111111111');
    expect(res.ok).toBe(true);
    expect(res.equityUsdt).toBe(1250.5);
    expect(res.availableUsdt).toBe(980.25);
    expect(res.depositUrl).toBe('https://app.hyperliquid.xyz/portfolio');
  });

  it('compares dotted version strings and checks update status at current release version', async () => {
    expect(APP_VERSION).toBe('0.0.0.4.12');
    expect(compareVersions('0.0.0.2.6', '0.0.0.2.6')).toBe(0);
    expect(compareVersions('0.0.0.2.6', '0.0.0.2.5')).toBe(1);
    expect(compareVersions('0.0.0.3.3', '0.0.0.2.6')).toBe(1);
    expect(compareVersions('0.0.0.1.9', '0.0.0.2.6')).toBe(-1);

    const fakeNewerFetch = async () =>
      new Response(JSON.stringify({ appVersion: '0.0.0.4.13', changelog: ['New feature'] }), { status: 200 });
    const st = await checkUpdate(fakeNewerFetch as unknown as typeof fetch);
    expect(st.ok).toBe(true);
    expect(st.currentVersion).toBe('0.0.0.4.12');
    expect(st.latestVersion).toBe('0.0.0.4.13');
    expect(st.updateAvailable).toBe(true);

    const applied = applyUpdate(process.cwd(), () => ({ status: 0, stdout: 'Already up to date.\n', stderr: '' }));
    expect(applied.ok).toBe(true);
    expect(applied.currentVersion).toBe('0.0.0.4.12');
  });

  it('handles dirty working tree gracefully by auto-stashing and pulling', () => {
    const executed: string[] = [];
    const runner = (cmd: string, args: string[]) => {
      const full = `${cmd} ${args.join(' ')}`;
      executed.push(full);
      if (args[0] === 'status') {
        return { status: 0, stdout: ' M bin/mpu.mjs\n M package-lock.json\n', stderr: '' };
      }
      if (args[0] === 'pull') {
        return { status: 0, stdout: 'Updating a72f476..9bacf40\nFast-forward\n', stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const res = applyUpdate(process.cwd(), runner);
    expect(res.ok).toBe(true);
    expect(executed.some((c) => c.includes('git stash push'))).toBe(true);
    expect(executed.some((c) => c.includes('git fetch origin main'))).toBe(true);
    expect(executed.some((c) => c.includes('git pull --ff-only origin main'))).toBe(true);
    expect(executed.some((c) => c.includes('run build'))).toBe(true);
  });

  it('resets cleanly when force update is requested after merge conflict', () => {
    const executed: string[] = [];
    const runner = (cmd: string, args: string[]) => {
      const full = `${cmd} ${args.join(' ')}`;
      executed.push(full);
      if (args[0] === 'status') {
        return { status: 0, stdout: ' M bin/mpu.mjs\n', stderr: '' };
      }
      if (args[0] === 'pull') {
        return { status: 1, stdout: '', stderr: 'error: Your local changes would be overwritten by merge' };
      }
      return { status: 0, stdout: '', stderr: '' };
    };

    const res = applyUpdate(process.cwd(), runner, { force: true });
    expect(res.ok).toBe(true);
    expect(executed.some((c) => c.includes('git reset --hard origin/main'))).toBe(true);
    expect(executed.some((c) => c.includes('run build'))).toBe(true);
  });
});
