import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TrakteerPopup } from '../web/src/components/Panels.js';
import { I18nProvider } from '../web/src/i18n.js';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import type { AddressInfo } from 'node:net';

describe('Trakteer support popup and Cendol office celebration', () => {
  it('renders the in-place Cendol menu with quantity presets and direct pay action without creator profile clutter', () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, { children: createElement(TrakteerPopup, { onClose: () => {} }) }));
    expect(html).toContain('<dialog');
    expect(html).toContain('cendol-logo-only');
    expect(html).toContain('trbtn-icon.png');
    expect(html).toContain('aria-label="Cendol presets"');
    expect(html).toContain('aria-label="Cendol quantity"');
    expect(html).toContain('Rp 5.000');
    expect(html).toContain('trakteer-pay-btn');
    expect(html).toContain('trakteer-close-x');
    expect(html).not.toContain('target="_blank"');
  });

  it('triggers Desk Lead speech and office Cendol banner when a tip arrives', async () => {
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', DEFAULT_PROVIDER: 'mock' });
    const { server, desk } = createApp(cfg, { reportsDir: null, learningsPath: null, conversationsPath: null });
    const speeches: Array<{ agent: string; text: string }> = [];
    const banners: Array<{ supporter: string; quantity: number; text: string }> = [];
    desk.on('speech', (sp: { agent: string; text: string }) => speeches.push(sp));
    desk.on('cendol', (ev: { supporter: string; quantity: number; text: string }) => banners.push(ev));

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/trakteer/tip`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ supporter_name: 'Sultan Crypto', quantity: 5, support_message: 'Mantap Mpu Gandring!' })
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { ok: boolean; quantity: number; supporter: string; text: string };
      expect(body.ok).toBe(true);
      expect(body.quantity).toBe(5);
      expect(body.supporter).toBe('Sultan Crypto');
      expect(body.text).toContain('Terima kasih traktiran cendolnya!');
      expect(speeches.some((s) => s.agent === 'lead' && s.text.includes('Terima kasih traktiran cendolnya!'))).toBe(true);
      expect(banners.some((b) => b.supporter === 'Sultan Crypto' && b.quantity === 5)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
