# Trading Agent Mpu Gandring: private host read-only checklist

Status: NOT EXECUTED. Needs verification, based on no access to the actual Grok Bot host during this local patch. Run beside the actual host Office after a separately authorized deployment. Keep authenticated output private and redact identifiers; never print `.env`, tokens, addresses, secret-store entries or keys.

## Source and running process

Record `git status --short`, `git rev-parse HEAD`, package version, host UTC time, Node and optional Python version. Do not install or restart anything while checking.

```sh
npm run gb -- health --json
npm run gb -- context --json
npm run gb -- capabilities --json
npm run gb -- candles NEARUSDT 15m --source aster --json
npm run gb -- candles HYPEUSDT 15m --source aster --json
npm run gb -- research market_snapshot NEARUSDT --json
npm run gb -- positions --json
```

Use `--network testnet` on public market commands if that is the intended source. Default public Aster requests are mainnet; `provenance.network` records what was actually used. CLI public reads and a running Office are separate processes. `context` reads the Office's active `/api/state`; it does not hot-load the CLI's environment into the Office.

Compare health `instanceId`, `runtime.processStartedAt`, repository SHA/dirty state captured at initialization, active mode/network/profile, `trading.values.minEntryConfidencePct`, and `runtime.active` against the intended instance. Compare `runtime.saved`, including `thresholdOrigin`; a source default is not a saved explicit value. A saved value differing from active state is evidence of drift, not permission to reload or restart LIVE.

Compare every `runtime.canonicalProfiles` digest with actual installed native role text and shared operating contract. Obtain actual platform profile/template/routine version or digest from its own read tools. `installedProfiles.status=UNAVAILABLE` means the backend cannot observe the native platform. A repository edit alone does not update it.

## Candles, sources and symbols

Require returned `.source === 'aster'`, `example === false` and matching actual network before calling candles native Aster. Otherwise describe them as labeled reference/sample data. Check requested and actual venue for every timeframe, ticker, depth and tape separately; Binance spot candles are not Aster perpetual candles. Compare equal symbol, timeframe, units and opening times. Cross-venue OHLC differences alone are not tape mismatches.

Each `t` is opening UTC milliseconds. `t + intervalMs <= observedAt` is closed, including equality. Do not remove the final row again. Inspect lastClosedOpenAt/lastClosedAt, collection start/end, latency, duplicates/conflicting duplicates, ordering, gaps, stale and future timestamps. Clock skew and missing bars are findings, not invented zeros or a new automatic veto.

For 1000FLOKI, separately run:

```sh
npm run gb -- symbol 1000FLOKIUSDT 15m --network mainnet --json
npm run gb -- candles 1000FLOKIUSDT 15m --source aster --json
```

Inspect LISTED/NOT_LISTED/UNAVAILABLE independently from candle availability and explicit provider errors. Absence from ASTER_GROUP_B only concerns a fee category. Preserve the Owner symbol list.

## Native scheduling and research evidence

Read the native routine's actual interval, timezone/phase, last scheduled/actual start, next run, and paused/running state. Compare interval with `runtime.routine.ownerCadenceMin`, preserving the Owner's saved cadence. Grok Bot disables the local auto loop; its state is not native routine proof. Native phase/run fields remain UNKNOWN until actual platform readback. Do not change routines during this checklist.

A 15m routine at 08:07 samples the bar closed 08:00 seven minutes late; the next run at 08:22 samples the 08:15 close seven minutes late. Four seconds of collection plus 90 seconds of debate puts submission at 08:08:34 and 08:23:34 respectively. This is arithmetic, not measured host latency. Record actual debate/submission/acceptance observations separately.

For macro claims, retain source URL, publication time, event time, window start/end, retrieval time, value, unit, scope and VERIFIED/REPORTED/INFERRED/UNAVAILABLE status. A fresh article quoting 15 October is not a current 24h liquidation metric. Without an explicit metric window, retain UNKNOWN/REPORTED. Check standalone native web tools as well as backend news responses.

## Protection, capabilities and Discord

Capabilities report code implementation and UNVERIFIED_LIVE separately from credential configuration. A successful unit test or numeric stop does not prove a venue order exists. Only a genuine exchange fill and private authenticated venue readback can attest actual resting protection. This checklist does not authorize an order to obtain that evidence. Compare any existing position's recorded protection with actual venue orders through the Owner's already-authorized read tools.

Read `gb entries --json` if GTC entries exist. Do not submit, cancel, close or retry an order as part of this checklist. UNKNOWN requires private reconciliation in a separately authorized operational session.

Discord production smoke, performed by the Owner in the configured private channel: send `/status` using an allowlisted account, record receipt time, check that the signed handler accepted it, and compare the returned mode/venue/settings with the same Office context. A refusal, missing response or wrong instance remains FAIL/UNKNOWN. Do not publish command endpoints, tokens or account identifiers. Local signed-handler tests prove only engineering behavior.

## Separately authorized deployment delta

Use the local remediation commit recorded in `CODE_CHANGES.md`; no push or remote deployment occurred here. The exact source file delta is available with `git diff --name-only 42d85251af9f7f9706a2dd6ec38aef7037c2d6e2 <remediation-commit>`.

Deploy changed `server/` and `cli/` sources plus their build output and local documentation. Locked dependencies and app version are unchanged. Refresh the existing Technical Market and Macro Research canonical role text, and refresh the shared operating contract attached to all six existing profiles. Update existing routine instructions from BOOTSTRAP/OPERATIONS while preserving cadence and authorization state. Never recreate agents/routines or rerun new-install defaults over the Owner's settings.

Preserve `.env`, secrets, journals, positions, reports and kill state. Any LIVE restart remains a separate Owner decision. If later authorized, verify replacement process identity, health, positions, venue protection and the reset daily-loss baseline immediately afterward. Do not mark this checklist complete without actual host results.
