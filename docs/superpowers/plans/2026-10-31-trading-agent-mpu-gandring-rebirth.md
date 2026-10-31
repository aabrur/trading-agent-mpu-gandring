# Trading Agent Mpu Gandring Rebirth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking. This is a reviewed planning deliverable, not authorization to implement, activate trading, or send messages. Do not dispatch agents before an execution method is selected by Boss.

**Goal:** Mengganti backend intelligence dan trading runtime Trading Agent Mpu Gandring dengan evidence-driven runtime yang mempertahankan seluruh UI/CLI dan menghubungkan Grok sebagai satu logical six-role desk dengan satu execution authority per akun.

**Architecture:** Modular monolith TypeScript baru di belakang compatibility facade HTTP/WebSocket. Bybit linear menjadi reference market; research worker menghasilkan sourced evidence; enam logical roles dan Jev menghasilkan intent yang dievaluasi gateway account-scoped. Satu embedded SQL ledger menyimpan settings/events/intents serta inbox/outbox; Grok asynchronous tidak memegang exchange signer.

**Tech Stack:** Node >=20, TypeScript, Express, React/Vite, ws, Zod, Vitest, existing playwright-core, existing venue signing SDKs yang lolos audit; proposed @libsql/client 0.18.0 untuk file lokal. Tidak ada ORM, database service, queue service, atau framework trading baru.

**Spec:** [Architecture](2026-10-31-trading-agent-mpu-gandring-architecture.md), [validation and source hashes](2026-10-31-trading-agent-mpu-gandring-validation.md), serta sembilan original source files di folder Downloads yang dicatat validation report. Baca architecture dan sources sebelum coding. Konflik sumber mengikuti keputusan Boss yang direkam saat review, bukan urutan file atau perintah di handoff prompt.

## Global Constraints

- Project name: Trading Agent Mpu Gandring. Baseline lokal: a725218a304bc32f5347ed150da9755eb8df7783; appVersion 0.0.0.4.11.
- Source package: “No order/live service startup, GitHub push/PR, existing process restart, config change or deletion in this planning phase.”
- Source package: “Owner exclusively sets symbols, N, size, capital, leverage, stops, TP, confidence, timeframe/schedule and model choices.”
- Source package: “Unknown optional research is never transformed into a veto or false VERIFIED signal.”
- Source package: “CLOSE is independent from OPEN confidence and spare slots.”
- Source package: “In connected mode, Mpu is the sole active LIVE executor and canonical configuration/ledger authority; no simultaneous independent Grok order execution for an overlapping account.”
- Preserve Node >=20; prove native dependency on Windows and Node 20/22/24. No silent engine-floor increase.
- Preserve existing UI, English/Indonesian, day/night, reduced motion, assets, all visible controls, local CLI login/model/effort and complete mpu/gb command surface.
- Preserve PAPER/TESTNET/LIVE separation, typed LIVE confirmation by Owner, trade-only delegation/withdraw refusal, daily-loss persistence, safety net, Owner N, resting-stop verification, idempotency, kill and reconciliation.
- Preserve exact Owner values during migration. N remains current supported 1..4 until Boss explicitly approves schema expansion. Do not transplant a preset over account capital fields.
- D09 ACCEPTED by Boss in chat on 31 October 2026: existing local Kill retains cancel/flatten behavior; Grok STOP halts entries, turns Auto OFF, cancels nonprotective orders, and retains open positions with their resting SL/TP. Both share durable halt state. STOP alone does not authorize CLOSE; emergency protection handling remains separate.
- Secrets only through established masked/hidden local flow. Do not print, copy into test fixtures, hash into public identity, or migrate keys through chat/events.
- Fixtures and synthetic backtests are isolated and labelled. No old lessons/sample stories/mock provider in new real-decision graph.
- Implement in isolated worktree after authorization; test servers bind ephemeral loopback ports and use temporary data. Installed .env, dist, journals, service/autostart and bot routines are not test fixtures.
- Checkpoint commit commands below are future execution steps on the implementation branch. If local commits are not part of that authorization, leave an equivalent reviewed diff. No push, PR, deployment or runtime cutover is implied.

## Review Focus

1. Reversal or trading-setting change while a cycle waits for the execution lock: re-read current evidence/config and invalidate only the approved thesis; no aiApproved bypass. Tests T03, T08, T09.
2. Duplicate/out-of-order Bybit events and REST/WS overlap, including legitimate nonconsecutive orderbook update IDs: no lookahead, duplicate volume, false resync or invented certainty. Tests T04, T05.
3. Timeout after venue acceptance followed by partial fill/cancel/stop race or restart: one stable intent, actual quantity protected, native reconciliation, no blind resend. Tests T09, every T11 variant, T18.
4. Signed bot callback claims actorRole=owner, reuses a nonce, or arrives after the role was reassigned: no Owner mutation, duplicate vote, stale result, or secret exposure. Tests T15-T17.
5. Account/venue switch with protected old positions and a failed settings activation: old lifecycle remains monitored; old policy remains active on prepare failure; remote ack cannot roll back local settings. Tests T02, T03, T16-T18.

---

## Delivery phases, dependencies dan gates

Plan ini satu integrated migration dengan deliverable yang dapat direview terpisah. Workstream market, research, execution, UI dan bridge tidak menjadi lima runtime atau lima sumber authority.

| Phase | Tasks | Gate sebelum lanjut |
|---|---|---|
| P0 Baseline | T00 | Manifest UI/API/CLI/settings/assets lengkap dan SHA dikunci |
| P1 Runtime contracts/durability | T01-T03 | No legacy runtime imports; crash-safe store; versioned settings dan account registry |
| P2 Evidence | T04-T06 | Bybit stream, deterministic indicators, actual tools/provenance bekerja tanpa fabricated data |
| P3 Agents/decision | T07-T08 | Six logical roles, no fake completion, optional Jev, fresh thesis dan independent CLOSE |
| P4 Execution | T09-T12 | Gateway/protection, wallet, delapan adapters, PAPER/backtest/learning isolation |
| P5 Product parity | T13-T14 | Existing UI/API/CLI/channels/logs/reports/support/update berfungsi pada runtime baru |
| P6 Grok interoperability | T15-T17 | Scoped typed bridge, durable async workflow, proven limits of Owner/authority |
| P7 Acceptance/cleanup | T18-T19 | Full checks, isolated recovery/migration rehearsal, artifact closure, classified cleanup |

Dependency DAG:

~~~text
T00 -> T01 -> T02 -> T03
T03 -> T04 -> T05
T03 -> T06
T05 + T06 -> T07 -> T08
T03 + T08 -> T09 -> T10 -> T11a..h
T08 + T09 -> T12
T10 + T11a..h + T12 -> T13 -> T14
T02 + T03 + T07 -> T15 -> T16
T09 + T13 + T14 + T16 -> T17
T11a..h + T14 + T17 -> T18 -> T19
~~~

Ada independent graph nodes, tetapi sesi ini tidak memilih atau menjalankan parallel agents. Grok tidak menghalangi local Bybit/position monitoring. Acceptance penuh AC-13..17 tetap belum lengkap bila actual external proof belum tersedia.

## Shared interfaces dan lokasi keputusan

Domain IDs/evidence/MarketFrame/AccountScope/DecimalString memakai architecture section 4. Each task owns the concrete service below; downstream tasks import its exported types and methods, not a duplicate definition.

| Owner task | Export dan exact boundary |
|---|---|
| T01 | OfficeState/OfficeEvent in shared/office.ts; createReplacementApp(runtime: OfficeRuntime): express.Express. OfficeRuntime has snapshot(): OfficeState and dispatch(input: OfficeCommand): Promise<OfficeReply>; command/reply DTO mengikuti T00 |
| T02 | RuntimeStore.open(file: string): Promise<RuntimeStore>; transaction<T>(fn: (tx: StoreTransaction) => Promise<T>): Promise<T>; append(event: DomainEvent): Promise<number>; close(): Promise<void> |
| T03 | SettingsService.apply(patch: OwnerSettingsPatch, expectedActiveVersion: number): Promise<ApplyResult>; current(): SettingsSnapshot. AccountRegistry.activate(accountRef: string): Promise<void>; contexts(): AccountContext[] |
| T04 | BybitMarketHub.configure(symbols: string[]): Promise<void>; snapshot(symbol: string): MarketFrame; onFrame(listener: (frame: MarketFrame) => void): () => void; stop(): Promise<void> |
| T05 | computeIntelligence(frame: MarketFrame): IntelligenceFrame; quantize(value: DecimalString, step: DecimalString, mode: 'floor' | 'ceil'): DecimalString in execution/decimal.ts |
| T06 | ResearchHost.run(call: ToolCall, context: ToolContext): Promise<ToolResult>; research(query: ResearchQuery): Promise<ResearchFinding[]> |
| T07 | RoleRunner.run(task: RoleTask, signal: AbortSignal): Promise<RoleResult>; JevClient.review(input: EvidenceReviewRequest): Promise<JevReview> |
| T08 | CycleRunner.run(symbol: string, reason: CycleReason): Promise<CycleResult>; revalidateEntry(thesis: TradeThesis, frame: MarketFrame, intelligence: IntelligenceFrame, quote: VenueQuote): EntryValidation; evaluateExits(input: ExitInput): VerifiedExit[] |
| T09 | ExecutionGateway.submit(intent: TradeIntent): Promise<ExecutionReceipt>; close(positionRef: string, cause: ExitCause): Promise<ExecutionReceipt>; halt(request: HaltRequest): Promise<HaltReceipt>; reconcile(accountRef: string): Promise<Reconciliation> |
| T10-T11 | VenueAdapter implemented per venue with permissions, accountIdentity, balance, instruments, quote, positions, submit, lookupOrder, cancelEntry, protection, protect, close, financialHistory; exact types defined T10 |
| T15-T17 | parseBridgeEvent(value: unknown): BridgeEvent; verifyCallback(raw: Buffer, headers: CallbackHeaders): Promise<VerifiedPeerEvent>; GrokBridge.enqueue(event: BridgeEvent): Promise<BridgeReceipt>; ingest(event: VerifiedPeerEvent): Promise<BridgeReceipt>; proposeOwnerCommand(request: OwnerCommandProposal): Promise<CommandProposalReceipt> |

StoreTransaction contains execute(sql: string, args: SqlValue[]): Promise<QueryResult> and append(event: DomainEvent): Promise<number>; SqlValue is string|number|bigint|null|Uint8Array; QueryResult has rows: Array<Record<string,SqlValue>> and rowsAffected: number. Never pass a transaction to network/provider code. Exact domain schemas are defined with Zod by their owning task, with inferred exported TS types; avoid hand-maintained parallel API types.

## T00: Freeze baseline dan reconcile conflicting requirements

**Files:** Create scripts/rebirth-contracts.mjs, docs/rebirth/baseline.json, docs/rebirth/ui-contract.md, docs/rebirth/decisions.md, tests/rebirth/baseline.test.ts. Read server/app.ts, setup/routes.ts, channels/routes.ts, research/routes.ts, session-log-routes.ts, bin/mpu.mjs, cli/session-entry.ts, web/src/**, .env.example and public assets. Do not read Owner .env.

**Consumes:** Current SHA and nine hashed source files. **Produces:** ContractManifest with screen/component/control/HTTP method+path/request+response/auth/error/event/storage/hot-apply/browser-test mapping; CLI commands, dependency/asset hashes; accepted D09/D11 and declared external unknowns.

- [ ] **Step 1:** Add failing test baseline.test.ts named discovers_every_declared_control_and_route. Assert manifest includes all 29 current TSX components, CodexResearchSetup, lessons, updater, Trakteer, history/cancel, research/backtest, eight venues, all CLI help commands and six role IDs. Assert each actionable control has a named behavior test, not only a path.
- [ ] **Step 2:** Run npx vitest run tests/rebirth/baseline.test.ts. Expected FAIL for missing manifest.
- [ ] **Step 3:** Implement collectContracts(root: string): ContractManifest in the script using existing TypeScript AST APIs and static references. Record current route declarations, runtime-mounted versus standalone routes separately. Capture baseline screenshots/interactions only on isolated PAPER fixture host. Record accepted D09 and the remaining source decisions in decisions.md; no policy value edits.
- [ ] **Step 4:** Re-run test. Expected PASS; every preserved field has a target owner and error behavior. Review mapping with actual consumer code, not generated regex output alone.
- [ ] **Step 5:** Checkpoint: git add only the five task files and approved baseline captures; git commit -m "docs: freeze Trading Agent Mpu Gandring replacement contracts".

## T01: Fresh startup, shared wire contract dan import boundary

**Files:** Create shared/office.ts, server/v2/{contracts,runtime,app,office}.ts, server/v2/api/state.ts, tsconfig.rebirth.json, scripts/check-runtime-boundary.mjs, tests/rebirth/runtime-isolation.test.ts. Modify server/index.ts, package.json, web/src/types.ts only for agreed shared DTO wiring in the isolated branch.

**Consumes:** T00 manifest. **Produces:** OfficeRuntime interface above; createReplacementApp; new entry composition with unavailable state until services are configured. Compilation output for the isolated new build is dist-rebirth/server/index.js with matching CLI layout under dist-rebirth/cli/.

- [ ] **Step 1:** Write runtime-isolation tests with these assertions:

~~~ts
expect(importClosure).not.toContain('server/desk.ts');
expect(importClosure).not.toContain('server/app.ts');
expect(importClosure.some(p => p.includes('providers/mock'))).toBe(false);
expect(state.lastVerdict).toBeNull();
expect(unavailableFinancialField).toEqual({ value: null, availability: 'UNAVAILABLE' });
~~~

- [ ] **Step 2:** Run npx vitest run tests/rebirth/runtime-isolation.test.ts; expect missing runtime/boundary FAIL.
- [ ] **Step 3:** Implement fresh local app/state/office envelope, shared DTO ownership and dedicated build script build:rebirth. Port audited neutral diagnostics explicitly. Do not mount old app/routes to obtain compatibility. Missing services return typed unavailable; never fake fills or six-agent replies.
- [ ] **Step 4:** Run focused test, npm run typecheck and npm run build:rebirth; expect PASS, emitted/runtime import closure contains only allowlisted fresh/neutral modules. Installed dist remains untouched at this phase.
- [ ] **Step 5:** Checkpoint commit feat: bootstrap isolated replacement runtime.

## T02: Durable store, schema dan crash recovery

**Files:** Create server/v2/store/{database,schema,events}.ts, tests/rebirth/store.test.ts. Modify package.json/package-lock.json only for proposed @libsql/client 0.18.0 and build/test requirements.

**Consumes:** T01 domain IDs, DomainEvent {eventId,scope,kind,createdAt,correlationId,causationId,schemaVersion,payload}; SqlValue/StoreTransaction described above. **Produces:** RuntimeStore and tables/constraints in architecture section 5, QueryResult, deterministic migration version.

- [ ] **Step 1:** Write tests transaction_rollback_preserves_projection, duplicate_event_returns_original_seq, torn_apply_recovers, disk_write_failure_is_visible, native_driver_opens_offline_on_supported_node. Assertions: rejected transaction changes neither event nor projection; duplicate same event returns same seq; changed payload under same ID is rejected; no private network call occurs on file: URL; reopen preserves committed data.
- [ ] **Step 2:** Run npx vitest run tests/rebirth/store.test.ts; expect FAIL before implementation. Independently verify install/open/transaction/reopen on Node 20/22/24 and Windows CI; package OS metadata alone is not compatibility proof.
- [ ] **Step 3:** Implement RuntimeStore with prepared parameterized statements, foreign keys, transactional unique keys and proven durability pragmas. Keep ledger under private .mpu-gandring/rebirth path. No generic repository framework. Store event+projection in same transaction; no network inside transaction.
- [ ] **Step 4:** Re-run store tests and typecheck. Expected PASS including kill-before-commit/reopen child-process scenario and two local writers contending for the same intent ID. If driver fails supported platform, stop at this dependency gate and revise storage choice before dependent work.
- [ ] **Step 5:** Checkpoint commit feat: persist replacement runtime state transactionally.

## T03: Versioned settings, secrets dan account lifecycle registry

**Files:** Create server/v2/settings/{schema,service,secrets}.ts, server/v2/accounts/{registry,authority}.ts, server/v2/api/setup.ts, tests/rebirth/settings.test.ts, tests/rebirth/accounts.test.ts.

**Consumes:** Store and full T00 field schema. **Produces:** OwnerSettings/OwnerSettingsPatch as inferred Zod types; SettingsSnapshot {savedVersion,activeVersion,effective,appliedAt}; ApplyResult {savedVersion,activeVersion,applyStatus:'applied'|'failed'|'conflict',appliedAt:number|null,reason:string|null,subsystems}; AccountContext {scope:AccountScope,lifecycle:'ACTIVE'|'DRAINING',pendingIntentIds:string[],positionRefs:string[]}; authority epoch per account.

- [ ] **Step 1:** Write tests with exact assertions:

~~~ts
expect(after.effective.trading).toEqual(before.effective.trading); // migration import
expect(failed.activeVersion).toBe(before.activeVersion);
expect(conflict.applyStatus).toBe('conflict');
expect(activeAccount).toBe('account-new');
expect(monitoredAccounts).toEqual(expect.arrayContaining(['account-old', 'account-new']));
expect(profile.safetyNet).toBe(savedBase.safetyNet); // preset resolution
~~~

Add N=0 rejection, existing valid N 1..4 round trips, key rotation same native identity, different accounts same venue, settings change while intent queued, failure after DB active commit before publish, and remote ack arriving for an older version.

- [ ] **Step 2:** Run npx vitest run tests/rebirth/settings.test.ts tests/rebirth/accounts.test.ts; expect FAIL.
- [ ] **Step 3:** Implement prepare/activate/recover coordinator exactly as architecture section 6. Import Owner settings without replacing account fields; secrets use references and established masked local flow. Local success only after active publication; remote projection separate. No duplicate schedules/subscriptions. Retain DRAINING account contexts until lifecycle terminal; do not detach old venue at switch.
- [ ] **Step 4:** Re-run focused tests and typecheck. Expected PASS; validate every field group from T00, provider selection next task, no secrets in state/events/errors, no .env mutation outside temporary fixtures.
- [ ] **Step 5:** Checkpoint commit feat: apply Owner settings and preserve account lifecycle.

## T04: Bybit linear realtime hub

**Files:** Create server/v2/market/{bybit,candles,orderbook,instruments}.ts, tests/rebirth/bybit.test.ts, tests/rebirth/fixtures/bybit/*.

**Consumes:** Account/watchlist requirements from settings; MarketFrame/Candle/Evidence. **Produces:** BybitMarketHub, native instrument reference mappings and source cursors. Default replay fixtures have no network.

- [ ] **Step 1:** Write fixture tests bootstrap_merges_ws_without_duplicate_volume, confirmed_candles_only, reset_book_on_snapshot, accepts_nonconsecutive_valid_update_ids, ticker_delta_preserves_fields, reconnect_backfills_gap, watchlist_does_not_drop_open_position. Assertions: TF keys exactly 1m/5m/15m/1h/4h/1d; core analysis TF exactly 1m/5m/1h/4h/1d; confirm=false excluded from closed; duplicate trade ID counted once; category linear on every market request; no Binance/spot/sample fallback request.
- [ ] **Step 2:** Run npx vitest run tests/rebirth/bybit.test.ts; expect FAIL.
- [ ] **Step 3:** Implement BybitMarketHub using existing ws and native fetch: buffer during bootstrap, chronological seed, snapshot/delta, ping/reconnect/backfill, per-feed timestamps/units, bounded buffers and subscription reconciliation. Missing Bybit instrument is explicit unavailable, never silently substituted.
- [ ] **Step 4:** Re-run focused tests/typecheck. Expected PASS. An optional public-feed smoke probe is separate evidence and must not be needed by deterministic tests or invoke private exchange APIs.
- [ ] **Step 5:** Checkpoint commit feat: stream canonical Bybit evidence.

## T05: Deterministic indicators dan exact numeric boundaries

**Files:** Create server/v2/market/{indicators,intelligence}.ts, server/v2/execution/decimal.ts, tests/rebirth/indicators.test.ts, tests/rebirth/decimal.test.ts.

**Consumes:** MarketFrame/Candle with units/finality. **Produces:** IntelligenceFrame {evidenceId,marketRevision,byTimeframe,microstructure,opposingFacts,formulaVersion}; quantize signature above; TimeframeFeatures with nullable indicator fields and input refs.

- [ ] **Step 1:** Write independently computed fixture assertions: SMA20, seeded EMA9/21/50/200, Wilder RSI14/ATR14, MACD12/26/9, population-SD Bollinger20, UTC-session VWAP and labelled candle approximation; first valid pivot only after right-side bars close. Assert insufficient warmup -> null/reason; incomplete flow never broad-market VERIFIED. Decimal assertion: quantize('0.000000019','0.00000001','floor') === '0.00000001'; floor quantity never rounds up.
- [ ] **Step 2:** Run npx vitest run tests/rebirth/indicators.test.ts tests/rebirth/decimal.test.ts; expect FAIL.
- [ ] **Step 3:** Implement pure formulas from architecture section 7 and BigInt decimal quantization. Cover HH/HL/LH/LL, confirmed break/retest/divergence, volatility expansion/compression, spread/liquidity gaps and taker/book scope. Do not turn calculated features into automatic policy gates.
- [ ] **Step 4:** Re-run tests/typecheck. Expected PASS; fixture with bullish 4h and reversing 1m preserves both facts rather than forcing one stance. Unit/multiplier mismatch is rejected before cross-venue comparison.
- [ ] **Step 5:** Checkpoint commit feat: compute traceable market intelligence.

## T06: Real research worker dan bounded host tools

**Files:** Create server/v2/research/{host,browser-worker,provenance}.ts, server/v2/api/research.ts, tests/rebirth/research.test.ts, tests/rebirth/tool-security.test.ts. Port existing research MCP contract into cli/v2/research-mcp.ts without importing old collectors.

**Consumes:** Canonical market/account read ports and configured optional sources. **Produces:** ResearchHost; ResearchFinding {id,claim,url,publisher,publishedAt,eventAt,observedAt,metricWindow,certainty,availability,freshness,excerptHash}; ToolCall {name,args}; ToolContext {role,cycleId,accountRef,evidenceId}; ToolResult {status:'ok'|'unavailable'|'error',data:unknown,sourceRefs:string[],traceId:string,error:string|null}.

- [ ] **Step 1:** Write tests actual_navigation_and_extraction, new_article_old_event, no_date_stays_unknown, repeated_story_not_upgraded, optional_provider_missing_not_veto, malicious_page_is_data. Assert a real local fixture navigation/click happened, original URL+event time survive, blocked source unavailable, and read_portfolio never calls order adapter.
- [ ] **Step 2:** Run research/security tests; expect FAIL. Add SSRF cases localhost/IPv6-mapped/private IP, DNS change, redirect to metadata, browser subrequest, credential-bearing URL, and page text asking to read .env. Assert each blocked before network access.
- [ ] **Step 3:** Implement ResearchHost with native fetch where sufficient and existing playwright-core worker where DOM required. Configure browser executable explicitly, isolate contexts/workdir/env, apply source/URL policy and dated provenance. Preserve CryptoPanic/Whale Alert/CMC controls as enrichment only. No second research broker or provider credential inheritance.
- [ ] **Step 4:** Re-run tests/typecheck. Expected PASS, worker crash/restart does not stop Bybit or CLOSE. Test page fixtures and host tool traces are sufficient for deterministic acceptance; external sites may remain unavailable honestly.
- [ ] **Step 5:** Checkpoint commit feat: host sourced research tools securely.

## T07: Provider adapters, six role tasks dan Jev

**Files:** Create server/v2/agents/{providers,local,roles,runner,jev}.ts, tests/rebirth/roles.test.ts, tests/rebirth/provider-tools.test.ts, tests/rebirth/jev.test.ts. Port role persona text into the existing identity-preserving structure chosen by T00.

**Consumes:** SettingsSnapshot, ResearchHost, MarketFrame/IntelligenceFrame, account reads. **Produces:** RoleTask {cycleId,role,phase:'observe'|'challenge'|'final',taskAttempt,evidenceId,configVersion,accountRef,route:'LOCAL'|'GROK'|'MIRROR_READ_ONLY',deadlineAt}; RoleResult {task identity,status:'completed'|'unavailable'|'cancelled',stance,claimRefs,contraryRefs,reasoning,confidence,provider,model,toolTraceIds}; risk variant also has decision APPROVE/REJECT; JevReview {status,reviewId,claimRefs,contraryRefs,reason} with no permission fields.

ConfidenceReading is {value:number|null,scale:'probability_0_1'|'ordinal_1_5'|'score_0_100',source:string}; RoleResult.confidence has that type. Only Lead-reported probability_0_1 satisfies an Owner probability threshold. Grok analyst confidence and TS score keep their original scales, not invented percentages.

- [ ] **Step 1:** Write tests exactly_six_roles, all_roles_can_use_applicable_host_tools, model_change_applies_next_task, cancellation_discards_late_result, no_key_is_unavailable_not_mock, jev_off_does_not_remove_role. Assert role IDs count=6, one current attempt per role/phase, actual provider/model recorded, Jev never counted as seventh role.
- [ ] **Step 2:** Run focused tests; expect FAIL. Include invalid JSON/empty output/quota/timeout, formatting repair that preserves claims, real tool continuation, and missing CLI sandbox capability. Add ordinal_confidence_is_not_probability: a Grok TM value 5/5 does not become Lead 100% or historical win rate. Assert no silent model or evidence substitution.
- [ ] **Step 3:** Implement official remote-provider adapters and verified local CLI transports for the providers/CLIs inventoried T00. Keep login/discovery/reasoning/timeout/cancel behavior. Host executes tools; CLI-native web access is not assumed. Explicitly expose UNSANDBOXED capability and require proven isolation before autonomous arbitrary-shell use. Preserve returned Jev result through downstream calls rather than passing null placeholders.
- [ ] **Step 4:** Re-run tests/typecheck. Expected PASS, including no network when Jev disabled and no secrets in model context/logs/child env. Provider account or live quota tests remain separately authorized.
- [ ] **Step 5:** Checkpoint commit feat: run six evidence-grounded roles and optional Jev.

## T08: Debate, current thesis revalidation dan independent CLOSE

**Files:** Create server/v2/decision/{cycle,revalidate,exits}.ts, tests/rebirth/debate.test.ts, tests/rebirth/reversal.test.ts, tests/rebirth/exits.test.ts.

**Consumes:** RoleRunner, snapshot services and Owner policy. **Produces:** TradeThesis {id,cycleId,accountRef,symbol,side,evidenceId,configVersion,claims,invalidation}; CycleResult {status,verdict,roleResults,jevReviewId}; EntryValidation {status:'valid'|'invalidated'|'unavailable',reason,evidenceRefs}; VerifiedExit {trigger,positionRef,evidenceRefs,observedAt}; CycleReason 'owner'|'schedule'|'market-event'|'position-event'.

- [ ] **Step 1:** Write assertions for reversal_after_ai_approval and reversal_after_lock_wait: approved LONG with a subsequently verified thesis invalidation -> invalidated, equivalent SHORT case; unchanged thesis plus optional unavailable research -> no automatic rejection; no aiApproved bypass field is accepted.
- [ ] **Step 2:** Run npx vitest run tests/rebirth/debate.test.ts tests/rebirth/reversal.test.ts tests/rebirth/exits.test.ts; expect FAIL. Add one case per nine named exit trigger; low entry confidence, all slots occupied, no free margin, Jev down and browser down must not block an applicable verified CLOSE. Duration alone produces no autonomous exit.
- [ ] **Step 3:** Implement actual observe/challenge/risk/execution/lead sequence with all available role results visible. Keep policy/config version and immutable evidence binding. Separate missing authoritative decision from optional data outage. Evaluate thesis predicates, not copied legacy global momentum/price thresholds. Explicit Owner close uses its authorization path.
- [ ] **Step 4:** Re-run tests/typecheck. Expected PASS: no fabricated role, no double vote, no extra 2/3 gate unless selected, no fake HOLD success on provider failure; incomplete decision has explicit status.
- [ ] **Step 5:** Checkpoint commit feat: deliberate and revalidate independent entry and exit intents.

## T09: Single execution gateway, durable intent dan protection

**Files:** Create server/v2/execution/{gateway,protection,reconcile}.ts, tests/rebirth/gateway.test.ts, tests/rebirth/protection.test.ts, tests/rebirth/authority.test.ts. Use fake venue transport here, not real credentials.

**Consumes:** Stable AccountScope/authority epoch, settings, thesis/exit, decimal, store. **Produces:** TradeIntent {intentId,accountRef,configVersion,authorityEpoch,action,symbol,side,quantity,entry,stop,tp,leverage,thesisId}; ExecutionReceipt {intentId,clientOrderId,orderState,filledQty,protectionState,certainty,reason}; HaltRequest {requestId,source,policy:'HALT_ONLY'|'HALT_AND_FLATTEN'}; HaltReceipt {halted,persisted,entryCancellation,flatten,reason}; Reconciliation {accountRef,positions,pending,protection,financial,unknowns}.

- [ ] **Step 1:** Write assertions:

~~~ts
expect(nativeSubmissionsForSameIntent).toBe(1);
expect(timeoutReceipt.orderState).toBe('UNKNOWN');
expect(timeoutReceipt.filledQty).toBeNull();
expect(confirmedStop.coveredQty).toBe(currentNativeExposure);
expect(ownerCloseBlockedByEntryConfidence).toBe(false);
expect(callbackTradeStatusNativeWrites).toBe(0);
~~~

Also test wrong account epoch, concurrent same account entries, unique pending occupancy, partial fill during cancel, stop lookup outage, disk full before submit, restart after venue accept, daily-loss latch retention and halted dispatch racing an entry.

- [ ] **Step 2:** Run gateway/protection/authority tests; expect FAIL.
- [ ] **Step 3:** Implement one account-scoped writer with journal-before-send, stable native client ID, under-lock fresh reads and revalidation, native reconciliation, quantity-correct protection and emergency behavior. Halt latch is immediate before asynchronous effects. No risk/sizing reductions beyond active Owner/official rules. Never hold SQL transaction over exchange IO.
- [ ] **Step 4:** Re-run tests/typecheck; expect PASS including dual-process store contention and replay with native submit disabled. Prove local lease only fences participating writers; expose external credential conflict rather than claiming global exclusivity.
- [ ] **Step 5:** Checkpoint commit feat: execute durable protected account-scoped intents.

## T10: Adapter conformance contract dan delegated wallet service

**Files:** Create server/v2/execution/adapters/types.ts, server/v2/wallet.ts, tests/rebirth/adapter-contract.test.ts, tests/rebirth/wallet.test.ts, tests/rebirth/fixtures/venues/*.json.

**Consumes:** Domain/money/protection types and existing wallet UX. **Produces:** VenueAdapter interface and reusable conformance fixture runner. Methods are all Promise-returning: permissions(): PermissionEvidence; accountIdentity(): NativeAccountIdentity; balance(): NativeBalance; instruments(symbol: string): NativeRules; quote(symbol: string): VenueQuote; positions(): NativePosition[]; submit(intent: NativeOrder): NativeOrderReceipt; lookupOrder(symbol: string, clientOrderId: string): NativeOrderReceipt; cancelEntry(symbol: string, clientOrderId: string): NativeOrderReceipt; protection(position: NativePosition): ProtectionEvidence; protect(position: NativePosition, protection: NativeProtection): ProtectionEvidence; close(position: NativePosition, clientOrderId: string): NativeOrderReceipt; financialHistory(cursor: string|null): FinancialPage. TS declarations wrap each listed return type in Promise. WalletService.start(venue: 'aster'|'hyperliquid'): Promise<ApprovalChallenge>; approve(challengeId: string, signature: string): Promise<WalletResult>.

- [ ] **Step 1:** Write conformance tests for canTrade=true/canWithdraw=false verified, unknown permissions refusal for LIVE, delegated-only signer, symbol multiplier/units, one-way and hedge IDs, explicit native stop coverage, quote age, native rounding/min-notional, missing support, no key in response, wallet challenge expiry/replay/wrong chain/wrong owner.
- [ ] **Step 2:** Run adapter-contract/wallet tests; expect FAIL.
- [ ] **Step 3:** Define inferred schemas for NativeAccountIdentity, NativeBalance, NativeRules, NativeOrder, NativeOrderReceipt, NativePosition, NativeProtection, ProtectionEvidence and FinancialPage using architecture sections 4/10. Implement challenge/approve with existing audited signing SDKs. Raw signing secret remains server-side and is never an arbitrary wallet-signing tool.
- [ ] **Step 4:** Re-run tests/typecheck; expect PASS with fixtures. NativeRules includes tick, lot, min/max/notional, contract multiplier, settlement currency and position-mode capability. Adapter cannot pretend to support exchangeStops or LIMIT_GTC it cannot verify.
- [ ] **Step 5:** Checkpoint commit feat: define native venue and delegated wallet contracts.

## T11a-T11h: Port each visible venue as an independent deliverable

Each row below is a separate task with its own red/green/review/commit. Do not combine five unsupported venues into one unchecked task. **Consumes:** T10 exact VenueAdapter contract. **Produces:** createVenueAdapter(options: AdapterOptions): VenueAdapter in the row's file; AdapterOptions {network:'testnet'|'mainnet',credentialRef:string,fetchImpl:typeof fetch,readSecret:(ref:string)=>Promise<DelegatedCredentials>}. No strategy or Owner policy in adapters.

| Task | Create | Test | Existing baseline to inspect |
|---|---|---|---|
| T11a | server/v2/execution/adapters/bybit.ts | tests/rebirth/venue-bybit.test.ts | server/exchange/bybit.ts |
| T11b | server/v2/execution/adapters/aster.ts | tests/rebirth/venue-aster.test.ts | server/exchange/aster.ts, live/executor.ts LIMIT_GTC |
| T11c | server/v2/execution/adapters/hyperliquid.ts | tests/rebirth/venue-hyperliquid.test.ts | server/exchange/hyperliquid.ts |
| T11d | server/v2/execution/adapters/binance.ts | tests/rebirth/venue-binance.test.ts | server/exchange/binance.ts |
| T11e | server/v2/execution/adapters/okx.ts | tests/rebirth/venue-okx.test.ts | server/exchange/okx.ts |
| T11f | server/v2/execution/adapters/dydx.ts | tests/rebirth/venue-dydx.test.ts | server/exchange/dydx.ts |
| T11g | server/v2/execution/adapters/paradex.ts | tests/rebirth/venue-paradex.test.ts | server/exchange/paradex.ts |
| T11h | server/v2/execution/adapters/orderly.ts | tests/rebirth/venue-orderly.test.ts | server/exchange/orderly.ts |

- [ ] **Step 1, for each row:** Write its conformance tests against captured/redacted protocol fixtures with assertions: submit acknowledgement alone is not FILLED; zero/missing stop readback is not VERIFIED; partial exposure has matched coverage; wrong hedge leg is rejected; missing fees/funding/PnL remain null; native accepted+timeout lookup produces one order, not resend. Add venue-specific signature test vectors. Aster also covers LIMIT_GTC opt-in, price rounding, expiration/cancel/additional-fill/repair.
- [ ] **Step 2, for each row:** Run npx vitest run tests/rebirth/venue-<venue>.test.ts. Expected FAIL for missing adapter or contract behavior. Inspect current official API docs for exact network/signature/permission/stop semantics; source snapshot is not proof of current external behavior.
- [ ] **Step 3, for each row:** Implement createVenueAdapter in that row. Port audited transport/signing logic without importing old strategy/runtime; preserve existing SDKs and experimental labels. Use exact contract IDs, account permissions, reduce-only/protection and order lookup. Unsupported feature returns explicit capability failure.
- [ ] **Step 4, for each row:** Re-run row test plus adapter-contract tests/typecheck. Expected PASS. No live/testnet order here; native read-only and roundtrip acceptance are separately recorded at T18 with authorization. Do not call fixture pass “venue verified”.
- [ ] **Step 5, for each row:** Checkpoint commit feat: support <venue> in replacement execution gateway.

## T12: PAPER, backtest dan learning without live contamination

**Files:** Create server/v2/sandbox/{paper,backtest}.ts, server/v2/learning.ts, tests/rebirth/sandbox.test.ts, tests/rebirth/learning.test.ts.

**Consumes:** MarketFrame, exact accounting primitives, immutable evidence and scoped store. **Produces:** PaperVenue satisfying safe simulated adapter subset with mode PAPER; runBacktest(input: BacktestInput): Promise<BacktestResult>; LearningService.add(input: ScopedLesson): Promise<Lesson>; recent(accountRef: string, limit: number): Promise<Lesson[]>.

- [ ] **Step 1:** Write tests paper_never_loads_signer, backtest_never_imports_live_gateway, legacy_lesson_not_used_as_new_evidence, lesson_cannot_mutate_settings, account_scoped_memory, partial_trade_pnl_not_fabricated. Assert simulated receipts have explicit simulation status, point-in-time feed excludes future bars, fees/funding definitions preserved, and unknown historical edge remains no data.
- [ ] **Step 2:** Run sandbox/learning tests; expect FAIL.
- [ ] **Step 3:** Implement isolated simulation and fresh account-scoped advice. Preserve existing backtest/lessons CLI/API contract and proaktif/reflection on/off settings. New lessons are advice, never order or setting authorization. Keep old records in read-only archive without preloading into new prompts.
- [ ] **Step 4:** Re-run tests/typecheck; expect PASS. Dependency audit proves LIVE/TESTNET decision entry cannot reach synthetic feed/mock provider; sandbox has no signing credential port.
- [ ] **Step 5:** Checkpoint commit feat: preserve isolated simulation and scoped learning.

## T13: UI/API parity, conversation history, chart stream dan reports

**Files:** Create server/v2/api/{operations,chat,history}.ts, server/v2/reports.ts, tests/rebirth/api-parity.test.ts, tests/rebirth/office-browser.test.ts. Complete api/state.ts, setup.ts, research.ts, office.ts; modify existing web files only where T00 mapping requires new wiring/status/null handling.

**Consumes:** All local services and T00 contract manifest. **Produces:** Complete OfficeRuntime dispatch/snapshot, HTTP contracts and existing WS events; additive candle/config/integration events with streamEpoch/sequence; immutable reports and downloadable session logs.

- [ ] **Step 1:** Write route tests from each manifest item for success/auth/invalid input/unavailable/version conflict/cancel. Browser assertions: all menus remain, six identities preserved, chart symbol+TF stays selected, old late chart result ignored, reconnect gap resync, saved/active/remote-ack distinct, unsupported numeric value is not shown as success, no unknown balance formatted as 0.
- [ ] **Step 2:** Run api-parity and office-browser tests; expect FAIL for missing routes/events. Browser test uses playwright-core against isolated app with deterministic services, not source-string assertions.
- [ ] **Step 3:** Implement thin compatibility handlers and WS reducers. Preserve conversations/new, request IDs, private history/delete/cancel, operational session context, command provenance, reports/verdicts/trade logs and all Setup fields. Lightweight Charts consumes same canonical candles; TV widget stays separate. Do not silently grant Owner scope to /api/agent-event or /api/gb callers.
- [ ] **Step 4:** Re-run tests/typecheck/build:rebirth; expect PASS across desktop/mobile, day/night, English/Indonesian, reduced motion, focus/keyboard and async dismissal. Compare screenshot and functional results to baseline. Existing support/update behavior is completed T14, not silently dropped.
- [ ] **Step 5:** Checkpoint commit feat: preserve Office interactions on replacement runtime.

## T14: Channels, complete CLI, managed launcher dan auxiliary surfaces

**Files:** Create server/v2/channels.ts, cli/v2/{main,client,setup,doctor,research-mcp}.ts, tests/rebirth/channels.test.ts, tests/rebirth/cli.test.ts, tests/rebirth/launcher.test.ts. Adapt bin/mpu.mjs, cli/session-entry.ts, service/autostart routing, update/support/logging endpoints and package scripts as specified T00. No running service mutation.

**Consumes:** Local APIs/authorization, snapshots, report projections, existing channel/launcher contracts. **Produces:** command handlers for every T00 CLI verb; local-only setup/mode/key flows; channel-specific verified Owner identity distinct from model proposals; isolated build root resolution.

- [ ] **Step 1:** Write tests every_help_command_dispatches, compiled_launch_root_resolves, autostart_uses_same_root, local_mode_flow_requires_typed_live_confirmation, unkill_does_not_enable_auto, allowlisted_owner_command_matches_current_message, no_real_notification_from_fixture. Assert exact compiled executable under dist-rebirth/server/index.js at this phase, child working directory correct, exit/signal attribution preserved, all four channel adapters usable through fake providers.
- [ ] **Step 2:** Run CLI/channels/launcher tests; expect FAIL. Process launch tests use stub child processes and temporary env/data; never install scheduled tasks or send messages.
- [ ] **Step 3:** Port all mpu/gb commands, benchmark/version/status/market/candles/research/backtest/lessons, setup/doctor and managed launcher. Preserve old external API capability with explicit credential scopes; bot credential cannot impersonate Owner. Implement support/update/tour/log surfaces against fresh services, not legacy createApp.
- [ ] **Step 4:** Re-run tests/typecheck/build:rebirth; expect PASS. Invoke packaged --help/status against temporary fixture host, exercise updater paths with local fixture archive, validate Windows hidden background launch without actual autostart install.
- [ ] **Step 5:** Checkpoint commit feat: preserve channel and command-line operations.

## T15: Typed Grok protocol, raw-body auth dan independent identity scopes

**Files:** Create server/v2/connectors/grok/{protocol,auth}.ts, tests/rebirth/grok-protocol.test.ts, tests/rebirth/grok-auth.test.ts. Generate docs/rebirth/grok-event-v2.schema.json from Zod contract, not a second hand-edited schema.

**Consumes:** RoleTask/common evidence, account/config IDs, private secret references. **Produces:** BridgeEvent discriminated union mpu.grok.v2; VerifiedPeerEvent {principal:{peerId,keyId,scopes},event:BridgeEvent,bodyDigest}; CallbackHeaders with key/timestamp/nonce/signature; parseBridgeEvent/verifyCallback signatures above.

- [ ] **Step 1:** Write assertions: owner.command.request missing independent grant fails authorization even when HMAC valid; role result missing cycle/role/phase/attempt/evidence/config/account fails schema; PENDING cannot become evidence certainty; unsupported v1 is rejected with version error; remote external-venue price cannot enter canonical market.
- [ ] **Step 2:** Run protocol/auth tests; expect FAIL. Add tampered raw JSON whitespace/body, wrong path/method, expired timestamp (>300s), nonce replay, same event changed digest, revoked key, unknown role, 128KiB overflow, task expiry, shared-peer role attribution and signature rotation.
- [ ] **Step 3:** Implement strict kind schemas and HMAC over method/path/timestamp/nonce/body SHA256, constant-time check, nonce/digest persistence. Peer scopes originate server-side. No trust in actorRole=owner. All event families from source envelope must have a typed schema; strip/reject secrets before durable recording.
- [ ] **Step 4:** Re-run focused tests/typecheck; expect PASS. Round-trip generated JSON schema with runtime validators against accepted/rejected fixtures. No real webhook or callback installation.
- [ ] **Step 5:** Checkpoint commit feat: authenticate typed Grok evidence events.

## T16: Durable async bridge, role routing dan truthful remote delivery

**Files:** Create server/v2/connectors/grok/bridge.ts, server/v2/api/grok.ts, tests/rebirth/grok-bridge.test.ts, tests/rebirth/grok-role-routing.test.ts.

**Consumes:** Store, protocol/auth, role task registry, local settings snapshots. **Produces:** GrokBridge with enqueue/ingest above and status(): GrokIntegrationStatus; {desiredMode,observedHealth,lastAcceptedAt,lastCallbackAt,lastAcknowledgedConfigVersion,pendingEvents,lastError}; BridgeReceipt {eventId,status:'QUEUED'|'ACCEPTED_BY_WEBHOOK'|'REMOTE_PENDING'|'REMOTE_COMPLETED'|'REJECTED'|'EXPIRED',reason}.

- [ ] **Step 1:** Write tests webhook_200_without_callback_stays_pending, crash_after_inbox_before_apply_replays_once, duplicate_event_gets_original_receipt, stale_role_attempt_not_counted, mirror_loop_suppressed, config_ack_monotonic, failed_remote_does_not_revert_local_apply. Assert native order writes=0 for all bridge ingest paths.
- [ ] **Step 2:** Run focused tests; expect FAIL. Include accepted outbound timeout/duplicate retry, bounded backoff without replaying stale intent, rate limit, missing reverse network, local role fallback only when preselected, and group delivery claimed versus observed separately.
- [ ] **Step 3:** Implement inbox/outbox transactional dispatch and separate ingress listener with only events callback. /pair and /status remain local-only. Office stays loopback in LIVE. Coalesce substantive events, never send one webhook per tick. Project settings/positions/reports into namespaced Grok files conceptually; no actual remote write in this task.
- [ ] **Step 4:** Re-run tests/typecheck; expect PASS. Crash/restart yields one accepted current role completion. OUTBOUND_ONLY/DEGRADED clearly shown; market feed and local exit/protection tests stay green with bridge unavailable.
- [ ] **Step 5:** Checkpoint commit feat: synchronize Grok results asynchronously.

## T17: Owner command proposals, execution handover dan STOP consistency

**Files:** Create server/v2/connectors/grok/commands.ts, tests/rebirth/grok-owner.test.ts, tests/rebirth/handover.test.ts, tests/rebirth/stop.test.ts. Extend settings/gateway/authority and existing Setup/Channels UI for explicit integration status and local command review, without a new top-level menu.

**Consumes:** VerifiedPeerEvent, current settings/account authority and accepted D09. **Produces:** OwnerCommandProposal {requestId,command,accountRef,expectedActiveVersion,expiresAt,sourcePeer}; CommandProposalReceipt {proposalId,status:'NEEDS_OWNER_PROOF'|'APPLIED'|'REJECTED',reason}; VerifiedOwnerGrant {grantId,commandDigest,accountRef,expectedActiveVersion,expiresAt,consumedAt}; authorizeHandover(input: HandoverEvidence): Promise<AuthorityResult> requiring native/credential/routine evidence references.

- [ ] **Step 1:** Write tests bot_cannot_promote_itself_to_owner, one_time_grant_bound_to_exact_command, expired_grant_not_reused, group_text_no_mutation, stale_authority_epoch_blocked, external_key_not_revoked_is_conflict. Assert grant for STOP cannot change size/mode, remote unkill/keys/LIVE are refused, and no handover claim before pending native outcomes reconciled.
- [ ] **Step 2:** Run Owner/handover/STOP tests; expect FAIL. For accepted D09 assert remote STOP -> halt ON, Auto OFF, nonprotective orders/entry remainder cancelled, still-open resting SL/TP retained, zero strategy CLOSE calls; existing local Kill -> halt plus explicit flatten behavior. Protection-failure emergency handling is tested separately and remains active. Disconnected remote STOP must report NOT_DELIVERED/NEEDS_OWNER_PROOF, never applied.
- [ ] **Step 3:** Implement local command review/one-use grant and authority handover. Direct HT-DM command execution remains unavailable unless independently verifiable human attestation actually exists and is integrated. Do not substitute bot HMAC for it. Grant confirmation is clear Owner action and cannot be triggered by group/model content.
- [ ] **Step 4:** Re-run focused tests, relevant UI browser tests and typecheck; expect PASS for implemented scopes. Record AC-16 partial if direct remote Owner provenance remains unproved. Add source-workflow tests: all ticket fields preserved; manual approval digest invalid after ticket change; daily summary once on first cycle after 22:00; weekly review once after Sunday 20:00 in Owner timezone including restart/DST; synced file paths cannot overwrite standalone originals; Grok five-minute schedule minimum does not rewrite Mpu cadence. No remote bot prompt/routine edit yet.
- [ ] **Step 5:** Checkpoint commit feat: scope Owner commands and execution authority handover.

## T18: Whole-system verification dan migration rehearsal

**Files:** Create tests/rebirth/system.test.ts, tests/rebirth/migration.test.ts, docs/rebirth/{acceptance-report,migration-runbook,grok-capability-proof}.md, docs/rebirth/verification-manifest.json. Evidence captures stay under approved QA directory without secrets.

**Consumes:** All replacement modules and frozen baseline. **Produces:** AC matrix with status PASS/FAIL/UNVERIFIED, exact SHA, commands/log digests, source/browser/venue evidence classes, migration/rollback rehearsal. No activation occurs here.

- [ ] **Step 1:** Write scenario assertions for bullish/bearish/conflicting trend, reversal during debate/lock, stale article/old event, unavailable optional news/Jev, Bybit disconnect/orderbook reset, CLI/provider failure, account switch with exposure, pending GTC partial fills, unknown stop, disk failure, duplicate callback and authenticated/unauthenticated STOP. Assert no secret in state/events/reports/fixtures/screenshots and no real order from offline replay.
- [ ] **Step 2:** Run system/migration tests RED against deliberately faulted fixtures, then restore correct implementation and require GREEN. Rehearse import from copied temporary legacy journal, preserve original files, run after-submit crash and post-cutover rollback reconciliation. Rollback cannot resurrect already-sent intents from an older DB backup.
- [ ] **Step 3:** Before removing legacy modules, map every existing retained behavior test to its new service/DTO in verification-manifest.json and rebind its imports/fixtures while preserving safety assertions. Expected policy differences, such as removing aiApproved bypass, require explicit replacement assertions and rationale. Then run npm test, npm run typecheck, npm run build:rebirth, import/artifact boundary audit and browser parity. Expected all PASS for deterministic/software acceptance; do not omit existing safety tests or delete failures to pass. Capture measured source-to-UI/decision/tool latency with scope, not fabricated numeric SLA or new strategy gate.
- [ ] **Step 4:** Separately list external proof that requires Boss to provision/authorize: actual inert Grok roundtrip/group receipt; callback TLS/reachability; trusted Owner identity; old writer credential/routine revocation; native account/permission/position/stop readback; authorized testnet lifecycle per supported venue. Do not execute these from fixtures or infer them from HTTP 200. Unknown remains UNVERIFIED and blocks corresponding full acceptance.
- [ ] **Step 5:** Checkpoint commit test: verify replacement lifecycle and migration evidence. Human review gate: code-ready, integration-ready, and activation-ready are distinct outcomes.

## T19: Classified cleanup, final package dan handoff

**Files:** Create docs/rebirth/cleanup-manifest.md. Modify package scripts/build/start paths, tsconfig.server.json, bin/mpu.mjs, CLI service root resolver, .env.example, README.md, docs/grokbot/skills references and CI only according to manifest. Delete proven obsolete legacy engine/runtime/dependency/assets only after replacement parity and review. Never delete Owner private data/journal, .env or referenced assets.

**Consumes:** T18 passing software checks, UI manifest, dependency closure and accepted cleanup list. **Produces:** Clean production entry and packed artifact containing no legacy decision graph, preserved CLI and source-based handoff evidence. Documentation accurately distinguishes completed software from unverified integration.

- [ ] **Step 1:** Extend runtime-isolation and launcher tests to inspect the real packed file list and final compiled paths. Assert no old decision/market/sample/mock modules in emitted production artifact, all referenced UI assets exist, every CLI target resolves, compiled server remains dist/server/server/index.js under the final package layout and service/autostart resolves that same root. Add an installed-package smoke with no source tree fallback.
- [ ] **Step 2:** Run extended tests before cleanup; expect FAIL for legacy inclusion or old launcher paths. Build cleanup manifest with path/classification/replacement/test/retention decision. Obtain review of exact deletion list as part of execution checkpoint; don't issue recursive deletes against computed Windows paths.
- [ ] **Step 3:** Apply only reviewed cleanup; switch final build from the isolated dist-rebirth artifact to the established dist/server layout using the new explicit entry closure. Preserve audit/history as inert retained data; update npm package files allowlist and docs so obsolete source is not shipped via broad server/cli globs. Do not reorganize all image directories without proven need.
- [ ] **Step 4:** Run npm test, npm run typecheck, npm run build, boundary audit, packed-artifact smoke and browser parity again because cleanup changed the artifact. Expected PASS. Record exact SHA and deleted paths; any external unknown remains in acceptance report. No installed runtime restart, order, bot routine update, push or release.
- [ ] **Step 5:** Checkpoint commit refactor: retire legacy runtime after verified parity. Hand Boss architecture/plan/diff/tests/AC evidence and migration runbook. Request separate activation instruction only after concrete evidence is reviewable.

## Acceptance crosswalk

| Original AC | Tasks | Required proof |
|---|---|---|
| AC-01 UI parity | T00,T13,T14,T18,T19 | Full control/route/CLI mapping, screenshots and actual interactions |
| AC-02 no legacy execution | T01,T12,T19 | Entry/import closure, runtime trace, emitted and packed artifact |
| AC-03 market truth | T04,T05 | Finality/orderbook/units/recovery fixtures and separately attributed public-feed proof |
| AC-04 research tools | T06,T07 | Real navigation/fetch/tool trace and dated sources, unavailable handling |
| AC-05 agent quality | T07,T08 | Six role task results, countercase/challenge/reversal fixtures, no fake votes |
| AC-06 Owner risk | T03,T08,T09 | Before/after value equality, explicit gate inventory and current thesis checks |
| AC-07 lifecycle | T09-T11,T18 | Native lookup/fill/stop/recovery behavior, separately authorized venue proof |
| AC-08 hot apply | T03,T13,T14 | Local active versions, prepare failure/crash recovery, actual effect per setting |
| AC-09 honesty | T02,T04-T09,T13 | Null/units/provenance survive storage/API/UI/report |
| AC-10 cleanup | T00,T19 | Classified deletion, asset/reference/pack audit, retained private ledger |
| AC-11 regression | T18,T19 | Full suite/typecheck/build/browser/WS checks tied to exact source |
| AC-12 handoff | T18,T19 | Migration/rollback runbook, source SHA, diff and explicit unknowns |
| AC-13 Grok role integrity | T07,T15,T16 | Unique role/phase/attempt acceptance, aliases, no seventh Jev vote |
| AC-14 round trip | T15,T16,T18 | Actual accepted webhook plus correlated authenticated callback; group delivery separately evidenced |
| AC-15 one executor | T03,T09,T11,T17,T18 | Local fencing plus independent credential ownership/revocation and reconciliation |
| AC-16 settings/STOP | T03,T13,T16-T18 | Local/remote versions, selected STOP semantics, independently proved Owner auth; partial if unavailable |
| AC-17 standalone parity/security | T12,T15-T18 | Ticket/risk/2-of-3/manual approval/report/file-state crosswalk; no leaked secrets or second writer |

Additional acceptance: A18 durable transactions/crash recovery (T02,T03,T09); A19 account/hedge/multiplier isolation (T03-T05,T09-T11); A20 callback trust/network boundary (T06,T15-T17); A21 PAPER/backtest/learning separation (T12); A22 all CLI and compiled artifact roots (T14,T19); A23 SSRF/local-CLI capability honesty (T06,T07); A24 explicit STOP semantics without naked exposure (T09,T17).

## Self-review dan evidence limits

- Spec coverage: every AC-01..17 has owner tasks; previously missing persistence, scoped identity, network ingress, PAPER/backtest/learning, CLI roots, updater/support, and full UI wiring have explicit tasks.
- Step scan: each deliverable has failing behavior checks, minimal implementation boundary, positive check and reviewable checkpoint. Eight adapters are separate deliverables, not a single ambiguous “implement venues” item.
- Type consistency: role IDs and phase/attempt, mpu.grok.v2, accountRef, configVersion, HMAC raw-body input, ApplyResult and execution states are shared contracts. Existing UI values are projections, not second authoritative types.
- Review Focus: five failure classes map to named task tests above; no fixture is promoted into proof of production connectivity.
- Remaining external uncertainties are deliberate acceptance gates with proof requirements, not instructions to invent vendor APIs or default risk values. No implementation task is checked off in this planning session.

## Execution handoff

D09 is accepted through Boss's explicit choice in chat on 31 October 2026. Boss reviews the remaining plan, including D11, before implementation. Recommended method: **subagent-driven**, because venue/protection/bridge tasks require independent review and a mistake can mutate financial exposure. The native method is also available if Boss prefers one implementer with a final independent review. No execution method has been selected and no subagents have been started.

After explicit implementation approval, load the selected execution skill and worktree skill. Keep phase gates and source evidence; do not infer deployment, remote bot changes, or live trading permission from approval to write code.
