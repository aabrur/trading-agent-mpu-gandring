// Subtle keris silhouette: a wavy blade (luk) with a hilt. Drawn inline, no asset.
export function Keris({ className = '', height = 28, x, y }: { className?: string; height?: number; x?: number; y?: number }) {
  return (
    <svg className={className} height={height} width={height / 4} x={x} y={y} viewBox="0 0 24 96" aria-hidden>
      <path d="M12 2 C16 10 8 16 12 24 S8 38 12 46 S8 60 12 68 L11 74 L13 74 Z" fill="url(#kg)" />
      <path d="M12 6 C14 12 10 17 12 24 S10 38 12 46 S10 60 12 66" stroke="rgba(255,255,255,.35)" strokeWidth=".8" fill="none" />
      <rect x="5" y="73" width="14" height="4" rx="2" fill="var(--brass)" />
      <path d="M9 77 Q12 96 15 77 Z" fill="var(--brass-deep)" />
      <defs>
        <linearGradient id="kg" x1="0" x2="1">
          <stop offset="0" stopColor="#8f97a8" />
          <stop offset=".5" stopColor="#dfe4ee" />
          <stop offset="1" stopColor="#6d7487" />
        </linearGradient>
      </defs>
    </svg>
  );
}

// Pamor-like flowing lines used as a faint pattern on panels.
export function PamorPattern() {
  return (
    <svg className="pamor" viewBox="0 0 400 120" preserveAspectRatio="none" aria-hidden>
      {Array.from({ length: 9 }).map((_, i) => (
        <path key={i} d={`M0 ${10 + i * 12} C 80 ${i * 12 - 6}, 140 ${i * 12 + 30}, 220 ${10 + i * 12} S 340 ${i * 12 - 4}, 400 ${12 + i * 12}`} fill="none" stroke="currentColor" strokeWidth=".6" />
      ))}
    </svg>
  );
}

// A chunkier blade for larger spots (wall frame, debate table, logo).
export function KerisBlade({ size = 80, className = '' }: { size?: number; className?: string }) {
  return (
    <svg className={className} width={size * 0.4} height={size} viewBox="-12 -42 24 90" aria-hidden>
      <path d="M0 -40 C5 -32 -4 -26 2 -18 S-4 -6 2 2 S-4 14 1 20 L-3 24 L5 24 L3 20 C8 12 0 6 6 -2 S0 -14 6 -22 S2 -34 0 -40Z" fill="#9aa3b3" stroke="#5f6676" strokeWidth="1.2" />
      <path d="M1 -34 C3 -28 -1 -24 3 -18 S-1 -6 3 2 S-1 12 2 18" stroke="#e7ecf3" strokeWidth="1" fill="none" />
      <rect x="-7" y="23" width="16" height="5" rx="2.5" fill="var(--brass)" />
      <path d="M-3 28 Q1 46 6 28Z" fill="var(--wood-dark)" />
    </svg>
  );
}
