import {
  EXCHANGES,
  type Network,
  type VenueId
} from '../contracts.js';

export interface GuideLink {
  label: string;
  url: string;
  login?: boolean;
  note?: string;
}

export interface GuideStep {
  id: string;
  title: string;
  text: string;
  links: GuideLink[];
}

export interface GuideField {
  name: string;
  label: string;
  secret: boolean;
  placeholder: string;
}

export interface VenueFieldRow {
  network: string;
  fields: { name: string; set: boolean; shown: string | null }[];
}

export interface VenueGuideDto {
  note: string | null;
  steps: GuideStep[];
  fields: GuideField[];
  venues?: VenueFieldRow[];
  connectWallet: boolean;
  docs: GuideLink[];
}

export function getVenueGuide(venue: VenueId, network: Network = 'testnet'): VenueGuideDto {
  const isDex = ['aster', 'hyperliquid', 'dydx', 'paradex', 'orderly'].includes(venue);

  const docsMap: Record<VenueId, GuideLink[]> = {
    bybit: [
      { label: 'Bybit API Management', url: 'https://www.bybit.com/app/user/api-management' },
      { label: 'Bybit API Docs', url: 'https://bybit-exchange.github.io/docs/v5/guide' }
    ],
    binance: [
      { label: 'Binance API Management', url: 'https://www.binance.com/en/my/settings/api-management' },
      { label: 'Binance Futures Docs', url: 'https://binance-docs.github.io/apidocs/futures/en/' }
    ],
    okx: [
      { label: 'OKX API Management', url: 'https://www.okx.com/account/my-api' },
      { label: 'OKX API Docs', url: 'https://www.okx.com/docs-v5/en/' }
    ],
    aster: [
      { label: 'Aster API Wallet', url: 'https://www.asterdex.com/en/api-wallet' },
      { label: 'Aster GitHub API Docs', url: 'https://github.com/asterdex/api-docs' }
    ],
    hyperliquid: [
      { label: 'Hyperliquid API Wallets', url: 'https://app.hyperliquid.xyz/API' },
      { label: 'Hyperliquid Docs', url: 'https://hyperliquid.gitbook.io/hyperliquid-docs' }
    ],
    dydx: [
      { label: 'dYdX Trading Keys', url: 'https://dydx.trade' },
      { label: 'dYdX v4 Docs', url: 'https://docs.dydx.exchange' }
    ],
    paradex: [
      { label: 'Paradex App', url: 'https://app.paradex.trade' },
      { label: 'Paradex API Docs', url: 'https://docs.paradex.trade' }
    ],
    orderly: [
      { label: 'Orderly Network', url: 'https://orderly.network' },
      { label: 'Orderly Docs', url: 'https://orderly.network/docs' }
    ]
  };

  const fieldsMap: Record<VenueId, GuideField[]> = {
    bybit: [
      { name: 'key', label: 'API Key', secret: false, placeholder: 'Bybit API key' },
      { name: 'secret', label: 'API Secret', secret: true, placeholder: 'Bybit API secret' }
    ],
    binance: [
      { name: 'key', label: 'API Key', secret: false, placeholder: 'Binance API key' },
      { name: 'secret', label: 'API Secret', secret: true, placeholder: 'Binance API secret' }
    ],
    okx: [
      { name: 'key', label: 'API Key', secret: false, placeholder: 'OKX API key' },
      { name: 'secret', label: 'API Secret', secret: true, placeholder: 'OKX API secret' },
      { name: 'passphrase', label: 'Passphrase', secret: true, placeholder: 'OKX Passphrase' }
    ],
    aster: [
      { name: 'key', label: 'Main Account Address (0x...)', secret: false, placeholder: '0x...' },
      { name: 'secret', label: 'Agent Private Key (0x...)', secret: true, placeholder: '0x...' }
    ],
    hyperliquid: [
      { name: 'key', label: 'Main Account Address (0x...)', secret: false, placeholder: '0x...' },
      { name: 'secret', label: 'Agent Private Key (0x...)', secret: true, placeholder: '0x...' }
    ],
    dydx: [
      { name: 'key', label: 'dYdX Address', secret: false, placeholder: 'dydx1...' },
      { name: 'secret', label: 'Private Key', secret: true, placeholder: '0x...' }
    ],
    paradex: [
      { name: 'key', label: 'Account Address', secret: false, placeholder: '0x...' },
      { name: 'secret', label: 'Subkey Private Key', secret: true, placeholder: '0x...' }
    ],
    orderly: [
      { name: 'key', label: 'Orderly Account ID', secret: false, placeholder: '0x...' },
      { name: 'secret', label: 'Orderly Key Secret', secret: true, placeholder: 'base58 secret' }
    ]
  };

  const steps: GuideStep[] = [
    {
      id: 'step-1',
      title: 'Sign in to venue',
      text: `Sign in to ${venue.toUpperCase()} on ${network.toUpperCase()}. Ensure trading permissions are enabled and withdrawal permissions are strictly disabled.`,
      links: docsMap[venue] ?? []
    },
    {
      id: 'step-2',
      title: isDex ? 'Connect wallet or enter delegated agent' : 'Create trade-only API key',
      text: isDex
        ? 'Connect your browser wallet (MetaMask/Rabby) in the Wallet tab to approve a trade-only agent, or paste your delegated trade-only key.'
        : 'Generate an API key with Contract/Futures Trading permissions enabled. Leave Withdrawal and Transfer permissions OFF.',
      links: docsMap[venue] ?? []
    },
    {
      id: 'step-3',
      title: 'Verify key permissions',
      text: 'Run the Doctor check to confirm that the key can trade and cannot withdraw.',
      links: []
    }
  ];

  return {
    note: isDex
      ? `${venue.toUpperCase()} is a decentralized venue. Delegated agent authorization allows trade-only execution without withdrawal permissions.`
      : `${venue.toUpperCase()} is a centralized exchange. Configure trade-only API credentials with withdrawals disabled.`,
    steps,
    fields: fieldsMap[venue] ?? [
      { name: 'key', label: 'Key', secret: false, placeholder: 'API key' },
      { name: 'secret', label: 'Secret', secret: true, placeholder: 'API secret' }
    ],
    connectWallet: venue === 'aster' || venue === 'hyperliquid',
    docs: docsMap[venue] ?? []
  };
}
