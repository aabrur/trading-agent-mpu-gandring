import { useEffect, useState } from 'react';
import { officeFetch as fetch } from '../officeApi';
import { useI18n } from '../i18n';

interface JevModelOption {
  id: string;
  label: string;
  tier: 'top_usage' | 'top_tier';
  weeklyTokens: string;
  latency: string;
  pricePerM: string;
}

const FALLBACK_JEV_MODELS: JevModelOption[] = [
  { id: 'typesafe/jev-1.13', label: 'TypeSafe: Jev 1.13 (3.09T tokens · 131ms · $0.042/M)', tier: 'top_usage', weeklyTokens: '3.09T', latency: '131ms', pricePerM: '$0.042' },
  { id: 'openai/gpt-6-luna-decisions', label: 'OpenAI: GPT-6 Luna Decisions (129B tokens · 683ms · $0.10/M)', tier: 'top_usage', weeklyTokens: '129B', latency: '683ms', pricePerM: '$0.10' },
  { id: 'microsoft/microsoft-decision-1', label: 'Microsoft: Microsoft-Decision-1 (38.3B tokens · 308ms · $0.042/M)', tier: 'top_usage', weeklyTokens: '38.3B', latency: '308ms', pricePerM: '$0.042' },
  { id: 'cloudflare/clef-flash', label: 'Cloudflare: Clef Flash (29.8B tokens · 402ms · $0.019/M)', tier: 'top_usage', weeklyTokens: '29.8B', latency: '402ms', pricePerM: '$0.019' },
  { id: 'liquid/d1', label: 'LiquidAI: d1 (27.1B tokens · 168ms · $0.02/M)', tier: 'top_usage', weeklyTokens: '27.1B', latency: '168ms', pricePerM: '$0.02' },
  { id: 'typesafe/jev-1.14', label: 'TypeSafe: Jev 1.14 (2.31T tokens · 127ms · $0.042/M)', tier: 'top_tier', weeklyTokens: '2.31T', latency: '127ms', pricePerM: '$0.042' },
  { id: 'nace-ai/drex-v1.5', label: 'Nace.AI: Drex v1.5 (26.2B tokens · 196ms · $0.04/M)', tier: 'top_tier', weeklyTokens: '26.2B', latency: '196ms', pricePerM: '$0.04' },
  { id: 'nace-ai/drex-v2.0', label: 'Nace.AI: Drex v2.0 (12.9B tokens · 337ms · $0.06/M)', tier: 'top_tier', weeklyTokens: '12.9B', latency: '337ms', pricePerM: '$0.06' },
  { id: 'cloudflare/clef', label: 'Cloudflare: Clef (12.4B tokens · 760ms · $0.192/M)', tier: 'top_tier', weeklyTokens: '12.4B', latency: '760ms', pricePerM: '$0.192' },
  { id: 'cloudflare/clef-omni', label: 'Cloudflare: Clef Omni (2.67B tokens · 211ms · $0.15/M)', tier: 'top_tier', weeklyTokens: '2.67B', latency: '211ms', pricePerM: '$0.15' }
];

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
  models?: JevModelOption[];
  dataCollection?: { routedBy: string; route: string; completedAt: number; routing: { status: string; reason: string | null }; feeds: Record<string, { status: string }> } | null;
}

export function JevSetup({ available }: { available: boolean }) {
  const { t, lang } = useI18n();
  const [info, setInfo] = useState<JevInfo | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<'off' | 'shadow' | 'assist'>('shadow');
  const [model, setModel] = useState('typesafe/jev-1.14');
  const [models, setModels] = useState<JevModelOption[]>(FALLBACK_JEV_MODELS);
  const [allowLive, setAllowLive] = useState(false);
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
      if (d.model) setModel(d.model);
      if (Array.isArray(d.models) && d.models.length > 0) setModels(d.models);
      setAllowLive(!!d.allowLive);
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
      const r = await fetch('/api/setup/jev', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled, mode, model, allowLive, ...(key.trim() ? { key: key.trim() } : {}) }) });
      const d: JevInfo = await r.json();
      setOk(r.ok && d.ok);
      setMessage(d.detail || (lang === 'id' ? 'Gagal menyimpan Jev.' : 'Unable to save Jev settings.'));
      if (r.ok && d.ok) { setInfo(d); if (d.model) setModel(d.model); if (Array.isArray(d.models) && d.models.length > 0) setModels(d.models); setKey(''); }
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
      <p className="wallet-note">{lang === 'id' ? 'Jev juga dapat memprioritaskan pengumpulan data; backend menjalankan kolektor dan perhitungan.' : 'Jev can also prioritize data acquisition; the backend runs the collectors and calculations.'}</p>
      {info.dataCollection && <div className="wallet-note" role="status">
        <p>{lang === 'id' ? 'Pengumpulan terakhir' : 'Last collection'}: {info.dataCollection.routedBy} · {info.dataCollection.route} · {new Date(info.dataCollection.completedAt).toLocaleString()}</p>
        <p>{Object.entries(info.dataCollection.feeds).map(([name, feed]) => `${name}: ${feed.status}`).join(' · ')}</p>
        {info.dataCollection.routing.reason && <p>{info.dataCollection.routing.reason}</p>}
      </div>}
      <form className="setup-keys" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <label className="setup-check"><input type="checkbox" disabled={!available || busy} checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> {t('setupJevEnable')}</label>
        <div className="wallet-pick">
          <label>{t('setupJevMode')}
            <select aria-label="Jev mode" disabled={!available || busy || !enabled} value={mode} onChange={(e) => setMode(e.target.value as 'off' | 'shadow' | 'assist')}>
              <option value="off">{t('setupJevModeOff')}</option>
              <option value="shadow">{t('setupJevModeShadow')}</option>
              <option value="assist">{t('setupJevModeAssist')}</option>
            </select>
          </label>
          <label>{lang === 'id' ? 'Model AI Decision' : 'AI Decision model'}
            <select aria-label="Jev decision model" disabled={!available || busy || !enabled} value={model} onChange={(e) => setModel(e.target.value)}>
              <optgroup label="Top Token Usage (OpenRouter Decisions)">
                {models.filter((m) => m.tier === 'top_usage').map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </optgroup>
              <optgroup label="Top Tier (OpenRouter Decisions)">
                {models.filter((m) => m.tier === 'top_tier').map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </optgroup>
            </select>
          </label>
        </div>
        <label><span>{t('setupJevKeyLabel')}</span>
          <input aria-label="Jev OpenRouter API key" type="password" disabled={!available || busy} autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        {info.liveAssistBlocked && <p className="wallet-msg bad">{t('setupJevLiveAssistBlocked')}</p>}
        <label className="setup-check"><input type="checkbox" disabled={!available || busy || !enabled} checked={allowLive} onChange={(e) => {
          if (e.target.checked) {
            const ok = window.confirm(lang === 'id'
              ? 'Otorisasi LIVE ASSIST? Jev dapat memperkaya analisis LIVE. Jev tidak menempatkan order dan tidak mengubah batas risiko.'
              : 'Authorize LIVE ASSIST? Jev may enrich LIVE analysis. Jev will not place orders or change risk limits.');
            if (!ok) return;
          }
          setAllowLive(e.target.checked);
        }} /> {t('setupJevAllowLive')}</label>
        <p className="field-help">{t('setupJevAllowLiveHelp')}</p>
        <p className="field-help">{t('setupJevHelp')}</p>
        <div className="setup-actions">
          <button type="submit" disabled={!available || busy}>{busy ? t('setupJevSaving') : t('setupJevSave')}</button>
          <button type="button" disabled={!available || busy || !enabled} onClick={() => void test()}>{t('setupJevTest')}</button>
        </div>
      </form>
      {message && <p className={`wallet-msg ${ok ? 'ok' : 'bad'}`}>{message}</p>}
    </section>
  );
}
