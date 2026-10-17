# Security

## Reporting a problem

If you find a way to leak an API key, bypass an automatic LIVE guard (no-withdraw key check, mandatory stop loss, daily loss stop, safety net, max N, kill switch, local bind), get an agent to act on injected text, or loosen a risk cap, please do not open a public issue. Contact the maintainer privately through the GitHub profile of the repository owner, and give us a reasonable time to fix it before you share details.

## What this project promises

- `TRADING_MODE` is `PAPER` by default. `TESTNET` and `LIVE` start only when the exchange confirms the key can trade and cannot withdraw (Hyperliquid: an approved agent wallet, not the main key). This is checked at setup and on every start; otherwise the server exits with code 2. LIVE always binds to 127.0.0.1.
- There is no withdrawal or transfer code. Exchange keys with withdraw permission are refused. On Hyperliquid only an approved API agent wallet is accepted, never the main wallet key.
- Every order, paper or live, goes through the risk gate, the money split, a mandatory stop loss, the daily loss stop and the kill switch. Live orders are sent once and reconciled from the exchange's own record, never blindly retried.
- Exchange keys and secrets live only in `.env` on the server. Reports, logs and webhook payloads pass through the secret redactor.
- Model API keys are read from environment variables on the server. They are never sent to the browser.
- Logs, reports, chat replies and Grok Bot bridge payloads pass through a redaction step that removes key-shaped strings.
- News, posts and market text are treated as untrusted. Lines that look like instructions are removed before prompts are built, and agent output is validated against a JSON schema.

## What you should do

- Keep `.env` out of git (it is in `.gitignore`).
- Never paste keys into chats, issues, or screenshots.
- Use keys with the smallest permissions your provider allows, and rotate any key you think was exposed.
- Exchange keys: trading only, withdrawals off, IP whitelist on. Use a sub-account holding only what you can afford to lose.
- Inbound endpoints (`/api/agent-event`, `/api/tradingview`) need their secrets. Put the server behind HTTPS (a tunnel or reverse proxy) before exposing it to the internet.
