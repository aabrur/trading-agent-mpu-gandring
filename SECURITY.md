# Security

## Reporting a problem

If you find a way to leak an API key, bypass the paper-only switch, get an agent to act on injected text, or loosen a risk cap, please do not open a public issue. Contact the maintainer privately through the GitHub profile of the repository owner, and give us a reasonable time to fix it before you share details.

## What this project promises

- `TRADING_MODE` must be `PAPER`. Any other value makes the server exit with code 2.
- There is no code here that places real orders, signs exchange requests, or moves funds.
- Model API keys are read from environment variables on the server. They are never sent to the browser.
- Logs, reports, chat replies and Grok Bot bridge payloads pass through a redaction step that removes key-shaped strings.
- News, posts and market text are treated as untrusted. Lines that look like instructions are removed before prompts are built, and agent output is validated against a JSON schema.

## What you should do

- Keep `.env` out of git (it is in `.gitignore`).
- Never paste keys into chats, issues, or screenshots.
- Use keys with the smallest permissions your provider allows, and rotate any key you think was exposed.
- If you build a live adapter yourself, keep it in a separate module, turn off withdrawal permission on exchange keys, and require a human to approve orders.
