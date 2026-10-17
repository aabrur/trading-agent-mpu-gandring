// Connect wallet. Local mode only.
// Uses the injected browser wallet to read the MAIN address and to sign ONE agent approval.
// It never asks for, exports or stores the main wallet private key or seed.
import { useCallback, useEffect, useState } from 'react';
import type { DeskState } from '../types';
import { useI18n } from '../i18n';
import { fmt } from './format';

interface VenueInfo { venue: string; label: string; kind: 'CEX' | 'DEX'; support: 'signature' | 'manual' | 'cex'; steps: string[]; revokeUrl: string | null; docsUrl: string; depositUrl: string; status: string }
interface WalletState { available: boolean; reason: string; appMode: string; current: string | null; venues: VenueInfo[] }
interface VenueBalance { ok: boolean; venue: string; label: string; kind: 'CEX' | 'DEX'; network: string; configured: boolean; address: string | null; equityUsdt: number | null; availableUsdt: number | null; depositUrl: string; note?: string; error?: string }
interface Eip1193 { request(a: { method: string; params?: unknown[] }): Promise<any> }
const eth = () => (window as unknown as { ethereum?: Eip1193 }).ethereum;

export function WalletPanel({ state, embedded = false }: { state: DeskState; embedded?: boolean }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<WalletState | null>(null);
  const [venue, setVenue] = useState<string>(() => {
    try { return localStorage.getItem('mg-wallet-venue') || 'hyperliquid'; } catch { return 'hyperliquid'; }
  });
  const [network, setNetwork] = useState<'testnet' | 'mainnet'>(() => {
    try {
      const saved = localStorage.getItem('mg-wallet-network');
      return saved === 'mainnet' || saved === 'testnet' ? saved : 'testnet';
    } catch { return 'testnet'; }
  });
  const [address, setAddress] = useState<string>(() => {
    try { return localStorage.getItem('mg-wallet-address') || ''; } catch { return ''; }
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [agent, setAgent] = useState<string>('');
  const [bal, setBal] = useState<VenueBalance | null>(null);
  const [balBusy, setBalBusy] = useState(false);

  useEffect(() => {
    fetch('/api/wallet')
      .then((r) => r.json())
      .then((d: WalletState) => {
        setInfo(d);
        const dexVenues = d.venues.filter((x) => x.kind === 'DEX');
        let savedV = '';
        try { savedV = localStorage.getItem('mg-wallet-venue') || ''; } catch { /* ignore */ }
        const initialDex = dexVenues.find((x) => x.venue === savedV)?.venue
          ?? dexVenues.find((x) => x.venue === d.current)?.venue
          ?? dexVenues[0]?.venue
          ?? 'hyperliquid';
        setVenue(initialDex);
      })
      .catch(() => {});
  }, []);

  const loadBalance = useCallback((targetVenue: string, targetNet: 'testnet' | 'mainnet', targetAddr: string) => {
    if (!targetVenue) return;
    setBalBusy(true);
    const qs = new URLSearchParams({ venue: targetVenue, network: targetNet });
    if (targetAddr) qs.set('address', targetAddr);
    fetch(`/api/wallet/balance?${qs.toString()}`)
      .then((r) => r.json())
      .then((d: VenueBalance) => setBal(d))
      .catch(() => {})
      .finally(() => setBalBusy(false));
  }, []);

  useEffect(() => {
    if (info && venue) loadBalance(venue, network, address);
  }, [info, venue, network, address, loadBalance]);

  if (!info) return null;
  const dex = info.venues.filter((x) => x.kind === 'DEX');
  const v = dex.find((x) => x.venue === venue) ?? dex[0];
  if (!v) return null;

  async function connect() {
    setMsg(null);
    const w = eth();
    if (!w) { setMsg({ ok: false, text: 'No browser wallet found. Install MetaMask or Rabby, or use the manual steps.' }); return; }
    try {
      const [a] = await w.request({ method: 'eth_requestAccounts' });
      setAddress(a);
      try {
        localStorage.setItem('mg-wallet-address', a);
        localStorage.setItem('mg-wallet-venue', v.venue);
        localStorage.setItem('mg-wallet-network', network);
      } catch { /* ignore */ }
      window.dispatchEvent(new Event('mg-wallet-updated'));
    }
    catch (e) { setMsg({ ok: false, text: `Wallet refused: ${(e as Error).message}` }); }
  }
  async function approve() {
    const w = eth();
    if (!w || !address) return;
    setBusy(true); setMsg(null); setAgent('');
    try {
      if (v.venue === 'aster') { try { await w.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x38' }] }); } catch { /* user can switch by hand */ } }
      const chainId = parseInt(await w.request({ method: 'eth_chainId' }), 16);
      const start = await fetch('/api/wallet/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ venue: v.venue, network, mainAddress: address, chainId }) }).then((r) => r.json());
      if (!start.ok) throw new Error(start.error);
      setAgent(start.agentAddress);
      const td = start.typedData;
      const types = { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...td.types };
      const signature = await w.request({ method: 'eth_signTypedData_v4', params: [address, JSON.stringify({ ...td, types })] });
      const done = await fetch('/api/wallet/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: start.id, signature }) }).then((r) => r.json());
      if (!done.ok) throw new Error(done.error);
      setMsg({ ok: true, text: done.note });
      try {
        localStorage.setItem('mg-wallet-address', address);
        localStorage.setItem('mg-wallet-venue', v.venue);
        localStorage.setItem('mg-wallet-network', network);
      } catch { /* ignore */ }
      window.dispatchEvent(new Event('mg-wallet-updated'));
      loadBalance(v.venue, network, address);
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  }

  return (
    <div className={embedded ? 'wallet-panel' : 'panel wallet-panel'}>
      <div className="panel-head">{!embedded && <h2>{t('connectWallet')}</h2>}<span className="badge">{t('dexOnlyLabel')}</span></div>
      <div className="wallet-pick">
        <select value={v.venue} onChange={(e) => { setVenue(e.target.value); setMsg(null); setAgent(''); }} aria-label="venue">
          <optgroup label="DEX">{dex.map((x) => <option key={x.venue} value={x.venue}>{x.label}</option>)}</optgroup>
        </select>
        <div className="seg" role="group" aria-label="network">
          {(['testnet', 'mainnet'] as const).map((n) => <button key={n} className={network === n ? 'on' : ''} onClick={() => setNetwork(n)}>{n}</button>)}
        </div>
        <a className="badge deposit-link-btn" href={v.depositUrl} target="_blank" rel="noreferrer">{t('depositOfficial')} ↗</a>
      </div>

      <div className="venue-balance-box">
        <div className="venue-balance-head">
          <b>{v.label} · {network.toUpperCase()} {t('venueBalanceTitle')}</b>
          <button className="mini" disabled={balBusy} onClick={() => loadBalance(v.venue, network, address)}>
            {balBusy ? '...' : t('refreshBalance')}
          </button>
        </div>
        {bal && bal.equityUsdt !== null ? (
          <div className="venue-balance-stats">
            <span>{t('equityUsdt')}: <b>{fmt(bal.equityUsdt)} USDT</b></span>
            <span>{t('availableUsdt')}: <b>{fmt(bal.availableUsdt ?? 0)} USDT</b></span>
            {bal.address && <code>{bal.address.slice(0, 6)}...{bal.address.slice(-4)}</code>}
          </div>
        ) : (
          <p className="wallet-note small">{bal?.error ? bal.error : (bal?.note ?? t('notConnectedBalance'))}</p>
        )}
      </div>

      {v.support === 'signature' && (
        info.available ? (
          <div className="wallet-actions">
            {!address
              ? <button className="wallet-btn" onClick={connect}>{t('connectBrowserWallet')}</button>
              : <><p className="wallet-addr">{t('mainWalletDisplayOnly')} <code>{address.slice(0, 6)}...{address.slice(-4)}</code></p>
                <button className="wallet-btn" disabled={busy} onClick={approve}>{busy ? t('waitingWallet') : `${t('approveAgentPrefix')} ${v.label}`}</button></>}
            {agent && <p className="wallet-addr">{t('agentAddressLabel')} <code>{agent}</code></p>}
            <p className="wallet-note">{t('walletSafetyNote')} {t('revokeAnyTime')} <a href={v.revokeUrl ?? '#'} target="_blank" rel="noreferrer">{v.label} API wallets</a>.</p>
          </div>
        ) : <p className="wallet-note">Connect wallet is off: {info.reason}</p>
      )}
      <ol className="wallet-steps">{v.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
      {v.support !== 'signature' && <p className="wallet-note">{v.label} keys are created in the {v.label} app, then entered in Setup. <a href={v.docsUrl} target="_blank" rel="noreferrer">{t('officialDocs')}</a> · <a href={v.depositUrl} target="_blank" rel="noreferrer">{t('depositOfficial')}</a></p>}
      {state.appMode === 'grokbot' && <p className="wallet-note">Grok Bot mode: use the secret card in Grok Bot for keys.</p>}
      {msg && <p className={`wallet-msg ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</p>}
    </div>
  );
}
