import type express from 'express';
import { z } from 'zod';
import {
  EXCHANGES,
  isLocalLoopbackClient,
  type Network,
  type VenueId
} from '../contracts.js';
import { findSecretLikePayload, WalletService } from '../wallet.js';
import { safe } from '../../redact.js';
import type { SettingsService } from '../settings/service.js';
import type { SecretStore } from '../settings/secrets.js';
import { getVenueAdapter } from '../execution/adapters/factory.js';
import { venueCredentialEnvNames } from '../runtime.js';

export type WalletSupport = 'signature' | 'manual' | 'cex';

export interface VenueWalletGuide {
  support: WalletSupport;
  label: string;
  kind: 'CEX' | 'DEX';
  steps: string[];
  revokeUrl: string | null;
  docsUrl: string;
  depositUrl: string;
}

export const WALLET_GUIDE: Record<VenueId, VenueWalletGuide> = {
  hyperliquid: {
    support: 'signature',
    label: 'Hyperliquid',
    kind: 'DEX',
    revokeUrl: 'https://app.hyperliquid.xyz/API',
    docsUrl: 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets',
    depositUrl: 'https://app.hyperliquid.xyz/portfolio',
    steps: [
      'Connect your wallet: main address is read for display only.',
      'The app makes a fresh agent key on this computer and shows its address.',
      'Sign "ApproveAgent" in your wallet. Agent wallets can trade but cannot withdraw.',
      'The agent key and your main address are saved securely to .env.'
    ]
  },
  aster: {
    support: 'signature',
    label: 'Aster',
    kind: 'DEX',
    revokeUrl: 'https://www.asterdex.com/en/api-wallet',
    docsUrl: 'https://github.com/asterdex/api-docs',
    depositUrl: 'https://www.asterdex.com/en/portfolio',
    steps: [
      'Connect your wallet. Approval switches it to BNB Chain (chain id 56).',
      'The app makes a fresh agent key on this computer and shows its address.',
      'Sign ApproveAgent: perp trading on, spot off, withdraw OFF forced.',
      'The agent key and your main address are saved securely to .env.'
    ]
  },
  dydx: {
    support: 'manual',
    label: 'dYdX v4',
    kind: 'DEX',
    revokeUrl: 'https://dydx.trade',
    docsUrl: 'https://help.dydx.trade/en/articles/267486-api-trading-keys-creating-a-new-key-on-the-front-end',
    depositUrl: 'https://dydx.trade/portfolio',
    steps: [
      'dYdX has no browser-signature agent approval this app can use.',
      'In the dYdX app open More, API Trading Keys, and create a key: trade only.',
      'Copy your dydx1 address, the API key private key and the authenticator id.',
      'Save them to .env or Setup wizard.'
    ]
  },
  paradex: {
    support: 'manual',
    label: 'Paradex',
    kind: 'DEX',
    revokeUrl: 'https://app.paradex.trade',
    docsUrl: 'https://docs.paradex.trade/api/general-information/api-authentication',
    depositUrl: 'https://app.paradex.trade/portfolio',
    steps: [
      'Paradex uses Starknet subkeys, not an EVM wallet approval.',
      'In the Paradex app create a subkey. Subkeys can trade but cannot withdraw.',
      'Copy your Paradex account address and the subkey private key.',
      'Save them to .env or Setup wizard.'
    ]
  },
  orderly: {
    support: 'manual',
    label: 'Orderly',
    kind: 'DEX',
    revokeUrl: 'https://orderly.network/docs/build-on-omnichain/user-flows/wallet-authentication',
    docsUrl: 'https://orderly.network/docs/build-on-omnichain/user-flows/wallet-authentication',
    depositUrl: 'https://app.orderly.network',
    steps: [
      'Create an Orderly key with scope read,trading in an Orderly-based app.',
      'Orderly keys cannot withdraw; withdrawals need your wallet signature.',
      'Copy your Orderly account id and the Orderly key secret.',
      'Save them to .env or Setup wizard.'
    ]
  },
  bybit: {
    support: 'cex',
    label: 'Bybit',
    kind: 'CEX',
    revokeUrl: null,
    docsUrl: 'https://www.bybit.com/app/user/api-management',
    depositUrl: 'https://www.bybit.com/user/assets/deposit',
    steps: [
      'No wallet for a CEX.',
      'Create an API key: Contract trade only, withdrawals OFF.',
      'Save your API key and secret to .env or Setup wizard.'
    ]
  },
  binance: {
    support: 'cex',
    label: 'Binance',
    kind: 'CEX',
    revokeUrl: null,
    docsUrl: 'https://www.binance.com/en/my/settings/api-management',
    depositUrl: 'https://www.binance.com/en/my/wallet/account/main/deposit/crypto/USDT',
    steps: [
      'No wallet for a CEX.',
      'Create an API key: futures on, withdrawals OFF.',
      'Save your API key and secret to .env or Setup wizard.'
    ]
  },
  okx: {
    support: 'cex',
    label: 'OKX',
    kind: 'CEX',
    revokeUrl: null,
    docsUrl: 'https://www.okx.com/account/my-api',
    depositUrl: 'https://www.okx.com/balance/recharge',
    steps: [
      'No wallet for a CEX.',
      'Create an API key with Trade permission only, no Withdraw.',
      'Save your key, secret, and passphrase to .env or Setup wizard.'
    ]
  }
};

export const walletInfo = (venue: VenueId) => ({
  venue,
  ...WALLET_GUIDE[venue]
});

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function walletAccess(o: {
  appMode: string;
  host: string;
  remoteAddress?: string | null;
  hostHeader?: string | null;
  origin?: string | null;
}): { ok: boolean; reason: string } {
  if (o.appMode === 'grokbot') {
    return {
      ok: false,
      reason: 'Grok Bot mode: keys go in through the Grok Bot secret card, not the browser. Connect wallet is off.'
    };
  }
  const boundHost = (o.host && o.host.trim() !== '') ? o.host.trim() : '127.0.0.1';
  if (!(boundHost === '127.0.0.1' || boundHost === 'localhost' || boundHost === '::1')) {
    return {
      ok: false,
      reason: `the office is bound to ${o.host}. Connect wallet works only when it is bound to 127.0.0.1 (set HOST=127.0.0.1).`
    };
  }
  if (!o.remoteAddress || !LOOPBACK_IPS.has(o.remoteAddress)) {
    return { ok: false, reason: 'only available from this computer (localhost).' };
  }
  const hostOk = (h: string) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(h);
  if (!o.hostHeader || !hostOk(o.hostHeader)) {
    return { ok: false, reason: 'open the office at http://127.0.0.1 or http://localhost to use Connect wallet.' };
  }
  if (o.origin && !hostOk(o.origin.replace(/^https?:\/\//, ''))) {
    return { ok: false, reason: 'cross-origin request refused.' };
  }
  return { ok: true, reason: 'local' };
}

export interface WalletRouteDeps {
  settings: SettingsService;
  secrets: SecretStore;
  walletService?: WalletService;
  fetchImpl?: typeof fetch;
}

const HL_BASE: Record<Network, string> = {
  mainnet: 'https://api.hyperliquid.xyz',
  testnet: 'https://api.hyperliquid-testnet.xyz'
};

const ASTER_INFO = 'https://tapi.asterdex.com/info';

async function readAsterPublicBalance(
  fetchImpl: typeof fetch,
  address: string
): Promise<{ equityUsdt: number; availableUsdt: number } | null> {
  try {
    const res = await fetchImpl(ASTER_INFO, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'aster_getBalance',
        params: [address, 'latest']
      })
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { result?: { perpAssets?: Array<{ asset?: string; walletBalance?: string }> } };
    const assets = data?.result?.perpAssets;
    if (!Array.isArray(assets)) return null;
    const row = assets.find((a) => a?.asset === 'USDT');
    const equity = Number(row?.walletBalance);
    if (!Number.isFinite(equity)) return null;
    return { equityUsdt: equity, availableUsdt: equity };
  } catch {
    return null;
  }
}

async function readHyperliquidPublicBalance(
  fetchImpl: typeof fetch,
  network: Network,
  address: string
): Promise<{ equityUsdt: number; availableUsdt: number } | null> {
  try {
    const res = await fetchImpl(`${HL_BASE[network]}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: address })
    });
    if (!res.ok) return null;
    const s = (await res.json()) as { marginSummary?: { accountValue?: string | number }; withdrawable?: string | number };
    const equity = Number(s?.marginSummary?.accountValue);
    const available = Number(s?.withdrawable ?? 0);
    if (!Number.isFinite(equity)) return null;
    return { equityUsdt: equity, availableUsdt: Number.isFinite(available) ? available : equity };
  } catch {
    return null;
  }
}

export function mountWalletRoutes(app: express.Express, deps: WalletRouteDeps): void {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const walletService =
    deps.walletService ??
    new WalletService({
      fetchImpl,
      persistDelegatedSecret: async (record) => {
        const isTestnet = record.network === 'testnet';
        if (record.venue === 'hyperliquid') {
          const keyName = isTestnet
            ? 'HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS'
            : 'HYPERLIQUID_ACCOUNT_ADDRESS';
          const secretName = isTestnet
            ? 'HYPERLIQUID_TESTNET_AGENT_PRIVATE_KEY'
            : 'HYPERLIQUID_AGENT_PRIVATE_KEY';
          deps.secrets.writeSecrets({
            [keyName]: record.mainAddress,
            [secretName]: record.agentPrivateKey
          });
        } else if (record.venue === 'aster') {
          const keyName = isTestnet ? 'ASTER_TESTNET_USER_ADDRESS' : 'ASTER_USER_ADDRESS';
          const secretName = isTestnet
            ? 'ASTER_TESTNET_SIGNER_PRIVATE_KEY'
            : 'ASTER_SIGNER_PRIVATE_KEY';
          const pinKey = isTestnet
            ? 'ASTER_TESTNET_AGENT_WITHDRAW_OFF_VERIFIED'
            : 'ASTER_AGENT_WITHDRAW_OFF_VERIFIED';
          deps.secrets.writeSecrets({
            [keyName]: record.mainAddress,
            [secretName]: record.agentPrivateKey,
            [pinKey]: record.agentAddress
          });
        }
      },
      verifyDelegatedAgent: async ({ venue, network, mainAddress, agentAddress, agentPrivateKey }) => {
        try {
          const adapter = getVenueAdapter(venue, {
            network,
            credentialRef: `${venue}:${network}`,
            fetchImpl,
            readSecret: async () => ({
              key: mainAddress,
              secret: agentPrivateKey,
              verifiedAgentAddress: agentAddress
            })
          });
          const perms = await adapter.permissions();
          const ok = perms.verified && perms.canTrade && perms.canWithdraw === false;
          return { ok, detail: perms.detail };
        } catch (err) {
          return {
            ok: false,
            detail: err instanceof Error ? err.message : 'Venue adapter permission verification failed'
          };
        }
      }
    });

  const getBoundHost = (): string =>
    process.env.HOST && process.env.HOST.trim() !== '' ? process.env.HOST.trim() : '127.0.0.1';

  const requireAccess = (req: express.Request, res: express.Response): boolean => {
    const snap = deps.settings.current();
    const access = walletAccess({
      appMode: snap.effective.appMode,
      host: getBoundHost(),
      remoteAddress: req.socket.remoteAddress,
      hostHeader: req.headers.host ?? null,
      origin: (req.headers.origin as string | undefined) ?? null
    });
    if (!access.ok) {
      res.status(403).json({ ok: false, error: access.reason });
      return false;
    }
    return true;
  };

  app.get('/api/wallet', (req, res) => {
    const snap = deps.settings.current();
    const access = walletAccess({
      appMode: snap.effective.appMode,
      host: getBoundHost(),
      remoteAddress: req.socket.remoteAddress,
      hostHeader: req.headers.host ?? null,
      origin: (req.headers.origin as string | undefined) ?? null
    });

    res.json({
      available: access.ok,
      reason: access.reason,
      appMode: snap.effective.appMode,
      current: snap.effective.venue,
      experimental: true,
      venues: EXCHANGES.map((v) => ({
        ...walletInfo(v as any),
        status: v === 'bybit' ? 'verified' : 'experimental'
      }))
    });
  });

  app.get('/api/wallet/balance', async (req, res) => {
    if (!requireAccess(req, res)) return;

    const snap = deps.settings.current();
    const rawVenue = String(req.query.venue ?? snap.effective.venue).toLowerCase();
    const venue = (EXCHANGES.includes(rawVenue as VenueId) ? rawVenue : snap.effective.venue) as VenueId;
    const network: Network =
      req.query.network === 'mainnet' || (req.query.network !== 'testnet' && snap.effective.mode === 'LIVE')
        ? 'mainnet'
        : 'testnet';
    const rawAddress = typeof req.query.address === 'string' ? req.query.address.trim() : '';
    const address = /^0x[0-9a-fA-F]{40}$/.test(rawAddress) ? rawAddress : null;

    const guide = WALLET_GUIDE[venue as VenueId] ?? {
      depositUrl: 'https://www.bybit.com/user/assets/deposit',
      support: 'cex',
      label: venue.toUpperCase(),
      kind: 'CEX'
    };
    const isDex = ['aster', 'hyperliquid', 'dydx', 'paradex', 'orderly'].includes(venue);
    const label = venue.toUpperCase();
    const depositUrl = guide.depositUrl;

    if (venue === 'hyperliquid' && address) {
      const pub = await readHyperliquidPublicBalance(fetchImpl, network, address);
      if (pub) {
        res.json({
          ok: true,
          venue,
          label,
          kind: 'DEX',
          network,
          configured: true,
          address,
          equityUsdt: pub.equityUsdt,
          availableUsdt: pub.availableUsdt,
          depositUrl
        });
        return;
      }
    }

    if (venue === 'aster' && address) {
      const pub = await readAsterPublicBalance(fetchImpl, address);
      if (pub) {
        res.json({
          ok: true,
          venue,
          label,
          kind: 'DEX',
          network,
          configured: true,
          address,
          equityUsdt: pub.equityUsdt,
          availableUsdt: pub.availableUsdt,
          depositUrl,
          note: 'Public Aster balance. Approve agent key to trade.'
        });
        return;
      }
    }

    try {
      const adapter = getVenueAdapter(venue, {
        network,
        credentialRef: `${venue}:${network}`,
        fetchImpl,
        readSecret: async () => {
          const names = venueCredentialEnvNames(venue, network);
          return {
            key: deps.secrets.getSecret(names.key) ?? '',
            secret: deps.secrets.getSecret(names.secret) ?? '',
            passphrase: names.passphrase ? deps.secrets.getSecret(names.passphrase) : null
          };
        }
      });
      const bal = await adapter.balance();
      const equity = bal.equity !== null ? Number(bal.equity) : null;
      const available = bal.available !== null ? Number(bal.available) : null;
      res.json({
        ok: true,
        venue,
        label,
        kind: isDex ? 'DEX' : 'CEX',
        network,
        configured: true,
        address,
        equityUsdt: equity,
        availableUsdt: available,
        depositUrl
      });
      return;
    } catch (err) {
      const note = safe((err as Error).message);
      res.json({
        ok: true,
        venue,
        label,
        kind: isDex ? 'DEX' : 'CEX',
        network,
        configured: Boolean(address),
        address,
        equityUsdt: null,
        availableUsdt: null,
        depositUrl,
        note: address ? `Connected as ${address}. ${note}` : note
      });
    }
  });

  app.post('/api/wallet/start', async (req, res) => {
    if (!requireAccess(req, res)) return;

    const secretHit = findSecretLikePayload(req.body);
    if (secretHit) {
      res.status(400).json({
        ok: false,
        error: `Refusing payload containing secret: payload contained ${secretHit}. Never paste a private key or seed phrase.`
      });
      return;
    }

    const schema = z.object({
      venue: z.enum(['aster', 'hyperliquid']),
      network: z.enum(['testnet', 'mainnet']),
      mainAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      chainId: z.number().int().positive()
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid start payload.' });
      return;
    }

    try {
      const challenge = await walletService.start(parsed.data.venue, {
        network: parsed.data.network,
        mainAddress: parsed.data.mainAddress,
        chainId: parsed.data.chainId
      });

      res.json({
        ok: true,
        id: challenge.challengeId,
        challengeId: challenge.challengeId,
        agentAddress: challenge.agentAddress,
        typedData: challenge.typedData,
        expiresInSec: challenge.expiresInSec,
        note: challenge.note,
        venue: challenge.venue,
        network: challenge.network,
        mainAddress: challenge.mainAddress
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: safe((err as Error).message) });
    }
  });

  app.post('/api/wallet/approve', async (req, res) => {
    if (!requireAccess(req, res)) return;

    const secretHit = findSecretLikePayload(req.body);
    if (secretHit) {
      res.status(400).json({
        ok: false,
        error: `Refusing payload containing secret: payload contained ${secretHit}. Never paste a private key or seed phrase.`
      });
      return;
    }

    const schema = z.object({
      id: z.string().optional(),
      challengeId: z.string().optional(),
      signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/)
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: 'Invalid approve payload.' });
      return;
    }

    const challengeId = parsed.data.challengeId || parsed.data.id;
    if (!challengeId) {
      res.status(400).json({ ok: false, error: 'Challenge id is required.' });
      return;
    }

    try {
      const result = await walletService.approve(challengeId, parsed.data.signature);

      // Persist agent secret
      if (result.venue === 'aster') {
        const pinKey =
          result.network === 'testnet'
            ? 'ASTER_TESTNET_AGENT_WITHDRAW_OFF_VERIFIED'
            : 'ASTER_AGENT_WITHDRAW_OFF_VERIFIED';
        deps.secrets.writeSecrets({ [pinKey]: result.agentAddress });
      }

      await deps.settings.apply(
        { venue: { exchange: result.venue, network: result.network } },
        deps.settings.current().activeVersion
      );

      res.json({
        ok: true,
        venue: result.venue,
        network: result.network,
        mainAddress: result.mainAddress,
        agentAddress: result.agentAddress,
        note: result.note
      });
    } catch (err) {
      res.status(400).json({ ok: false, error: safe((err as Error).message) });
    }
  });
}
