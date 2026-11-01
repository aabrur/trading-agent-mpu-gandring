# Mpu Gandring V2 Latest GitHub Comprehensive Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair Rebirth V2 Office discussions, private chat sessions, authenticated CLI and provider model selection, native LIVE execution truth, and safe legacy cleanup at the verified current GitHub commit.

**Architecture:** Preserve the single Rebirth V2 runtime and native exchange writer. Repair source-to-state-to-UI contract seams with explicit persistence, provider capability adapters, venue reconciliation and evidence-based removals. Use the included initial local patch as an *unmerged candidate*, not an already-passing production commit.

**Tech Stack:** Node.js >=20 (CI Node 24), TypeScript, Express, React, SQLite, Zod, Vitest, Vite, native venue adapters, optional CCXT read-only, Playwright/browser where available.

**Spec:** `../specs/2026-11-01-mpu-v2-office-model-cli-live-repair.md`

## Global Constraints

- Base from `main` SHA `49ba0c15235caecb1d7931e767aa7f6872e2838f`; recheck branch head at execution time and rebase/resolve if drifted. Never silently apply an old patch onto a different HEAD.
- Owner solely controls capital, leverage, risk thresholds, confidence policy, N, symbols, provider/model selection. No new hidden strategy gate, confidence veto, cooldown, per-symbol throttling or CLOSE restriction.
- Keep `guard.ts`, protected venue resting stops, withdraw OFF for delegated agents, kill switch, single writer; do not replace native execution with CCXT or second engine.
- Do not read, print, copy or commit owner exchange keys, wallet secrets, `data/*.sqlite`, trading evidence or local `.env`; use test fixtures and synthetic credentials.
- No fabricated model IDs, connections, fills, agent speech, whale classifications, price data or claims of verified LIVE proof.
- Avoid introducing TypeScript `any`; if touched legacy uses it, narrow the typed boundary where practical.
- Work in isolated branch/worktree. Deletion of source files requires import-graph proof plus restoration path; account data must never be deleted as cleanup.
- External Git pushes, merges, releases, deployments, LIVE trades and on-chain transactions require separate explicit authorization for those actions.

## Review Focus

- A successful venue order ACK does not prove a fill; duplicate/replayed receipts cannot double-book a trade.
- `New` then `Delete` followed by restart/reconnect cannot recover deleted chat, orphan selected ID, or remove financial journal; tests T2 and T3.
- CLI `PATH` detection without authentication is `installed_unverified`, never `connected`; tests T5.
- Model list may return fewer than 25, 404, empty, stale, or deprecated IDs; UI keeps working and existing manual selection stays intact; tests T6.
- Old launcher or registry paths may still be imported indirectly; no cleanup removal before manifest and tests; T11.

---
### Task T0: Exact GitHub HEAD, dependency baseline, old vs new snapshot, reproducible environment

**Files:** `package.json`, `.github/workflows/ci.yml`, `AGENTS.md`, `docs/rebirth/*`, `docs/roadmap/*`, `scripts/mpu-gate.mjs`, `tsconfig.*`

**Interfaces and acceptance:** Create `docs/qa/2026-11-01-source-baseline.md` with sha, changed-file list, Node/npm versions and mode-neutral test commands; diff supplied snapshot against HEAD and record mismatches. Run `git status --short`, `git rev-parse HEAD`, `git fetch origin`, `git merge-base`, `npm ci --ignore-scripts --no-audit --no-fund`, `npm run typecheck`, `npm test`, `npm run build`, `npm run build:rebirth` and `npm run stage-gate` (inspect actual options). Real output, no predicted counts.

- [ ] **Step 1, RED:** Write focused tests reproducing the specific input/output contract, failure mode and no-regression assertion before modifying production code. Maintain exact setup and teardown; no fixture traffic to production.
- [ ] **Step 2, prove RED:** Run `npx vitest run tests/rebirth/system.test.ts` (or newly named test file); record failing test names and cause. If an existing regression is already green, keep it and add the missing failing behavior instead.
- [ ] **Step 3, minimal fix:** Implement only this task's declared interfaces, preserving existing owner choices and guard boundaries. Write explicit failure messages and non-secret observability records.
- [ ] **Step 4, GREEN:** Re-run focused test, `npm run typecheck`, `npm test` and `npm run build`; inspect complete output, not only shell exit; if a stage remains unavailable mark UNVERIFIED. Review patch against the preceding commit and run `git diff --check`.
- [ ] **Step 5, review and commit:** Record exact new/modified/deleted files and test result in QA ledger, take independent review, then commit focused files with message `fix(v2): t0 exact github head, dependency baseline, old`. Verify there is no owner credential or LIVE mode mutation.

### Task T1: Repair model-backed operational office chat routing and role resolution

**Files:** `server/v2/api/operations.ts`, `server/v2/runtime.ts`, `server/v2/agents/runner.ts`, `server/v2/agents/providers.ts`, `server/v2/contracts.ts`, `tests/rebirth/chat-repair.test.ts`, new `tests/rebirth/chat-routing.test.ts`

**Interfaces and acceptance:** Trace command `conversationId` and `clientRequestId`; add failing tests for single role, all six, explicit errors, timeout, restart and no trading side effects. Replace direct private member calls/`as any` with a typed `RoleRunner.chat({role, user, conversationId, requestId, configVersion})` or separate typed `ChatProviderCaller`; use active SettingsService resolver. `@all` fans out to exactly six roles, stores one owner request and only authentic individual replies. Verify `npx vitest run tests/rebirth/chat-routing.test.ts tests/rebirth/chat-repair.test.ts`, then full suite.

- [ ] **Step 1, RED:** Write focused tests reproducing the specific input/output contract, failure mode and no-regression assertion before modifying production code. Maintain exact setup and teardown; no fixture traffic to production.
- [ ] **Step 2, prove RED:** Run `npx vitest run tests/rebirth/chat-repair.test.ts` (or newly named test file); record failing test names and cause. If an existing regression is already green, keep it and add the missing failing behavior instead.
- [ ] **Step 3, minimal fix:** Implement only this task's declared interfaces, preserving existing owner choices and guard boundaries. Write explicit failure messages and non-secret observability records.
- [ ] **Step 4, GREEN:** Re-run focused test, `npm run typecheck`, `npm test` and `npm run build`; inspect complete output, not only shell exit; if a stage remains unavailable mark UNVERIFIED. Review patch against the preceding commit and run `git diff --check`.
- [ ] **Step 5, review and commit:** Record exact new/modified/deleted files and test result in QA ledger, take independent review, then commit focused files with message `fix(v2): t1 repair model-backed operational office chat`. Verify there is no owner credential or LIVE mode mutation.

### Task T2: New/Delete chat and websocket state parity

**Files:** `server/v2/api/chat.ts`, `server/v2/api/operations.ts`, `web/src/useDesk.ts`, `web/src/App.tsx`, `web/src/components/Office.tsx`, `web/src/components/OfficeDiscussion.tsx`, `web/src/components/AgentPanel.tsx`, `web/src/discussion.ts`, `tests/rebirth/chat-repair.test.ts`

**Interfaces and acceptance:** Use included candidate patch only after comparing HEAD. Assert POST returns both `conversationId` and object; generate collision-safe ids, default `office`, local-owner 403 guard and required DELETE confirmation, state broadcast and selected conversation fallback. Test 2 simultaneous POSTs, deleting default, authorization, stale session, rapid New->Delete, focus and keyboard. Add HTTP integration test and browser regression. Run focused Vitest, browser matrix and typecheck.

- [ ] **Step 1, RED:** Write focused tests reproducing the specific input/output contract, failure mode and no-regression assertion before modifying production code. Maintain exact setup and teardown; no fixture traffic to production.
- [ ] **Step 2, prove RED:** Run `npx vitest run tests/rebirth/chat-repair.test.ts` (or newly named test file); record failing test names and cause. If an existing regression is already green, keep it and add the missing failing behavior instead.
- [ ] **Step 3, minimal fix:** Implement only this task's declared interfaces, preserving existing owner choices and guard boundaries. Write explicit failure messages and non-secret observability records.
- [ ] **Step 4, GREEN:** Re-run focused test, `npm run typecheck`, `npm test` and `npm run build`; inspect complete output, not only shell exit; if a stage remains unavailable mark UNVERIFIED. Review patch against the preceding commit and run `git diff --check`.
- [ ] **Step 5, review and commit:** Record exact new/modified/deleted files and test result in QA ledger, take independent review, then commit focused files with message `fix(v2): t2 new/delete chat and websocket state parity`. Verify there is no owner credential or LIVE mode mutation.

### Task T3: Durable scoped conversation/message persistence and replay integrity

**Files:** `server/v2/store/database.ts`, `server/v2/store/schema.ts`, `server/v2/store/events.ts`, `server/v2/api/chat.ts`, `server/v2/runtime.ts`, `web/src/useDesk.ts`, new `tests/rebirth/chat-persistence.test.ts`

**Interfaces and acceptance:** Define tables `conversations(id, ownerScope, title, createdAt, updatedAt, deletedAt)` and `chat_messages(messageId, conversationId, clientRequestId, role, text, createdAt, status)` with suitable unique keys and migration. Verify DB event migrations and existing owner scopes. Implement create/delete/post transactional idempotency and retention policy for chat only. On crash/reconnect reconstruct exact latest messages; dedupe by messageId and command id, never delete immutable trade journals. Test fresh reload, double request, failed DB transaction, deleted session, pagination and two owners.

- [ ] **Step 1, RED:** Write focused tests reproducing the specific input/output contract, failure mode and no-regression assertion before modifying production code. Maintain exact setup and teardown; no fixture traffic to production.
- [ ] **Step 2, prove RED:** Run `npx vitest run tests/rebirth/chat-repair.test.ts` (or newly named test file); record failing test names and cause. If an existing regression is already green, keep it and add the missing failing behavior instead.
- [ ] **Step 3, minimal fix:** Implement only this task's declared interfaces, preserving existing owner choices and guard boundaries. Write explicit failure messages and non-secret observability records.
- [ ] **Step 4, GREEN:** Re-run focused test, `npm run typecheck`, `npm test` and `npm run build`; inspect complete output, not only shell exit; if a stage remains unavailable mark UNVERIFIED. Review patch against the preceding commit and run `git diff --check`.
- [ ] **Step 5, review and commit:** Record exact new/modified/deleted files and test result in QA ledger, take independent review, then commit focused files with message `fix(v2): t3 durable scoped conversation/message persist`. Verify there is no owner credential or LIVE mode mutation.

### Task T4: Office Discussion visual errors, debate visibility and responsive UX

**Files:** `web/src/components/OfficeDiscussion.tsx`, `web/src/components/Office.tsx`, `web/src/discussion.ts`, `web/src/useDesk.ts`, `web/src/styles/app.css`, `tests/rebirth/office-browser.test.ts`, `tests/discussion.test.ts`

**Interfaces and acceptance:** Reproduce reported error with browser console/HTTP/network websocket trace and actual stack. Assert owner messages visible immediately in selected room, authentic six replies, partial failures, scroll behavior, theme/responsive 375/390/768/1366/1440 widths, speech and agent panels. Do not treat missing Chromium as passed coverage; mark skipped separately. Fix only reproduced issue, run focused tests/build and record before/after screenshots/console.

- [ ] **Step 1, RED:** Write focused tests reproducing the specific input/output contract, failure mode and no-regression assertion before modifying production code. Maintain exact setup and teardown; no fixture traffic to production.
- [ ] **Step 2, prove RED:** Run `npx vitest run tests/rebirth/office-browser.test.ts` (or newly named test file); record failing test names and cause. If an existing regression is already green, keep it and add the missing failing behavior instead.
- [ ] **Step 3, minimal fix:** Implement only this task's declared interfaces, preserving existing owner choices and guard boundaries. Write explicit failure messages and non-secret observability records.
- [ ] **Step 4, GREEN:** Re-run focused test, `npm run typecheck`, `npm test` and `npm run build`; inspect complete output, not only shell exit; if a stage remains unavailable mark UNVERIFIED. Review patch against the preceding commit and run `git diff --check`.
- [ ] **Step 5, review and commit:** Record exact new/modified/deleted files and test result in QA ledger, take independent review, then commit focused files with message `fix(v2): t4 office discussion visual errors, debate vis`. Verify there is no owner credential or LIVE mode mutation.

### Task T5: Genuine CLI authentication, model-specific launch and connected state

**Files:** `server/v2/agents/local.ts`, `server/v2/api/local-agents.ts`, `web/src/components/LocalAgentsSetup.tsx`, `tests/rebirth/local-agents.test.ts`, `tests/rebirth/provider-tools.test.ts`

**Interfaces and acceptance:** Build typed `CliCapability` per tool (Codex, Claude Code, Gemini CLI, Pi, Kimi, Kilo, Cline, Grok Build, Antigravity, Hermes, OpenClaw, Copilot, Cursor, Qwen, OpenCode, Muse). Declare `version`, `authProbe`, `modelList`, `modelFlag` and true current account capability; no invented flags. Verify installed PATH separately from auth, explicit selected model via dry non-trade inference with response evidence; unknown/unsupported model returns precise status. Fix refresh UI to consume `discovery` without wiping `agents`; assert server settings save actually persists or fails. Test missing binary, invalid auth, wrong model, timeout, Windows paths, injection isolation. Run `npx vitest run tests/rebirth/local-agents.test.ts` then full suite.

- [ ] **Step 1, RED:** Write focused tests reproducing the specific input/output contract, failure mode and no-regression assertion before modifying production code. Maintain exact setup and teardown; no fixture traffic to production.
- [ ] **Step 2, prove RED:** Run `npx vitest run tests/rebirth/local-agents.test.ts` (or newly named test file); record failing test names and cause. If an existing regression is already green, keep it and add the missing failing behavior instead.
- [ ] **Step 3, minimal fix:** Implement only this task's declared interfaces, preserving existing owner choices and guard boundaries. Write explicit failure messages and non-secret observability records.
- [ ] **Step 4, GREEN:** Re-run focused test, `npm run typecheck`, `npm test` and `npm run build`; inspect complete output, not only shell exit; if a stage remains unavailable mark UNVERIFIED. Review patch against the preceding commit and run `git diff --check`.
- [ ] **Step 5, review and commit:** Record exact new/modified/deleted files and test result in QA ledger, take independent review, then commit focused files with message `fix(v2): t5 genuine cli authentication, model-specific `. Verify there is no owner credential or LIVE mode mutation.

### Task T6: 25 verified model options per API provider and custom models

**Files:** `server/v2/api/setup.ts`, `server/v2/settings/schema.ts`, `server/v2/settings/service.ts`, `server/v2/settings/secrets.ts`, `web/src/components/ModelsSetup.tsx`, `web/src/components/LocalAgentsSetup.tsx`, new `server/v2/settings/model-catalog.ts`, new `tests/rebirth/model-catalog.test.ts`

**Interfaces and acceptance:** Build official authenticated catalog adapters for ten provider IDs `xai,openai,anthropic,gemini,deepseek,openrouter,groq,mistral,together,fireworks`; document their official model-list APIs and error/access semantics. Model object includes exact ID, source, checkedAt, available, usable, retired, reasoning and context when verified. Display/search at least 25 actual IDs when available; fewer means truthful count, manual custom ID supported, do not invent placeholders or drop saved selection. Avoid changing trading provider/model assignments through UI-only catalog refresh. Add ETag/cache with visible provenance, not a trading gate. Test count 0/4/24/25/200, 401, rate limit, retired, invalid, empty, offline, mixed auth, manual model; build and full suite.

- [ ] **Step 1, RED:** Write focused tests reproducing the specific input/output contract, failure mode and no-regression assertion before modifying production code. Maintain exact setup and teardown; no fixture traffic to production.
- [ ] **Step 2, prove RED:** Run `npx vitest run tests/rebirth/model-catalog.test.ts` (or newly named test file); record failing test names and cause. If an existing regression is already green, keep it and add the missing failing behavior instead.
- [ ] **Step 3, minimal fix:** Implement only this task's declared interfaces, preserving existing owner choices and guard boundaries. Write explicit failure messages and non-secret observability records.
- [ ] **Step 4, GREEN:** Re-run focused test, `npm run typecheck`, `npm test` and `npm run build`; inspect complete output, not only shell exit; if a stage remains unavailable mark UNVERIFIED. Review patch against the preceding commit and run `git diff --check`.
- [ ] **Step 5, review and commit:** Record exact new/modified/deleted files and test result in QA ledger, take independent review, then commit focused files with message `fix(v2): t6 25 verified model options per api provider `. Verify there is no owner credential or LIVE mode mutation.

### Task T7: Six-role live settings and model activation parity

**Files:** `server/v2/runtime.ts`, `server/v2/agents/runner.ts`, `server/v2/settings/service.ts`, `server/v2/api/setup.ts`, `server/v2/api/local-agents.ts`, `tests/rebirth/roles.test.ts`, `tests/rebirth/settings.test.ts`

**Interfaces and acceptance:** Remove split-brain `AGENT_*` env-only static resolver from active roles while preserving migration fallback where documented. Six roles get verified `provider/model/reasoning` and `activeVersion` from SettingsService on every new cycle. Settings changes applied atomically and acknowledged; current inflight cycle remains on captured config snapshot; new cycle gets new version. CLI `assignAll` works only explicit, partial assignment keeps five untouched. Assert no role unexpectedly falls back to mock or stale model; test start/restart/update/unknown provider.

- [ ] **Step 1, RED:** Write focused tests reproducing the specific input/output contract, failure mode and no-regression assertion before modifying production code. Maintain exact setup and teardown; no fixture traffic to production.
- [ ] **Step 2, prove RED:** Run `npx vitest run tests/rebirth/settings.test.ts` (or newly named test file); record failing test names and cause. If an existing regression is already green, keep it and add the missing failing behavior instead.
- [ ] **Step 3, minimal fix:** Implement only this task's declared interfaces, preserving existing owner choices and guard boundaries. Write explicit failure messages and non-secret observability records.
- [ ] **Step 4, GREEN:** Re-run focused test, `npm run typecheck`, `npm test` and `npm run build`; inspect complete output, not only shell exit; if a stage remains unavailable mark UNVERIFIED. Review patch against the preceding commit and run `git diff --check`.
- [ ] **Step 5, review and commit:** Record exact new/modified/deleted files and test result in QA ledger, take independent review, then commit focused files with message `fix(v2): t7 six-role live settings and model activation`. Verify there is no owner credential or LIVE mode mutation.

### Task T8: Native LIVE execution receipts, CLOSE truth, durable reconciliation

**Files:** `server/v2/runtime.ts`, `server/v2/execution/gateway.ts`, `server/v2/execution/reconcile.ts`, `server/v2/execution/protection.ts`, `server/v2/execution/adapters/*`, `tests/rebirth/gateway.test.ts`, `tests/rebirth/exits.test.ts`, `tests/rebirth/protection.test.ts`

**Interfaces and acceptance:** Reproduce ACK-as-fill and unconditional CLOSE. Build explicit submission/unknown/partial/filled/rejected/cancelled state; update verdict/order and equity only after venue evidence reconciles. Apply client-order ID idempotency and persist outstanding receipts before restart, verify protective stop on exchange. CLOSE available per strategy, but show PENDING/UNKNOWN until verified. Test accepted nonfill, partial, late full, cancel, timeout, retry, hedge, restart, remote drift, missing stop. Run focused plus full suite. Do not place real orders from CI.

- [ ] **Step 1, RED:** Write focused tests reproducing the specific input/output contract, failure mode and no-regression assertion before modifying production code. Maintain exact setup and teardown; no fixture traffic to production.
- [ ] **Step 2, prove RED:** Run `npx vitest run tests/rebirth/gateway.test.ts` (or newly named test file); record failing test names and cause. If an existing regression is already green, keep it and add the missing failing behavior instead.
- [ ] **Step 3, minimal fix:** Implement only this task's declared interfaces, preserving existing owner choices and guard boundaries. Write explicit failure messages and non-secret observability records.
- [ ] **Step 4, GREEN:** Re-run focused test, `npm run typecheck`, `npm test` and `npm run build`; inspect complete output, not only shell exit; if a stage remains unavailable mark UNVERIFIED. Review patch against the preceding commit and run `git diff --check`.
- [ ] **Step 5, review and commit:** Record exact new/modified/deleted files and test result in QA ledger, take independent review, then commit focused files with message `fix(v2): t8 native live execution receipts, close truth`. Verify there is no owner credential or LIVE mode mutation.

### Task T9: Wallet delegated agents and eight exchange account truth

**Files:** `server/v2/api/wallet.ts`, `server/v2/wallet.ts`, `server/v2/accounts/registry.ts`, `server/v2/accounts/authority.ts`, `server/v2/execution/adapters/{aster,binance,bybit,dydx,hyperliquid,okx,orderly,paradex}.ts`, relevant `tests/rebirth/venue-*.test.ts`

**Interfaces and acceptance:** Wire `persistDelegatedSecret` and `verifyDelegatedAgent` in real mount; distinguish wallet browser address from verified venue balance/account trade ability. Check eight credential + network + balances + fees + positions + stop paths using official schemas; do not silently apply testnet URL to mainnet. Exactly-once webhook/app close and correct venue `withdraw OFF`. For unverified account show UNAVAILABLE not zero. Run adapter conformance & wallet tests with mocked HTTP, then staged owner-host read-only credential probes with sanitized evidence and separately authorized testnet roundtrips.

- [ ] **Step 1, RED:** Write focused tests reproducing the specific input/output contract, failure mode and no-regression assertion before modifying production code. Maintain exact setup and teardown; no fixture traffic to production.
- [ ] **Step 2, prove RED:** Run `npx vitest run tests/rebirth/gateway.test.ts` (or newly named test file); record failing test names and cause. If an existing regression is already green, keep it and add the missing failing behavior instead.
- [ ] **Step 3, minimal fix:** Implement only this task's declared interfaces, preserving existing owner choices and guard boundaries. Write explicit failure messages and non-secret observability records.
- [ ] **Step 4, GREEN:** Re-run focused test, `npm run typecheck`, `npm test` and `npm run build`; inspect complete output, not only shell exit; if a stage remains unavailable mark UNVERIFIED. Review patch against the preceding commit and run `git diff --check`.
- [ ] **Step 5, review and commit:** Record exact new/modified/deleted files and test result in QA ledger, take independent review, then commit focused files with message `fix(v2): t9 wallet delegated agents and eight exchange `. Verify there is no owner credential or LIVE mode mutation.

### Task T10: ResearchHost, Whale Alert, CCXT, TradingView authenticated durable ingress

**Files:** `server/v2/runtime.ts`, `server/v2/research/host.ts`, `server/v2/market/{ccxt,whale}.ts`, `server/v2/app.ts`, `server/v2/store/events.ts`, `tests/rebirth/{ccxt,tradingview,whale-intelligence,research}.test.ts`

**Interfaces and acceptance:** Initialize ResearchHost before RoleRunner and wire toolHost to six roles, with unavailable clear not veto. Integrate CCXT read-only REST optionally; do not claim Pro WS without paid capability. Replace obsolete whale v1 polling with provider-supported live subscriptions while distinguishing transfers from market fills. TradingView verify passphrase, event ID dedupe only exact retry, persist then 200 ACK under 3s, queue distinct same-symbol events rather than one/min throttle. Test parallel/replayed/late signals, invalid auth, restart and API outage; preserve same strategy contract.

- [ ] **Step 1, RED:** Write focused tests reproducing the specific input/output contract, failure mode and no-regression assertion before modifying production code. Maintain exact setup and teardown; no fixture traffic to production.
- [ ] **Step 2, prove RED:** Run `npx vitest run tests/rebirth/tradingview.test.ts` (or newly named test file); record failing test names and cause. If an existing regression is already green, keep it and add the missing failing behavior instead.
- [ ] **Step 3, minimal fix:** Implement only this task's declared interfaces, preserving existing owner choices and guard boundaries. Write explicit failure messages and non-secret observability records.
- [ ] **Step 4, GREEN:** Re-run focused test, `npm run typecheck`, `npm test` and `npm run build`; inspect complete output, not only shell exit; if a stage remains unavailable mark UNVERIFIED. Review patch against the preceding commit and run `git diff --check`.
- [ ] **Step 5, review and commit:** Record exact new/modified/deleted files and test result in QA ledger, take independent review, then commit focused files with message `fix(v2): t10 researchhost, whale alert, ccxt, tradingvie`. Verify there is no owner credential or LIVE mode mutation.

### Task T11: Legacy engine, stale data, abandoned UI, documents and assets cleanup

**Files:** `bin/mpu.mjs`, `server/index.ts`, `server/app.ts`, `server/runtime.ts`, `server/desk.ts`, `server/v2/*`, `cli/*`, `web/src/*`, `docs/*`, `.gitignore`, `package.json`, new `docs/qa/2026-11-01-cleanup-manifest.md`

**Interfaces and acceptance:** Generate actual import/entrypoint and storage migration graph; classify every candidate KEEP/CONSOLIDATE/ARCHIVE/REMOVE after evidence. Verify legacy `server/live/guard.ts` and `resting-stop.ts` may be called by compat before any deletion. Remove only proven unused source/test fixtures, fake stale docs, unreferenced copied assets and deprecated launch commands. Keep historical financial evidence and migration scripts. For each removal run affected test, full typecheck/build/test, binary asset manifest compare and smoke startup; record rollback git commit. Never bulk `rm -rf server` or `data`.

- [ ] **Step 1, RED:** Write focused tests reproducing the specific input/output contract, failure mode and no-regression assertion before modifying production code. Maintain exact setup and teardown; no fixture traffic to production.
- [ ] **Step 2, prove RED:** Run `npx vitest run tests/rebirth/system.test.ts` (or newly named test file); record failing test names and cause. If an existing regression is already green, keep it and add the missing failing behavior instead.
- [ ] **Step 3, minimal fix:** Implement only this task's declared interfaces, preserving existing owner choices and guard boundaries. Write explicit failure messages and non-secret observability records.
- [ ] **Step 4, GREEN:** Re-run focused test, `npm run typecheck`, `npm test` and `npm run build`; inspect complete output, not only shell exit; if a stage remains unavailable mark UNVERIFIED. Review patch against the preceding commit and run `git diff --check`.
- [ ] **Step 5, review and commit:** Record exact new/modified/deleted files and test result in QA ledger, take independent review, then commit focused files with message `fix(v2): t11 legacy engine, stale data, abandoned ui, do`. Verify there is no owner credential or LIVE mode mutation.

### Task T12: Owner strategies: remove undocumented throttles/clamps, preserve system guards

**Files:** `server/v2/settings/schema.ts`, `server/v2/api/setup.ts`, `server/v2/app.ts`, `server/v2/decision/*`, `server/v2/execution/*`, `server/live/guard.ts`, `tests/rebirth/system.test.ts`, `tests/rebirth/tradingview.test.ts`

**Interfaces and acceptance:** Audit every clamp/limit against Owner-specified active schema; particularly `maxPositions: max4`, `dailyLossLimitPct: 0.5..25`, webhook 1/60s; do not change Owner-selected values. Adjust contract ranges only to explicit Owner policy, tests for values just outside old artificial limits, OPEN/CLOSE without hidden veto, and guard retained. Exclude duplicate retries by immutable event ID not arbitrary symbol/time throttle. Run regression gate and change log.

- [ ] **Step 1, RED:** Write focused tests reproducing the specific input/output contract, failure mode and no-regression assertion before modifying production code. Maintain exact setup and teardown; no fixture traffic to production.
- [ ] **Step 2, prove RED:** Run `npx vitest run tests/rebirth/settings.test.ts` (or newly named test file); record failing test names and cause. If an existing regression is already green, keep it and add the missing failing behavior instead.
- [ ] **Step 3, minimal fix:** Implement only this task's declared interfaces, preserving existing owner choices and guard boundaries. Write explicit failure messages and non-secret observability records.
- [ ] **Step 4, GREEN:** Re-run focused test, `npm run typecheck`, `npm test` and `npm run build`; inspect complete output, not only shell exit; if a stage remains unavailable mark UNVERIFIED. Review patch against the preceding commit and run `git diff --check`.
- [ ] **Step 5, review and commit:** Record exact new/modified/deleted files and test result in QA ledger, take independent review, then commit focused files with message `fix(v2): t12 owner strategies: remove undocumented throt`. Verify there is no owner credential or LIVE mode mutation.

### Task T13: Exact-SHA end-to-end acceptance, handoff, and implementation evidence

**Files:** `docs/qa/2026-11-01-acceptance.md`, `.github/workflows/ci.yml`, `docs/rebirth/verification-manifest.json`, `scripts/mpu-gate.mjs`, `tests/rebirth/office-browser.test.ts`

**Interfaces and acceptance:** After T0-T12, run `npm run typecheck`, `npm test`, `npm run build`, `npm run build:rebirth`, validated stage gate command, lint/diff checks and exact GitHub Actions run matched to commit sha. Browser Office Discussion and Models on desktop/mobile theme matrix. CLI executable/Auth/model inference live probes only on owner-authorized host. Venue read-only probes first, authorized testnet fill/stop/close proof next, then guarded LIVE cutover under single writer. For every scenario mark PASS/FAIL/UNVERIFIED and link redacted logs. Compare remote branch and deployment process build SHA, no false 100% claims. Publish release only if separately approved.

- [ ] **Step 1, RED:** Write focused tests reproducing the specific input/output contract, failure mode and no-regression assertion before modifying production code. Maintain exact setup and teardown; no fixture traffic to production.
- [ ] **Step 2, prove RED:** Run `npx vitest run tests/rebirth/system.test.ts` (or newly named test file); record failing test names and cause. If an existing regression is already green, keep it and add the missing failing behavior instead.
- [ ] **Step 3, minimal fix:** Implement only this task's declared interfaces, preserving existing owner choices and guard boundaries. Write explicit failure messages and non-secret observability records.
- [ ] **Step 4, GREEN:** Re-run focused test, `npm run typecheck`, `npm test` and `npm run build`; inspect complete output, not only shell exit; if a stage remains unavailable mark UNVERIFIED. Review patch against the preceding commit and run `git diff --check`.
- [ ] **Step 5, review and commit:** Record exact new/modified/deleted files and test result in QA ledger, take independent review, then commit focused files with message `fix(v2): t13 exact-sha end-to-end acceptance, handoff, a`. Verify there is no owner credential or LIVE mode mutation.

## Implementation sequence, dependency and owner handoff

Start **T0 -> T1 -> T2 -> T3 -> T4**, since chat contracts explain the visible UI failures. Then **T5 -> T6 -> T7** for CLI/auth/model selection, **T8 -> T9 -> T10 -> T12** for the operating engine, **T11** after dependency evidence, **T13** final. Tasks may be run by separate agents only when they do not write overlapping files. Do not merge multiple concurrent patches to `server/v2/runtime.ts` without serial review.

The included early patch targets T1/T2/T5/T6 *partially*. It is not the complete implementation of those tasks. In particular, chat DB persistence, typed chat caller replacing private member access, official model discovery, 25 available models, effective per-CLI settings write, all CLI model flags, verified live receipts, wallet persistence and safe deletion manifest remain to be done.

**Execution commands:** `git fetch origin && git status --short && git rev-parse HEAD`; if the baseline differs, rebase patch, review `git diff`, and rerun tests. `git apply --check mpu_v2_surgical_repairs.patch` against precisely matching snapshot; apply in a clean isolated worktree only. Node smoke `node --test tests/repair-contracts.node.test.mjs` after copying tests. No GitHub push, force reset, kill/restart or owner-account action is part of this documentation package.
