import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

interface Policy { enabled: boolean; mcpTools: Record<string, string[]> }
interface Connection { name: string; enabled: boolean; authStatus: string; status: string }
export function CodexResearchSetup({ available }: { available: boolean }) {
  const { lang } = useI18n();
  const [loaded, setLoaded] = useState<Policy | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [tools, setTools] = useState<Record<string, string>>({});
  const [connections, setConnections] = useState<Connection[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const restore = (policy: Policy) => { setEnabled(policy.enabled); setTools(Object.fromEntries(Object.entries(policy.mcpTools).map(([name, names]) => [name, names.join(', ')]))); };
  const refresh = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/setup/local-agents/research');
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.detail || 'Connections unavailable');
      setLoaded(result.policy); restore(result.policy); setConnections(result.connections);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Connections unavailable'); }
    finally { setBusy(false); }
  };
  useEffect(() => { void refresh(); }, []);
  const save = async () => {
    setBusy(true);
    const policy: Policy = { enabled, mcpTools: Object.fromEntries(Object.entries(tools).map(([name, value]) => [name, value.split(',').map(tool => tool.trim()).filter(Boolean)]).filter(([, value]) => value.length)) };
    try {
      const response = await fetch('/api/setup/local-agents/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(policy) });
      const result = await response.json(); setMessage(result.detail || result.error);
      if (response.ok && result.ok) { setLoaded(policy); restore(policy); }
    } catch { setMessage('Office not reachable'); }
    finally { setBusy(false); }
  };
  return <div className="codex-research-settings">
    <div>
      <p className="wallet-note">{lang === 'id' ? 'Aktifkan pencarian web live dan MCP riset meja trading: market, berita, on-chain, akun, dan pengumpulan data melalui Jev.' : 'Enable live web search and the desk research MCP: market, news, on-chain observations, account data, and Jev-directed collection.'}</p>
      <label><input type="checkbox" checked={enabled} disabled={!available || busy || !loaded} onChange={event => setEnabled(event.target.checked)} /> {lang === 'id' ? 'Akses riset untuk agent Codex' : 'Research access for Codex agents'}</label>
      <p className="wallet-note small">{lang === 'id' ? 'Sambungan tambahan di bawah terdeteksi dari akun Codex. Isi hanya nama tools baca yang ingin diizinkan, dipisahkan koma. Terdeteksi tidak berarti sudah teruji live.' : 'Additional connections below are detected from the Codex account. Enter only the read tool names to permit, separated by commas. Detected does not mean verified live.'}</p>
      {connections.filter(connection => !['supabase', 'rea'].includes(connection.name.toLowerCase())).map(connection => <label key={connection.name} style={{ display: 'block', marginTop: 8 }}>
        {connection.name} <span className="badge">{lang === 'id' ? 'Terdeteksi, belum diuji' : 'Detected, not verified'}</span>
        <input aria-label={`${connection.name} permitted research tools`} value={tools[connection.name] || ''} disabled={!available || busy || !loaded} placeholder={lang === 'id' ? 'Nama tools baca, pisahkan koma' : 'Read tool names, comma separated'} onChange={event => setTools(old => ({ ...old, [connection.name]: event.target.value }))} />
      </label>)}
    </div>
    <div className="setup-nav">
      <button type="button" disabled={!available || busy || !loaded} onClick={() => void save()}>{lang === 'id' ? 'Simpan akses' : 'Save access'}</button>
      <button type="button" disabled={busy || !loaded} onClick={() => loaded && restore(loaded)}>{lang === 'id' ? 'Batal' : 'Cancel'}</button>
      <button type="button" disabled={busy} onClick={() => void refresh()}>{lang === 'id' ? 'Segarkan' : 'Refresh'}</button>
    </div>
    {message && <p className="wallet-note" role="status">{message}</p>}
  </div>;
}
