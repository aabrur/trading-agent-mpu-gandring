# Trading Agent Mpu Gandring Bundle and CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking. Owner model restrictions in the specification override any skill model recommendation.

**Goal:** Remove the oversized initial client chunk and establish an offline CI gate with exact-SHA verification.

**Architecture:** Load the chart and infrequently opened panels through existing React lazy/Suspense boundaries. Use one GitHub Actions workflow for typecheck, existing tests and production build, with no credentials, deployments or releases.

**Tech Stack:** Existing React, TypeScript, Vite, Vitest, Node 24 and GitHub Actions.

**Spec:** ../specs/2026-10-19-upgrade-follow-up.md

## Global Constraints
- All Global constraints in the specification apply verbatim.
- Do not raise chunkSizeWarningLimit, hide warnings, install a bundle framework or split trading controls into deferred menus.
- Preserve the project's Node >=20 floor; use Node 24 in CI to match the validated host.
- No exchange/model secrets, owner env file, LIVE startup, deployment, registry publication, automatic release or privileged pull_request_target workflow.
- Creating the workflow is planned work, not a claim CI already exists. Future push/run requires authorization in that execution session.

## Review Focus
- A deferred chunk load failure must not hide Kill/Close/Auto controls; Task 1 checks local loading and failure behavior.
- Opening Setup or AgentPanel must preserve their focus/close behavior; Task 1 checks authorized navigation.
- An unchanged bundle warning must not be relabeled fixed by increasing a limit; Task 1 compares actual built sizes.
- Clean CI has no owner .env and no credentials, yet all guard tests must run; Task 2 pins offline environment.
- A green run for another commit or workflow is not verification of the delivered SHA; Task 2 records exact headSha.

---

## File structure
- Modify web/src/App.tsx: lazy named-export imports for PriceChart, SetupWizard and AgentPanel; local Suspense boundaries only.
- Create web/src/components/DeferredPanel.tsx: small loading/error boundary for a deferred panel, leaving the office and operations mounted.
- Modify web/src/styles/app.css: stable local loading/error placeholder dimensions and visible reload action.
- Modify vite.config.ts only if inspection demonstrates another required split; keep current warning threshold.
- Create .github/workflows/ci.yml: read-only permissions, npm ci, typecheck, existing tests, build.
- Create docs/qa/2026-10-19-build-and-ci.md: measured chunk evidence, real run URL/SHA and blockers.

### Task 1: Split optional UI without losing operations

**Files:** web/src/App.tsx, web/src/components/DeferredPanel.tsx, web/src/styles/app.css; vite.config.ts only if the measured build requires it.

**Interfaces:**
- Consume existing named exports PriceChart, SetupWizard and AgentPanel with unchanged props. Use React.lazy imports resolving those named exports to default, no component API rewrites.
- Produce DeferredPanel({ children, label }: { children: React.ReactNode; label: string }), a local error boundary/Suspense wrapper. Failure copy identifies the panel and offers a button that reloads the office; do not auto-reload an active desk.
- Keep DeskOps, CommandBar, TopBar, office, kill/close controls and WebSocket state outside these boundaries.
- Preserve on-demand setup and agent panels. A chart loading placeholder holds its space rather than shifting Desk Ops.

- [ ] **Step 1: Record the baseline** with npm.cmd run build into docs/qa/2026-10-19-build-and-ci.md: current JS chunk 526.40 kB minified, CSS 68.51 kB, warning threshold unchanged. Use actual new output if the baseline has drifted.
- [ ] **Step 2: Implement the declared lazy imports, local DeferredPanel and stable fallback styles.** Do not add dynamic imports to financial execution or critical controls. Add no runtime dependencies.
- [ ] **Step 3: Run** npm.cmd run typecheck and npm.cmd run build. Expected: pass, initial entry JS smaller than baseline, every emitted JS chunk below the existing 500 kB warning threshold and no corresponding warning. If a remaining shared chart chunk is still over that threshold, inspect actual generated imports and split that dependency at the chart boundary; do not suppress the limit.
- [ ] **Step 4: After renewed browser authorization, verify** chart load, setup open/close/focus restoration, AgentPanel speech access, offline chunk-load failure/reload action, and uninterrupted access to operational controls. If browser access is still denied, record behavioral acceptance unverified rather than bypassing it.
- [ ] **Step 5: Run** npm.cmd test with DOTENV_CONFIG_PATH=__isolated_no_env__. Expected: all existing tests pass. No mirrored component tests or new browser framework is required for this reversible UI import change.
- [ ] **Step 6: Commit** only Task 1 files and actual measurement evidence with message perf(web): defer optional panels and chart loading.

### Task 2: Offline CI and commit-specific proof

**Files:** .github/workflows/ci.yml and docs/qa/2026-10-19-build-and-ci.md.

**Interfaces:**
- Trigger on push to main and pull_request, with permissions contents: read and no secrets reference.
- Job validate runs on ubuntu-latest, timeout-minutes 15, actions/checkout@v4 and actions/setup-node@v4 with node-version '24', cache npm and npm ci --ignore-scripts --no-audit --no-fund.
- Environment: DOTENV_CONFIG_PATH=__isolated_no_env__, CI=true. Run npm run typecheck, npm test and npm run build as distinct steps. Do not import server/index.ts or execute setup/doctor/roundtrip/dev/start.
- Existing v4 action pins are deliberately explicit for this plan; verify official action support at implementation time before selecting a newer major. Never add package-install or release credentials.

- [ ] **Step 1: Write the workflow exactly within the declared trigger/job/environment contract.** Keep tests serial after install, then build. Do not delete or weaken a safety test if Ubuntu exposes a Windows-specific assumption.
- [ ] **Step 2: Rehearse the commands in the isolated worktree.** Run npm.cmd ci --ignore-scripts --no-audit --no-fund, npm.cmd run typecheck, npm.cmd test and npm.cmd run build with the declared env. Expected: each exits 0. This is local proof, not GitHub CI.
- [ ] **Step 3: Commit** only the workflow and evidence document with message ci: validate offline trading desk tests and build.
- [ ] **Step 4: When that execution session authorizes push, push normally and query** gh run list --repo aabrur/trading-agent-mpu-gandring --commit <actual-full-head-sha> --json databaseId,headSha,status,conclusion,url. Wait for that run with gh run watch <actual-run-id> --exit-status.
- [ ] **Step 5: Record the actual SHA, workflow URL and result.** Expected: headSha equals pushed HEAD and conclusion success. If Actions is disabled, permissions unavailable, no run appears, or a step fails, record the specific condition. Inspect failed job logs and fix only a reproduced in-scope CI issue; never substitute a prior green run.
- [ ] **Step 6: Commit** the final factual QA evidence separately. A docs-only evidence commit creates another main SHA, so report both the verified code SHA and final doc SHA; do not claim the latter passed before its own run completes.
