---
name: market-scan
description: Read-only market snapshot for the desk's watchlist on the venue the user picked during setup (CEX Bybit or DEX Hyperliquid). Use before any strategy vote or when the user asks for prices.
---

# Market scan (read-only)

Never place, size, or approve orders. Never invent a price: every number comes from a live public endpoint, cited with UTC and the user's local time. No API keys are needed or allowed here.

## Inputs (from setup interview)
- `VENUE`: `bybit` (CEX, linear USDT perps) or `hyperliquid` (DEX perps).
- `WATCHLIST`: e.g. ETH, SOL, AVAX, LINK. Read-only symbols (e.g. BTC) are scanned but never traded.
- `READ_HOST`: the computer that can reach the venue. Bybit blocks some cloud regions (CloudFront 403); if so, run reads from the user's own computer.

## Fields per symbol
last, mark, 24h change, funding rate, open interest, best bid/ask, and the latest CLOSED 15-minute candles (a bar is closed when open + 15 min <= server time). Default history: 300 closed bars.

## Bybit V5 (public, no key)
- Server time: `GET https://api.bybit.com/v5/market/time`
- Ticker: `GET https://api.bybit.com/v5/market/tickers?category=linear&symbol=ETHUSDT` -> lastPrice, markPrice, price24hPcnt, fundingRate, openInterest, bid1Price, ask1Price
- Candles: `GET https://api.bybit.com/v5/market/kline?category=linear&symbol=ETHUSDT&interval=15&limit=301` (newest first; drop any bar not yet closed)

## Hyperliquid (public, no key)
- `POST https://api.hyperliquid.xyz/info` body `{"type":"metaAndAssetCtxs"}` -> markPx, midPx, funding, openInterest, prevDayPx per coin
- Book: body `{"type":"l2Book","coin":"ETH"}`
- Candles: body `{"type":"candleSnapshot","req":{"coin":"ETH","interval":"15m","startTime":<ms>,"endTime":<ms>}}`

## Output
Write a brief to `briefs/YYYY-MM-DD-HHMMSS-<symbols>.md` plus a CSV of closed bars, then post a short summary: one line per symbol, source and timestamp. If the venue is unreachable, say so once and stay quiet until it changes.
