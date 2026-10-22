import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TrakteerPopup } from '../web/src/components/Panels.js';
import { I18nProvider } from '../web/src/i18n.js';

describe('Trakteer support popup', () => {
  it('offers direct support navigation without loading the blocked embedded page', () => {
    const html = renderToStaticMarkup(createElement(I18nProvider, { children: createElement(TrakteerPopup, { onClose: () => {} }) }));
    expect(html).toContain('href="https://trakteer.id/aabrur/tip"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('Opens the Trakteer support page in a new tab.');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('/tip/embed/');
    expect(html).toContain('<dialog');
    expect(html).toContain('aria-labelledby=');
    expect(html).toContain('aria-describedby=');
    expect(html).toContain('Maybe later');
  });
});
