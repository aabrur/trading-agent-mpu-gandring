import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AgentId, AgentView, DeskState, Fight, Reaction, Speech } from '../types';
import { AGENT_ORDER } from '../types';
import { Bot, type Face, type Pose } from './Bot';
import { Sparkline } from './MiniCharts';
import { WORKSTATIONS, FIGHT_STAGE, officePositions, heatedDebateFight, officePnl, route, type Activity, type Point, type SceneEvent } from '../sceneDirector';
import { useSceneDirector } from '../useSceneDirector';
import { DESK_SETS } from '../officeSets';
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
  const recent = fights.at(-1);
  return recent && clock.now >= recent.at && clock.now - recent.at < 2400 ? recent : heatedDebateFight(state, clock.now) ?? undefined;
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
    const changingStage = staged || wasStaged.current;
    wasStaged.current = staged;
    if (from.x === pos.x && from.y === pos.y) { el.style.transform = `translate(${pos.x}%, ${pos.y}%)`; return; }
    const path = changingStage ? [from, pos] : route(from, pos, desks);
    const target = path.at(-1)!;
    previous.current = target;
    const distance = path.slice(1).reduce((d, p, i) => d + Math.hypot(p.x - path[i].x, p.y - path[i].y), 0);
    const duration = media.matches || document.hidden ? 0 : changingStage ? 400 : Math.max(600, distance * 65);
    setWalk({ on: duration > 0 && path.length > 1 && !staged, left: target.x < from.x });
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
  const label = walk.on ? 'walking' : fight ? 'cartoon sparring' : activeFight ? 'watching the debate' : activity.label;
  return (
    <div ref={anchor} className="agent-anchor" data-agent={a.id} style={{ zIndex: Math.round(pos.y * 10) + 100 }}>
    <button
      className={`agent status-${a.status} ${selected ? 'is-selected' : ''} ${isPunching ? 'is-punching' : ''} ${isHit ? 'is-hit' : ''} ${(isPunching || isHit) ? 'in-dust-brawl' : ''} ${!inDebate && pose === 'idle' ? 'at-desk' : ''} ${pos.y < 48 ? 'bubble-below' : ''} ${pos.x < 25 ? 'bubble-left' : pos.x > 75 ? 'bubble-right' : ''}`}
      style={{ zIndex: Math.round(pos.y * 10) + (sp ? 400 : 0) + (isPunching || isHit ? 250 : 0), ['--agent' as string]: a.color }}
      onClick={onSelect}
      aria-label={`${a.name}, ${label}`} data-activity={pose}
    >
      {a.status === 'thinking' && !sp && <div className="think"><i /><i /><i /></div>}
      <div className={`bot-wrap ${flip ? 'flip' : ''}`}><Bot id={a.id} size={62} pose={pose} face={face} talking={talking} /></div>
      <div className="nametag">
        <strong>{a.name}</strong>
        <span className="status"><i className="dot" />{label}</span>
        {a.stance && inDebate && <span className={`stance s-${a.stance}`}>{a.stance}{a.confidence != null ? ` ${Math.round(a.confidence * 100)}%` : ''}</span>}
      </div>
    </button>
    </div>
  );
}

export function Office({ state, sceneEvents, speech, fights, reactions, disagreement, selected, spark, onSelect, children }: Props) {
  const { t } = useI18n();
  const officeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const office = officeRef.current;
    const stage = office?.parentElement;
    const roster = stage?.querySelector<HTMLElement>('.desk-team');
    if (!office || !stage || !roster) return;
    const fit = () => {
      const top = office.getBoundingClientRect().top + window.scrollY;
      const gap = parseFloat(getComputedStyle(stage).rowGap) || 0;
      const height = window.innerHeight - top - roster.offsetHeight - gap - 16;
      office.style.setProperty('--office-fit-height', `${Math.max(180, height)}px`);
    };
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    observer.observe(roster);
    const header = document.querySelector('.topbar');
    if (header) observer.observe(header);
    window.addEventListener('resize', fit);
    fit();
    return () => { observer.disconnect(); window.removeEventListener('resize', fit); };
  }, []);
  const activities = useSceneDirector(state, sceneEvents);
  const inDebate = !!state.debate;
  const atTable = inDebate && !['reading', 'opening', 'done'].includes(state.debate!.phase);
  const heat = Math.min(1, disagreement);
  const up = spark.length > 1 && spark.at(-1)! >= spark[0];
  const latestSpeech = (Object.values(speech).filter(Boolean) as Speech[]).sort((a, b) => b.at - a.at)[0];
  const activeFight = useOfficeFight(state, fights);
  const displayFights = activeFight ? [activeFight] : [];
  const pnl = officePnl(state);

  const positions = officePositions(state, activities, activeFight);

  return (
    <div ref={officeRef} className={`office office-v2 ${inDebate ? 'is-debating' : ''} ${displayFights.length ? 'is-brawling' : ''}`} style={{ ['--heat' as string]: heat }}>
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
        <div className="studio-window window-west"><img src={asset('mg_prop_window_frame')} alt="" /><span /></div>
        <div className="studio-window window-east"><img src={asset('mg_prop_window_frame')} alt="" /><span /></div>
        <div className="studio-sign"><img src="/mpu-gandring-logo.webp" alt="" /></div>
        <div className="studio-library"><img className="studio-shelf" src={asset('mg_prop_bookshelf')} alt="" /></div>
        <div className="studio-coffee"><img src={asset('mg_prop_coffee_counter')} alt="" /><img className="coffee-cup" src={asset('mg_item_coffee_mug_dustyblue')} alt="" /></div>
        <img className="studio-vine vine-west" src={asset('mg_prop_plant_hanging')} alt="" />
        <img className="studio-vine vine-east" src={asset('mg_prop_plant_hanging')} alt="" />
        <img className="studio-pendant" src={asset('mg_env_pendant_lamp')} alt="" />
        <div className="studio-sunlight" />
        <div className="studio-rug"><img src={asset('mg_prop_office_rug')} alt="" /></div>
        <img className="studio-lamp lamp-west" src={asset('mg_prop_floor_lamp')} alt="" />
        <img className="studio-lamp lamp-east" src={asset('mg_prop_floor_lamp')} alt="" />
        <img className="studio-plant plant-west" src={asset('mg_prop_plant_floor')} alt="" />
        <img className="studio-plant plant-east" src={asset('mg_prop_plant_desktop')} alt="" />
        <div className="studio-wall-board"><img src={asset('mg_prop_whiteboard')} alt="" /><div><span>{t('analysisBoardText')}</span>{spark.length > 1 ? <Sparkline values={spark} up={up} /> : <img className="board-reference" src={asset('mg_icon_trend_analysis')} alt="" />}<i /><i /></div></div>
      </div>
      <div className="studio-meeting" style={{ left: '50%', top: '65%' }} aria-label="Agent discussion table">
        <img src={asset('mg_prop_debate_table')} alt="" />
        <div className="studio-table-inlay"><img src={asset('mg_item_keris_ornament')} alt="" /></div>
        <img className="meeting-cup cup-left" src={asset('mg_item_coffee_mug_sage')} alt="" />
        <img className="meeting-cup cup-right" src={asset('mg_item_coffee_mug_terracotta')} alt="" />
        <img className="meeting-book" src={asset('mg_item_strategy_notebook')} alt="" />
        <img className="meeting-plant" src={asset('mg_prop_plant_succulent')} alt="" />
      </div>

      {AGENT_ORDER.map((id) => {
        const a = state.agents[id];
        const desk = WORKSTATIONS[id];
        const busy = !atTable && a.status !== 'idle';
        const set = DESK_SETS[id];
        return (
          <div key={`desk-${id}`} data-desk={id} className={`studio-desk ${desk.x > 50 ? 'desk-east' : 'desk-west'} ${busy ? 'is-busy' : ''}`} style={{ left: `${desk.x}%`, top: `${desk.y}%`, zIndex: Math.round(desk.y * 10) + 5, width: `${set.width ?? 17}%`, ['--agent' as string]: a.color }} aria-hidden="true">
            <div className="studio-chair" />
            <img className="studio-desk-wood" src={asset(set.base)} alt="" />
            {set.monitor && <div className="studio-monitor" style={{ left: `${set.monitor.x}%`, top: `${set.monitor.y}%`, width: `${set.monitor.width}%` }}><img src={asset('mg_item_market_tablet')} alt="" />{spark.length > 1 && <div className="studio-screen"><Sparkline values={spark} up={up} /></div>}</div>}
            {set.props.map((prop) => <img key={prop.asset} className="studio-desk-prop" src={asset(prop.asset)} alt="" style={{ left: `${prop.x}%`, top: `${prop.y}%`, width: `${prop.width}%` }} />)}
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
              <img className="combat-cloud cloud-main" src={asset('mg_fx_fight_smoke_soft')} alt="" />
              <img className="combat-cloud cloud-roll" src={asset('mg_fx_fight_smoke_brawl')} alt="" />
              <img className="combat-impact impact-left" src={asset('mg_fx_thinking_sparkles')} alt="" />
              <img className="combat-impact impact-right" src={asset('mg_fx_execution_flash')} alt="" />
              {Array.from({ length: 8 }, (_, idx) => (
                <img key={idx} className={`brawl-limb l-${idx + 1}`} src={asset('mg_fx_thinking_sparkles')} alt="" />
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
