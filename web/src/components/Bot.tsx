import { useId } from 'react';
import type { AgentId } from '../types';

export type Pose = 'idle' | 'type' | 'point' | 'think' | 'argue' | 'punch' | 'guard' | 'cheer' | 'walk' | 'read' | 'drink' | 'stretch' | 'sit' | 'observe' | 'pass';
export type Face = 'normal' | 'happy' | 'angry' | 'dizzy' | 'worried';

// Body tints: glossy 2.5D studio palette tuned per role.
export const TINT: Record<AgentId, { base: string; light: string; dark: string; rim: string; ink: string }> = {
  lead:       { base: '#68d5bc', light: '#e2fff7', dark: '#277f6d', rim: '#a8f5e2', ink: '#103831' },
  market:     { base: '#66c5de', light: '#e2f9ff', dark: '#25738b', rim: '#a6ecff', ink: '#0f3342' },
  research:   { base: '#8eb4ec', light: '#ebf2ff', dark: '#41659e', rim: '#bfd8ff', ink: '#192847' },
  strategist: { base: '#98d98f', light: '#efffe9', dark: '#46893f', rim: '#c7f5be', ink: '#1a3717' },
  risk:       { base: '#f09f90', light: '#fff2ed', dark: '#aa5344', rim: '#ffc8bd', ink: '#441912' },
  execution:  { base: '#f3be76', light: '#fff6e2', dark: '#a6722a', rim: '#ffdfab', ink: '#422b0a' },
};

interface Props {
  id: AgentId;
  size?: number;
  pose?: Pose;
  face?: Face;
  talking?: boolean;
  className?: string;
}

// 2.5D studio character with role accessories, expressive faces, and activity-matched props.
export function Bot({ id, size = 72, pose = 'idle', face = 'normal', talking = false, className = '' }: Props) {
  const uid = useId().replace(/:/g, '');
  const t = TINT[id];
  const g = `g-${uid}`;
  const showBook = pose === 'read' || pose === 'pass';
  const showMug = pose === 'drink' || pose === 'idle';
  const showScope = pose === 'observe';
  const showTypeFx = pose === 'type';
  const showIdea = pose === 'think';

  return (
    <svg className={`bot pose-${pose} face-${face} ${talking ? 'talking' : ''} ${className}`} width={size} height={size * 1.1} viewBox="0 0 120 132" aria-hidden>
      <defs>
        <radialGradient id={g} cx="34%" cy="26%" r="76%">
          <stop offset="0" stopColor={t.light} />
          <stop offset="0.42" stopColor={t.base} />
          <stop offset="0.84" stopColor={t.dark} />
          <stop offset="1" stopColor={t.ink} stopOpacity="0.92" />
        </radialGradient>
        <linearGradient id={`${g}-metal`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff3be" />
          <stop offset="0.48" stopColor="#dfb45d" />
          <stop offset="1" stopColor="#8a5f2a" />
        </linearGradient>
        <linearGradient id={`${g}-visor`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.15" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.4" />
        </linearGradient>
      </defs>

      <ellipse className="bot-shadow" cx="60" cy="126" rx="31" ry="5.5" fill="rgba(62,36,16,.25)" />
      <ellipse className="bot-shadow-core" cx="60" cy="126" rx="19" ry="3.2" fill="rgba(50,28,12,.18)" />

      <g className="feet">
        <ellipse className="foot foot-l" cx="46" cy="118" rx="10.5" ry="6.2" fill={t.dark} stroke={t.ink} strokeWidth="1" strokeOpacity=".35" />
        <ellipse className="foot foot-r" cx="74" cy="118" rx="10.5" ry="6.2" fill={t.dark} stroke={t.ink} strokeWidth="1" strokeOpacity=".35" />
        <path d="M40 116 q6 -3 12 0 M68 116 q6 -3 12 0" fill="none" stroke={t.light} strokeWidth="1.5" opacity=".55" strokeLinecap="round" />
      </g>

      <g className="body">
        {/* Back arm (left) */}
        <g className="arm arm-l">
          <path d="M24 78 Q12 90 14 104" stroke={t.dark} strokeWidth="9" fill="none" strokeLinecap="round" />
          <circle cx="14" cy="106" r="8" fill={t.base} stroke={t.dark} strokeWidth="1.5" />
          <circle cx="20" cy="102" r="3.4" fill={t.base} stroke={t.dark} strokeWidth="1.2" />

          {showBook && (
            <g className="prop-book" transform="rotate(-8 14 106)">
              <rect x="0" y="94" width="27" height="22" rx="3" fill="#3f5c85" stroke="#243a5a" strokeWidth="1.3" />
              <path d="M4 97 h19 v16 H4z" fill="#fff7e2" />
              <path d="M13.5 97 v16" stroke="#d5c3a3" strokeWidth="1" />
              <path d="M6 100 h5.5 M6 103 h6 M6 106 h5 M15.5 100 h5.5 M15.5 103 h5 M15.5 106 h6" stroke="#9e8b6b" strokeWidth="1" strokeLinecap="round" />
              <path d="M20 96 v11 l-2 -2 -2 2 v-11" fill="#d46b4e" />
            </g>
          )}

          {showMug && (
            <g className="mug">
              <rect x="1" y="99" width="13" height="14" rx="3.2" fill="#fffaf0" stroke="#c4a67d" strokeWidth="1.3" />
              <path d="M14 102 q5.5 1 0 7.5" stroke="#c4a67d" strokeWidth="1.7" fill="none" />
              <rect x="2.8" y="100.8" width="9.4" height="3.2" rx="1.5" fill="#7d4d28" />
              <path d="M3 106 h9" stroke="#e5d4b7" strokeWidth="1" />
              <path className="steam" d="M5.5 95 q-2 -4 1.2 -7.5 M10 95 q-2 -4 1.2 -7.5" stroke="rgba(255,252,244,.92)" strokeWidth="1.5" fill="none" strokeLinecap="round" />
            </g>
          )}
        </g>

        <g className="ball">
          <circle cx="60" cy="68" r="44" fill={`url(#${g})`} />
          <circle cx="60" cy="68" r="43" fill="none" stroke={t.rim} strokeWidth="1.6" opacity=".42" />
          <path d="M28 89 C42 109 78 111 92 89" fill="none" stroke={t.dark} strokeWidth="3.5" opacity=".28" strokeLinecap="round" />
          {/* Glossy studio highlights */}
          <ellipse cx="41" cy="40" rx="14" ry="7.5" fill="#fff" opacity=".46" transform="rotate(-30 41 40)" />
          <ellipse cx="30" cy="55" rx="2.6" ry="5.2" fill="#fff" opacity=".35" transform="rotate(16 30 55)" />
          {/* Warm cheek blush */}
          <ellipse cx="36" cy="84" rx="7.2" ry="3.8" fill="#ff859d" opacity=".4" />
          <ellipse cx="86" cy="80" rx="7.2" ry="3.8" fill="#ff859d" opacity=".4" />

          {/* Subtle collar / neck detail */}
          <path d="M44 103 Q60 110 76 103" fill="none" stroke="rgba(255,255,255,.32)" strokeWidth="2" strokeLinecap="round" />

          {/* Eyes */}
          <g className="eyes" fill={t.ink}>
            <g className="eyes-normal">
              <ellipse className="eye" cx="50" cy="64" rx="6.3" ry="12.2" transform="rotate(-18 50 64)" />
              <ellipse className="eye" cx="73" cy="60" rx="6.3" ry="12.2" transform="rotate(-18 73 60)" />
              <circle cx="48" cy="57.5" r="2.1" fill="#fff" opacity=".88" />
              <circle cx="71" cy="53.5" r="2.1" fill="#fff" opacity=".88" />
              <circle cx="52" cy="68" r="1.1" fill={t.light} opacity=".7" />
              <circle cx="75" cy="64" r="1.1" fill={t.light} opacity=".7" />
            </g>
            <g className="eyes-happy" fill="none" stroke={t.ink} strokeWidth="4.5" strokeLinecap="round">
              <path d="M42 66 q7 -11 14 -1" />
              <path d="M65 62 q7 -11 14 -1" />
            </g>
            <g className="eyes-dizzy" fill="none" stroke={t.ink} strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M43 55 L55 63 L43 71" />
              <path d="M80 51 L68 59 L80 67" />
            </g>
            <g className="brows" stroke={t.ink} strokeWidth="3.8" strokeLinecap="round">
              <path className="brow-angry" d="M41 46 L57 53 M82 42 L67 50" />
              <path className="brow-worried" d="M42 50 L56 45 M80 45 L67 42" />
            </g>
          </g>

          {/* Expressive mouth */}
          <path className="mouth-smile" d="M57 86 q5 3.5 10 -0.5" fill="none" stroke={t.ink} strokeWidth="2.2" strokeLinecap="round" opacity=".55" />
          <ellipse className="mouth" cx="62" cy="88" rx="4.2" ry="3.2" fill={t.ink} />
          <path className="sweat" d="M100 36 q6 9 0 13 q-6 -4 0 -13z" fill="#9fdcf5" stroke="#5fb6dc" strokeWidth="1" />

          {/* Role accessories */}
          {id === 'lead' && (
            <g className="acc-lead">
              <path d="M50 101 l10 4 l10 -4 l-3 6 l-7 -2 l-7 2z" fill="#f7efe0" opacity=".88" />
              <path d="M56 104 l4 -4 l4 4 l-1.8 11 l-2.2 2.5 l-2.2 -2.5z" fill="#b84d35" />
              <path d="M57 100 h6 l-1 3.2 h-4z" fill="#8c3523" />
              <circle cx="60" cy="108" r="1.3" fill="#f5d27b" />
              <g transform="rotate(28 86 92)">
                <rect x="80" y="80" width="12" height="24" rx="5" fill={t.ink} opacity=".14" />
                <path d="M86 82 c4 3 -3 5 0 8 s-3 5 0 8 l-1 3 h2z" fill={`url(#${g}-metal)`} stroke="#926632" strokeWidth=".6" />
                <rect x="82" y="99" width="8" height="2" rx="1" fill="#e6c779" />
                <path d="M86 101 v3 m-2 0 h4" stroke="#956431" strokeWidth="2" strokeLinecap="round" />
              </g>
            </g>
          )}

          {id === 'market' && (
            <g className="acc-market">
              <path d="M18 64 Q18 17 60 17 Q102 17 102 64" stroke="#36261b" strokeWidth="5.2" fill="none" strokeLinecap="round" />
              <path d="M22 42 Q28 20 60 20 Q90 20 98 42" stroke="#7d624c" strokeWidth="2.2" fill="none" strokeLinecap="round" />
              <rect x="11" y="55" width="13" height="21" rx="5.5" fill="#36261b" />
              <rect x="96" y="55" width="13" height="21" rx="5.5" fill="#36261b" />
              <rect x="13.5" y="59" width="5.5" height="12" rx="2.6" fill="#63b5cf" />
              <rect x="101" y="59" width="5.5" height="12" rx="2.6" fill="#63b5cf" />
              <path d="M101 74 Q100 92 80 94" stroke="#36261b" strokeWidth="2.5" fill="none" />
              <circle cx="79" cy="94" r="3.8" fill="#e07a52" stroke="#36261b" strokeWidth="1" />
            </g>
          )}

          {id === 'research' && (
            <g className="acc-research">
              {/* Scholar hairpin / beret accent */}
              <ellipse cx="44" cy="25" rx="18" ry="6.5" fill="#5b7bb2" transform="rotate(-14 44 25)" />
              <circle cx="34" cy="26" r="2.5" fill="#f3d27a" />
              {/* Round reading glasses */}
              <g fill="none" stroke="#634329" strokeWidth="2.6">
                <circle cx="50" cy="64" r="12.2" fill={`url(#${g}-visor)`} />
                <circle cx="74" cy="60" r="12.2" fill={`url(#${g}-visor)`} />
                <path d="M61.5 62.5 Q62 58 62.5 61" />
                <path d="M38 62 L22 58 M86 58 L100 52" />
                <path d="M42 57 l5 -3 M66 53 l5 -3" stroke="#fff" strokeWidth="1.6" opacity=".75" strokeLinecap="round" />
              </g>
            </g>
          )}

          {id === 'strategist' && (
            <g className="acc-strategist">
              <ellipse cx="54" cy="27" rx="31" ry="11.5" fill="#d9774f" transform="rotate(-8 54 27)" />
              <ellipse cx="54" cy="30.5" rx="26.5" ry="5" fill="#b05636" transform="rotate(-8 54 30.5)" opacity=".65" />
              <rect x="51" y="12.5" width="4" height="7" rx="2" fill="#b05636" />
              <circle cx="68" cy="26" r="3.2" fill="#f5d178" stroke="#9e6d2b" strokeWidth="1" />
              <path d="M33 24 q13 -7 26 -4" stroke="#f7b389" strokeWidth="2" fill="none" strokeLinecap="round" opacity=".7" />
              <g transform="rotate(35 96 44)">
                <rect x="92" y="28" width="5" height="26" rx="1" fill="#f2c14e" />
                <path d="M93 31 v21" stroke="#ffe7a2" strokeWidth="1.2" />
                <path d="M92 54 l2.5 6 l2.5 -6z" fill="#f6dfb6" />
                <path d="M93.5 57.5 l1 2.5 1 -2.5z" fill="#43352b" />
                <rect x="92" y="26" width="5" height="4" fill="#e58a8a" />
                <path d="M92 31 h5" stroke="#a5804f" strokeWidth="1.5" />
              </g>
            </g>
          )}

          {id === 'risk' && (
            <g className="acc-risk">
              <path d="M22 40 Q24 12 60 12 Q96 12 98 40 Z" fill="#f2c14e" stroke="#c59434" strokeWidth="1.5" />
              <rect x="16" y="37" width="88" height="8" rx="4" fill="#e6ae36" />
              <rect x="56" y="12" width="8" height="26" rx="3" fill="#ffd978" />
              <path d="M30 31 Q35 20 49 19 M71 19 Q84 22 89 31" stroke="#ffe49b" strokeWidth="2" fill="none" strokeLinecap="round" />
              <path d="M20 41 h80" stroke="#b88229" strokeWidth="1" opacity=".5" />
              <rect x="52.5" y="25.5" width="15" height="10.5" rx="3" fill="#fff4d1" stroke="#c59434" strokeWidth="1" />
              <path d="M56.5 31 l2.2 2.2 4.5 -4.5" fill="none" stroke="#6f4f1c" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </g>
          )}

          {id === 'execution' && (
            <g className="acc-execution">
              <path d="M24 38 Q28 14 60 14 Q92 14 94 38 Z" fill="#d9774f" />
              <path d="M90 36 q22 -2 24 4 q-12 4 -26 2z" fill="#b05636" />
              <circle cx="60" cy="15" r="3" fill="#b05636" />
              <path d="M60 19 q-4 8 -3 17 M34 33 q10 -12 20 -13" fill="none" stroke="#f5a782" strokeWidth="1.5" strokeLinecap="round" />
              <path d="M88 40 q14 0 20 -1" fill="none" stroke="#8a4935" strokeWidth="1" />
              <rect x="56.5" y="24.5" width="13" height="9.5" rx="3" fill="#ffe2b8" stroke="#b05636" strokeWidth=".9" />
              <path d="M64 25.5 l-4 4 h3 l-1 3 5 -4 h-4z" fill="#9d5337" />
            </g>
          )}

          {/* Idea sparkle when thinking */}
          {showIdea && (
            <g className="prop-idea">
              <path d="M98 22 l2.5 5.5 l5.5 2.5 l-5.5 2.5 l-2.5 5.5 l-2.5 -5.5 l-5.5 -2.5 l5.5 -2.5z" fill="#ffe07d" stroke="#d49b2a" strokeWidth="1" />
              <circle cx="88" cy="16" r="2" fill="#fff2b2" />
            </g>
          )}
        </g>

        {/* Typing indicator bar when actively typing/executing */}
        {showTypeFx && (
          <g className="prop-type-fx">
            <rect x="34" y="109" width="52" height="7" rx="3.5" fill="rgba(255,248,230,.85)" stroke={t.dark} strokeWidth="1.2" />
            <circle cx="43" cy="112.5" r="1.8" fill={t.dark} />
            <circle cx="51" cy="112.5" r="1.8" fill={t.base} />
            <circle cx="60" cy="112.5" r="1.8" fill={t.dark} />
            <circle cx="69" cy="112.5" r="1.8" fill={t.base} />
            <circle cx="77" cy="112.5" r="1.8" fill={t.dark} />
          </g>
        )}

        {/* Front arm (right) */}
        <g className="arm arm-r">
          <path d="M96 78 Q108 90 106 104" stroke={t.dark} strokeWidth="9" fill="none" strokeLinecap="round" />
          <circle className="fist" cx="106" cy="106" r="8" fill={t.base} stroke={t.dark} strokeWidth="1.5" />
          <circle cx="100" cy="102" r="3.4" fill={t.base} stroke={t.dark} strokeWidth="1.2" />

          {pose === 'pass' && (
            <g className="prop-pass-doc" transform="rotate(12 108 102)">
              <rect x="96" y="92" width="20" height="15" rx="2" fill="#fff8e6" stroke="#b8986c" strokeWidth="1.2" />
              <path d="M99 96 h12 M99 99.5 h14 M99 103 h9" stroke="#8a7250" strokeWidth="1.1" strokeLinecap="round" />
            </g>
          )}

          {showScope && (
            <g className="prop-scope" transform="rotate(-18 106 100)">
              <line x1="104" y1="104" x2="112" y2="114" stroke="#785230" strokeWidth="3" strokeLinecap="round" />
              <circle cx="100" cy="96" r="8.5" fill="rgba(215,246,255,.55)" stroke="#c89643" strokeWidth="2.2" />
              <path d="M96 93 l4 -3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
            </g>
          )}

          {id === 'execution' && pose !== 'pass' && !showScope && (
            <g className="prop-stopwatch">
              <rect x="109" y="102" width="6" height="20" rx="2" fill="#72523c" />
              <circle cx="111" cy="112" r="6.5" fill={`url(#${g}-metal)`} stroke="#8b5a33" strokeWidth="1.5" />
              <circle cx="111" cy="112" r="4.8" fill="#fffaf0" />
              <path d="M111 112 v-3 M111 112 l2 1" stroke="#3b2a1e" strokeWidth="1.3" strokeLinecap="round" />
              <circle cx="111" cy="112" r=".9" fill="#a65f3b" />
            </g>
          )}
        </g>
      </g>
    </svg>
  );
}
