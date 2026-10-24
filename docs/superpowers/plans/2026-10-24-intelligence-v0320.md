# Trading Agent Mpu Gandring Intelligence Implementation Plan

> For agentic workers: use superpowers:executing-plans for integration and subagent-driven-development for bounded collector tasks. Track checks below.

**Goal:** Deliver version 0.3.20 / appVersion 0.0.0.3.20 with real collaboration and traceable market intelligence.
**Architecture:** Extend the existing Desk, research catalog and market collectors. Intelligence remains advisory; the owner command authorization and shared execution path remain unchanged.
**Tech Stack:** TypeScript, React, Zod, Vitest, existing HTTP collectors.
**Spec:** Owner attachment `C:/Users/abrur/.codex/attachments/f72d7bcd-f070-4b28-b85e-595af9fc3e6b/Pasted text.txt`.

## Global Constraints

- Preserve profiles, N, allocation, sizing, SL/TP, leverage, safety net, mode, Auto, wallet and execution permissions.
- No development orders, LIVE restart, deployment, fabricated observations, or secrets in prompts/logs/tests.
- Work on the owner-authorized main checkout; normal push to origin/main only after validation.
- Independent public-feed development uses fixtures; premium connections may remain explicitly unverified.

## Review Focus

- Quoted/tool/news mentions cannot delegate or mutate configuration.
- Concurrent conversations cannot leak symbols or overwrite each other's context.
- Partial trade history and shallow books must not imply full coverage.
- Native Aster failure cannot relabel Bybit data as native.
- Configured providers without successful observations cannot appear connected.

## Task 1: Collaboration and conversation context

Files: server/schemas.ts, server/desk.ts, server/commands.ts, server/providers/local.ts, tests/discussion.test.ts, tests/collaboration.test.ts.
Interfaces: backward-compatible askTeammate plus askTeammates; bounded fan-out results with agent, status, latency and errors; conversationId optional on command.

- [ ] Add failing tests for parallel teammate calls, deduplication, failure, synthesis, untrusted mentions, sticky and multi-symbol context.
- [ ] Extend schema and actual Desk orchestration; retain direct owner-command authorization.
- [ ] Verify targeted tests; record actual invocations, room history and latency.

## Task 2: Public market microstructure and native Aster

Files: server/market/index.ts, server/market/observations.ts, new server/market/microstructure.ts, server/market/positioning.ts, additive server/types.ts, tests/microstructure.test.ts, tests/positioning.test.ts.
Interfaces: additive OrderflowSummary rolling windows, OrderbookSummary depth bands and provenance, DerivativesSummary.positioning. Preserve existing required fields.

- [ ] Read official endpoint contracts and write failing fixtures for chronological ordering, duplicates, gaps, maker classification and incomplete depth.
- [ ] Implement bounded per-venue/symbol flow history; native Aster public depth/trades; explicitly labeled fallback; positioning separate from whale data.
- [ ] Verify targeted collector tests, failures, and unchanged exchange execution source.

## Task 3: News and optional on-chain evidence

Files: server/market/live-news.ts, server/market/news.ts, server/market/whale.ts, new server/market/sui.ts, related tests and provider documentation.
Interfaces: additive normalized provenance/status metadata; no fabricated events or changes to existing whale contract expectations.

- [ ] Verify official Bybit, Whale Alert, Hyperliquid and Sui contracts.
- [ ] Write failing tests for valid zero events versus unconfigured/error, publication timestamps, deduplication and optional Sui absence.
- [ ] Implement supported optional Sui GraphQL, configurable Hyperliquid watchlist and truthful coverage/status.
- [ ] Verify fixture tests; distinguish fixture proof from live connectivity.

## Task 4: Capabilities, capital state and tactical intelligence

Files: server/research/catalog.ts, server/research/routes.ts, server/desk.ts, server/market/tactical.ts, server/types.ts, web/src/types.ts, existing Desk Ops component, related tests.
Interfaces: sanitized capability manifest, additive accountState summary, TacticalTradePlan derived from existing TechnicalSummary.

- [ ] Add failing tests for configured versus connected, capital versus slots, both directional scenarios and missing evidence.
- [ ] Wire bounded capability and tactical summaries to relevant agents/Jev; retain strategyVote and all execution settings.
- [ ] Add compact existing UI status; verify accessibility and long-content behavior.

## Task 5: Verification and release

Files: package.json, package-lock.json, server/updater.ts, CHANGELOG.md, release report.

- [ ] Review changed frontend/backend against requested skills and resolve actionable issues.
- [ ] Run focused regressions, full suite, repository typecheck and production build.
- [ ] Record baseline/final tests, fixture latency, live public probes and remaining limitations.
- [ ] Update version metadata consistently and inspect full diff, protected-file changes and staged secret scan.
- [ ] Verify aabrur identity, fetch/reconcile, commit relevant files and push normally to origin/main.
- [ ] Report SHA/push, changed files and running old-runtime boundary. Do not restart LIVE.

## Execution record

- Baseline: clean main, HEAD 72f3cde6506c8197c2e931b0d2cfc06b12e5bf73, version 0.3.19 / appVersion 0.0.0.3.19.
- LIVE health: Aster, kill off, Auto on 30m. Baseline suite started in PAPER fixtures.
- Ruling: execute supplied directive without a separate plan approval, because it explicitly requires implementation through release. Preserve LIVE process throughout.
