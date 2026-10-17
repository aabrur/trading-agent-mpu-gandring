import type { AgentId } from '../types';

const SKIN: Record<AgentId, string> = { lead: '#c98e5f', market: '#e0b08a', research: '#a8714a', strategist: '#f1c9a5', risk: '#8d5a3b', execution: '#d9a179', reviewer: '#b77f57' };
const HAIR: Record<AgentId, string> = { lead: '#1b1612', market: '#2b1d14', research: '#121018', strategist: '#3a2a20', risk: '#0e0c0c', execution: '#22180f', reviewer: '#4a3a33' };

// Hand-drawn SVG people. No external assets.
export function Avatar({ id, color, size = 64, punching = false }: { id: AgentId; color: string; size?: number; punching?: boolean }) {
  const skin = SKIN[id];
  const hair = HAIR[id];
  return (
    <svg className="avatar-svg" width={size} height={size * 1.25} viewBox="0 0 64 80" aria-hidden>
      <ellipse cx="32" cy="76" rx="18" ry="4" fill="rgba(0,0,0,.45)" />
      {/* legs */}
      <rect x="23" y="58" width="7" height="16" rx="3" fill="#1d1b2b" />
      <rect x="34" y="58" width="7" height="16" rx="3" fill="#1d1b2b" />
      {/* body */}
      <path d="M16 62 Q16 38 32 38 Q48 38 48 62 Z" fill={color} />
      <path d="M26 40 L32 50 L38 40" fill="none" stroke="rgba(0,0,0,.25)" strokeWidth="2" />
      {/* back arm */}
      <rect className="arm arm-back" x="12" y="42" width="7" height="16" rx="3.5" fill={color} style={{ filter: 'brightness(.8)' }} />
      {/* punching arm */}
      <g className={`arm arm-front ${punching ? 'is-punching' : ''}`}>
        <rect x="45" y="42" width="7" height="16" rx="3.5" fill={color} style={{ filter: 'brightness(.9)' }} />
        <circle className="fist" cx="48.5" cy="59" r="4.2" fill={skin} />
      </g>
      {/* head */}
      <circle cx="32" cy="24" r="13" fill={skin} />
      <circle cx="27" cy="25" r="1.6" fill="#16121c" className="eye" />
      <circle cx="37" cy="25" r="1.6" fill="#16121c" className="eye" />
      <path className="mouth" d="M28 31 Q32 33.5 36 31" stroke="#5a2e22" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      {id === 'lead' && (
        <>
          {/* blangkon style headwrap with a gold band */}
          <path d="M18 22 Q19 9 32 9 Q45 9 46 22 Q40 16 32 16 Q24 16 18 22Z" fill="#2a1f14" />
          <path d="M19 19 Q32 12 45 19" stroke="#e8b44c" strokeWidth="2" fill="none" />
          <circle cx="45" cy="22" r="3" fill="#2a1f14" />
        </>
      )}
      {id === 'market' && (
        <>
          <path d="M19 22 Q20 10 32 10 Q44 10 45 22 Q38 15 30 16 Q24 17 19 22Z" fill={hair} />
          <path d="M18 25 Q18 9 32 9 Q46 9 46 25" stroke="#0e1726" strokeWidth="2.5" fill="none" />
          <rect x="15" y="22" width="5" height="8" rx="2" fill="#4cc9f0" />
          <path d="M18 30 Q20 36 27 35" stroke="#0e1726" strokeWidth="1.5" fill="none" />
        </>
      )}
      {id === 'research' && (
        <>
          <path d="M18 26 Q16 8 32 9 Q48 8 46 26 Q46 16 32 15 Q19 16 18 26Z" fill={hair} />
          <circle cx="27" cy="25" r="4.2" fill="none" stroke="#e8e6f0" strokeWidth="1.4" />
          <circle cx="37" cy="25" r="4.2" fill="none" stroke="#e8e6f0" strokeWidth="1.4" />
          <path d="M31.2 25 h1.6" stroke="#e8e6f0" strokeWidth="1.4" />
        </>
      )}
      {id === 'strategist' && (
        <>
          <path d="M19 21 Q22 10 32 10 Q43 10 45 21 L19 21Z" fill={hair} />
          <rect x="21" y="21.5" width="22" height="6" rx="3" fill="#06d6a0" opacity=".85" />
        </>
      )}
      {id === 'risk' && (
        <>
          <path d="M19 20 Q20 11 32 11 Q44 11 45 20 Q32 15 19 20Z" fill={hair} />
          <path d="M25 46 l7 -3 l7 3 v5 q0 5 -7 8 q-7 -3 -7 -8z" fill="#fff" opacity=".9" />
          <path d="M29 50 l2.5 2.5 l4.5 -5" stroke={color} strokeWidth="1.8" fill="none" />
        </>
      )}
      {id === 'execution' && (
        <>
          <path d="M18 20 Q20 9 32 9 Q44 9 46 20Z" fill="#f78c6b" />
          <path d="M44 19 h9 q1 0 0 2 h-9z" fill="#c25e40" />
        </>
      )}
      {id === 'reviewer' && (
        <>
          <path d="M18 24 Q15 8 32 9 Q50 9 46 24 Q44 14 36 15 Q30 13 24 16 Q19 18 18 24Z" fill={hair} />
          <rect x="8" y="48" width="10" height="12" rx="1.5" fill="#fff6d6" transform="rotate(-10 13 54)" />
          <path d="M10 52 h6 M10 55 h5" stroke="#9a7b4f" strokeWidth="1" transform="rotate(-10 13 54)" />
        </>
      )}
    </svg>
  );
}
