# Trading Agent Mpu Gandring: local integrity audit

Date: 2026-10-29, Asia/Jakarta. Baseline: `42d85251af9f7f9706a2dd6ec38aef7037c2d6e2`, version `0.0.0.4.8`. The original checkout was clean on `main`. `git ls-remote origin refs/heads/main` returned that same SHA during this session. Work is isolated on `remediation/offline-integrity-gtc`.

Certain, based on Git output: the baseline matches the supplied audit identity. The supplied Repomix XML was not present as an attachment in this local task; conclusions below use the actual checkout. No remote Office, exchange account, installed platform profile or native routine was inspected. Engineering results are recorded separately in `TEST_RESULTS.md`.

## Verification matrix

Classification describes the baseline complaint, not a claim about a running host.

| Complaint | Baseline status | Source / reproducible seam | Correction and regression |
| --- | --- | --- | --- |
| Last completed bar is always discarded | NOT_REPRODUCED | `market/observations.ts::closedLiveCandles`, `strategy.ts::closedOnly`, `cli/gb.ts` use opening timestamps | Keep equality at close, document no second drop; deterministic 15m/1h/4h tests in `market-integrity-provenance.test.ts` and transport test in `gb-evidence.test.ts` |
| Duplicate/out-of-order rows can truncate valid history | CONFIRMED_CODE | Duplicate row inside an otherwise consecutive series made the actual filter return 11 bars instead of 21 | Deduplicate timestamps before the existing consecutive-tail filter; expose conflicting duplicates, ordering, gaps and clock diagnostics |
| Fallback candles can be described as native Aster | CONFIRMED_CODE | `market/index.ts::getCandles/getSnapshot` retained alternative-venue data with incomplete response metadata | Add per-feed requested/actual venue, endpoint, network, instrument, unit and availability; preserve useful reference data and existing admission rules |
| Candle volume loses precision in CLI JSON | CONFIRMED_CODE | `gb candles` applied `round2(c.v)`; `4.123456789e-8` became zero | Return native numeric candle values, metadata and errors unchanged; human text remains separately formatted |
| Median RVOL and ranking RVOL disagree | CONFIRMED_CODE | `strategy.ts::volumeDelta` uses the mean of up to 20 bars including current | Preserve it exactly; add complete prior-20 median diagnostic and an explicitly named mean diagnostic, with null/unknown for unavailable evidence |
| Candle direction share is actual taker pressure | CONFIRMED_CODE | Legacy `takerBuyPressure` is bullish-candle volume share | Preserve compatibility field and score; diagnostic is explicitly inferred. Normalized tape volumes have separate raw observations |
| Runtime uses 70% although Owner saved 60% | RUNTIME_ONLY | Active `cfg`, saved network profile, another Office and platform profile are separate | Add captured checkout/process/profile identity, active/saved threshold provenance and unknown native state; test existing Setup hot-apply, reload and reconstruction at 60% |
| Native routine permanently uses 15m | CONFIRMED_CODE | `grokbot/BOOTSTRAP.md` hardcoded its routine description | Bind documentation to the Owner's existing `DEBATE_INTERVAL_MIN`; phase remains UNKNOWN until native readback. No host routine or timer changed |
| Bar sampling is described as instantaneous | UNKNOWN | No native run trace supplied | Expose collector/bar times and local debate start/end; retain actual order journal times. Document 08:07 sampling delay and debate duration separately |
| Fresh article proves a current 24h liquidation metric | CONFIRMED_CODE | Legacy news provenance lacked separate event/window fields | Add publication/event/window/retrieval/value/unit/scope metadata. Missing event window stays UNKNOWN; repetition cannot establish verification |
| $932M liquidation event occurred in the claimed window | UNKNOWN | No primary event-window evidence supplied | Fixture demonstrates a fresh article quoting 15 October is historical. The dollar amount remains an unverified reported claim |
| Kill activation origin is overwritten | CONFIRMED_CODE | `killswitch.ts::writeKill`, generic `desk.kill()` reason; sequential regression reproduced overwrite | Exclusive first activation record, sanitized append-only local audit, source/correlation/result and explicit audit failure status; authorization/reset semantics preserved |
| Resting LIMIT GTC entry already exists | FEATURE_GAP | Baseline `PlaceOrder`, Aster MARKET request and immediate-fill executor | Implement explicit opt-in Aster lifecycle, guarded routes and CLI. MARKET remains default; every live feature is UNVERIFIED_LIVE |
| 1000FLOKI missing from fee group proves it is unavailable | NOT_REPRODUCED | `exchange/rules.ts::ASTER_GROUP_B` is a fee category; `coinOf()` preserves `1000` | Add independent public listing/candle diagnostics. Mocked listing success, invalid-symbol error and rate-limit failures remain distinct |
| 1000FLOKI is currently listed and produces host candles | UNKNOWN | Requires contemporaneous Aster exchangeInfo and public candle observations | Host-only checklist. No venue calls were made for verification |
| Node/Python mismatch is a production defect | NOT_REPRODUCED | `package.json` requires Node >=20; CI uses 24; worker is optional standard-library Python | Local Node 24.15.0 and Python 3.12.10 recorded. No package/runtime installation or worker activation |
| Discord /status works in production | UNKNOWN | Signed handler fixture can test routing, signatures and allowlists only | Add signed `/status` regression; provide separate private production smoke procedure |

Paths in the source column are under `server/` unless explicitly prefixed. Test paths are under `tests/`.

## Cross-check of supplied Gemini claims

Certain, based on source inspection: resting exchange stops existed before this patch; they are distinct from resting entry orders. Aster and Bybit baseline entry methods used MARKET, but that does not establish every internal order type used by every adapter. The order-execution skill's separate IOC workflow is not shared GTC support.

Certain, based on unchanged source and regression fixtures: mean-volume ranking, saved Owner configuration, 6h/48h news freshness, exchange guards, no-withdraw permission checks, exchange stops, kill authorization, local binding and OPEN/CLOSE separation are retained. Median RVOL is diagnostic only. Existing unavailable/stale behavior is retained; no new confidence, freshness or source gate was added.

Certain, based on the inspected files: OpportunityReviews remains observational. Financial cost/history collection remains read-only. Lazy-loaded `web/src/App.tsx` panels and `DeferredPanel.tsx` are retained. Historical bundle numbers in `docs/qa/2026-10-19-build-and-ci.md` describe that build; this session's build output is separate. Existing incident suites are retained; this audit makes no unsupported claim about how many suites a prior release added.

Needs verification, based on absent host observations: installed Grok Bot scripts may independently double-drop bars, use old profiles, run at a different phase, or obtain stale metrics through a standalone web tool. A source patch cannot attest those copies. Configured credentials and tool declarations do not prove provider connectivity, permission checks or successful live observations.

## GTC safety findings resolved during implementation

Certain, based on deterministic regressions: the baseline adapter ignored the new entry discriminator and submitted MARKET plus protection before any resting fill. The new path submits one LIMIT with GTC and protects observed exposure. BUY limits round down and SELL limits round up to the venue tick, preserving the explicit price bound.

Certain, based on a failing then passing regression: an early implementation suppressed later protective closes after the first emergency close. The journal now records cumulative fills covered by that close. Later fills are handled separately, while repeated callbacks cannot close the same observed fill twice. Unknown prior close results still require reconciliation.

Certain, based on fixtures: a stop price alone cannot establish quantity coverage. Aster readback distinguishes close-all net protection from quantity-limited or unknown coverage. Pending entries remain separate from filled positions; their filled and unfilled portions share one existing Owner slot. Cancellation preserves stops on filled exposure. Manual CLOSE handles the remaining entry and current filled position without entry-confidence or free-slot admission.

Official protocol reference consulted: [Aster Futures v3 account and trading API](https://asterdex.github.io/aster-api-website/futures-v3/account%26trades/#new-order-trade). LIMIT, GTC, order readback, cancellation and close-all trigger semantics were checked against that documentation, not against a live account. GTC is not a maker-only guarantee.

## Frontend boundary and remaining evidence

The frontend review is limited to consumers of the changed additive state contracts and the existing lazy panel boundary. No UI layout or interaction implementation changed. The [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md) were fetched as the required review baseline. A desktop/mobile visual audit was not performed or claimed.

The strongest remaining uncertainty is deployment/runtime evidence, not a verified source default defect. See `GROKBOT_HOST_READONLY_CHECKLIST.md` for exact private host checks and `OPERATIONAL_COMPATIBILITY.md` for pending-order compatibility and rollback limits.
