# Trading Agent Mpu Gandring Financial Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking. Owner model restrictions in the specification override any skill model recommendation.

**Goal:** Retrieve and attribute available execution, fee and funding records while preserving unknowns and current execution behavior.

**Architecture:** Add an optional read-only adapter capability and a separate idempotent evidence ledger. Retrieve history outside the order path, retain account/window completeness, and enrich existing reports without treating account-wide income as a proven position exit.

**Tech Stack:** Existing TypeScript adapters, local JSON persistence, redaction helpers and mocked HTTP/Vitest.

**Spec:** ../specs/2026-10-19-upgrade-follow-up.md

## Global Constraints
- All Global constraints in the specification apply verbatim.
- No order, cancellation, transfer, key permission, account setting or guard changes.
- Prioritize Aster and Bybit only. Every other adapter remains compatible and explicitly unsupported unless independently scoped later.
- An average order price is not proof of actual fees, funding, net realized PnL or an entire historical position lifecycle.
- No currency conversion to invent USDT totals; unknown is null and confirmed zero is 0.

## Review Focus
- Overlapping pages, retries and restarts must not count the same income/fill twice; Task 2 pins immutable source ids.
- Unsupported methods, missing pages and API errors must not become zero costs or complete coverage; Tasks 1 and 2 pin coverage.
- Hedge sides, partial fills and a manual exit without a matching order must not be attached to the wrong managed position; Task 2 pins attribution.
- Non-USDT commission, rebates and signed funding must retain currency/sign; Tasks 1 and 3 pin exact accounting.
- History lookup must not delay orders or alter the book balance/daily-loss baseline; Task 3 pins side effects.

---

## File structure
- Create docs/financial-history-capabilities.md: verified official source URLs, fields, scopes, cursor/retention limitations.
- Modify server/exchange/types.ts: optional history interface and normalized discriminated records.
- Modify server/exchange/aster.ts and bybit.ts: read-only implementations only where verified APIs permit.
- Create server/live/financial-evidence.ts: account-scoped dedupe, coverage and position attribution.
- Modify server/live/executor.ts, server/desk.ts, server/index.ts: optional background history observation and evidence ownership.
- Modify server/types.ts, server/reports.ts, web/src/types.ts and web/src/components/Reports.tsx: optional evidence fields and certainty labels.
- Modify .gitignore for local evidence files.
- Create tests/financial-history.test.ts and tests/financial-evidence.test.ts; extend tests/execution-recovery.test.ts.

### Task 1: Verify venue capabilities and normalize reads

**Files:** docs/financial-history-capabilities.md, server/exchange/types.ts, aster.ts, bybit.ts and tests/financial-history.test.ts.

**Interfaces:**
- Add FinancialQuery { since: number; until: number; cursor?: string }.
- Add FinancialFill { kind: 'fill'; id: string; orderId: string; clientId?: string; symbol: string; side: Side | null; qty: number; price: number; fee: { amount: number; currency: string } | null; realizedPnl: { amount: number; currency: string } | null; at: number }.
- Add FinancialFunding { kind: 'funding'; id: string; symbol: string; amount: number; currency: string; at: number }.
- Add FinancialPage { accountScope: string; records: Array<FinancialFill | FinancialFunding>; nextCursor: string | null; complete: boolean; supported: Array<'fills' | 'fees' | 'funding'> }.
- Add optional ExchangeAdapter.financialHistory?(query: FinancialQuery): Promise<FinancialPage>. Absence means unsupported. Never require implementations on other adapters.
- accountScope is a stable hash of venue/network and an already-configured public identity or verified read-only account id, derived within the adapter. Never hash private key/token material or publish addresses. If no safe identity is verifiable, persisted attribution for that adapter remains unsupported.
- fee.amount is normalized as signed cost (positive charge, negative rebate); funding.amount is signed account credit (negative payment). Keep raw source-id namespace by record kind.

- [ ] **Step 1: Verify official Aster and Bybit history API documentation.** Record actual URLs, read-only methods, required permissions, account identity source, timestamp units, side meaning, commission sign/currency, pagination and retention in the capability document. No live keys or account calls. Do not guess an endpoint/schema. If a capability is not documented, record unsupported and do not implement it.
- [ ] **Step 2: Add mocked HTTP contract tests** using verified response fields: two pages, empty complete window, malformed/truncated response, missing required fields, duplicate page cursor, negative rebate, signed funding, non-USDT fee and hedge-side ambiguity. Assert no POST/DELETE or order methods are called and malformed values never normalize to 0.
  For each supported adapter, use a verified fixture and the existing fetch injection. The test query is { since: 1000, until: 2000 }. Assert normalized output and captured methods, for example:
  ~~~ts
  expect(page.records.find((r) => r.kind === 'funding')).toMatchObject({
    kind: 'funding', amount: -2, currency: 'USDT'
  });
  expect(calls.every((c) => c.method === 'GET')).toBe(true);
  ~~~
  The raw mocked response and the expected signed value must be derived from the documentation verified in Step 1, not a made-up claim about venue behavior.
- [ ] **Step 3: Run** npm.cmd test -- tests/financial-history.test.ts. Expected: new normalization/capability assertions fail.
- [ ] **Step 4: Implement the declared optional interface with verified read-only calls.** Reuse existing adapter signing/timeouts/redaction. Mark complete only when the supported record categories cover the entire requested window and all pages; unsupported categories stay absent.
- [ ] **Step 5: Run** npm.cmd test -- tests/financial-history.test.ts tests/aster-agent.test.ts tests/live.test.ts and npm.cmd run typecheck. Expected: pass with all original order/protection tests intact.
- [ ] **Step 6: Commit** Task 1 files with message feat(exchange): expose verified read-only financial history.

### Task 2: Account-scoped evidence and conservative attribution

**Files:** server/live/financial-evidence.ts, tests/financial-evidence.test.ts, server/types.ts and .gitignore.

**Interfaces:**
- Consume FinancialPage from Task 1 and ExecutionIntent/Position/ClosedTrade from existing journal/types.
- Produce class FinancialEvidence(file: string | null = null), ingest(page: FinancialPage, window: { since: number; until: number }): void, attribute(intents: ExecutionIntent[], trades: ClosedTrade[]): void, summary(since: number, until: number): FinancialSummary.
- FinancialSummary { accountScope: string | null; coverage: 'complete' | 'partial' | 'unsupported'; actualFees: number | null; funding: number | null; confirmedNetRealized: number | null; unattributedRecords: number; observedAt: number | null }.
- Join fills by verified clientId/orderId and persisted intent.positionId, not symbol/time alone. Add optional executionOrderId?: string to ExecutionIntent when storing real order records. Do not fabricate intent records for external activity.
- Persist deduplicated records and covered windows atomically, scoped by accountScope. Reject a mixed-account page without deleting existing evidence. Summary totals become numeric only for proven complete windows/categories in USDT; non-USDT/ambiguous subsets retain null totals.
- confirmedNetRealized requires a complete managed lifecycle with attributed fills, actual fees and funding coverage. Partial lifecycle, unknown entry or external/manual exit stays null. Ledger evidence must not add a second local ClosedTrade or mutate execution checkpoints.

- [ ] **Step 1: Add tests** duplicate_pages_and_reload_count_once, failed_second_page_is_partial, unsupported_is_null_not_zero, complete_empty_window_is_zero, account_switch_cannot_mix_records, partial_close_ids_attribute_once, hedge_or_manual_ambiguity_stays_unattributed, non_usdt_total_is_null, funding_cost_and_rebate_preserve_sign and unknown_entry_prevents_net_profit_claim. Assert existing local realized estimates remain unchanged.
  Test-local completeEmptyPage(): FinancialPage uses a fixed anonymized accountScope, no records, all three supported categories and complete=true. Pin null versus zero:
  ~~~ts
  it('complete_empty_window_is_zero', () => {
    const evidence = new FinancialEvidence(null);
    expect(evidence.summary(1000, 2000).actualFees).toBeNull();
    evidence.ingest(completeEmptyPage(), { since: 1000, until: 2000 });
    expect(evidence.summary(1000, 2000)).toMatchObject({
      coverage: 'complete', actualFees: 0, funding: 0
    });
  });
  ~~~
- [ ] **Step 2: Run** npm.cmd test -- tests/financial-evidence.test.ts. Expected: fail because the ledger is absent.
- [ ] **Step 3: Implement the declared ledger, explicit coverage and exact-id attribution.** Local file defaults to data/financial-evidence-<venue>-<network>.json, ignored with its .tmp file. Tests pass null or a temp path. Retention must not discard records needed by any persisted open lifecycle; report current retained coverage honestly instead of promising unlimited history.
- [ ] **Step 4: Run** npm.cmd test -- tests/financial-evidence.test.ts. Expected: pass without credential, network or order access.
- [ ] **Step 5: Commit** Task 2 files with message feat(accounting): retain idempotent financial evidence and attribution.

### Task 3: Observe history outside execution and expose certainty

**Files:** server/live/executor.ts, server/desk.ts, server/index.ts, server/reports.ts, web/src/types.ts, web/src/components/Reports.tsx and tests/execution-recovery.test.ts.

**Interfaces:**
- Consume Task 1 optional history and Task 2 FinancialEvidence/FinancialSummary.
- Produce LiveExecutor.refreshFinancialEvidence(since: number, until: number): Promise<void> as a coalesced single-flight read. Persist real orderId into ExecutionIntent during existing reconciliation, not by resubmission.
- Start best-effort evidence refresh only after normal successful reconciliation, without awaiting it in open/close/kill or the serialized mutation queue. Use existing adapter request timeouts; no new permanent timer. An unsupported adapter returns without a network request.
- Add Report.accounting.financialEvidence?: FinancialSummary, widen existing actualFees/funding null fields to number | null, and preserve existing estimated/unknown realized fields. Text/UI must label confirmed net, estimated book PnL and account-wide funding separately.

- [ ] **Step 1: Add tests** history_timeout_does_not_delay_order_confirmation, unsupported_adapter_keeps_legacy_report_fields, repeated_refresh_is_singleflight, late_history_enriches_report_without_second_close and manual_exit_never_gets_guessed_net_pnl. Assert book.balance, day.startEquity, risk config, order/cancel counts and report scheduling remain unchanged.
  Extend the existing memory-adapter fixture with a deferred financialHistory promise. Resolve the order first without resolving that promise; do not use a flaky elapsed-time assertion:
  ~~~ts
  expect(openResult.ok).toBe(true);
  expect(historyResolved).toBe(false);
  expect(adapter.placed).toHaveLength(1);
  expect(desk.day.startEquity).toBe(dayStartBefore);
  ~~~
- [ ] **Step 2: Run** npm.cmd test -- tests/execution-recovery.test.ts. Expected: new evidence integration assertions fail.
- [ ] **Step 3: Implement background observation and additive report rendering.** Never backfill unavailable values with TAKER_FEE, configured estimates, analytical-feed prices or fabricated funding. Sanitize source errors through existing redaction.
- [ ] **Step 4: Run** npm.cmd test -- tests/financial-history.test.ts tests/financial-evidence.test.ts tests/execution-recovery.test.ts tests/learning.test.ts, npm.cmd run typecheck and npm.cmd run build. Expected: pass; no live account needed.
- [ ] **Step 5: Commit** Task 3 files with message feat(reports): distinguish verified financial evidence from book estimates.
