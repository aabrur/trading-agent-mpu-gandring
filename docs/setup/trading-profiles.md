# Trading Agent Mpu Gandring: trading profiles

Open **Desk ops → Live trading setup → Default** or **Manual setup**. Both open **Setup → Trading & Risk**. Select **Testnet** or **Mainnet**, review the values, then save. Opening the popup or selecting a profile saves nothing.

Manual setup loads the values previously entered for that network. Switching sections keeps the draft. **Discard edits** restores saved values; closing Setup discards unsaved edits. Saving Default keeps the saved manual values available for later editing.

| Setting | App preset | Meaning |
| --- | --- | --- |
| Daily loss cap | 3% | UTC-day equity loss limit; an existing daily stop remains latched until the next UTC day |
| Risk per trade | 1% | Maximum loss at stop including estimated round-trip fees, relative to the lower of balance and equity |
| Minimum entry confidence | 0% | No additional confidence floor; manual profiles can require a higher reported signal confidence |
| Maximum leverage | 3x | Existing code caps and instrument limits still apply |
| Maximum / fallback stop | 1.5% | Maximum allowed distance and fallback when deriving a stop |
| Minimum stop distance | 0.3% | Minimum allowed stop distance |
| Take profit | 2R | Derived target distance; 0 disables the derived target |
| Minimum order notional | 5 USDT | Exchange minimums also apply; quantity is never rounded up to force an entry |
| Reserved capital | 200 USDT | Excluded from Money Trade; must remain above zero outside PAPER |
| Maximum open positions | 4 | Allocation slots; existing positions are not resized or closed by a profile change |

The preset is the app baseline, not a recommendation tailored to an account. In particular, a reserve above available equity leaves no allocation for new entries. Confidence is an agent's reported assessment, not a verified probability of profit. No daily profit target or daily order quota is added.

## What saving does

- On the running TESTNET or LIVE network, settings apply after the exchange operation currently in progress finishes. New sizing and entry checks use them. Existing positions, order protection and the daily loss latch are preserved.
- Saving the other network, or saving while PAPER is running, prepares that network for its next start. PAPER settings stay unchanged.
- Saving does not switch mode, enable Auto Trade, connect an exchange, restart the desk or place an order. **Exchange & Safety** retains the existing credential checks and typed LIVE confirmation. LIVE trades real money autonomously and can lose it.
- Existing installations keep their current configuration until a profile is explicitly saved. Provider/model selection, permitted symbols, debate settings, holding period, reporting, notifications, fees and kill-switch behavior are not changed by a profile.

The entry confidence floor applies to internal Lead decisions, signed agent proposals and agent open tickets, for both LONG and SHORT. CLOSE and HOLD remain available. A missing confidence blocks an agent entry only when the configured floor is above zero. Human manual tickets retain their existing sizing, risk and protection checks.

Agent tickets can provide `confidence` on the existing API, or `npm run gb -- open ETHUSDT LONG --stop <price> --confidence 0.75`. Use the same 0..1 scale as agent replies. The agent CLI, signed agent routes and proposals identify the ticket as an agent entry automatically, including when the CLI uses the local ops route. Do not omit confidence to bypass an owner-configured floor.

## Persistence

The existing local setup store holds `TESTNET_DESK_PROFILE` and `MAINNET_DESK_PROFILE`, with values `default` or `manual`. Missing selection means legacy/current configuration. Manual values use the same existing setting names, prefixed with `TESTNET_DESK_` or `MAINNET_DESK_`, for example `MAINNET_DESK_MIN_ENTRY_CONFIDENCE_PCT=75`. Default selection does not erase these manual values. Legacy settings and credentials are retained.

Profile reads and writes use the existing localhost and same-origin setup route gate. No exchange history reads or model calls are needed to edit a profile.
