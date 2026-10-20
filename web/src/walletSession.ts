import { useEffect, useState } from 'react';
import { getAddress, zeroAddress } from 'viem';

export interface BrowserWallet {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}
export const browserWallet = () => (window as unknown as { ethereum?: BrowserWallet }).ethereum;

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
  useEffect(() => {
    const wallet = browserWallet();
    let revision = 0;
    let alive = true;
    const sync = async () => {
      const current = ++revision;
      const saved = localStorage.getItem('mg-wallet-address');
      setAddress('');
      if (!saved || !wallet) return;
      try {
        const accounts = await wallet.request({ method: 'eth_accounts' });
        const first = Array.isArray(accounts) && accounts.length ? screenAccount(accounts[0]) : '';
        if (!alive || current !== revision) return;
        if (first.toLowerCase() === saved.toLowerCase()) setAddress(first);
        else saveWalletSession('');
      } catch { if (alive && current === revision) saveWalletSession(''); }
    };
    const changed = () => { ++revision; setAddress(''); saveWalletSession(''); };
    const storage = (event: StorageEvent) => { if (event.key === 'mg-wallet-address') void sync(); };
    void sync();
    wallet?.on?.('accountsChanged', changed);
    wallet?.on?.('chainChanged', changed);
    wallet?.on?.('disconnect', changed);
    window.addEventListener('mg-wallet-updated', sync);
    window.addEventListener('storage', storage);
    return () => {
      alive = false;
      wallet?.removeListener?.('accountsChanged', changed);
      wallet?.removeListener?.('chainChanged', changed);
      wallet?.removeListener?.('disconnect', changed);
      window.removeEventListener('mg-wallet-updated', sync);
      window.removeEventListener('storage', storage);
    };
  }, []);
  return address;
}
