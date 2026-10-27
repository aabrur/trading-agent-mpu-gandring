// Connect wallet. Local mode only.
// Uses the injected browser wallet to read the MAIN address and to sign ONE agent approval.
// It never asks for, exports or stores the main wallet private key or seed.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeskState } from '../types';
import { useI18n } from '../i18n';
import { fmt } from './format';
import { browserWallet as eth, disconnectWallet, saveWalletSession, screenAccount, selectWallet, useWalletOptions, useWalletSession, type BrowserWallet } from '../walletSession';

const BNB_CHAIN_ID = 56;
async function ensureBnbChain(w: BrowserWallet): Promise<number> {
  const hex = `0x${BNB_CHAIN_ID.toString(16)}`;
  const current = Number(await w.request({ method: 'eth_chainId' }));
  if (current === BNB_CHAIN_ID) return current;
  try {
    await w.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code !== 4902) throw e;
    await w.request({ method: 'wallet_addEthereumChain', params: [{ chainId: hex, chainName: 'BNB Smart Chain', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: ['https://bsc-dataseed.binance.org'], blockExplorerUrls: ['https://bscscan.com'] }] });
  }
  const after = Number(await w.request({ method: 'eth_chainId' }));
  if (after !== BNB_CHAIN_ID) throw new Error('Switch your wallet to BNB Smart Chain, then approve again.');
  return after;
}

interface VenueInfo { venue: string; label: string; kind: 'CEX' | 'DEX'; support: 'signature' | 'manual' | 'cex'; steps: string[]; revokeUrl: string | null; docsUrl: string; depositUrl: string; status: string }
interface WalletState { available: boolean; reason: string; appMode: string; current: string | null; venues: VenueInfo[] }
interface VenueBalance { ok: boolean; venue: string; label: string; kind: 'CEX' | 'DEX'; network: string; configured: boolean; address: string | null; equityUsdt: number | null; availableUsdt: number | null; depositUrl: string; note?: string; error?: string }

export function WalletPanel({ state, embedded = false }: { state: DeskState; embedded?: boolean }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<WalletState | null>(null);
  const [loadError, setLoadError] = useState('');
  const wallets = useWalletOptions();
  const [venue, setVenue] = useState<string>(() => {
    try { return localStorage.getItem('mg-wallet-venue') || 'hyperliquid'; } catch { return 'hyperliquid'; }
  });
  const [network, setNetwork] = useState<'testnet' | 'mainnet'>(() => {
    try {
      const saved = localStorage.getItem('mg-wallet-network');
      return saved === 'mainnet' || saved === 'testnet' ? saved : state.mode === 'LIVE' ? 'mainnet' : 'testnet';
    } catch { return 'testnet'; }
  });
  const address = useWalletSession();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [agent, setAgent] = useState<string>('');
  const [bal, setBal] = useState<VenueBalance | null>(null);
  const [balBusy, setBalBusy] = useState(false);
  const balanceRequest = useRef(0);

  useEffect(() => { ++balanceRequest.current; setAgent(''); setMsg(null); setBal(null); }, [address, venue, network]);

  useEffect(() => {
    fetch('/api/wallet')
      .then((r) => r.json())
      .then((d: WalletState) => {
        if (!Array.isArray(d.venues)) throw new Error('Wallet service is unavailable. Refresh the page to retry.');
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
      .catch(() => setLoadError('Wallet service is unavailable. Refresh the page to retry.'));
  }, []);

  const loadBalance = useCallback((targetVenue: string, targetNet: 'testnet' | 'mainnet', targetAddr: string) => {
    if (!targetVenue) return;
    const request = ++balanceRequest.current;
    setBalBusy(true);
    const qs = new URLSearchParams({ venue: targetVenue, network: targetNet });
    if (targetAddr) qs.set('address', targetAddr);
    fetch(`/api/wallet/balance?${qs.toString()}`)
      .then((r) => r.json())
      .then((d: VenueBalance) => { if (request === balanceRequest.current) setBal(d); })
      .catch(() => {
        if (request !== balanceRequest.current) return;
        setBal({ ok: false, venue: targetVenue, label: targetVenue, kind: 'DEX', network: targetNet, configured: false, address: targetAddr || null, equityUsdt: null, availableUsdt: null, depositUrl: '', error: 'Balance could not be read. Refresh to retry.' });
      })
      .finally(() => { if (request === balanceRequest.current) setBalBusy(false); });
  }, []);

  useEffect(() => {
    if (info && venue) loadBalance(venue, network, address);
  }, [info, venue, network, address, loadBalance]);

  if (!info) return <p className="wallet-note" role="status">{loadError || 'Loading wallet options…'}</p>;
  const dex = info.venues.filter((x) => x.kind === 'DEX');
  const v = dex.find((x) => x.venue === venue) ?? dex[0];
  if (!v) return null;

  async function connect() {
    setBusy(true);
    setMsg(null);
    const w = eth();
    if (!w) { setMsg({ ok: false, text: 'No EVM wallet detected. Open this office in the browser where MetaMask or Rabby is enabled, then refresh. Solana-only wallets cannot approve Aster agents.' }); setBusy(false); return; }
    try {
      const option = wallets.find((option) => option.provider === w);
      if (option) selectWallet(option.id);
      const accounts = await w.request({ method: 'eth_requestAccounts' });
      const a = screenAccount(Array.isArray(accounts) ? accounts[0] : null);
      try {
        localStorage.setItem('mg-wallet-venue', v.venue);
        localStorage.setItem('mg-wallet-network', network);
      } catch { /* ignore */ }
      saveWalletSession(a);
    }
    catch (e) {
      const error = e as { code?: number; message?: string };
      setMsg({ ok: false, text: error.code === -32002 ? 'A connection request is already open. Open the selected wallet extension and finish or reject it before retrying.' : error.code === 4001 ? 'Connection declined in the wallet. Select your wallet and connect again when ready.' : `${t('walletRefusedPrefix')} ${error.message ?? 'The selected wallet did not respond. Refresh and retry.'}` });
    }
    finally { setBusy(false); }
  }
  async function disconnect() {
    setBusy(true);
    const revoked = await disconnectWallet();
    setAgent(''); setBal(null);
    setMsg({ ok: true, text: revoked
      ? 'Browser wallet disconnected. Exchange agent approvals remain active; revoke them on the venue if needed.'
      : 'Logged out locally. Remove this site in your wallet to revoke browser access. Exchange agent approvals remain active.' });
    setBusy(false);
  }
  async function approve() {
    const w = eth();
    if (!w || !address) return;
    setBusy(true); setMsg(null); setAgent('');
    try {
      const accounts = await w.request({ method: 'eth_accounts' });
      if (!Array.isArray(accounts) || screenAccount(accounts[0]) !== address) throw new Error('Wallet account changed. Reconnect before approving.');
      const chainId = v.venue === 'aster' ? await ensureBnbChain(w) : Number(await w.request({ method: 'eth_chainId' }));
      const start = await fetch('/api/wallet/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ venue: v.venue, network, mainAddress: address, chainId }) }).then((r) => r.json());
      if (!start.ok) throw new Error(start.error);
      setAgent(start.agentAddress);
      const td = start.typedData;
      const types = { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }], ...td.types };
      const signature = await w.request({ method: 'eth_signTypedData_v4', params: [address, JSON.stringify({ ...td, types })] });
      const currentAccounts = await w.request({ method: 'eth_accounts' });
      if (!Array.isArray(currentAccounts) || screenAccount(currentAccounts[0]) !== address || Number(await w.request({ method: 'eth_chainId' })) !== chainId || localStorage.getItem('mg-wallet-address') !== address) throw new Error('Wallet session changed. Reconnect and approve again.');
      const done = await fetch('/api/wallet/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: start.id, signature }) }).then((r) => r.json());
      if (!done.ok) throw new Error(done.error);
      if (localStorage.getItem('mg-wallet-address') !== address) return;
      setMsg({ ok: true, text: done.note });
      try {
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
      {!embedded && <div className="panel-head"><h2>{t('connectWallet')}</h2></div>}
      <label className="wallet-provider">Browser wallet<select aria-label="Browser wallet" disabled={busy || !wallets.length} value={wallets.find((option) => option.provider === eth())?.id ?? ''} onChange={(event) => { selectWallet(event.target.value); setMsg(null); }}>
        {!wallets.length && <option value="">No EVM wallet detected</option>}
        {wallets.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select></label>
      <div className="wallet-pick">
        <select value={v.venue} onChange={(e) => { setVenue(e.target.value); setMsg(null); setAgent(''); }} aria-label="venue">
          <optgroup label="DEX">{dex.map((x) => <option key={x.venue} value={x.venue}>{x.label}</option>)}</optgroup>
        </select>
        <select aria-label="Wallet network" value={network} disabled={busy} onChange={(event) => setNetwork(event.target.value as 'testnet' | 'mainnet')}><option value="testnet">Testnet</option><option value="mainnet">Mainnet</option></select>
        <a className="badge deposit-link-btn" href={v.depositUrl} target="_blank" rel="noreferrer">{t('depositOfficial')} ↗</a>
      </div>

      <div className="venue-balance-box">
        <div className="venue-balance-head">
          <b>{v.label} · {network.toUpperCase()} {t('venueBalanceTitle')}</b>
          <button className="mini" disabled={balBusy} aria-busy={balBusy} onClick={() => loadBalance(v.venue, network, address)}>
            {balBusy ? '…' : t('refreshBalance')}
          </button>
        </div>
        {bal && bal.equityUsdt !== null ? (
          <div className="venue-balance-stats">
            <span>{t('equityUsdt')}: <b>{fmt(bal.equityUsdt)} USDT</b></span>
            <span>{t('availableUsdt')}: <b>{bal.availableUsdt == null ? 'Unknown' : fmt(bal.availableUsdt)} USDT</b></span>
            {bal.address && <code translate="no">{bal.address.slice(0, 6)}…{bal.address.slice(-4)}</code>}
            {bal.note && <p className="wallet-note small" role="status">{bal.note}</p>}
          </div>
        ) : (
          <p className="wallet-note small" role="status">{bal?.error ? bal.error : (bal?.note ?? t('notConnectedBalance'))}</p>
        )}
      </div>

      {v.support === 'signature' && (
        info.available ? (
          <div className="wallet-actions">
            {!address
              ? <button className="wallet-btn" disabled={busy} onClick={connect}>{busy ? t('waitingWallet') : t('connectBrowserWallet')}</button>
              : <><p className="wallet-addr">{t('mainWalletDisplayOnly')} <code>{address.slice(0, 6)}...{address.slice(-4)}</code></p>
                <button className="wallet-disconnect" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>
                <details className="wallet-agent-approval"><summary>Venue agent approval</summary><button className="wallet-btn" disabled={busy} onClick={approve}>{busy ? t('waitingWallet') : `${t('approveAgentPrefix')} ${v.label}`}</button></details></>}
            {agent && <p className="wallet-addr">{t('agentAddressLabel')} <code>{agent}</code></p>}
            <p className="wallet-note">Browser connection and exchange agent approval are separate. Disconnecting here does not stop trading or revoke a venue agent.</p>
          </div>
        ) : <p className="wallet-note">{t('walletOffPrefix')} {info.reason}</p>
      )}
      <details className="wallet-help"><summary>Setup &amp; safety</summary><p className="wallet-note">{t('walletSafetyNote')} {t('revokeAnyTime')} <a href={v.revokeUrl ?? v.docsUrl} target="_blank" rel="noreferrer">{v.label} API wallets</a>.</p><ol className="wallet-steps">{v.steps.map((s, i) => <li key={i}>{s}</li>)}</ol></details>
      {v.support !== 'signature' && <p className="wallet-note">{v.label} {t('walletKeysAppNote')} <a href={v.docsUrl} target="_blank" rel="noreferrer">{t('officialDocs')}</a> · <a href={v.depositUrl} target="_blank" rel="noreferrer">{t('depositOfficial')}</a></p>}
      {state.appMode === 'grokbot' && <p className="wallet-note">{t('walletGrokbotSecretNote')}</p>}
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={`wallet-msg ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</p>}
    </div>
  );
}
