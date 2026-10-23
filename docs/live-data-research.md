# Live data and agent research

Trading Agent Mpu Gandring collects observations in the backend and exposes a read-only research MCP to Codex agents. Existing exchange execution and Owner risk limits remain in the shared executor.

## Measurements

- OI changes use timestamped Bybit linear-contract history at 5-minute resolution. The 15-minute, 1-hour and 4-hour changes require observations exactly that far apart. Evidence records the venue, latest observation and baseline time.
- Deribit put/call is the sum of put **open interest** divided by call open interest across the returned options. It is not a volume ratio. DVOL comes from the volatility index endpoint; index price comes from the index price endpoint. Failed endpoints remain independently unavailable.
- Timeframes use their own valid closed candles. A missing 4-hour feed does not become a 15-minute feed. EMA200 requires 200 observations. Realized 24-hour volatility requires 96 consecutive 15-minute returns and is expressed as a daily percentage, not an annualized value.
- Volume profiles and swing-distance calculations are labeled candle-derived estimates, rather than measured volume-at-price or liquidation liquidity.
- LIVE/TESTNET do not substitute sample market data or sample news. Without CryptoPanic, the news collector attempts relevant public Bybit announcements. No returned headline means no relevant news evidence, not a verified absence of events.
- Hyperliquid wallet observations cover only the configured watchlist. An incomplete wallet query is unavailable, rather than zero exposure. Cross-chain transfers require a configured Whale Alert provider.

## Jev

In authorized LIVE assist mode, Jev chooses acquisition priority from a bounded set. Backend code performs the actual fetches and calculations, then delivers the observations to the agents. Every collector still runs. The collection trace exposes the route, whether Jev or the default selected it, routing errors, and each feed's availability. Jev's existing semantic assessments continue to enrich the Research Analyst, Strategist and Desk Lead. A routing answer cannot execute a trade or change settings.

## Setup

Open **Setup → Local CLI Agents**. Enable Codex live research to make live web search and the desk MCP available on subsequent Codex calls. The desk tools are market snapshots, news, on-chain observations, account reads and Jev-directed collection.

Additional standalone MCP servers are discovered from the native Codex account. Permit explicit read tool names per server. OAuth stays with Codex. Selected environment references can supply provider-specific research credentials; desk exchange, model and messaging credentials are never forwarded. Inline MCP credentials are rejected. Installed plugins are not automatically enabled for trading agents.

Use the masked news/on-chain inputs on the same page to save provider keys locally. Empty fields keep saved keys; Cancel clears the unsaved input. Keys being set does not establish feed availability: collection results and completed MCP events provide that evidence.

Research access is opt-in with `LOCAL_CODEX_RESEARCH_TOOLS=on`. `LOCAL_CODEX_MCP_TOOLS` stores the server-to-read-tool selection as JSON. These settings do not authorize arbitrary connectors, external messages, exchange writes, or key access. Test in PAPER before applying changes to a running LIVE desk.
