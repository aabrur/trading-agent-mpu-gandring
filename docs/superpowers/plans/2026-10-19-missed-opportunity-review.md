# Trading Agent Mpu Gandring Missed Opportunity Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking. Owner model restrictions in the specification override any skill model recommendation.

**Goal:** Explain skipped opportunities using subsequent observed price movement without inventing trades or changing decision rules.

**Architecture:** Add a small append/update review store fed by existing verdicts and market snapshots. Use a descriptive markout over the already configured auto interval. Reports consume bounded summaries; risk, lessons promotion and scorecards do not consume this store.

**Tech Stack:** Existing TypeScript, local JSON persistence and Vitest.

**Spec:** ../specs/2026-10-19-upgrade-follow-up.md

## Global Constraints
- All Global constraints in the specification apply verbatim.
- Do not add LLM calls, data requests, scheduling, eligibility thresholds, changes to trade frequency or standing rules.
- Markout is observed market movement, not executable profit, missed profit or a correctness score.
- Preserve existing Learnings protection/promotion behavior and notification cadence.

## Review Focus
- Replayed verdicts or process restarts must not create duplicate reviews; Task 1 pins stable ids and reload.
- Feed switches, sample/stale data and missing later prices must not become verified missed outcomes; Task 1 pins provenance.
- SHORT sign, exact time boundary and invalid prices must produce correct/null descriptive movement; Task 1 pins math.
- A failed execution differs from HOLD, VETO and Risk rejection; Task 2 pins reason attribution.
- Report building must not change guards, lessons, scores, model calls or exchange writes; Task 2 pins side effects.

---

## File structure
- Create server/opportunity-review.ts: typed bounded review records and deterministic observation.
- Modify server/desk.ts, server/types.ts and server/index.ts: verdict/snapshot integration and optional persistence path.
- Modify server/reports.ts, web/src/types.ts and web/src/components/Reports.tsx: separate descriptive review summary.
- Modify .gitignore: local data/opportunity-reviews.json and temporary atomic-write file.
- Create tests/opportunity-review.test.ts; extend tests/upgrade-workflow.test.ts for integration. Keep tests in memory or isolated temp directories.

### Task 1: Descriptive observation store

**Files:** server/opportunity-review.ts and tests/opportunity-review.test.ts.

**Interfaces:**
- Consume MarketSnapshot and Side from current server types.
- Produce ReviewInput { id: string; symbol: string; side: Side | null; reasonKind: 'hold' | 'veto' | 'risk-reject' | 'execution-failed'; reason: string; at: number; horizonMs: number; reference: { price: number; source: MarketSnapshot['source']; fetchedAt: number; example: boolean }; evidence: Record<string, unknown> }.
- Produce OpportunityReview extends ReviewInput with status: 'pending' | 'observed' | 'unavailable'; observedAt: number | null; observedPrice: number | null; directionalMovePct: number | null.
- Produce class OpportunityReviews(file: string | null = null), record(input: ReviewInput): void, observe(snapshot: MarketSnapshot): void, since(at: number): OpportunityReview[].
- Keep the latest 500 records, dedupe by id and persist atomically. This retention bound does not enter trading logic.
- Horizon is captured from cfg.auto.intervalMin * 60000. Use the first existing valid same-source snapshot at/after at+horizonMs, within one further horizon. Expired, sample, cross-source, invalid or stale observations yield unavailable/null, never substituted prices. Mark snapshots older than the captured horizon stale. Unknown side yields unavailable. No scheduler is added.

- [ ] **Step 1: Add tests** long_reference100_observed102_yields2, short_reference100_observed98_yields2, duplicate_id_survives_reload, before_horizon_remains_pending, invalid_or_cross_source_or_sample_is_not_observed, stale_or_expired_observation_is_unavailable, unknown_side_has_null_markout, and retention_keeps500. Assert outcome prices/timestamps/source separately from interpretation, with no realizedPnl property.
  Test-local input(side: Side): ReviewInput uses id='verdict-1', at=0, horizonMs=60000, reference price=100/source='bybit'/example=false, reasonKind='hold', and fixed evidence. snapshot(price: number, at: number): MarketSnapshot returns a valid non-sample Bybit snapshot. Representative assertion:
  ~~~ts
  it('short_reference100_observed98_yields2', () => {
    const store = new OpportunityReviews(null);
    store.record(input('SHORT'));
    store.observe(snapshot(98, 60000));
    expect(store.since(-1)[0]).toMatchObject({
      status: 'observed', directionalMovePct: 2, observedPrice: 98
    });
    expect(store.since(-1)[0]).not.toHaveProperty('realizedPnl');
  });
  ~~~
- [ ] **Step 2: Run** npm.cmd test -- tests/opportunity-review.test.ts. Expected: fail because the store is absent.
- [ ] **Step 3: Implement the declared store and exact observation semantics.** Sanitize market/agent reason text with existing untrusted/redaction helpers before persistence. Do not reinterpret favorable movement as a trade that could have passed the guard or been filled.
- [ ] **Step 4: Run** npm.cmd test -- tests/opportunity-review.test.ts. Expected: pass with deterministic time inputs and no network.
- [ ] **Step 5: Commit** only these two files with message feat(learning): record descriptive skipped-opportunity markouts.

### Task 2: Capture decision reasons and report without feedback gates

**Files:** server/desk.ts, server/types.ts, server/index.ts, server/reports.ts, web/src/types.ts, web/src/components/Reports.tsx, .gitignore and tests/upgrade-workflow.test.ts.

**Interfaces:**
- Consume OpportunityReviews from Task 1 and actual final Verdict/rule/research/gate/execution results in Desk.runDebate.
- Add DeskOptions.opportunityReviewsPath?: string | null, default null under VITEST. Runtime persistence is data/opportunity-reviews.json. Add Desk.opportunityReviews: OpportunityReviews.
- Feed observe(snapshot) only from existing updateTicker; never fetch for review.
- Add Report.opportunityReviews?: { observed: number; pending: number; unavailable: number; items: OpportunityReview[] }, restricted to the current report period and at most 10 detail rows. Keep existing report fields and legacy report rendering compatible.
- Record only non-executed opportunities once per verdict id with final reasonKind. Use original code-computed rule side or null; snapshot price is analytical, not a claimed execution price. Record VETO/Risk failure explicitly rather than relabeling everything HOLD.

- [ ] **Step 1: Add regression tests** capturing HOLD/VETO/REJECT/failed-open distinctly, retaining per-agent stances and code rule in evidence, recording no review for executed OPEN/CLOSE, and replaying the same verdict without duplication. Assert cfg.risk, Learnings.items and Scorecard.rows unchanged by observation/report building.
  In the existing real-provider HOLD test, capture risk and lesson state before runDebate and assert:
  ~~~ts
  expect(d.opportunityReviews.since(-1)[0].reasonKind).toBe('hold');
  expect(d.cfg.risk).toEqual(riskBefore);
  expect(d.learnings.items).toEqual(lessonsBefore);
  expect(calls.filter((r) => r.task === 'risk')).toHaveLength(0);
  ~~~
  Test observation/report side effects separately after the verdict, since the verdict itself legitimately updates Scorecard.
- [ ] **Step 2: Run** npm.cmd test -- tests/upgrade-workflow.test.ts. Expected: new review assertions fail.
- [ ] **Step 3: Integrate capture, existing-snapshot observation and optional report fields.** UI/text copy must say observed directional movement and analytical source, with pending/unavailable counts. Do not call it realized PnL, lost profit, or actionable advice. Do not feed it automatically into prompts, lessons, scores or risk gates.
- [ ] **Step 4: Run** npm.cmd test -- tests/opportunity-review.test.ts tests/upgrade-workflow.test.ts tests/learning.test.ts and npm.cmd run typecheck. Expected: pass; current lesson guard tests remain intact.
- [ ] **Step 5: Commit** only Task 2 files with message feat(reports): explain skipped decisions with observed follow-up evidence.
