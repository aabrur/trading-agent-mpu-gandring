import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

function browserFixture() {
  const values = new Map<string, string>();
  const host = new EventTarget();
  vi.stubGlobal('window', host);
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) });
  return { host, values };
}

describe('browser wallet selection', () => {
  it('discovers multiple EIP-6963 wallets without relying on window.ethereum', async () => {
    const { host } = browserFixture();
    const session = await import('../web/src/walletSession');
    session.discoverWallets();
    const metamask = { request: vi.fn() }, rabby = { request: vi.fn() };
    for (const [rdns, name, provider] of [['io.metamask', 'MetaMask', metamask], ['io.rabby', 'Rabby', rabby]] as const) {
      host.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info: { rdns, name }, provider } }));
    }
    expect(session.walletOptions().map((option) => option.name)).toEqual(['MetaMask', 'Rabby']);
    session.saveWalletSession('0x1111111111111111111111111111111111111111');
    session.selectWallet('io.rabby');
    expect(session.browserWallet()).toBe(rabby);
    expect(localStorage.getItem('mg-wallet-address')).toBeNull();
    expect(() => session.selectWallet('unknown')).toThrow(/no longer available/);
  });

  it('logs out locally when the selected provider cannot revoke permissions', async () => {
    const { host } = browserFixture();
    Object.assign(host, { ethereum: { request: vi.fn().mockRejectedValue(new Error('Unsupported method')) } });
    const session = await import('../web/src/walletSession');
    session.saveWalletSession('0x1111111111111111111111111111111111111111');
    expect(await session.disconnectWallet()).toBe(false);
    expect(localStorage.getItem('mg-wallet-address')).toBeNull();
  });

  it('rejects malformed or zero accounts and keeps the chosen provider on rediscovery', async () => {
    const { host } = browserFixture();
    const session = await import('../web/src/walletSession');
    const provider = { request: vi.fn() };
    session.discoverWallets();
    const detail = { info: { rdns: 'io.rabby', name: 'Rabby' }, provider };
    host.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    session.selectWallet('io.rabby');
    session.saveWalletSession('0x1111111111111111111111111111111111111111');
    host.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    expect(session.walletOptions()).toHaveLength(1);
    expect(localStorage.getItem('mg-wallet-address')).not.toBeNull();
    expect(() => session.screenAccount('0x0000000000000000000000000000000000000000')).toThrow();
    expect(() => session.screenAccount('invalid')).toThrow();
  });
});
