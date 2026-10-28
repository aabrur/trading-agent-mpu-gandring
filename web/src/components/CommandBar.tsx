import { useState } from 'react';
import { applyAndRestartOffice, officeFetch } from '../officeApi';
import type { DeskState } from '../types';
import { POPULAR_SYMBOLS } from '../types';
import { useI18n } from '../i18n';

export function CommandBar({ state, command }: { state: DeskState; command: (t: string) => Promise<{ ok: boolean; reply: string }> }) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [symbol, setSymbol] = useState(state.watchlist[0] ?? 'BTCUSDT');
  const [reply, setReply] = useState<{ ok: boolean; reply: string } | null>(null);
  const [killBusy, setKillBusy] = useState(false);
  const [restarting, setRestarting] = useState(false);
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
            disabled={killBusy}
            aria-busy={killBusy}
            onClick={async () => {
              if (killBusy) return;
              setKillBusy(true);
              try {
                const response = await officeFetch('/api/ops/kill', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: !state.killed }) });
                const result = await response.json();
                setReply({ ok: response.ok && !!result.ok, reply: result.ok ? `${result.killed ? t('cbKillOnMsg') : t('cbKillReleasedMsg')}${result.notes?.length ? ` ${result.notes.join('; ')}` : ''}` : (result.error || t('cbKillFailedMsg')) });
              } catch (error) { setReply({ ok: false, reply: (error as Error).message }); }
              finally { setKillBusy(false); }
            }}
          >
            {state.killed ? t('releaseKillSwitch') : t('killSwitch')}
          </button>
          <button
            type="button"
            className="restart-btn"
            title={t('cbRestartTitle')}
            disabled={restarting}
            aria-busy={restarting}
            onClick={async () => {
              setRestarting(true);
              try { await applyAndRestartOffice(); window.location.reload(); }
              catch (error) { setReply({ ok: false, reply: error instanceof Error ? error.message : 'Restart could not be confirmed.' }); }
              finally { setRestarting(false); }
            }}
          >
            {t('restartOfficeBtn')}
          </button>
        </div>
        <form className="cb-input" onSubmit={(e) => { e.preventDefault(); void run(text); setText(''); }}>
          <span className="prompt">&gt;</span>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('commandPlaceholder')} maxLength={32000} aria-label="command" />
          <button type="submit">{t('runBtn')}</button>
        </form>
      </div>
      {reply && <div className={`cb-reply ${reply.ok ? '' : 'err'}`} onClick={() => setReply(null)}>{reply.reply}</div>}
    </div>
  );
}
