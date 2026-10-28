# Trading Agent Mpu Gandring: operational evidence

Release: **v0.0.0.4.8**. Record audit date: **29 October 2026**, using the Owner's Asia/Jakarta date. This statement separates executable functionality, owner-retained mainnet records and complete financial verification.

## What the evidence supports

| Claim | Evidence and result |
| --- | --- |
| The repository implements exchange execution | [Executor](../server/live/executor.ts), venue adapters, persistent intents, fill reconciliation and exchange protection are implemented. Offline tests exercise these paths with fake exchanges |
| Mainnet execution records exist in the Owner's retained data | Observed by the read-only local audit for this release |
| Some engine close intents have positive exchange-reported realized PnL | Observed: positive USDT realized-PnL fill records match a single filled engine close intent by symbol, side and nonempty client/order identifier |
| Complete net realized profit after fees and funding | **Not verified**. Retained accounting coverage does not establish a complete positive net result |
| Independent exchange attestation or public account verification | **Not supplied**. The audit reads retained local records and does not authenticate directly with a venue |
| Future profitability or identical decisions across native agent platforms | No such claim is made |

The supported performance statement is: **the retained mainnet records include positive realized-PnL closes matched to the application's execution intents**. That does not establish independently certified, complete or consistently profitable trading.

## Reproduce privately

After installing dependencies, run:

```sh
npm run evidence:live
```

The [audit script](../scripts/audit-live-records.ts) reads local execution/financial files, checks mainnet journal identity, and requires a unique close-intent match for positive realized PnL. Complete net verification uses the application's existing [financial-evidence accounting](../server/live/financial-evidence.ts). Unmatched income, TESTNET, PAPER, missing lifecycle coverage and unknown costs do not become verified net profit.

The [release audit snapshot](evidence/live-record-audit-v0.0.0.4.8.json) contains only privacy-preserving flags from the actual audit. It excludes amounts, balances, symbols, wallet addresses, account identifiers, client/order identifiers, credentials and raw operational files. Another installation reports its own evidence state; a fresh install normally has no mainnet records.

## Engineering verification

[Public CI](https://github.com/aabrur/trading-agent-mpu-gandring/actions/workflows/ci.yml) executes isolated typecheck, tests and production build. Focused regressions cover long-debate CLOSE freshness, entry-only Risk/confidence admission, native-agent tickets, source-preserving Research repair, session-metadata contention, channel reports and accounting attribution.

These checks use controlled fixtures, never real-money test orders. The LIVE-record statement above is based on the separately retained operational evidence.

## Publication privacy

The release source and reachable Git history are checked for credential patterns. Exact current local secret/identifier values are compared privately with the staged publication tree without printing their values. Operational data stays ignored by Git. Scanner reports remain outside the repository, and synthetic credentials used by mocked tests are classified explicitly. A clean scan is bounded evidence, not a guarantee that any future upload is safe.
