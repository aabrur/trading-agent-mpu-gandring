import { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, HistogramSeries, LineStyle, type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp, type Time, type MouseEventParams } from 'lightweight-charts';
import type { CandleData, DeskState, ChartTimeframe } from '../types';
import { POPULAR_SYMBOLS } from '../types';
import { TradingViewChart } from './TradingViewChart';
import { fmt, fmtPx } from './format';
import { useI18n } from '../i18n';

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const localTime = (sec: number) => new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const localDay = (sec: number) => new Date(sec * 1000).toLocaleDateString([], { day: 'numeric', month: 'short' });

interface Props { state: DeskState; symbol: string; onSymbol: (s: string) => void; data: CandleData | null; theme: string; timeframe: ChartTimeframe; onTimeframe: (tf: ChartTimeframe) => void; error: string; onRetry: () => void }

export function PriceChart({ state, symbol, onSymbol, data, theme, timeframe, onTimeframe, error, onRetry }: Props) {
  const { t, lang } = useI18n();
  const id = lang === 'id';
  const [view, setView] = useState<'desk' | 'tv'>('desk');
  const tv = !!state.tradingview?.widget && view === 'tv';
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const loaded = useRef('');
  const liveLine = useRef<IPriceLine | null>(null);
  const [showLevels, setShowLevels] = useState(true);
  const lines = useRef<IPriceLine[]>([]);
  const extra = useRef<number[]>([]);
  const [hover, setHover] = useState<{ o: number; h: number; l: number; c: number; t: number } | null>(null);

  // create once per theme so colors follow the tokens file
  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: css('--chart-text'), fontFamily: css('--font-ui'), fontSize: 12, attributionLogo: true },
      grid: { vertLines: { color: css('--chart-grid') }, horzLines: { color: css('--chart-grid') } },
      rightPriceScale: { borderColor: css('--chart-axis'), scaleMargins: { top: 0.12, bottom: 0.23 } },
      timeScale: { borderColor: css('--chart-axis'), timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 8, tickMarkFormatter: (ts: number) => { const d = new Date(ts * 1000); return d.getHours() === 0 && d.getMinutes() === 0 ? localDay(ts) : localTime(ts); } },
      localization: { timeFormatter: (ts: number) => `${localDay(ts)} ${localTime(ts)}`, priceFormatter: (p: number) => fmtPx(p) },
      crosshair: { vertLine: { color: css('--chart-cross'), labelBackgroundColor: css('--wood-dark') }, horzLine: { color: css('--chart-cross'), labelBackgroundColor: css('--wood-dark') } }
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: css('--long'), downColor: css('--short'), borderUpColor: css('--long'), borderDownColor: css('--short'), wickUpColor: css('--long'), wickDownColor: css('--short'),
      priceLineVisible: false, lastValueVisible: false,
      // keep entry, stop and take profit inside the visible price range
      autoscaleInfoProvider: (original: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
        const r = original();
        if (!r || !extra.current.length) return r;
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...extra.current), maxValue: Math.max(r.priceRange.maxValue, ...extra.current) } };
      }
    });
    const v = c.addSeries(HistogramSeries, { priceScaleId: 'volume', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false });
    v.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    volume.current = v;
    loaded.current = '';
    const onMove = (p: MouseEventParams) => {
      const d = p.seriesData.get(s);
      if (d && !('open' in d)) return;
      setHover(d && p.time ? { o: d.open, h: d.high, l: d.low, c: d.close, t: p.time as number } : null);
    };
    c.subscribeCrosshairMove(onMove);
    chart.current = c; series.current = s; lines.current = [];
    return () => { c.unsubscribeCrosshairMove(onMove); c.remove(); chart.current = null; series.current = null; volume.current = null; liveLine.current = null; };
  }, [theme]);

  useEffect(() => {
    chart.current?.applyOptions({ timeScale: { tickMarkFormatter: (ts: Time) => typeof ts === 'number' ? (timeframe === '1d' || timeframe === '4h' ? localDay(ts) : localTime(ts)) : null } });
  }, [timeframe, theme]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    if (!data || data.symbol !== symbol || data.tf !== timeframe) {
      s.setData([]); volume.current?.setData([]); setHover(null); loaded.current = ''; return;
    }
    const first = loaded.current !== `${symbol}:${timeframe}`;
    s.setData(data.candles.map((k) => ({ ...k, time: k.time as UTCTimestamp })));
    const price = data.last ?? 1;
    const precision = price >= 100 ? 2 : price >= 1 ? 4 : 8;
    s.applyOptions({ priceFormat: { type: 'price', precision, minMove: 10 ** -precision } });
    const upVolume = css('--long') + '66', downVolume = css('--short') + '66';
    volume.current?.setData(data.candles.map((k) => ({ time: k.time as UTCTimestamp, value: k.volume ?? 0, color: k.close >= k.open ? upVolume : downVolume })));
    if (first) { chart.current?.timeScale().fitContent(); setHover(null); }
    loaded.current = `${symbol}:${timeframe}`;
  }, [data, symbol, timeframe, theme]);

  const tick = state.tickers[symbol];
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    if (liveLine.current) s.removePriceLine(liveLine.current);
    liveLine.current = null;
    const price = tick?.last ?? data?.last;
    if (price && Number.isFinite(price)) liveLine.current = s.createPriceLine({ price, color: css('--teal'), lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: tick ? (tick.example ? 'Sample' : 'Last') : 'Close' });
  }, [tick?.last, tick?.example, data, symbol, theme]);

  // Managed book levels are visual references, not proof of exchange protection.
  const positions = state.paper.positions.filter((p) => p.symbol === symbol);
  const key = positions.map((p) => `${p.id}${p.entry}${p.stop}${p.tp}`).join('|');
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const l of lines.current) s.removePriceLine(l);
    lines.current = [];
    extra.current = showLevels ? positions.flatMap((p) => [p.entry, p.stop, ...(p.tp ? [p.tp] : [])]).filter((n) => Number.isFinite(n) && n > 0) : [];
    if (!showLevels) return;
    for (const p of positions) {
      lines.current.push(s.createPriceLine({ price: p.entry, color: css('--wood-dark'), lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `${p.side} entry` }));
      if (p.stop > 0) lines.current.push(s.createPriceLine({ price: p.stop, color: css('--short'), lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: `${p.side} SL` }));
      if (p.tp) lines.current.push(s.createPriceLine({ price: p.tp, color: css('--long'), lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: `${p.side} TP` }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, theme, showLevels]);

  const last = data?.candles.at(-1);
  const shown = hover ?? (last ? { o: last.open, h: last.high, l: last.low, c: last.close, t: last.time } : null);
  return (
    <section className="panel chart-panel">
      <div className="panel-head">
        <div className="chart-title">
          <h2>{symbol}</h2>
          <span className="chart-price">{tick ? fmtPx(tick.last) : data?.last != null ? fmtPx(data.last) : '...'}</span>
          {tick && <span className={`chip-change ${tick.change24hPct >= 0 ? 'up' : 'down'}`}>{tick.change24hPct >= 0 ? '+' : ''}{fmt(tick.change24hPct)}% 24h</span>}
          <span className="muted small">{timeframe} {id ? 'candle tertutup' : 'closed candles'} · {data ? (data.example ? 'sample data · EXAMPLE' : data.source) : error ? (id ? 'Tidak tersedia' : 'Unavailable') : t('loading')}</span>
        </div>
        {state.tradingview?.widget && <div className="seg">
          <button className={view === 'desk' ? 'on' : ''} onClick={() => setView('desk')}>{t('deskChart')}</button>
          <button className={view === 'tv' ? 'on' : ''} onClick={() => setView('tv')}>TradingView</button>
        </div>}
        <div className="seg chart-symbols-bar">
          {state.watchlist.map((s) => <button key={s} className={s === symbol ? 'on' : ''} onClick={() => onSymbol(s)}>{s.replace('USDT', '')}</button>)}
          <select
            className="chart-symbol-select"
            aria-label="select token"
            value={symbol}
            onChange={(e) => {
              if (e.target.value === '__custom__') {
                const c = window.prompt(t('customTokenPrompt'));
                if (c) onSymbol(c.trim().toUpperCase());
              } else {
                onSymbol(e.target.value);
              }
            }}
          >
            <optgroup label={t('watchlistGroup')}>
              {state.watchlist.map((s) => <option key={s} value={s}>{s}</option>)}
            </optgroup>
            <optgroup label={t('popularPerpsGroup')}>
              {POPULAR_SYMBOLS.filter((s) => !state.watchlist.includes(s)).map((s) => <option key={s} value={s}>{s}</option>)}
            </optgroup>
            <option value="__custom__">{t('customTokenOpt')}</option>
          </select>
          <button
            className="chart-custom-btn"
            title="Type any token to view on chart"
            onClick={() => {
              const c = window.prompt(t('customTokenPrompt'));
              if (c) onSymbol(c.trim().toUpperCase());
            }}
          >
            {t('addTokenBtn')}
          </button>
        </div>
      </div>
      <div className="chart-toolbar">
        <div className="chart-timeframes" role="group" aria-label={id ? 'Interval candle' : 'Candle timeframe'}>
          {(['1m', '5m', '15m', '1h', '4h', '1d'] as const).map((tf) => <button key={tf} aria-pressed={timeframe === tf} onClick={() => onTimeframe(tf)}>{tf}</button>)}
        </div>
        {!tv && <div className="chart-actions">
          <button aria-pressed={showLevels} onClick={() => setShowLevels(!showLevels)}>Entry / SL / TP</button>
          <button onClick={() => chart.current?.timeScale().fitContent()}>{id ? 'Pas layar' : 'Fit'}</button>
          <button onClick={() => chart.current?.timeScale().scrollToRealTime()}>{id ? 'Terbaru' : 'Latest'}</button>
        </div>}
      </div>
      {!tv && <div className="ohlc">
        {shown && <>
          <span>{localDay(shown.t)} {localTime(shown.t)}</span>
          <span>O <b>{fmtPx(shown.o)}</b></span><span>H <b>{fmtPx(shown.h)}</b></span><span>L <b>{fmtPx(shown.l)}</b></span>
          <span>C <b className={shown.c >= shown.o ? 'up' : 'down'}>{fmtPx(shown.c)}</b></span>
        </>}
        <span className="legend"><i className="lg entry" />{t('entryLegend')} <i className="lg stop" />{t('stopLegend')} <i className="lg tp" />{t('tpLegend')} <i className="lg now" />{t('lastPriceLegend')}</span>
      </div>}
      {!tv && error && <div className="chart-feedback" role="alert">{error} <button onClick={onRetry}>{id ? 'Coba lagi' : 'Retry'}</button>{data && <span>{id ? 'Data terakhir dipertahankan.' : 'Showing the last loaded data.'}</span>}</div>}
      {!tv && !data && !error && <p className="chart-feedback" role="status">{t('loading')} {symbol} / {timeframe}</p>}
      <div className="chart-box" ref={box} style={tv ? { display: 'none' } : undefined} role="img" aria-label={`${symbol} ${timeframe} OHLC, volume, entry, SL and TP. ${data?.example ? 'Sample data.' : data?.source ?? 'Loading.'}`} />
      {!tv && positions.length > 0 && <div className="chart-positions">
        <p className="chart-note">{state.mode === 'PAPER' ? 'Paper positions' : 'Managed positions; protection status from the desk'}</p>
        {positions.map((p) => <div className="chart-position" key={p.id}>
          <strong className={p.side === 'LONG' ? 'up' : 'down'}>{p.side} {p.leverage}x</strong><span>Qty <b>{p.qty}</b></span>
          <span>Entry <b>{fmtPx(p.entry)}</b></span><span>SL <b>{p.stop > 0 ? fmtPx(p.stop) : 'Missing'}</b></span><span>TP <b>{p.tp ? fmtPx(p.tp) : 'None'}</b></span>
          <span className={p.unrealizedPnl >= 0 ? 'up' : 'down'}>PnL {fmt(p.unrealizedPnl)} USDT</span>
          {state.mode !== 'PAPER' && <small>Protection: {p.protectionStatus ?? 'unknown'}</small>}
        </div>)}
      </div>}
      {!tv && data && <details className="chart-data"><summary>{id ? 'Data candle' : 'Candle data'} ({Math.min(20, data.candles.length)})</summary><div className="chart-data-scroll"><table><caption>{symbol} / {timeframe} / {data.source}{data.example ? ' / SAMPLE' : ''}</caption><thead><tr>{['Time', 'Open', 'High', 'Low', 'Close', 'Volume'].map((label) => <th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{data.candles.slice(-20).reverse().map((c) => <tr key={c.time}><td>{localDay(c.time)} {localTime(c.time)}</td>{[c.open, c.high, c.low, c.close].map((n, i) => <td key={i}>{fmtPx(n)}</td>)}<td>{fmt(c.volume ?? 0)}</td></tr>)}</tbody></table></div></details>}
      {tv && <TradingViewChart symbol={symbol} prefix={state.tradingview.prefix} theme={theme} timeframe={timeframe} />}
      {!tv && positions.length === 0 && <p className="chart-note">{t('noOpenPositionOn')} {symbol}. {t('chartLinesNote')}</p>}
    </section>
  );
}
