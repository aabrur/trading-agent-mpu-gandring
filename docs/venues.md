# Venues

Trading Agent Mpu Gandring trades perpetual futures on one venue at a time, chosen with `EXCHANGE` (or `npm run setup`). Every venue sits behind the same adapter interface and the same guards. Not financial advice.

## The list

| Venue | Kind | `EXCHANGE` | Status | Key it takes | Stop on the exchange |
| --- | --- | --- | --- | --- | --- |
| Bybit | CEX | `bybit` | implemented (mocked tests only) | API key + secret, trade only | stop attached to the position (`/v5/position/trading-stop`) |
| Binance | CEX | `binance` | experimental | API key + secret, futures on | `STOP_MARKET` closePosition order |
| OKX | CEX | `okx` | experimental | API key + secret + passphrase | attached algo / conditional algo, closeFraction 1 |
| Hyperliquid | DEX | `hyperliquid` | experimental | main ADDRESS + API agent wallet key | reduce-only trigger order |
| Aster | DEX | `aster` | experimental | main ADDRESS + Pro API agent (API wallet) key | `STOP_MARKET` closePosition order |
| dYdX v4 | DEX | `dydx` | experimental, **SDK required** | owner ADDRESS + API Trading Key + authenticator id | conditional reduce-only `STOP_MARKET` |
| Paradex | DEX | `paradex` | experimental | main account ADDRESS + subkey | reduce-only `STOP_MARKET` |
| Orderly | DEX | `orderly` | experimental | account id + Orderly key (read,trading) | `POSITIONAL_TP_SL` algo (CLOSE_POSITION) |

Experimental means nobody has run the adapter against a real account. Every experimental venue needs `ALLOW_EXPERIMENTAL_LIVE=yes` before LIVE will start. PAPER uses public market data only and needs no key.

## Rules that apply to every venue

- **No main wallet key, ever.** DEX venues take a public address plus a delegated key that can trade but cannot withdraw. A key that is (or derives to) the main wallet, a seed phrase, or a key whose permissions cannot be proven trade-only is refused at setup and at every TESTNET/LIVE start.
- **No withdrawal or transfer code.**
- **Stop on every order, resting on the exchange.** After every fill the executor reads the venue's own open trigger orders. A missing stop is placed once; if it still is not there, the position is closed (fail closed). An adapter that cannot place an exchange-side stop is not allowed to open at all. On every start, open venue positions without an exchange-side stop get one (`PROTECT_STOP_PCT`, default 3, from the worse of entry and mark), or are closed if that fails. So positions stay protected while the laptop is off.
- **Send once, reconcile.** One send per intent, then the exchange's own order record decides. No blind retry.
- **Same caps everywhere:** N cap, safety net, daily loss stop, kill switch.

## Env var names

`<P>` is the prefix in the first column. Testnet names add `_TESTNET` after the prefix, for example `ASTER_TESTNET_USER_ADDRESS`.

| Venue | Public field | Secret field | Third field |
| --- | --- | --- | --- |
| Bybit | `BYBIT_API_KEY` (secret) | `BYBIT_API_SECRET` | |
| Binance | `BINANCE_API_KEY` (secret) | `BINANCE_API_SECRET` | |
| OKX | `OKX_API_KEY` (secret) | `OKX_API_SECRET` | `OKX_API_PASSPHRASE` (secret) |
| Hyperliquid | `HYPERLIQUID_ACCOUNT_ADDRESS` | `HYPERLIQUID_AGENT_PRIVATE_KEY` | |
| Aster | `ASTER_USER_ADDRESS` | `ASTER_SIGNER_PRIVATE_KEY` | |
| dYdX v4 | `DYDX_ADDRESS` | `DYDX_API_PRIVATE_KEY` | `DYDX_AUTHENTICATOR_ID` (public number) |
| Paradex | `PARADEX_ACCOUNT_ADDRESS` | `PARADEX_SUBKEY_PRIVATE_KEY` | |
| Orderly | `ORDERLY_ACCOUNT_ID` | `ORDERLY_KEY_SECRET` | |

Optional: `ASTER_BASE_URL`, `ASTER_TESTNET_BASE_URL`, `DYDX_SUBACCOUNT` (default 0), `DYDX_INDEXER_URL`, `DYDX_VALIDATOR_URL`, `PARADEX_BASE_URL`, `ORDERLY_BASE_URL`, `PROTECT_STOP_PCT`.

## The new DEX venues

### Aster (asterdex, futures API v3)

- Docs: https://github.com/asterdex/api-docs (V3 futures, `V3(Recommended)/EN/aster-finance-futures-api-v3.md`), authentication: https://asterdex.github.io/aster-api-website/asterCode/authentication/
- Base: `https://fapi.asterdex.com`, testnet `https://fapi.asterdex-testnet.com`.
- Auth: every signed request carries `user` (main address), `signer` (agent address) and `nonce` (microseconds). The exact query string is signed with EIP-712: domain `AsterSignTransaction` v1, chainId 1666 (testnet 714), type `Message{msg: string}`. `signature` is appended last.
- Delegation: Pro API agents ("API wallets") have their own `canSpotTrade`, `canPerpTrade` and `canWithdraw` flags, set when the main wallet approves the agent (`POST /fapi/v3/approveAgent` or `registerAndApproveAgent`; `canWithdraw` "recommended default false", and an agent with `canWithdraw=true` must have a non-empty IP whitelist). The adapter refuses the main key (signer equals user) before anything else. It then reads `/fapi/v3/account` with the agent signature and accepts an explicit account `canWithdraw: false`. Anything else is refused (fail closed) unless you opt in to the agent check below.
- Account flag vs agent flag. On a normal Aster account `/fapi/v3/account` reports `canWithdraw: true`: that is the ACCOUNT flag ("can transfer out asset"), not your agent's permission, and you cannot switch it off. Aster does expose each agent's own flags: `GET /fapi/v3/agent` ("Get Agents", signed by any authorized signer) lists the agents approved for your main address with `canWithdraw`, `canPerpTrade` and `expired`. Docs: https://asterdex.github.io/aster-api-website/asterCode/endpoints/ (Create / Approve Agent, Update Agent, Get Agents), integration flow: https://asterdex.github.io/aster-api-website/asterCode/integration-flow/, changelog for registerAndApproveAgent: https://asterdex.github.io/aster-api-website/changelog/2026-5-12/.
- Opt in: `ASTER_AGENT_WITHDRAW_OFF_VERIFIED=<your agent address>` (default empty = off). Set it to YOUR OWN agent's address, nobody else's. With it set, when the account flag says `canWithdraw: true` the adapter still accepts the key only if ALL of these hold: the signer key's address equals the pinned address (case-insensitive); the signer is not your main address; the account reports `canTrade: true` explicitly (missing counts as no); `GET /fapi/v3/agent` lists exactly one entry for this signer under your main address; that entry says `canWithdraw: false` and `canPerpTrade: true`; the approval has not expired. Any other answer, or a failed read, is a refusal. The status keeps the real account reading and startup prints one line: `[withdraw guard] ASTER_AGENT_WITHDRAW_OFF_VERIFIED accepted: account canWithdraw true; signer 0x... is a registered agent of 0x... and Aster reports this agent canWithdraw false, canPerpTrade true`. The check runs on every start. If you later turn withdraw on for the agent in Aster, the next start refuses it.
- Withdrawing from Aster also needs an EIP-712 `userSignature` from your wallet (https://asterdex.github.io/aster-api-website/futures-v3/deposit%26withdrawal/). This app has no withdraw or transfer code.
- Caveats: Aster documents that an approved trading agent can move funds between futures and spot (`POST /fapi/v3/asset/wallet/transfer`) and between the owner's own sub-accounts (`POST /fapi/v3/subAccountTransfer`; transfers to external addresses are not supported). Funds stay inside your own Aster accounts, but if you use sub-accounts, know that an agent can move between them. From 1 Sept 2026 trading endpoints need a completed deposit.
- Connect wallet: supported. The app calls `POST /fapi/v3/registerAndApproveAgent`, signed by your wallet on chain id 56, with `canWithdraw=false` forced, `canSpotTrade=false`, `canPerpTrade=true`.
- Public data: ticker, `premiumIndex` (funding), klines.

### dYdX v4

- Docs: https://docs.dydx.xyz/concepts/trading/authenticators, https://docs.dydx.xyz/interaction/permissioned-keys, creating a key in the app: https://help.dydx.trade/en/articles/267486-api-trading-keys-creating-a-new-key-on-the-front-end
- Indexer (reads): `https://indexer.dydx.trade/v4`, testnet `https://indexer.v4testnet.dydx.exchange/v4`.
- Delegation: API Trading Keys are permissioned keys (authenticators). The adapter reads the authenticator on chain and accepts only `AllOf(SignatureVerification(this key), MessageFilter(MsgPlaceOrder / MsgCancelOrder / MsgBatchCancel))`. No message filter, `AnyOf`, a different key, or any extra message type (transfers, withdrawals) is refused. The owner key is refused.
- **SDK required.** Orders, the authenticator check and the withdraw-off check are signed and broadcast with the official SDK `@dydxprotocol/v4-client-js`, loaded only when trading on dYdX. Without it the dYdX permission check fails and the desk refuses to start TESTNET or LIVE on dYdX (fail safe); public market data and sizing still work.
- It is deliberately not bundled, not even as an optional dependency: v3.6 pulls 88 packages and `npm audit` reports 12 advisories (1 critical in `protobufjs`, high in `axios` and `@cosmjs/*`) against 0 for this app without it (checked 2026-10-17). Install it yourself only on the machine that trades dYdX: `npm install @dydxprotocol/v4-client-js`. `npm run doctor` says whether it is installed.
- Stops: conditional `STOP_MARKET`, reduce only, good for 28 days. Market orders use a 2% worst price.
- Connect wallet: not supported (no EVM signature approval this app can use). Manual steps in the office and in setup.

### Paradex

- Docs: https://docs.paradex.trade/api/general-information/api-authentication, reference SDK https://github.com/tradeparadex/paradex-py
- Base: `https://api.prod.paradex.trade/v1`, testnet `https://api.testnet.paradex.trade/v1`.
- Delegation: subkeys can place, modify and cancel orders but cannot withdraw, transfer or manage keys. The adapter looks the key up with `GET /v1/account/keys/subkeys/{public_key}` and refuses it if it is not a registered (non revoked) subkey of the account. A main account key is not a subkey, so it is refused.
- Auth: JWT from `POST /v1/auth/{subkey_public_key}` signed with Starknet typed data (`Request`, domain `Paradex` v1 with the chain id from `/v1/system/config`). Each order is signed (`Order{timestamp, market, side, orderType, size, price}`, 8 decimals).
- Connect wallet: not supported (Starknet subkeys). Manual steps.

### Orderly Network

- Docs: https://orderly.network/docs/build-on-omnichain/api-authentication, adding a key: https://orderly.network/docs/build-on-omnichain/restful-api/public/add-orderly-key, key info: https://orderly.network/docs/build-on-omnichain/restful-api/private/get-current-orderly-key-info
- Base: `https://api.orderly.org`, testnet `https://testnet-api.orderly.org`. Symbols are `PERP_<COIN>_USDC`.
- Delegation: an Orderly key is an ed25519 key with a scope. Withdrawals and transfers need a wallet EIP-712 signature, so an Orderly key cannot withdraw. The adapter reads `GET /v1/client/key_info` and requires the key to be ACTIVE, not expired, with scope only `read` and `trading`. A hex value that looks like a wallet private key is refused before anything is sent.
- Auth: ed25519 over `timestamp + METHOD + path?query + body`, base64url.
- Stops: one `POSITIONAL_TP_SL` algo per symbol and side (STOP_LOSS / TAKE_PROFIT, CLOSE_POSITION).
- Connect wallet: not built yet (manual steps).
- Public candles come from `/v1/tv/history` (the `/v1/kline` endpoint needs a key).

## Considered and skipped

| Venue | Why skipped |
| --- | --- |
| Lighter | API keys can perform withdrawals (documented: https://apidocs.lighter.xyz/docs/api-keys), so a Lighter trading key is withdraw-capable. Signing also needs a native Poseidon/Goldilocks signer. |
| ApeX Omni | The zkKeys that sign orders also sign withdrawals (https://api-docs.pro.apex.exchange/), so the trading credential can withdraw. |
| edgeX | The v2 L2 signing key also signs transfers to other accounts (https://edgex-1.gitbook.io/edgeX-documentation/api-v2/sign). Its public API also answered 503 from our test box. |
| Drift (now the Velocity gateway) | Trading goes through a self-hosted gateway plus a Solana RPC (https://github.com/drift-labs/gateway). A delegate cannot withdraw, but this app cannot verify that the gateway runs with a delegate key rather than the owner key. |

## Public data from the build box (checked 17 Oct 2026)

All four new venues answered with live data (ticker, candles, funding), mainnet and testnet: Aster, dYdX indexer, Paradex, Orderly. Hyperliquid also answers. Bybit and Binance public endpoints are blocked from that box, so the app falls through to the next source and finally to sample data, exactly as before. Your own network may differ: `npm run gb -- market BTC --source aster`.

## What is tested

Mocked APIs only: signing format, key refusal, order plus exchange-side stop, fail-closed when the stop is rejected or not kept, reconcile, and startup re-placement of missing stops (`tests/dex.test.ts`, `tests/protection.test.ts`). No real DEX account, real wallet or real funds were used. Watch the first trades closely.
