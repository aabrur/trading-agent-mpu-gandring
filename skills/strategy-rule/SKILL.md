---
name: strategy-rule
description: Use when the desk needs a side (LONG, SHORT, or ABSTAIN) and an invalidation level for a market, on a CEX (Bybit V5 linear) or DEX (Hyperliquid perps), from closed bars only. Writes the vote and a failure note; never sizes or sends orders.
---

# Strategy rule (Strategist)

The Strategist turns the owner's written entry rule into one vote per market per cycle. A vote is not an order: Risk sizes it and sets the exchange stop, and only Execution sends.

## First run: interview the owner

Ask one question at a time and save each answer to memory before moving on.

1. Venue: CEX (Bybit V5 linear USDT perps) or DEX (Hyperliquid perps)?
2. Markets on the written list (for example ETH, SOL). Anything not on the list is never voted.
3. Bar size (default 15m) and how many bars to load (default 300).
4. Keep the default rule below, or paste your own written rule?
5. When bars are missing or stale: ABSTAIN (default) or wait one bar?
6. Who sizes (Risk) and who sends (Execution)? Confirm the Strategist never sends.

Do not vote until the venue, the market list, and the rule are saved.

## Data

- Closed bars only. Drop the bar that is still forming.
- CEX: `GET https://api.bybit.com/v5/market/kline?category=linear&symbol=ETHUSDT&interval=15&limit=300` (public, no key). The newest row comes first, so reverse it.
- DEX: `POST https://api.hyperliquid.xyz/info` with `{"type":"candleSnapshot","req":{"coin":"ETH","interval":"15m","startTime":<ms>,"endTime":<ms>}}` (public, no key).
- If the request is blocked (for example HTTP 403 by region) or returns fewer bars than needed, ABSTAIN and write why. Never vote on guessed prices. Using a bars file another desk member saved is fine if it lists closed bars with timestamps.

## Default rule

EMA: seed with the simple average of the first N closes, then `ema = close*k + ema*(1-k)` with `k = 2/(N+1)`. Compute EMA9, EMA21, EMA50.

1. Trend gate: LONG if the last closed close is above EMA9, EMA21, and EMA50. SHORT if it is below all three.
2. Momentum gate (used when the trend gate does not decide): five-bar change `(close[-1]-close[-5])/close[-5]`. Above +0.3% and close above EMA9 means LONG. Below -0.3% and close below EMA9 means SHORT.
3. Otherwise ABSTAIN.

Do not use a gain/loss ratio labelled "RSI" as a gate. It is not RSI and it has no place in this rule.

## Invalidation

- The structure invalidation is EMA9 at the voting bar. The vote is withdrawn when a later closed bar closes back through it (below EMA9 for a LONG, above for a SHORT).
- This level is not the exchange stop. Risk owns the stop and the size.

## Discipline

- One vote is not an order. If the desk needs two votes (for example technical plus research), a research ABSTAIN plus one technical vote is still one vote.
- Never vote to add to a position that is already open. If a market already has a position, report only whether its structure still holds.
- An ABSTAIN on an open position is not a close order.
- Never promise profit.

## Output each cycle

Write `strategies/<UTC date>-<HHMM>-votes.md` with, per market: side, last closed bar time (UTC), close, EMA9, EMA21, EMA50, five-bar change, invalidation level, and the reason. Add a failure note when anything went wrong (missing bars, blocked API, stale file) and what was done instead. Post a short summary to the desk.

## Secrets

This skill uses public market data only. It never reads or prints API keys. Keys for other roles live in environment variables, never in files, chat, or the repo.
