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
          <button
            type="button"
            className={`kill ${state.killed ? 'is-released' : ''} ${state.mode !== 'PAPER' ? 'is-live' : ''}`}
            title={state.killed ? t('cbKillReleaseTitle') : t('cbKillEngageTitle')}
            onClick={async () => {
              if (state.killed) {
                const r = await fetch('/api/ops/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: false }) }).then((x) => x.json()).catch(() => null);
                setReply({ ok: !!r?.ok, reply: r?.ok ? t('cbKillReleasedMsg') : (r?.detail || t('cbKillFailedMsg')) });
              } else {
                if (!window.confirm(t('cbKillConfirmPrompt'))) return;
                const r = await fetch('/api/ops/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: true }) }).then((x) => x.json()).catch(() => null);
                setReply({ ok: !!r?.ok, reply: r?.ok ? t('cbKillOnMsg') : (r?.detail || t('cbKillFailedMsg')) });
              }
            }}
          >
            {state.killed ? t('releaseKillSwitch') : t('killSwitch')}
          </button>
          <button
            type="button"
            className="restart-btn"
            title={t('cbRestartTitle')}
            onClick={async () => {
              const r = await fetch('/api/setup/restart', { method: 'POST' }).then((x) => x.json()).catch(() => null);
              setReply({ ok: !!r?.ok, reply: r?.detail || t('cbRestartSuccess') });
            }}
          >
            {t('restartOfficeBtn')}
          </button>
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
