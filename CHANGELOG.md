# Changelog

All notable changes to Trading Agent Mpu Gandring are documented in this file.

## [v0.0.0.4.12] - 2026-10-31

### Added
- Rebirth v2 architecture overhaul with LibSQL SQLite store and WAL durability.
- Bybit Linear WebSocket/REST market hub with deterministic decimal indicators.
- Six-role agent runner with 24 persona profiles, Jev calibration client, and CycleRunner.
- ExecutionGateway and ProtectionService ensuring resting stop loss on exchange for all live trades.
- 8 venue adapters: Bybit, Aster, Hyperliquid, Binance, OKX, dYdX, Paradex, and Orderly.
- Grok v2 bridge with HMAC raw-body verification and D09 STOP semantics.
- Support for ZECUSDT across default watchlist, auto symbols, sample feeds, and UI.

## [v0.0.0.4.11] - 2026-10-30

### Fixed
- Compiled `mpu trade --service` resolves the project root instead of `dist/server`, so it starts `dist/server/server/index.js` and reads the existing project `.env`. Windows autostart uses that same root. Ordinary `mpu` records child exit code, signal, pid, and whether a restart was requested. Trading settings and guards are unchanged.

## [v0.0.0.4.10] - 2026-10-30

### Fixed
- Desk Ops on TESTNET and LIVE counts occupied slots from backend accounting, including a unique pending entry, instead of local book rows. Unverified observations stay labeled unverified. PAPER still counts position rows. Owner settings, slot accounting and guards are unchanged.

## [v0.0.0.4.9] - 2026-10-29

### Fixed
- Preserve completed candles at exact close boundaries and normalize duplicate timestamps before the existing consecutive-history filter. Keep native candle volume precision in CLI JSON.
- Expose requested and actual venue, endpoint, network, instrument, unit and availability separately for candles, ticker, depth and tape. Distinguish Aster symbol listing failures from missing candle observations.
- Preserve the first kill-switch activation origin and append sanitized local forensic records. Surface audit failures and avoid duplicate emergency closes.

### Added
- Prior-20 median relative volume as a diagnostic alongside the unchanged mean-based ranking, and separate publication/event/window provenance for macro metrics.
- Read-only checkout/process identity, canonical profile hashes, saved/active threshold provenance and native routine phase limits. Routine instructions follow the Owner's existing cadence.
- Explicit opt-in Aster LIMIT GTC entry with durable pending-order state, idempotent reconciliation, cancellation, optional Owner-selected expiration, partial-fill protection and recovery of late fills after protective closes. MARKET remains the default.
- Audit, compatibility, test evidence and a private Grok Bot host read-only checklist. Offline checks do not establish live fills, installed native profiles or trading performance.

## [v0.0.0.4.8] - 2026-10-29

### Fixed
- Apply entry Risk approval and the saved Owner confidence threshold only to OPEN. Verified CLOSE remains possible when every position slot is occupied or entry margin is exhausted.
- Refresh CLOSE evidence after Risk and Lead deliberation, recompute structure and momentum from the current snapshot, match the selected typed trigger, and repeat position/trigger validation under the reduce-only execution lock with a 30-second freshness limit.
- Preserve full Research citations while abbreviating bounded source labels. Schema-only repairs reuse completed answers without new web research or changes to vote, confidence, argument or source identity.
- Retry recoverable Windows session-metadata replacement failures asynchronously with bounded backoff. Preserve last-good data and terminal metadata, and report persistence failures accurately.

### Added
- Guarded native-agent OPEN with explicit Risk APPROVE and actual Lead confidence; verified agent CLOSE bound to a position id, quantity and fresh typed trigger. Existing manual Owner commands retain their own paths.
- Shared CLI CLOSE review and formatted status, positions, scan and scorecard summaries for Grok Bot and Muse teams on their own computers.
- A privacy-preserving, offline audit of owner-retained mainnet records. Positive matched realized-PnL records are distinguished from complete net profitability and independent exchange attestation.

### Changed
- Updated Grok Bot installation/group setup and native Muse six-agent templates. Preserve saved settings on upgrades, reuse existing agents/routines, and keep Execution independent from Lead.
- Rewrote the README around installation, the current six-role workflow, Jev's optional role, verifiable evidence and credential privacy. Historical changelog entries below describe their release at that time, not the current execution contract.

## [v0.0.0.4.7] - 2026-10-28

- Restored the reasoned six-agent decision flow, saved Owner confidence policy and native venue execution.
- Preserved exit causality, asynchronous execution-journal safety, operational chat history and authorized local kill-switch ON/OFF behavior.

## [v0.0.0.4.6] - 2026-10-28

### Fixed
- Zod schema null tolerance: added nullToUndefined preprocessor to entryScenarioId, entryZone, invalidationLevel, closeTrigger, and exitSignal so nullish values from LLMs do not trigger validation rejections on HOLD and NEUTRAL stances.
- Provider output token ceiling: raised base token limit across all providers from 2048 to 20,000 tokens to ensure reasoning models complete JSON responses without truncation; raised OpenRouter output limit retry cap to 65,536 tokens.
- Provider and local agent timeouts: relaxed remote HTTP provider timeout from 60s to 180s (configurable via PROVIDER_TIMEOUT_MS); relaxed local agent CLI discovery timeout to 25s and execution timeout from 120s to 300s (configurable via LOCAL_AGENT_TIMEOUT_MS); extended Cline timeout to 300s.
- Local agent CLI execution fixes: added --dangerously-skip-permissions to Antigravity CLI to prevent interactive prompts from blocking headless runs; closed stdin immediately for file-prompt CLIs (grok, hermes, openclaw, muse) to prevent OS pipe deadlocks.
- Error classification: refined quota detection to catch usage limit and credit exhaustion diagnostics cleanly.

## [v0.0.0.4.5] - 2026-10-28

### Fixed
- OPEN momentum alignment (Bug A): required supporting tape momentum and verified directional price and orderflow alignment for OPEN_LONG and OPEN_SHORT; JEV and catalysts cannot substitute for missing or opposing momentum.
- CLOSE trigger decoupling (Bug B): decoupled price momentum reversal and authenticated orderflow reversal in close triggers, authorizing exit on either condition independently.
- Unconditioned anomaly exits (Bug C): removed negative unrealized PnL gating from data anomaly exits, allowing verified data anomalies and severe source conflicts to authorize defense on profitable positions.
- Strategist to Lead execution contract: restored canonical tactical scenario propagation, added bid/ask spread tolerance to entry zone checks, and strictly enforced scenario geometry during execution.
- OpenAI structured outputs: added strict JSON schemas with nullable properties and complete required fields for reliable provider parsing.
- Test suite and CI stability: repaired all 25 historical CI failures across 8 test suites, restored desk.invalidated(), sanitized ambient test environment variables, and verified independent S5 stage-gate.

## [v0.0.0.4.4] - 2026-10-27

### Changed
- OPEN requires a live entry zone and invalidation, aligned measured momentum, and at least one distinct supporting evidence family. One verified opposing dimension cancels the entry. Unknown optional news, whale, or JEV data does not.
- CLOSE can fire from any one verified trigger. Holding duration does not close a position.
- Lessons stay in the account scope that recorded them, and room/chat history caps apply per conversation.
- Structural levels and ATR keep low-price precision. Realized-profit evaluation separates book PnL from fees, USDT funding, and expectancy.

This is local remediation. It does not start production trading and it does not claim profitability.

## [v0.0.0.4.3] - 2026-10-27

### Fixed
- Use the active theme's panel background for Add Token dropdown options so token names remain readable and match the other dropdowns in day and night mode.

## [v0.0.0.4.2] - 2026-10-27

### Fixed
- Preserve successful local CLI replies when Windows locks the temporary working directory during cleanup. Cleanup retries asynchronously, and model deadlines now include time spent waiting for a process slot.
- Decode OpenRouter content blocks consistently after structured-output fallback, preserve authentication errors, and distinguish provider timeouts, empty replies, and exhausted output budgets. Only output-limit failures receive a larger budget on the existing second attempt.
- Apply saved desk preferences immediately without recreating the exchange executor or resetting positions, realized paper equity, the daily loss baseline, or safety latches. Reschedule periodic reports when their interval changes.
- Validate saved configuration before restart, request managed restarts before touching exchange state, and wait for a replacement server identity before reporting completion or reloading the browser.
- Activate the selected local CLI for all six agents directly from Connect. Verify unknown sessions in the backend before opening native sign-in, bound verification requests, and preserve existing configuration when verification fails or expires.
- Bound Office requests so stalled operations release their loading state, synchronize max-hold fields correctly, and give native preset options explicit text and background colors in night mode.

## [v0.0.0.4.1] - 2026-10-26

### Added
- Autonomous trading exits: granted agents full autonomous authority for dynamic profit-taking on momentum surges (margin unrealized profit >= 15% or momentum pump exhaustion) and cut-risk exits on market anomalies and adverse divergences.
- JEV decision engine optimization: moved JEV pre-evaluation earlier in the debate pipeline so all team agents receive rich market regime context, added deterministic algorithmic heuristic fallback when remote endpoints timeout or fail, removed live-only restrictions on collection routing, and added harmonic pattern detection.
- Unified CLI Router expansion: added mpu version (--json, --short, -v), mpu link, mpu health, mpu context, mpu capabilities, mpu research, mpu reports, mpu split, and mpu bench.
- Friction-free kill switch: added in-memory unkill API endpoints (POST /api/unkill and POST /api/kill with { on: false }) and mpu unkill notification support to release the emergency stop without requiring a server restart.
- Grok Bot CLI and operations: exposed backend research tools, health checks, state context, and operating runbooks for remote Grok Bot agents.
- Persistent local application sessions with parent/child identity, startup and shutdown outcomes, conservative unclean-session recovery, ordered JSONL events, readable console/error transcripts, bounded queues, rotation, and explicit storage-loss counters. Diagnostic failures do not authorize or reject orders.
- Metadata observers for market snapshots, model tasks, debates, Jev, automation, order reconciliation, protection observations, journals, financial evidence, reports, and integration failures. Financial journals remain independent.
- System Log archived-session browser with session summaries, searchable chronological events, severity/source/correlation filters, and downloads for console, errors, events, and session metadata. Live log and History views remain available separately.
- Independent roadmap verification mode that runs typecheck, tests, and build with isolated dotenv configuration and stores hashed outputs plus a source-tree digest in a temporary evidence directory.

### Changed
- Historical simulator cash and trade PnL now reconcile entry/exit fees and funding once, including liquidation adjustments and open-position costs. Entry affordability includes fees; protective intrabar exits take precedence over close-based ROI exits; strategy feeds are bounded to the current close, invalid history is rejected, and settlement clocks traverse data gaps.
- Statistical forecasts expose seeded simulations, side-aware TP/SL/no-hit probabilities, validated worker outputs and input bounds, and explicit GBM source labels. They remain outside production trading decisions.
- Roadmap `S*.json` evidence is reported as historical integrity only; it no longer counts as verification of the current checkout or authorizes the next stage.
- README now distinguishes research libraries from modules wired into the live execution path and labels Monte Carlo outputs as scenarios rather than validated predictions.

### Fixed
- Resolved body-parser security advisory GHSA-27r3-jxmh-p828 (CVE-2026-111181) by upgrading to fixed 2.4.0 release via lockfile resolution, with isolated compression regression coverage.

## [v0.0.0.3.29] - 2026-10-25

### Added
- **In-Place Cendol Menu (`TrakteerPopup`)**: Interactive Cendol quantity selector (`1`, `2`, `5`, `10`, `25` presets + custom stepper), Cendol-only branding without creator profile clutter, and direct in-place checkout overlay without leaving the virtual office.
- **Real-Time Cendol Office Celebration (`TrakteerWS` + `/api/trakteer/tip`)**: When a Cendol tip or test stream arrives, the Desk Lead character at the virtual desk immediately speaks `"Terima kasih traktiran cendolnya!"`, all six agents cheer, and a floating celebration banner appears at the top of the office.
- **OpenRouter Dashboard Attribution (`OPENROUTER_HTTP_REFERER`)**: Configured GitHub Pages showcase referer (`https://aabrur.github.io/trading-agent-mpu-gandring/`) so OpenRouter crawls and displays the official Mpu Gandring icon.

### Changed
- **Refined 2.5D Virtual Office & Night Mode Lighting**: Grounded the coffee counter on the right floor, proportioned the central discussion table, illuminated night-mode wall sconces, pendant lamp, and floor lamps with warm ambient glow, and streamlined the compact right HUD (`Fight meter`, 2 `Verdicts`, `Open orders N`, `Open positions`, and `Close all`).
- **Updated `README.md` (`v0.0.0.3.29`)**: Added independent multi-venue verification across Bybit, Aster, Hyperliquid, and Binance, expanded sanitized live profit history ledger, updated workflow/architecture diagrams and office screenshots, and added the Responsible Autonomy & Anti-Overreliance advisory.

## [v0.0.0.3.28] - 2026-10-25

### Added
- Per-venue credential field status map (`venuesByExchange` in `GET /api/setup` and `venues` in `GET /api/setup/guide/:venue`) so every exchange shows its exact testnet and mainnet credential status immediately on selection.
- Partial credential merging in `saveVenueKeys`: entering only the missing key or secret merges with existing saved credentials for that venue and network before verification and persistence.

### Changed
- Instant venue switching in **Setup > Exchange & Safety**: selecting any exchange in the dropdown immediately persists `EXCHANGE` via `POST /api/setup/venue`, reloads runtime desk configuration, opens the credential form, and updates all field labels and status lines.
- Default minimum order size (`MIN_ORDER_USDT` / `minOrderUsdt`) set to `0` USDT across trading profiles, schema validation, and order planning (`planOrder`).
- Cleaned up `TopBar` header by removing redundant `CEX · Bybit`, `V`, and `data: <source>` badges, and prioritized active server venue state over stale `localStorage` entries.
- Reorganized `README.md` with step-by-step installation instructions (Quick 4-Command Install, Dev Mode, and Grok Bot Mode), updated `v0.0.0.3.28` release highlights, and clearer reference tables.

## [v0.0.0.3.27] - 2026-10-25

### Changed
- Eliminated WorkspaceTools flyout layout thrashing and jitter by removing scrollbar freezing.
- Enlarged compact HUD metric indicators and increased compact verdicts view to 3 items for enhanced readability.
- Streamlined agent direct chat with concise responses, no redundant team handoffs on 1-on-1 chats, and duplicate message deduplication.
- Isolated HTTP client 4xx malformed requests from supervisor exchange error escalation counters.
- Fixed Windows quoting and batch execution for Local CLI Agents with spaces in executable paths.

## [v0.0.0.3.22] - 2026-10-24

### Added
- Expanded local CLI agents catalog: Hermes Agent, OpenClaw, GitHub Copilot CLI, Cursor Agent, Qwen Code, OpenCode, and Muse Code alongside existing Codex, Claude Code, Pi, Kimi Code, Kilo, Cline, Grok Build, and Antigravity.
- Integrated non-CLI external AI supervisors: Grok Bot, Claude Cowork / Desktop, Dot (New Computer), Muse (app), ChatGPT Agent, Manus, and Perplexity Comet with copyable prompt cards and supervisor poll endpoints.
- Per-agent isolated settings drawer: customize temperature, top_p, and custom CLI invocation arguments per agent with full persistence and reset capabilities.
- Live topbar version indicator `v0.0.0.3.22` and Bybit `V` badge beside venue indicators.

### Changed
- Refactored Local CLI agent card layout with clean status tags, dedicated drawer panels, and direct login commands.
- Updated setup model catalog and documentation to reflect 15 supported CLI agents and 7 external supervisor integrations.

## [v0.0.0.3.20] - 2026-10-24

### Added
- Multi-agent structured collaboration supporting `askTeammates` with parallel fan-out, dependency ordering, and explicit Desk Lead synthesis.
- Conversation-scoped sticky symbol memory preventing active discussions from being hijacked by background auto-trading cycles.
- Market microstructure analysis engine with cumulative volume delta (CVD) tracking across 1m, 5m, and 15m intervals, order-flow divergence, and order book imbalance.
- Native Aster depth and aggregate-trade data collection with explicit venue and proxy provenance tracking.
- Frontier AI model catalog update with curated October 2026 models (Anthropic Claude 5.5, OpenAI GPT-6.1, Google Gemini 4 Argon, DeepSeek v4.1, Z-AI GLM 5.3, Kimi k3, MiniMax m3.1).
- Native JSON Schema structured output enforcement via `response_format: { type: 'json_schema', ... }` for supporting models, with graceful downgrade on rejection.
- Model stack presets: Performance-First Candidate and Cost-Optimized Challenger.
- Model benchmark CLI (`npm run bench:models`) with dry-run support, schema compliance metrics, and safety budget guards.

### Fixed
- LIVE capital availability reporting now derives from exchange-confirmed account balances rather than paper book state.
- Tactical breakout and reversal swing validation corrected to use historical swing points without self-referential test-candle lookbacks.
- Desk Lead synthesis in huddles now only triggers when the Desk Lead is targeted or when addressing the full desk.
- Strict JSON Schema compatibility corrected for `risk` (pure root object) and `chat` (nullable fields in required array) for OpenAI and OpenRouter strict structured outputs.
- OpenRouter structured outputs now pass `provider: { require_parameters: true }` to enforce endpoint capability routing.
- Benchmark harness (`cli/bench-models.ts`) upgraded to test all 6 desk agents, enforce a hard spending ceiling via `--budget-usd`, and compute true directional consensus across agents.

## [v0.0.0.3.19] - 2026-10-23
- System Log separates Tools, MCP, Plugins, Processes, and frontend/backend diagnostics.
- History contains searchable trade records, chat sessions, agent discussions, and commands.
- Office discussion supports direct and group messages with latest-message auto-scrolling.
- Codex research controls integrated inside its connection card.

## [v0.0.0.3.18] - 2026-10-23
- Live public observations for open interest, Deribit DVOL, and put/call ratios.
- Jev decision-intelligence research sidecar collection prioritization.

## [v0.0.0.3.17] - 2026-10-23
- Local CLI agent adapter configuration and model selection persistence.
