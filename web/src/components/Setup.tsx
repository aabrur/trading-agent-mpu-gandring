// Setup wizard in the office. Mirrors `npm run setup` step by step and uses the same backend module (server/setup/*).
// Keys are typed into masked inputs and go straight to the local .env (chmod 600) through a localhost-only route.
// Nothing is echoed back. The kill switch is released only in a terminal (the command is shown, not run).
import { useEffect, useState } from 'react';
import type { DeskState } from '../types';
import { WalletPanel } from './Wallet';
import { ChannelsSetup } from './Channels';
import { ModelsSetup } from './ModelsSetup';
import { PreferencesSetup } from './PreferencesSetup';
import { LocalAgentsSetup } from './LocalAgentsSetup';

interface Link { label: string; url: string; login?: boolean; note?: string }
interface Step { id: string; title: string; text: string; links: Link[] }
interface Field { name: string; label: string; secret: boolean; placeholder: string }
interface VenueRow { venue: string; label: string; kind: string; status: string; connectWallet: boolean; login: string; extra: string | null }
interface SetupInfo { ok: boolean; error?: string; linksCheckedOn: string; modes: { mode: string; info: string }[]; liveConfirmPhrase: string; keyEntry: { available: boolean; reason: string }; running: { mode: string; appMode: string }; status: { tradingMode: string; exchange: string; venues: { network: string; fields: { name: string; set: boolean; shown: string | null }[] }[]; forbidden: string[] }; unkill: string; venues: VenueRow[] }
interface Guide { note: string | null; steps: Step[]; fields: Field[]; connectWallet: boolean; docs: Link[] }
interface DoctorLine { ok: boolean | null; label: string; detail: string }

type SetupTab = 'desk' | 'models' | 'local' | 'exchange' | 'channels';

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

export function SetupWizard({ state, onClose }: { state: DeskState; onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<SetupTab>('desk');
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [venue, setVenue] = useState('');
  const [network, setNetwork] = useState<'testnet' | 'mainnet'>('testnet');
  const [guide, setGuide] = useState<Guide | null>(null);
  const [at, setAt] = useState(0);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [doc, setDoc] = useState<DoctorLine[] | null>(null);
  const [mode, setMode] = useState('PAPER');
  const [confirm, setConfirm] = useState('');

  const load = () => fetch('/api/setup').then((r) => r.json()).then((d: SetupInfo) => { setInfo(d); if (d.ok) setVenue((v) => v || (d.status.exchange !== 'none' ? d.status.exchange : 'bybit')); }).catch(() => setInfo({ ok: false, error: 'office backend not reachable' } as SetupInfo));
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (!venue) return; setAt(0); setVals({}); setMsg(null); fetch(`/api/setup/guide/${venue}?network=${network}`).then((r) => r.json()).then((g) => setGuide(Array.isArray(g?.steps) ? g : null)).catch(() => setGuide(null)); }, [venue, network]);

  if (!info) return null;
  if (!info.ok) return <div className="setup-overlay"><div className="panel setup"><div className="panel-head"><h2>Setup</h2><button onClick={onClose}>Close</button></div><p className="wallet-msg bad">{info.error === 'slow down' ? 'Too many requests for a moment. Close and open Setup again in a minute.' : info.error ?? 'Setup is not available here.'}</p><p>Same setup in a terminal: <code>npm run setup</code></p></div></div>;
  const v = info.venues.find((x) => x.venue === venue);
  const steps = guide?.steps ?? [];
  const cur = steps[at];

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
  async function saveMode() { setBusy(true); const r = await post('/api/setup/mode', { mode, ...(mode === 'LIVE' ? { confirm } : {}) }).catch(() => ({ ok: false, detail: 'office not reachable' })); setBusy(false); setConfirm(''); setMsg({ ok: r.ok, text: r.detail }); void load(); }

  return (
    <div className="setup-overlay" role="dialog" aria-label="Setup">
      <div className="panel setup setup-tabbed">
        <div className="panel-head">
          <div className="brand">
            <img src="/mpu-gandring-logo.webp" alt="Mpu Gandring" width={54} height={34} />
            <h2>Setup</h2>
          </div>
          <span className="badge">same as npm run setup</span>
          <button onClick={onClose}>Close</button>
        </div>

        <div className="setup-body">
          <nav className="setup-sidebar" aria-label="Setup Sections">
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

          <main className="setup-content">
            {activeTab === 'desk' && (
              <section className="setup-pane">
                <div className="pane-header">
                  <h3>Desk Settings</h3>
                  <p className="wallet-note">Running now: <b>{info.running.mode}</b> in {info.running.appMode} mode. Saved in .env: TRADING_MODE {info.status.tradingMode}, EXCHANGE {info.status.exchange}.</p>
                </div>
                {info.status.forbidden.length > 0 && <p className="wallet-msg bad">Remove {info.status.forbidden.join(', ')} from your environment. Main wallet keys and seed phrases are never used.</p>}
                {state.killed && <p className="wallet-msg bad">Kill switch is ON. Release it only in a terminal on this computer: <code>{info.unkill}</code>, then restart.</p>}
                <PreferencesSetup />
              </section>
            )}

            {activeTab === 'models' && (
              <section className="setup-pane">
                <div className="pane-header">
                  <h3>Model Providers and Models</h3>
                  <p className="wallet-note">10 providers with 20 AI models each.</p>
                </div>
                <ModelsSetup available={info.keyEntry.available} appMode={info.running.appMode} />
              </section>
            )}

            {activeTab === 'local' && (
              <section className="setup-pane">
                <div className="pane-header">
                  <h3>Local CLI Agents</h3>
                  <p className="wallet-note">Local coding CLI agents detected on your computer.</p>
                </div>
                <LocalAgentsSetup available={info.keyEntry.available} />
              </section>
            )}

            {activeTab === 'exchange' && (
              <section className="setup-pane">
                <div className="pane-header">
                  <h3>Exchange, Trading Mode and Safety Checks</h3>
                  <p className="wallet-note">Running now: <b>{info.running.mode}</b> in {info.running.appMode} mode.</p>
                </div>

                <h4>1. Mode</h4>
                <ol className="wallet-steps">{info.modes.map((m) => <li key={m.mode}><b>{m.mode}</b>: {m.info}</li>)}</ol>

                <h4>2. Venue and network</h4>
                <div className="wallet-pick">
                  <select value={venue} onChange={(e) => setVenue(e.target.value)} aria-label="venue">
                    <optgroup label="CEX">{info.venues.filter((x) => x.kind === 'CEX').map((x) => <option key={x.venue} value={x.venue}>{x.label}{x.status === 'experimental' ? ' · experimental' : ''}</option>)}</optgroup>
                    <optgroup label="DEX">{info.venues.filter((x) => x.kind === 'DEX').map((x) => <option key={x.venue} value={x.venue}>{x.label} · experimental</option>)}</optgroup>
                  </select>
                  <div className="seg" role="group" aria-label="network">{(['testnet', 'mainnet'] as const).map((n) => <button key={n} className={network === n ? 'on' : ''} onClick={() => setNetwork(n)}>{n}</button>)}</div>
                </div>
                {v && <p className="wallet-note">{v.login}{v.extra ? ` ${v.extra}` : ''}</p>}
                {guide?.note && <p className="wallet-note">{guide.note}</p>}

                <h4>3. Step {steps.length ? at + 1 : 0} of {steps.length}{cur ? `: ${cur.title}` : ''}</h4>
                {cur && <div className="setup-step"><p>{cur.text}</p><ul>{cur.links.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer">{l.label}</a>{l.login ? ' · sign in or connect wallet first' : ''}{l.note ? ` · ${l.note}` : ''}</li>)}</ul></div>}
                <div className="setup-nav"><button disabled={at === 0} onClick={() => setAt(at - 1)}>Back</button><button disabled={at >= steps.length - 1} onClick={() => setAt(at + 1)}>Next step</button></div>

                <h4>4. Enter the keys: masked, saved to .env on this computer</h4>
                {info.keyEntry.available && guide ? (
                  <form className="setup-keys" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void saveKeys(); }}>
                    {guide.fields.map((f) => <label key={f.name}><span>{f.label} <code>{f.name}</code></span><input type={f.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} placeholder={f.placeholder} value={vals[f.name] ?? ''} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} /></label>)}
                    <button disabled={busy} type="submit">{busy ? 'Checking on the venue...' : 'Check and save'}</button>
                    <p className="wallet-note small">Refused: seed phrases, main wallet keys, keys that can withdraw. Never paste a key into a chat.</p>
                  </form>
                ) : <p className="wallet-note">Key entry is off here: {info.keyEntry.reason}</p>}
                {guide?.connectWallet && <WalletPanel state={state} />}
                {info.status.venues.map((n) => <p key={n.network} className="wallet-note small">{n.network}: {n.fields.map((f) => `${f.name} ${f.set ? (f.shown ?? 'set') : 'empty'}`).join(', ')}</p>)}

                <h4>5. Verify</h4>
                <button disabled={busy} onClick={runDoctor}>Run doctor</button> <span className="wallet-note small">same as <code>npm run doctor</code></span>
                {doc && <ul className="setup-doctor">{doc.map((l, i) => <li key={i} className={l.ok === true ? 'ok' : l.ok === false ? 'bad' : ''}>{l.ok === true ? 'OK' : l.ok === false ? 'FAIL' : '--'} {l.label}: {l.detail}</li>)}</ul>}

                <h4>6. Switch mode</h4>
                <div className="setup-nav">
                  <select value={mode} onChange={(e) => setMode(e.target.value)} aria-label="mode">{info.modes.map((m) => <option key={m.mode}>{m.mode}</option>)}</select>
                  {mode === 'LIVE' && <input className="setup-confirm" placeholder={`type: ${info.liveConfirmPhrase}`} value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
                  <button disabled={busy || !info.keyEntry.available || (mode === 'LIVE' && confirm !== info.liveConfirmPhrase)} onClick={saveMode}>Check and save mode</button>
                </div>
                <p className="wallet-note small">TESTNET and LIVE are saved only after the key check passes: trade on, withdraw off. LIVE needs the typed confirmation. Restart the office afterwards.</p>
                {msg && <p className={`wallet-msg ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</p>}
              </section>
            )}

            {activeTab === 'channels' && (
              <section className="setup-pane">
                <div className="pane-header">
                  <h3>Chat Channel and Desk Lead: optional</h3>
                  <p className="wallet-note">Connect Telegram, Discord, Slack or WhatsApp for automated trade updates and reports.</p>
                </div>
                <ChannelsSetup />
              </section>
            )}
          </main>
        </div>

        <p className="wallet-note small" style={{ marginTop: '12px' }}>Links checked {info.linksCheckedOn}. Full guides: docs/setup/. Not financial advice.</p>
      </div>
    </div>
  );
}

