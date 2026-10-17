import { useState } from 'react';
import type { DeskState } from '../types';
import { POPULAR_SYMBOLS } from '../types';
import { useI18n } from '../i18n';

export function CommandBar({ state, command }: { state: DeskState; command: (t: string) => Promise<{ ok: boolean; reply: string }> }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [symbol, setSymbol] = useState(state.watchlist[0] ?? 'BTCUSDT');
  const [reply, setReply] = useState<{ ok: boolean; reply: string } | null>(null);
  const run = async (cmd: string) => { if (!cmd.trim()) return; setReply(await command(cmd)); };
  return (
    <div className="commandbar">
      <div className="cb-row">
        <div className="cb-debate">
          <select
            value={symbol}
            onChange={(e) => {
              if (e.target.value === '__custom__') {
                const c = window.prompt(t('customTokenPrompt'));
                if (c) setSymbol(c.trim().toUpperCase());
              } else {
                setSymbol(e.target.value);
              }
            }}
            aria-label="symbol"
          >
            <optgroup label={t('watchlistGroup')}>
              {state.watchlist.map((s) => <option key={s} value={s}>{s}</option>)}
            </optgroup>
            <optgroup label={t('popularPerpsGroup')}>
              {POPULAR_SYMBOLS.filter((s) => !state.watchlist.includes(s)).map((s) => <option key={s} value={s}>{s}</option>)}
            </optgroup>
            <option value="__custom__">{t('customTokenOpt')}</option>
          </select>
          <button className="primary" disabled={!!state.debate || state.paused} onClick={() => run(`analyze ${symbol}`)}>
            {state.debate ? `${t('debatingPrefix')} ${state.debate.symbol}...` : t('startDebate')}
          </button>
          <button onClick={() => run(state.paused ? 'resume' : 'pause')}>{state.paused ? t('resume') : t('pause')}</button>
          <button className="danger" onClick={() => run('close all')}>{t('closeAll')}</button>
          <button className={`kill ${state.mode !== 'PAPER' ? 'is-live' : ''}`} disabled={state.killed} title="Cancel everything, flatten every position and stop the desk until npm run unkill -- --yes"
            onClick={async () => {
              if (!window.confirm(`Kill switch: cancel all orders, close every ${state.mode === 'PAPER' ? 'paper' : state.mode} position and stop the desk? It stays stopped until someone runs npm run unkill -- --yes on this computer and restarts the office.`)) return;
              const r = await fetch('/api/kill', { method: 'POST' }).then((x) => x.json()).catch(() => null);
              setReply({ ok: !!r?.ok, reply: r?.ok ? `Kill switch on. ${(r.notes ?? []).join('; ') || 'Nothing was open.'}` : 'Kill switch request failed' });
            }}>{state.killed ? t('killed') : t('killSwitch')}</button>
        </div>
        <form className="cb-input" onSubmit={(e) => { e.preventDefault(); void run(text); setText(''); }}>
          <span className="prompt">&gt;</span>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('commandPlaceholder')} maxLength={500} aria-label="command" />
          <button type="submit">{t('runBtn')}</button>
        </form>
      </div>
      {reply && <div className={`cb-reply ${reply.ok ? '' : 'err'}`} onClick={() => setReply(null)}>{reply.reply}</div>}
    </div>
  );
}
