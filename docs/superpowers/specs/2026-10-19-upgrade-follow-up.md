# Trading Agent Mpu Gandring follow-up specification

Owner request: prepare implementation plans and a handoff for the explicitly deferred items after publishing the completed upgrade. This document records that request for future sessions. It does not authorize implementing the follow-up now.

## Verified baseline
- Upgrade: https://github.com/aabrur/trading-agent-mpu-gandring/commit/6ecf9fcc68faa029038ef08a917cf47b0b2f7738
- Release: https://github.com/aabrur/trading-agent-mpu-gandring/releases/tag/v0.0.0.2.7
- Release commit: fa549cb56e9716328678165b7691e95099bc1d5f. npm version 0.2.7, app version 0.0.0.2.7.
- Local release verification on 2026-10-19 Asia/Jakarta: 265 tests across 31 files, typecheck and production build passed. Client JS chunk 526.40 kB minified; warning remains.
- No .github/workflows directory and no GitHub Actions runs were present at inspection. CI is absent, not a pending green run.
- Original implementation ledger: ../plans/2026-10-18-trading-office-upgrade.md. Existing code/diff is authoritative for delivered features; do not implement those again.

## Required outcomes
1. Validate desktop/mobile, day/night, speech, staging and reduced motion using an isolated PAPER/mock installation. Finish meaningful paired agent interactions without creating fake trading/debate events.
2. Record why opportunities were skipped and what subsequently observable market movement occurred. Keep this descriptive and separate from realized PnL, agent correctness scores, risk gates and standing rules.
3. Add read-only, capability-based execution/fee/funding history for supported venues where verified API data allows it. Preserve unknown values and distinguish account-wide entries from position attribution.
4. Reduce the oversized client chunk without hiding warnings or breaking frequent controls. Add normal offline typecheck/test/build CI and verify the exact pushed SHA.

## Global constraints
- Preserve all existing owner trading configuration and guard semantics: TRADING_MODE, EXCHANGE, MARKET_SOURCE, MAX_LEVERAGE, DEFAULT_STOP_PCT, MIN_STOP_PCT, MAX_LOSS_PER_TRADE_PCT, DAILY_LOSS_LIMIT_PCT, MIN_ORDER_USDT, TAKER_FEE, TAKE_PROFIT_R, SAFETY_NET, OPEN_ORDERS_N.
- Preserve auto symbols, interval, maximum holding period, debate rounds, fight threshold, providers/models, reporting and notification cadence, wallet setup and kill-switch behavior.
- Never read, copy, edit, print or commit the owner's .env or credentials. Never run exchange orders, round trips, permission-changing setup or LIVE-account experiments as validation.
- No new trading thresholds, cooldowns, risk penalties, approval steps, automatic reversals or duplicate order retries. Do not remove existing guards.
- No paid data services, new runtime packages, broad test infrastructure or unrelated refactoring. Use existing TypeScript, React, SVG, CSS, Vitest and Vite.
- No new TypeScript any. No fabricated market, financial, on-chain or agent events. No profitability claim.
- Retain six glossy pastel characters, accessories, keris identity, warm wooden interior, existing navigation and both themes.
- Use an isolated worktree. Do not update or restart the owner's potentially running original checkout.
- Earlier localhost browser-origin denial remains effective. Request explicit renewed browser authorization before browser QA; do not use another browser, CDP, shell, port or protocol as a workaround. Independent code/test work can continue while that permission remains unavailable.
- If delegated work is explicitly selected, every subagent must use gpt-5.6-luna at max reasoning, including reviewers. Native execution is the default recommendation. No delegation is required to write these plans.
- Future release, deployment, version bump and push require scope authorization for that future session. This session's release authority is already fulfilled.

## Independent plans and order
Read this specification with the chosen plan. The four plans can be reviewed and implemented independently; complete one before starting another.

1. ../plans/2026-10-19-office-acceptance-and-interactions.md
2. ../plans/2026-10-19-missed-opportunity-review.md
3. ../plans/2026-10-19-financial-evidence.md
4. ../plans/2026-10-19-bundle-and-ci.md

Recommended first: bundle/CI for a repeatable gate, then office, missed opportunities and financial evidence. The financial work carries the largest correctness surface and must not delay existing execution.

## Acceptance evidence
Each completed plan records actual commands, results and changed files. Visual captures are evidence only after authorized access. Missing venue capability remains explicitly unsupported. A successful source release or green CI is not evidence that the owner's running process has upgraded.
