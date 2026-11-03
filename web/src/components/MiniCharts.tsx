import { useState } from 'react';
import type { DeskState } from '../types';
import { fmt } from './format';
import { useI18n } from '../i18n';

// Equity over time. Plain SVG with gridlines, axis labels, safety net line and a hover readout.
export function EquityChart({ state }: { state: DeskState }) {
  const { t } = useI18n();
  const pts = state.equityHistory.length ? state.equityHistory : [{ t: Date.now(), equity: state.paper.equity, balance: state.paper.balance }];
  const [hi, setHi] = useState<number | null>(null);
  const W = 340, H = 130, L = 52, R = 10, T = 12, B = 22;
  const vals = pts.map((p) => p.equity);
  const net = state.paper.safetyNet;
  // scale to the equity itself so small moves are visible; the safety net shows only if it is in range
  let lo = Math.min(...vals), hiV = Math.max(...vals);
  const pad = Math.max((hiV - lo) * 0.2, Math.abs(hiV) * 0.004, 0.5);
  lo -= pad; hiV += pad;
  const x = (i: number) => L + (pts.length === 1 ? (W - L - R) : (i / (pts.length - 1)) * (W - L - R));
  const y = (v: number) => T + (1 - (v - lo) / (hiV - lo)) * (H - T - B);
  const ticks = [0, 0.5, 1].map((f) => lo + (hiV - lo) * f);
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(' ');
  const area = `${path} L${x(pts.length - 1)},${H - B} L${x(0)},${H - B} Z`;
  const tm = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const h = hi != null ? pts[hi] : null;
  return (
    <figure className="mini-chart">
      <figcaption><span>{t('equityOverTime')}</span>{h ? <b>{fmt(h.equity)} USDT · {tm(h.t)}</b> : <b>{fmt(state.paper.equity)} USDT</b>}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="paper equity over time"
        onMouseMove={(e) => { const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * W; const i = Math.round(((px - L) / (W - L - R)) * (pts.length - 1)); setHi(Math.max(0, Math.min(pts.length - 1, i))); }}
        onMouseLeave={() => setHi(null)}>
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid" />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" className="axis">{fmt(v, v > 999 ? 0 : 2)}</text>
          </g>
        ))}
        {net > lo && net < hiV && <g><line x1={L} x2={W - R} y1={y(net)} y2={y(net)} className="net" /><text x={W - R} y={y(net) - 4} textAnchor="end" className="axis net-label">{t('safetyNet').toLowerCase()} {fmt(net, 0)}</text></g>}
        <path d={area} className="eq-area" />
        <path d={path} className="eq-line" />
        <circle cx={x(pts.length - 1)} cy={y(vals.at(-1)!)} r="3.5" className="eq-dot" />
        {net <= lo && <text x={W - R} y={H - B - 5} textAnchor="end" className="axis net-label">{t('safetyNet').toLowerCase()} {fmt(net, 0)} {t('safetyNetBelowRange')}</text>}
        <text x={L} y={H - 6} className="axis">{tm(pts[0].t)}</text>
        <text x={W - R} y={H - 6} textAnchor="end" className="axis">{tm(pts.at(-1)!.t)}</text>
        {h && hi != null && <g><line x1={x(hi)} x2={x(hi)} y1={T} y2={H - B} className="hover-line" /><circle cx={x(hi)} cy={y(h.equity)} r="4" className="eq-dot" /></g>}
      </svg>
    </figure>
  );
}

// Money Trade split into N slots. Each bar is one order's allocation; the fill is margin in use.
export function AllocationBars({ state }: { state: DeskState }) {
  const { t } = useI18n();
  const p = state.paper;
  const W = 340, H = 140, L = 44, R = 8, T = 14, B = 30;
  const slots = Array.from({ length: p.n }, (_, i) => p.positions[i] ?? null);
  const max = Math.max(p.perOrder, ...p.positions.map((x) => x.margin), 1) * 1.15;
  const bw = Math.min(54, (W - L - R) / p.n - 14);
  const gap = (W - L - R - bw * p.n) / (p.n + 1);
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const [hi, setHi] = useState<number | null>(null);
  return (
    <figure className="mini-chart">
      <figcaption><span>{t('allocationPerOrder')}</span><b>{fmt(p.moneyTrade)} / {p.n} = {fmt(p.perOrder)} USDT</b></figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="allocation per order">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={W - R} y1={y(max * f / 1.15)} y2={y(max * f / 1.15)} className="grid" />
            <text x={L - 6} y={y(max * f / 1.15) + 4} textAnchor="end" className="axis">{fmt(max * f / 1.15, 0)}</text>
          </g>
        ))}
        {slots.map((pos, i) => {
          const x0 = L + gap + i * (bw + gap);
          const used = pos ? Math.min(pos.margin, max) : 0;
          return (
            <g key={i} onMouseEnter={() => setHi(i)} onMouseLeave={() => setHi(null)}>
              <rect x={x0} y={y(p.perOrder)} width={bw} height={H - B - y(p.perOrder)} rx="7" className="slot" />
              {pos && <rect x={x0 + 3} y={y(used)} width={bw - 6} height={Math.max(0, H - B - y(used) - 2)} rx="5" className={`slot-fill ${pos.side}`} />}
              <text x={x0 + bw / 2} y={H - B + 14} textAnchor="middle" className="axis strong">#{i + 1}</text>
              <text x={x0 + bw / 2} y={H - B + 26} textAnchor="middle" className="axis">{pos ? pos.symbol.replace('USDT', '') : t('slotFree')}</text>
              {(hi === i || pos) && <text x={x0 + bw / 2} y={y(pos ? used : p.perOrder) - 5} textAnchor="middle" className="axis strong">{fmt(pos ? pos.margin : p.perOrder, 0)}</text>}
            </g>
          );
        })}
      </svg>
      <div className="safety-strip" title="Balance split: safety net stays untouched">
        <span className="sn" style={{ flex: Math.max(p.safetyNet, 0.0001) }}>net {fmt(p.safetyNet, 0)}</span>
        <span className="mt" style={{ flex: Math.max(p.moneyTrade, 0.0001) }}>Money Trade {fmt(p.moneyTrade, 0)}</span>
      </div>
    </figure>
  );
}

// Tiny sparkline for desk monitors.
export function Sparkline({ values, up }: { values: number[]; up: boolean }) {
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${36 - ((v - min) / (max - min || 1)) * 30}`).join(' ');
  return (
    <svg className="spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke={up ? 'var(--long)' : 'var(--short)'} strokeWidth="3" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
