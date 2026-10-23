import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { CodexResearchSetup } from './CodexResearchSetup';
import { DataSourcesSetup } from './DataSourcesSetup';

interface LocalAgent { id: string; label: string; installed: boolean; docs: string; loginCommand: string; hint: string }
export function LocalAgentsSetup({ available }: { available: boolean }) {
  const { t, lang } = useI18n();
  const [tab, setTab] = useState<'connect' | 'supervisor'>('connect');
  const [agents, setAgents] = useState<LocalAgent[]>([]);
  const [message, setMessage] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const [waiting, setWaiting] = useState<Record<string, number>>({});
  const status = async (id: string, verify = false) => {
    const response = await fetch('/api/setup/local-agents/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, verify }) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error('Unable to check sign-in.');
    return result as { connected: boolean; state: string };
  };
  const load = () => fetch('/api/setup/local-agents').then((r) => r.json()).then((d) => { if (d.ok) setAgents(d.agents); }).catch(() => setMessage({ load: lang === 'id' ? 'Gagal mendeteksi agen lokal. Coba Segarkan.' : 'Unable to detect local agents. Try Refresh.' }));
  useEffect(() => { void load(); }, [lang]);
  useEffect(() => {
    if (Object.keys(waiting).length === 0) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      for (const [id, started] of Object.entries(waiting)) {
        try {
          const result = await status(id, true);
          if (cancelled) return;
          const expired = Date.now() - started > 300_000;
          if (result.connected || result.state === 'failed' || result.state === 'missing' || expired) {
            setWaiting((old) => { const next = { ...old }; delete next[id]; return next; });
            if (result.connected) {
              setConnected((old) => ({ ...old, [id]: true }));
              setMessage((old) => ({ ...old, [id]: lang === 'id' ? 'Connected. Akun agen siap digunakan. Test connection menguji balasan model dan memakai kuota.' : 'Connected. The agent account is ready. Test connection checks a model reply and uses quota.' }));
            } else setMessage((old) => ({ ...old, [id]: lang === 'id' ? 'Login belum berhasil. Coba Open sign-in lagi setelah menutup terminal login sebelumnya.' : 'Sign-in was not confirmed. Close the previous login terminal and try Open sign-in again.' }));
          }
        } catch {
          if (!cancelled) setMessage((old) => ({ ...old, [id]: lang === 'id' ? 'Belum dapat memeriksa login. Mencoba lagi...' : 'Unable to check sign-in. Retrying...' }));
          if (Date.now() - started > 300_000 && !cancelled) setWaiting((old) => { const next = { ...old }; delete next[id]; return next; });
        }
      }
      if (!cancelled) setWaiting((old) => ({ ...old }));
    }, 3000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [waiting, agents, lang]);
  async function action(agent: LocalAgent, type: 'login' | 'test') {
    setVerified((old) => ({ ...old, [agent.id]: false }));
    if (type === 'login') setConnected((old) => ({ ...old, [agent.id]: false }));
    setBusy(agent.id); setMessage((old) => ({ ...old, [agent.id]: type === 'test' ? (lang === 'id' ? 'Menguji respon model. Memakai akun dan kuota milik agen sendiri...' : 'Testing a model reply. This uses the agent’s own account and quota...') : (lang === 'id' ? 'Membuka login...' : 'Opening sign-in...') }));
    try {
      const r = await fetch(`/api/setup/local-agents/${type}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(type === 'login' ? { id: agent.id } : { model: `${agent.id}:default` }) });
      const d = await r.json(); setMessage((old) => ({ ...old, [agent.id]: d.detail || d.error })); if (type === 'test') setVerified((old) => ({ ...old, [agent.id]: r.ok && d.ok }));
      if (type === 'login' && r.ok && d.ok) setWaiting((old) => ({ ...old, [agent.id]: Date.now() }));
    } catch { setMessage((old) => ({ ...old, [agent.id]: lang === 'id' ? 'Meja trading tidak terjangkau. Coba lagi.' : 'Office not reachable. Try again.' })); } finally { setBusy(null); }
  }
  return (
    <div className="local-agents">
      <div className="local-agents-tabs" role="tablist" aria-label="Agent connection options">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'connect'}
          className={`local-agent-tab-btn ${tab === 'connect' ? 'active' : ''}`}
          onClick={() => setTab('connect')}
        >
          {t('connectAgentTab')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'supervisor'}
          className={`local-agent-tab-btn ${tab === 'supervisor' ? 'active' : ''}`}
          onClick={() => setTab('supervisor')}
        >
          {t('externalSupervisorTab')}
        </button>
      </div>

      {tab === 'connect' ? (
        <div className="local-agent-pane" role="tabpanel">
          <div className="local-agent-pane-head">
            <p className="wallet-note">{t('setupLocalSignInNote')}</p>
            <button type="button" onClick={() => void load()}>{t('setupLocalRefreshBtn')}</button>
          </div>
          {message.load && <p role="status">{message.load}</p>}
          <div className="local-agent-list">
            <CodexResearchSetup available={available} />
            <DataSourcesSetup available={available} />
            {agents.map((a) => (
              <section key={a.id} className="local-agent-row">
                <div>
                  <b>{a.label}</b>{' '}
                  <span className="badge">{verified[a.id] ? t('setupLocalVerifiedBadge') : connected[a.id] ? 'Connected' : waiting[a.id] ? (lang === 'id' ? 'Menunggu login...' : 'Waiting for sign-in...') : a.installed ? t('setupLocalInstalledBadge') : t('setupLocalNotOnPathBadge')}</span>
                  <p className="wallet-note small">{a.hint} <a href={a.docs} target="_blank" rel="noreferrer">Install / docs</a></p>
                  <code>{a.loginCommand}</code>
                </div>
                <div className="setup-nav">
                  <button type="button" disabled={!available || !a.installed || !!busy || !!waiting[a.id] || !!connected[a.id]} onClick={() => void action(a, 'login')}>{connected[a.id] ? 'Connected' : waiting[a.id] ? (lang === 'id' ? 'Menunggu login...' : 'Waiting for sign-in...') : t('setupLocalOpenSignInBtn')}</button>
                  <button type="button" disabled={!available || !a.installed || !!busy || !!waiting[a.id] || !connected[a.id]} onClick={() => void action(a, 'test')}>{busy === a.id ? (lang === 'id' ? 'Bekerja...' : 'Working...') : t('setupLocalTestConnBtn')}</button>
                </div>
                {message[a.id] && <p className="wallet-note" role="status">{message[a.id]}</p>}
              </section>
            ))}
          </div>
        </div>
      ) : (
        <div className="local-agent-pane" role="tabpanel">
          <p className="wallet-note">{t('setupLocalSupervisorDesc')}</p>
          <p className="wallet-note">{lang === 'id' ? 'Untuk Antigravity atau agen desktop lainnya, berikan instruksi ini di komputer meja trading:' : 'For Antigravity or another desktop agent, give it this instruction on the desk computer:'}</p>
          <pre className="supervisor-instructions">Supervise Trading Agent Mpu Gandring. Read http://127.0.0.1:8787/api/health, /api/state and /api/reports. Report missing stops, loss caps, stale prices and errors. Do not open, close or resize orders; change modes or guards; read keys; or release the kill switch. Follow AGENTS.md in the project for the full supervisor protocol.</pre>
        </div>
      )}
    </div>
  );
}
