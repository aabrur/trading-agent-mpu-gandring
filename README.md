# Trading Agent Mpu Gandring

<p align="center">
  <img src="web/public/mpu-gandring-logo.webp" alt="Trading Agent Mpu Gandring" width="240" />
</p>

**App v0.0.0.4.5 · Node.js 24 recommended · MIT**

A local trading desk with six agent roles: Desk Lead, Market Analyst, Research Analyst, Strategist, Risk Manager, and Execution Trader. The Office brings together market analysis, debates, positions, reports, and persistent diagnostic logs.

A fresh installation starts in **PAPER**, uses mock agents, and leaves **Auto Trading off**. Exchange and model API keys are optional for getting started. Public market-data requests may still use the network.

## Install and open

Install [Node.js](https://nodejs.org/) and Git first. Node.js 24 matches the version used by this repository's CI.

**Windows PowerShell**

```powershell
git clone https://github.com/aabrur/trading-agent-mpu-gandring.git
cd trading-agent-mpu-gandring
npm.cmd ci
node bin/mpu.mjs
```

**macOS / Linux**

```sh
git clone https://github.com/aabrur/trading-agent-mpu-gandring.git
cd trading-agent-mpu-gandring
npm ci
node bin/mpu.mjs
```

The first launch builds the application, creates a local PAPER configuration, and opens **[http://127.0.0.1:8787/#setup](http://127.0.0.1:8787/#setup)**. The built Office and backend share port `8787` by default. A later launch reuses your saved configuration.

No global installation is required. From the project directory, run `node bin/mpu.mjs` again whenever you want to open the Office. Keep that terminal running while you use the desk.

Optional: run `npm link` once to register the shorter `mpu` command. On Windows, use `npm.cmd link` if PowerShell blocks `npm.ps1`.

## First setup

1. Open **Setup** in the Office.
2. Keep **PAPER** selected while you explore. Mock agents work without model keys; connect your model provider or an installed local agent when ready.
3. Choose the paper balance, capital reserve, position count, and other settings yourself.
4. Use **Start debate** or enter `analyze BTCUSDT` in the command bar.
5. Open **Log → Archived sessions** to inspect the current run or a previous session. Trade and conversation history remain in **History**.

The terminal wizard is available through `npm run setup`. If you installed the optional global command, `mpu setup` opens that terminal wizard.

Enter credentials through the hidden terminal prompts or masked Setup fields. Never paste keys into chat or commit them. Use trade-only credentials with withdrawal and transfer permissions disabled; never provide a main wallet private key or seed phrase.

For a venue account, follow the [venue setup guide](docs/setup/README.md), run `npm run doctor`, and verify TESTNET before choosing LIVE. **LIVE uses real money and can lose it.** When Auto Trading is enabled, decisions can execute without per-order approval. Read [live trading](docs/live-trading.md) before enabling it.

## What is available

| Area | Current behavior |
| --- | --- |
| Trading desk | Six agent roles, structured debates, Owner-selected settings, execution, reconciliation, and reporting |
| Models | Mock provider, cloud model APIs, and supported installed local agent CLIs; optional Jev decision sidecar |
| Market context | Market snapshots, technical analysis, Alpha Factors, and SMC included in tactical context |
| Session diagnostics | Startup/shutdown metadata, ordered events, readable console/error logs, correlation IDs, redaction, rotation, and historical browsing |
| Financial records | Execution journals, financial evidence, trade reviews, and reports remain separate from diagnostic logs |
| Historical research | Point-in-time backtesting with fee/funding reconciliation, LONG/SHORT support, liquidation accounting, and documented candle-based execution conventions |
| Predictive research | Seeded statistical GBM simulations with quantiles and TP/SL/no-hit probabilities; no pretrained Kronos inference or automatic connection to LIVE decisions |
| Additional libraries | Harmonic geometry, adversarial synthesis, archetypes, calibration, rejection caching, typed event bus, inventory skew, and standalone precision/protection/supervisor helpers; their presence does not mean they are active in the execution path |

Simulation results and past trades do not establish future returns. This repository does not promise profit.

### Venue support

These labels describe the current adapter contract in the source, not an independent certification of a venue or account.

| Venue | Repository status | Setup |
| --- | --- | --- |
| Bybit | Implemented; covered by mocked exchange tests | [Guide](docs/setup/bybit.md) |
| Binance | Experimental | [Guide](docs/setup/binance.md) |
| OKX | Experimental | [Guide](docs/setup/okx.md) |
| Hyperliquid | Experimental | [Guide](docs/setup/hyperliquid.md) |
| Aster | Experimental | [Guide](docs/setup/aster.md) |
| dYdX v4 | Experimental; additional SDK required | [Guide](docs/setup/dydx.md) |
| Paradex | Experimental | [Guide](docs/setup/paradex.md) |
| Orderly | Experimental | [Guide](docs/setup/orderly.md) |

Existing exchange protections and startup permission checks remain in place. Confirm the actual exchange-side stop status for your positions; an unavailable verification result is not confirmation.

## Daily use

| Action | How |
| --- | --- |
| Open the built Office | `node bin/mpu.mjs` |
| Open without launching a browser | `node bin/mpu.mjs --no-open` |
| Configure models, venue, mode, or channels | **Setup**, or `npm run setup` |
| Inspect masked configuration | `npm run setup -- status` |
| Check configured permissions/connectivity | `npm run doctor` |
| Read account / positions | `npm run gb -- account --json` / `npm run gb -- positions --json` |
| Generate a report | **Reports → Report now**, or `npm run gb -- report` |
| Read persistent diagnostics | **Log → Archived sessions** |
| Pause debate activity | `pause`; this does not close positions |
| Close positions | **Close all** or the position controls |
| Emergency action | **Kill**; distinct from Pause, Close all, and ordinary server shutdown |
| Release emergency kill | **mpu unkill**; releases the kill switch in memory without restarting |
| Check version and health | **mpu version** (--json, --short, -v) / **mpu health** |
| Global CLI shortcut link | **mpu link** (or **npm link**); makes mpu executable from any folder |
| Account money trade allocation | **mpu split** |
| Market and research queries | **mpu market <sym>**, **mpu research <tool> <sym>**, **mpu backtest <sym>** |

`npm run trade` starts the trading supervisor. In local mode, it **forces Auto Trading on for that run** and uses the saved trading mode. In Grok Bot mode, it starts the Office for the remote team. It is not needed for the first-run walkthrough.

Ctrl+C stops the launcher/server. It does not invoke the Kill Switch. Position protection and exchange-side outcomes must be checked separately.

### Where data lives

| Path | Contents |
| --- | --- |
| `.env` | Local configuration and secrets; ignored by Git |
| `data/logs/sessions/` | Session metadata and rotated diagnostic streams |
| `data/execution-*.json` | Execution ownership, intents, positions, and fill checkpoints |
| `data/execution-*.json.financial.json` | Financial evidence |
| `data/conversations.json` | Persisted conversations |
| `data/learnings.json` | Recorded lessons |
| `reports/` | Periodic reports, debate reports, and review journal |

Diagnostic logs have no automatic deletion policy. See [session logs](docs/session-logs.md) for storage settings, export, access restrictions, and crash-recovery limits.

## Development and verification

```sh
npm run dev
```

Development uses two services: Office at `http://127.0.0.1:5173`, backend at `http://127.0.0.1:8787`. Open the Office URL yourself. This differs from the single-port built launcher.

```sh
npm run typecheck
npm test
npm run build
npm run stage-gate
```

The stage gate independently executes typecheck, the complete test suite, and build. It saves command outputs, exit codes, and source fingerprints in a temporary evidence directory. Historical roadmap PASS files are not current execution evidence. See [independent verification](docs/roadmap/independent-verification.md).

The Python statistical worker tests require a working `python` command. Running the desk does not require activating that worker.

For the isolated archive browser check, see [session-log verification](docs/session-logs.md). Keep production credentials and an active trading process separate from development and test runs.

To update an installation, choose a maintenance window, then use `git pull --ff-only`, `npm ci`, and `npm run build` before starting the updated desk. Do not replace files underneath an active watched trading process.

## Guides

- [Local model setup and operation](docs/local-mode.md)
- [Installed local agent CLIs](docs/local-agents.md)
- [Venue setup](docs/setup/README.md)
- [Trading settings](docs/setup/trading-profiles.md)
- [Live trading and exchange protections](docs/live-trading.md)
- [Channels: Telegram, Discord, Slack, WhatsApp](docs/channels.md)
- [Grok Bot mode](docs/grokbot-mode.md) and [installation on the bot's computer](grokbot/INSTALL.md)
- [Session logs](docs/session-logs.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md) and [security reports](SECURITY.md)

## Mulai cepat

Pasang Node.js 24 dan Git, lalu jalankan perintah instalasi di atas. Untuk PowerShell, gunakan `npm.cmd ci`. Perintah `node bin/mpu.mjs` membangun aplikasi dan membuka Office di `http://127.0.0.1:8787`.

Instalasi baru memakai **PAPER**, agen mock, dan **Auto Trading mati**. `npm link` hanya pilihan untuk menambahkan perintah singkat `mpu`. Setup tersedia di Office atau lewat `npm run setup`; `mpu setup` adalah wizard terminal.

Pilih pengaturan modal dan trading sendiri. Isi kredensial hanya di input lokal yang tersembunyi atau bertopeng. Mulai dari PAPER, periksa TESTNET, lalu pilih LIVE hanya saat memang ingin memakai uang sungguhan. Dalam mode lokal, `npm run trade` menyalakan Auto Trading untuk proses tersebut sesuai mode trading yang tersimpan.

**Log → Archived sessions** menampilkan sesi aktif dan arsip yang dapat dicari, difilter, dan diunduh. **History** tetap terpisah untuk riwayat transaksi dan percakapan. Panduan rinci tersedia pada daftar tautan di atas.

## License and credits

[MIT](LICENSE), copyright 2026 Abrur Alaina. Charts use TradingView Lightweight Charts under Apache 2.0. Fonts include Nunito, Fredoka, JetBrains Mono, and Bangers.
