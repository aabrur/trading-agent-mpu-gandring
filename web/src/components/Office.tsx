import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentId, AgentView, DeskState, Fight, Reaction, Speech } from '../types';
import { AGENT_ORDER } from '../types';
import { Bot, type Face, type Pose } from './Bot';
import { KerisBlade } from './Keris';
import { Sparkline } from './MiniCharts';

const SEATS: Record<AgentId, { x: number; y: number }> = {
  lead: { x: 50, y: 55 }, market: { x: 31, y: 63 }, research: { x: 69, y: 63 },
  strategist: { x: 31, y: 84 }, risk: { x: 69, y: 84 }, execution: { x: 50, y: 94 }
};
const STATUS_LABEL: Record<string, string> = { idle: 'coffee break', reading: 'reading charts', thinking: 'thinking', typing: 'typing', arguing: 'arguing', fighting: 'fighting', executing: 'filling paper order', journaling: 'journaling' };
const POW_WORDS = ['POW!', 'BAM!', 'BONK!', 'WHAM!', 'BUK!', 'PLAK!'];

interface Props {
  state: DeskState;
  speech: Partial<Record<AgentId, Speech>>;
  fights: Fight[];
  reactions: Partial<Record<AgentId, Reaction>>;
  disagreement: number;
  selected: AgentId | null;
  spark: number[];
  onSelect: (id: AgentId) => void;
}

// The puncher walks over and squares up beside the target, one arm's length away,
// so the two never stack on top of each other.
function approach(f: { x: number; y: number }, t: { x: number; y: number }, gap = 11) {
  const side = f.x > t.x ? 1 : -1;
  let x = t.x + side * gap;
  if (x < 6 || x > 94) x = t.x - side * gap;
  return { x, y: t.y };
}

function poseFor(a: AgentView, fight: Fight | undefined, reaction: Reaction | undefined, inDebate: boolean): { pose: Pose; face: Face } {
  if (fight?.from === a.id) return { pose: 'punch', face: 'angry' };
  if (fight?.to === a.id) return { pose: 'guard', face: 'dizzy' };
  if (reaction === 'cheer') return { pose: 'cheer', face: 'happy' };
  if (reaction === 'worried') return { pose: 'think', face: 'worried' };
  switch (a.status) {
    case 'reading': return { pose: 'point', face: 'normal' };
    case 'thinking': return { pose: 'think', face: 'normal' };
    case 'typing': case 'executing': case 'journaling': return { pose: 'type', face: 'normal' };
    case 'arguing': return { pose: 'argue', face: 'normal' };
    case 'fighting': return { pose: 'argue', face: 'angry' };
    default: return { pose: inDebate ? 'idle' : 'idle', face: 'normal' };
  }
}

function useWalking(x: number, y: number) {
  const prev = useRef({ x, y });
  const [walk, setWalk] = useState<{ on: boolean; left: boolean }>({ on: false, left: false });
  useEffect(() => {
    if (prev.current.x === x && prev.current.y === y) return;
    const left = x < prev.current.x;
    prev.current = { x, y };
    setWalk({ on: true, left });
    const t = window.setTimeout(() => setWalk((w) => ({ ...w, on: false })), 950);
    return () => window.clearTimeout(t);
  }, [x, y]);
  return walk;
}

function Agent({ a, pos, sp, fight, reaction, inDebate, selected, onSelect }: { a: AgentView; pos: { x: number; y: number }; sp?: Speech; fight?: Fight; reaction?: Reaction; inDebate: boolean; selected: boolean; onSelect: () => void }) {
  const walk = useWalking(pos.x, pos.y);
  let { pose, face } = poseFor(a, fight, reaction, inDebate);
  if (walk.on && (pose === 'idle' || pose === 'argue')) pose = 'walk';
  // face the opponent when punching, face travel direction when walking
  let flip = false;
  if (fight) {
    const hit = SEATS[fight.to], from = approach(SEATS[fight.from], hit);
    if (fight.from === a.id) flip = hit.x < from.x;
    else if (fight.to === a.id) flip = from.x < hit.x;
  }
  else if (walk.on && walk.left) flip = true;
  const talking = !!sp && !sp.done;
  return (
    <button
      className={`agent status-${a.status} ${selected ? 'is-selected' : ''} ${fight?.to === a.id ? 'is-hit' : ''} ${!inDebate && pose === 'idle' ? 'at-desk' : ''}`}
      style={{ left: `${pos.x}%`, top: `${pos.y}%`, zIndex: Math.round(pos.y * 10) + (sp ? 400 : 0), ['--agent' as string]: a.color }}
      onClick={onSelect}
      aria-label={`${a.name}, ${STATUS_LABEL[a.status]}`}
    >
      {sp && (
        <div className={`bubble ${sp.done ? 'done' : 'streaming'}`}>
          <b className="bubble-name">{a.name}</b>
          <span>{sp.text}</span>{!sp.done && <i className="caret" />}
          {sp.example && <em className="tag-example">EXAMPLE</em>}
        </div>
      )}
      {a.status === 'thinking' && !sp && <div className="think"><i /><i /><i /></div>}
      <div className={`bot-wrap ${flip ? 'flip' : ''}`}><Bot id={a.id} size={84} pose={pose} face={face} talking={talking} /></div>
      <div className="nametag">
        <strong>{a.name}</strong>
        <span className="status"><i className="dot" />{inDebate && a.status === 'idle' ? 'listening' : STATUS_LABEL[a.status]}</span>
        {a.stance && inDebate && <span className={`stance s-${a.stance}`}>{a.stance}{a.confidence != null ? ` ${Math.round(a.confidence * 100)}%` : ''}</span>}
      </div>
    </button>
  );
}

export function Office({ state, speech, fights, reactions, disagreement, selected, spark, onSelect }: Props) {
  const inDebate = !!state.debate;
  const activeFight = fights.at(-1);
  const heat = Math.min(1, disagreement);
  const up = spark.length > 1 && spark.at(-1)! >= spark[0];
  const visible = new Set((Object.values(speech).filter(Boolean) as Speech[]).sort((a, b) => b.at - a.at).slice(0, 1).map((s) => s.agent));

  const positions = useMemo(() => {
    const out = {} as Record<AgentId, { x: number; y: number }>;
    for (const id of AGENT_ORDER) {
      const a = state.agents[id];
      // at the desk they stand beside it, on the side that faces the room
      out[id] = inDebate ? { ...SEATS[id] } : { x: a.desk.x + (a.desk.x <= 50 ? 7.8 : -7.8), y: a.desk.y + 5.5 };
    }
    if (inDebate && activeFight) {
      const f = SEATS[activeFight.from], t = SEATS[activeFight.to];
      out[activeFight.from] = approach(f, t);
    }
    return out;
  }, [state.agents, inDebate, activeFight]);

  return (
    <div className={`office ${inDebate ? 'is-debating' : ''} ${fights.length ? 'is-brawling' : ''}`} style={{ ['--heat' as string]: heat }}>
      <svg className="office-scene" viewBox="0 0 1000 560" preserveAspectRatio="none" aria-hidden>
        <defs>
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--sky-top)" /><stop offset="1" stopColor="var(--sky-bottom)" /></linearGradient>
          <radialGradient id="sun" cx=".5" cy=".5" r=".5"><stop offset="0" stopColor="var(--sun)" /><stop offset="1" stopColor="var(--sun)" stopOpacity="0" /></radialGradient>
          <radialGradient id="lampglow" cx=".5" cy=".5" r=".5"><stop offset="0" stopColor="var(--lamp-glow)" stopOpacity=".55" /><stop offset="1" stopColor="var(--lamp-glow)" stopOpacity="0" /></radialGradient>
          <linearGradient id="beam" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--sun)" stopOpacity=".28" /><stop offset="1" stopColor="var(--sun)" stopOpacity="0" /></linearGradient>
          <pattern id="planks" width="160" height="34" patternUnits="userSpaceOnUse">
            <rect width="160" height="34" fill="var(--floor)" />
            <rect y="0" width="160" height="2" fill="var(--floor-line)" />
            <rect x="70" y="0" width="2" height="34" fill="var(--floor-line)" opacity=".7" />
            <rect y="17" width="160" height="17" fill="var(--floor-alt)" opacity=".45" />
            <rect y="17" width="160" height="1.5" fill="var(--floor-line)" />
            <rect x="140" y="17" width="2" height="17" fill="var(--floor-line)" opacity=".7" />
          </pattern>
          <pattern id="wallpaper" width="28" height="28" patternUnits="userSpaceOnUse">
            <rect width="28" height="28" fill="var(--wall)" />
            <circle cx="14" cy="14" r="1.6" fill="var(--wall-dot)" />
          </pattern>
          <clipPath id="frame-clip">
            <rect x="458" y="30" width="84" height="74" rx="3" />
          </clipPath>
        </defs>

        {/* wall */}
        <rect width="1000" height="168" fill="url(#wallpaper)" />
        <rect y="132" width="1000" height="40" fill="var(--wainscot)" />
        <rect y="130" width="1000" height="5" fill="var(--wood-dark)" opacity=".55" />
        {/* windows */}
        {[300, 600].map((x) => (
          <g key={x}>
            <rect x={x} y="18" width="120" height="100" rx="10" fill="url(#sky)" />
            <circle cx={x + 82} cy="86" r="34" fill="url(#sun)" />
            <path d={`M${x} 104 q25 -18 50 -6 t70 -8 v28 h-120z`} fill="var(--hill)" opacity=".75" />
            <rect x={x} y="18" width="120" height="100" rx="10" fill="none" stroke="var(--wood)" strokeWidth="7" />
            <line x1={x + 60} y1="18" x2={x + 60} y2="118" stroke="var(--wood)" strokeWidth="5" />
            <line x1={x} y1="68" x2={x + 120} y2="68" stroke="var(--wood)" strokeWidth="5" />
            <rect x={x - 6} y="116" width="132" height="8" rx="3" fill="var(--wood-dark)" />
            <path d={`M${x + 10} 124 L${x + 110} 124 L${x + 200} 560 L${x - 80} 560 Z`} fill="url(#beam)" className="sunbeam" />
          </g>
        ))}
        {/* bookshelf */}
        <g>
          <rect x="40" y="20" width="150" height="150" rx="6" fill="var(--wood-dark)" />
          {[30, 76, 122].map((yy, r) => (
            <g key={yy}>
              <rect x="48" y={yy} width="134" height="40" fill="var(--shelf-back)" />
              {Array.from({ length: 9 }).map((_, i) => {
                const h = 26 + ((i * 7 + r * 5) % 12);
                const cols = ['var(--terracotta)', 'var(--sage)', 'var(--teal)', 'var(--cream-deep)', 'var(--brass)', 'var(--rose)'];
                return <rect key={i} x={52 + i * 14} y={yy + 40 - h} width="11" height={h} rx="2" fill={cols[(i + r) % cols.length]} transform={i === 7 ? `rotate(12 ${58 + i * 14} ${yy + 40})` : undefined} />;
              })}
              <rect x="44" y={yy + 40} width="142" height="5" fill="var(--wood)" />
            </g>
          ))}
        </g>
        {/* framed logo and plaque */}
        <g>
          <rect x="450" y="22" width="100" height="90" rx="6" fill="var(--sage)" stroke="var(--wood)" strokeWidth="6" />
          <rect x="458" y="30" width="84" height="74" rx="3" fill="var(--cream)" />
          <image href="/mpu-gandring-logo.webp" x="460" y="32" width="80" height="70" preserveAspectRatio="xMidYMid meet" clipPath="url(#frame-clip)" />
          <rect x="448" y="112" width="104" height="15" rx="4" fill="var(--wood-dark)" />
          <text x="500" y="122.5" textAnchor="middle" className="plaque">MPU GANDRING</text>
        </g>
        {/* clock */}
        <g transform="translate(740 56)">
          <circle r="22" fill="var(--cream)" stroke="var(--wood)" strokeWidth="5" />
          <line x1="0" y1="0" x2="0" y2="-13" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" className="clock-min" />
          <line x1="0" y1="0" x2="9" y2="4" stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" />
          <circle r="2.5" fill="var(--terracotta)" />
        </g>
        {/* coffee corner */}
        <g>
          <rect x="820" y="104" width="160" height="66" rx="6" fill="var(--wood)" />
          <rect x="816" y="98" width="168" height="10" rx="4" fill="var(--wood-dark)" />
          <rect x="840" y="46" width="52" height="54" rx="8" fill="var(--machine)" />
          <rect x="848" y="54" width="36" height="14" rx="3" fill="var(--teal)" opacity=".8" />
          <circle cx="856" cy="78" r="3.5" fill="var(--terracotta)" />
          <circle cx="868" cy="78" r="3.5" fill="var(--sage)" />
          <rect x="858" y="86" width="16" height="12" rx="2" fill="var(--cream)" />
          <path className="steam" d="M862 84 q-3 -6 1 -10 M869 84 q-3 -6 1 -10" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" opacity=".8" />
          {[915, 940].map((x) => <g key={x}><rect x={x} y="84" width="14" height="14" rx="3" fill={x === 915 ? 'var(--terracotta)' : 'var(--sage)'} /><path d={`M${x + 14} 88 q5 2 0 7`} stroke={x === 915 ? 'var(--terracotta)' : 'var(--sage)'} strokeWidth="2" fill="none" /></g>)}
          <text x="900" y="140" textAnchor="middle" className="plaque dark">kopi corner</text>
        </g>

        {/* floor */}
        <rect y="170" width="1000" height="390" fill="url(#planks)" />
        <rect y="168" width="1000" height="8" fill="var(--wood-dark)" opacity=".35" />
        {/* rug */}
        <ellipse cx="500" cy="400" rx="300" ry="130" fill="var(--rug-edge)" />
        <ellipse cx="500" cy="400" rx="286" ry="128" fill="var(--rug)" />
        <ellipse cx="500" cy="400" rx="250" ry="108" fill="none" stroke="var(--rug-pattern)" strokeWidth="4" strokeDasharray="2 10" strokeLinecap="round" />
        <ellipse cx="500" cy="400" rx="210" ry="88" fill="none" stroke="var(--rug-pattern)" strokeWidth="2" opacity=".7" />
        <ellipse cx="500" cy="400" rx="300" ry="138" fill="var(--hit)" className="rug-heat" />
        {/* lamp glows */}
        <circle cx="60" cy="300" r="140" fill="url(#lampglow)" className="lamp-glow" />
        <circle cx="940" cy="300" r="140" fill="url(#lampglow)" className="lamp-glow" />
      </svg>

      {/* props in front of the floor */}
      <div className="prop lamp" style={{ left: '6%', top: '58%' }}><i className="shade" /><i className="pole" /><i className="base" /></div>
      <div className="prop lamp" style={{ left: '94%', top: '58%' }}><i className="shade" /><i className="pole" /><i className="base" /></div>
      <div className="prop plant big" style={{ left: '3.5%', top: '97%' }}><i className="leaf l1" /><i className="leaf l2" /><i className="leaf l3" /><i className="leaf l4" /><i className="pot" /></div>
      <div className="prop plant big" style={{ left: '96.5%', top: '97%' }}><i className="leaf l1" /><i className="leaf l2" /><i className="leaf l3" /><i className="leaf l4" /><i className="pot" /></div>
      <div className="prop plant small" style={{ left: '26%', top: '40%' }}><i className="leaf l1" /><i className="leaf l2" /><i className="leaf l3" /><i className="pot" /></div>

      {/* debate table */}
      <div className="arena" style={{ left: '50%', top: '72%' }}>
        <div className="arena-table">
          <div className="arena-inlay"><KerisBlade size={120} /></div>
          <div className="arena-label">{state.debate ? `${state.debate.symbol} · ${state.debate.phase}` : 'debate table'}</div>
        </div>
      </div>

      {/* desks */}
      {AGENT_ORDER.map((id) => {
        const a = state.agents[id];
        const busy = !inDebate && a.status !== 'idle';
        return (
          <div key={`desk-${id}`} className={`desk ${busy ? 'is-busy' : ''}`} style={{ left: `${a.desk.x}%`, top: `${a.desk.y}%`, zIndex: Math.round(a.desk.y * 10) + 5, ['--agent' as string]: a.color }}>
            <div className="monitor"><div className="screen"><Sparkline values={spark} up={up} /></div></div>
            <div className="desk-top"><i className="mug" /><i className="keyboard" />{id === 'research' && <i className="papers" />}{id === 'lead' && <i className="papers" />}{(id === 'lead' || id === 'strategist') && <i className="desk-plant" />}</div>
            <div className="desk-front"><span>{a.name}</span></div>
          </div>
        );
      })}

      {AGENT_ORDER.map((id) => {
        const f = activeFight && (activeFight.from === id || activeFight.to === id) ? activeFight : undefined;
        return <Agent key={id} a={state.agents[id]} pos={positions[id]} sp={visible.has(id) ? speech[id] : undefined} fight={inDebate ? f : undefined} reaction={reactions[id]} inDebate={inDebate} selected={selected === id} onSelect={() => onSelect(id)} />;
      })}

      {fights.map((f) => {
        const to = SEATS[f.to], from = approach(SEATS[f.from], to);
        return (
          <div key={f.id} className="pow" style={{ left: `${(from.x + to.x) / 2}%`, top: `${to.y - 18}%`, ['--i' as string]: f.intensity }}>
            <span>{POW_WORDS[f.id % POW_WORDS.length]}</span>
          </div>
        );
      })}

    </div>
  );
}
