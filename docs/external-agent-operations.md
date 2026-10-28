# Trading Agent Mpu Gandring: external six-agent operations

This is the shared operating contract for the Grok Bot team and the Muse personal-agent team. Both run the repository on their own computer. Their native agents supply the reasoning; the repository supplies data collection, sizing, execution, protection, journals, lessons and reports. Shared tools do not guarantee identical model decisions or trading performance.

Read `AGENTS.md` first. An installation or template update is not permission to trade, switch mode, enable Auto, change a provider, release Kill, or restart LIVE. Preserve the saved Owner configuration. Never copy another installation's keys, N, leverage, SL/TP, capital allocation, confidence setting or allowed symbols.

## Six independent roles

| Role id | Responsibility |
| --- | --- |
| `lead` | Chair the debate, weigh completed specialist replies, record one verdict and its evidence |
| `market` | Current price, structure, measured momentum and source quality |
| `research` | Verified/reported catalysts, on-chain observations and source provenance |
| `strategist` | Entry scenario, structural invalidation and opposing case |
| `risk` | OPEN admission separately from existing-position management and CLOSE review |
| `execution` | Independent venue/protection assessment and one guarded order submission |

Reuse existing native agents. A fresh install uses the main agent as Lead and creates five peers, including Execution. Never add a seventh coordinator. If the platform cannot create, resume or address a required role, report the missing capability. Do not fabricate teammate replies or let Lead silently replace all specialists. An incomplete entry review remains HOLD. Existing exchange protection continues independently.

## Runtime tools

Run these commands beside the office. Add `--json` for structured results.

| Command | Use |
| --- | --- |
| `npm run gb -- health` | Current mode, venue and kill state |
| `npm run gb -- context` | Saved runtime Owner settings, agents, account state and recent verdicts |
| `npm run gb -- capabilities` | Implemented tools and observed availability |
| `npm run gb -- research market_snapshot BTCUSDT` | Timestamped market observations and tactical scenarios |
| `npm run gb -- research market_news BTCUSDT` | Sourced catalysts, with evidence labels |
| `npm run gb -- research onchain_briefing BTCUSDT` | Available on-chain evidence; missing data stays unavailable |
| `npm run gb -- research desk_account BTCUSDT` | Account observation and recorded protection status |
| `npm run gb -- research jev_research BTCUSDT --objective "Collect candidate evidence"` | Shared collector, within the existing Owner-enabled JEV configuration |
| `npm run gb -- close-review BTCUSDT` | Fresh typed exit triggers, current position id/quantity, momentum and entry capacity |
| `npm run gb -- size BTCUSDT LONG 60000` | Owner-profile sizing preview; no order |
| `npm run gb -- positions` | Read recorded positions/protection; inspect account-observation freshness in context |
| `npm run gb -- reports` | Read recorded reports |
| `npm run gb -- summary status` | Shared formatted `/status` report |
| `npm run gb -- summary positions` | Shared formatted `/positions` report |
| `npm run gb -- summary scan` | Shared formatted `/scan` report |
| `npm run gb -- summary scorecard` | Shared formatted `/scorecard` report |
| `npm run gb -- backtest BTCUSDT --strategy simple_momentum` | Built-in baseline simulation, not a six-agent strategy replay |

Research, summaries and CLOSE review require a loopback client on the office computer. Do not publish the office to make them reachable. CLOSE review uses the existing reconciliation path; protection failures may invoke the engine's existing protective exits. It is not permission for the agent to invent an order.

## Cycle and entry admission

1. Verify Owner authorization, health, mode, venue and kill state. Run `gb scan`, `gb account`, `gb positions`, `gb lessons list`, `gb capabilities` and `gb context`.
2. Collect timestamped evidence once and assign it to the six roles. Declare intent `OPEN`, `MANAGE_EXISTING` or `CLOSE_REVIEW`. Keep exchange facts separate from local inference, stale narrative and unknown values.
3. Market, Research and Strategist give independent evidence-backed views. Risk and Execution assess the same current account observation. Lead weighs the completed replies and records OPEN_LONG, OPEN_SHORT, CLOSE or HOLD. Disagreement alone is not a code veto.
4. OPEN requires Risk APPROVE, the Lead's actual confidence meeting `context.trading.values.minEntryConfidencePct / 100`, a valid venue ticket, available capacity and the existing hard guards. Read this value at runtime; there is no template-specific 60% or 70% floor. Missing Risk approval is not APPROVE. Risk cannot silently REDUCE Owner sizing or replace profile SL/TP.
5. Execution submits one approved entry: `gb open <symbol> <LONG|SHORT> --risk-approval APPROVE --confidence <lead confidence> --reason "<verdict and Risk decision>" --json`. This selects the guarded agent-entry endpoint, requiring structured Risk APPROVE and actual confidence. It uses saved Owner leverage/profile and refuses ticket overrides. Do not omit the approval flag or fall back to legacy/manual entry after a refusal; do not add a second confidence threshold.
6. Re-read positions and recorded protection. Numeric SL/TP values alone do not prove resting exchange orders. Reconcile ambiguous fills before any further action; never resend blindly.
7. Finish with outcome-based lessons and the Owner's report cadence. Lessons are advice, not trading or configuration authority.

## Existing positions and verified CLOSE

Full slots, entry allocation, entry margin and Minimum Entry Confidence apply to OPEN only. They cannot veto a legitimate reduce-only CLOSE. Risk reviews the current position and its exit evidence, not a hypothetical extra entry. A daily loss stop blocks new entries; it does not make existing exposure unmanageable.

After Lead selects CLOSE, refresh `gb close-review <symbol> --trigger <Lead's selected trigger> --json`. The optional typed request also allows the engine to validate EARLY_TAKE_PROFIT against observed exhaustion/target and actual net profit; the request alone cannot make it verified. Select exactly one returned verified trigger matching Lead's verdict. Use its `position.id` and `position.qty`:

```bash
npm run gb -- close BTCUSDT --trigger MOMENTUM_REVERSAL \
  --position-id <review.position.id> --expected-qty <review.position.qty> \
  --reason "Lead CLOSE: measured reversal; Risk and Execution reviewed" --json
```

The backend recomputes strategy invalidation, momentum and triggers on current evidence under the execution lock. Snapshot and exchange-account freshness stay bounded to 30 seconds. It rejects a missing/changed position, externally owned exposure, stopped desk or mismatching trigger. This route does not apply entry confidence, free-slot or entry-margin admission.

An opposite OPEN signal against an existing position is only a CLOSE review. It needs an actual verified exit trigger and never reverses into a new entry in the same operation. Holding duration, model disagreement, a large unrealized gain, or a free-text anomaly alone cannot authorize CLOSE. Early profit taking requires actual net profit plus the engine's observed exhaustion/target evidence. If evidence expires during deliberation, refresh it; do not weaken freshness or rerun completed specialist research just to repair formatting.

Bare `gb close <symbol|all>` retains the explicit manual Owner-command path. Autonomous drivers must use the typed-trigger form above and must never fall back to the manual path after a refusal. Kill and automatic exchange protective exits retain their dedicated authorization and engine behavior.

## Research and reporting

Keep source identifiers concise (at most 120 characters, at most 10 sources). Keep full citations/URLs in `sourceDetails` as `{label, citation}` pairs. Preserve original vote, confidence and substantive argument. A schema-only repair reuses the completed answer, disables web/MCP research for that repair and changes format only. If content cannot be validated without invention, ABSTAIN honestly.

Use `gb summary` output for the four chat command reports; do not recreate metrics in prose. External platform messages alone do not populate backend scored trades. Report the actual recorded counters and mark absent external attribution unavailable. Never invent per-role accuracy, tool success, returns or connector availability.

## Installation upgrades

On the platform's own computer, inspect Git status and saved runtime state first. Preserve local work. Update `main` by fast-forward only, run `npm ci`, focused checks and the production build there. Refresh the six existing role profiles and the existing group/routines from their canonical files. Preserve secret-store entries and Owner settings; do not rerun new-install defaults over a configured desk. A LIVE restart needs explicit Owner authorization and post-restart verification of health, positions, protection and the daily-loss baseline.

Repository files, installed platform profiles and a published template are separate copies. Report each actual result separately. Do not claim a profile, routine, hosted template or LIVE outcome was updated without native-platform confirmation.
