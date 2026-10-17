# Desk skills

Role notes for the Trading Agent Mpu Gandring desk. A coding agent or Grok Bot can load these to understand how each seat should behave.

| Skill | Role | What it does |
| --- | --- | --- |
| `market-scan` | Market Analyst | Reads public prices and candles. No key. |
| `catalyst-research` | Research Analyst | Network status, exchange notices, news, macro calendar. Votes ABSTAIN, LONG, SHORT or VETO. |
| `strategy-rule` | Strategist | Turns the owner's rule into a side and a cancel level, on closed bars only. |
| `risk-gate` | Risk Manager | Writes the limits with the owner and gives PASS or FAIL on every ticket. |
| `order-execution` | Execution Trader | The only seat that would send orders. |

Important: the app in this repository runs in PAPER mode only. The notes in `risk-gate` and `order-execution` describe how a live desk should behave (testnet first, mainnet and automatic sending each need a typed yes from the owner). That live part is guidance for a future, separately reviewed module. It is not code in this build.

Keys are read from environment variables only. Never paste a key in chat and never commit one. No profit is promised.
