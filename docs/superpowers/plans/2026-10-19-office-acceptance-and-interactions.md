# Trading Agent Mpu Gandring Office Acceptance and Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking. Owner model restrictions in the specification override any skill model recommendation.

**Goal:** Finish paired office behavior and obtain honest visual acceptance without affecting trading.

**Architecture:** Extend the current pure scene selector, the single coordinator hook and SVG poses. Authentic speech/status/order events can stage paired interactions; ambient social behavior has cosmetic labels only. Trading never waits on animation.

**Tech Stack:** Existing TypeScript, React, SVG, CSS, Vitest and the authorized browser tool.

**Spec:** ../specs/2026-10-19-upgrade-follow-up.md

## Global Constraints
- All Global constraints in the specification apply verbatim.
- Preserve six agents, current environment artwork, warm themes and existing controls.
- No new runtime package, animation engine, backend model call or trading delay.
- Browser acceptance is blocked until explicit renewed authorization for the previously denied localhost origin.

## Review Focus
- Replayed WebSocket events must not restart handoffs indefinitely; Task 1 pins event identity.
- Busy execution/risk actors must preempt cosmetic movement immediately; Task 1 pins priority.
- Reduced-motion or hidden-tab changes during a walk must release reservations and cancel movement; Task 1 pins the selector and Task 2 checks rendering.
- Long speech at the top/right/mobile boundaries must stay compact and leave full text accessible; Task 2 checks the matrix.
- Chunk load failures, if the bundle plan is implemented first, must leave trading controls available; Task 2 checks actual navigation.

---

## File structure
- Modify web/src/sceneDirector.ts: deterministic scene selection and paired destination reservations.
- Modify web/src/useSceneDirector.ts: existing single clock, event identity and visibility/reduced-motion inputs.
- Modify web/src/useDesk.ts and web/src/types.ts: normalize completed authentic speech into bounded scene events.
- Modify web/src/components/Office.tsx, Bot.tsx and web/src/styles/app.css: facing, paired document pose, interrupted movement and bubble placement.
- Modify tests/scene-director.test.ts: pure deterministic behavior and path assertions.
- Create scripts/office-preview.ts: isolated opt-in PAPER/mock preview, not imported by production.
- Create docs/qa/2026-10-19-office-acceptance.md: actual matrix, results and authorized screenshot paths.

### Task 1: Paired staging from authentic events

**Files:** sceneDirector.ts, useSceneDirector.ts, useDesk.ts, types.ts, Office.tsx, Bot.tsx, app.css and tests/scene-director.test.ts listed above.

**Interfaces:**
- Consumes existing DeskState, AgentId, Point, Activity, route(from: Point, to: Point, desks: Point[]): Point[] and actual speech payload with agent, text, done.
- Extend SceneEvent.kind with 'speech' and optional agent?: AgentId; target?: AgentId. Keep id/at/status and existing kinds backward compatible.
- Extend Activity with optional facing?: 'left' | 'right'; partner?: AgentId. Keep existing pose/face/label/destination.
- Produce directScene(input: { state: DeskState; events: SceneEvent[]; tick: number; now: number; hidden: boolean; reducedMotion: boolean }): Record<AgentId, Activity>. useSceneDirector retains its existing return type.
- Research-to-Lead report sharing and Risk-to-Execution ticket sharing consume completed role speech. They express communication, never claim approval/fill from text parsing. Ambient paired chat is explicitly cosmetic.

- [ ] **Step 1: Add failing tests in tests/scene-director.test.ts.** Use existing fixtures or a typed DeskState fixture. Add assertions for each:
  - duplicate speech id produces the same scene without restarting a reservation;
  - execution.status='executing' cancels its ambient partner/destination;
  - directScene with reducedMotion=true or hidden=true has no shared movement destinations;
  - two actors reserve distinct reachable points and no segment enters blocked furniture;
  - speech from research stages research/lead while status='partial' never produces cheer;
  - elapsed authentic event lifetime of 7000 ms releases the pair; timestamps far in the future are ignored.
  Test-local sceneFixture(): Parameters<typeof directScene>[0] must return a typed idle six-agent state with fixed tick/now and no network. Representative assertions:
  ~~~ts
  it('busy execution preempts a cosmetic pair', () => {
    const input = sceneFixture();
    input.state.agents.execution.status = 'executing';
    expect(directScene(input).execution.destination).toBeUndefined();
    expect(directScene(input).execution.partner).toBeUndefined();
  });
  it('reduced motion has no shared movement', () => {
    const frame = directScene({ ...sceneFixture(), reducedMotion: true });
    expect(Object.values(frame).every((a) => !a.destination)).toBe(true);
  });
  ~~~
- [ ] **Step 2: Run** npm.cmd test -- tests/scene-director.test.ts. Expected: new assertions fail because directScene/paired event behavior is absent.
- [ ] **Step 3: Implement directScene and normalize only completed speech once per event id.** Keep events bounded as in useDesk, retain actual timestamps, and give active trading/status events priority. Reserve at most one pair; route with the existing furniture graph. Keep the existing single timer and cancellation cleanup. Add facing/document SVG details without replacing character identities.
- [ ] **Step 4: Run** npm.cmd test -- tests/scene-director.test.ts and npm.cmd run typecheck. Expected: pass, with no new timer or model/exchange call.
- [ ] **Step 5: Commit** only the Task 1 files with message feat(office): stage authentic paired agent interactions.

### Task 2: Isolated visual acceptance and necessary CSS fixes

**Files:** scripts/office-preview.ts, docs/qa/2026-10-19-office-acceptance.md, Office.tsx, app.css and useSceneDirector.ts only if observations require fixes.

**Interfaces:**
- Consumes createApp(cfg: AppConfig, opts) from server/app.ts with explicit PAPER/sample/mock config and executor absent; data/report/learning/kill persistence disabled.
- Produce a localhost-only preview using an OS-assigned port. Never import server/index.ts, load the owner's env, connect exchange adapters, send notifications or add public production QA routes.
- QA-only scenarios are labeled fixtures. They may exercise event rendering but must never be represented as real trades or agent history.
- Produce a matrix for representative 1366x768, 1440x900 and 390x844 viewports, both themes and reduced motion on/off. These are chosen targets, not a claim to have the missing original screenshot.

- [ ] **Step 1: Obtain explicit renewed browser-origin authorization.** If denied/unavailable, record the blocker and leave visual acceptance unchecked. Do not try another observation channel.
- [ ] **Step 2: Create and start the isolated preview** with npx.cmd tsx scripts/office-preview.ts. Expected: a localhost URL and PAPER/sample/mock health state; no keys, owner files, notification output or exchange network traffic.
- [ ] **Step 3: Run the matrix through the authorized browser.** Exercise real mock debate, authentic disagreement versus fight, paired movement interruption, long completed speech, partial/full/failed execution fixtures, Desk Ops inputs, full agent text access, chart/setup navigation and close controls. Observe idle life for 60 seconds. Change reduced motion and tab visibility during movement.
- [ ] **Step 4: Fix only observed clipping, overlap, focus or animation cleanup defects.** Re-run the affected matrix cases; record pass/fail and actual capture paths. Confirm no document horizontal overflow, no giant overlapping bubbles, accessible controls and no residual WAAPI movement under reduced motion.
- [ ] **Step 5: Run** npm.cmd test -- tests/scene-director.test.ts, npm.cmd run typecheck and npm.cmd run build. Expected: pass. Stop only the preview process created by this task.
- [ ] **Step 6: Commit** the preview, QA evidence and actual fixes with message fix(office): verify responsive and reduced-motion staging. Do not commit an all-pass report if browser authorization remains unavailable.
