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
      </defs>
      <ellipse className="bot-shadow" cx="60" cy="126" rx="30" ry="5" fill="rgba(70,40,20,.22)" />
      <g className="feet">
        <ellipse className="foot foot-l" cx="46" cy="118" rx="10" ry="6" fill={t.dark} />
        <ellipse className="foot foot-r" cx="74" cy="118" rx="10" ry="6" fill={t.dark} />
      </g>

      <g className="body">
        {/* back arm (left) sits behind the ball */}
        <g className="arm arm-l">
          <path d="M24 78 Q12 90 14 104" stroke={t.dark} strokeWidth="9" fill="none" strokeLinecap="round" />
          <circle cx="14" cy="106" r="8" fill={t.base} stroke={t.dark} strokeWidth="1.5" />
          <circle cx="20" cy="102" r="3.4" fill={t.base} stroke={t.dark} strokeWidth="1.2" />
          {(id === 'research' || pose === 'read' || pose === 'pass') && <g transform="rotate(-12 10 108)"><rect x="-6" y="98" width="24" height="18" rx="2" fill="#fbf6ea" stroke="#b9a98c" /><path d="M-2 103 h16 M-2 107 h12 M-2 111 h14" stroke="#9b8a6c" strokeWidth="1.2" /></g>}
          {id !== 'research' && <g className="mug"><rect x="2" y="100" width="12" height="13" rx="3" fill="#fffaf0" stroke="#c9b08a" strokeWidth="1.2" /><path d="M14 103 q5 1 0 7" stroke="#c9b08a" strokeWidth="1.6" fill="none" /><rect x="3.5" y="101.5" width="9" height="3" rx="1.5" fill="#8b5a33" /><path className="steam" d="M6 96 q-2 -4 1 -7 M10 96 q-2 -4 1 -7" stroke="rgba(255,255,255,.9)" strokeWidth="1.4" fill="none" strokeLinecap="round" /></g>}
        </g>

        <g className="ball">
          <circle cx="60" cy="68" r="44" fill={`url(#${g})`} />
          <circle cx="60" cy="68" r="43" fill="none" stroke="rgba(255,255,255,.25)" strokeWidth="1.5" />
          <ellipse cx="42" cy="42" rx="13" ry="7" fill="#fff" opacity=".42" transform="rotate(-32 42 42)" />
          <ellipse cx="37" cy="86" rx="7" ry="3.6" fill="#ff8fa3" opacity=".38" />
          <ellipse cx="85" cy="82" rx="7" ry="3.6" fill="#ff8fa3" opacity=".38" />

          {/* eyes */}
          <g className="eyes" fill={t.ink}>
            <g className="eyes-normal">
              <ellipse className="eye" cx="50" cy="64" rx="6.2" ry="12" transform="rotate(-20 50 64)" />
              <ellipse className="eye" cx="73" cy="60" rx="6.2" ry="12" transform="rotate(-20 73 60)" />
              <circle cx="48" cy="58" r="1.8" fill="#fff" opacity=".8" />
              <circle cx="71" cy="54" r="1.8" fill="#fff" opacity=".8" />
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
              <g transform="rotate(30 86 92)"><path d="M86 82 c2 3 -2 5 0 8 s-2 5 0 8 l-.6 3 h1.2z" fill="#d9b25a" /><rect x="83" y="100" width="6" height="2" rx="1" fill="#a4762a" /></g>
            </g>
          )}
          {id === 'market' && (
            <g>
              <path d="M18 64 Q18 18 60 18 Q102 18 102 64" stroke="#3b2a1e" strokeWidth="5" fill="none" strokeLinecap="round" />
              <rect x="12" y="56" width="12" height="20" rx="5" fill="#3b2a1e" />
              <rect x="96" y="56" width="12" height="20" rx="5" fill="#3b2a1e" />
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
            </g>
          )}
          {id === 'strategist' && (
            <g>
              <ellipse cx="54" cy="28" rx="30" ry="11" fill="#d9774f" transform="rotate(-8 54 28)" />
              <ellipse cx="54" cy="31" rx="26" ry="5" fill="#b65e3e" transform="rotate(-8 54 31)" opacity=".6" />
              <rect x="51" y="13" width="4" height="7" rx="2" fill="#b65e3e" />
              <g transform="rotate(35 96 44)"><rect x="92" y="28" width="5" height="26" rx="1" fill="#f2c14e" /><path d="M92 54 l2.5 6 l2.5 -6z" fill="#f6dfb6" /><rect x="92" y="26" width="5" height="4" fill="#e58a8a" /></g>
            </g>
          )}
          {id === 'risk' && (
            <g>
              <path d="M22 40 Q24 12 60 12 Q96 12 98 40 Z" fill="#f2c14e" stroke="#c99a3b" strokeWidth="1.5" />
              <rect x="16" y="37" width="88" height="8" rx="4" fill="#e9b13a" />
              <rect x="56" y="12" width="8" height="26" rx="3" fill="#ffd978" />
            </g>
          )}
          {id === 'execution' && (
            <g>
              <path d="M24 38 Q28 14 60 14 Q92 14 94 38 Z" fill="#d9774f" />
              <path d="M90 36 q22 -2 24 4 q-12 4 -26 2z" fill="#b65e3e" />
              <circle cx="60" cy="15" r="3" fill="#b65e3e" />
            </g>
          )}
        </g>

        {/* front arm (right) */}
        <g className="arm arm-r">
          <path d="M96 78 Q108 90 106 104" stroke={t.dark} strokeWidth="9" fill="none" strokeLinecap="round" />
          <circle className="fist" cx="106" cy="106" r="8" fill={t.base} stroke={t.dark} strokeWidth="1.5" />
          <circle cx="100" cy="102" r="3.4" fill={t.base} stroke={t.dark} strokeWidth="1.2" />
          {id === 'execution' && <g><circle cx="112" cy="112" r="7" fill="#fffaf0" stroke="#8b5a33" strokeWidth="2" /><rect x="110.5" y="102" width="3" height="4" fill="#8b5a33" /><path d="M112 112 l0 -4 M112 112 l3 1" stroke="#3b2a1e" strokeWidth="1.3" strokeLinecap="round" /></g>}
        </g>
      </g>
    </svg>
  );
}
