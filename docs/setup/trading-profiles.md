# Trading Agent Mpu Gandring: trading profiles

Open **Desk ops → Live trading setup → Default** or **Manual setup**. Both open **Setup → Trading & Risk**. Select **Testnet** or **Mainnet**, review the values, then save. Opening the popup or selecting a profile saves nothing.

Manual setup loads the values previously entered for that network. Switching sections keeps the draft. **Discard edits** restores saved values; closing Setup discards unsaved edits. Saving Default keeps the saved manual values available for later editing.

| Profile | Stop loss | Take profit | Maximum leverage | Minimum entry confidence | Daily loss limit |
| --- | --- | --- | --- | --- | --- |
| Default | 20% | 60% | 5x | 60% | 10% |
| Balance | 30% | 60% | 10x | 60% | 15% |
| Profit | 40% | 70% | 15x | 60% | 20% |
| Aggressive | 50% | 80% | 20x | 60% | 25% |

SL and TP are percentages of the margin committed to an order, before fees and venue rounding. Price distance equals margin percentage divided by leverage. For example, Default at 5x places SL 4% and TP 12% from entry. LONG subtracts the SL distance and adds the TP distance; SHORT does the reverse.

Every entry path uses these profile percentages, including Office tickets, Owner commands, internal debates and agent API/CLI tickets. Legacy stop/TP prices supplied by agent tickets do not override the active profile. There is no minimum stop distance, separate account-equity loss cap per trade, model size reduction, mood multiplier or automatic hedge order.

Allocation still comes from the Owner's Money Trade and N/order-size setting. Available funds, exchange quantity/tick rules, the profile leverage cap, exchange-side protection, daily loss limit, and kill/pause controls still apply. Estimated fees are shown separately and do not impose a second per-trade loss cap. The daily limit uses UTC-day start equity and remains latched until the next UTC day once reached.

These values are Owner settings. Confidence is an agent's reported assessment, not a verified probability of profit. No daily profit target or daily order quota is added.

## What saving does

- On the running TESTNET or LIVE network, settings apply after the exchange operation currently in progress finishes. New sizing and entry checks use them. Existing positions, order protection and the daily loss latch are preserved.
- Saving the other network, or saving while PAPER is running, prepares that network for its next start. PAPER settings stay unchanged.
- Saving does not switch mode, enable Auto Trade, connect an exchange, restart the desk or place an order. **Exchange & Safety** retains the existing credential checks and typed LIVE confirmation. LIVE trades real money autonomously and can lose it.
- Existing installations keep their current configuration until a profile is explicitly saved. Provider/model selection, permitted symbols, debate settings, holding period, reporting, notifications, fees and kill-switch behavior are not changed by a profile.

The entry confidence floor applies to internal Lead decisions, signed agent proposals and agent open tickets, for both LONG and SHORT. CLOSE and HOLD remain available. A missing confidence blocks an agent entry only when the configured floor is above zero. Human manual tickets use the profile SL/TP without an agent confidence requirement.

Agent tickets can provide `confidence` on the existing API, or `npm run gb -- open ETHUSDT LONG --confidence 0.60`. The profile supplies SL/TP. Use the same 0..1 confidence scale as agent replies. The agent CLI, signed agent routes and proposals identify the ticket as an agent entry automatically, including when the CLI uses the local ops route.

## Persistence

The existing local setup store holds `TESTNET_DESK_PROFILE` and `MAINNET_DESK_PROFILE`, with values `default`, `balance`, `profit`, `aggressive` or `manual`. Missing selection means legacy/current configuration. Saved preset values are frozen until the Owner saves a profile again. Manual values use the existing setting names prefixed with `TESTNET_DESK_` or `MAINNET_DESK_`. Preset selection does not erase manual drafts. Legacy minimum-stop and account-equity risk fields remain readable for compatibility but do not affect execution.

Profile reads and writes use the existing localhost and same-origin setup route gate. No exchange history reads or model calls are needed to edit a profile.
