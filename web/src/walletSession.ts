import { useEffect, useState } from 'react';
import { getAddress, zeroAddress } from 'viem';

export interface BrowserWallet {
  providers?: BrowserWallet[];
  isMetaMask?: boolean;
  isRabby?: boolean;
  isPhantom?: boolean;
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}
export interface WalletOption { id: string; name: string; provider: BrowserWallet }
const announced = new Map<string, WalletOption>();
let discovering = false;
export function walletOptions(): WalletOption[] {
  const injected = (window as unknown as { ethereum?: BrowserWallet }).ethereum;
  const options = [...announced.values()];
  for (const [i, provider] of (injected?.providers ?? (injected ? [injected] : [])).entries()) {
    if (!options.some((option) => option.provider === provider)) options.push({ id: `injected-${i}`, name: provider.isRabby ? 'Rabby' : provider.isPhantom ? 'Phantom EVM' : provider.isMetaMask ? 'MetaMask' : 'Browser EVM wallet', provider });
  }
  return options;
}
export function discoverWallets() {
  if (!discovering) {
    discovering = true;
    window.addEventListener('eip6963:announceProvider', (event) => {
      const detail = (event as CustomEvent<{ info?: { rdns?: string; name?: string }; provider?: BrowserWallet }>).detail;
      if (!detail?.info?.rdns || !detail.info.name || typeof detail.provider?.request !== 'function') return;
      announced.set(detail.info.rdns, { id: detail.info.rdns, name: detail.info.name.slice(0, 60), provider: detail.provider });
      window.dispatchEvent(new Event('mg-wallet-providers'));
    });
    window.addEventListener('ethereum#initialized', () => window.dispatchEvent(new Event('mg-wallet-providers')));
  }
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}
export function browserWallet() {
  const options = walletOptions(), selected = localStorage.getItem('mg-wallet-provider');
  return selected ? options.find((option) => option.id === selected)?.provider : options[0]?.provider;
}
export function selectWallet(id: string) {
  if (!walletOptions().some((option) => option.id === id)) throw new Error('Wallet is no longer available. Refresh and select it again.');
  if (localStorage.getItem('mg-wallet-provider') !== id) {
    localStorage.setItem('mg-wallet-provider', id);
    saveWalletSession('');
    window.dispatchEvent(new Event('mg-wallet-providers'));
  }
}
export function useWalletOptions() {
  const [options, setOptions] = useState<WalletOption[]>([]);
  useEffect(() => {
    const update = () => setOptions(walletOptions());
    window.addEventListener('mg-wallet-providers', update);
    discoverWallets(); update();
    return () => window.removeEventListener('mg-wallet-providers', update);
  }, []);
  return options;
}

export function screenAccount(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Wallet did not return an account.');
  const address = getAddress(value);
  if (address === zeroAddress) throw new Error('The zero address cannot connect.');
  return address;
}

export function saveWalletSession(address: string) {
  if (address) localStorage.setItem('mg-wallet-address', address);
  else localStorage.removeItem('mg-wallet-address');
  window.dispatchEvent(new Event('mg-wallet-updated'));
}

export async function disconnectWallet(): Promise<boolean> {
  saveWalletSession('');
  try {
    await browserWallet()?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] });
    return Boolean(browserWallet());
  } catch {
    // Some wallets do not implement permission revocation. Local logout still succeeds.
    return false;
  }
}

export function useWalletSession() {
  const [address, setAddress] = useState('');
  const options = useWalletOptions();
  const wallet = browserWallet();
  useEffect(() => {
    let revision = 0;
    let alive = true;
    const sync = async () => {
      const current = ++revision;
      const saved = localStorage.getItem('mg-wallet-address');
      if (!saved || !wallet) { setAddress(''); return; }
      try {
        const accounts = await wallet.request({ method: 'eth_accounts' });
        const first = Array.isArray(accounts) && accounts.length ? screenAccount(accounts[0]) : '';
        if (!alive || current !== revision) return;
        if (first.toLowerCase() === saved.toLowerCase()) setAddress(first);
        else saveWalletSession('');
      } catch { if (alive && current === revision) saveWalletSession(''); }
    };
    // Account announcements during connect are normal; clear only an actual mismatch.
    const accountsChanged = () => { void sync(); };
    const changed = () => { ++revision; setAddress(''); saveWalletSession(''); };
    const storage = (event: StorageEvent) => { if (event.key === 'mg-wallet-address') void sync(); };
    void sync();
    wallet?.on?.('accountsChanged', accountsChanged);
    wallet?.on?.('chainChanged', changed);
    wallet?.on?.('disconnect', changed);
    window.addEventListener('mg-wallet-updated', sync);
    window.addEventListener('storage', storage);
    return () => {
      alive = false;
      wallet?.removeListener?.('accountsChanged', accountsChanged);
      wallet?.removeListener?.('chainChanged', changed);
      wallet?.removeListener?.('disconnect', changed);
      window.removeEventListener('mg-wallet-updated', sync);
      window.removeEventListener('storage', storage);
    };
  }, [wallet, options]);
  return address;
}
