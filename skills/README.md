# Desk skills

Role notes for the Trading Agent Mpu Gandring desk. A coding agent or Grok Bot can load these to understand how each seat should behave.

| Skill | Role | What it does |
| --- | --- | --- |
| `market-scan` | Market Analyst | Reads public prices and candles. No key. |
| `catalyst-research` | Research Analyst | Network status, exchange notices, news, macro calendar. Votes ABSTAIN, LONG, SHORT or VETO. |
| `strategy-rule` | Strategist | Turns the owner's rule into a side and a cancel level, on closed bars only. |
| `risk-gate` | Risk Manager | Writes the limits with the owner and gives PASS or FAIL on every ticket. |
| `order-execution` | Execution Trader | The only seat that would send orders. |

Important: the app runs in PAPER mode by default. TESTNET and LIVE run full auto after setup, behind automatic guards: a no-withdraw key check, a stop on every order, the daily loss stop, the safety net and max N (see `docs/live-trading.md`). The notes in `risk-gate` and `order-execution` describe how the desk behaves in both modes.

Keys are read from environment variables only. Never paste a key in chat and never commit one. No profit is promised.
