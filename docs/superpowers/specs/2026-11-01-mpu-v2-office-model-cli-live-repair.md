# Mpu Gandring V2 Office, Providers, CLI and LIVE Integrity Design

**Date:** 2026-11-01 Asia/Jakarta. **Evidence baseline:** GitHub `aabrur/trading-agent-mpu-gandring`, `main` at `49ba0c15235caecb1d7931e767aa7f6872e2838f`; attached Repomix `trading-agent-mpu-gandring(20261101-023219).xml` with 647 entries. **Status:** design plus isolated initial patch, not production deployment.

## Mission and authority

Deliver one functioning Rebirth V2 trading engine, with accurate authenticated AI/CLI status, genuinely configurable models, reliable six-agent desk discussions and private chat sessions, durable histories, native exchange settlement, and a lean maintained source tree. All owner trading values are owned solely by the Owner. No strategy thresholds, confidence vetoes, cooldowns, N caps, symbol exclusions, or allocation changes may be invented. Preserve official system guards `guard.ts`, exchange-side resting stops, withdraw disabled, kill switch, and single writer. Preserve strategy CLOSE availability as defined by Owner's contract. Treat UNAVAILABLE source evidence as unavailable, not a speculative strategy veto.

## Findings proven in source and limitations

1. `server/v2/api/chat.ts` used in-memory conversations, legacy default `conv-default`, replied with `conversation.id`, while `web/src/useDesk.ts` required `conversationId` and selected `office`. No per-conversation DELETE route. `OfficeDiscussion` could not expose delete. This explains new/delete UI contract failure; root cause requires both API and UI repair, not just a button.
2. `server/v2/api/operations.ts` accepted but discarded `conversationId`. Runtime chat stored role messages without conversation IDs in the displayed room transcript. `@all` was not a true six-role room broadcast. Multiple layers caused Office Discussion to appear empty or cross-session.
3. `server/v2/api/local-agents.ts` declared installed executables connected without authentication when `verify=false`, offered a fabricated settings-save success, supplied static fallback discovery with mismatch to UI. `web/src/components/LocalAgentsSetup.tsx` refresh erroneously replaced its whole roster with nonexistent `result.agents` instead of consuming `result.discovery`. Some CLI launchers ignore requested model IDs. Agent authentication and model activation must be verified separately.
4. `server/v2/api/setup.ts` exposed a small seven-provider catalog; V2 has ten official API providers plus `local` and `unconfigured`. Legacy `server/setup/models.ts` is a 2026-10-17 static 20-candidate catalog and has unverified/future/deprecated IDs. Do not pad to 25 fabricated model IDs.
5. `server/v2/runtime.ts` still treats some successful placement ACKs as executed/filled before exchange confirmation and treats CLOSE as closed without validating receipts. `server/v2/api/wallet.ts` production initialization lacks the verification/persistence callbacks. Saved role/model settings can diverge from environment-based runner assignments. These issues predate this patch and remain P0.
6. `server/v2/market/whale.ts` contains legacy Whale Alert v1 path; CCXT adapter is not installed into production; TradingView webhook has same-symbol 1/min rate limiter. Audit against verified official live APIs before claiming these sources live.
7. `server/v2/settings/schema.ts` includes `dailyLossLimitPct` 0.5-25 and `maxPositions` max 4. The Owner governs legal ranges; do not quietly clamp or impose hidden position limits. Separate serialization/types validation from strategy eligibility.
8. Project contains overlapping legacy `server/{app,desk,runtime}.ts` and Rebirth V2 `server/v2/*`, dual persona paths and old CLI/docs; these may still be imported by release/compat/tests. Audit the actual import graph and launchers before deleting anything. Protect historical event journals and migration data.
9. Browser-test presence alone does not establish browser coverage: tests may skip when dist/browser unavailable; exact HEAD Actions and real browser/CLI authentication evidence still required.

## Desired architecture

### Model discovery and 25-per-provider target

`ProviderModelCatalog` accepts one `provider`, verified auth/endpoint, fetches official model listing where the provider exposes it, maps capabilities/retirement/access, persists a checked timestamp, and publishes an explicit `source: verified_api|provider_documented|static_fallback|manual`, `available: true|false|null`, `usable: true|false|null`, `error`, `modelId`, and `name`. Show the first 25 **real** model IDs for each of ten API providers when >=25 verified IDs exist; support search/pagination over full discovered inventory. When <25 models exist/are accessible, show the truthful count and allow owner-entered custom IDs. Never invent models to hit 25. Existing custom model settings must survive catalog refresh and API outages. Live validation tests whether selected ID is accepted using non-trading inference. One `ModelAssignment` resolver drives Setup, CLI settings, role runner and `/api/state`; configVersion matches SettingsService active version. Any provider or model change applies after a verifiable settings transaction; hide stale successes.

### CLI adapter contract

Every supported CLI declares executable, version probe, nonsecret auth probe, model discovery capability and invocation model flag adapter; `installed`, `authenticated`, `modelSelectSupported`, `selectedModel`, `verifiedAt`, `activeForRoles`, `lastError` reported independently. Supported model IDs are only marked active if actual invocation used them. Do not use a faux 'Connected' badge based on PATH. Protect execution credentials via least-privilege sanitized environment. Per-CLI settings are stored or return explicit unsupported status; connect must not assign all roles unless explicitly requested. No CLI may receive direct exchange write authority.

### Office Chat

Canonical `conversationId` is carried `web request -> operations route -> runtime -> role runner -> event store -> room/private chat -> websocket -> UI`, scoped by owner session. Database persists metadata and messages with idempotency key; crash/reconnect restores order and prevents duplicate prompts; `New chat` returns and selects id; `Delete` requires explicit intent and only removes chat records for that id, not financial/event journal. `Main Office` always exists. Office Discussion shows authentic owner/agent debate, distinct system speeches, error states, and `@all` outcomes. During async role inference emit acknowledgement/progress and allow reconnect; no fabricated role reply or successful completion. New/delete controls work in both Office and AgentPanel desktop/mobile.

### LIVE and source integrity

Native exchange adapter is order-write authority. Gateway receipt states `SUBMITTED`, `ACKNOWLEDGED`, `PARTIALLY_FILLED`, `FILLED`, `REJECTED`, `CANCELLED`, `UNKNOWN`; reconcile by venue order/client IDs and actual signed account state before changing ledger or UI verdict to `executed`. Rebuild open/close lifecycle and persistence on restart without double ordering or falsely flat positions. Wallet delegated secret persists via local secure secret store and verifies account-agent trade/no-withdraw on venue. Distinguish missing or stale equity from verified zero. Whale Alert transport follows currently documented subscription contract and subscription tier; on-chain transfer is not orderflow. CCXT REST is optional read-only supplementary data, not the executor; paid Pro WS capability must be explicit. TradingView authenticates events, persists before ACK and queues each distinct alert; dedupe only true retries.

### Cleanup strategy

Build dependency inventory with `tsc --traceResolution`, `rg` references, `git grep`, npm scripts, Vite chunk graph, active route mounts, stage-gates, docs and migration compatibility. Classify `KEEP`, `CONSOLIDATE`, `ARCHIVE`, `DELETE AFTER EVIDENCE`. Removal happens only after all consumers and durable data migration are verified. Never delete `.env`, account backups, production journal, sqlite, learned evidence, historical closed positions or protocol migration. Kill/close/rollback controls survive client chunk splitting.

## Definition of done

- Exact remote `main` SHA and test-run SHA documented. Source patch verified against that SHA, clean isolated worktree, no unintended mutations.
- New/private and @all chat create, route, delete, persist, recover, no duplicate after websocket reconnect or server restart, on desktop/mobile. Errors surfaced, no empty silent room.
- All ten API providers discover actual available models and can select 25 when those providers offer 25; fewer reported as fewer. CLI connection distinguish installed/authenticated/model active, no false success. Six actual role assignments use saved settings.
- Eight native exchange adapters and session/wallet/stop semantics tested against official documented fixtures; host proof distinguished from mocks.
- No false fill, close, PnL, zero equity, connected wallet or verified transfer classification.
- No new hidden strategy gate; all official system guards and Owner configuration preserved.
- Verified cleanup manifest with reason, references, tests, restore path and measured result.
- `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, `npm run build:rebirth`, `npm run stage-gate`, browser matrix and exact-SHA GitHub Actions; honest NOT_VERIFIED for unavailable checks.

## Official research links (verify immediately before implementing)

- OpenAI API models list: https://developers.openai.com/api/reference/resources/models/methods/list
- Anthropic API models list: https://platform.claude.com/docs/en/api/models/list
- Gemini API models.list: https://ai.google.dev/api/models
- xAI model list: https://docs.x.ai/developers/rest-api-reference/inference/models
- GitHub Copilot CLI models and custom provider: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-llm-models
- Bybit order create ACK: https://bybit-exchange.github.io/docs/v5/order/create-order
- Bybit private WS order: https://bybit-exchange.github.io/docs/v5/websocket/private/order
- Whale Alert: https://developer.whale-alert.io/api-account/documentation
- CCXT REST: https://github.com/ccxt/ccxt/wiki/Manual
- CCXT Pro: https://docs.ccxt.com/docs/pro-manual
- TradingView webhook: https://www.tradingview.com/support/solutions/43000529348-how-to-configure-webhook-alerts/
