// Connect wallet (EXPERIMENTAL, untested on real wallets). Local mode only.
// Uses the injected browser wallet (EIP-1193) to read the MAIN address and to sign ONE agent approval.
// It never asks for, exports or stores the main wallet private key or seed.
import { useEffect, useState } from 'react';
import type { DeskState } from '../types';

interface VenueInfo { venue: string; label: string; kind: 'CEX' | 'DEX'; support: 'signature' | 'manual' | 'cex'; steps: string[]; revokeUrl: string | null; docsUrl: string; status: string }
interface WalletState { available: boolean; reason: string; appMode: string; current: string | null; venues: VenueInfo[] }
interface Eip1193 { request(a: { method: string; params?: unknown[] }): Promise<any> }
const eth = () => (window as unknown as { ethereum?: Eip1193 }).ethereum;

export function WalletPanel({ state }: { state: DeskState }) {
  const [info, setInfo] = useState<WalletState | null>(null);
  const [venue, setVenue] = useState<string>('');
  const [network, setNetwork] = useState<'testnet' | 'mainnet'>('testnet');
  const [address, setAddress] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [agent, setAgent] = useState<string>('');

  useEffect(() => { fetch('/api/wallet').then((r) => r.json()).then((d: WalletState) => { setInfo(d); setVenue((v) => v || d.current || 'hyperliquid'); }).catch(() => {}); }, []);
  if (!info) return null;
  const v = info.venues.find((x) => x.venue === venue) ?? info.venues[0];
  const dex = info.venues.filter((x) => x.kind === 'DEX'), cex = info.venues.filter((x) => x.kind === 'CEX');

  async function connect() {
    setMsg(null);
    const w = eth();
    if (!w) { setMsg({ ok: false, text: 'No browser wallet found. Install MetaMask or Rabby, or use the manual steps.' }); return; }
    try { const [a] = await w.request({ method: 'eth_requestAccounts' }); setAddress(a); }
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
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setBusy(false); }
  }

  return (
    <div className="panel wallet-panel">
      <div className="panel-head"><h2>Venue keys</h2><span className="badge">experimental</span></div>
      <div className="wallet-pick">
        <select value={venue} onChange={(e) => { setVenue(e.target.value); setMsg(null); setAgent(''); }} aria-label="venue">
          <optgroup label="DEX">{dex.map((x) => <option key={x.venue} value={x.venue}>{x.label}</option>)}</optgroup>
          <optgroup label="CEX">{cex.map((x) => <option key={x.venue} value={x.venue}>{x.label}</option>)}</optgroup>
        </select>
        {v.support === 'signature' && (
          <div className="seg" role="group" aria-label="network">
            {(['testnet', 'mainnet'] as const).map((n) => <button key={n} className={network === n ? 'on' : ''} onClick={() => setNetwork(n)}>{n}</button>)}
          </div>
        )}
      </div>
      {v.support === 'signature' && (
        info.available ? (
          <div className="wallet-actions">
            {!address
              ? <button className="wallet-btn" onClick={connect}>Connect wallet</button>
              : <><p className="wallet-addr">Main wallet <code>{address.slice(0, 6)}...{address.slice(-4)}</code> (display only)</p>
                <button className="wallet-btn" disabled={busy} onClick={approve}>{busy ? 'Waiting for your wallet...' : `Approve a trade-only agent on ${v.label}`}</button></>}
            {agent && <p className="wallet-addr">Agent address <code>{agent}</code></p>}
            <p className="wallet-note">Trade only, cannot withdraw. Your main wallet key and seed never leave your wallet. Revoke any time: <a href={v.revokeUrl ?? '#'} target="_blank" rel="noreferrer">{v.label} API wallets</a>.</p>
          </div>
        ) : <p className="wallet-note">Connect wallet is off: {info.reason}</p>
      )}
      <ol className="wallet-steps">{v.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
      {v.support !== 'signature' && <p className="wallet-note">{v.kind === 'CEX' ? 'CEX keys are entered with npm run setup.' : `${v.label} keys are created in the ${v.label} app, then entered with npm run setup.`} <a href={v.docsUrl} target="_blank" rel="noreferrer">Official docs</a></p>}
      {state.appMode === 'grokbot' && <p className="wallet-note">Grok Bot mode: use the secret card in Grok Bot for keys.</p>}
      {msg && <p className={`wallet-msg ${msg.ok ? 'ok' : 'bad'}`}>{msg.text}</p>}
      <p className="wallet-note small">Experimental, untested on real wallets. Not financial advice.</p>
    </div>
  );
}
