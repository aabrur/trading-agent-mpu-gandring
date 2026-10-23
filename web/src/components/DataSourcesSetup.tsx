import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';

interface Status { cryptoPanicKeySet: boolean; whaleAlertKeySet: boolean }
export function DataSourcesSetup({ available }: { available: boolean }) {
  const { lang } = useI18n();
  const [status, setStatus] = useState<Status | null>(null);
  const [cryptoKey, setCryptoKey] = useState('');
  const [whaleKey, setWhaleKey] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const response = await fetch('/api/setup/data-sources'); const data = await response.json();
    if (response.ok && data.ok) setStatus(data);
  };
  useEffect(() => { void load().catch(() => setMessage('Data sources unavailable')); }, []);
  const save = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/setup/data-sources', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(cryptoKey ? { cryptoPanicKey: cryptoKey } : {}), ...(whaleKey ? { whaleAlertKey: whaleKey } : {}) }) });
      const data = await response.json(); setMessage(data.detail || data.error);
      if (response.ok && data.ok) { setCryptoKey(''); setWhaleKey(''); await load(); }
    } catch { setMessage('Office not reachable'); }
    finally { setBusy(false); }
  };
  return <section className="local-agent-row">
    <div>
      <b>{lang === 'id' ? 'Sumber berita dan on-chain' : 'News and on-chain sources'}</b>
      <p className="wallet-note">{lang === 'id' ? 'Berita memakai CryptoPanic jika tersedia; LIVE/TESTNET juga punya fallback pengumuman Bybit. Transfer whale lintas chain memerlukan Whale Alert. Field kosong mempertahankan key tersimpan.' : 'News uses CryptoPanic when configured; LIVE/TESTNET also have a public Bybit announcement fallback. Cross-chain whale transfers require Whale Alert. Empty fields keep saved keys.'}</p>
      <label style={{ display: 'block' }}>CryptoPanic <span className="badge">{status?.cryptoPanicKeySet ? 'Key set' : 'Not configured'}</span>
        <input type="password" aria-label="CryptoPanic API key" autoComplete="off" spellCheck={false} value={cryptoKey} disabled={!available || busy || !status} onChange={event => setCryptoKey(event.target.value)} />
      </label>
      <label style={{ display: 'block', marginTop: 8 }}>Whale Alert <span className="badge">{status?.whaleAlertKeySet ? 'Key set' : 'Not configured'}</span>
        <input type="password" aria-label="Whale Alert API key" autoComplete="off" spellCheck={false} value={whaleKey} disabled={!available || busy || !status} onChange={event => setWhaleKey(event.target.value)} />
      </label>
    </div>
    <div className="setup-nav">
      <button type="button" disabled={!available || busy || !status} onClick={() => void save()}>{lang === 'id' ? 'Simpan sumber' : 'Save sources'}</button>
      <button type="button" disabled={busy} onClick={() => { setCryptoKey(''); setWhaleKey(''); }}>{lang === 'id' ? 'Batal' : 'Cancel'}</button>
    </div>
    {message && <p className="wallet-note" role="status">{message}</p>}
  </section>;
}
