// Setup wizard in the office. Mirrors `npm run setup` step by step and uses the same backend module (server/setup/*).
// Keys are typed into masked inputs and go straight to the local .env (chmod 600) through a localhost-only route.
// Nothing is echoed back. The kill switch is released only in a terminal (the command is shown, not run).
import { useEffect, useRef, useState } from 'react';
import type { DeskState } from '../types';
import { WalletPanel } from './Wallet';
import { ChannelsSetup } from './Channels';
import { ModelsSetup } from './ModelsSetup';
import { PreferencesSetup } from './PreferencesSetup';
import { LocalAgentsSetup } from './LocalAgentsSetup';
import { TradingSetup } from './TradingSetup';

interface Link { label: string; url: string; login?: boolean; note?: string }
interface Step { id: string; title: string; text: string; links: Link[] }
interface Field { name: string; label: string; secret: boolean; placeholder: string }
interface VenueRow { venue: string; label: string; kind: string; status: string; connectWallet: boolean; login: string; extra: string | null }
interface SetupInfo { ok: boolean; error?: string; linksCheckedOn: string; modes: { mode: DeskState['mode']; info: string }[]; liveConfirmPhrase: string; keyEntry: { available: boolean; reason: string }; running: { mode: string; appMode: string }; status: { tradingMode: DeskState['mode']; exchange: string; venues: { network: string; fields: { name: string; set: boolean; shown: string | null }[] }[]; forbidden: string[] }; unkill: string; venues: VenueRow[] }
interface Guide { note: string | null; steps: Step[]; fields: Field[]; connectWallet: boolean; docs: Link[] }
interface DoctorLine { ok: boolean | null; label: string; detail: string }

type SetupTab = 'desk' | 'trading' | 'models' | 'local' | 'exchange' | 'channels';

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

export function SetupWizard({ state, onClose, tradingProfile }: { state: DeskState; onClose: () => void; tradingProfile?: 'default' | 'manual' }) {
  const [activeTab, setActiveTab] = useState<SetupTab>(tradingProfile ? 'trading' : 'desk');
  useEffect(() => { if (tradingProfile) setActiveTab('trading'); }, [tradingProfile]);
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [venue, setVenue] = useState('');
  const [network, setNetwork] = useState<'testnet' | 'mainnet'>(state.mode === 'LIVE' ? 'mainnet' : 'testnet');
  const [guide, setGuide] = useState<Guide | null>(null);
  const [at, setAt] = useState(0);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [doc, setDoc] = useState<DoctorLine[] | null>(null);
  const [mode, setMode] = useState(state.mode);
  const [confirm, setConfirm] = useState('');
  const [editingExchange, setEditingExchange] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => previous?.focus();
  }, []);
  useEffect(() => { if (info) dialog.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [!!info]);

  const load = () => fetch('/api/setup').then((r) => r.json()).then((d: SetupInfo) => { setInfo(d); if (d.ok) setVenue((v) => v || (d.status.exchange !== 'none' ? d.status.exchange : 'bybit')); }).catch(() => setInfo({ ok: false, error: 'office backend not reachable' } as SetupInfo));
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (!venue) return; setAt(0); setVals({}); setMsg(null); fetch(`/api/setup/guide/${venue}?network=${network}`).then((r) => r.json()).then((g) => setGuide(Array.isArray(g?.steps) ? g : null)).catch(() => setGuide(null)); }, [venue, network]);

  if (!info) return <div className="setup-overlay"><div className="panel setup setup-tabbed" role="dialog" aria-modal="true" aria-label="Setup"><div className="panel-head"><h2>Setup</h2><button onClick={onClose}>Close</button></div><p role="status">Loading saved setup…</p></div></div>;
  if (!info.ok) return <div className="setup-overlay"><div className="panel setup setup-tabbed"><div className="panel-head"><h2>Setup</h2><button onClick={onClose}>Close</button></div><p className="wallet-msg bad">{info.error === 'slow down' ? 'Too many requests for a moment. Close and open Setup again in a minute.' : info.error ?? 'Setup is not available here.'}</p><p>Same setup in a terminal: <code>npm run setup</code></p></div></div>;
  const v = info.venues.find((x) => x.venue === venue);
  const steps = guide?.steps ?? [];
  const cur = steps[at];
  function restoreExchange() {
    setVenue(info!.status.exchange !== 'none' ? info!.status.exchange : 'bybit');
    setMode(info!.status.tradingMode); setNetwork(info!.status.tradingMode === 'LIVE' ? 'mainnet' : 'testnet');
    setVals({}); setConfirm(''); setMsg(null); setAt(0);
  }

  async function saveKeys() {
    if (!guide) return;
    const [k, s, t] = guide.fields.map((f) => vals[f.name] ?? '');
    setBusy(true); setMsg(null);
    const r = await post('/api/setup/keys', { venue, network, key: k, secret: s, ...(guide.fields[2] ? { third: t } : {}) }).catch(() => ({ ok: false, detail: 'office not reachable' }));
    setVals({}); // never keep secrets in the page after sending
    setBusy(false); setMsg({ ok: r.ok, text: `${r.detail ?? r.error ?? ''}${r.warning ? ` ${r.warning}` : ''}` });
    if (r.ok) {
      try {
        localStorage.setItem('mg-wallet-venue', venue);
        localStorage.setItem('mg-wallet-network', network);
      } catch { /* ignore */ }
      window.dispatchEvent(new Event('mg-wallet-updated'));
    }
    void load();
  }
  async function runDoctor() { setBusy(true); const r = await post('/api/setup/doctor', {}).catch(() => null); setBusy(false); setDoc(r?.lines ?? [{ ok: false, label: 'doctor', detail: r?.error ?? 'failed' }]); }
  async function saveMode() {
    setBusy(true);
    const conf = mode === 'LIVE' ? confirm : '';
    const r = await post('/api/setup/mode', { mode, ...(mode === 'LIVE' ? { confirm: conf } : {}) }).catch(() => ({ ok: false, detail: 'office not reachable' }));
    setBusy(false);
    setConfirm('');
    setMsg({ ok: r.ok, text: r.detail });
    void load();
  }

  return (
    <div ref={dialog} className="setup-overlay" role="dialog" aria-modal="true" aria-label="Setup" onKeyDown={(e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')].filter((el) => el.getClientRects().length > 0);
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="panel setup setup-tabbed">
        <div className="panel-head">
          <div className="brand">
            <img src="/mpu-gandring-logo.webp" alt="Mpu Gandring" width={54} height={34} />
            <h2>Setup</h2>
          </div>
          <span className="badge">Saved setup · Edit when needed</span>
          <button onClick={onClose}>Close</button>
        </div>

        <div className="setup-body">
          <nav className="setup-sidebar" aria-label="Setup Sections">
            <button type="button" className={`setup-tab-btn ${activeTab === 'trading' ? 'active' : ''}`} onClick={() => setActiveTab('trading')}><span>Trading & Risk</span></button>
            <button
              type="button"
              className={`setup-tab-btn ${activeTab === 'desk' ? 'active' : ''}`}
              onClick={() => setActiveTab('desk')}
            >
              <span>Desk Settings</span>
            </button>
            <button
              type="button"
              className={`setup-tab-btn ${activeTab === 'models' ? 'active' : ''}`}
              onClick={() => setActiveTab('models')}
            >
              <span>Models & Providers</span>
            </button>
            <button
              type="button"
              className={`setup-tab-btn ${activeTab === 'local' ? 'active' : ''}`}
              onClick={() => setActiveTab('local')}
            >
              <span>Local CLI Agents</span>
            </button>
            <button
              type="button"
              className={`setup-tab-btn ${activeTab === 'exchange' ? 'active' : ''}`}
              onClick={() => setActiveTab('exchange')}
            >
              <span>Exchange & Safety</span>
            </button>
            <button
              type="button"
              className={`setup-tab-btn ${activeTab === 'channels' ? 'active' : ''}`}
              onClick={() => setActiveTab('channels')}
            >
              <span>Chat Channels</span>
            </button>
          </nav>

          <main className="setup-content"><div className="setup-guide-note">Your setup is retained. Review saved settings below, then Edit the section you want to change. New here? Choose agents, verify the venue, review allocation, then enable Auto Trade.</div>
            <section className="setup-pane" hidden={activeTab !== 'trading'}><div className="pane-header"><h3>Trading & Risk</h3><p className="wallet-note">Separate testnet and mainnet profiles. Review defaults or edit your manual settings.</p></div><TradingSetup state={state} initialProfile={tradingProfile} /></section>
            <section className="setup-pane" hidden={activeTab !== 'desk'}>
                <div className="pane-header">
                  <h3>Desk Settings</h3>
                  <p className="wallet-note">Running: <b>{info.running.mode}</b> · {info.running.appMode}. Saved mode: {info.status.tradingMode} · venue: {info.status.exchange}. Saving a section does not apply it to the running desk.</p>
                </div>
                {info.status.forbidden.length > 0 && <p className="wallet-msg bad">Remove {info.status.forbidden.join(', ')} from your environment. Main wallet keys and seed phrases are never used.</p>}
                {state.killed && <p className="wallet-msg bad">Kill switch is ON. Release it only in a terminal on this computer: <code>{info.unkill}</code>, then restart.</p>}
                <PreferencesSetup />
              </section>

            <section className="setup-pane" hidden={activeTab !== 'models'}>
                <div className="pane-header">
                  <h3>Model Providers and Models</h3>
                  <p className="wallet-note">10 providers with 20 AI models each.</p>
                </div>
                <ModelsSetup available={info.keyEntry.available} appMode={info.running.appMode} />
              </section>

            <section className="setup-pane" hidden={activeTab !== 'local'}>
                <div className="pane-header">
                  <h3>Local CLI Agents</h3>
                  <p className="wallet-note">Local coding CLI agents detected on your computer.</p>
                </div>
                <LocalAgentsSetup available={info.keyEntry.available} />
              </section>

            <section className="setup-pane" hidden={activeTab !== 'exchange'}>
                <div className="pane-header">
                  <h3>Exchange, Trading Mode and Safety Checks</h3>
                  <p className="wallet-note">Running now: <b>{info.running.mode}</b> in {info.running.appMode} mode.</p>
                </div>

                <div className="setup-section-actions"><p className="wallet-note">Saved: <b>{info.status.tradingMode}</b> · {info.status.exchange}. Existing credentials do not need to be entered again.</p>{!editingExchange && <button onClick={() => { restoreExchange(); setEditingExchange(true); }}>Edit exchange setup</button>}</div>
                {!editingExchange && <><dl className="setup-summary">{info.status.venues.map((n) => <div key={n.network}><dt>{n.network}</dt><dd>{n.fields.map((f) => `${f.name}: ${f.set ? 'saved' : 'not set'}`).join(' · ')}</dd></div>)}</dl><button disabled={busy} onClick={runDoctor}>Run doctor</button></>}
                <div hidden={!editingExchange}>
                <details className="setup-reference"><summary>Mode guide</summary>
                <h4>1. Mode</h4>
                <ol className="wallet-steps">{info.modes.map((m) => <li key={m.mode}><b>{m.mode}</b>: {m.info}</li>)}</ol>
                </details>

                <h4>2. Venue and network</h4>
                <div className="wallet-pick">
                  <select value={venue} onChange={(e) => setVenue(e.target.value)} aria-label="venue">
                    <optgroup label="CEX">{info.venues.filter((x) => x.kind === 'CEX').map((x) => <option key={x.venue} value={x.venue}>{x.label}</option>)}</optgroup>
                    <optgroup label="DEX">{info.venues.filter((x) => x.kind === 'DEX').map((x) => <option key={x.venue} value={x.venue}>{x.label}</option>)}</optgroup>
                  </select>
                  <div className="seg" role="group" aria-label="network">{(['testnet', 'mainnet'] as const).map((n) => <button key={n} className={network === n ? 'on' : ''} onClick={() => setNetwork(n)}>{n}</button>)}</div>
                </div>
                {v && <p className="wallet-note">{v.login}{v.extra ? ` ${v.extra}` : ''}</p>}
                {guide?.note && <p className="wallet-note">{guide.note}</p>}

                <details className="setup-reference"><summary>Connection guide · only needed for a new venue or key</summary>
                <h4>Step {steps.length ? at + 1 : 0} of {steps.length}{cur ? `: ${cur.title}` : ''}</h4>
                {cur && <div className="setup-step"><p>{cur.text}</p><ul>{cur.links.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer">{l.label}</a>{l.login ? ' · sign in or connect wallet first' : ''}{l.note ? ` · ${l.note}` : ''}</li>)}</ul></div>}
                <div className="setup-nav"><button disabled={at === 0} onClick={() => setAt(at - 1)}>Back</button><button disabled={at >= steps.length - 1} onClick={() => setAt(at + 1)}>Next step</button></div>
                </details>

                <details className="setup-reference"><summary>Replace or add trade-only credentials</summary>
                <p className="field-help">Saved credentials stay in place. Open this section only to replace them or connect a new venue. Secret fields are intentionally empty.</p>
                {info.keyEntry.available && guide ? (
                  <form className="setup-keys" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void saveKeys(); }}>
                    {guide.fields.map((f) => <label key={f.name}><span>{f.label} <code>{f.name}</code></span><input type={f.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} placeholder={f.placeholder} value={vals[f.name] ?? ''} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} /></label>)}
                    <button disabled={busy} type="submit">{busy ? 'Checking on the venue...' : 'Check and save'}</button>
                    <p className="wallet-note small">Refused: seed phrases, main wallet keys, keys that can withdraw. Never paste a key into a chat.</p>
                  </form>
                ) : <p className="wallet-note">Key entry is off here: {info.keyEntry.reason}</p>}
                {guide?.connectWallet && <WalletPanel state={state} />}
                {info.status.venues.map((n) => <p key={n.network} className="wallet-note small">{n.network}: {n.fields.map((f) => `${f.name} ${f.set ? (f.shown ?? 'set') : 'empty'}`).join(', ')}</p>)}
                </details>

                <h4>5. Verify</h4>
                <button disabled={busy} onClick={runDoctor}>Run doctor</button> <span className="wallet-note small">same as <code>npm run doctor</code></span>

                <h4>6. Switch mode</h4>
                <div className="setup-nav">
                  <select
                    value={mode}
                    onChange={(e) => {
                      const next = info.modes.find((m) => m.mode === e.target.value)?.mode; if (!next) return;
                      setMode(next);
                      setConfirm('');
                    }}
                    aria-label="mode"
                  >
                    {info.modes.map((m) => <option key={m.mode}>{m.mode}</option>)}
                  </select>
                  {mode === 'LIVE' && (
                    <label className="field-help">LIVE trades real money automatically. Type “{info.liveConfirmPhrase}” to change mode.<input aria-label="LIVE confirmation" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
                  )}
                  <button
                    disabled={busy || !info.keyEntry.available || mode === 'LIVE' && confirm !== info.liveConfirmPhrase}
                    onClick={saveMode}
                  >
                    {mode === 'LIVE' ? 'Confirm & Switch to LIVE' : 'Save mode'}
                  </button>
                </div>
                <p className="wallet-note small">TESTNET and LIVE are verified on the exchange: trade on, withdraw off. Restart the office afterwards.</p>
                <button disabled={busy} onClick={() => { restoreExchange(); setEditingExchange(false); }}>Done editing exchange</button>
                </div>
                {doc && <ul className="setup-doctor">{doc.map((l, i) => <li key={i} className={l.ok === true ? 'ok' : l.ok === false ? 'bad' : ''}>{l.ok === true ? 'OK' : l.ok === false ? 'FAIL' : '--'} {l.label}: {l.detail}</li>)}</ul>}
                {msg && <p className={`wallet-msg ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</p>}
              </section>

            <section className="setup-pane" hidden={activeTab !== 'channels'}>
                <div className="pane-header">
                  <h3>Chat Channel and Desk Lead: optional</h3>
                  <p className="wallet-note">Connect Telegram, Discord, Slack or WhatsApp for automated trade updates and reports.</p>
                </div>
                <ChannelsSetup />
              </section>
          </main>
        </div>

        <p className="wallet-note small" style={{ marginTop: '12px' }}>Links checked {info.linksCheckedOn}. Full guides: docs/setup/. Not financial advice.</p>
      </div>
    </div>
  );
}

