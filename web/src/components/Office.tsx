import { useMemo } from 'react';
import type { AgentId, DeskState, Fight, Speech } from '../types';
import { AGENT_ORDER } from '../types';
import { Avatar } from './Avatar';
import { Keris } from './Keris';

const SEATS: Record<AgentId, { x: number; y: number }> = {
  lead: { x: 50, y: 41 }, market: { x: 29, y: 51 }, research: { x: 71, y: 51 },
  strategist: { x: 28, y: 73 }, risk: { x: 72, y: 73 }, execution: { x: 42, y: 86 }, reviewer: { x: 58, y: 86 }
};
const STATUS_LABEL: Record<string, string> = { idle: 'idle', reading: 'reading charts', thinking: 'thinking', typing: 'typing', arguing: 'arguing', fighting: 'fighting', executing: 'filling paper order', journaling: 'journaling' };
const POW_WORDS = ['POW!', 'BAM!', 'WHAM!', 'BONK!', 'THWACK!', 'GEDEBUK!'];

interface Props {
  state: DeskState;
  speech: Partial<Record<AgentId, Speech>>;
  fights: Fight[];
  disagreement: number;
  selected: AgentId | null;
  onSelect: (id: AgentId) => void;
}

export function Office({ state, speech, fights, disagreement, selected, onSelect }: Props) {
  const inDebate = !!state.debate;
  const activeFight = fights.at(-1);
  const heat = Math.min(1, disagreement);
  const fighting = new Set(fights.flatMap((f) => [f.from, f.to]));
  // only the three most recent speakers keep a bubble, so the arena stays readable
  const visible = new Set(
    (Object.values(speech).filter(Boolean) as Speech[]).sort((a, b) => b.at - a.at).slice(0, 3).map((s) => s.agent)
  );

  const positions = useMemo(() => {
    const out = {} as Record<AgentId, { x: number; y: number }>;
    for (const id of AGENT_ORDER) {
      const a = state.agents[id];
      out[id] = inDebate ? { ...SEATS[id] } : { x: a.desk.x, y: a.desk.y - 7 };
    }
    if (inDebate && activeFight) {
      const f = SEATS[activeFight.from], t = SEATS[activeFight.to];
      out[activeFight.from] = { x: f.x + (t.x - f.x) * 0.55, y: f.y + (t.y - f.y) * 0.55 };
    }
    return out;
  }, [state.agents, inDebate, activeFight]);

  return (
    <div className={`office ${inDebate ? 'is-debating' : ''} ${fighting.size ? 'is-brawling' : ''}`} style={{ ['--heat' as string]: heat }}>
      <svg className="office-floor" viewBox="0 0 1000 625" preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#151229" /><stop offset="1" stopColor="#1d1838" /></linearGradient>
          <linearGradient id="floorg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#14112a" /><stop offset="1" stopColor="#0d0b1c" /></linearGradient>
          <radialGradient id="arenaGlow" cx=".5" cy=".5" r=".5"><stop offset="0" stopColor="var(--arena-glow)" stopOpacity=".55" /><stop offset="1" stopColor="var(--arena-glow)" stopOpacity="0" /></radialGradient>
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#2b1d4f" /><stop offset="1" stopColor="#e86f51" stopOpacity=".55" /></linearGradient>
        </defs>
        <rect x="0" y="0" width="1000" height="78" fill="url(#wall)" />
        {[70, 250, 670, 850].map((x) => (
          <g key={x}>
            <rect x={x} y="10" width="90" height="54" rx="4" fill="url(#sky)" stroke="#2c2650" strokeWidth="3" />
            {Array.from({ length: 6 }).map((_, i) => <rect key={i} x={x + 6 + i * 14} y={64 - 10 - ((x + i * 37) % 26)} width="10" height={10 + ((x + i * 37) % 26)} fill="#120f24" opacity=".9" />)}
            <line x1={x + 45} y1="10" x2={x + 45} y2="64" stroke="#2c2650" strokeWidth="2" />
          </g>
        ))}
        <g className="wall-screen">
          <rect x="400" y="8" width="200" height="58" rx="6" fill="#0a0916" stroke="var(--brass)" strokeOpacity=".5" />
          <polyline className="wall-chart" points="410,52 430,46 450,49 470,36 490,40 510,28 530,33 550,22 570,30 590,18" fill="none" stroke="var(--teal)" strokeWidth="2" />
          <text x="500" y="22" textAnchor="middle" className="wall-title">MPU GANDRING DESK</text>
        </g>
        <polygon points="40,78 960,78 1000,625 0,625" fill="url(#floorg)" />
        {Array.from({ length: 13 }).map((_, i) => {
          const t = i / 12;
          return <line key={`v${i}`} x1={40 + 920 * t} y1="78" x2={1000 * t} y2="625" stroke="var(--grid-line)" />;
        })}
        {Array.from({ length: 10 }).map((_, i) => {
          const y = 78 + 547 * Math.pow(i / 9, 1.35);
          const inset = 40 * (1 - (y - 78) / 547);
          return <line key={`h${i}`} x1={inset} y1={y} x2={1000 - inset} y2={y} stroke="var(--grid-line)" />;
        })}
        <ellipse cx="500" cy="395" rx="300" ry="170" fill="url(#arenaGlow)" className="arena-glow" />
        <rect x="0" y="76" width="1000" height="4" fill="var(--brass)" opacity=".35" />
      </svg>

      {/* plants */}
      <div className="prop plant" style={{ left: '3%', top: '22%' }} />
      <div className="prop plant" style={{ left: '95%', top: '22%' }} />
      <div className="prop cooler" style={{ left: '50%', top: '96%' }}><span>kopi</span></div>

      {/* arena table */}
      <div className="arena" style={{ left: '50%', top: '61%' }}>
        <div className="arena-table">
          <Keris className="arena-keris" height={150} />
          <div className="arena-label">{state.debate ? `${state.debate.symbol} · ${state.debate.phase}` : 'debate arena'}</div>
        </div>
      </div>

      {/* desks */}
      {AGENT_ORDER.map((id) => {
        const a = state.agents[id];
        const busy = !inDebate && a.status !== 'idle';
        return (
          <div key={`desk-${id}`} className={`desk ${busy ? 'is-busy' : ''}`} style={{ left: `${a.desk.x}%`, top: `${a.desk.y}%`, zIndex: Math.round(a.desk.y * 10) + 5, ['--agent' as string]: a.color }}>
            <div className="monitor"><div className="screen"><i /><i /><i /><i /><i /></div></div>
            <div className="desk-top" />
            <div className="desk-front"><span>{a.name}</span></div>
          </div>
        );
      })}

      {/* agents */}
      {AGENT_ORDER.map((id) => {
        const a = state.agents[id];
        const p = positions[id];
        const sp = visible.has(id) ? speech[id] : undefined;
        const isPunching = activeFight?.from === id;
        const isHit = activeFight?.to === id;
        return (
          <button
            key={id}
            className={`agent status-${a.status} ${selected === id ? 'is-selected' : ''} ${isPunching ? 'is-punching' : ''} ${isHit ? 'is-hit' : ''}`}
            style={{ left: `${p.x}%`, top: `${p.y}%`, zIndex: Math.round(p.y * 10) + (sp ? 400 : 0), ['--agent' as string]: a.color }}
            onClick={() => onSelect(id)}
            aria-label={`${a.name}, ${STATUS_LABEL[a.status]}`}
          >
            {sp && (
              <div className={`bubble ${sp.done ? 'done' : 'streaming'}`}>
                <span>{sp.text}</span>{!sp.done && <b className="caret" />}
                {sp.example && <em className="tag-example">EXAMPLE</em>}
              </div>
            )}
            {a.status === 'reading' && <div className="think chart"><i /><i /><i /><i /></div>}
            {a.status === 'thinking' && <div className="think dots"><i /><i /><i /></div>}
            <Avatar id={id} color={a.color} size={52} punching={isPunching} />
            <div className="nametag">
              <strong>{a.name}</strong>
              <span className="status"><i className="dot" />{STATUS_LABEL[a.status]}</span>
              {a.stance && <span className={`stance s-${a.stance}`}>{a.stance}{a.confidence != null ? ` ${Math.round(a.confidence * 100)}%` : ''}</span>}
            </div>
          </button>
        );
      })}

      {/* comic hits */}
      {fights.map((f) => {
        const from = SEATS[f.from], to = SEATS[f.to];
        return (
          <div key={f.id} className="pow" style={{ left: `${(from.x + to.x * 2) / 3}%`, top: `${(from.y + to.y * 2) / 3 - 9}%`, ['--i' as string]: f.intensity }}>
            <span>{POW_WORDS[f.id % POW_WORDS.length]}</span>
          </div>
        );
      })}

      {!inDebate && (
        <div className="office-hint">Click any agent to talk to them. Type <code>analyze ETHUSDT</code> below to call a debate.</div>
      )}
    </div>
  );
}
