# MPU GANDRING - TARGETED REMEDIATION COMPLETE

Trading Agent Mpu Gandring. Scope: source remediation and isolated regression validation.

Baseline SHA: `d658ad41521cf76499e4bfc87232da4bc8f6111e`.
Final commit SHA: supplied in the delivery response; resolve the commit containing this report with `git log -1 --format=%H -- docs/targeted-remediation-2026-10-30.md`.
Branch: `main`.

Certainty: **certain** for the source findings and executed test results below, based on deterministic regressions and project typechecking. **Needs verification** for activation of the remediated source on the running LIVE host.

| Scope | Root cause | Files changed | Focused test | Result | Completion |
| --- | --- | --- | --- | --- | --- |
| A | Length-only text validation accepted sentence loops; speech waited per three words | agents/speech.ts, agents/run.ts, desk.ts, Execution persona, debate-pacing.test.ts | debate-pacing: 9 distinct tests | 9 passed; final tokenizer preservation correction rechecked only its 2 affected cases | Complete |
| B | Unresolved CLOSE records counted as new exposure; pending entries counted as records | desk.ts, gtc-desk.test.ts | gtc-desk | 5 passed | Complete |
| C | Tactical recommendations treated as binding in evidence and non-AI revalidation | debate-evidence.ts, stale.ts, desk.ts, debate-evidence and contract tests | evidence/contract: 47; explicit LIMIT GTC: 2 | 49 passed | Complete |
| D | MARKET omitted quantity readback and dropped protection status; Aster trusted unrelated rows | exchange types/Aster/Bybit, executor/journal, desk/types, fake adapter, protection tests | protection/recovery: 43; affected GTC: 6 | 49 passed | Complete |
| E | Threshold not uniform in role context; raw flow lacked interpretation scope; HOLD log omitted two roles; unsolicited proposal failed ordinary chat | desk.ts, roles.ts, debate-evidence.ts, critical-path/chat/Owner/evidence tests | chat/Owner/critical path: 31; flow: 1; runtime: 2 | 34 passed | Complete |

## SCOPE A - Execution Trader repetition

Root cause: `ChatSchema` accepts 64,000 characters and checks length/shape, not sentence loops. `say()` awaited each three-word frame, multiplying delay. Decision-question schemas do not own this chat-task output.

Fix: normalize consecutive identical sentence/line runs in the shared agent response path, leaving structured actions and schemas intact. Retain redacted original-response evidence in existing bounded completion diagnostics. Speech has at most 24 partial frames plus its final event. Normalized model data feeds speech, history, reports and Lead synthesis. The HYPE fixture includes 1,200 repeated sentences followed by useful account status. Long distinct decimal-rich prose and leading blank lines remain intact. Execution persona requests each observed fact once.

Focused test: `npx vitest run tests/debate-pacing.test.ts`, followed only by the initially failed fixture assertion and the two cases affected by the final tokenizer correction.

Status: **PASS**, 9 distinct cases. Existing debate order, six roles, providers and execution authority preserved.

## SCOPE B - Slot accounting

Root cause: unresolved CLOSE records without a local position consumed entry capacity. Pending OPENs were counted as records rather than unique exposure. Journal settlement describes fill accounting, not current exposure.

Fix: count confirmed venue symbol/side exposure plus unique nonterminal pending entry exposure. A partial GTC entry and its position occupy one slot. Retain unresolved CLOSE and terminal accounting records without forced settlement. Expose exchange positions, local positions, pending entries, unresolved CLOSEs and unresolved entry accounting in the slot breakdown. Keep the existing stale/unverified-account guard and duplicate-intent checks. N is unchanged.

Focused test: `npx vitest run tests/gtc-desk.test.ts`.

Status: **PASS**, 5 cases, including flat account/unresolved CLOSE, unknown OPEN deduplication and partial GTC exposure.

## SCOPE C - Entry-zone policy

Root cause: tactical recommendations became binding in `validateEntryGeometry()` and non-AI `revalidateEntry()`, contradicting Desk Lead instructions. The existing explicit price authority is an Owner `EntryOrder` with `type: LIMIT_GTC`; no separate Owner binding-zone setting exists.

Fix: report valid out-of-zone prices as neutral structural analysis, without an automatic zone veto. Preserve structural invalidation, freshness, native quotes, venue consistency and exchange rules. Risk and Lead retain OPEN/HOLD discretion. Explicit limit prices still use the existing executor/adapter path and side-aware tick rounding; MARKET defaults are unchanged.

Focused tests: `npx vitest run tests/debate-evidence.test.ts tests/debate-contract-integration.test.ts`; `npx vitest run tests/gtc-entry.test.ts -t 'sends LIMIT GTC|rounds a SHORT limit'`.

Status: **PASS**, 47 evidence/contract cases plus 2 explicit limit-order cases.

## SCOPE D - Exchange protection evidence

Root cause: MARKET readback omitted required quantity and its fill result dropped protection status. Aster trusted returned rows without independently filtering symbol/position side. A numeric requested SL/TP could therefore appear stronger than its readback evidence.

Fix: persist and surface requested protection, exchange acceptance, active status, observation time, symbol, side, required quantity and observed coverage through MARKET fills, journal, positions and diagnostics. Read protection with quantity for MARKET and GTC. Aster filters symbol and hedge side; Bybit reports position-associated coverage. Missing protection retains the existing fail-closed emergency path. Failed reads and unavailable coverage remain unknown, with no stacking on a read failure. Other adapters without coverage evidence are reported unknown rather than confirmed; their placement behavior is unchanged. SL/TP percentages are unchanged.

Focused tests: `npx vitest run tests/protection.test.ts tests/execution-recovery.test.ts`; `npx vitest run tests/gtc-entry.test.ts -t 'protectively closes|persists RESTING|preserves known fills|undersized|verified existing net-position|late fill racing'`.

Status: **PASS**, 43 protection/recovery cases plus 6 affected GTC cases. No real exchange orders were used.

## SCOPE E - Confidence, orderflow, telemetry and chat

Root cause: active confidence was not uniform in all role contexts; raw flow lacked explicit interpretation scope; HOLD participant logs listed four roles despite six completed tasks; an unsolicited model command marked a completed ordinary answer failed.

Fix: inject the current `cfg.risk.minEntryConfidencePct` into every role's data, context and system instruction. Keep existing saved-versus-active diagnostics. Add sample-scoped orderflow interpretation with original raw numbers, venue, endpoint, timestamp, window, coverage and trade count. Label candle proxies separately and deny broad-market confirmation from venue samples without changing admission predicates. Report each of the six primary role phases once, with completion/fallback status and model duration in the existing verdict diagnostic. Ignore unauthorized model command proposals diagnostically while preserving successful chat; the authorization matcher and command executor are unchanged.

Focused tests:

- `npx vitest run tests/debate-critical-path.test.ts tests/chat-operational-reliability.test.ts tests/owner-commands.test.ts`: **31 passed**.
- `npx vitest run tests/debate-evidence.test.ts -t 'qualifies a six-trade'`: **1 passed**. Six trades retain the 768:1 ratio and partial coverage without becoming broad confirmation or a veto.
- `npx vitest run tests/runtime-evidence.test.ts -t 'compares saved and active thresholds'`: **1 passed**.
- `npx vitest run tests/runtime-evidence.test.ts -t 'existing Setup hot-apply'`: **1 passed**.

Status: **PASS**, 34 distinct cases. Read-only host verification confirmed active minimum **70%**, saved minimum **70%**, profile `manual`, saved-network origin, and `matchesActive: true`. The source default of 60% is not the active setting. No threshold was changed.

## TEST SUMMARY

New/modified regression tests: 13 added cases across existing files; existing zone, confidence/telemetry and ordinary-chat expectations updated. No new test file or dependency.

Focused tests executed: 19 narrowly scoped Vitest invocations, including deterministic red reproductions and corrections. **146 distinct cases passed** in their latest applicable executions. **0 unresolved failures**. Initial red results and one test-property typo were corrected; the final speech preservation change reran only its 2 directly affected cases. This is not a claim that the full repository suite ran.

Previously passing tests intentionally not rerun: all unrelated suites and already-passing cases unless a subsequent change directly affected them. No lint, formatting or general integration campaign.

Typecheck/build: `npm run typecheck` **PASS**, executed once after completed source changes, covering server and web projects. Production build not required for these backend changes; omitted to avoid redundant compilation and touching the running compiled application. No frontend source changed.

## OWNER CONTRACT

Trading settings changed: **NO**.
Hidden gates added: **NO**.
CLOSE restrictions added: **NO**.
Official protections removed: **NO**.
LIVE test orders submitted: **NO**.

No production restart, flatten, journal reset, key change, deployment or strategy-formula change was performed. Tests used isolated PAPER/fake venue adapters and loopback ephemeral HTTP servers.

## FINAL

Completed: Scopes A–E source changes, focused regressions, type compatibility and this report.

Remaining: no in-scope implementation work. Runtime activation remains an Owner operation.

Host-only verification: read-only health snapshots before and after remediation retained instance `69aededb-8cbe-4293-b3a8-74d23055b7a5`, process start `1793290223896`, LIVE/Aster mode and baseline repository SHA. The running process has **not** loaded this remediation. New runtime behavior and current/historical XRP/SOL resting-stop proof are **NOT VERIFIED** by these fixtures or baseline health reads.

Commit: only the remediation paths and this report; exact SHA supplied in the delivery response.

Push status: exact remote SHA/result supplied in the delivery response after normal push to `origin/main`; no force push or production deployment.
