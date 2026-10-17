export const fmt = (v: number, d = 2) => (Number.isFinite(v) ? v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '-');
export const fmtPx = (v: number) => (!Number.isFinite(v) ? '-' : v >= 1000 ? fmt(v, 1) : v >= 1 ? fmt(v, 3) : v.toPrecision(4));
export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
