# Security

## Reporting a problem

If you find a way to leak an API key, bypass the LIVE unlock (testnet pass, no-withdraw key check, typed confirmation), get an agent to act on injected text, or loosen a risk cap, please do not open a public issue. Contact the maintainer privately through the GitHub profile of the repository owner, and give us a reasonable time to fix it before you share details.

## What this project promises

- `TRADING_MODE` is `PAPER` by default. `LIVE` starts only when a signed unlock state proves a testnet round trip passed, the mainnet key cannot withdraw (checked on the exchange), and a person typed the confirmation phrase in the CLI. Otherwise the server exits with code 2. The key is checked again on every LIVE start.
- There is no withdrawal or transfer code. Exchange keys with withdraw permission are refused. On Hyperliquid only an approved API agent wallet is accepted, never the main wallet key.
- Every order, paper or live, goes through the risk gate, the money split, a mandatory stop loss, the daily loss stop and the kill switch. Live orders are sent once and reconciled from the exchange's own record, never blindly retried.
- Exchange keys and secrets live only in `.env` on the server. The unlock state stores a fingerprint, never a key.
- Model API keys are read from environment variables on the server. They are never sent to the browser.
- Logs, reports, chat replies and Grok Bot bridge payloads pass through a redaction step that removes key-shaped strings.
- News, posts and market text are treated as untrusted. Lines that look like instructions are removed before prompts are built, and agent output is validated against a JSON schema.

## What you should do

- Keep `.env` out of git (it is in `.gitignore`).
- Never paste keys into chats, issues, or screenshots.
- Use keys with the smallest permissions your provider allows, and rotate any key you think was exposed.
- Exchange keys: trading only, withdrawals off, IP whitelist on. Use a sub-account holding only what you can afford to lose.
- Inbound endpoints (`/api/agent-event`, `/api/tradingview`) need their secrets. Put the server behind HTTPS (a tunnel or reverse proxy) before exposing it to the internet.
