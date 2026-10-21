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
    { key: 'dailyLossLimitPct' as const, label: t('tradingDailyLossCap'), min: 0.5, max: 20, help: t('tradingHelpDailyLoss') },
    { key: 'maxLossPerTradePct' as const, label: t('tradingRiskPerTrade'), min: 0, max: 100, help: t('tradingHelpRiskPerTrade') },
    { key: 'minEntryConfidencePct' as const, label: t('tradingMinEntryConfidence'), min: 0, max: 100, help: t('tradingHelpMinEntryConfidence') },
    { key: 'maxLeverage' as const, label: t('tradingMaxLeverage'), min: 1, max: 100, step: 1, help: t('tradingHelpMaxLeverage') },
    { key: 'orderSizePct' as const, label: 'Order size (% of Money Trade)', min: 1.5, max: 100, help: '1.5–100%. Leave empty to divide Money Trade by N.' },
    { key: 'defaultStopPct' as const, label: t('tradingDefaultStop'), min: 0, max: 100, help: t('tradingHelpDefaultStop') },
    { key: 'minStopPct' as const, label: t('tradingMinStop'), min: 0, max: 100, help: t('tradingHelpMinStop') },
    { key: 'takeProfitPct' as const, label: t('tradingTakeProfitPct'), min: 0, max: 1000, help: t('tradingHelpTakeProfitPct') },
    { key: 'takeProfitR' as const, label: t('tradingTakeProfitR'), min: 0, help: t('tradingHelpTakeProfitR') },
    { key: 'minOrderUsdt' as const, label: t('tradingMinOrderUsdt'), min: 0, help: t('tradingHelpMinOrderUsdt') },
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
    <p className="setup-guide-note">{t('tradingSavedProfilePrefix')} {network}: <b>{savedLabel}</b>. {isPreset ? `${lang === 'id' ? 'Tinjau preset' : 'Review the'} ${TRADING_PRESETS[profile as TradingPresetId].name} ${t('tradingPresetBanner')}` : (lang === 'id' ? 'Edit hanya nilai yang ingin kamu ubah. Nilai manual sebelumnya disimpan terpisah untuk tiap jaringan.' : 'Edit only the values you want to change. The previous manual values are retained separately for each network.')}</p>
    <p className="field-help">{isPreset ? (lang === 'id' ? 'Nilai preset ditetapkan berdasarkan rekomendasi. Dana aman dan nominal minimal order mengikuti konfigurasi akun kamu.' : 'Preset values are fixed by recommendation. Capital reserves and order minimums reflect your network configuration.') : (lang === 'id' ? 'Semua kolom manual wajib diisi.' : 'All manual fields are required.')}</p>
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
      <p className="field-help">{lang === 'id' ? 'Pengaturan ini diteruskan ke Agen Risiko, sizing bersama, dan pengecekan eksekusi. Tiket manual tetap mematuhi pengaman stop/ukuran; batas keyakinan minimal berlaku untuk entry mandiri agen. Menyimpan tidak mengubah ukuran order terbuka, tidak me-reset batas rugi harian, dan tidak mengaktifkan Auto Trade atau mengganti mode.' : 'These settings feed the Risk Agent, shared sizing and execution checks. Manual tickets keep their stop/size guards; the confidence floor applies to agent entries. Applying does not resize open orders, reset a daily loss stop, enable Auto Trade or switch mode.'}</p>
      <div className="setup-nav"><button disabled={busy} type="submit">{busy ? t('tradingSavingBtn') : `${active ? (lang === 'id' ? 'Simpan & terapkan' : 'Save and apply') : t('tradingSaveProfileBtn')} ${isPreset ? TRADING_PRESETS[profile as TradingPresetId].name : profile} ${lang === 'id' ? 'untuk' : 'for'} ${network}`}</button><button disabled={busy} type="button" onClick={() => { setProfile(draftProfile(savedProfile)); setDrafts({ ...drafts, [network]: info.networks[network].values }); setMessage(lang === 'id' ? 'Draf dikembalikan ke nilai tersimpan.' : 'Draft restored to saved values.'); }}>{t('tradingDiscardEdits')}</button></div>
      {!active && <p className="field-help">{lang === 'id' ? 'Jaringan ini sedang tidak berjalan. Menyimpan akan mempersiapkannya untuk dijalankan berikutnya; ganti mode di Bursa & Pengamanan.' : 'This network is not running. Saving prepares it for its next start; change mode separately in Exchange & Safety.'}</p>}
    </form>
    {message && <p className="wallet-note" role="status">{message}</p>}
  </section>;
}
