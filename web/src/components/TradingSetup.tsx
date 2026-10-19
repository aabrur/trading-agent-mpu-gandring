import { useEffect, useState } from 'react';
import type { DeskState } from '../types';
import type { TradingNetwork, TradingProfile, TradingSettings } from '../../../server/trading-settings';

interface TradingInfo {
  defaults: TradingSettings;
  networks: Record<TradingNetwork, { profile: TradingProfile; values: TradingSettings; manual: TradingSettings }>;
  running: { mode: string; network: TradingNetwork | null; profile: TradingProfile; values: TradingSettings };
}
const fields: { key: keyof TradingSettings; label: string; help: string; min: number; max?: number; step?: number }[] = [
  { key: 'dailyLossLimitPct', label: 'Daily loss cap (%)', min: 0.5, max: 20, help: 'Loss from the UTC day’s starting equity. Stops new entries once reached; an existing daily stop stays latched until the next UTC day.' },
  { key: 'maxLossPerTradePct', label: 'Risk per trade (%)', min: 0, max: 100, help: 'Maximum loss at the stop, including estimated round-trip fees, as a percentage of the lower of balance and equity. Sizing can reduce the order.' },
  { key: 'minEntryConfidencePct', label: 'Minimum entry confidence (%)', min: 0, max: 100, help: 'Desk Lead’s reported confidence for autonomous LONG/SHORT entries. 0 adds no confidence threshold. This is not a measured win probability; CLOSE is not blocked by this value.' },
  { key: 'maxLeverage', label: 'Maximum leverage (x)', min: 1, max: 100, step: 1, help: 'Upper cap; the risk gate and exchange instrument limits still apply.' },
  { key: 'defaultStopPct', label: 'Maximum / fallback stop distance (%)', min: 0, max: 100, help: 'Fallback when no stop price is supplied, and maximum allowed stop distance. Every order still requires protection.' },
  { key: 'minStopPct', label: 'Minimum stop distance (%)', min: 0, max: 100, help: 'Stop distance floor. Must not exceed the maximum stop distance.' },
  { key: 'takeProfitR', label: 'Take profit (R)', min: 0, help: 'Target distance as a multiple of stop distance. 2 means 2R; 0 disables the derived target, not the stop.' },
  { key: 'minOrderUsdt', label: 'Minimum order notional (USDT)', min: 0, help: 'Minimum order value, not margin. A larger exchange minimum wins; the desk never rounds quantity up to force an order.' },
  { key: 'safetyNet', label: 'Reserved capital (USDT)', min: 0, help: 'Must stay above zero outside PAPER. Kept outside Money Trade. If the verified venue equity is below this reserve, no new allocation is available.' },
  { key: 'maxPositions', label: 'Maximum open positions', min: 1, max: 4, step: 1, help: 'Money Trade is divided into these slots. Changing this does not close or resize existing positions.' }
];

export function TradingSetup({ state, initialProfile }: { state: DeskState; initialProfile?: 'default' | 'manual' }) {
  const [info, setInfo] = useState<TradingInfo | null>(null);
  const [network, setNetwork] = useState<TradingNetwork>(state.mode === 'LIVE' ? 'mainnet' : 'testnet');
  const [profile, setProfile] = useState<'default' | 'manual'>(initialProfile ?? 'manual');
  const [drafts, setDrafts] = useState<Record<TradingNetwork, TradingSettings> | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const load = async () => {
    try {
      const r = await fetch('/api/setup/trading'), d = await r.json();
      if (!r.ok || !d.ok) { setMessage(d.detail || 'Trading settings unavailable.'); return; }
      const next: TradingInfo = d; setInfo(next);
      setDrafts((previous) => previous ?? { testnet: next.networks.testnet.manual, mainnet: next.networks.mainnet.manual });
    } catch { setMessage('Office not reachable. Saved settings could not be loaded.'); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (initialProfile) setProfile(initialProfile); }, [initialProfile]);
  if (!info || !drafts) return <div className="wallet-note" role="status"><p>{message || 'Loading saved trading profiles...'}</p>{message && <button onClick={() => void load()}>Retry loading</button>}</div>;
  const values = profile === 'default' ? info.defaults : drafts[network];
  const active = info.running.network === network;
  async function save() {
    setBusy(true); setMessage('');
    try {
      const body = { network, profile, ...(profile === 'manual' ? { values } : {}) };
      const r = await fetch('/api/setup/trading', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), d = await r.json();
      setMessage(d.detail || 'Saving was not confirmed.'); if (r.ok && d.ok) await load();
    } catch { setMessage('Saving was not confirmed. Refresh this section before trying again.'); }
    finally { setBusy(false); }
  }
  return <section className="trading-setup">
    <p className="wallet-note">Running: <b>{info.running.mode}</b>{info.running.network ? ` · ${info.running.network}` : ''} · {info.running.profile === 'current' ? 'existing settings' : info.running.profile}. Testnet uses test funds; mainnet LIVE uses real funds. Selecting a profile does not change mode or connect an exchange.</p>
    <div className="wallet-pick">
      <label>Trading network<select aria-label="Trading network" disabled={busy} value={network} onChange={(e) => { setNetwork(e.target.value as TradingNetwork); setMessage(''); }}><option value="testnet">Testnet · TESTNET</option><option value="mainnet">Mainnet · LIVE</option></select></label>
      <label>Settings profile<select aria-label="Settings profile" disabled={busy} value={profile} onChange={(e) => { setProfile(e.target.value as 'default' | 'manual'); setMessage(''); }}><option value="default">Default · app preset</option><option value="manual">Manual · edit saved values</option></select></label>
    </div>
    <p className="setup-guide-note">Saved for {network}: <b>{info.networks[network].profile === 'current' ? 'existing configuration' : info.networks[network].profile}</b>. {profile === 'default' ? 'Review the app preset below before applying. It can differ from your current settings and available capital.' : 'Edit only the values you want to change. The previous manual values are retained separately for each network.'}</p>
    <p className="field-help">All manual fields are required.</p>
    <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="settings-grid">{fields.map((f) => <label key={f.key}>{f.label}<input aria-label={f.label} type="number" required min={f.min} max={f.max} step={f.step ?? 'any'} disabled={busy || profile === 'default'} value={values[f.key]} onChange={(e) => setDrafts((old) => old ? { ...old, [network]: { ...old[network], [f.key]: Number(e.target.value) } } : old)} /><small className="field-help">{f.help}</small></label>)}</div>
      <p className="field-help">These settings feed the Risk Agent, shared sizing and execution checks. Manual tickets keep their stop/size guards; the confidence floor applies to agent entries. Applying does not resize open orders, reset a daily loss stop, enable Auto Trade or switch mode.</p>
      <div className="setup-nav"><button disabled={busy} type="submit">{busy ? 'Saving...' : `${active ? 'Save and apply' : 'Save'} ${profile} for ${network}`}</button>{profile === 'manual' && <button disabled={busy} type="button" onClick={() => { setDrafts({ ...drafts, [network]: info.networks[network].manual }); setMessage('Draft restored to saved values.'); }}>Discard edits</button>}</div>
      {!active && <p className="field-help">This network is not running. Saving prepares it for its next start; change mode separately in Exchange & Safety.</p>}
    </form>
    {message && <p className="wallet-note" role="status">{message}</p>}
  </section>;
}
