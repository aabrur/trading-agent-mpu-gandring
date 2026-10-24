import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { CodexResearchSetup } from './CodexResearchSetup';
import { DataSourcesSetup } from './DataSourcesSetup';

interface LocalAgent {
  id: string;
  bin: string;
  label: string;
  installed: boolean;
  docs: string;
  loginCommand: string;
  hint: string;
  models: string[];
}

interface AgentSettings {
  model?: string;
  effort?: string;
  provider?: string;
}

interface ExternalSupervisor {
  id: string;
  name: string;
  category: string;
  docs: string;
  summaryEn: string;
  summaryId: string;
  prompt: string;
}

const EXTERNAL_SUPERVISORS: ExternalSupervisor[] = [
  {
    id: 'grokbot',
    name: 'Grok Bot',
    category: 'xAI Bot Platform',
    docs: 'https://x.ai',
    summaryEn: 'Monitors the desk from your Grok Bot team chat without touching keys.',
    summaryId: 'Memantau meja trading dari obrolan tim Grok Bot kamu tanpa menyentuh kunci.',
    prompt: 'You are supervising Trading Agent Mpu Gandring on this machine. Read http://127.0.0.1:8787/api/health and /api/reports every 5-15 min. Check open positions, active stops on the exchange, daily loss cap, and equity safety net. Escalate immediately to the owner if any position lacks a stop loss or if health fails twice. Never execute or resize orders. Refer to AGENTS.md for full supervisor protocol.'
  },
  {
    id: 'claude_desktop',
    name: 'Claude Cowork / Claude Desktop',
    category: 'Anthropic Desktop App',
    docs: 'https://claude.ai',
    summaryEn: 'Supervises desk health and resting stops via desktop or cowork session.',
    summaryId: 'Memantau kesehatan meja dan stop loss via sesi desktop atau cowork.',
    prompt: 'Supervise Trading Agent Mpu Gandring on the local machine. Read http://127.0.0.1:8787/api/health, /api/state and /api/reports via web search or local HTTP GET. Ensure all active positions have stops resting on the exchange. If daily loss cap is 90% reached or kill switch is active, notify the owner immediately. Do not touch order keys, change modes, or place trades.'
  },
  {
    id: 'dot',
    name: 'Dot (New Computer)',
    category: 'Personal AI Companion',
    docs: 'https://new.computer',
    summaryEn: 'Personal AI companion keeping watch on trading limits and safety net.',
    summaryId: 'Asisten AI pribadi yang mengawasi batasan trading dan safety net.',
    prompt: 'You are monitoring the Trading Agent Mpu Gandring desk. Query http://127.0.0.1:8787/api/health and /api/reports periodically. Confirm office is alive, paper/testnet/live mode is steady, and stops are intact. Escalate to the user if safety net is breached or errors occur. Never modify trades.'
  },
  {
    id: 'muse_app',
    name: 'Muse (muse.ai app)',
    category: 'Web & Mobile Assistant',
    docs: 'https://muse.ai',
    summaryEn: 'Consumer app monitoring desk health reports and daily performance.',
    summaryId: 'Aplikasi konsumer yang memantau laporan kesehatan meja dan performa harian.',
    prompt: 'Supervise the local Trading Agent Mpu Gandring instance. Periodically review desk health via http://127.0.0.1:8787/api/health and latest trade verdicts at /api/reports. Send a brief summary of daily PnL, safety net margin, and resting stops to the owner. Never authorize or change trading orders.'
  },
  {
    id: 'chatgpt_agent',
    name: 'ChatGPT Agent',
    category: 'OpenAI Operator & Desktop',
    docs: 'https://chatgpt.com',
    summaryEn: 'Monitors desk state, drawdown limits, and alert triggers in real time.',
    summaryId: 'Memantau status meja, batas drawdown, dan trigger peringatan secara real-time.',
    prompt: 'Supervise Trading Agent Mpu Gandring. Use read-only web requests to http://127.0.0.1:8787/api/health and http://127.0.0.1:8787/api/reports. Verify alive status, exchange stops, and daily drawdown cap. Report anomalies immediately. Do not alter parameters or place trades.'
  },
  {
    id: 'manus',
    name: 'Manus',
    category: 'Autonomous General Agent',
    docs: 'https://manus.im',
    summaryEn: 'Autonomous workflow agent verifying stops and error recovery.',
    summaryId: 'Agen alur kerja otonom yang memverifikasi stop loss dan pemulihan error.',
    prompt: 'Supervise Trading Agent Mpu Gandring. Periodically poll http://127.0.0.1:8787/api/health and http://127.0.0.1:8787/api/state. Inspect portfolio equity, verify stops on venue, and check error counts. Alert if mode changes or stops are missing. Do not place or modify orders.'
  },
  {
    id: 'perplexity_comet',
    name: 'Perplexity Comet',
    category: 'Research & Macro Watch',
    docs: 'https://perplexity.ai',
    summaryEn: 'Macro-aware monitoring correlating desk performance with market alerts.',
    summaryId: 'Pemantauan makro yang menghubungkan performa meja dengan berita pasar.',
    prompt: 'Monitor Trading Agent Mpu Gandring status and macro context. Check http://127.0.0.1:8787/api/health and /api/reports. Cross-reference market anomalies with latest desk scan. Do not alter trading configuration or place orders.'
  }
];

export function LocalAgentsSetup({ available }: { available: boolean }) {
  const { t, lang } = useI18n();
  const [tab, setTab] = useState<'connect' | 'supervisor'>('connect');
  const [agents, setAgents] = useState<LocalAgent[]>([]);
  const [settings, setSettings] = useState<Record<string, AgentSettings>>({});
  const [editSettings, setEditSettings] = useState<Record<string, AgentSettings>>({});
  const [openDrawer, setOpenDrawer] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  const [connected, setConnected] = useState<Record<string, boolean>>({});
  const [waiting, setWaiting] = useState<Record<string, number>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const status = async (id: string, verify = false) => {
    const response = await fetch('/api/setup/local-agents/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, verify })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error('Unable to check sign-in.');
    return result as { connected: boolean; state: string };
  };

  const load = () =>
    fetch('/api/setup/local-agents')
      .then((r) => r.json())
      .then(async (d) => {
        if (d.ok) {
          const list: LocalAgent[] = d.agents || [];
          setAgents(list);
          setSettings(d.settings || {});
          setEditSettings(d.settings || {});

          const installed = list.filter((a) => a.installed);
          if (installed.length > 0) {
            const results = await Promise.allSettled(
              installed.map((a) => status(a.id, false).then((st) => ({ id: a.id, connected: st.connected })))
            );
            const updates: Record<string, boolean> = {};
            for (const r of results) {
              if (r.status === 'fulfilled' && r.value.connected) {
                updates[r.value.id] = true;
              }
            }
            if (Object.keys(updates).length > 0) {
              setConnected((old) => ({ ...old, ...updates }));
            }
          }
        }
      })
      .catch(() => setMessage({ load: lang === 'id' ? 'Gagal mendeteksi agen lokal. Coba Segarkan.' : 'Unable to detect local agents. Try Refresh.' }));

  useEffect(() => {
    void load();
  }, [lang]);

  useEffect(() => {
    if (Object.keys(waiting).length === 0) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      for (const [id, started] of Object.entries(waiting)) {
        try {
          const result = await status(id, false);
          if (cancelled) return;
          const expired = Date.now() - started > 300_000;
          if (result.connected || result.state === 'finished' || result.state === 'failed' || result.state === 'missing' || expired) {
            setWaiting((old) => {
              const next = { ...old };
              delete next[id];
              return next;
            });
            if (result.connected) {
              setConnected((old) => ({ ...old, [id]: true }));
              setMessage((old) => ({
                ...old,
                [id]: lang === 'id'
                  ? 'Connected. Akun agen siap digunakan. Test connection menguji balasan model dan memakai kuota.'
                  : 'Connected. The agent account is ready. Test connection checks a model reply and uses quota.'
              }));
            } else if (result.state === 'finished') {
              setMessage((old) => ({
                ...old,
                [id]: lang === 'id'
                  ? 'Terminal login selesai. Klik Test connection untuk menguji respon model.'
                  : 'Sign-in terminal closed. Click Test connection to verify model connection.'
              }));
            } else {
              setMessage((old) => ({
                ...old,
                [id]: lang === 'id'
                  ? 'Login belum berhasil. Coba Open sign-in lagi setelah menutup terminal login sebelumnya.'
                  : 'Sign-in was not confirmed. Close the previous login terminal and try Open sign-in again.'
              }));
            }
          }
        } catch {
          if (!cancelled) setMessage((old) => ({ ...old, [id]: lang === 'id' ? 'Belum dapat memeriksa login. Mencoba lagi...' : 'Unable to check sign-in. Retrying...' }));
          if (Date.now() - started > 300_000 && !cancelled) {
            setWaiting((old) => {
              const next = { ...old };
              delete next[id];
              return next;
            });
          }
        }
      }
      if (!cancelled) setWaiting((old) => ({ ...old }));
    }, 3000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [waiting, agents, lang]);

  async function action(agent: LocalAgent, type: 'login' | 'test') {
    setVerified((old) => ({ ...old, [agent.id]: false }));
    if (type === 'login') setConnected((old) => ({ ...old, [agent.id]: false }));
    setBusy(agent.id);
    setMessage((old) => ({
      ...old,
      [agent.id]: type === 'test'
        ? (lang === 'id' ? 'Menguji respon model. Memakai akun dan kuota milik agen sendiri...' : 'Testing a model reply. This uses the agent’s own account and quota...')
        : (lang === 'id' ? 'Membuka login...' : 'Opening sign-in...')
    }));
    try {
      const activeModel = editSettings[agent.id]?.model || 'default';
      const r = await fetch(`/api/setup/local-agents/${type}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(type === 'login' ? { id: agent.id } : { model: `${agent.id}:${activeModel}` })
      });
      const d = await r.json();
      setMessage((old) => ({ ...old, [agent.id]: d.detail || d.error }));
      if (type === 'test') {
        const isOk = r.ok && d.ok;
        setVerified((old) => ({ ...old, [agent.id]: isOk }));
        if (isOk) {
          setConnected((old) => ({ ...old, [agent.id]: true }));
        }
      }
      if (type === 'login' && r.ok && d.ok) setWaiting((old) => ({ ...old, [agent.id]: Date.now() }));
    } catch {
      setMessage((old) => ({ ...old, [agent.id]: lang === 'id' ? 'Meja trading tidak terjangkau. Coba lagi.' : 'Office not reachable. Try again.' }));
    } finally {
      setBusy(null);
    }
  }

  async function saveAgentSettings(id: string) {
    setBusy(`save-${id}`);
    try {
      const payload = editSettings[id] || {};
      const r = await fetch('/api/setup/local-agents/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, settings: payload })
      });
      const d = await r.json();
      if (r.ok && d.ok) {
        setSettings(d.settings || {});
        setMessage((old) => ({ ...old, [id]: lang === 'id' ? 'Pengaturan agen tersimpan di .env' : 'Agent settings saved to .env' }));
      } else {
        setMessage((old) => ({ ...old, [id]: d.detail || 'Failed to save settings' }));
      }
    } catch {
      setMessage((old) => ({ ...old, [id]: lang === 'id' ? 'Gagal menyimpan pengaturan' : 'Failed to save settings' }));
    } finally {
      setBusy(null);
    }
  }

  function resetAgentSettings(id: string) {
    setEditSettings((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
    void saveAgentSettings(id);
  }

  function copyPrompt(id: string, text: string) {
    void navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2500);
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
          {t('connectAgentTab')} ({agents.length})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'supervisor'}
          className={`local-agent-tab-btn ${tab === 'supervisor' ? 'active' : ''}`}
          onClick={() => setTab('supervisor')}
        >
          {t('externalSupervisorTab')} ({EXTERNAL_SUPERVISORS.length})
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
            <DataSourcesSetup available={available} />
            {agents.map((a) => {
              const currentSettings = editSettings[a.id] || {};
              const isOpen = !!openDrawer[a.id];
              const isCustomModel = currentSettings.model && currentSettings.model !== 'default' && !a.models.includes(currentSettings.model);

              return (
                <section key={a.id} className="local-agent-row">
                  <div className="local-agent-main">
                    <div className="local-agent-info">
                      <b>{a.label}</b>{' '}
                      <span className="badge">
                        {verified[a.id]
                          ? t('setupLocalVerifiedBadge')
                          : connected[a.id]
                          ? 'Connected'
                          : waiting[a.id]
                          ? (lang === 'id' ? 'Menunggu login...' : 'Waiting for sign-in...')
                          : a.installed
                          ? t('setupLocalInstalledBadge')
                          : t('setupLocalNotOnPathBadge')}
                      </span>
                      {settings[a.id]?.model && settings[a.id]?.model !== 'default' && (
                        <span className="badge" style={{ marginLeft: 4, background: 'var(--panel-2)' }}>
                          model: {settings[a.id]?.model}
                        </span>
                      )}
                      <p className="wallet-note small">
                        {a.hint} <a href={a.docs} target="_blank" rel="noreferrer">Install / docs</a>
                      </p>
                      <code>{a.loginCommand}</code>
                    </div>
                    <div className="local-agent-actions">
                      <button
                        type="button"
                        disabled={!available || !a.installed || !!busy || !!waiting[a.id] || !!connected[a.id]}
                        onClick={() => void action(a, 'login')}
                      >
                        {connected[a.id] ? 'Connected' : waiting[a.id] ? (lang === 'id' ? 'Menunggu login...' : 'Waiting for sign-in...') : t('setupLocalOpenSignInBtn')}
                      </button>
                      <button
                        type="button"
                        disabled={!available || !a.installed || !!busy || !!waiting[a.id]}
                        onClick={() => void action(a, 'test')}
                      >
                        {busy === a.id ? (lang === 'id' ? 'Bekerja...' : 'Working...') : t('setupLocalTestConnBtn')}
                      </button>
                      <button
                        type="button"
                        className="btn-settings-toggle"
                        onClick={() => setOpenDrawer((old) => ({ ...old, [a.id]: !old[a.id] }))}
                      >
                        {isOpen ? (lang === 'id' ? 'Tutup Opsi ▲' : 'Close Options ▲') : (lang === 'id' ? 'Opsi Agen ▼' : 'Agent Options ▼')}
                      </button>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="local-agent-drawer">
                      <div className="local-agent-drawer-grid">
                        <label>
                          {lang === 'id' ? 'Pilihan Model CLI' : 'CLI Model Selection'}
                          <select
                            value={isCustomModel ? '__custom__' : currentSettings.model || 'default'}
                            onChange={(e) => {
                              const val = e.target.value;
                              if (val === '__custom__') {
                                setEditSettings((old) => ({ ...old, [a.id]: { ...old[a.id], model: '' } }));
                              } else {
                                setEditSettings((old) => ({ ...old, [a.id]: { ...old[a.id], model: val } }));
                              }
                            }}
                          >
                            <option value="default">{lang === 'id' ? 'default (Model bawaan CLI)' : 'default (CLI default model)'}</option>
                            {a.models.filter((m) => m !== 'default').map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                            <option value="__custom__">{lang === 'id' ? 'Model kustom...' : 'Custom model ID...'}</option>
                          </select>
                        </label>

                        {isCustomModel && (
                          <label>
                            {lang === 'id' ? 'Ketik ID Model Kustom' : 'Type Custom Model ID'}
                            <input
                              type="text"
                              value={currentSettings.model || ''}
                              placeholder="e.g. gpt-5, claude-3-7-sonnet"
                              onChange={(e) => {
                                const val = e.target.value;
                                setEditSettings((old) => ({ ...old, [a.id]: { ...old[a.id], model: val } }));
                              }}
                            />
                          </label>
                        )}

                        {a.id === 'hermes' && (
                          <>
                            <label>
                              {lang === 'id' ? 'Tingkat Penalaran (Reasoning Effort)' : 'Reasoning Effort (--reasoning)'}
                              <select
                                value={currentSettings.effort || 'none'}
                                onChange={(e) => setEditSettings((old) => ({ ...old, [a.id]: { ...old[a.id], effort: e.target.value } }))}
                              >
                                <option value="none">none</option>
                                <option value="minimal">minimal</option>
                                <option value="low">low</option>
                                <option value="medium">medium</option>
                                <option value="high">high</option>
                                <option value="xhigh">xhigh</option>
                                <option value="max">max</option>
                                <option value="ultra">ultra</option>
                              </select>
                            </label>
                            <label>
                              {lang === 'id' ? 'Override Provider (--provider)' : 'Provider Override (--provider)'}
                              <input
                                type="text"
                                value={currentSettings.provider || ''}
                                placeholder="e.g. openrouter, nous"
                                onChange={(e) => setEditSettings((old) => ({ ...old, [a.id]: { ...old[a.id], provider: e.target.value } }))}
                              />
                            </label>
                          </>
                        )}

                        {a.id === 'copilot' && (
                          <label>
                            {lang === 'id' ? 'Tingkat Penalaran (--reasoning-effort)' : 'Reasoning Effort (--reasoning-effort)'}
                            <select
                              value={currentSettings.effort || 'none'}
                              onChange={(e) => setEditSettings((old) => ({ ...old, [a.id]: { ...old[a.id], effort: e.target.value } }))}
                            >
                              <option value="none">none</option>
                              <option value="minimal">minimal</option>
                              <option value="low">low</option>
                              <option value="medium">medium</option>
                              <option value="high">high</option>
                              <option value="xhigh">xhigh</option>
                              <option value="max">max</option>
                            </select>
                          </label>
                        )}

                        {a.id === 'openclaw' && (
                          <label>
                            {lang === 'id' ? 'Tingkat Thinking (--thinking)' : 'Thinking Level (--thinking)'}
                            <select
                              value={currentSettings.effort || 'off'}
                              onChange={(e) => setEditSettings((old) => ({ ...old, [a.id]: { ...old[a.id], effort: e.target.value } }))}
                            >
                              <option value="off">off</option>
                              <option value="minimal">minimal</option>
                              <option value="low">low</option>
                              <option value="medium">medium</option>
                              <option value="high">high</option>
                              <option value="xhigh">xhigh</option>
                              <option value="adaptive">adaptive</option>
                              <option value="max">max</option>
                            </select>
                          </label>
                        )}
                      </div>

                      <div className="setup-nav" style={{ marginTop: 6 }}>
                        <button
                          type="button"
                          disabled={busy === `save-${a.id}`}
                          onClick={() => void saveAgentSettings(a.id)}
                        >
                          {busy === `save-${a.id}` ? (lang === 'id' ? 'Menyimpan...' : 'Saving...') : (lang === 'id' ? 'Simpan Opsi Agen' : 'Save Agent Options')}
                        </button>
                        <button
                          type="button"
                          disabled={busy === `save-${a.id}`}
                          onClick={() => resetAgentSettings(a.id)}
                        >
                          {lang === 'id' ? 'Reset Default' : 'Reset to Default'}
                        </button>
                      </div>

                      {a.id === 'codex' && <CodexResearchSetup available={available} />}
                    </div>
                  )}

                  {message[a.id] && <p className="wallet-note" role="status">{message[a.id]}</p>}
                </section>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="local-agent-pane" role="tabpanel">
          <div className="local-agent-pane-head">
            <div>
              <b>{t('setupSupervisorsTitle')}</b>
              <p className="wallet-note">{t('setupSupervisorsNote')}</p>
            </div>
          </div>

          <div className="supervisor-grid">
            {EXTERNAL_SUPERVISORS.map((s) => (
              <div key={s.id} className="supervisor-card">
                <div className="supervisor-card-head">
                  <span className="supervisor-card-title">{s.name}</span>
                  <span className="badge">{s.category}</span>
                </div>
                <p className="supervisor-card-desc">{lang === 'id' ? s.summaryId : s.summaryEn}</p>
                <div className="supervisor-card-prompt">
                  <pre>{s.prompt}</pre>
                </div>
                <div className="supervisor-card-footer">
                  <a href={s.docs} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
                    {lang === 'id' ? 'Dokumentasi' : 'Documentation'}
                  </a>
                  <button
                    type="button"
                    className="copy-prompt-btn"
                    onClick={() => copyPrompt(s.id, s.prompt)}
                  >
                    {copiedId === s.id ? t('setupLocalCopied') : t('setupCopyPrompt')}
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 12, padding: 10, background: 'var(--panel)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--line)' }}>
            <b>{lang === 'id' ? 'Integrasi Otomatis Desk Lead' : 'Desk Lead Channel Integration'}</b>
            <p className="wallet-note small" style={{ margin: '4px 0 0' }}>
              {lang === 'id'
                ? 'Supervisor di atas tidak memerlukan port terbuka tambahan. Desk Lead (server/channels/supervisor.ts) mempublikasikan laporan berkala dan sinyal darurat ke channel Telegram, Discord, Slack, atau WhatsApp kamu secara aman dan read-only.'
                : 'The supervisors above require no extra open ports. The Desk Lead (server/channels/supervisor.ts) publishes periodic reports and emergency alerts directly to your Telegram, Discord, Slack, or WhatsApp channel in a secure, read-only manner.'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
