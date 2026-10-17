import { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, LineStyle, type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp, type MouseEventParams } from 'lightweight-charts';
import type { CandleData, DeskState } from '../types';
import { TradingViewChart } from './TradingViewChart';
import { fmt, fmtPx } from './format';

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const localTime = (sec: number) => new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const localDay = (sec: number) => new Date(sec * 1000).toLocaleDateString([], { day: 'numeric', month: 'short' });

interface Props { state: DeskState; symbol: string; onSymbol: (s: string) => void; data: CandleData | null; theme: string }

export function PriceChart({ state, symbol, onSymbol, data, theme }: Props) {
  const [view, setView] = useState<'desk' | 'tv'>('desk');
  const tv = !!state.tradingview?.widget && view === 'tv';
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
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
      rightPriceScale: { borderColor: css('--chart-axis'), scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderColor: css('--chart-axis'), timeVisible: true, secondsVisible: false, rightOffset: 4, barSpacing: 8, tickMarkFormatter: (t: number) => { const d = new Date(t * 1000); return d.getHours() === 0 && d.getMinutes() === 0 ? localDay(t) : localTime(t); } },
      localization: { timeFormatter: (t: number) => `${localDay(t)} ${localTime(t)}`, priceFormatter: (p: number) => fmtPx(p) },
      crosshair: { vertLine: { color: css('--chart-cross'), labelBackgroundColor: css('--wood-dark') }, horzLine: { color: css('--chart-cross'), labelBackgroundColor: css('--wood-dark') } }
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: css('--long'), downColor: css('--short'), borderUpColor: css('--long'), borderDownColor: css('--short'), wickUpColor: css('--long'), wickDownColor: css('--short'),
      priceLineColor: css('--teal'), priceLineWidth: 2, priceLineStyle: LineStyle.Solid, lastValueVisible: true,
      // keep entry, stop and take profit inside the visible price range
      autoscaleInfoProvider: (original: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
        const r = original();
        if (!r || !extra.current.length) return r;
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...extra.current), maxValue: Math.max(r.priceRange.maxValue, ...extra.current) } };
      }
    });
    const onMove = (p: MouseEventParams) => {
      const d = p.seriesData.get(s) as { open: number; high: number; low: number; close: number } | undefined;
      setHover(d && p.time ? { o: d.open, h: d.high, l: d.low, c: d.close, t: p.time as number } : null);
    };
    c.subscribeCrosshairMove(onMove);
    chart.current = c; series.current = s; lines.current = [];
    return () => { c.unsubscribeCrosshairMove(onMove); c.remove(); chart.current = null; series.current = null; };
  }, [theme]);

  useEffect(() => {
    if (!series.current || !data || data.symbol !== symbol) return;
    series.current.setData(data.candles.map((k) => ({ ...k, time: k.time as UTCTimestamp })));
    chart.current?.timeScale().scrollToRealTime();
  }, [data, symbol, theme]);

  // entry, stop and take profit lines for open paper positions on this symbol
  const positions = state.paper.positions.filter((p) => p.symbol === symbol);
  const key = positions.map((p) => `${p.id}${p.entry}${p.stop}${p.tp}`).join('|');
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const l of lines.current) s.removePriceLine(l);
    lines.current = [];
    extra.current = positions.flatMap((p) => [p.entry, p.stop, ...(p.tp ? [p.tp] : [])]);
    for (const p of positions) {
      lines.current.push(s.createPriceLine({ price: p.entry, color: css('--wood-dark'), lineWidth: 2, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `${p.side} entry` }));
      lines.current.push(s.createPriceLine({ price: p.stop, color: css('--short'), lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'stop' }));
      if (p.tp) lines.current.push(s.createPriceLine({ price: p.tp, color: css('--long'), lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'take profit' }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, theme, data]);

  const last = data?.candles.at(-1);
  const shown = hover ?? (last ? { o: last.open, h: last.high, l: last.low, c: last.close, t: last.time } : null);
  const tick = state.tickers[symbol];
  return (
    <section className="panel chart-panel">
      <div className="panel-head">
        <div className="chart-title">
          <h2>{symbol}</h2>
          <span className="chart-price">{tick ? fmtPx(tick.last) : data ? fmtPx(data.last) : '...'}</span>
          {tick && <span className={`chip-change ${tick.change24hPct >= 0 ? 'up' : 'down'}`}>{tick.change24hPct >= 0 ? '+' : ''}{fmt(tick.change24hPct)}% 24h</span>}
          <span className="muted small">15m candles · {data ? (data.example ? 'sample data (EXAMPLE)' : data.source) : 'loading'}</span>
        </div>
        {state.tradingview?.widget && <div className="seg">
          <button className={view === 'desk' ? 'on' : ''} onClick={() => setView('desk')}>desk chart</button>
          <button className={view === 'tv' ? 'on' : ''} onClick={() => setView('tv')}>TradingView</button>
        </div>}
        <div className="seg">
          {state.watchlist.map((s) => <button key={s} className={s === symbol ? 'on' : ''} onClick={() => onSymbol(s)}>{s.replace('USDT', '')}</button>)}
        </div>
      </div>
      {!tv && <div className="ohlc">
        {shown && <>
          <span>{localDay(shown.t)} {localTime(shown.t)}</span>
          <span>O <b>{fmtPx(shown.o)}</b></span><span>H <b>{fmtPx(shown.h)}</b></span><span>L <b>{fmtPx(shown.l)}</b></span>
          <span>C <b className={shown.c >= shown.o ? 'up' : 'down'}>{fmtPx(shown.c)}</b></span>
        </>}
        <span className="legend"><i className="lg entry" />entry <i className="lg stop" />stop <i className="lg tp" />take profit <i className="lg now" />last price</span>
      </div>}
      <div className="chart-box" ref={box} style={tv ? { display: 'none' } : undefined} />
      {tv && <TradingViewChart symbol={symbol} prefix={state.tradingview.prefix} theme={theme} />}
      {!tv && positions.length === 0 && <p className="chart-note">No open {state.mode === 'LIVE' ? 'LIVE' : 'paper'} position on {symbol}. Entry, stop and take profit lines show up here when one opens.</p>}
    </section>
  );
}
