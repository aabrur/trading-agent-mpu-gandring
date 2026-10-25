// Setup wizard in the office. Mirrors `npm run setup` step by step and uses the same backend module (server/setup/*).
// Keys are typed into masked inputs and go straight to the local .env (chmod 600) through a localhost-only route.
// Nothing is echoed back. The kill switch is released only in a terminal (the command is shown, not run).
import { useEffect, useRef, useState } from 'react';
import type { DeskState } from '../types';
import { WalletPanel } from './Wallet';
import { ChannelsSetup } from './Channels';
import { ModelsSetup } from './ModelsSetup';
import { PreferencesSetup } from './PreferencesSetup';
import { DataSourcesSetup } from './DataSourcesSetup';
import { LocalAgentsSetup } from './LocalAgentsSetup';
import { TradingSetup } from './TradingSetup';
import { JevSetup } from './JevSetup';
import { useI18n } from '../i18n';

interface Link { label: string; url: string; login?: boolean; note?: string }
interface Step { id: string; title: string; text: string; links: Link[] }
interface Field { name: string; label: string; secret: boolean; placeholder: string }
interface VenueFieldRow { network: string; fields: { name: string; set: boolean; shown: string | null }[] }
interface VenueRow { venue: string; label: string; kind: string; status: string; connectWallet: boolean; login: string; extra: string | null }
interface SetupInfo {
  ok: boolean;
  error?: string;
  linksCheckedOn: string;
  modes: { mode: DeskState['mode']; info: string }[];
  liveConfirmPhrase: string;
  keyEntry: { available: boolean; reason: string };
  running: { mode: string; appMode: string };
  status: {
    tradingMode: DeskState['mode'];
    exchange: string;
    venues: VenueFieldRow[];
    venuesByExchange?: Record<string, VenueFieldRow[]>;
    forbidden: string[];
  };
  unkill: string;
  venues: VenueRow[];
}
interface Guide { note: string | null; steps: Step[]; fields: Field[]; venues?: VenueFieldRow[]; connectWallet: boolean; docs: Link[] }
interface DoctorLine { ok: boolean | null; label: string; detail: string }

type SetupTab = 'desk' | 'trading' | 'models' | 'local' | 'exchange' | 'channels';

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

export function SetupWizard({ state, onClose, tradingProfile }: { state: DeskState; onClose: () => void; tradingProfile?: 'default' | 'manual' }) {
  const { t, lang } = useI18n();
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

  if (!info) return <div className="setup-overlay"><div className="panel setup setup-tabbed" role="dialog" aria-modal="true" aria-label={t('setupTitle')}><div className="panel-head"><h2>{t('setupTitle')}</h2><button onClick={onClose}>{t('setupCloseBtn')}</button></div><p role="status">{t('setupLoadingMsg')}</p></div></div>;
  if (!info.ok) return <div className="setup-overlay"><div className="panel setup setup-tabbed"><div className="panel-head"><h2>{t('setupTitle')}</h2><button onClick={onClose}>{t('setupCloseBtn')}</button></div><p className="wallet-msg bad">{info.error === 'slow down' ? (lang === 'id' ? 'Terlalu banyak permintaan. Tutup dan buka kembali Pengaturan dalam satu menit.' : 'Too many requests for a moment. Close and open Setup again in a minute.') : info.error ?? (lang === 'id' ? 'Pengaturan tidak tersedia di sini.' : 'Setup is not available here.')}</p><p>{lang === 'id' ? 'Pengaturan yang sama via terminal:' : 'Same setup in a terminal:'} <code>npm run setup</code></p></div></div>;
  const v = info.venues.find((x) => x.venue === venue);
  const activeVenuesStatus = info.status.venuesByExchange?.[venue] ?? guide?.venues ?? info.status.venues;
  const steps = guide?.steps ?? [];
  const cur = steps[at];
  function restoreExchange() {
    setVenue(info!.status.exchange !== 'none' ? info!.status.exchange : 'bybit');
    setMode(info!.status.tradingMode); setNetwork(info!.status.tradingMode === 'LIVE' ? 'mainnet' : 'testnet');
    setVals({}); setConfirm(''); setMsg(null); setAt(0);
  }

  async function selectVenue(nextVenue: string) {
    setVenue(nextVenue);
    setDoc(null);
    const r = await post('/api/setup/venue', { venue: nextVenue }).catch(() => ({ ok: false }));
    if (r?.ok) {
      try {
        localStorage.setItem('mg-wallet-venue', nextVenue);
      } catch { /* ignore */ }
      window.dispatchEvent(new Event('mg-wallet-updated'));
      void load();
    }
  }

  async function saveKeys() {
    if (!guide) return;
    const [k, s, t] = guide.fields.map((f) => vals[f.name] ?? '');
    setBusy(true); setMsg(null);
    const r = await post('/api/setup/keys', { venue, network, key: k, secret: s, ...(guide.fields[2] ? { third: t } : {}) }).catch(() => ({ ok: false, detail: 'office not reachable' }));
    setBusy(false); setMsg({ ok: r.ok, text: `${r.detail ?? r.error ?? ''}${r.warning ? ` ${r.warning}` : ''}` });
    if (r.ok) {
      setVals({}); // clear secrets from the page after a successful save
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
            <h2>{t('setupTitle')}</h2>
          </div>
          <span className="badge">{t('setupSavedBadge')}</span>
          <button onClick={onClose}>{t('setupCloseBtn')}</button>
        </div>

        <div className="setup-body">
          <nav className="setup-sidebar" aria-label="Setup Sections">
            <button type="button" className={`setup-tab-btn ${activeTab === 'trading' ? 'active' : ''}`} onClick={() => setActiveTab('trading')}><span>{t('setupTabTrading')}</span></button>
            <button
              type="button"
              className={`setup-tab-btn ${activeTab === 'desk' ? 'active' : ''}`}
              onClick={() => setActiveTab('desk')}
            >
              <span>{t('setupTabDesk')}</span>
            </button>
            <button
              type="button"
              className={`setup-tab-btn ${activeTab === 'models' ? 'active' : ''}`}
              onClick={() => setActiveTab('models')}
            >
              <span>{t('setupTabModels')}</span>
            </button>
            <button
              type="button"
              className={`setup-tab-btn ${activeTab === 'local' ? 'active' : ''}`}
              onClick={() => setActiveTab('local')}
            >
              <span>{t('setupTabLocal')}</span>
            </button>
            <button
              type="button"
              className={`setup-tab-btn ${activeTab === 'exchange' ? 'active' : ''}`}
              onClick={() => setActiveTab('exchange')}
            >
              <span>{t('setupTabExchange')}</span>
            </button>
            <button
              type="button"
              className={`setup-tab-btn ${activeTab === 'channels' ? 'active' : ''}`}
              onClick={() => setActiveTab('channels')}
            >
              <span>{t('setupTabChannels')}</span>
            </button>
          </nav>

          <main className="setup-content"><div className="setup-guide-note">{t('setupGuideNote')}</div>
            <section className="setup-pane" hidden={activeTab !== 'trading'}><div className="pane-header"><h3>{t('setupTabTrading')}</h3><p className="wallet-note">{lang === 'id' ? 'Profil terpisah untuk testnet dan mainnet. Tinjau nilai bawaan atau edit pengaturan manual kamu.' : 'Separate testnet and mainnet profiles. Review defaults or edit your manual settings.'}</p></div><TradingSetup state={state} initialProfile={tradingProfile} /></section>
            <section className="setup-pane" hidden={activeTab !== 'desk'}>
                <div className="pane-header">
                  <h3>{t('setupDeskTitle')}</h3>
                  <p className="wallet-note">{t('setupDeskRunningPrefix')} <b>{info.running.mode}</b> · {info.running.appMode}. {t('setupDeskSavedModePrefix')} {info.status.tradingMode} · {t('setupDeskVenuePrefix')} {info.status.exchange}. {t('setupDeskSavingNotice')}</p>
                </div>
                {info.status.forbidden.length > 0 && <p className="wallet-msg bad">{t('setupDeskRemoveForbidden')} ({info.status.forbidden.join(', ')})</p>}
                {state.killed && <p className="wallet-msg bad">{t('setupDeskKillSwitchAlert')} <code>{info.unkill}</code>{t('setupDeskThenRestart')}</p>}
                <PreferencesSetup />
                <div style={{ marginTop: '16px', borderTop: '1px solid var(--line)', paddingTop: '16px' }}>
                  <DataSourcesSetup available={info.keyEntry.available} />
                </div>
              </section>

            <section className="setup-pane" hidden={activeTab !== 'models'}>
                <div className="pane-header">
                  <h3>{t('setupModelsTitle')}</h3>
                  <p className="wallet-note">{t('setupModelsNote')}</p>
                </div>
                <ModelsSetup available={info.keyEntry.available} appMode={info.running.appMode} />
                <JevSetup available={info.keyEntry.available} />
              </section>

            <section className="setup-pane setup-local-pane" hidden={activeTab !== 'local'}>
                <div className="pane-header">
                  <h3>{t('setupLocalTitle')}</h3>
                  <p className="wallet-note">{t('setupLocalNote')}</p>
                </div>
                <LocalAgentsSetup available={info.keyEntry.available} />
              </section>

            <section className="setup-pane" hidden={activeTab !== 'exchange'}>
                <div className="pane-header">
                  <h3>{t('setupExchangeTitle')}</h3>
                  <p className="wallet-note">{t('setupExchangeRunningPrefix')} <b>{info.running.mode}</b> {lang === 'id' ? 'dalam mode' : 'in'} {info.running.appMode}.</p>
                </div>

                <div className="setup-section-actions"><p className="wallet-note">{t('setupExchangeSavedPrefix')} <b>{info.status.tradingMode}</b> · {venue || info.status.exchange}. {t('setupExchangeCredsNote')}</p>{!editingExchange && <button onClick={() => { restoreExchange(); setEditingExchange(true); }}>{t('setupExchangeEditBtn')}</button>}</div>
                {!editingExchange && <><dl className="setup-summary">{activeVenuesStatus.map((n) => <div key={n.network}><dt>{n.network}</dt><dd>{n.fields.map((f) => `${f.name}: ${f.set ? (lang === 'id' ? 'tersimpan' : 'saved') : (lang === 'id' ? 'belum diatur' : 'not set')}`).join(' · ')}</dd></div>)}</dl><button disabled={busy} onClick={runDoctor}>{t('setupExchangeRunDoctorBtn')}</button></>}
                <div hidden={!editingExchange}>
                <details className="setup-reference"><summary>{t('setupExchangeModeGuide')}</summary>
                <h4>1. Mode</h4>
                <ol className="wallet-steps">{info.modes.map((m) => <li key={m.mode}><b>{m.mode}</b>: {m.info}</li>)}</ol>
                </details>

                <h4>2. {t('setupExchangeVenueAndNetwork')}</h4>
                <div className="wallet-pick">
                  <select value={venue} onChange={(e) => { void selectVenue(e.target.value); }} aria-label="venue">
                    <optgroup label={t('setupExchangeCexGroup')}>{info.venues.filter((x) => x.kind === 'CEX').map((x) => <option key={x.venue} value={x.venue}>{x.label}</option>)}</optgroup>
                    <optgroup label={t('setupExchangeDexGroup')}>{info.venues.filter((x) => x.kind === 'DEX').map((x) => <option key={x.venue} value={x.venue}>{x.label}</option>)}</optgroup>
                  </select>
                  <div className="seg" role="group" aria-label="network">{(['testnet', 'mainnet'] as const).map((n) => <button key={n} className={network === n ? 'on' : ''} onClick={() => setNetwork(n)}>{n}</button>)}</div>
                </div>
                {v && <p className="wallet-note">{v.login}{v.extra ? ` ${v.extra}` : ''}</p>}
                {guide?.note && <p className="wallet-note">{guide.note}</p>}

                <details className="setup-reference"><summary>{lang === 'id' ? 'Panduan koneksi · hanya dibutuhkan untuk bursa atau key baru' : 'Connection guide · only needed for a new venue or key'}</summary>
                <h4>{lang === 'id' ? 'Langkah' : 'Step'} {steps.length ? at + 1 : 0} {lang === 'id' ? 'dari' : 'of'} {steps.length}{cur ? `: ${cur.title}` : ''}</h4>
                {cur && <div className="setup-step"><p>{cur.text}</p><ul>{cur.links.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer">{l.label}</a>{l.login ? (lang === 'id' ? ' · masuk atau sambungkan dompet dulu' : ' · sign in or connect wallet first') : ''}{l.note ? ` · ${l.note}` : ''}</li>)}</ul></div>}
                <div className="setup-nav"><button disabled={at === 0} onClick={() => setAt(at - 1)}>{lang === 'id' ? 'Kembali' : 'Back'}</button><button disabled={at >= steps.length - 1} onClick={() => setAt(at + 1)}>{lang === 'id' ? 'Langkah berikutnya' : 'Next step'}</button></div>
                </details>

                <details className="setup-reference" open><summary>{lang === 'id' ? 'Ganti atau tambah kredensial khusus-trading' : 'Replace or add trade-only credentials'}</summary>
                <p className="field-help">{lang === 'id' ? 'Kredensial tersimpan tetap aman di komputer ini. Buka bagian ini hanya untuk menggantinya atau menghubungkan bursa baru. Kolom rahasia sengaja dikosongkan.' : 'Saved credentials stay in place. Open this section only to replace them or connect a new venue. Secret fields are intentionally empty.'}</p>
                {info.keyEntry.available && guide ? (
                  <form className="setup-keys" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void saveKeys(); }}>
                    {guide.fields.map((f) => <label key={f.name}><span>{f.label} <code>{f.name}</code></span><input type={f.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} placeholder={f.placeholder} value={vals[f.name] ?? ''} onChange={(e) => setVals({ ...vals, [f.name]: e.target.value })} /></label>)}
                    <button disabled={busy} type="submit">{busy ? (lang === 'id' ? 'Memeriksa di bursa...' : 'Checking on the venue...') : t('setupExchangeSaveKeysBtn')}</button>
                    {msg && <p className={`wallet-msg ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</p>}
                    <p className="wallet-note small">{lang === 'id' ? 'Ditolak: seed phrase, private key dompet utama, key dengan izin withdraw. Jangan pernah menempelkan API key ke dalam chat.' : 'Refused: seed phrases, main wallet keys, keys that can withdraw. Never paste a key into a chat.'}</p>
                  </form>
                ) : <p className="wallet-note">{t('setupExchangeKeyEntryUnavailable')} {info.keyEntry.reason}</p>}
                {guide?.connectWallet && <WalletPanel state={state} />}
                {activeVenuesStatus.map((n) => <p key={n.network} className="wallet-note small">{n.network}: {n.fields.map((f) => `${f.name} ${f.set ? (f.shown ?? (lang === 'id' ? 'tersimpan' : 'set')) : (lang === 'id' ? 'kosong' : 'empty')}`).join(', ')}</p>)}
                </details>

                <h4>5. {lang === 'id' ? 'Verifikasi' : 'Verify'}</h4>
                <button disabled={busy} onClick={runDoctor}>{t('setupExchangeRunDoctorBtn')}</button> <span className="wallet-note small">{lang === 'id' ? 'sama seperti' : 'same as'} <code>npm run doctor</code></span>

                <h4>6. {t('setupExchangeSaveModeBtn')}</h4>
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
                    <label className="field-help">{lang === 'id' ? 'LIVE otomatis mentransaksikan uang sungguhan. Ketik' : 'LIVE trades real money automatically. Type'} “{info.liveConfirmPhrase}” {lang === 'id' ? 'untuk mengganti mode.' : 'to change mode.'}<input aria-label="LIVE confirmation" autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
                  )}
                  <button
                    disabled={busy || !info.keyEntry.available || mode === 'LIVE' && confirm !== info.liveConfirmPhrase}
                    onClick={saveMode}
                  >
                    {mode === 'LIVE' ? (lang === 'id' ? 'Konfirmasi & Pindah ke LIVE' : 'Confirm & Switch to LIVE') : t('setupExchangeSaveModeBtn')}
                  </button>
                </div>
                <p className="wallet-note small">{lang === 'id' ? 'TESTNET dan LIVE diverifikasi langsung di bursa: trading aktif, withdraw mati. Restart meja trading setelahnya.' : 'TESTNET and LIVE are verified on the exchange: trade on, withdraw off. Restart the office afterwards.'}</p>
                <button disabled={busy} onClick={() => { restoreExchange(); setEditingExchange(false); }}>{t('setupExchangeCancelBtn')}</button>
                </div>
                {doc && <ul className="setup-doctor">{doc.map((l, i) => <li key={i} className={l.ok === true ? 'ok' : l.ok === false ? 'bad' : ''}>{l.ok === true ? 'OK' : l.ok === false ? 'FAIL' : '--'} {l.label}: {l.detail}</li>)}</ul>}
                {msg && <p className={`wallet-msg ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</p>}
              </section>

            <section className="setup-pane" hidden={activeTab !== 'channels'}>
                <div className="pane-header">
                  <h3>{t('setupChannelsTitle')}</h3>
                  <p className="wallet-note">{lang === 'id' ? 'Hubungkan Telegram, Discord, Slack atau WhatsApp untuk pembaruan trading dan laporan otomatis.' : 'Connect Telegram, Discord, Slack or WhatsApp for automated trade updates and reports.'}</p>
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
