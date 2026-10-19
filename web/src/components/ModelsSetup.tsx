import { useEffect, useState } from 'react';

interface Choice { id: string; label: string; tags: string[] }
interface Selection { provider: string; model: string }
interface Provider { provider: string; keyEnv: string | null; keySet: boolean; source: string; defaultModel: string; models: Choice[] }
interface ModelsInfo { ok: boolean; checkedOn: string; usageSource: { url: string; asOf: string; period: string }; providers: Provider[]; defaultProvider: string; defaultModel: string; agents: (Selection & { id: string; custom: boolean })[] }

export function ModelsSetup({ available, appMode }: { available: boolean; appMode: string }) {
  const [info, setInfo] = useState<ModelsInfo | null>(null);
  const [selection, setSelection] = useState<Selection>({ provider: 'mock', model: 'mock-desk-v1' });
  const [agents, setAgents] = useState<Record<string, Selection>>({});
  const [custom, setCustom] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [ok, setOk] = useState(false);
  const [editing, setEditing] = useState(false);
  function restore(d: ModelsInfo) {
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
    } catch { setMessage('Model setup is unavailable. Reopen Setup to try again.'); setOk(false); }
  };
  useEffect(() => { if (appMode !== 'grokbot') void load(); }, [appMode]);

  if (appMode === 'grokbot') return <p className="wallet-note">Grok Bot mode uses your external agents. Model providers are configured with those agents.</p>;
  if (!info) return <p className="wallet-note">{message || 'Loading model choices...'}</p>;
  const provider = (p: string) => info.providers.find((v) => v.provider === p)!;
  const used = [...new Set([selection.provider, ...(custom ? Object.values(agents).map((a) => a.provider) : [])])];
  const controls = (value: Selection, change: (s: Selection) => void, label: string) => <div className="wallet-pick">
    <label>{label} provider <select aria-label={`${label} provider`} disabled={!available || busy} value={value.provider} onChange={(e) => change({ provider: e.target.value, model: provider(e.target.value).defaultModel })}>
      {info.providers.map((p) => <option key={p.provider} value={p.provider}>{p.provider === 'mock' ? 'Offline demo' : p.provider === 'local' ? 'Agent on this computer' : p.provider}</option>)}
    </select></label>
    {value.provider === 'local' && <label>{label} agent <select aria-label={`${label} local agent`} disabled={!available || busy} value={value.model.split(':')[0]} onChange={(e) => change({ provider: 'local', model: `${e.target.value}:default` })}>
      {[...new Set(provider('local').models.map((m) => m.id.split(':')[0]))].map((id) => <option key={id} value={id}>{provider('local').models.find((m) => m.id.startsWith(`${id}:`))!.label.split(':')[0]}</option>)}
    </select></label>}
    <label>{label} model <select aria-label={`${label} model`} disabled={!available || busy} value={value.model} onChange={(e) => change({ ...value, model: e.target.value })}>
      {provider(value.provider).models.filter((m) => value.provider !== 'local' || m.id.split(':')[0] === value.model.split(':')[0]).map((m) => <option key={m.id} value={m.id}>{m.label} · {m.tags.join(', ')}</option>)}
    </select></label>
  </div>;

  async function save() {
    setBusy(true); setMessage('');
    try {
      const r = await fetch('/api/setup/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ defaultProvider: selection.provider, defaultModel: selection.model, ...(custom ? { agents } : {}), keys: Object.fromEntries(Object.entries(keys).filter(([p]) => used.includes(p))) }) });
      const d: { ok: boolean; detail?: string; error?: string } = await r.json();
      setOk(r.ok && d.ok); setMessage(d.detail || d.error || 'Unable to save model choices.');
      if (r.ok && d.ok) { await load(); setEditing(false); }
    } catch { setOk(false); setMessage('Office not reachable. Model choices were not confirmed saved.'); }
    finally { setKeys({}); setBusy(false); }
  }

  return <section className="setup-models">
    {!editing && <><div className="setup-section-actions"><p className="wallet-note">Saved provider choices. Existing API keys stay on this computer.</p><button disabled={!available} onClick={() => { setMessage(''); setEditing(true); }}>Edit models and providers</button></div><dl className="setup-summary"><div><dt>Default</dt><dd>{info.defaultProvider} · {info.defaultModel}</dd></div>{info.agents.map((a) => <div key={a.id}><dt>{a.id}</dt><dd>{a.provider} · {a.model}</dd></div>)}</dl><p className="field-help">{info.providers.filter((p) => p.keyEnv && p.keySet).map((p) => p.provider).join(', ') || 'No provider API keys'}: saved keys remain hidden. Local agents keep their own sign-in.</p></>}
    <form hidden={!editing} autoComplete="off" onChange={() => setMessage('')} onSubmit={(e) => { e.preventDefault(); void save(); }}>
    <p className="wallet-note">Curated {info.checkedOn}: 10 providers with 20 AI models each.</p>
    {controls(selection, setSelection, 'Default')}
    <label><input type="checkbox" disabled={!available || busy} checked={custom} onChange={(e) => { setCustom(e.target.checked); if (e.target.checked) setAgents(Object.fromEntries(info.agents.map((a) => [a.id, { ...selection }]))); }} /> Customize provider and model for each agent</label>
    {custom && info.agents.map((a) => <div key={a.id}>{controls(agents[a.id], (s) => setAgents((prev) => ({ ...prev, [a.id]: s })), a.id)}</div>)}
    <div className="setup-keys">
      {used.filter((p) => provider(p).keyEnv).map((p) => <label key={p}><span>{p} API key <code>{provider(p).keyEnv}</code> · {provider(p).keySet ? 'set, leave blank to keep' : 'not set, agents use mock until added'}</span>
        <input aria-label={`${p} API key`} type="password" disabled={!available || busy} autoComplete="off" spellCheck={false} value={keys[p] || ''} onChange={(e) => setKeys((prev) => ({ ...prev, [p]: e.target.value }))} />
      </label>)}
    </div>
    <p className="wallet-note small">One API key per provider can serve all six agents with different models. Local agents reuse their own sign-in and configured model; account limits still apply.</p>
    <p className="wallet-note small">Free tier choices depend on account eligibility and quota. The same model can be billed on a paid tier. Providers without confirmed free API models have no free choices listed.</p>
    <p className="wallet-note small">Source: <a href={info.usageSource.url} target="_blank" rel="noreferrer">OpenRouter</a>, as of {info.usageSource.asOf} over {info.usageSource.period}. Token ranks measure OpenRouter traffic. Model and pricing sources: {used.filter((p) => p !== 'mock').map((p) => <a key={p} href={provider(p).source} target="_blank" rel="noreferrer">{p} </a>)}</p>
    <button type="submit" disabled={!available || busy}>{busy ? 'Saving...' : custom ? 'Save provider and model choices' : 'Use default provider and model for all agents'}</button>
    <button type="button" disabled={busy} onClick={() => { restore(info); setEditing(false); setMessage(''); }}>Cancel</button>
    </form>
    {message && <p className={`wallet-msg ${ok ? 'ok' : 'bad'}`} role="status">{message}</p>}
  </section>;
}
