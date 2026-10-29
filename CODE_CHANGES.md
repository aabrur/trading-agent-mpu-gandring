# Trading Agent Mpu Gandring: changes by local commit

Branch: `remediation/offline-integrity-gtc`. Baseline: `42d85251af9f7f9706a2dd6ec38aef7037c2d6e2`. No push, PR, merge, release, deployment, host profile/routine edit, order or LIVE restart was performed.

## Implementation commit

`fbd6dd772b5211e1b90b206037d7b1bc3b293ead`

`fix: preserve market evidence and add opt-in Aster GTC lifecycle`

Certain, based on the committed diff and offline regressions:

| Area | Change | Preserved contract |
| --- | --- | --- |
| Candles | Timestamp finality metadata; duplicate normalization; gap/order/skew diagnostics; native JSON precision | Actual-interval close boundary, last completed row, existing stale/consecutive-tail behavior |
| Feed identity | Per-feed requested/actual venue, endpoint, network, instrument, unit and availability; separate Aster listing diagnostics | Useful cross-venue references remain available; no new entry veto or symbol exclusion |
| Volume | Named mean/current and median/prior-20 diagnostics; inferred candle-direction proxy; raw tape volumes | Existing volumeDelta score and ranking are unchanged |
| News | Publication/event/window/retrieval/value/unit/scope provenance and comparable-window checks | 6h/48h article freshness and existing trading protections |
| Runtime | Captured checkout/process/canonical profile identity; active/saved threshold origin; UNKNOWN installed profile and native phase | No read-command config mutation, env watcher or automatic restart |
| Routine docs | Owner DEBATE_INTERVAL_MIN cadence; phase/latency accounting; native readback procedure | No new timer, polling, order trigger or host edit |
| Kill | First activation preserved; sanitized append-only source/correlation/result audit; explicit forensic failure status | Existing local/channel authorization, flatten and reset behavior |
| Aster GTC | Explicit discriminated entry, side-aware limit tick, durable state/readback, cancellation, expiry and partial-fill protection | MARKET remains default, no implicit TTL, same Owner sizing and slot N |
| Recovery | Stable client IDs, no blind entry retry, protection coverage readback, emergency cumulative-fill checkpoints | No duplicate entry, stop or emergency close for the same observed fill |
| Routes/CLI | Strict additive entry input, explicit --limit/--ttl-min/--client-id, entries and cancel-entry | Existing OPEN confidence/Risk and CLOSE separation; no flags inferred from free text |
| Verification | Targeted regressions plus full isolated engineering checks | No real account/API order calls; existing kill test's Office request is now mocked |

The GTC gap reproduced because the baseline adapter ignored the discriminator and emitted MARKET plus trigger orders. Tiny volumes became zero because the CLI applied display rounding to JSON. Duplicate timestamps were mistaken for gaps. Kill activation origin was replaced by an unconditional write. A new late-fill regression found that an earlier emergency close ID suppressed protection of later fills; cumulative covered-fill checkpoints fix that sequence.

Implementation commit: 42 files, 1,761 insertions, 97 deletions. Exact file list:

```text
.gitignore
AUDIT_FINDINGS.md
GROKBOT_HOST_READONLY_CHECKLIST.md
OPERATIONAL_COMPATIBILITY.md
cli/gb.ts
cli/kill.ts
docs/external-agent-operations.md
grokbot/BOOTSTRAP.md
grokbot/OPERATIONS.md
grokbot/roles/macro-research.md
grokbot/roles/technical-market.md
server/app.ts
server/channels/commands.ts
server/decision/timing.ts
server/desk.ts
server/exchange/aster.ts
server/exchange/types.ts
server/killswitch.ts
server/live/executor.ts
server/live/journal.ts
server/market/index.ts
server/market/live-news.ts
server/market/microstructure.ts
server/market/news.ts
server/market/observations.ts
server/market/provenance.ts
server/research/routes.ts
server/runtime-evidence.ts
server/schemas.ts
server/setup/routes.ts
server/strategy.ts
server/types.ts
tests/channels.test.ts
tests/gb-evidence.test.ts
tests/gtc-cli.test.ts
tests/gtc-desk.test.ts
tests/gtc-entry.test.ts
tests/killswitch-forensics.test.ts
tests/live-observations.test.ts
tests/market-integrity-provenance.test.ts
tests/mpu-cli.test.ts
tests/runtime-evidence.test.ts
```

## Evidence report commit

The following documentation-only commit adds `CODE_CHANGES.md` and `TEST_RESULTS.md`. Resolve its exact SHA with `git log -1 --format=%H -- CODE_CHANGES.md TEST_RESULTS.md`. It changes no executable source or tests. The final chat response returns that branch-tip SHA.

S5 certifies implementation commit `fbd6dd7` and source-tree SHA-256 `4920341aec51576af92f0a41a7002982dc62c8f3ca31208e458b52cbf848e1e2`. The reports were added afterward; the S5 manifest is not mislabeled as a test of the later documentation commit.

## Host delta and limits

The exact separately authorized deployment delta is the implementation file list above, plus these two evidence reports. Locked packages and app version remain unchanged. See [host read-only checklist](GROKBOT_HOST_READONLY_CHECKLIST.md) and [compatibility/rollback](OPERATIONAL_COMPATIBILITY.md). Existing profiles/routines must be read and updated on their own host under separate authorization; a local source edit has not deployed them.

Runtime repository `dirty` reflects tracked changes at initialization; canonical role/template digests are captured separately. The descriptor's `partialFillHandling` refers to the new GTC lifecycle, not a denial of existing MARKET partial reconciliation. All live execution verification remains UNVERIFIED_LIVE. Standalone native web tools, exchange symbol availability, host clock/phase, profile copies and Discord production delivery remain host-only checks.

## Reports

- [Audit findings and verification matrix](AUDIT_FINDINGS.md)
- [Actual test results and stdout locations](TEST_RESULTS.md)
- [Operational compatibility and rollback](OPERATIONAL_COMPATIBILITY.md)
- [Private host read-only checklist](GROKBOT_HOST_READONLY_CHECKLIST.md)
