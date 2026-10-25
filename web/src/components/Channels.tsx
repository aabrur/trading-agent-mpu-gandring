// Chat channels for the Desk Lead, inside the Setup wizard. Mirrors `npm run channels -- setup <channel>` (server/channels/*).
// Secrets are typed into masked inputs, sent once to the localhost-only route, written to .env (chmod 600) and cleared from the page.
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';

interface Link { label: string; url: string; login?: boolean }
interface Field { env: string; label: string; secret: boolean; required: boolean; hint: string }
interface Guide { channel: string; label: string; official: string; outbound: string; inbound: string; publicUrl: boolean; fields: Field[]; steps: { title: string; text: string; links: Link[] }[]; notes: string[] }
interface DiscordBot { installUrl: string; delivery: string; application: {id: string; verify_key?: string}; guilds: {id: string; name: string}[]; channels: {id: string; name: string}[] }
interface Info { discordConnection?: string; ok: boolean; error?: string; linksCheckedOn: string; entry: { available: boolean; reason: string }; discordRegister: string; notShipped: Record<string, string>; supervisorEnv: { env: string; text: string }[];
  status: { commands: boolean; supervisor: { on: boolean; intervalMin: number; cooldownMin: number }; channels: { channel: string; label: string; enabled: boolean; commandsReady: boolean; fields: { env: string; set: boolean; shown: string | null }[] }[] }; guides: Guide[] }

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

export function ChannelsSetup() {
  const { t, lang } = useI18n();
  const [info, setInfo] = useState<Info | null>(null);
  const [ch, setCh] = useState('telegram');
  const [at, setAt] = useState(0);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [commands, setCommands] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [chats, setChats] = useState<{ chatId: string; chat: string; userId: string; user: string }[] | null>(null);
  const [discordBot, setDiscordBot] = useState<DiscordBot | null>(null);
  const requestGeneration = useRef(0);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const load = () => fetch('/api/setup/channels').then((r) => r.json()).then((d: Info) => { setInfo(d); if (d.ok) setCommands(d.status.commands); }).catch(() => setInfo({ ok: false, error: lang === 'id' ? 'Meja trading tidak terjangkau' : 'office backend not reachable' } as Info));
  useEffect(() => { void load(); }, [lang]);
  useEffect(() => { requestGeneration.current++; setDiscordBot(null); setAt(0); setVals({}); setMsg(null); setChats(null); setEditing(false); }, [ch]);
  if (!info) return null;
  if (!info.ok) return <p className="wallet-msg bad">{info.error}</p>;
  const g = info.guides.find((x) => x.channel === ch)!;
  const st = info.status.channels.find((x) => x.channel === ch)!;
  const step = Math.min(at, g.steps.length - 1);
  const cur = g.steps[step];

  async function save() { setBusy(true); const r = await post('/api/setup/channels/save', { channel: ch, values: vals, commands }).catch(() => ({ ok: false, detail: lang === 'id' ? 'Meja trading tidak terjangkau' : 'office not reachable' })); setVals({}); setBusy(false); setMsg({ ok: r.ok, text: r.detail ?? r.error }); if (r.ok) { setEditing(false); void load(); } }
  async function test() { setBusy(true); const r = await post('/api/setup/channels/test', { channel: ch }).catch(() => ({ ok: false, detail: lang === 'id' ? 'Meja trading tidak terjangkau' : 'office not reachable' })); setBusy(false); setMsg({ ok: r.ok, text: r.detail ?? r.error }); }
  async function findChats() { setBusy(true); const r = await post('/api/setup/channels/telegram-chats', {}).catch(() => ({ ok: false, detail: lang === 'id' ? 'Meja trading tidak terjangkau' : 'office not reachable', chats: [] })); setBusy(false); setChats(r.chats ?? []); setMsg({ ok: r.ok, text: r.detail ?? r.error }); }

  async function inspectBot(guildId?: string) {
    const generation = ++requestGeneration.current;
    setBusy(true);
    try {
      const result = await post('/api/setup/channels/discord-bot', { ...(vals.DISCORD_BOT_TOKEN ? {token: vals.DISCORD_BOT_TOKEN} : {}), ...(guildId ? {guildId} : {}) });
      if (generation !== requestGeneration.current) return;
      if (!result.ok) { setMsg({ok: false, text: result.detail}); return; }
      setDiscordBot(result);
      setVals(old => ({...old, DISCORD_APPLICATION_ID: result.application.id, ...(result.application.verify_key ? {DISCORD_PUBLIC_KEY: result.application.verify_key} : {}), DISCORD_DELIVERY: result.delivery, ...(guildId ? {DISCORD_GUILD_ID: guildId, DISCORD_CHANNEL_ID: ''} : {})}));
      setMsg({ok: true, text: lang === 'id' ? 'Bot tervalidasi. Instal bot, pilih server dan channel, lalu simpan.' : 'Bot validated. Install it, select a server and channel, then save.'});
    } catch { if (generation === requestGeneration.current) setMsg({ok: false, text: 'Discord validation failed.'}); }
    finally { if (generation === requestGeneration.current) setBusy(false); }
  }
  async function syncCommands() {
    setBusy(true);
    try { const result = await post('/api/setup/channels/discord-sync', {}); setMsg({ok: result.ok, text: result.detail}); }
    catch { setMsg({ok: false, text: 'Discord synchronization failed.'}); }
    finally { setBusy(false); }
  }

  return (
    <div className="setup-channels">
      <p className="wallet-note">{t('setupChannelsNote')}</p>
      <div className="seg" role="group" aria-label="channel">{info.guides.map((x) => <button key={x.channel} className={ch === x.channel ? 'on' : ''} onClick={() => { setAt(0); setCh(x.channel); }}>{x.label}</button>)}</div>
      <div className="setup-section-actions"><p className="wallet-note">{st.enabled ? t('setupChannelsConnReady') : t('setupChannelsNoConn')} {t('setupChannelsSafeCommands')} {info.status.commands ? (lang === 'id' ? 'aktif' : 'on') : (lang === 'id' ? 'mati' : 'off')}.</p>{!editing && <button disabled={!info.entry.available} onClick={() => { setCommands(info.status.commands); setEditing(true); }}>{t('setupChannelsEditBtn')} ({g.label})</button>}</div>
      {!editing && <><dl className="setup-summary">{st.fields.map((f) => <div key={f.env}><dt>{f.env}</dt><dd>{f.set ? f.shown ?? (lang === 'id' ? 'Tersimpan · disembunyikan' : 'Saved · hidden') : (lang === 'id' ? 'Belum diatur' : 'Not set')}</dd></div>)}</dl><button disabled={busy || !st.enabled} onClick={test}>{t('setupChannelsSendTestBtn')}</button></>}
      {ch === 'discord' && <p role="status">Discord: {info.discordConnection || 'unknown'} <button type="button" disabled={busy || !st.enabled} onClick={() => void syncCommands()}>{lang === 'id' ? 'Sinkronkan Perintah Sekarang' : 'Sync Commands Now'}</button></p>}
      <div hidden={!editing}>
      <p className="wallet-note small">{g.official}. {lang === 'id' ? 'Kirim:' : 'Posts:'} {g.outbound}. {lang === 'id' ? 'Perintah:' : 'Commands:'} {g.inbound}.</p>
      <details className="setup-reference"><summary>{lang === 'id' ? 'Panduan koneksi' : 'Connection guide'}</summary>
      <h4>{lang === 'id' ? 'Langkah' : 'Step'} {step + 1} {lang === 'id' ? 'dari' : 'of'} {g.steps.length}: {cur.title}</h4>
      <div className="setup-step"><p>{cur.text}</p><ul>{cur.links.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer">{l.label}</a>{l.login ? (lang === 'id' ? ' (masuk dulu)' : ' (sign in first)') : ''}</li>)}</ul></div>
      <div className="setup-nav"><button disabled={step === 0} onClick={() => setAt(step - 1)}>{lang === 'id' ? 'Kembali' : 'Back'}</button><button disabled={step >= g.steps.length - 1} onClick={() => setAt(step + 1)}>{lang === 'id' ? 'Langkah berikutnya' : 'Next step'}</button>
        {ch === 'telegram' && <button disabled={busy} onClick={findChats}>{t('setupChannelsFindChatIdBtn')}</button>}</div>
      {chats && chats.length > 0 && <ul className="wallet-note small">{chats.map((c) => <li key={c.chatId + c.userId}>chat id <code>{c.chatId}</code> ({c.chat}), user id <code>{c.userId}</code> ({c.user})</li>)}</ul>}

      </details>
      {info.entry.available ? (
        <form className="setup-keys" autoComplete="off" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {g.fields.map((f) => <label key={f.env}><span>{f.label}{f.required ? '' : (lang === 'id' ? ' (opsional)' : ' (optional)')} <code>{f.env}</code></span><input type={f.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} placeholder={st.fields.find((x) => x.env === f.env)?.set ? (lang === 'id' ? 'sudah diatur, kosongkan bila tidak diganti' : 'already set, empty keeps it') : f.hint} value={vals[f.env] ?? ''} onChange={(e) => setVals({ ...vals, [f.env]: e.target.value })} /></label>)}
          {ch === 'discord' && <div>
            <button type="button" disabled={busy} onClick={() => void inspectBot(vals.DISCORD_GUILD_ID || undefined)}>{lang === 'id' ? 'Validasi Bot / Segarkan Server' : 'Validate Bot / Refresh Servers'}</button>
            {discordBot && <><p><a href={discordBot.installUrl} target="_blank" rel="noreferrer">{lang === 'id' ? 'Instal Bot di Discord' : 'Install Bot in Discord'}</a> · {discordBot.delivery}</p>
              <label>{lang === 'id' ? 'Server' : 'Server'}<select disabled={busy} value={vals.DISCORD_GUILD_ID || ''} onChange={e => void inspectBot(e.target.value)}><option value="">{lang === 'id' ? 'Pilih server' : 'Select server'}</option>{discordBot.guilds.map(guild => <option key={guild.id} value={guild.id}>{guild.name}</option>)}</select></label>
              <label>Channel<select disabled={busy} value={vals.DISCORD_CHANNEL_ID || ''} onChange={e => setVals(old => ({...old, DISCORD_CHANNEL_ID: e.target.value}))}><option value="">{lang === 'id' ? 'Pilih channel' : 'Select channel'}</option>{discordBot.channels.map(channel => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label></>}
          </div>}
          <label className="setup-check"><input type="checkbox" checked={commands} onChange={(e) => setCommands(e.target.checked)} /> <span>{t('setupChannelsAllowCommandsCheck')}</span></label>
          <button disabled={busy} type="submit">{t('setupChannelsSaveBtn')}</button> <button type="button" disabled={busy || !st.enabled} onClick={test}>{t('setupChannelsSendTestBtn')}</button>
        </form>
      ) : <p className="wallet-note">{lang === 'id' ? `Input dinonaktifkan di sini: ${info.entry.reason} Gunakan` : `Entry is off here: ${info.entry.reason} Use`} <code>npm run channels -- setup {ch}</code> {lang === 'id' ? 'atau secret store platform kamu.' : 'or your platform secret mechanism.'}</p>}
      <p className="wallet-note small">{lang === 'id' ? 'Kredensial lama tetap dipakai jika kolom dikosongkan. Secret tidak pernah ditampilkan kembali. Restart meja trading setelah menyimpan.' : 'Existing values are retained when left blank. Secrets are never loaded back into inputs. Restart the desk after saving.'}</p>
      {g.publicUrl && <p className="wallet-note small">{lang === 'id' ? `Perintah untuk ${g.label} diterima di server webhook terpisah (port default 8788, hanya /api/channels/*). Arahkan HTTPS tunnel ke port ini saja.` : `Commands for ${g.label} arrive on a separate webhook server (default port 8788, only /api/channels/*). Point an HTTPS tunnel at that port only.`} See docs/channels.md.</p>}
      {g.notes.map((n) => <p key={n} className="wallet-note small">{n}</p>)}
      <button disabled={busy} onClick={() => { setVals({}); setCommands(info.status.commands); setEditing(false); setMsg(null); }}>{t('setupDeskCancelBtn')}</button>
      </div>
      {msg && <p role="status" className={`wallet-msg ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</p>}
      <p className="wallet-note small">MiChat: {info.notShipped.michat} Email: {info.notShipped.email}</p>
      <p className="wallet-note small">Desk Lead {info.status.supervisor.on ? `${lang === 'id' ? 'aktif, setiap' : 'on, every'} ${info.status.supervisor.intervalMin} ${lang === 'id' ? 'mnt' : 'min'}` : (lang === 'id' ? 'mati sampai channel dikonfigurasi' : 'off until a channel is set')}. {lang === 'id' ? 'Tautan dicek' : 'Links checked'} {info.linksCheckedOn}. {lang === 'id' ? 'Sama seperti' : 'Same as'} <code>npm run channels</code>.</p>
    </div>
  );
}
