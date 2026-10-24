# Changelog

All notable changes to Trading Agent Mpu Gandring are documented in this file.

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
