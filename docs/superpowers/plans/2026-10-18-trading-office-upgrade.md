# Trading Agent Mpu Gandring Implementation Plan

**Goal:** Correct execution accounting and recovery, improve decision inputs, and extend the existing six-agent office.
**Architecture:** Keep the existing adapter/executor/desk path, React SVG characters, CSS tokens and WebSocket stream. Separate exchange observations from estimated history and cosmetic activity from trading.
**Tech Stack:** TypeScript, Express, React, SVG, CSS, Vitest, Vite.
**Spec:** Owner's approved specification and reviewed implementation plan in this chat, 2026-10-18.

## Constraints
- No owner environment, credentials, risk parameters, mode, symbols, notification cadence, version or deployment changes. Commit and push to main were authorized on 2026-10-19.
- No live-account testing or server startup using owner configuration.
- No new trade eligibility thresholds, blind retries, cosmetic model calls or automatic reversal.
- Preserve existing startup protection policy. External/unknown positions are visible but not automatically adopted into strategy management.
- Native implementation; final independent review uses gpt-5.6-luna with max reasoning as requested by the owner.

## Tasks and verification
- [x] A1: executor fill quantities, partial accounting, confirmed prices, no phantom flat state. Tests: partial/failed/cancelled fills and repeated observations.
- [x] A2: reconcile ownership, protection and pending orders; serialize book mutations. Tests: restart, repeated sync, failed reads, external positions and opposite sides.
- [x] A3: venue execution quote, account provenance and report estimates. Tests: different feeds, zero equity, stale read, remote close without history.
- [x] B1: shared stop/TP preview from active configuration and instrument rules. Tests: LONG/SHORT, custom parameters, missing quote.
- [x] B2: scheduler generation and manual/scheduled cycle state. Tests: OFF while running/waiting, configure race, no duplicate timer.
- [x] B3: serialized decision context, OPEN-only risk call, honest trade-flow terminology and role instructions. Tests: provider payload and all four actions.
- [x] B4: available-evidence ranking, bounded lessons and outcome attribution. Tests: missing/stale input, partial exits, unknown outcomes.
- [x] C: deterministic scene director, meaningful destinations, SVG expressions, compact speech, actual-event fights, cleanup/reduced motion. Tests: event priority, stable ambient, duplicate events.
- [ ] D: operational grouping, source/cycle labels, static FX disclosure, responsive day/night UI. Verify with isolated fixtures in browser.
- [x] Final: focused regression tests, typecheck, production build, independent review and repair. Browser acceptance remains incomplete under D.

## Review focus
- An order can acquire additional fills after the first observation; cumulative fills must not be applied twice.
- A timeout is not a rejected order or a flat position.
- External positions must count as exposure without becoming automatic strategy-close targets.
- Zero venue equity is a valid observation; unavailable values must not become zero.
- Old WebSocket timers and repeated state snapshots must not replay effects or overwrite newer UI activity.

## Execution ledger
- Setup: isolated managed worktree from 4e565ab; no owner environment copied. No AI Slop applies to new copy; retain financial terminology such as leverage.
- Ruling: use the approved chat plan as the specification and retain this single progress ledger. Do not create unrelated artwork, video, landing-page design or dependencies.
- Ruling: no commits until the complete scoped diff is verified; no changes copied into the potentially running checkout.

- Owner requested handoff, checkpoint and break. Implementation is paused, not accepted as complete.
- A-D code was present at the pause. Independent Luna 5.6 MAX review found correctness gaps, subsequently repaired after the owner resumed work.
- Latest full-suite log records 260 passing tests in 31 files. Earlier focused pass: 53 tests and typecheck. Final combined-command output was interrupted; current typecheck/build completion is not claimed from that interrupted command.
- Browser observation permission for the isolated localhost preview was denied. Do not bypass that denial with another browser/CDP/Playwright surface. Responsive/day-night visual verification remains incomplete.
- Checkpoint is explicitly WIP. It does not authorize merge, deployment, release, push, or copying changes into the owner's possibly running checkout.

- 2026-10-19: Owner resumed implementation and explicitly authorized commit and push to main. Earlier pause is superseded.
- Integrated origin/main 3a73fad before final validation; its Aster signer/setup fixes remain intact.
- Latest verification: npm test = 265 passed across 31 files; npm run typecheck = passed; npm run build = passed. Existing build warning: client chunk about 526 kB, minified.
- Final execution fixes include symbol-wide pending intents, lagging position-snapshot checks, pause/kill serialization, null balance provenance, Bybit complete-list pagination and manual quantity-drift ownership handling.
- D implementation is present. Browser-origin denial leaves responsive, both-theme, reduced-motion and spatial visual acceptance incomplete. Do not bypass the previous browser denial.
- Actual fees/funding and historical exit fills remain unavailable through the current adapter interface; reports identify estimates/unknowns. No LIVE-account validation was performed.
- No owner .env, trading configuration, credential, notification cadence, version or deployment changes. All writes/tests occurred in the isolated worktree.
- Final independent review found an entry stopped before its first position snapshot could remain locally open forever. A regression test reproduced it; settled intents now yield to repeated consistent venue observations, with exit history/PnL left unknown. Active partial orders retain their pending reconciliation state. The adapter does not expose position-snapshot sequence numbers, so repeated reads cannot prove historical exit timing.
