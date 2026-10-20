import { useEffect, useRef } from 'react';
import type { DeskState } from '../types';
import { useWalletSession } from '../walletSession';
import { WalletPanel } from './Wallet';
import { useI18n } from '../i18n';

export function WalletMenu({ state, open, onOpen, onClose }: { state: DeskState; open: boolean; onOpen: () => void; onClose: () => void }) {
  const { t, lang } = useI18n();
  const address = useWalletSession();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) onClose(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { onClose(); document.getElementById('venue-keys-trigger')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open, onClose]);
  return <div className="wallet-menu" ref={root}>
    <button id="venue-keys-trigger" className={`badge setup-btn connect-wallet-btn${address ? ' is-connected' : ''}`} aria-expanded={open} aria-controls="wallet-dropdown" onClick={open ? onClose : onOpen}>
      {address ? (lang === 'id' ? 'Terhubung' : 'Connected') : t('connectWallet')} <span aria-hidden="true">⌄</span>
    </button>
    {open && <section id="wallet-dropdown" className="wallet-dropdown" aria-label={t('connectWallet')}>
      <div className="panel-head"><h2>{address ? (lang === 'id' ? 'Wallet terhubung' : 'Wallet connected') : t('connectWallet')}</h2><button className="mini" onClick={onClose} aria-label="Close wallet">×</button></div>
      <WalletPanel state={state} embedded />
    </section>}
  </div>;
}
