# Jev Decision Sidecar + REA Developer Toolkit

Approved architecture for Trading Agent Mpu Gandring. Jev is an optional decision-intelligence sidecar. REA is an optional developer toolkit. Neither is a seventh trading agent.

## Boundaries

- Six agents keep generative debate, personalities, and communication.
- Deterministic code keeps risk, sizing, stops, kill switch, and exchange execution.
- Jev never places, cancels, or resizes orders. It never loosens a hard guard.
- REA never runs inside a trading cycle and is not a runtime dependency.
- Public GitHub distribution: bring-your-own OpenRouter key. No maintainer secrets.

## P0 Evidence

News distinguishes `publishedAt` (source time, nullable) from `observedAt` (ingest time). Unknown publication time stays unknown. Freshness uses `publishedAt` only.

Keyword matches are REPORTED claims, not VERIFIED events. Auto-VETO requires verified, symbol-relevant, fresh, non-sample evidence.

Whale missing USD amounts stay `null`, not `0`. Provider labels are not automatic high-confidence attribution or confirmed market sales.

## P1 Jev adapter

Provider: OpenRouter only. Endpoint: `POST https://openrouter.ai/api/alpha/decisions`. Model: `typesafe/jev-1.14` (not user-typed). TypeSafe Direct is deferred.

Primitives used: Choice, Noul, Score. Not chat completions.

Key precedence: `JEV_OPENROUTER_API_KEY` if set, else `OPENROUTER_API_KEY`. Keys stay server-side, masked in APIs, registered with the redactor.

Defaults: `JEV_ENABLED=false`, `JEV_PROVIDER=openrouter`, `JEV_MODEL=typesafe/jev-1.14`, `JEV_MODE=shadow`.

## Modes

- OFF / disabled: unchanged desk behavior.
- SHADOW: record decisions, no effect on votes or orders.
- ASSIST: enrich analysis/debate context on PAPER and TESTNET only. LIVE assist requires explicit `JEV_ALLOW_LIVE=yes` and never upgrades from a reload or key save.

## P2 Tasks

Bounded state only. One batched request for pre-analysis (regime, news, whale). One post-verdict conflict review. Jev does not compute EMA/RSI/ATR or invent whale facts.

## P3 UI

Compact Jev section in Setup (Models pane). Compact monitor in Desk Ops. Honest UNAVAILABLE / NOT_CONFIGURED / NOT_YET_EVALUATED states. No dummy metrics.

## P4 REA

Document optional `rea` CLI / MCP registration for Codex or Antigravity. Do not commit personal MCP config. Do not install Hopper/Ghidra/IDA.
