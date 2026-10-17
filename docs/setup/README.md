# Venue setup guides

<!-- Generated from server/setup/guide.ts by `npm run docs:setup`. -->

Pick one venue. Each guide has a testnet and a mainnet section with the direct links, the permissions to tick, the `.env` names and how to verify. The same steps run in `npm run setup` and in the office Setup wizard.

| Venue | Kind | Adapter | Key path | Testnet key page | Mainnet key page |
| --- | --- | --- | --- | --- | --- |
| [Bybit](bybit.md) | CEX | implemented | manual key | [Testnet API management](https://testnet.bybit.com/app/user/api-management) (sign in / connect wallet first) | [API management](https://www.bybit.com/app/user/api-management) (sign in / connect wallet first) |
| [Binance](binance.md) | CEX | experimental | manual key | [Demo API management](https://demo.binance.com/en/my/settings/api-management) (sign in / connect wallet first) | [API management](https://www.binance.com/en/my/settings/api-management) (sign in / connect wallet first) |
| [OKX](okx.md) | CEX | experimental | manual key | [OKX API FAQ (demo key steps)](https://www.okx.com/help/api-faq) | [OKX API keys](https://www.okx.com/account/my-api) (sign in / connect wallet first) |
| [Hyperliquid](hyperliquid.md) | DEX | experimental | Connect wallet (one signature) or manual | [Testnet API page](https://app.hyperliquid-testnet.xyz/API) (sign in / connect wallet first) | [API page](https://app.hyperliquid.xyz/API) (sign in / connect wallet first) |
| [Aster](aster.md) | DEX | experimental | Connect wallet (one signature) or manual | [Testnet API wallet](https://www.asterdex-testnet.com/en/api-wallet) (sign in / connect wallet first) | [API wallet](https://www.asterdex.com/en/api-wallet) (sign in / connect wallet first) |
| [dYdX v4](dydx.md) | DEX | experimental | manual key | [How to create the key](https://help.dydx.trade/en/articles/267486-api-trading-keys-creating-a-new-key-on-the-front-end) | [How to create the key](https://help.dydx.trade/en/articles/267486-api-trading-keys-creating-a-new-key-on-the-front-end) |
| [Paradex](paradex.md) | DEX | experimental | manual key | [How to create a subkey](https://docs.paradex.trade/api/general-information/api-authentication) | [How to create a subkey](https://docs.paradex.trade/api/general-information/api-authentication) |
| [Orderly](orderly.md) | DEX | experimental | manual key | [Orderly CLI](https://github.com/OrderlyNetwork/cli) | [Add Orderly key](https://orderly.network/docs/build-on-omnichain/restful-api/public/add-orderly-key) |

Rules for every venue: your own account and key; trade permission only; withdrawals and transfers off; never a main wallet private key or seed phrase; keys only in `.env` (or your platform secret store), never in a chat.

No exchange here offers OAuth for a personal trading key: CEXes issue API keys, DEXes use your wallet to approve a delegated key.
