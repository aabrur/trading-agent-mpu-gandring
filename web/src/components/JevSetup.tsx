import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

interface JevInfo {
  ok: boolean;
  enabled: boolean;
  provider: string;
  model: string;
  mode: string;
  configuredMode: string;
  health: string;
  openrouterKeySet: boolean;
  dedicatedKeySet: boolean;
  keySource: string;
  allowLive: boolean;
  liveAssistBlocked?: boolean;
  tradingMode?: string;
  detail?: string;
}

export function JevSetup({ available }: { available: boolean }) {
  const { t, lang } = useI18n();
  const [info, setInfo] = useState<JevInfo | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<'off' | 'shadow' | 'assist'>('shadow');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [ok, setOk] = useState(false);

  const load = async () => {
    try {
      const r = await fetch('/api/setup/jev');
      const d: JevInfo = await r.json();
      if (!r.ok || !d.ok) throw new Error('unavailable');
      setInfo(d);
      setEnabled(d.enabled);
      setMode((d.configuredMode === 'assist' || d.configuredMode === 'off' ? d.configuredMode : 'shadow'));
      setKey('');
    } catch {
      setOk(false);
      setMessage(lang === 'id' ? 'Pengaturan Jev tidak tersedia.' : 'Jev setup is unavailable.');
    }
  };
  useEffect(() => { void load(); }, []);

  const save = async () => {
    setBusy(true); setMessage('');
    try {
      const r = await fetch('/api/setup/jev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled, mode, ...(key.trim() ? { key: key.trim() } : {}) }) });
      const d: JevInfo = await r.json();
      setOk(r.ok && d.ok);
      setMessage(d.detail || (lang === 'id' ? 'Gagal menyimpan Jev.' : 'Unable to save Jev settings.'));
      if (r.ok && d.ok) { setInfo(d); setKey(''); }
    } catch {
      setOk(false);
      setMessage(lang === 'id' ? 'Meja tidak terjangkau.' : 'Office not reachable.');
    } finally { setBusy(false); }
  };

  const test = async () => {
    setBusy(true); setMessage('');
    try {
      const r = await fetch('/api/setup/jev/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const d: { ok: boolean; detail?: string; health?: string } = await r.json();
      setOk(r.ok && d.ok);
      setMessage(d.detail || d.health || (lang === 'id' ? 'Uji Jev gagal.' : 'Jev test failed.'));
    } catch {
      setOk(false);
      setMessage(lang === 'id' ? 'Meja tidak terjangkau.' : 'Office not reachable.');
    } finally { setBusy(false); }
  };

  if (!info) return <p className="wallet-note">{message || t('setupJevLoading')}</p>;

  return (
    <section className="setup-models" aria-label="Jev intelligence">
      <div className="pane-header">
        <h3>{t('setupJevTitle')}</h3>
        <p className="wallet-note">{t('setupJevNote')}</p>
      </div>
      <dl className="setup-summary">
        <div><dt>{t('setupJevStatus')}</dt><dd>{info.health}</dd></div>
        <div><dt>{t('setupJevProviderLabel')}</dt><dd>{info.provider} · {info.model}</dd></div>
        <div><dt>{t('setupJevMode')}</dt><dd>{info.mode}</dd></div>
        <div><dt>{t('setupJevOpenrouterSet')}</dt><dd>{info.openrouterKeySet ? t('setupJevKeyPresent') : t('setupJevKeyMissing')}</dd></div>
        <div><dt>{t('setupJevDedicatedSet')}</dt><dd>{info.dedicatedKeySet ? t('setupJevKeyPresent') : t('setupJevKeyMissing')}</dd></div>
      </dl>
      <form autoComplete="off" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label><input type="checkbox" disabled={!available || busy} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {t('setupJevEnable')}</label>
        <div className="wallet-pick">
          <label>{t('setupJevMode')}
            <select aria-label="Jev mode" disabled={!available || busy || !enabled} value={mode} onChange={(e) => setMode(e.target.value as 'off' | 'shadow' | 'assist')}>
              <option value="shadow">{t('setupJevModeShadow')}</option>
              <option value="assist">{t('setupJevModeAssist')}</option>
            </select>
          </label>
        </div>
        <label><span>{t('setupJevKeyLabel')}</span>
          <input aria-label="Jev OpenRouter API key" type="password" disabled={!available || busy} autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        {info.liveAssistBlocked && <p className="wallet-msg bad">{t('setupJevLiveAssistBlocked')}</p>}
        <p className="field-help">{t('setupJevHelp')}</p>
        <button type="submit" disabled={!available || busy}>{busy ? t('setupJevSaving') : t('setupJevSave')}</button>
        <button type="button" disabled={!available || busy || !enabled} onClick={() => void test()}>{t('setupJevTest')}</button>
      </form>
      {message && <p className={`wallet-msg ${ok ? 'ok' : 'bad'}`}>{message}</p>}
    </section>
  );
}
