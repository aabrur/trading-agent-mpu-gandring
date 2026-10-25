import { useEffect, useRef, useState } from 'react';
import type { DeskState } from '../types';
import type { TradingNetwork, TradingPresetId, TradingProfile, TradingSettings } from '../../../server/trading-settings';
import { TRADING_PRESETS, draftProfile, resolveTradingPreset } from '../../../server/trading-settings';
import { useI18n, type TranslationKey } from '../i18n';

interface TradingInfo {
  defaults: TradingSettings;
  networks: Record<TradingNetwork, { profile: TradingProfile; values: TradingSettings; manual: TradingSettings }>;
  running: { mode: string; network: TradingNetwork | null; profile: TradingProfile; values: TradingSettings };
}

function getTradingFields(t: (k: TranslationKey) => string) {
  return [
    { key: 'dailyLossLimitPct' as const, label: t('tradingDailyLossCap'), min: 0.5, max: 25, help: t('tradingHelpDailyLoss') },
    { key: 'minEntryConfidencePct' as const, label: t('tradingMinEntryConfidence'), min: 0, max: 100, help: t('tradingHelpMinEntryConfidence') },
    { key: 'maxLeverage' as const, label: t('tradingMaxLeverage'), min: 1, max: 100, step: 1, help: t('tradingHelpMaxLeverage') },
    { key: 'orderSizePct' as const, label: 'Order size (% of Money Trade)', min: 1.5, max: 100, help: '1.5–100%. Leave empty to divide Money Trade by N.' },
    { key: 'defaultStopPct' as const, label: t('tradingDefaultStop'), min: 0, max: 100, help: t('tradingHelpDefaultStop') },
    { key: 'takeProfitPct' as const, label: t('tradingTakeProfitPct'), min: 0, max: 1000, help: t('tradingHelpTakeProfitPct') },
    { key: 'safetyNet' as const, label: t('tradingSafetyNet'), min: 0, help: t('tradingHelpSafetyNet') },
    { key: 'maxPositions' as const, label: t('tradingMaxPositions'), min: 1, max: 4, step: 1, help: t('tradingHelpMaxPositions') }
  ];
}

function profileName(profile: TradingProfile, lang: string) {
  if (profile === 'current') return lang === 'id' ? 'pengaturan tersimpan' : 'existing settings';
  if (profile in TRADING_PRESETS) return TRADING_PRESETS[profile as TradingPresetId].name;
  return profile;
}

export function TradingSetup({ state, initialProfile }: { state: DeskState; initialProfile?: TradingProfile }) {
  const { t, lang } = useI18n();
  const fields = getTradingFields(t);
  const [info, setInfo] = useState<TradingInfo | null>(null);
  const [network, setNetwork] = useState<TradingNetwork>(state.mode === 'LIVE' ? 'mainnet' : 'testnet');
  const [profile, setProfile] = useState<TradingProfile>(initialProfile ?? 'manual');
  const [drafts, setDrafts] = useState<Record<TradingNetwork, TradingSettings> | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const honorShortcut = useRef(!!initialProfile);
  const load = async (refreshDrafts = false) => {
    try {
      const r = await fetch('/api/setup/trading'), d = await r.json();
      if (!r.ok || !d.ok) { setMessage(d.detail || t('tradingUnavailableMsg')); return; }
      const next: TradingInfo = d; setInfo(next);
      setDrafts((previous) => {
        const manuals = { testnet: next.networks.testnet.values, mainnet: next.networks.mainnet.values };
        if (!previous || refreshDrafts) return manuals;
        return previous;
      });
      if (!honorShortcut.current) setProfile(draftProfile(next.networks[network].profile));
    } catch { setMessage(lang === 'id' ? 'Meja trading tidak dapat dihubungi. Pengaturan tersimpan gagal dimuat.' : 'Office not reachable. Saved settings could not be loaded.'); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (initialProfile) setProfile(initialProfile); }, [initialProfile]);
  useEffect(() => {
    if (!info) return;
    honorShortcut.current = false;
    setProfile(draftProfile(info.networks[network].profile));
  }, [network]);
  if (!info || !drafts) return <div className="wallet-note" role="status"><p>{message || t('tradingLoadingProfiles')}</p>{message && <button onClick={() => void load()}>{t('tradingRetryBtn')}</button>}</div>;
  const isPreset = profile in TRADING_PRESETS;
  const values = drafts[network];
  const active = info.running.network === network;
  async function save() {
    setBusy(true); setMessage('');
    try {
      const body = { network, profile, values };
      const r = await fetch('/api/setup/trading', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), d = await r.json();
      if (r.ok && d.ok) {
        setMessage(d.applied ? `${t('tradingAppliedToDesk')}. ${d.detail ?? ''}` : `${t('tradingSavedForNextStart')}. ${d.detail ?? ''}`);
        await load(true);
      } else {
        setMessage(d.detail || (lang === 'id' ? 'Penyimpanan tidak terkonfirmasi.' : 'Saving was not confirmed.'));
      }
    } catch { setMessage(lang === 'id' ? 'Penyimpanan tidak terkonfirmasi. Muat ulang bagian ini sebelum mencoba lagi.' : 'Saving was not confirmed. Refresh this section before trying again.'); }
    finally { setBusy(false); }
  }
  async function saveLimits() {
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/setup/trading/limits', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({network, minOrderUsdt: values.minOrderUsdt, maxOrderUsdt: values.maxOrderUsdt})});
      const result = await response.json();
      setMessage(result.detail);
      if (response.ok && result.ok) await load(true);
    } catch { setMessage(lang === 'id' ? 'Gagal menyimpan batas trading.' : 'Unable to save trading limits.'); }
    finally { setBusy(false); }
  }
  const savedProfile = info.networks[network].profile;
  const savedLabel = profileName(savedProfile, lang);
  const runningLabel = profileName(info.running.profile, lang);
  const draftDirty = draftProfile(savedProfile) !== profile;
  return <section className="trading-setup">
    <p className="wallet-note">{lang === 'id' ? 'Berjalan:' : 'Running:'} <b>{info.running.mode}</b>{info.running.network ? ` · ${info.running.network}` : ''} · {runningLabel}. {lang === 'id' ? 'Testnet menggunakan dana tes; mainnet LIVE menggunakan uang sungguhan. Memilih profil tidak mengganti mode atau menyambungkan bursa.' : 'Testnet uses test funds; mainnet LIVE uses real funds. Selecting a profile does not change mode or connect an exchange.'}</p>
    <p className="setup-guide-note"><b>{t('tradingAppliedToDesk')}</b>: {info.running.mode}{info.running.network ? ` · ${info.running.network}` : ''} · {runningLabel}</p>
    <p className="setup-guide-note"><b>{t('tradingSavedForNextStart')}</b> ({network}): {savedLabel}</p>
    {draftDirty && <p className="field-help">{t('tradingDraftProfile')}: {profileName(profile, lang)}</p>}
    {profile === 'manual' && info.running.profile !== 'manual' && active && <p className="field-help">{lang === 'id' ? 'Nilai manual ini belum aktif. Simpan dan terapkan untuk mengganti preset yang berjalan.' : 'These manual values are not active. Save and apply to replace the running preset.'}</p>}
    <div className="wallet-pick">
      <label>{lang === 'id' ? 'Jaringan trading' : 'Trading network'}<select aria-label="Trading network" disabled={busy} value={network} onChange={(e) => { setNetwork(e.target.value as TradingNetwork); setMessage(''); }}><option value="testnet">Testnet · TESTNET</option><option value="mainnet">Mainnet · LIVE</option></select></label>
      <label>{t('tradingProfileLabel')}<select aria-label="Settings profile" disabled={busy} value={profile} onChange={(e) => {
        const next = e.target.value as TradingProfile;
        setProfile(next);
        setMessage('');
        if (next in TRADING_PRESETS) {
          const presetVals = resolveTradingPreset(next as TradingPresetId, drafts[network]);
          setDrafts((old) => old ? { ...old, [network]: presetVals } : old);
        }
      }}>
        <option value="default">{t('tradingProfileDefault')}</option>
        <option value="balance">{t('tradingProfileBalance')}</option>
        <option value="profit">{t('tradingProfileProfit')}</option>
        <option value="aggressive">Aggressive</option>
        <option value="manual">{t('tradingProfileManual')}</option>
      </select></label>
    </div>
    <form onSubmit={e => {e.preventDefault(); void saveLimits();}}>
      <fieldset disabled={busy}><legend>{lang === 'id' ? 'Batas Trading' : 'Trading Limits'} · {network}</legend>
        {(['minOrderUsdt', 'maxOrderUsdt'] as const).map(key => <label key={key}>{key === 'minOrderUsdt' ? (lang === 'id' ? 'Batas Minimum Trade (USDT)' : 'Minimum Trade Limit (USDT)') : (lang === 'id' ? 'Batas Maksimum Trade (USDT)' : 'Maximum Trade Limit (USDT)')}<input type="number" min="0" step="any" required value={values[key] ?? 0} onChange={e => setDrafts(old => old ? {...old, [network]: {...old[network], [key]: Number(e.target.value)}} : old)} /><small>{lang === 'id' ? 'Tersimpan' : 'Saved'}: {info.networks[network].values[key] ?? 0} · {lang === 'id' ? 'Berjalan' : 'Running'}: {info.running.values[key] ?? 0}</small></label>)}
        <p className="field-help">{lang === 'id' ? '0 = tanpa batas tambahan aplikasi. Aturan kuantitas, step, dan nominal bursa tetap berlaku.' : '0 = no additional application limit. Exchange quantity, step, and notional rules still apply.'}</p>
        <button type="submit">{lang === 'id' ? 'Simpan & Terapkan' : 'Save & Apply'}</button>
        <button type="button" onClick={() => setDrafts(old => old ? {...old, [network]: {...old[network], minOrderUsdt: info.networks[network].values.minOrderUsdt, maxOrderUsdt: info.networks[network].values.maxOrderUsdt}} : old)}>{lang === 'id' ? 'Reset Perubahan Belum Disimpan' : 'Reset Unsaved Changes'}</button>
      </fieldset>
    </form>
    <p className="setup-guide-note">{t('tradingSavedProfilePrefix')} {network}: <b>{savedLabel}</b>. {isPreset ? `${lang === 'id' ? 'Tinjau preset' : 'Review the'} ${TRADING_PRESETS[profile as TradingPresetId].name} ${t('tradingPresetBanner')}` : (lang === 'id' ? 'Edit hanya nilai yang ingin kamu ubah. Nilai manual sebelumnya disimpan terpisah untuk tiap jaringan.' : 'Edit only the values you want to change. The previous manual values are retained separately for each network.')}</p>
    <p className="field-help">{isPreset ? (lang === 'id' ? 'Nilai preset ditetapkan oleh Owner. SL dan TP dihitung dari margin order. Dana aman dan nominal minimal order mengikuti konfigurasi akun kamu.' : 'Preset values are set by the Owner. SL and TP are percentages of order margin. Capital reserves and order minimums reflect your network configuration.') : (lang === 'id' ? 'Semua kolom manual wajib diisi.' : 'All manual fields are required.')}</p>
    <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="settings-grid">{fields.map((f) => <label key={f.key}>{f.label}<input aria-label={f.label} type="number" required={f.key !== 'orderSizePct'} min={f.min} max={f.max} step={f.step ?? 'any'} disabled={busy} value={values[f.key] ?? ''} onChange={(e) => {
        const val = Number(e.target.value);
        setDrafts((old) => {
          if (!old) return old;
          const current = { ...old[network], [f.key]: f.key === 'orderSizePct' && e.target.value === '' ? undefined : val };
          if (f.key === 'takeProfitPct' && current.defaultStopPct > 0) {
            current.takeProfitR = Math.round((val / current.defaultStopPct) * 100) / 100;
          } else if (f.key === 'defaultStopPct' && (current.takeProfitPct ?? 0) > 0) {
            current.takeProfitR = Math.round(((current.takeProfitPct ?? 0) / Math.max(0.1, val)) * 100) / 100;
          }
          return { ...old, [network]: current };
        });
      }} /><small className="field-help">{f.help}{active ? ` ${lang === 'id' ? 'Aktif' : 'Active'}: ${info.running.values[f.key]}.` : ''}</small></label>)}</div>
      <p className="field-help">{lang === 'id' ? 'Semua order memakai SL/TP profil dari margin, sebelum biaya dan pembulatan bursa. Tidak ada jarak stop minimal, pemotongan ukuran oleh AI, atau batas rugi per order dari ekuitas akun. Keyakinan minimal berlaku untuk entry mandiri agen. Menyimpan tidak mengubah order terbuka, me-reset batas rugi harian, menyalakan Auto Trade, atau mengganti mode.' : 'Every order uses profile SL/TP percentages of margin, before fees and venue rounding. No minimum stop distance, AI size reduction, or account-equity loss cap per order. Minimum confidence applies to agent entries. Saving does not change open orders, reset the daily loss stop, enable Auto Trade, or switch mode.'}</p>
      <div className="setup-nav"><button disabled={busy} type="submit">{busy ? t('tradingSavingBtn') : `${active ? (lang === 'id' ? 'Simpan & terapkan' : 'Save and apply') : t('tradingSaveProfileBtn')} ${isPreset ? TRADING_PRESETS[profile as TradingPresetId].name : profile} ${lang === 'id' ? 'untuk' : 'for'} ${network}`}</button><button disabled={busy} type="button" onClick={() => { setProfile(draftProfile(savedProfile)); setDrafts({ ...drafts, [network]: info.networks[network].values }); setMessage(lang === 'id' ? 'Draf dikembalikan ke nilai tersimpan.' : 'Draft restored to saved values.'); }}>{t('tradingDiscardEdits')}</button></div>
      {!active && <p className="field-help">{lang === 'id' ? 'Jaringan ini sedang tidak berjalan. Menyimpan akan mempersiapkannya untuk dijalankan berikutnya; ganti mode di Bursa & Pengamanan.' : 'This network is not running. Saving prepares it for its next start; change mode separately in Exchange & Safety.'}</p>}
    </form>
    {message && <p className="wallet-note" role="status">{message}</p>}
  </section>;
}
