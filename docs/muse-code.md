# Muse Code (Meta)

Muse Code is Meta's terminal coding agent. The command is `muse`. It runs on **the owner's computer**, like Claude Code or Codex. It is not Grok Bot mode.

Do not follow [grokbot/BOOTSTRAP.md](../grokbot/BOOTSTRAP.md). Grok Bot clones and trades on Grok Bot's computer. Muse Code sets up and runs the desk on this machine.

The consumer app at https://muse.ai/ is a personal agent. For this repo use **Muse Code**.

Official product page: https://dev.meta.ai/

## Install Muse Code

You need Node.js 20+ and git on this computer. Muse Code itself is a separate CLI.

macOS or Linux:

```bash
curl -fsSL https://dev.meta.ai/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://dev.meta.ai/install.ps1 | iex
```

Sign in with a Meta developer account when `muse` asks (browser or API key). CI can set `META_API_KEY`. Account, quotas and billing stay with Meta. This repo does not ship a Muse plugin.

## Get the desk

```bash
git clone https://github.com/aabrur/trading-agent-mpu-gandring.git
cd trading-agent-mpu-gandring
npm install
```

Then in that folder:

```bash
muse
```

Tell Muse:

> Read AGENTS.md and follow it exactly to set up Trading Agent Mpu Gandring for me.

A one-file pointer also exists at [MUSE.md](../MUSE.md).

## What Muse must do

Same protocol as every local agent in [AGENTS.md](../AGENTS.md):

1. PAPER first. TESTNET next. LIVE last, only if the owner asks, with the owner typing `I understand LIVE trades real money`.
2. One venue question at a time. One direct link per step (`npm run setup -- guide <venue>`).
3. Keys never in the Muse chat. The owner types them into `npm run setup` (hidden prompts), the office Setup wizard at `http://127.0.0.1:5173/#setup`, or `.env`. If a key appears in chat, tell them to revoke it.
4. Refuse main wallet private keys, seed phrases, and any key that can withdraw.
5. Run `npm run doctor`. It must say the key can trade and cannot withdraw.
6. After the first TESTNET or LIVE order, confirm the stop is resting on the exchange (`npm run gb -- positions`).

## Run the office (local mode)

```bash
npm run setup
npm run doctor
npm run dev
```

Or, after `npm link`:

```bash
mpu
```

- Backend health: http://127.0.0.1:8787/api/health
- Office UI in dev: http://127.0.0.1:5173
- Production launcher `mpu` / `npm start` serves the built UI on port 8787

Do not expose the office to the internet in LIVE. It binds `127.0.0.1`.

## Supervisor only

If Muse should watch a desk that is already running, use the shell poll commands in [AGENTS.md](../AGENTS.md#head-supervisor-the-desk-lead-or-your-own-ai-agent). Forbidden without the owner asking: opening or closing orders, switching mode, releasing the kill switch, reading `.env`.

## Not supported

- Using Muse as a seventh trading employee. The desk has six roles.
- Putting exchange keys into Muse chat or into a Muse skill file.
- Running Grok Bot CreateAgent, Grok Bot secret cards, or `/workspace/...` paths. Those are Grok Bot only.
- Treating Muse Wonder / Muse Spark API keys as exchange keys.
