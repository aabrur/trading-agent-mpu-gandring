// Chat channels for the Desk Lead, inside the Setup wizard. Mirrors `npm run channels -- setup <channel>` (server/channels/*).
// Secrets are typed into masked inputs, sent once to the localhost-only route, written to .env (chmod 600) and cleared from the page.
import { useEffect, useState } from 'react';

interface Link { label: string; url: string; login?: boolean }
interface Field { env: string; label: string; secret: boolean; required: boolean; hint: string }
interface Guide { channel: string; label: string; official: string; outbound: string; inbound: string; publicUrl: boolean; fields: Field[]; steps: { title: string; text: string; links: Link[] }[]; notes: string[] }
interface Info { ok: boolean; error?: string; linksCheckedOn: string; entry: { available: boolean; reason: string }; discordRegister: string; notShipped: Record<string, string>; supervisorEnv: { env: string; text: string }[];
  status: { commands: boolean; supervisor: { on: boolean; intervalMin: number; cooldownMin: number }; channels: { channel: string; label: string; enabled: boolean; commandsReady: boolean; fields: { env: string; set: boolean; shown: string | null }[] }[] }; guides: Guide[] }

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

export function ChannelsSetup() {
  const [info, setInfo] = useState<Info | null>(null);
  const [ch, setCh] = useState('telegram');
  const [at, setAt] = useState(0);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [commands, setCommands] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [chats, setChats] = useState<{ chatId: string; chat: string; userId: string; user: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const load = () => fetch('/api/setup/channels').then((r) => r.json()).then((d: Info) => { setInfo(d); if (d.ok) setCommands(d.status.commands); }).catch(() => setInfo({ ok: false, error: 'office backend not reachable' } as Info));
  useEffect(() => { void load(); }, []);
  useEffect(() => { setAt(0); setVals({}); setMsg(null); setChats(null); setEditing(false); }, [ch]);
  if (!info) return null;
  if (!info.ok) return <p className="wallet-msg bad">{info.error}</p>;
  const g = info.guides.find((x) => x.channel === ch)!;
  const st = info.status.channels.find((x) => x.channel === ch)!;
  // Channels have different step counts: clamp so switching from a long guide (WhatsApp) to a short one never renders a missing step.
  const step = Math.min(at, g.steps.length - 1);
  const cur = g.steps[step];

  async function save() { setBusy(true); const r = await post('/api/setup/channels/save', { channel: ch, values: vals, commands }).catch(() => ({ ok: false, detail: 'office not reachable' })); setVals({}); setBusy(false); setMsg({ ok: r.ok, text: r.detail ?? r.error }); if (r.ok) { setEditing(false); void load(); } }
  async function test() { setBusy(true); const r = await post('/api/setup/channels/test', { channel: ch }).catch(() => ({ ok: false, detail: 'office not reachable' })); setBusy(false); setMsg({ ok: r.ok, text: r.detail ?? r.error }); }
  async function findChats() { setBusy(true); const r = await post('/api/setup/channels/telegram-chats', {}).catch(() => ({ ok: false, detail: 'office not reachable', chats: [] })); setBusy(false); setChats(r.chats ?? []); setMsg({ ok: r.ok, text: r.detail ?? r.error }); }

  return (
    <div className="setup-channels">
      <p className="wallet-note">The Desk Lead watches health, positions, stops, the daily loss cap and errors, and sends alerts and scheduled reports here. From chat, allowlisted ids can only ask for <b>status, report, positions</b> and <b>kill</b>. Orders, going LIVE, un-kill and key changes are never possible from chat.</p>
      <div className="seg" role="group" aria-label="channel">{info.guides.map((x) => <button key={x.channel} className={ch === x.channel ? 'on' : ''} onClick={() => { setAt(0); setCh(x.channel); }}>{x.label}</button>)}</div>
      <div className="setup-section-actions"><p className="wallet-note">{st.enabled ? 'Saved connection is ready.' : 'No complete connection saved.'} Safe commands: {info.status.commands ? 'on' : 'off'}.</p>{!editing && <button disabled={!info.entry.available} onClick={() => { setCommands(info.status.commands); setEditing(true); }}>Edit {g.label} connection</button>}</div>
      {!editing && <><dl className="setup-summary">{st.fields.map((f) => <div key={f.env}><dt>{f.env}</dt><dd>{f.set ? f.shown ?? 'Saved · hidden' : 'Not set'}</dd></div>)}</dl><button disabled={busy || !st.enabled} onClick={test}>Send test message</button></>}
      <div hidden={!editing}>
      <p className="wallet-note small">{g.official}. Posts: {g.outbound}. Commands: {g.inbound}.</p>
      <details className="setup-reference"><summary>Connection guide</summary>
      <h4>Step {step + 1} of {g.steps.length}: {cur.title}</h4>
      <div className="setup-step"><p>{cur.text}</p><ul>{cur.links.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer">{l.label}</a>{l.login ? ' (sign in first)' : ''}</li>)}</ul></div>
      <div className="setup-nav"><button disabled={step === 0} onClick={() => setAt(step - 1)}>Back</button><button disabled={step >= g.steps.length - 1} onClick={() => setAt(step + 1)}>Next step</button>
        {ch === 'telegram' && <button disabled={busy} onClick={findChats}>Find my chat id</button>}</div>
      {chats && chats.length > 0 && <ul className="wallet-note small">{chats.map((c) => <li key={c.chatId + c.userId}>chat id <code>{c.chatId}</code> ({c.chat}), user id <code>{c.userId}</code> ({c.user})</li>)}</ul>}
      {ch === 'discord' && <p className="wallet-note small">Register the slash commands yourself (bot token stays in your shell): <code>{info.discordRegister}</code></p>}
      </details>
      {info.entry.available ? (
        <form className="setup-keys" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {g.fields.map((f) => <label key={f.env}><span>{f.label}{f.required ? '' : ' (optional)'} <code>{f.env}</code></span><input type={f.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} placeholder={st.fields.find((x) => x.env === f.env)?.set ? 'already set, empty keeps it' : f.hint} value={vals[f.env] ?? ''} onChange={(e) => setVals({ ...vals, [f.env]: e.target.value })} /></label>)}
          <label className="setup-check"><input type="checkbox" checked={commands} onChange={(e) => setCommands(e.target.checked)} /> <span>Allow the safe chat commands from the allowlisted ids (CHANNEL_COMMANDS)</span></label>
          <button disabled={busy} type="submit">Save to .env</button> <button type="button" disabled={busy || !st.enabled} onClick={test}>Send test message</button>
        </form>
      ) : <p className="wallet-note">Entry is off here: {info.entry.reason} Use <code>npm run channels -- setup {ch}</code> or your platform&apos;s secret mechanism.</p>}
      <p className="wallet-note small">Existing values are retained when left blank. Secrets are never loaded back into inputs. Restart the desk after saving.</p>
      {g.publicUrl && <p className="wallet-note small">Commands for {g.label} arrive on a separate webhook server (default port 8788, only /api/channels/*). Point an HTTPS tunnel at that port only. See docs/channels.md.</p>}
      {g.notes.map((n) => <p key={n} className="wallet-note small">{n}</p>)}
      <button disabled={busy} onClick={() => { setVals({}); setCommands(info.status.commands); setEditing(false); setMsg(null); }}>Cancel</button>
      </div>
      {msg && <p className={`wallet-msg ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</p>}
      <p className="wallet-note small">MiChat: {info.notShipped.michat} Email: {info.notShipped.email}</p>
      <p className="wallet-note small">Desk Lead {info.status.supervisor.on ? `on, every ${info.status.supervisor.intervalMin} min` : 'off until a channel is set'}. Links checked {info.linksCheckedOn}. Same as <code>npm run channels</code>.</p>
    </div>
  );
}
