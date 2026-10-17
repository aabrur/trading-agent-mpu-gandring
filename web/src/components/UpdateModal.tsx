import { useState } from 'react';
import { useI18n } from '../i18n';

export interface UpdateInfo {
  ok: boolean;
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  commit: string | null;
  releaseUrl: string;
  checkedAt: number;
  notes: string[];
  error?: string;
}

export function UpdateModal({
  info,
  onRefresh,
  onClose
}: {
  info: UpdateInfo | null;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string; output?: string } | null>(null);

  const cur = info?.currentVersion ?? '0.0.0.2.2';
  const latest = info?.latestVersion ?? cur;

  const checkNow = async () => {
    setChecking(true);
    setResult(null);
    await onRefresh();
    setChecking(false);
  };

  const applyNow = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await fetch('/api/update/apply', { method: 'POST' }).then((x) => x.json());
      setResult({ ok: !!r.ok, message: r.message ?? (r.error || 'Update failed'), output: r.output });
      await onRefresh();
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup-overlay" role="dialog" aria-modal="true" aria-label={t('versionModalTitle')} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <div className="panel setup update-modal">
        <div className="panel-head">
          <h2>{t('versionModalTitle')}</h2>
          <span className="badge update-avail-badge">
            <i className="update-notif-dot" /> {info?.updateAvailable ? t('updateAvailable') : `v${latest} · ${t('updateAvailable')}`}
          </span>
          <button autoFocus onClick={onClose}>{t('closeModal')}</button>
        </div>

        <div className="update-grid">
          <div className="stat">
            <small>{t('currentVersionLabel')}</small>
            <b>v{cur}{info?.commit ? ` · ${info.commit}` : ''}</b>
          </div>
          <div className="stat hi">
            <small>{t('latestVersionLabel')}</small>
            <b>v{latest}</b>
          </div>
        </div>

        {info?.notes && info.notes.length > 0 && (
          <div className="update-notes">
            <h4>{t('releaseNotesTitle')} · v{latest}</h4>
            <ul>
              {info.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          </div>
        )}

        <div className="setup-actions">
          <button onClick={checkNow} disabled={checking || busy}>
            {checking ? '...' : t('checkUpdateBtn')}
          </button>
          <button className="primary" onClick={applyNow} disabled={busy}>
            {busy ? t('updatingBtn') : `${t('applyUpdateBtn')} v${latest}`}
          </button>
          <a className="badge" href={info?.releaseUrl ?? 'https://github.com/aabrur/trading-agent-mpu-gandring'} target="_blank" rel="noreferrer">
            {t('viewRepoLink')} ↗
          </a>
        </div>

        {result && (
          <div className={`wallet-msg ${result.ok ? 'ok' : 'bad'}`}>
            <p>{result.message}</p>
            {result.output && <pre className="update-log">{result.output}</pre>}
          </div>
        )}
      </div>
    </div>
  );
}
