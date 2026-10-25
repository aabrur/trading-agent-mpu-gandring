import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

interface Choice { id: string; label: string; tags: string[] }
interface Preset { id: string; label: string; description: string; defaultProvider: string; defaultModel: string; agents: Record<string, Selection> }
interface Selection { provider: string; model: string }
interface Provider { provider: string; keyEnv: string | null; keySet: boolean; source: string; defaultModel: string; models: Choice[] }
interface ReasoningStatus { requested: string | null; effective: string | null; supported: string[]; status: string }
interface ModelsInfo { defaultReasoning?: string | null; ok: boolean; checkedOn: string; usageSource: { url: string; asOf: string; period: string }; presets?: Preset[]; providers: Provider[]; defaultProvider: string; defaultModel: string; agents: (Selection & { id: string; custom: boolean; reasoning?: string | null; reasoningStatus?: ReasoningStatus })[]; runningAgents?: (Selection & { id: string })[] }

export function ModelsSetup({ available, appMode }: { available: boolean; appMode: string }) {
  const { t, lang } = useI18n();
  const [info, setInfo] = useState<ModelsInfo | null>(null);
  const [selection, setSelection] = useState<Selection>({ provider: 'mock', model: 'mock-desk-v1' });
  const [agents, setAgents] = useState<Record<string, Selection>>({});
  const [custom, setCustom] = useState(false);
  const [defaultReasoning, setDefaultReasoning] = useState('');
  const [reasoning, setReasoning] = useState<Record<string, string | null>>({});
  const [search, setSearch] = useState<Record<string, string>>({});
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [ok, setOk] = useState(false);
  const [editing, setEditing] = useState(false);
  function restore(d: ModelsInfo) {
    setDefaultReasoning(d.defaultReasoning || '');
    setReasoning(Object.fromEntries(d.agents.map(a => [a.id, a.reasoning ?? null])));
    setSelection({ provider: d.defaultProvider, model: d.defaultModel });
    setAgents(Object.fromEntries(d.agents.map((a) => [a.id, { provider: a.provider, model: a.model }])));
    setCustom(d.agents.some((a) => a.custom)); setKeys({});
  }

  const load = async () => {
    try {
      const r = await fetch('/api/setup/models');
      const d: ModelsInfo = await r.json();
      if (!r.ok || !d.ok) throw new Error('unavailable');
      setInfo(d); restore(d);
    } catch { setMessage(lang === 'id' ? 'Pengaturan model tidak tersedia. Buka kembali Pengaturan untuk mencoba lagi.' : 'Model setup is unavailable. Reopen Setup to try again.'); setOk(false); }
  };
  useEffect(() => { if (appMode !== 'grokbot') void load(); }, [appMode]);

  useEffect(() => {
    const refresh = () => { if (!editing) void load(); else void fetch('/api/setup/models').then(r => r.json()).then(d => { if (d.ok) setInfo(d); }); };
    window.addEventListener('mpu-models-updated', refresh);
    return () => window.removeEventListener('mpu-models-updated', refresh);
  }, [editing, appMode]);

  if (appMode === 'grokbot') return <p className="wallet-note">{t('setupModelsGrokbotNote')}</p>;
  if (!info) return <p className="wallet-note">{message || t('setupModelsLoading')}</p>;
  const provider = (p: string) => info.providers.find((v) => v.provider === p)!;
  const used = [...new Set([selection.provider, ...(custom ? Object.values(agents).map((a) => a.provider) : [])])];
  const controls = (value: Selection, change: (s: Selection) => void, label: string) => <div className="wallet-pick">
    <label>{label} {t('setupModelsProviderLabel')} <select aria-label={`${label} provider`} disabled={!available || busy} value={value.provider} onChange={(e) => change({ provider: e.target.value, model: provider(e.target.value).defaultModel })}>
      {info.providers.map((p) => <option key={p.provider} value={p.provider}>{p.provider === 'mock' ? t('setupModelsOfflineDemo') : p.provider === 'local' ? t('setupModelsAgentOnComputer') : p.provider}</option>)}
    </select></label>
    {value.provider === 'local' && <label>{label} {t('setupModelsAgentLabel')} <select aria-label={`${label} local agent`} disabled={!available || busy} value={value.model.split(':')[0]} onChange={(e) => change({ provider: 'local', model: `${e.target.value}:default` })}>
      {[...new Set(provider('local').models.map((m) => m.id.split(':')[0]))].map((id) => <option key={id} value={id}>{provider('local').models.find((m) => m.id.startsWith(`${id}:`))!.label.split(':')[0]}</option>)}
    </select></label>}
    <label>{lang === 'id' ? 'Cari model' : 'Search models'}<input value={search[label] || ''} onChange={e => setSearch(old => ({...old, [label]: e.target.value}))} /></label>
    <label>{label} {t('setupModelsModelLabel')} <select aria-label={`${label} model`} disabled={!available || busy} value={value.model} onChange={(e) => change({ ...value, model: e.target.value })}>
      {provider(value.provider).models.filter(m => m.id === value.model || !search[label] || `${m.id} ${m.label}`.toLowerCase().includes(search[label].toLowerCase())).filter((m) => value.provider !== 'local' || m.id.split(':')[0] === value.model.split(':')[0]).map((m) => <option key={m.id} value={m.id}>{m.label} · {m.tags.join(', ')}</option>)}
      {value.provider === 'local' && !provider('local').models.some((model) => model.id === value.model) && <option value={value.model}>{value.model} · {lang === 'id' ? 'ID model manual' : 'Manual model ID'}</option>}
    </select></label>
    {value.provider === 'local' && <label>{label} {lang === 'id' ? 'ID model CLI' : 'CLI model ID'}
      <input aria-label={`${label} CLI model ID`} disabled={!available || busy} value={value.model.slice(value.model.indexOf(':') + 1)} spellCheck={false} autoComplete="off" onChange={(e) => change({ ...value, model: `${value.model.split(':')[0]}:${e.target.value}` })} />
      <small className="field-help">{lang === 'id' ? 'Gunakan default atau ID persis dari CLI agen. Akses dan kuota mengikuti akun agen.' : 'Use default or the exact model ID from the agent CLI. Access and quota depend on that account.'}</small>
    </label>}
  </div>;

  async function save() {
    setBusy(true); setMessage('');
    try {
      const r = await fetch('/api/setup/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ defaultReasoning: defaultReasoning || null, reasoning, defaultProvider: selection.provider, defaultModel: selection.model, ...(custom ? { agents } : {}), keys: Object.fromEntries(Object.entries(keys).filter(([p]) => used.includes(p))) }) });
      const d: { ok: boolean; detail?: string; error?: string } = await r.json();
      setOk(r.ok && d.ok); setMessage(d.detail || d.error || (lang === 'id' ? 'Gagal menyimpan pilihan model.' : 'Unable to save model choices.'));
      if (r.ok && d.ok) { await load(); setEditing(false); }
    } catch { setOk(false); setMessage(lang === 'id' ? 'Meja trading tidak terjangkau. Pilihan model gagal dikonfirmasi.' : 'Office not reachable. Model choices were not confirmed saved.'); }
    finally { setKeys({}); setBusy(false); }
  }

  return <section className="setup-models">
    {info.runningAgents && info.agents.some((saved) => { const active = info.runningAgents!.find((agent) => agent.id === saved.id); return active && (active.provider !== saved.provider || active.model !== saved.model); }) && <p className="wallet-msg" role="status">{lang === 'id' ? 'Pilihan tersimpan berbeda dari agen yang sedang berjalan. Klik Edit models lalu Save untuk menerapkannya.' : 'Saved choices differ from the running agents. Click Edit models, then Save to apply them.'}</p>}
    {!editing && <><div className="setup-section-actions"><p className="wallet-note">{lang === 'id' ? 'Pilihan provider tersimpan. API key yang sudah ada tetap aman di komputer ini.' : 'Saved provider choices. Existing API keys stay on this computer.'}</p><button disabled={!available} onClick={() => { setMessage(''); setEditing(true); }}>{t('setupModelsEditBtn')}</button></div><dl className="setup-summary"><div><dt>Default</dt><dd>{info.defaultProvider} · {info.defaultModel}</dd></div>{info.agents.map((a) => <div key={a.id}><dt>{a.id}</dt><dd>{a.provider} · {a.model}</dd></div>)}</dl><p className="field-help">{info.providers.filter((p) => p.keyEnv && p.keySet).map((p) => p.provider).join(', ') || (lang === 'id' ? 'Tidak ada API key provider' : 'No provider API keys')}: {lang === 'id' ? 'key tersimpan tetap disembunyikan. Agen lokal memakai login mandiri.' : 'saved keys remain hidden. Local agents keep their own sign-in.'}</p></>}
    <form hidden={!editing} autoComplete="off" onChange={() => setMessage('')} onSubmit={(e) => { e.preventDefault(); void save(); }}>
    <p className="wallet-note">{lang === 'id' ? `Katalog API ${info.checkedOn}: 10 provider dengan 20 model masing-masing. CLI lokal memakai model bawaan, cache katalog Codex bila tersedia, atau ID model manual.` : `API catalog ${info.checkedOn}: 10 providers with 20 models each. Local CLIs use configured defaults, the Codex catalog cache when available, or a manual model ID.`}</p>
    {info.presets && info.presets.length > 0 && <div className="setup-presets" style={{ marginBottom: '1rem', padding: '0.75rem', background: 'var(--panel-subtle, rgba(255,255,255,0.03))', borderRadius: '6px' }}>
      <p style={{ margin: '0 0 0.5rem 0', fontWeight: 600 }}>{lang === 'id' ? 'Preset Stack Model Rekomendasi' : 'Recommended Model Stack Presets'}</p>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {info.presets.map((preset) => <button key={preset.id} type="button" disabled={!available || busy} onClick={() => {
          setSelection({ provider: preset.defaultProvider, model: preset.defaultModel });
          setAgents(Object.fromEntries(Object.entries(preset.agents).map(([id, sel]) => [id, { provider: sel.provider, model: sel.model }])));
          setCustom(true);
          setMessage(lang === 'id' ? `Preset ${preset.label} dimuat. Klik Simpan untuk menerapkan.` : `Loaded ${preset.label}. Click Save to apply.`);
          setOk(true);
        }} title={preset.description}>
          {preset.label}
        </button>)}
      </div>
      <small className="field-help" style={{ display: 'block', marginTop: '0.5rem' }}>{lang === 'id' ? 'Kandidat berbasis benchmark, bukan jaminan profitabilitas trading. Klik Simpan untuk menerapkan.' : 'Benchmark-informed candidates, not a guarantee of trading profitability. Click Save to apply.'}</small>
    </div>}
    {controls(selection, setSelection, 'Default')}
    <label>{lang === 'id' ? 'Reasoning default' : 'Default reasoning'}<select value={defaultReasoning} disabled={!available || busy} onChange={e => setDefaultReasoning(e.target.value)}><option value="">Native default</option>{['low', 'med', 'high', 'xhigh', 'max'].map((level, i) => <option key={level} value={level}>{['Low', 'Medium', 'High', 'XHigh', 'Max'][i]}</option>)}</select></label>
    {info.agents.map(a => <label key={`reasoning-${a.id}`}>{a.id} reasoning<select disabled={!available || busy} value={reasoning[a.id] || ''} onChange={e => setReasoning(old => ({...old, [a.id]: e.target.value || null}))}><option value="">{lang === 'id' ? 'Ikuti default' : 'Inherit default'}</option>{['low', 'med', 'high', 'xhigh', 'max'].map((level, i) => <option key={level} value={level}>{['Low', 'Medium', 'High', 'XHigh', 'Max'][i]}</option>)}</select><small>{a.reasoningStatus?.status} · requested: {a.reasoningStatus?.requested || 'native'} · effective: {a.reasoningStatus?.effective || 'native / unverified'} · supported: {a.reasoningStatus?.supported.join(', ') || 'native default'}</small></label>)}
    <label><input type="checkbox" disabled={!available || busy} checked={custom} onChange={(e) => { setCustom(e.target.checked); if (e.target.checked) setAgents(Object.fromEntries(info.agents.map((a) => [a.id, { ...selection }]))); }} /> {lang === 'id' ? 'Kustomisasi provider dan model untuk tiap agen' : 'Customize provider and model for each agent'}</label>
    {custom && info.agents.map((a) => <div key={a.id}>{controls(agents[a.id], (s) => setAgents((prev) => ({ ...prev, [a.id]: s })), a.id)}</div>)}
    <div className="setup-keys">
      {used.filter((p) => provider(p).keyEnv).map((p) => <label key={p}><span>{p} API key <code>{provider(p).keyEnv}</code> · {provider(p).keySet ? (lang === 'id' ? 'tersimpan, kosongkan bila tidak diganti' : 'set, leave blank to keep') : (lang === 'id' ? 'belum diatur, agen memakai mock' : 'not set, agents use mock until added')}</span>
        <input aria-label={`${p} API key`} type="password" disabled={!available || busy} autoComplete="off" spellCheck={false} value={keys[p] || ''} onChange={(e) => setKeys((prev) => ({ ...prev, [p]: e.target.value }))} />
      </label>)}
    </div>
    <p className="wallet-note small">{lang === 'id' ? 'Satu API key per provider dapat digunakan untuk keenam agen dengan model berbeda. Agen lokal memakai akun login bawaan mereka.' : 'One API key per provider can serve all six agents with different models. Local agents reuse their own sign-in and configured model; account limits still apply.'}</p>
    <p className="wallet-note small">{lang === 'id' ? 'Pilihan tier gratis bergantung pada kuota akun masing-masing. Model yang sama bisa dikenakan biaya jika kuota habis.' : 'Free tier choices depend on account eligibility and quota. The same model can be billed on a paid tier. Providers without confirmed free API models have no free choices listed.'}</p>
    <p className="wallet-note small">Source: <a href={info.usageSource.url} target="_blank" rel="noreferrer">OpenRouter</a>, as of {info.usageSource.asOf} over {info.usageSource.period}. Token ranks measure OpenRouter traffic. Model and pricing sources: {used.filter((p) => p !== 'mock').map((p) => <a key={p} href={provider(p).source} target="_blank" rel="noreferrer">{p} </a>)}</p>
    <button type="submit" disabled={!available || busy}>{busy ? (lang === 'id' ? 'Menyimpan...' : 'Saving...') : custom ? t('setupModelsSaveBtn') : (lang === 'id' ? 'Gunakan provider dan model default untuk semua agen' : 'Use default provider and model for all agents')}</button>
    <button type="button" disabled={busy} onClick={() => { restore(info); setEditing(false); setMessage(''); }}>{t('setupDeskCancelBtn')}</button>
    </form>
    {message && <p className={`wallet-msg ${ok ? 'ok' : 'bad'}`} role="status">{message}</p>}
  </section>;
}
