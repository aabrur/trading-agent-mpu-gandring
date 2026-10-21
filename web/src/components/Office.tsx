import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentId, AgentView, DeskState, Fight, Reaction, Speech } from '../types';
import { AGENT_ORDER } from '../types';
import { Bot, type Face, type Pose } from './Bot';
import { KerisBlade } from './Keris';
import { Sparkline } from './MiniCharts';
import { SEATS, WORKSTATIONS, FIGHT_STAGE, SPECTATORS, heatedDebateFight, officePnl, route, type Activity, type Point, type SceneEvent } from '../sceneDirector';
import { useSceneDirector } from '../useSceneDirector';
import { useI18n } from '../i18n';
import { fmt } from './format';
import { OfficeDiscussion } from './OfficeDiscussion';
import '../styles/office-v2.css';

const POW_WORDS = ['GEBUK!', 'POW!', 'BONK!', 'DUAR!', 'PLAK!', 'BLETAK!', 'BAM!', 'AMPUN!', 'HAJAR!', 'JEDER!'];
const asset = (name: string) => `/office-assets/${name}.webp`;
const DESK_LABEL: Record<AgentId, string> = { lead: 'Desk lead', market: 'Market watch', research: 'Research library', strategist: 'Strategy desk', risk: 'Risk review', execution: 'Execution desk' };

interface Props {
  children?: ReactNode;
  state: DeskState;
  sceneEvents: SceneEvent[];
  speech: Partial<Record<AgentId, Speech>>;
  fights: Fight[];
  reactions: Partial<Record<AgentId, Reaction>>;
  disagreement: number;
  selected: AgentId | null;
  spark: number[];
  onSelect: (id: AgentId) => void;
}

function useOfficeFight(state: DeskState, fights: Fight[]) {
  const [clock, setClock] = useState({ now: 0, reduced: true, hidden: true });
  const debating = Boolean(state.debate);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setClock({ now: Date.now(), reduced: media.matches, hidden: document.hidden });
    update();
    const timer = debating ? window.setInterval(update, 500) : undefined;
    media.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    return () => { window.clearInterval(timer); media.removeEventListener('change', update); document.removeEventListener('visibilitychange', update); };
  }, [debating]);
  if (!debating || ['opening', 'reading', 'verdict', 'risk gate', 'done'].includes(state.debate?.phase ?? '') || state.killed || state.paused || clock.reduced || clock.hidden) return undefined;
  return fights.at(-1) ?? heatedDebateFight(state, clock.now) ?? undefined;
}

function poseFor(a: AgentView, fight: Fight | undefined, reaction: Reaction | undefined, inDebate: boolean, activeFight?: Fight): { pose: Pose; face: Face } {
  if (fight?.from === a.id) return { pose: 'punch', face: 'angry' };
  if (fight?.to === a.id) return { pose: 'guard', face: 'dizzy' };
  if (reaction === 'cheer') return { pose: 'cheer', face: 'happy' };
  if (reaction === 'worried') return { pose: 'think', face: 'worried' };
  if (activeFight && activeFight.from !== a.id && activeFight.to !== a.id) {
    return { pose: 'think', face: 'worried' };
  }
  switch (a.status) {
    case 'reading': return { pose: 'point', face: 'normal' };
    case 'thinking': return { pose: 'think', face: 'normal' };
    case 'typing': case 'executing': case 'journaling': return { pose: 'type', face: 'normal' };
    case 'arguing': return { pose: 'argue', face: 'normal' };
    case 'fighting': return { pose: 'punch', face: 'angry' };
    default: return { pose: inDebate ? 'idle' : 'idle', face: 'normal' };
  }
}


function useMovement(pos: Point, desks: Point[], staged = false) {
  const anchor = useRef<HTMLDivElement>(null);
  const previous = useRef(pos);
  const wasStaged = useRef(false);
  const [walk, setWalk] = useState({ on: false, left: false });
  const geometry = desks.map((d) => `${d.x},${d.y}`).join(';');
  useEffect(() => {
    const el = anchor.current;
    if (!el) return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const from = previous.current;
    if (staged || wasStaged.current) {
      wasStaged.current = staged;
      previous.current = pos;
      el.style.transform = `translate(${pos.x}%, ${pos.y}%)`;
      setWalk({ on: false, left: false });
      return;
    }
    if (from.x === pos.x && from.y === pos.y) { el.style.transform = `translate(${pos.x}%, ${pos.y}%)`; return; }
    const path = route(from, pos, desks);
    const target = path.at(-1)!;
    previous.current = target;
    const distance = path.slice(1).reduce((d, p, i) => d + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0);
    const duration = media.matches || document.hidden ? 0 : Math.max(600, distance * 65);
    setWalk({ on: duration > 0 && path.length > 1, left: target.x < from.x });
    let travelled = 0;
    const frames = path.map((p, i) => {
      if (i) travelled += Math.hypot(p.x - path[i - 1].x, p.y - path[i - 1].y);
      return { transform: `translate(${p.x}%, ${p.y}%)`, offset: distance ? travelled / distance : i / Math.max(1, path.length - 1) };
    });
    const animation = el.animate(frames, { duration, easing: 'ease-in-out', fill: 'forwards' });
    animation.onfinish = () => { el.style.transform = `translate(${target.x}%, ${target.y}%)`; setWalk((w) => ({ ...w, on: false })); };
    const reduce = () => { if (media.matches || document.hidden) animation.finish(); };
    media.addEventListener('change', reduce);
    document.addEventListener('visibilitychange', reduce);
    return () => {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
      const parent = el.parentElement;
      if (parent?.clientWidth && parent.clientHeight) previous.current = { x: matrix.m41 / parent.clientWidth * 100, y: matrix.m42 / parent.clientHeight * 100 };
      el.style.transform = getComputedStyle(el).transform;
      animation.cancel(); media.removeEventListener('change', reduce);
      document.removeEventListener('visibilitychange', reduce);
    };
  }, [pos.x, pos.y, geometry, staged]);
  return { anchor, walk };
}

function Agent({ a, pos, activity, desks, sp, fight, reaction, inDebate, selected, activeFight, onSelect }: { a: AgentView; pos: Point; activity: Activity; desks: Point[]; sp?: Speech; fight?: Fight; reaction?: Reaction; inDebate: boolean; selected: boolean; activeFight?: Fight; onSelect: () => void }) {
  const { anchor, walk } = useMovement(pos, desks, Boolean(activeFight));
  let { pose, face } = fight || reaction || activeFight ? poseFor(a, fight, reaction, inDebate, activeFight) : activity;

  if (walk.on && !fight) pose = 'walk';
  // face the opponent when punching, face travel direction when walking
  let flip = false;
  if (fight) {
    const hit = FIGHT_STAGE.to, from = FIGHT_STAGE.from;
    if (fight.from === a.id) flip = hit.x < from.x;
    else if (fight.to === a.id) flip = from.x < hit.x;
  }
  else if (walk.on && walk.left) flip = true;
  else if (activity.facing) flip = activity.facing === 'left';
  const talking = !!sp && !sp.done;
  const isPunching = fight?.from === a.id;
  const isHit = fight?.to === a.id;
  return (
    <div ref={anchor} className="agent-anchor" data-agent={a.id} style={{ zIndex: Math.round(pos.y * 10) + 100 }}>
    <button
      className={`agent status-${a.status} ${selected ? 'is-selected' : ''} ${isPunching ? 'is-punching' : ''} ${isHit ? 'is-hit' : ''} ${(isPunching || isHit) ? 'in-dust-brawl' : ''} ${!inDebate && pose === 'idle' ? 'at-desk' : ''} ${pos.y < 48 ? 'bubble-below' : ''} ${pos.x < 25 ? 'bubble-left' : pos.x > 75 ? 'bubble-right' : ''}`}
      style={{ zIndex: Math.round(pos.y * 10) + (sp ? 400 : 0) + (isPunching || isHit ? 250 : 0), ['--agent' as string]: a.color }}
      onClick={onSelect}
      aria-label={`${a.name}, ${walk.on ? 'walking' : activity.label}`}
    >
      {a.status === 'thinking' && !sp && <div className="think"><i /><i /><i /></div>}
      <div className={`bot-wrap ${flip ? 'flip' : ''}`}><Bot id={a.id} size={62} pose={pose} face={face} talking={talking} /></div>
      <div className="nametag">
        <strong>{a.name}</strong>
        <span className="status"><i className="dot" />{walk.on ? 'walking' : activity.label}</span>
        {a.stance && inDebate && <span className={`stance s-${a.stance}`}>{a.stance}{a.confidence != null ? ` ${Math.round(a.confidence * 100)}%` : ''}</span>}
      </div>
    </button>
    </div>
  );
}

export function Office({ state, sceneEvents, speech, fights, reactions, disagreement, selected, spark, onSelect, children }: Props) {
  const { t } = useI18n();
  const activities = useSceneDirector(state, sceneEvents);
  const inDebate = !!state.debate;
  const heat = Math.min(1, disagreement);
  const up = spark.length > 1 && spark.at(-1)! >= spark[0];
  const latestSpeech = (Object.values(speech).filter(Boolean) as Speech[]).sort((a, b) => b.at - a.at)[0];
  const activeFight = useOfficeFight(state, fights);
  const displayFights = activeFight ? [activeFight] : [];
  const pnl = officePnl(state);

  const positions = useMemo(() => {
    const out = {} as Record<AgentId, { x: number; y: number }>;
    for (const id of AGENT_ORDER) {
      const desk = WORKSTATIONS[id];
      // at the desk they stand beside it, on the side that faces the room
      out[id] = inDebate ? { ...SEATS[id] } : { x: desk.x + (desk.x <= 50 ? 7.8 : -7.8), y: desk.y + 5.5 };
    }
    if (inDebate && activeFight) {
      for (const id of AGENT_ORDER) out[id] = { ...SPECTATORS[id] };
      out[activeFight.from] = FIGHT_STAGE.from;
      out[activeFight.to] = FIGHT_STAGE.to;
    }
    for (const id of AGENT_ORDER) if ((!inDebate || (!activeFight && activities[id].partner)) && activities[id].destination) out[id] = activities[id].destination!;
    return out;
  }, [state.agents, inDebate, activeFight, activities]);

  return (
    <div className={`office office-v2 ${inDebate ? 'is-debating' : ''} ${displayFights.length ? 'is-brawling' : ''}`} style={{ ['--heat' as string]: heat }}>
      <output className="office-pnl" aria-label={`Open PnL, ${pnl.source}`} title="Unrealized PnL of open positions in USDT. Local estimates are not confirmed exchange results.">
        <span>Open PnL</span>
        <strong className={pnl.value == null ? '' : pnl.value >= 0 ? 'up' : 'down'}>{pnl.value == null ? 'Unavailable' : `${pnl.value >= 0 ? '+' : ''}${fmt(pnl.value)}`} <small>USDT</small></strong>
        {pnl.source.includes('stale') && <small>Stale data</small>}
      </output>
      <div className="office-hud">{children}</div>
      <div className="office-world">
      <div className="studio-room" aria-hidden="true">
        <div className="studio-wall" />
        <div className="studio-floor" />
        <div className="studio-window window-west"><img src={asset('023_keyboard_window-1')} alt="" /><span /></div>
        <div className="studio-window window-east"><img src={asset('023_keyboard_window-1')} alt="" /><span /></div>
        <div className="studio-sign"><img src="/mpu-gandring-logo.webp" alt="" /></div>
        <div className="studio-library">
          <img className="studio-shelf" src={asset('011_red-books_wooden-bookshelf-1')} alt="" />
          {[0, 1, 2].map((row) => <div className={`studio-books books-${row}`} key={row}>{Array.from({ length: 7 }, (_, i) => <img key={i} src={asset('011_red-books_1')} alt="" style={{ filter: `hue-rotate(${(i * 43 + row * 17) % 180}deg)`, height: `${74 + (i * 7 % 25)}%` }} />)}</div>)}
        </div>
        <div className="studio-coffee"><img src={asset('023_keyboard_office-desk-7')} alt="" /><img className="coffee-machine" src={asset('051_red-mug_espresso-machine')} alt="" /><img className="coffee-cup" src={asset('012_coffee-cup')} alt="" /><span>the coffee corner</span></div>
        <img className="studio-vine vine-west" src={asset('023_keyboard_hanging-plant')} alt="" />
        <img className="studio-vine vine-east" src={asset('023_keyboard_hanging-plant')} alt="" />
        <div className="studio-pendant"><i /><span /></div>
        <div className="studio-sunlight" />
        <div className="studio-rug"><span /></div>
        <img className="studio-lamp lamp-west" src={asset('023_keyboard_floor-lamp-1')} alt="" />
        <img className="studio-lamp lamp-east" src={asset('023_keyboard_floor-lamp-1')} alt="" />
        <img className="studio-plant plant-west" src={asset('019_soil_potted-plant')} alt="" />
        <img className="studio-plant plant-east" src={asset('022_soil_potted-plant')} alt="" />
        <div className="studio-wall-board"><span>{t('analysisBoardText')}</span><svg viewBox="0 0 90 30"><path d="M4 23 L18 16 L31 20 L44 8 L57 13 L70 6 L85 9" fill="none" stroke="currentColor" strokeWidth="2" /></svg></div>
      </div>
      <div className="studio-meeting" style={{ left: '50%', top: '72%' }} aria-label="Agent discussion table">
        <img src={asset('023_keyboard_round-coffee-table')} alt="" />
        <div className="studio-table-inlay"><KerisBlade size={60} /></div>
        <img className="meeting-cup cup-left" src={asset('012_coffee-cup')} alt="" />
        <img className="meeting-cup cup-right" src={asset('001_ceramic-mug')} alt="" />
        <img className="meeting-book" src={asset('030_closed-book')} alt="" />
        <img className="meeting-plant" src={asset('012_coffee-cup_potted-plant')} alt="" />
      </div>

      {AGENT_ORDER.map((id) => {
        const a = state.agents[id];
        const desk = WORKSTATIONS[id];
        const busy = !inDebate && a.status !== 'idle';
        return (
          <div key={`desk-${id}`} data-desk={id} className={`studio-desk ${busy ? 'is-busy' : ''}`} style={{ left: `${desk.x}%`, top: `${desk.y}%`, zIndex: Math.round(desk.y * 10) + 5, ['--agent' as string]: a.color }} aria-hidden="true">
            <div className="studio-chair" />
            <img className="studio-desk-wood" src={asset('023_keyboard_computer-desk-5')} alt="" />
            <div className="studio-monitor"><img src={asset('023_keyboard_computer-monitor-1')} alt="" /><div className="studio-screen"><Sparkline values={spark} up={up} /></div></div>
            <img className="studio-keyboard" src={asset('004_keyboard')} alt="" />
            <img className="studio-mug" src={asset('001_ceramic-mug')} alt="" />
            {(id === 'lead' || id === 'research') && <img className="studio-notebook" src={asset('030_closed-book')} alt="" />}
            <span className="studio-desk-name">{DESK_LABEL[id]}</span>
          </div>
        );
      })}

      {AGENT_ORDER.map((id) => {
        const f = activeFight && (activeFight.from === id || activeFight.to === id) ? activeFight : undefined;
        return <Agent key={id} a={state.agents[id]} pos={positions[id]} activity={activities[id]} desks={AGENT_ORDER.map((id) => WORKSTATIONS[id])} sp={latestSpeech?.agent === id ? latestSpeech : undefined} fight={f} reaction={reactions[id]} inDebate={inDebate} selected={selected === id} activeFight={activeFight} onSelect={() => onSelect(id)} />;
      })}


      {displayFights.map((f) => {
        const to = FIGHT_STAGE.to, from = FIGHT_STAGE.from;
        const cx = (from.x + to.x) / 2;
        const cy = to.y - 12;
        const word1 = POW_WORDS[Math.abs(f.id) % POW_WORDS.length];
        const word2 = POW_WORDS[(Math.abs(f.id) + 3) % POW_WORDS.length];
        return (
          <div key={f.id} className="brawl-zone" style={{ left: `${cx}%`, top: `${cy}%`, ['--i' as string]: f.intensity }}>
            <div className="brawl-art">
            <div className="brawl-dust-cloud" aria-hidden="true">
              <i className="smoke-puff p1" />
              <i className="smoke-puff p2" />
              <i className="smoke-puff p3" />
              <i className="smoke-puff p4" />
              <i className="smoke-puff p5" />
              <i className="smoke-puff p6" />
              <i className="smoke-swirl s1" />
              <i className="smoke-swirl s2" />
              {Array.from({ length: 8 }, (_, idx) => (
                <svg key={idx} className={`brawl-limb l-${idx + 1}`} viewBox="0 0 24 24"><path d="m12 1 3 7 8 4-8 3-3 8-3-8-8-3 8-4z" fill="currentColor" /></svg>
              ))}
            </div>
            <div className="pow pow-main">
              <span>{word1}</span>
            </div>
            <div className="pow pow-sub">
              <span>{word2}</span>
            </div>
            </div>
          </div>
        );
      })}

      <OfficeDiscussion state={state} latest={latestSpeech} onSelect={onSelect} />
      </div>
    </div>
  );
}
