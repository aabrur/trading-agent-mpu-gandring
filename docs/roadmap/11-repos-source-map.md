# 11 Open Source Quant & AI Repositories: Source Map & Clean-Room Rules

Baseline Commit: `2dee1bc1d53aa498d9e5a5cd4b103155254e7fd4`
Document Date: 2026-10-26 (WIB)

## Clean-Room Engineering Policy
Trading Agent Mpu Gandring is licensed under the **MIT License**.
- Upstream repositories with **GPL-3.0** (such as Freqtrade) or **LGPL-3.0** (such as NautilusTrader) must NEVER be copied, pasted, or directly bundled into this codebase.
- Reusable concepts (such as event replay, fee/funding accounting, minimal ROI tables, trailing stop algorithms) are re-implemented clean-room in native TypeScript from first principles and mathematical formulas.
- Code from permissive licenses (**MIT** and **Apache-2.0**) must be adapted with proper copyright credit and structural alignment.

---

## 11 Repositories Source Inventory

| # | Repository | Pinned SHA | License | Architectural Derivation | Target in Mpu Gandring |
|---|---|---|---|---|---|
| 1 | `TauricResearch/TradingAgents` | `e8f5503e9b86d5c2710b0c76b1f686703968c9df` | Apache-2.0 | Bull vs Bear adversarial debate, structured research state | `server/decision/adversarial-debate.ts` |
| 2 | `virattt/ai-hedge-fund` | `29b32f71861480e9bfd48b82cf0d3ca3e5680955` | MIT | Deterministic simulated broker, investor personas (Buffett, Munger) | `server/research/backtest.ts`, `server/agents/personas/` |
| 3 | `ZhuLinsen/daily_stock_analysis` | `b19d4b99f0f564a7c7f1e33a59fab28e3113bf33` | MIT | Multi-market ETL, catalyst scoring, scheduled reporting | `server/market/`, `server/reports.ts` |
| 4 | `shiyu-coder/Kronos` | `67b630e67f6a18c9e9be918d9b4337c960db1e9a` | MIT (code) | K-Line autoregressive foundation model, Monte Carlo pathing | `workers/kronos/`, `server/market/kronos-client.ts` |
| 5 | `microsoft/qlib` | `54355232463878d2eebb91fe0ee5fa7fa1f5976c` | MIT | Alpha158/Alpha360 mathematical factor library, IC/IR scoring | `server/market/alpha-factors.ts` |
| 6 | `openbq-org/OpenBB` | `7df7d0c5592bf25be88e87e130a05c71e243d2d8` | Apache-2.0 | Standardized provider abstraction layer, typed data schemas | `server/market/point-in-time.ts` |
| 7 | `ccxt/ccxt` | `d3159f7036f93db086cd0414642132fba5401710` | MIT | Unified crypto market metadata, decimal precision arithmetic | `server/exchange/rules.ts`, `server/live/executor.ts` |
| 8 | `freqtrade/freqtrade` | `150a10bc2b2c49959975693fafd668f7fb37de7d` | GPL-3.0 | Minimal ROI matrix, dynamic ATR trailing stop (Clean-Room only) | `server/risk.ts`, `server/research/backtest.ts` |
| 9 | `hummingbot/hummingbot` | `9af100d6822da7d2d0291a906c730ef172284ee2` | Apache-2.0 | Microstructure quoting, inventory skew management, laddering | `server/live/inventory-skew.ts` |
| 10 | `nautechsystems/nautilus_trader` | `224ed24dbc1e98f4779a93592a7c7c8e49fafd85` | LGPL-3.0 | Deterministic event replay, nanosecond bar clock (Clean-Room only) | `server/events/event-bus.ts`, `server/research/pit.ts` |
| 11 | `HKUDS/Vibe-Trading` | `e75c20aa9e0f7818c457c36310facdf69864953f` | MIT | Smart Money Concepts (BOS, ChoCH, FVG), Harmonic Fibonacci PRZ | `server/market/smc.ts`, `server/market/harmonics.ts` |
