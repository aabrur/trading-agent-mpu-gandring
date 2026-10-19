import { useEffect, useState } from 'react';
import type { DeskState } from '../types';
import type { TradingNetwork, TradingPresetId, TradingProfile, TradingSettings } from '../../../server/trading-settings';
import { TRADING_PRESETS, resolveTradingPreset } from '../../../server/trading-settings';
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
    { key: 'defaultStopPct' as const, label: t('tradingDefaultStop'), min: 0, max: 100, help: t('tradingHelpDefaultStop') },
    { key: 'minStopPct' as const, label: t('tradingMinStop'), min: 0, max: 100, help: t('tradingHelpMinStop') },
    { key: 'takeProfitR' as const, label: t('tradingTakeProfitR'), min: 0, help: t('tradingHelpTakeProfitR') },
    { key: 'minOrderUsdt' as const, label: t('tradingMinOrderUsdt'), min: 0, help: t('tradingHelpMinOrderUsdt') },
    { key: 'safetyNet' as const, label: t('tradingSafetyNet'), min: 0, help: t('tradingHelpSafetyNet') },
    { key: 'maxPositions' as const, label: t('tradingMaxPositions'), min: 1, max: 4, step: 1, help: t('tradingHelpMaxPositions') }
  ];
}

export function TradingSetup({ state, initialProfile }: { state: DeskState; initialProfile?: TradingProfile }) {
  const { t, lang } = useI18n();
  const fields = getTradingFields(t);
  const [info, setInfo] = useState<TradingInfo | null>(null);
  const [network, setNetwork] = useState<TradingNetwork>(state.mode === 'LIVE' ? 'mainnet' : 'testnet');
  const [profile, setProfile] = useState<TradingProfile>(initialProfile ?? 'manual');
  const [drafts, setDrafts] = useState<Record<TradingNetwork, TradingSettings> | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const load = async () => {
    try {
      const r = await fetch('/api/setup/trading'), d = await r.json();
      if (!r.ok || !d.ok) { setMessage(d.detail || t('tradingUnavailableMsg')); return; }
      const next: TradingInfo = d; setInfo(next);
      setDrafts((previous) => previous ?? { testnet: next.networks.testnet.manual, mainnet: next.networks.mainnet.manual });
    } catch { setMessage(lang === 'id' ? 'Meja trading tidak dapat dihubungi. Pengaturan tersimpan gagal dimuat.' : 'Office not reachable. Saved settings could not be loaded.'); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (initialProfile) setProfile(initialProfile); }, [initialProfile]);
  if (!info || !drafts) return <div className="wallet-note" role="status"><p>{message || t('tradingLoadingProfiles')}</p>{message && <button onClick={() => void load()}>{t('tradingRetryBtn')}</button>}</div>;
  const isPreset = profile in TRADING_PRESETS;
  const values = isPreset
    ? resolveTradingPreset(profile as TradingPresetId, drafts[network])
    : drafts[network];
  const active = info.running.network === network;
  async function save() {
    setBusy(true); setMessage('');
    try {
      const body = { network, profile, ...(profile === 'manual' ? { values } : {}) };
      const r = await fetch('/api/setup/trading', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), d = await r.json();
      setMessage(d.detail || (lang === 'id' ? 'Penyimpanan tidak terkonfirmasi.' : 'Saving was not confirmed.')); if (r.ok && d.ok) await load();
    } catch { setMessage(lang === 'id' ? 'Penyimpanan tidak terkonfirmasi. Muat ulang bagian ini sebelum mencoba lagi.' : 'Saving was not confirmed. Refresh this section before trying again.'); }
    finally { setBusy(false); }
  }
  const savedProfile = info.networks[network].profile;
  const savedLabel = savedProfile === 'current'
    ? (lang === 'id' ? 'pengaturan saat ini' : 'existing configuration')
    : savedProfile in TRADING_PRESETS
      ? TRADING_PRESETS[savedProfile as TradingPresetId].name
      : savedProfile;
  return <section className="trading-setup">
    <p className="wallet-note">{lang === 'id' ? 'Berjalan:' : 'Running:'} <b>{info.running.mode}</b>{info.running.network ? ` · ${info.running.network}` : ''} · {info.running.profile === 'current' ? (lang === 'id' ? 'pengaturan tersimpan' : 'existing settings') : (info.running.profile in TRADING_PRESETS ? TRADING_PRESETS[info.running.profile as TradingPresetId].name : info.running.profile)}. {lang === 'id' ? 'Testnet menggunakan dana tes; mainnet LIVE menggunakan uang sungguhan. Memilih profil tidak mengganti mode atau menyambungkan bursa.' : 'Testnet uses test funds; mainnet LIVE uses real funds. Selecting a profile does not change mode or connect an exchange.'}</p>
    <div className="wallet-pick">
      <label>{lang === 'id' ? 'Jaringan trading' : 'Trading network'}<select aria-label="Trading network" disabled={busy} value={network} onChange={(e) => { setNetwork(e.target.value as TradingNetwork); setMessage(''); }}><option value="testnet">Testnet · TESTNET</option><option value="mainnet">Mainnet · LIVE</option></select></label>
      <label>{t('tradingProfileLabel')}<select aria-label="Settings profile" disabled={busy} value={profile} onChange={(e) => { setProfile(e.target.value as TradingProfile); setMessage(''); }}>
        <option value="default">{t('tradingProfileDefault')}</option>
        <option value="balance">{t('tradingProfileBalance')}</option>
        <option value="profit">{t('tradingProfileProfit')}</option>
        <option value="high_risk">{t('tradingProfileHighRisk')}</option>
        <option value="manual">{t('tradingProfileManual')}</option>
      </select></label>
    </div>
    <p className="setup-guide-note">{t('tradingSavedProfilePrefix')} {network}: <b>{savedLabel}</b>. {isPreset ? `${lang === 'id' ? 'Tinjau preset' : 'Review the'} ${TRADING_PRESETS[profile as TradingPresetId].name} ${t('tradingPresetBanner')}` : (lang === 'id' ? 'Edit hanya nilai yang ingin kamu ubah. Nilai manual sebelumnya disimpan terpisah untuk tiap jaringan.' : 'Edit only the values you want to change. The previous manual values are retained separately for each network.')}</p>
    <p className="field-help">{isPreset ? (lang === 'id' ? 'Nilai preset ditetapkan berdasarkan rekomendasi. Dana aman dan nominal minimal order mengikuti konfigurasi akun kamu.' : 'Preset values are fixed by recommendation. Capital reserves and order minimums reflect your network configuration.') : (lang === 'id' ? 'Semua kolom manual wajib diisi.' : 'All manual fields are required.')}</p>
    <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <div className="settings-grid">{fields.map((f) => <label key={f.key}>{f.label}<input aria-label={f.label} type="number" required min={f.min} max={f.max} step={f.step ?? 'any'} disabled={busy || isPreset} value={values[f.key]} onChange={(e) => setDrafts((old) => old ? { ...old, [network]: { ...old[network], [f.key]: Number(e.target.value) } } : old)} /><small className="field-help">{f.help}</small></label>)}</div>
      <p className="field-help">{lang === 'id' ? 'Pengaturan ini diteruskan ke Agen Risiko, sizing bersama, dan pengecekan eksekusi. Tiket manual tetap mematuhi pengaman stop/ukuran; batas keyakinan minimal berlaku untuk entry mandiri agen. Menyimpan tidak mengubah ukuran order terbuka, tidak me-reset batas rugi harian, dan tidak mengaktifkan Auto Trade atau mengganti mode.' : 'These settings feed the Risk Agent, shared sizing and execution checks. Manual tickets keep their stop/size guards; the confidence floor applies to agent entries. Applying does not resize open orders, reset a daily loss stop, enable Auto Trade or switch mode.'}</p>
      <div className="setup-nav"><button disabled={busy} type="submit">{busy ? t('tradingSavingBtn') : `${active ? (lang === 'id' ? 'Simpan & terapkan' : 'Save and apply') : t('tradingSaveProfileBtn')} ${isPreset ? TRADING_PRESETS[profile as TradingPresetId].name : profile} ${lang === 'id' ? 'untuk' : 'for'} ${network}`}</button>{profile === 'manual' && <button disabled={busy} type="button" onClick={() => { setDrafts({ ...drafts, [network]: info.networks[network].manual }); setMessage(lang === 'id' ? 'Draf dikembalikan ke nilai tersimpan.' : 'Draft restored to saved values.'); }}>{lang === 'id' ? 'Batalkan perubahan' : 'Discard edits'}</button>}</div>
      {!active && <p className="field-help">{lang === 'id' ? 'Jaringan ini sedang tidak berjalan. Menyimpan akan mempersiapkannya untuk dijalankan berikutnya; ganti mode di Bursa & Pengamanan.' : 'This network is not running. Saving prepares it for its next start; change mode separately in Exchange & Safety.'}</p>}
    </form>
    {message && <p className="wallet-note" role="status">{message}</p>}
  </section>;
}
