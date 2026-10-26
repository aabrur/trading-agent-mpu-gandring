import type { ChartTimeframe } from '../types';
import { useEffect, useRef } from 'react';

// Optional TradingView Advanced Chart widget (TRADINGVIEW_WIDGET=on). It loads tradingview.com
// in the browser only. No keys involved. The desk's own chart stays the source for entry, stop and TP lines.
export function TradingViewChart({ symbol, prefix, theme, timeframe = '15m' }: { symbol: string; prefix: string; theme?: string; timeframe?: ChartTimeframe }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.innerHTML = '<div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div>';
    const s = document.createElement('script');
    s.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    s.async = true;
    s.type = 'text/javascript';
    s.innerHTML = JSON.stringify({
      autosize: true, symbol: `${prefix}:${symbol}.P`, interval: ({ '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' })[timeframe], timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Etc/UTC',
      theme: theme === 'night' ? 'dark' : 'light', style: '1', locale: 'en', allow_symbol_change: false, hide_side_toolbar: true, save_image: false, support_host: 'https://www.tradingview.com'
    });
    el.appendChild(s);
    return () => { el.innerHTML = ''; };
  }, [symbol, prefix, theme, timeframe]);
  return <div className="tv-wrap"><div className="tradingview-widget-container tv-box" ref={box} /></div>;
}
