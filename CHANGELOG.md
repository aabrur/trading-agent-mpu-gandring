# Changelog

All notable changes to Trading Agent Mpu Gandring are documented in this file.

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
