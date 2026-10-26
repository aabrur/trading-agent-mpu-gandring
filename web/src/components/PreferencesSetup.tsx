import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

interface Preferences {
  appMode: 'local' | 'grokbot';
  balance: number;
  safetyNet: number;
  n: number;
  dailyLoss: number;
  auto: boolean;
  debateInterval: number;
  reportInterval: number;
  maxHoldHours: number;
}

export function PreferencesSetup() {
  const { t, lang } = useI18n();
  const [values, setValues] = useState<Preferences | null>(null);
  const [saved, setSaved] = useState<Preferences | null>(null);
  const [editing, setEditing] = useState(false);
  const [canRestart, setCanRestart] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/setup/preferences')
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) {
          const loaded = { ...d.values, maxHoldHours: d.values.maxHoldHours ?? 0 };
          setValues(loaded);
          setSaved(loaded);
          setCanRestart(d.canRestart);
        } else {
          setMessage(lang === 'id' ? 'Pengaturan tidak tersedia.' : 'Settings unavailable.');
        }
      })
      .catch(() => setMessage(lang === 'id' ? 'Meja trading tidak terjangkau.' : 'Office not reachable.'));
  }, [lang]);

  async function save() {
    setBusy(true);
    try {
      const r = await fetch('/api/setup/preferences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(values)
      });
      const d = await r.json();
      setMessage(d.detail || d.error);
      if (r.ok && d.ok) {
        setSaved(values);
        setEditing(false);
      }
    } catch {
      setMessage(lang === 'id' ? 'Meja trading tidak terjangkau. Coba simpan lagi.' : 'Office not reachable. Try saving again.');
    } finally {
      setBusy(false);
    }
  }

  async function restart() {
    setBusy(true);
    setMessage(lang === 'id' ? 'Menerapkan pengaturan tersimpan...' : 'Applying saved settings...');
    try {
      const r = await fetch('/api/setup/restart', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) { setMessage(d.detail); setBusy(false); return; }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      for (let i = 0; i < 30; i++) {
        try {
          const health = await fetch('/api/health', { signal: AbortSignal.timeout(1500) });
          if (health.ok) { window.location.reload(); return; }
        } catch { /* Wait for the managed server. */ }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      setMessage(lang === 'id' ? 'Restart memakan waktu lebih lama. Cek terminal mpu, lalu muat ulang halaman.' : 'Restart is taking longer than expected. Check the mpu terminal, then refresh.');
    } catch {
      setMessage(lang === 'id' ? 'Restart tidak dapat dikonfirmasi. Cek terminal mpu.' : 'Restart could not be confirmed. Check the mpu terminal.');
    }
    setBusy(false);
  }

  if (!values) return <p className="wallet-note">{message || (lang === 'id' ? 'Memuat pengaturan...' : 'Loading settings...')}</p>;

  const help = {
    balance: lang === 'id' ? 'Hanya dana simulasi. Ekuitas LIVE berasal langsung dari bursa.' : 'Simulation funds only. LIVE equity comes from the venue.',
    safetyNet: lang === 'id' ? 'Dana cadangan yang dikecualikan dari ukuran posisi baru.' : 'Capital reserved from new position sizing.',
    n: lang === 'id' ? 'Alokasi Modal Trading dibagi ke slot sejumlah ini.' : 'The existing Money Trade allocation is divided across these slots.',
    dailyLoss: lang === 'id' ? 'Batas rugi harian. Entry baru berhenti saat batas tercapai.' : 'Existing daily loss limit. New entries stop when reached.',
    debateInterval: lang === 'id' ? 'Menit jeda antarsiklus analisa, bukan penundaan order.' : 'Minutes between scheduled analysis cycles, not a delay before each order.',
    reportInterval: lang === 'id' ? 'Menit jeda antarlaporan dan notifikasi berkala.' : 'Minutes between scheduled reports and notifications.',
    maxHoldHours: lang === 'id' ? 'Batas maksimal umur posisi dalam jam sebelum ditutup otomatis. 0 = mati (posisi dipegang terus tanpa batas waktu sampai kena SL/TP).' : 'Maximum open position age in hours before automated close. 0 = off (positions held indefinitely until SL/TP).'
  };

  const numeric = (key: Exclude<keyof Preferences, 'appMode' | 'auto'>, label: string, min: number, max?: number) => (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={key === 'balance' || key === 'safetyNet' || key === 'dailyLoss' ? '0.1' : '1'}
        required
        value={values[key]}
        onChange={(e) => setValues({ ...values, [key]: Number(e.target.value) })}
      />
      <small className="field-help">{help[key]}</small>
    </label>
  );

  return (
    <section className="setup-preferences">
      {!editing && (
        <>
          <div className="setup-section-actions">
            <p className="wallet-note">{lang === 'id' ? 'Pengaturan tersimpan kamu. Edit hanya yang kamu butuhkan; tidak perlu mengulang dari awal.' : 'Your saved settings. Edit only what you need; you do not need to set up again.'}</p>
            <button onClick={() => { setMessage(''); setEditing(true); }}>{t('setupDeskEditBtn')}</button>
          </div>
          <dl className="setup-summary">
            <div><dt>{t('setupDeskAgentSource')}</dt><dd>{values.appMode === 'local' ? (lang === 'id' ? 'Model / agen lokal terautentikasi' : 'Models / signed-in local agents') : (lang === 'id' ? 'Tim Grok Bot eksternal' : 'External Grok Bot team')}</dd></div>
            <div><dt>{lang === 'id' ? 'Saldo paper' : 'Paper balance'}</dt><dd>{values.balance} USDT</dd></div>
            <div><dt>{t('safetyNet')}</dt><dd>{values.safetyNet} USDT</dd></div>
            <div><dt>{lang === 'id' ? 'Order maksimal terbuka' : 'Maximum open orders'}</dt><dd>{values.n}</dd></div>
            <div><dt>{lang === 'id' ? 'Batas rugi harian' : 'Daily loss cap'}</dt><dd>{values.dailyLoss}%</dd></div>
            <div><dt>{lang === 'id' ? 'Batas hold posisi' : 'Max position hold'}</dt><dd>{values.maxHoldHours ? `${values.maxHoldHours} ${lang === 'id' ? 'jam' : 'hours'}` : (lang === 'id' ? 'Mati (tanpa batas waktu)' : 'Off (no time limit)')}</dd></div>
            <div><dt>{lang === 'id' ? 'Jadwal otomatis' : 'Auto schedule'}</dt><dd>{values.auto ? (lang === 'id' ? 'Aktif' : 'On') : (lang === 'id' ? 'Mati' : 'Off')} · {lang === 'id' ? 'setiap' : 'every'} {values.debateInterval} {lang === 'id' ? 'mnt' : 'min'}</dd></div>
            <div><dt>{lang === 'id' ? 'Laporan' : 'Reports'}</dt><dd>{lang === 'id' ? 'Setiap' : 'Every'} {values.reportInterval} {lang === 'id' ? 'mnt' : 'min'}</dd></div>
          </dl>
        </>
      )}
      <form hidden={!editing} className="setup-keys" onChange={() => setMessage('')} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label>
          {t('setupDeskAgentSource')}
          <select value={values.appMode} onChange={(e) => setValues({ ...values, appMode: e.target.value as Preferences['appMode'] })}>
            <option value="local">{t('setupDeskSourceLocal')}</option>
            <option value="grokbot">{t('setupDeskSourceGrokbot')}</option>
          </select>
        </label>
        <div className="settings-grid">
          {numeric('balance', t('setupDeskPaperBalance'), 0)}
          {numeric('safetyNet', t('setupDeskSafetyNet'), 0, values.balance)}
          {numeric('n', t('setupDeskMaxOrders'), 1, 4)}
          {numeric('dailyLoss', t('setupDeskDailyLossCap'), 0.1, 100)}
          {numeric('maxHoldHours', t('setupDeskMaxHoldHours') || (lang === 'id' ? 'Batas waktu hold posisi (jam, 0 = mati)' : 'Max position hold hours (0 = off)'), 0, 720)}
          {numeric('debateInterval', t('setupDeskDebateInterval'), 1, 1440)}
          {numeric('reportInterval', t('setupDeskReportInterval'), 1, 1440)}
        </div>
        <p className="wallet-note">{lang === 'id' ? 'Pratinjau alokasi (Rumus Safety Net & Auto-Hedge):' : 'Allocation preview (Safety Net & Auto-Hedge Formula):'} {t('moneyTrade')} {(values.balance * 0.6).toFixed(2)} USDT (60%) · {t('safetyNet')} {values.safetyNet.toFixed(2)} USDT · {lang === 'id' ? 'per slot' : 'per slot'} {((Math.max(0, values.balance - values.safetyNet)) / (values.n || 1)).toFixed(2)} USDT · Trigger Auto-Hedge -{(values.safetyNet * 0.625).toFixed(2)} USDT · Buffer {(values.safetyNet * 0.375).toFixed(2)} USDT.</p>
        <label className="setup-check"><input type="checkbox" checked={values.auto} onChange={(e) => setValues({ ...values, auto: e.target.checked })} /> {t('setupDeskAutoScheduleCheck')}</label>
        <p className="field-help">{t('setupDeskAutoScheduleHelp')}</p>
        <div className="setup-nav">
          <button disabled={busy} type="submit">{t('setupDeskSaveBtn')}</button>
          <button type="button" disabled={busy} onClick={() => { setValues(saved); setEditing(false); setMessage(''); }}>{t('setupDeskCancelBtn')}</button>
        </div>
      </form>
      <div className="setup-nav">
        <button disabled={busy || !canRestart} onClick={restart}>{t('setupDeskApplyRestartBtn')}</button>
        <small className="wallet-note">{canRestart ? t('setupDeskApplyRestartNotice') : t('setupDeskApplyRestartNoticeMpu')}</small>
      </div>
      {message && <p className="wallet-note" role="status">{message}</p>}
    </section>
  );
}
