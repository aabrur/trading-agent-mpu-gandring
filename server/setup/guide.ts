// Per-venue setup guide: the ONE source for the CLI wizard (npm run setup), the office Setup wizard and docs/setup/*.md.
// Links were opened from a test box on LINKS_CHECKED_ON. `login: true` = the page needs you to be signed in (or to connect
// a wallet) before it shows the key form. Each user brings their own account and keys; nothing here belongs to the maintainer.
import { EXCHANGES, VENUE_KIND, VENUE_LABEL, ADAPTER_STATUS, type ExchangeName, type Network } from '../exchange/types.js';
import { envNames, PUBLIC_KEY_FIELD, PUBLIC_THIRD_FIELD } from '../exchange/index.js';

export const LINKS_CHECKED_ON = '2026-10-17';
export interface GuideLink { label: string; url: string; login?: boolean; note?: string }
export interface GuideStep { id: string; title: string; text: string; links: GuideLink[] }
export interface NetGuide { steps: GuideStep[]; note?: string }
export interface VenueGuide {
  venue: ExchangeName; label: string; kind: 'CEX' | 'DEX'; status: 'implemented' | 'experimental';
  /** How you sign in to the venue itself. No venue offers OAuth for a personal trading key; DEXes use your wallet. */
  login: string;
  /** Connect wallet in the office (local mode): one wallet signature approves a fresh agent key. */
  connectWallet: boolean;
  permissionsOn: string[]; permissionsOff: string[]; ip: string; docs: GuideLink[];
  networks: Record<Network, NetGuide>;
  extra?: string;
}

const L = (label: string, url: string, login = false, note?: string): GuideLink => ({ label, url, ...(login ? { login } : {}), ...(note ? { note } : {}) });
const step = (id: string, title: string, text: string, ...links: GuideLink[]): GuideStep => ({ id, title, text, links });
const METAMASK = L('MetaMask', 'https://metamask.io/download/'), RABBY = L('Rabby', 'https://rabby.io/');

export const VENUE_GUIDES: Record<ExchangeName, VenueGuide> = {
  bybit: {
    venue: 'bybit', label: VENUE_LABEL.bybit, kind: 'CEX', status: ADAPTER_STATUS.bybit,
    login: 'Email or phone account. API keys only (no OAuth for personal keys). Keys can only be created on the website, not in the app; new accounts may wait 48 hours.',
    connectWallet: false,
    permissionsOn: ['API transaction, Read-Write', 'Contract (derivatives): Orders and Positions'],
    permissionsOff: ['Withdraw', 'Transfer / Assets / Wallet', 'Everything not listed above'],
    ip: 'Bind the key to your IP address if you have a fixed one (recommended). Bybit may expire keys that have no IP bound; then make a new one.',
    docs: [L('How to create your API key', 'https://www.bybit.com/en/help-center/article/How-to-create-your-API-key'), L('Bybit API docs', 'https://bybit-exchange.github.io/docs/v5/guide')],
    networks: {
      testnet: { note: 'Bybit testnet is a separate site with its own account (PC browser only).', steps: [
        step('signup', 'Create a Bybit testnet account', 'Register with email or phone on the testnet site. It is a different account from mainnet.', L('Bybit testnet sign-up', 'https://testnet.bybit.com/register'), L('Guide', 'https://www.bybit.com/en/help-center/article/How-to-Request-Test-Coins-on-Testnet')),
        step('funds', 'Get test coins', 'Assets, Assets Overview, Request Test Coins (10,000 USDT, once every 24 hours). Move USDT to the derivatives/unified account if asked.', L('Bybit testnet', 'https://testnet.bybit.com/', true)),
        step('key', 'Create the testnet API key', 'API Management, Create New Key, System-generated. Tick only the permissions below. Withdraw and transfer stay OFF.', L('Testnet API management', 'https://testnet.bybit.com/app/user/api-management', true))] },
      mainnet: { steps: [
        step('signup', 'Create a Bybit account', 'Register and finish identity verification (KYC) as Bybit requires for your country.', L('Bybit sign-up', 'https://www.bybit.com/register')),
        step('funds', 'Deposit USDT', 'Deposit only what you can afford to lose and keep it in the derivatives/unified trading account.', L('Bybit', 'https://www.bybit.com/', true)),
        step('key', 'Create the API key', 'API Management, Create New Key, System-generated. Tick only the permissions below. Withdraw and transfer stay OFF.', L('API management', 'https://www.bybit.com/app/user/api-management', true))] }
    }
  },
  binance: {
    venue: 'binance', label: VENUE_LABEL.binance, kind: 'CEX', status: ADAPTER_STATUS.binance,
    login: 'Email or phone account. API keys only (no OAuth for personal keys).',
    connectWallet: false,
    permissionsOn: ['Enable Reading', 'Enable Futures'],
    permissionsOff: ['Enable Withdrawals', 'Universal Transfer', 'Margin / Spot trading (not needed)'],
    ip: 'Restrict the key to trusted IPs (recommended). Binance only allows withdrawals on IP-restricted keys; keep withdrawals off anyway.',
    docs: [L('How to create API keys', 'https://www.binance.com/en/support/faq/how-to-create-api-keys-on-binance-360002502072', false, 'bot check, open in a browser'), L('USD-M futures API docs', 'https://developers.binance.com/docs/derivatives/usds-margined-futures/general-info', false, 'bot check, open in a browser')],
    networks: {
      testnet: { note: 'Binance replaced the old futures testnet with Demo Trading. Old testnet keys were deleted; create Demo Trading keys. This app talks to https://demo-fapi.binance.com on TESTNET.', steps: [
        step('signup', 'Use your Binance account in Demo Trading', 'Demo Trading uses your normal Binance login. Sign up first if you have no account.', L('Binance sign-up', 'https://accounts.binance.com/register', false, 'bot check, open in a browser')),
        step('funds', 'Open Demo Trading futures', 'The demo account comes with demo funds; you can reset them in the UI.', L('Binance Demo Trading futures', 'https://demo.binance.com/en/futures/BTCUSDT', true)),
        step('key', 'Create a Demo Trading API key', 'Demo Trading, API Key Management, Create API. Tick only the permissions below.', L('Demo API management', 'https://demo.binance.com/en/my/settings/api-management', true))] },
      mainnet: { steps: [
        step('signup', 'Create a Binance account', 'Register and finish identity verification (KYC). Open a USD-M futures account.', L('Binance sign-up', 'https://accounts.binance.com/register', false, 'bot check, open in a browser')),
        step('funds', 'Deposit USDT to USD-M futures', 'Only what you can afford to lose.'),
        step('key', 'Create the API key', 'API Management, Create API, System generated. Tick only the permissions below. Withdrawals OFF.', L('API management', 'https://www.binance.com/en/my/settings/api-management', true))] }
    }
  },
  okx: {
    venue: 'okx', label: VENUE_LABEL.okx, kind: 'CEX', status: ADAPTER_STATUS.okx,
    login: 'Email or phone account. API keys only (no OAuth for personal keys). OKX may require a minimum balance before it lets you create an API key.',
    connectWallet: false,
    permissionsOn: ['Read', 'Trade'],
    permissionsOff: ['Withdraw'],
    ip: 'Add your IP to the allowlist (up to 20). Keys with Trade permission and no IP expire after 14 days without use (demo keys do not expire).',
    docs: [L('OKX API FAQ', 'https://www.okx.com/help/api-faq'), L('OKX API docs (Demo Trading Services)', 'https://www.okx.com/docs-v5/en/')],
    networks: {
      testnet: { note: 'OKX has no separate testnet site: Demo Trading inside your normal account. The app sends the x-simulated-trading header.', steps: [
        step('signup', 'Create an OKX account', 'Demo Trading uses your normal OKX login.', L('OKX sign-up', 'https://www.okx.com/account/register')),
        step('funds', 'Switch to Demo Trading', 'Trade, Demo Trading. The demo account comes with demo funds.', L('What is demo trading', 'https://www.okx.com/help/how-to-use-demo-trading')),
        step('key', 'Create a Demo Trading API key', 'In Demo Trading: Personal Center, Demo Trading API, Create Demo Trading API Key. Permission Trade only. Save key, secret and passphrase.', L('OKX API FAQ (demo key steps)', 'https://www.okx.com/help/api-faq'))] },
      mainnet: { steps: [
        step('signup', 'Create an OKX account', 'Register and verify as OKX requires for your country.', L('OKX sign-up', 'https://www.okx.com/account/register')),
        step('funds', 'Deposit USDT to the trading account', 'Only what you can afford to lose.'),
        step('key', 'Create the API key', 'Profile, API, Create API key. Permissions Read + Trade, never Withdraw. Choose a passphrase; you need it in the app.', L('OKX API keys', 'https://www.okx.com/account/my-api', true))] }
    }
  },
  hyperliquid: {
    venue: 'hyperliquid', label: VENUE_LABEL.hyperliquid, kind: 'DEX', status: ADAPTER_STATUS.hyperliquid,
    login: 'Connect a wallet (MetaMask, Rabby) or email login. No password, no OAuth. The app only ever gets an API agent wallet key, never your wallet key.',
    connectWallet: true,
    permissionsOn: ['API agent wallet (can place and cancel orders)'],
    permissionsOff: ['Agent wallets cannot withdraw by design. Never enter your main wallet private key or seed phrase.'],
    ip: 'No IP allowlist on Hyperliquid. Revoke the agent on the API page any time.',
    docs: [L('Nonces and API wallets', 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets'), L('Testnet faucet', 'https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/testnet-faucet')],
    networks: {
      testnet: { note: 'The faucet only pays addresses that have deposited on mainnet. Email logins get a different address on testnet; use a wallet extension.', steps: [
        step('signup', 'Connect your wallet on Hyperliquid testnet', 'Open the testnet app and connect MetaMask or Rabby.', L('Hyperliquid testnet', 'https://app.hyperliquid-testnet.xyz/', true), METAMASK, RABBY),
        step('funds', 'Claim mock USDC', '1,000 mock USDC from the drip page (the same address must have a mainnet deposit).', L('Testnet faucet (drip)', 'https://app.hyperliquid-testnet.xyz/drip', true)),
        step('key', 'Approve an agent wallet', 'Easiest: the office Connect wallet button (local mode) makes a fresh agent key on your computer and asks for ONE signature. Or by hand: API page, Generate, Authorize, copy the agent private key.', L('Testnet API page', 'https://app.hyperliquid-testnet.xyz/API', true))] },
      mainnet: { steps: [
        step('signup', 'Connect your wallet on Hyperliquid', 'Open the app and connect MetaMask or Rabby.', L('Hyperliquid', 'https://app.hyperliquid.xyz/trade', true), METAMASK, RABBY),
        step('funds', 'Deposit USDC', 'Deposit from Arbitrum in the app. Only what you can afford to lose.'),
        step('key', 'Approve an agent wallet', 'Office Connect wallet button (one signature) or by hand: API page, Generate, Authorize, copy the agent private key.', L('API page', 'https://app.hyperliquid.xyz/API', true))] }
    }
  },
  aster: {
    venue: 'aster', label: VENUE_LABEL.aster, kind: 'DEX', status: ADAPTER_STATUS.aster,
    login: 'Connect a wallet (MetaMask, Rabby). No OAuth. The app only ever gets a Pro API agent (API wallet) key with withdraw off.',
    connectWallet: true,
    permissionsOn: ['Pro API agent: perpetual trading'],
    permissionsOff: ['Withdraw', 'Spot trading (not needed)', 'Never your main wallet key or seed phrase'],
    ip: 'Optional IP allowlist when you create the API wallet by hand.',
    docs: [L('Aster API docs', 'https://github.com/asterdex/api-docs'), L('Futures authentication', 'https://asterdex.github.io/aster-api-website/asterCode/authentication/'), L('Agent endpoints (approveAgent, Get Agents: per-agent canWithdraw)', 'https://asterdex.github.io/aster-api-website/asterCode/endpoints/')],
    extra: 'Optional ASTER_AGENT_WITHDRAW_OFF_VERIFIED (off by default). Aster accounts report the ACCOUNT flag canWithdraw=true even when your agent cannot withdraw, so without this LIVE/TESTNET is refused. Withdraw permission is set per agent: create a trade-only Aster agent (perp on, canWithdraw false; Connect wallet does this for you), then set ASTER_AGENT_WITHDRAW_OFF_VERIFIED to YOUR OWN agent address (the address of your agent key, never your main wallet). On every start the app reads GET /fapi/v3/agent and accepts the key only if Aster lists that agent for your main address with canWithdraw false, canPerpTrade true and not expired, and the account says canTrade true. Docs: https://asterdex.github.io/aster-api-website/asterCode/endpoints/ (Get Agents) and docs/venues.md.',
    networks: {
      testnet: { note: 'Aster may require a completed deposit before trading endpoints work.', steps: [
        step('signup', 'Connect your wallet on Aster testnet', 'Open the testnet site and connect MetaMask or Rabby.', L('Aster testnet', 'https://www.asterdex-testnet.com/', true), METAMASK, RABBY),
        step('funds', 'Claim test funds', 'Testnet faucet (test USDT).', L('Aster testnet faucet', 'https://www.asterdex-testnet.com/en/faucet', true)),
        step('key', 'Authorize an API wallet', 'Easiest: the office Connect wallet button (local mode) registers a fresh agent with withdraw forced OFF, ONE signature. Or by hand: API wallet page, Pro API, Authorize new API wallet: perp on, spot off, withdraw off.', L('Testnet API wallet', 'https://www.asterdex-testnet.com/en/api-wallet', true))] },
      mainnet: { steps: [
        step('signup', 'Connect your wallet on Aster', 'Open Aster and connect MetaMask or Rabby (BNB Chain).', L('Aster', 'https://www.asterdex.com/en/trade/pro/futures/BTCUSDT', true), METAMASK, RABBY),
        step('funds', 'Deposit USDT', 'Only what you can afford to lose. A completed deposit is required for trading endpoints.'),
        step('key', 'Authorize an API wallet', 'Office Connect wallet button (withdraw forced OFF) or by hand on the API wallet page: perp on, spot off, withdraw off.', L('API wallet', 'https://www.asterdex.com/en/api-wallet', true))] }
    }
  },
  dydx: {
    venue: 'dydx', label: VENUE_LABEL.dydx, kind: 'DEX', status: ADAPTER_STATUS.dydx,
    login: 'Connect a wallet in the dYdX app. No OAuth. The app only takes an API Trading Key (place/cancel only), never the owner key.',
    connectWallet: false,
    permissionsOn: ['API Trading Key: place and cancel orders'],
    permissionsOff: ['Transfers and withdrawals (an API Trading Key cannot do them)', 'Never the owner key or seed phrase'],
    ip: 'No IP allowlist. Remove the key in the dYdX app any time.',
    extra: 'SDK required: run `npm install @dydxprotocol/v4-client-js` in the app folder before TESTNET or LIVE (not bundled, see docs/venues.md).',
    docs: [L('API Trading Keys (create in the app)', 'https://help.dydx.trade/en/articles/267486-api-trading-keys-creating-a-new-key-on-the-front-end'), L('Permissioned keys', 'https://docs.dydx.xyz/interaction/permissioned-keys'), L('Endpoints and faucet', 'https://docs.dydx.xyz/interaction/endpoints')],
    networks: {
      testnet: { note: 'Test USDC comes from the dYdX faucet API (https://faucet.v4testnet.dydx.exchange, used by the testnet app and the official SDK FaucetClient); it has no web page of its own.', steps: [
        step('signup', 'Connect your wallet on the dYdX testnet app', 'Open the testnet app and connect a wallet.', L('dYdX testnet app', 'https://v4.testnet.dydx.exchange/', true), METAMASK, RABBY),
        step('funds', 'Get test USDC', 'Use the faucet in the testnet app, or the SDK FaucetClient.', L('Faucet client docs', 'https://docs.dydx.xyz/faucet-client')),
        step('key', 'Create an API Trading Key', 'In the app: More, API Trading Keys, create a key. Copy your dydx1 address, the key private key and the authenticator id.', L('How to create the key', 'https://help.dydx.trade/en/articles/267486-api-trading-keys-creating-a-new-key-on-the-front-end'))] },
      mainnet: { steps: [
        step('signup', 'Connect your wallet on dYdX', 'Open dydx.trade and connect a wallet.', L('dYdX', 'https://dydx.trade/trade/ETH-USD', true), METAMASK, RABBY),
        step('funds', 'Deposit USDC', 'Only what you can afford to lose.'),
        step('key', 'Create an API Trading Key', 'More, API Trading Keys, create a key (place/cancel only).', L('How to create the key', 'https://help.dydx.trade/en/articles/267486-api-trading-keys-creating-a-new-key-on-the-front-end'))] }
    }
  },
  paradex: {
    venue: 'paradex', label: VENUE_LABEL.paradex, kind: 'DEX', status: ADAPTER_STATUS.paradex,
    login: 'Connect a wallet (EVM or Starknet) in the Paradex app. No OAuth. The app only takes a subkey (cannot withdraw or transfer).',
    connectWallet: false,
    permissionsOn: ['Subkey: place, modify, cancel orders'],
    permissionsOff: ['Withdrawals, transfers and key management (subkeys cannot)', 'Never the main account key'],
    ip: 'Subkeys can carry an IP allowlist (set through the Paradex API); optional.',
    docs: [L('API authentication (subkeys)', 'https://docs.paradex.trade/api/general-information/api-authentication'), L('Testnet FAQs', 'https://docs.paradex.trade/docs/testnet-faqs')],
    networks: {
      testnet: { note: 'Paradex testnet runs on Sepolia; your wallet may ask to switch network.', steps: [
        step('signup', 'Connect your wallet on Paradex testnet', 'Open the testnet app and connect a wallet.', L('Paradex testnet', 'https://app.testnet.paradex.trade/', true)),
        step('funds', 'Test USDC', 'New testnet accounts get test USDC automatically. Out of funds: create a sub-account and transfer.', L('Testnet FAQs', 'https://docs.paradex.trade/docs/testnet-faqs'), L('Sub-accounts', 'https://docs.paradex.trade/docs/accounts/sub-accounts')),
        step('key', 'Create a subkey', 'Account security settings, Key Management, Subkeys, + Add New Key. The private key is shown once. Copy your account address and the subkey private key.', L('How to create a subkey', 'https://docs.paradex.trade/api/general-information/api-authentication'))] },
      mainnet: { steps: [
        step('signup', 'Connect your wallet on Paradex', 'Open the app and connect a wallet.', L('Paradex', 'https://app.paradex.trade/', true)),
        step('funds', 'Deposit USDC', 'Only what you can afford to lose.'),
        step('key', 'Create a subkey', 'Key Management, Subkeys, + Add New Key. Copy the account address and the subkey private key.', L('How to create a subkey', 'https://docs.paradex.trade/api/general-information/api-authentication'))] }
    }
  },
  orderly: {
    venue: 'orderly', label: VENUE_LABEL.orderly, kind: 'DEX', status: ADAPTER_STATUS.orderly,
    login: 'Orderly has no app of its own: you trade through an Orderly-based frontend (for example WOOFi Pro) with your wallet, or with the official Orderly CLI. No OAuth.',
    connectWallet: false,
    permissionsOn: ['Orderly key with scope read,trading'],
    permissionsOff: ['Withdrawals and transfers (they need your wallet signature, an Orderly key cannot)', 'Never the wallet private key'],
    ip: 'No IP allowlist in this app.',
    docs: [L('Wallet authentication and Orderly keys', 'https://orderly.network/docs/build-on-omnichain/user-flows/wallet-authentication'), L('Accounts', 'https://orderly.network/docs/build-on-omnichain/user-flows/accounts'), L('Add Orderly key', 'https://orderly.network/docs/build-on-omnichain/restful-api/public/add-orderly-key')],
    networks: {
      testnet: { note: 'The official Orderly CLI makes a testnet account, claims test USDC and adds an Orderly key with scope read,trading in four commands (broker id "demo").', steps: [
        step('signup', 'Create a testnet account with the Orderly CLI', 'npm install -g @orderly.network/cli, then follow the Quick Start (Testnet) in the README.', L('Orderly CLI', 'https://github.com/OrderlyNetwork/cli')),
        step('funds', 'Claim test USDC', 'orderly faucet-usdc (1,000 USDC per claim on EVM, up to 5 claims).', L('Faucet docs', 'https://orderly.network/docs/build-on-omnichain/restful-api/public/get-faucet-usdctestnet-only')),
        step('key', 'Add an Orderly key', 'orderly wallet-add-key --scope read,trading. Copy the account id (0x...) and the key secret (ed25519, base58).', L('Orderly CLI', 'https://github.com/OrderlyNetwork/cli'))] },
      mainnet: { steps: [
        step('signup', 'Open an Orderly-based frontend', 'For example WOOFi Pro. Connect your wallet and create the account.', L('WOOFi Pro', 'https://pro.woofi.com/', true), L('Orderly', 'https://orderly.network/')),
        step('funds', 'Deposit USDC', 'Only what you can afford to lose.'),
        step('key', 'Get an Orderly key with scope read,trading', 'Create the key through the add-orderly-key flow (or a frontend that exports it). Copy the account id and the key secret.', L('Add Orderly key', 'https://orderly.network/docs/build-on-omnichain/restful-api/public/add-orderly-key'))] }
    }
  }
};

export interface EnvField { name: string; label: string; secret: boolean; placeholder: string }
/** The .env names the user fills for a venue and network, in order. Public fields (addresses, ids) are not secret. */
export function envFields(venue: ExchangeName, net: Network): EnvField[] {
  const n = envNames(venue, net);
  const pub = PUBLIC_KEY_FIELD.has(venue);
  const out: EnvField[] = [
    { name: n.key, label: pub ? (venue === 'orderly' ? 'Orderly account id (0x..., public)' : venue === 'dydx' ? 'dYdX address (dydx1..., public)' : 'Main account address (public)') : 'API key', secret: !pub, placeholder: pub ? (venue === 'dydx' ? 'dydx1...' : '0x...') : '' },
    { name: n.secret, label: venue === 'hyperliquid' ? 'API agent wallet private key' : venue === 'aster' ? 'API wallet (agent) private key' : venue === 'dydx' ? 'API Trading Key private key' : venue === 'paradex' ? 'Subkey private key' : venue === 'orderly' ? 'Orderly key secret (ed25519:...)' : 'API secret', secret: true, placeholder: '' }
  ];
  if (n.passphrase) out.push({ name: n.passphrase, label: venue === 'dydx' ? 'Authenticator id (number, public)' : 'API passphrase', secret: !PUBLIC_THIRD_FIELD.has(venue), placeholder: '' });
  return out;
}

/** The ordered steps for one venue and network, ending with the steps that are the same everywhere. */
export function guideSteps(venue: ExchangeName, net: Network, appMode: 'local' | 'grokbot' = 'local'): GuideStep[] {
  const g = VENUE_GUIDES[venue];
  const fields = envFields(venue, net).map((f) => f.name).join(', ');
  const enter = appMode === 'grokbot'
    ? step('enter', 'Hand the keys to the app', `Grok Bot mode: enter them ONLY through the Grok Bot secret request card, named ${fields}. Never paste them in chat.`)
    : step('enter', 'Enter the keys on this computer', `Type them into the hidden prompts of npm run setup or the office Setup wizard (they go into .env, chmod 600): ${fields}.${g.connectWallet ? ' Or use Connect wallet instead (one signature, nothing to copy).' : ''} Never paste keys in a chat.`);
  return [
    ...g.networks[net].steps,
    step('permissions', 'Check the permissions', `ON: ${g.permissionsOn.join('; ')}. OFF: ${g.permissionsOff.join('; ')}. ${g.ip}`.replace(/\.\./g, '.')),
    enter,
    step('verify', 'Verify', 'npm run doctor (or the Setup wizard "Run doctor") reads the key once: it must say it can trade and cannot withdraw. A key that can withdraw, a main wallet key or a seed phrase is refused.'),
    step('mode', `Switch to ${net === 'testnet' ? 'TESTNET' : 'LIVE'} and restart`, `${net === 'testnet' ? 'TESTNET' : 'LIVE (explicit confirmation)'} is checked again on every start. Then watch the first order: its stop loss must appear as an open trigger order on ${g.label}.`)
  ];
}

export const MODES = ['PAPER', 'TESTNET', 'LIVE'] as const;
export const MODE_INFO: Record<(typeof MODES)[number], string> = {
  PAPER: 'Simulated trades on public prices. No account, no key. Start here.',
  TESTNET: 'Real exchange testnet or demo account with test money. Needs a testnet/demo key that can trade and cannot withdraw.',
  LIVE: 'Real money, full auto. You can lose it. Needs a mainnet key that is proven trade-only, and an explicit confirmation.'
};
/** Typed by the user (CLI and office) before LIVE is written. */
export const LIVE_CONFIRM_PHRASE = 'I understand LIVE trades real money';

/** Every link in the guide, de-duplicated (docs and the link test use it). */
export function allGuideLinks(): GuideLink[] {
  const seen = new Map<string, GuideLink>();
  for (const v of EXCHANGES) {
    const g = VENUE_GUIDES[v];
    for (const l of [...g.docs, ...g.networks.testnet.steps.flatMap((s) => s.links), ...g.networks.mainnet.steps.flatMap((s) => s.links)]) if (!seen.has(l.url)) seen.set(l.url, l);
  }
  return [...seen.values()];
}
export const venueKind = (v: ExchangeName) => VENUE_KIND[v];
