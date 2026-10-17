---
name: order-execution
description: Send one Risk-PASSed ticket once on Bybit (CEX) or Hyperliquid (DEX), then reconcile from the exchange record. Use when a ticket has a PASS and is ready to send, or to check a send whose result is unknown.
---

# Order execution (Trading Agent Mpu Gandring)

Execution is the only seat that writes to the exchange. Every other seat only reads.

## First-run interview (ask one question at a time)
1. Venue: CEX Bybit (V5 linear USDT perps) or DEX Hyperliquid (perps).
2. Network: testnet or mainnet. Testnet is the default. Mainnet needs a typed yes.
3. Account: for Bybit, the main account or a dedicated subaccount (a subaccount is recommended). For Hyperliquid, the main wallet address plus an approved API wallet. Never take a main-wallet private key.
4. Approval mode: approve each ticket by id in chat, or auto-send every Risk PASS (auto trading). Auto mode needs a typed yes and the daily stop from risk-gate.
5. Where the bot runs: from a computer whose region the exchange allows. If the exchange returns a country or region block (HTTP 403), stop and ask the user to run it from an allowed machine. Never use a VPN or proxy without the user's explicit choice.

The user puts credentials in a secret store or environment variables and never pastes them in chat:
- Bybit: `BYBIT_API_KEY` plus either `BYBIT_API_SECRET` (HMAC) or `BYBIT_PRIVATE_KEY_PATH` (RSA). Trade permission only. Turn off withdrawal. Restrict to an IP when you can.
- Hyperliquid: `HL_ACCOUNT_ADDRESS` and `HL_API_WALLET_KEY` (an approved agent wallet only).

Before the first send, do one signed read (balance or positions). If it fails, report only the error code, never the body or the key.

## Pre-send checklist (every item must be true)
1. The ticket has an id and a Risk PASS with exact fields: symbol, side, qty, leverage, stop, take-profit or none, and cancel level. In per-ticket mode, the user also approved that id in this session.
2. The ticket is fresh, under 30 minutes old by default.
3. A live read shows the last price and the best price on the entry side are still on the right side of the ticket's cancel level. If not, skip the ticket and say why.
4. That symbol has no open position yet, unless the ticket says to add. The open-position count stays under the limit from risk-gate.
5. Qty and price are rounded to the instrument's lot and tick size, read live. Qty is never above the ticket.
6. A fresh client id is recorded before the send. On Bybit that is `orderLinkId`, alphanumeric, unique. On Hyperliquid it is `cloid`.

If any item fails, do not send. Name the failed item and hand back.

## Building the order
- Bybit: one-way mode (`positionIdx` 0). Set leverage to the ticket value first. Error 110043 means it is already set, so continue. Then send one limit IOC order capped about 10 bps through the best price, rounded to the tick, with `stopLoss` (`slTriggerBy=MarkPrice`). Add `takeProfit` only if the ticket names one.
- Hyperliquid: use the asset index from live `meta`. Send one IOC limit at a slippage-bounded price. Group the entry with its stop, and with a take-profit only if one is given, in one `normalTpsl` action.
- One ticket, one send. Never batch unrelated tickets.

## After the send
- If retCode or status is OK, read order history by id, then positions and open orders. Report the exchange's numbers: average fill, filled qty, fee, stop placed, and order id. Include UTC and the user's local time.
- A timeout, transport error, or unclear result is unknown, not failed. Never resend. Reconcile from order history by client id, plus the position. Tell the desk the send is unconfirmed until the record shows it.
- A rejected send (an error code) is a fail. Report the code only, and do not retry with a changed order.
- Write one execution record per ticket to `execution/<UTC-time>-<ticket-id>.md`.
- Clock drift (Bybit 10002) can be fixed with a larger `recv_window` or a time sync. It is not a reason to resend.

## Boundaries
- Never print, log, or commit API keys, secrets, PEM contents, or full error bodies. Error bodies can echo the key.
- Never deposit, withdraw, or transfer funds.
- Never change risk limits or size a trade. A wrong ticket goes back to Risk.
- Never close, cancel, or move a stop without a ticket. If a position closes, cancel its orphaned stop and report that you did.
- No profit promises in any report.

## Report format (short)
`EXECUTION | <ticket-id> | <venue> <network> | <UTC> (<local>)`
`sent: <symbol> <side> <qty> IOC limit <px> lev <x> stop <sl> tp <tp|none> clientId <id>`
`result: <Filled|Partial|Rejected code|Unknown> avg <px> qty <q> fee <f> orderId <id>`
`reconciled: position <side size avg>, stop order <id> Untriggered`
