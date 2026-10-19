import { useEffect, useState } from 'react';

interface Preferences { appMode: 'local' | 'grokbot'; balance: number; safetyNet: number; n: number; dailyLoss: number; auto: boolean; debateInterval: number; reportInterval: number }
export function PreferencesSetup() {
  const [values, setValues] = useState<Preferences | null>(null);
  const [saved, setSaved] = useState<Preferences | null>(null);
  const [editing, setEditing] = useState(false);
  const [canRestart, setCanRestart] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetch('/api/setup/preferences').then((r) => r.json()).then((d) => { if (d.ok) { setValues(d.values); setSaved(d.values); setCanRestart(d.canRestart); } else setMessage('Settings unavailable.'); }).catch(() => setMessage('Office not reachable.')); }, []);
  async function save() {
    setBusy(true);
    try { const r = await fetch('/api/setup/preferences', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values) }); const d = await r.json(); setMessage(d.detail || d.error); if (r.ok && d.ok) { setSaved(values); setEditing(false); } }
    catch { setMessage('Office not reachable. Try saving again.'); } finally { setBusy(false); }
  }
  async function restart() {
    setBusy(true); setMessage('Applying saved settings...');
    try {
      const r = await fetch('/api/setup/restart', { method: 'POST' }); const d = await r.json();
      if (!r.ok) { setMessage(d.detail); setBusy(false); return; }
      await new Promise((resolve) => setTimeout(resolve, 1500));
      for (let i = 0; i < 30; i++) {
        try { const health = await fetch('/api/health', { signal: AbortSignal.timeout(1500) }); if (health.ok) { window.location.reload(); return; } } catch { /* Wait for the managed server. */ }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      setMessage('Restart is taking longer than expected. Check the mpu terminal, then refresh.');
    } catch { setMessage('Restart could not be confirmed. Check the mpu terminal.'); }
    setBusy(false);
  }
  if (!values) return <p className="wallet-note">{message || 'Loading settings...'}</p>;
  const help = { balance: 'Simulation funds only. LIVE equity comes from the venue.', safetyNet: 'Capital reserved from new position sizing.', n: 'The existing Money Trade allocation is divided across these slots.', dailyLoss: 'Existing daily loss limit. New entries stop when reached.', debateInterval: 'Minutes between scheduled analysis cycles, not a delay before each order.', reportInterval: 'Minutes between scheduled reports and notifications.' };
  const numeric = (key: Exclude<keyof Preferences, 'appMode' | 'auto'>, label: string, min: number, max?: number) => <label>{label}<input type="number" min={min} max={max} step={key === 'balance' || key === 'safetyNet' || key === 'dailyLoss' ? '0.1' : '1'} required value={values[key]} onChange={(e) => setValues({ ...values, [key]: Number(e.target.value) })} /><small className="field-help">{help[key]}</small></label>;
  return <section className="setup-preferences">
    {!editing && <><div className="setup-section-actions"><p className="wallet-note">Your saved settings. Edit only what you need; you do not need to set up again.</p><button onClick={() => { setMessage(''); setEditing(true); }}>Edit desk settings</button></div><dl className="setup-summary">
      <div><dt>Agent source</dt><dd>{values.appMode === 'local' ? 'Models / signed-in local agents' : 'External Grok Bot team'}</dd></div>
      <div><dt>Paper balance</dt><dd>{values.balance} USDT</dd></div><div><dt>Safety net</dt><dd>{values.safetyNet} USDT</dd></div><div><dt>Maximum open orders</dt><dd>{values.n}</dd></div><div><dt>Daily loss cap</dt><dd>{values.dailyLoss}%</dd></div><div><dt>Auto schedule</dt><dd>{values.auto ? 'On' : 'Off'} · every {values.debateInterval} min</dd></div><div><dt>Reports</dt><dd>Every {values.reportInterval} min</dd></div>
    </dl></>}
    <form hidden={!editing} className="setup-keys" onChange={() => setMessage('')} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <label>Agent source<select value={values.appMode} onChange={(e) => setValues({ ...values, appMode: e.target.value as Preferences['appMode'] })}><option value="local">Models or signed-in agents on this computer</option><option value="grokbot">External Grok Bot team via signed bridge</option></select></label>
      <div className="settings-grid">{numeric('balance', 'Paper balance in USDT', 0)}{numeric('safetyNet', 'Safety net in USDT', 0, values.balance)}{numeric('n', 'Maximum open orders', 1, 4)}{numeric('dailyLoss', 'Daily loss cap in %', 0.1, 100)}{numeric('debateInterval', 'Debate interval in minutes', 1, 1440)}{numeric('reportInterval', 'Report interval in minutes', 1, 1440)}</div>
      <p className="wallet-note">PAPER allocation preview: Money Trade {Math.max(0, values.balance - values.safetyNet).toFixed(2)} USDT · per slot {((Math.max(0, values.balance - values.safetyNet)) / (values.n || 1)).toFixed(2)} USDT. This is not your confirmed LIVE balance.</p>
      <label className="setup-check"><input type="checkbox" checked={values.auto} onChange={(e) => setValues({ ...values, auto: e.target.checked })} /> Schedule automatic analysis and execution in the saved mode.</label>
      <p className="field-help">Once a supported decision passes existing checks, the desk executes without another approval. Saving does not switch trading mode. Connect trade-only credentials and verify the venue in Exchange & Safety; apply saved changes only when you intend to restart.</p>
      <div className="setup-nav"><button disabled={busy} type="submit">Save desk settings</button><button type="button" disabled={busy} onClick={() => { setValues(saved); setEditing(false); setMessage(''); }}>Cancel</button></div>
    </form>
    <div className="setup-nav"><button disabled={busy || !canRestart} onClick={restart}>Apply saved settings and restart</button><small className="wallet-note">{canRestart ? 'Save each section before applying.' : 'Start with mpu to apply saved changes here.'}</small></div>
    {message && <p className="wallet-note" role="status">{message}</p>}
  </section>;
}
