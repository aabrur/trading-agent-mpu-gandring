---
name: catalyst-research
description: Use before a ticket is sized, or on each report cycle, to check public news, network status, exchange notices, and the macro calendar for the symbols the desk trades. Works for CEX and DEX setups. Needs no API key.
---
# Catalyst research

Research reads public sources only. It never places, changes, or cancels an order, and it never predicts a price.

## Inputs
- Venue type from the setup interview: CEX or DEX, and the exchange name.
- The symbols the desk trades. A symbol that is read but not traded is still checked.

## Each cycle
1. Network status. Open the chain's official status page for each symbol (for example status.solana.com, status.avax.network). For Bitcoin, read the latest block height and time from a public block explorer API. If a status page does not load, write "unknown", not "fine".
2. Venue notices.
   - CEX: open the exchange's announcements page and look for delistings, maintenance, contract changes, and margin or collateral changes that name a traded symbol.
   - DEX: open the protocol's status page, docs changelog, and official channels for halts, upgrades, or oracle issues.
3. News. Search for exploits, outages, and delistings tied to each symbol in the last 24 hours. Open the primary source before quoting a secondary one.
4. Macro calendar. Read the next FOMC date from federalreserve.gov and the next CPI date from bls.gov. Note anything inside the next 24 hours.
5. Large flows. Report only when a real source was opened. If none was opened, write "not read".

## Labels
Mark every claim as verified, reported, claimed, inferred, or unknown. Attach a link and a UTC time to each one.

## Vote
- ABSTAIN when nothing material is found. ABSTAIN is not a vote in either direction and does not count toward agreement.
- LONG or SHORT only when a sourced catalyst points that way.
- VETO when a traded symbol is being delisted, halted, or exploited, or when its chain is down. Name the source and time.
A missing field is never permission to trade.

## Output
Write one short note to `research/<YYYY-MM-DD-HHMM>-<symbols>.md` in the desk folder. Post a short summary to the desk: vote, material yes or no, what was verified, and what was not read. Never put an API key or token in a note.
