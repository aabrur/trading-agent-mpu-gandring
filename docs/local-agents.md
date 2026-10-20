# Existing agents in Trading Agent Mpu Gandring

Run `mpu`, open Setup, and expand **Connect an agent you already use**. Installed means the executable was found on PATH. **Test connection** runs a small JSON reply through the agent's own model account; only a valid reply marks it verified for that browser session.

| Agent | Native sign-in | Model selection |
| --- | --- | --- |
| Codex | `codex login` | Configured model, GPT-6 Astra, GPT-6.1 Sol |
| Claude Code | `claude auth login` | Configured model, Opus, Sonnet |
| Pi | `pi`, then `/login` | Pi's configured provider/model |
| Kimi Code | `kimi login` | Kimi's configured model |
| Kilo | `kilo auth login` | Kilo's configured provider/model |
| Cline | `cline auth` | Cline's configured provider/model |
| Grok Build | `grok login` | Grok's configured model |

After signing in and testing, choose **Agent on this computer**, then the local agent and model. Enable per-agent customization to mix connections. Save and apply to restart. Account eligibility, available models, quotas and billing are controlled by each agent's provider. The desk does not read or copy its OAuth tokens. Login opens an interactive terminal; Linux needs a terminal emulator. An agent available only as an editor extension needs its CLI installed first.

Calls run from a fresh temporary directory with a restricted environment, bounded output and a two-minute timeout. Prompts are not executed by a shell. Native tool restrictions are applied: Codex read-only with shell execution disabled, Claude Code/Pi without tools, Kimi with an empty tool profile, Kilo with permissions denied, Cline in plan mode with auto-approval off, and Grok with tools denied. Installed versions must support these flags; failures return through the existing safe HOLD/REJECT path. Structured replies still pass the same schema and risk gates. Calls are serialized to avoid launching six heavy CLI processes at once.

Antigravity, Muse Code and other desktop agents with terminal access can supervise through the existing shell/HTTP protocol in [AGENTS.md](../AGENTS.md#head-supervisor-the-desk-lead-or-your-own-ai-agent). Their desktop sessions are not exposed as a model API by this integration. Muse Code setup for this repo: [muse-code.md](muse-code.md). The UI provides the supervisor instructions. Grok Bot teams use [grokbot/INSTALL.md](../grokbot/INSTALL.md) and run on Grok Bot's computer, not this laptop.

CLI interfaces checked on 2026-10-17 against installed command help and official sources:

- [Codex CLI](https://developers.openai.com/codex/cli)
- [Claude Code CLI](https://code.claude.com/docs/en/cli-reference)
- [Pi CLI](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/cli.md)
- [Kimi agent tool boundaries](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/agents.html)
- [Kilo CLI](https://kilo.ai/docs/code-with-ai/platforms/cli), [permissions](https://kilo.ai/docs/customize/agent-permissions)
- [Cline CLI](https://docs.cline.bot/cline-cli/overview)
- [Grok headless mode](https://docs.x.ai/build/cli/headless-scripting)
