import { useId } from 'react';
import type { AgentId } from '../types';

export type Pose = 'idle' | 'type' | 'point' | 'think' | 'argue' | 'punch' | 'guard' | 'cheer' | 'walk' | 'read' | 'drink' | 'stretch' | 'sit' | 'observe' | 'pass';
export type Face = 'normal' | 'happy' | 'angry' | 'dizzy' | 'worried';

// Body tints: all from the same glossy mint family, nudged per role.
export const TINT: Record<AgentId, { base: string; light: string; dark: string; ink: string }> = {
  lead:       { base: '#6fd8bf', light: '#d7fff3', dark: '#2f8f7c', ink: '#123f38' },
  market:     { base: '#6cc9df', light: '#d9f7ff', dark: '#2b7f98', ink: '#11394a' },
  research:   { base: '#93b8ec', light: '#e6efff', dark: '#4a6fa8', ink: '#1c2c4d' },
  strategist: { base: '#9fdc96', light: '#ecffe6', dark: '#4f9548', ink: '#1d3d1a' },
  risk:       { base: '#f2a596', light: '#fff0ea', dark: '#b65e4f', ink: '#4a1d16' },
  execution:  { base: '#f4c27e', light: '#fff4dd', dark: '#b07d34', ink: '#47300d' },
};

interface Props { id: AgentId; size?: number; pose?: Pose; face?: Face; talking?: boolean; className?: string }

// Original SVG take on the round Grok Bot mascot: glossy ball, two tall tilted eyes,
// plus mitten hands and tiny feet so the desk can wave, type, point and punch.
export function Bot({ id, size = 72, pose = 'idle', face = 'normal', talking = false, className = '' }: Props) {
  const uid = useId().replace(/:/g, '');
  const t = TINT[id];
  const g = `g-${uid}`;
  return (
    <svg className={`bot pose-${pose} face-${face} ${talking ? 'talking' : ''} ${className}`} width={size} height={size * 1.1} viewBox="0 0 120 132" aria-hidden>
      <defs>
        <radialGradient id={g} cx="36%" cy="30%" r="75%">
          <stop offset="0" stopColor={t.light} />
          <stop offset="0.45" stopColor={t.base} />
          <stop offset="1" stopColor={t.dark} />
        </radialGradient>
        <linearGradient id={`${g}-metal`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff0b5" />
          <stop offset=".45" stopColor="#d6ad59" />
          <stop offset="1" stopColor="#8d632e" />
        </linearGradient>
      </defs>
      <ellipse className="bot-shadow" cx="60" cy="126" rx="30" ry="5" fill="rgba(70,40,20,.22)" />
      <g className="feet">
        <ellipse className="foot foot-l" cx="46" cy="118" rx="10" ry="6" fill={t.dark} />
        <ellipse className="foot foot-r" cx="74" cy="118" rx="10" ry="6" fill={t.dark} />
        <path d="M40 116 q6 -3 12 0 M68 116 q6 -3 12 0" fill="none" stroke={t.light} strokeWidth="1.4" opacity=".5" strokeLinecap="round" />
      </g>

      <g className="body">
        {/* back arm (left) sits behind the ball */}
        <g className="arm arm-l">
          <path d="M24 78 Q12 90 14 104" stroke={t.dark} strokeWidth="9" fill="none" strokeLinecap="round" />
          <circle cx="14" cy="106" r="8" fill={t.base} stroke={t.dark} strokeWidth="1.5" />
          <circle cx="20" cy="102" r="3.4" fill={t.base} stroke={t.dark} strokeWidth="1.2" />
          {(id === 'research' || pose === 'read' || pose === 'pass') && <g transform="rotate(-8 14 108)"><rect x="2" y="97" width="25" height="21" rx="2.5" fill="#46618a" stroke="#283e60" /><path d="M6 100 h17 v15 H6z" fill="#fff5dc" /><path d="M7 103 h12 M7 106 h14 M7 109 h10" stroke="#ad9b7a" strokeWidth="1" /><path d="M5 98 v19" stroke="#a9c4e5" strokeWidth="1.5" /><path d="M20 99 v10 l-2 -2 -2 2 v-10" fill="#c97355" /></g>}
          {id !== 'research' && <g className="mug"><rect x="2" y="100" width="12" height="13" rx="3" fill="#fffaf0" stroke="#c9b08a" strokeWidth="1.2" /><path d="M14 103 q5 1 0 7" stroke="#c9b08a" strokeWidth="1.6" fill="none" /><rect x="3.5" y="101.5" width="9" height="3" rx="1.5" fill="#8b5a33" /><path className="steam" d="M6 96 q-2 -4 1 -7 M10 96 q-2 -4 1 -7" stroke="rgba(255,255,255,.9)" strokeWidth="1.4" fill="none" strokeLinecap="round" /></g>}
        </g>

        <g className="ball">
          <circle cx="60" cy="68" r="44" fill={`url(#${g})`} />
          <circle cx="60" cy="68" r="43" fill="none" stroke="rgba(255,255,255,.25)" strokeWidth="1.5" />
          <path d="M31 91 C44 108 75 111 90 91" fill="none" stroke={t.dark} strokeWidth="3" opacity=".25" strokeLinecap="round" />
          <ellipse cx="42" cy="42" rx="13" ry="7" fill="#fff" opacity=".42" transform="rotate(-32 42 42)" />
          <ellipse cx="31" cy="56" rx="2.4" ry="5" fill="#fff" opacity=".33" transform="rotate(18 31 56)" />
          <ellipse cx="37" cy="86" rx="7" ry="3.6" fill="#ff8fa3" opacity=".38" />
          <ellipse cx="85" cy="82" rx="7" ry="3.6" fill="#ff8fa3" opacity=".38" />

          {/* eyes */}
          <g className="eyes" fill={t.ink}>
            <g className="eyes-normal">
              <ellipse className="eye" cx="50" cy="64" rx="6.2" ry="12" transform="rotate(-20 50 64)" />
              <ellipse className="eye" cx="73" cy="60" rx="6.2" ry="12" transform="rotate(-20 73 60)" />
              <circle cx="48" cy="58" r="1.8" fill="#fff" opacity=".8" />
              <circle cx="71" cy="54" r="1.8" fill="#fff" opacity=".8" />
              <circle cx="52" cy="68" r=".9" fill={t.light} opacity=".6" />
              <circle cx="75" cy="64" r=".9" fill={t.light} opacity=".6" />
            </g>
            <g className="eyes-happy" fill="none" stroke={t.ink} strokeWidth="4.5" strokeLinecap="round">
              <path d="M42 66 q7 -11 14 -1" />
              <path d="M65 62 q7 -11 14 -1" />
            </g>
            <g className="eyes-dizzy" fill="none" stroke={t.ink} strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M43 55 L55 63 L43 71" />
              <path d="M80 51 L68 59 L80 67" />
            </g>
            <g className="brows" stroke={t.ink} strokeWidth="4" strokeLinecap="round">
              <path className="brow-angry" d="M41 46 L57 53 M82 42 L67 50" />
              <path className="brow-worried" d="M42 50 L56 45 M80 45 L67 42" />
            </g>
          </g>
          <ellipse className="mouth" cx="62" cy="88" rx="4" ry="3" fill={t.ink} />
          <path className="sweat" d="M100 36 q6 9 0 13 q-6 -4 0 -13z" fill="#9fdcf5" stroke="#5fb6dc" strokeWidth="1" />

          {/* accessories */}
          {id === 'lead' && (
            <g>
              <path d="M56 104 l4 -4 l4 4 l-2 10 l-2 2 l-2 -2z" fill="#b5523b" />
              <path d="M57 100 h6 l-1 3 h-4z" fill="#8f3c2b" />
              <path d="M59 105 v7" stroke="#efac79" strokeWidth="1" strokeLinecap="round" />
              <g transform="rotate(30 86 92)"><rect x="80" y="80" width="12" height="24" rx="5" fill={t.ink} opacity=".12" /><path d="M86 82 c4 3 -3 5 0 8 s-3 5 0 8 l-1 3 h2z" fill={`url(#${g}-metal)`} stroke="#926632" strokeWidth=".6" /><rect x="82" y="99" width="8" height="2" rx="1" fill="#e6c779" /><path d="M86 101 v3 m-2 0 h4" stroke="#956431" strokeWidth="2" strokeLinecap="round" /></g>
            </g>
          )}
          {id === 'market' && (
            <g>
              <path d="M18 64 Q18 18 60 18 Q102 18 102 64" stroke="#3b2a1e" strokeWidth="5" fill="none" strokeLinecap="round" />
              <rect x="12" y="56" width="12" height="20" rx="5" fill="#3b2a1e" />
              <rect x="96" y="56" width="12" height="20" rx="5" fill="#3b2a1e" />
              <path d="M22 43 Q28 21 59 22 Q89 22 98 43" stroke="#795e49" strokeWidth="2" fill="none" strokeLinecap="round" />
              <rect x="14" y="60" width="5" height="11" rx="2.5" fill="#756556" />
              <rect x="101" y="60" width="5" height="11" rx="2.5" fill="#756556" />
              <path d="M101 74 Q100 92 80 94" stroke="#3b2a1e" strokeWidth="2.5" fill="none" />
              <circle cx="79" cy="94" r="3.5" fill="#d9774f" />
            </g>
          )}
          {id === 'research' && (
            <g fill="none" stroke="#6b4a2f" strokeWidth="2.6">
              <circle cx="50" cy="64" r="12" fill="rgba(255,255,255,.15)" />
              <circle cx="74" cy="60" r="12" fill="rgba(255,255,255,.15)" />
              <path d="M61.5 62.5 Q62 58 62.5 61" />
              <path d="M38 62 L22 58 M86 58 L100 52" />
              <path d="M42 58 l5 -3 M66 54 l5 -3" stroke="#fff" strokeWidth="1.5" opacity=".7" strokeLinecap="round" />
            </g>
          )}
          {id === 'strategist' && (
            <g>
              <ellipse cx="54" cy="28" rx="30" ry="11" fill="#d9774f" transform="rotate(-8 54 28)" />
              <ellipse cx="54" cy="31" rx="26" ry="5" fill="#b65e3e" transform="rotate(-8 54 31)" opacity=".6" />
              <rect x="51" y="13" width="4" height="7" rx="2" fill="#b65e3e" />
              <path d="M33 25 q13 -7 26 -4" stroke="#f6ae81" strokeWidth="2" fill="none" strokeLinecap="round" opacity=".65" />
              <g transform="rotate(35 96 44)"><rect x="92" y="28" width="5" height="26" rx="1" fill="#f2c14e" /><path d="M93 31 v21" stroke="#ffe7a2" strokeWidth="1.2" /><path d="M92 54 l2.5 6 l2.5 -6z" fill="#f6dfb6" /><path d="M93.5 57.5 l1 2.5 1 -2.5z" fill="#43352b" /><rect x="92" y="26" width="5" height="4" fill="#e58a8a" /><path d="M92 31 h5" stroke="#a5804f" strokeWidth="1.5" /></g>
            </g>
          )}
          {id === 'risk' && (
            <g>
              <path d="M22 40 Q24 12 60 12 Q96 12 98 40 Z" fill="#f2c14e" stroke="#c99a3b" strokeWidth="1.5" />
              <rect x="16" y="37" width="88" height="8" rx="4" fill="#e9b13a" />
              <rect x="56" y="12" width="8" height="26" rx="3" fill="#ffd978" />
              <path d="M30 31 Q35 20 49 19 M71 19 Q84 22 89 31" stroke="#ffe49b" strokeWidth="2" fill="none" strokeLinecap="round" />
              <path d="M20 41 h80" stroke="#b88229" strokeWidth="1" opacity=".5" />
              <rect x="53" y="26" width="14" height="10" rx="3" fill="#fff3cd" />
              <path d="M57 31 l2 2 4 -4" fill="none" stroke="#7c5b24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          )}
          {id === 'execution' && (
            <g>
              <path d="M24 38 Q28 14 60 14 Q92 14 94 38 Z" fill="#d9774f" />
              <path d="M90 36 q22 -2 24 4 q-12 4 -26 2z" fill="#b65e3e" />
              <circle cx="60" cy="15" r="3" fill="#b65e3e" />
              <path d="M60 19 q-4 8 -3 17 M34 33 q10 -12 20 -13" fill="none" stroke="#f2a27b" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M88 40 q14 0 20 -1" fill="none" stroke="#8a4935" strokeWidth="1" />
              <rect x="57" y="25" width="12" height="9" rx="3" fill="#ffdfb1" />
              <path d="M64 26 l-4 4 h3 l-1 3 5 -4 h-4z" fill="#9d5337" />
            </g>
          )}
        </g>

        {/* front arm (right) */}
        <g className="arm arm-r">
          <path d="M96 78 Q108 90 106 104" stroke={t.dark} strokeWidth="9" fill="none" strokeLinecap="round" />
          <circle className="fist" cx="106" cy="106" r="8" fill={t.base} stroke={t.dark} strokeWidth="1.5" />
          <circle cx="100" cy="102" r="3.4" fill={t.base} stroke={t.dark} strokeWidth="1.2" />
          {id === 'execution' && <g><rect x="109" y="102" width="6" height="20" rx="2" fill="#72523c" /><circle cx="111" cy="112" r="6.5" fill={`url(#${g}-metal)`} stroke="#8b5a33" strokeWidth="1.5" /><circle cx="111" cy="112" r="4.8" fill="#fffaf0" /><path d="M111 112 v-3 M111 112 l2 1" stroke="#3b2a1e" strokeWidth="1.3" strokeLinecap="round" /><circle cx="111" cy="112" r=".9" fill="#a65f3b" /></g>}
        </g>
      </g>
    </svg>
  );
}
