# Trading Agent Mpu Gandring follow-up acceptance

## Boundary

Implementation uses the isolated `codex/trading-office-upgrade` worktree, starting at d7476614e73965156256dd0f1735f72ce0279ab7. The original checkout and its local changes were not edited or restarted. Browser permission was explicitly renewed for isolated preview in this session.

The preview used PAPER, sample data, mock agents, no executor, no report/lesson/kill persistence, and an OS-assigned localhost port (51475 in this run). Preference-save QA used only `.superpowers/qa-settings.env`: 1234 was saved, Setup closed/reopened, Edit still showed 1234, then QA balance was restored to 1000. No owner settings or credentials were used. The preview was stopped after QA.

## Implementation coverage

| Work | Files | Result |
| --- | --- | --- |
| Optional bundle and CI | App.tsx, DeferredPanel.tsx, app.css, .github/workflows/ci.yml | Chart/Setup/agent panels deferred; critical controls remain mounted. Offline workflow prepared. |
| Saved Setup and Desk Ops | Setup.tsx, PreferencesSetup.tsx, ModelsSetup.tsx, Channels.tsx, DeskOps.tsx, DESIGN.md | Saved summaries, explicit Edit, prefilled non-secret choices, Cancel, retained tab drafts, fixed frame, plain help, grouped controls. ON/OFF and Cycle now do not save unrelated draft schedule values. Symbol drafts no longer reset on identical WebSocket snapshots. |
| Authentic office interaction | sceneDirector.ts, useSceneDirector.ts, useDesk.ts, Office.tsx, AgentPanel.tsx, types.ts | Stable completed speech ids; Research/Lead and Risk/Execution paired staging; facing; reachable separate destinations; priority/interruption; full last speech in agent panel. Partial or unknown fills never trigger verdict cheers. Hidden/reduced motion finish movement. |
| Missed-opportunity observation | server/opportunity-review.ts, desk.ts, app.ts, reports.ts, Reports.tsx | Bounded idempotent observations, explicit HOLD/VETO/Risk/execution-failure reasons, same-source follow-up prices, maturation visible in later reports, unavailable expiry. No profit/score/gate feedback or new calls. |
| Financial evidence | exchange/types.ts, financial-history.ts, aster.ts, bybit.ts, live/financial-evidence.ts, executor.ts, desk.ts, reports.ts, Reports.tsx | Optional signed read-only history, scoped dedupe/coverage, conservative exact-id attribution, explicit unknowns, independent order path and report snapshot. See ../financial-history-capabilities.md. |

Decision speech no longer waits for cosmetic pacing during a debate. Agent calls, configured rounds, fight threshold and opening guards remain in place.

## Browser observations

Five Setup sections retained the same frame per viewport. Both themes and reduced motion on/off were measured with the preview foreground, avoiding stale background-tab layout readings.

| Viewport | Modal width | Modal height | Top | Document horizontal overflow |
| --- | --- | --- | --- | --- |
| 1440 x 900 | 1100 | 820 | 40 | none |
| 1366 x 768 | 1100 | 736 | 16 | none |
| 390 x 844 | 351 | 812 | 16 | none |

The desktop browser's stable scrollbar gutter is included in these measurements. Modal animation and transform were `none`. Mobile navigation scrolls horizontally inside the modal, while the content pane scrolls vertically.

Confirmed interactions:

- Saved summary opens before editing. Paper-balance draft 1234 survived tab navigation; Cancel restored 1000. A subsequent isolated save survived closing/reopening Setup. Model Edit showed the saved mock provider. No secret is prefilled.
- Escape closed Setup and returned focus to its trigger. Existing manual LIVE confirmation is blank and its switch button disabled until the exact phrase is entered. No mode switch was submitted. Review found and removed the old auto-confirm bypass.
- Deliberately blocking the PriceChart chunk displayed the local error/reload action while Kill, Cycle now and Auto OFF remained enabled. The block was removed and reload restored normal navigation.
- An actual offline mock debate completed and produced its own speech, disagreement/fight and verdict. No execution fixture was represented as a real fill. Ambient walking was observed; a 73-second idle check ended with stable workstations.
- Agent panel initially omitted the speech promised by the bubble. After the fix, Research showed the full recorded line, labeled EXAMPLE for mock, without a new model request.
- Reduced motion reported zero running WAAPI agent-anchor animations. The visibility cleanup also finishes active movement; direct hidden/reduced staging is covered by deterministic tests.

Local ignored captures: `.superpowers/qa/setup-final-desktop.png`, `setup-final-mobile.png`, `setup-desktop-night.png`, `office-final-desktop-day.png`. Final matrix: `setup-verified-matrix.json`. Earlier intermediate measurements taken while the tab was backgrounded are excluded from acceptance. Capture timeouts were recovered by foregrounding the preview. Preview rebuilds and the deliberate blocked chunk produced expected missing-asset logs.

## Verification

Windows PowerShell, with `DOTENV_CONFIG_PATH=__isolated_no_env__` and `CI=true`:

- `npm.cmd ci --ignore-scripts --no-audit --no-fund`: exit 0, 224 packages installed.
- `npm.cmd run typecheck`: exit 0.
- `npm.cmd test`: exit 0, **290 tests in 34 files** after the final fixes.
- `npm.cmd run build`: exit 0. Initial JS **325.11 kB**, chart 168.36 kB, Setup 35.21 kB, AgentPanel 2.83 kB, JSX 8.27 kB, CSS 71.08 kB. No oversized chunk warning; the warning limit was not changed.
- `git diff --check`: clean before commits.

Regression failures were reproduced before fixes for cross-page account switching, unknown fill fees falsely becoming zero, report state drifting during history awaits, expired review visibility, cosmetic decision delay and partial-fill cheers. Financial, opportunity, workflow and scene tests are local mocks with temporary/in-memory persistence. Existing safety tests were retained.

## Limits and outstanding acceptance

- GitHub CI is **not run**: this follow-up has no push authorization. No release, version change, deployment or activation occurred.
- Full visual fixtures for partial/full/failed execution, forced long speech and hidden-tab interruption across every office viewport/theme combination are not all captured. Their deterministic event/route/priority behavior is tested; do not call that complete browser choreography acceptance. Saved Setup's complete size/theme/motion matrix is verified. The final symbol-draft equality and partial-verdict reaction refinements were verified by final tests/typecheck/build, after the captures.
- Aster saturation, missing historical entries, non-USDT costs and ambiguous funding/exit attribution remain unknown where proof is unavailable. No inferred net profit replaces them. Evidence archival is not implemented; records needed by open lifecycles are retained.
- The history refresh runs at report generation instead of every reconciliation, outside order locking. Report delivery can wait for read timeouts; the configured scheduling interval and delivery channels were not changed.

Owner configuration values, trading/risk guards, credentials, modes, permitted symbols, providers/models and notification/report cadence were not changed. The existing typed setup confirmation was restored in the UI. No real account order or testnet roundtrip was performed. Implementation is local and has not been activated in the owner's LIVE process.
