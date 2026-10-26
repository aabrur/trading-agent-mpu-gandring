import { useEffect, useState } from 'react';
import { officeFetch as fetch } from '../officeApi';
import { useI18n } from '../i18n';

interface Status { coinMarketCap?: {connected: boolean; observedAt: number | null; freshness: string; quota: {creditsLeft?: number; plan?: string} | null}; cryptoPanicKeySet: boolean; whaleAlertKeySet: boolean; coinMarketCapKeySet: boolean }
export function DataSourcesSetup({ available }: { available: boolean }) {
  const { lang } = useI18n();
  const [status, setStatus] = useState<Status | null>(null);
  const [cryptoKey, setCryptoKey] = useState('');
  const [whaleKey, setWhaleKey] = useState('');
  const [cmcKey, setCmcKey] = useState('');
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
        body: JSON.stringify({
          ...(cryptoKey ? { cryptoPanicKey: cryptoKey } : {}),
          ...(whaleKey ? { whaleAlertKey: whaleKey } : {}),
          ...(cmcKey ? { coinMarketCapKey: cmcKey } : {})
        }) });
      const data = await response.json(); setMessage(data.detail || data.error);
      if (response.ok && data.ok) { setCryptoKey(''); setWhaleKey(''); setCmcKey(''); await load(); }
    } catch { setMessage('Office not reachable'); }
    finally { setBusy(false); }
  };
  return <section className="local-agent-row">
    <div>
      <b>{lang === 'id' ? 'Sumber berita, on-chain, dan pasar global' : 'News, on-chain, and global market sources'}</b>
      <p className="wallet-note">{lang === 'id' ? 'Berita memakai CryptoPanic jika tersedia; LIVE/TESTNET juga punya fallback pengumuman Bybit. Transfer whale lintas chain memerlukan Whale Alert. CoinMarketCap menambahkan metrik pasar global, dominasi BTC/ETH, dan ranking token (dioptimalkan untuk free tier). Field kosong mempertahankan key tersimpan.' : 'News uses CryptoPanic when configured; LIVE/TESTNET also have a public Bybit announcement fallback. Cross-chain whale transfers require Whale Alert. CoinMarketCap adds global crypto metrics, BTC/ETH dominance, and token rank (optimized for free tier). Empty fields keep saved keys.'}</p>
      <label style={{ display: 'block' }}>CryptoPanic <span className="badge">{status?.cryptoPanicKeySet ? (lang === 'id' ? 'Key tersimpan' : 'Key set') : (lang === 'id' ? 'Belum dikonfigurasi' : 'Not configured')}</span>
        <input type="password" aria-label="CryptoPanic API key" autoComplete="off" spellCheck={false} value={cryptoKey} disabled={!available || busy || !status} onChange={event => setCryptoKey(event.target.value)} />
      </label>
      <label style={{ display: 'block', marginTop: 8 }}>Whale Alert <span className="badge">{status?.whaleAlertKeySet ? (lang === 'id' ? 'Key tersimpan' : 'Key set') : (lang === 'id' ? 'Belum dikonfigurasi' : 'Not configured')}</span>
        <input type="password" aria-label="Whale Alert API key" autoComplete="off" spellCheck={false} value={whaleKey} disabled={!available || busy || !status} onChange={event => setWhaleKey(event.target.value)} />
      </label>
      <label style={{ display: 'block', marginTop: 8 }}>CoinMarketCap <span className="badge">{status?.coinMarketCapKeySet ? (lang === 'id' ? 'Key tersimpan' : 'Key set') : (lang === 'id' ? 'Belum dikonfigurasi' : 'Not configured')}</span>
        <input type="password" aria-label="CoinMarketCap API key" placeholder={status?.coinMarketCapKeySet ? '••••••••' : (lang === 'id' ? 'API Key CoinMarketCap (X-CMC_PRO_API_KEY)' : 'CoinMarketCap Pro API key')} autoComplete="off" spellCheck={false} value={cmcKey} disabled={!available || busy || !status} onChange={event => setCmcKey(event.target.value)} />
      </label>
      <p role="status">CMC: {status?.coinMarketCap?.connected ? 'Connected' : (lang === 'id' ? 'Belum terverifikasi' : 'Unverified')} · {status?.coinMarketCap?.freshness || 'unverified'} · {status?.coinMarketCap?.observedAt ? new Date(status.coinMarketCap.observedAt).toLocaleString(lang) : (lang === 'id' ? 'Belum ada observasi' : 'No observations')} · {lang === 'id' ? 'Sisa kuota' : 'Quota remaining'}: {status?.coinMarketCap?.quota?.creditsLeft ?? (lang === 'id' ? 'Belum diketahui' : 'Unknown')}</p>
    </div>
    <div className="setup-nav">
      <button type="button" disabled={!available || busy || !status} onClick={() => void save()}>{lang === 'id' ? 'Simpan sumber' : 'Save sources'}</button>
      <button type="button" disabled={busy} onClick={() => { setCryptoKey(''); setWhaleKey(''); setCmcKey(''); }}>{lang === 'id' ? 'Batal' : 'Cancel'}</button>
    </div>
    {message && <p className="wallet-note" role="status">{message}</p>}
  </section>;
}
