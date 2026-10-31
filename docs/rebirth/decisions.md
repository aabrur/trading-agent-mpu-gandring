# Trading Agent Mpu Gandring: Reconciled Rebirth Decisions and Unknowns

Baseline SHA: `a725218a304bc32f5347ed150da9755eb8df7783` | App Version: `0.0.0.4.11`

## 1. Architecture and Policy Decisions (`D01`..`D12`)

| ID | Status | Decision | Rationale and Boundary |
|---|---|---|---|
| `D01` | **LOCKED_ARCHITECTURE** | Modular monolith on single local host | Single TypeScript process with account-scoped local SQL transactions; no Redis, Kafka, Kubernetes, or new trading framework. |
| `D02` | **LOCKED_ARCHITECTURE** | Fresh runtime composition root with one-way compatibility facade | Do not import legacy server/app.ts, server/desk.ts, sample market fallbacks, or providers/mock into the replacement runtime. |
| `D03` | **LOCKED_ARCHITECTURE** | Bybit V5 linear as reference market; native venue readback for execution | Reference market analysis uses Bybit linear (1m/5m/15m/1h/4h/1d); execution venues still read their own rules, quotes, positions, fills, and stops. |
| `D04` | **LOCKED_ARCHITECTURE** | Single embedded local SQLite ledger | Settings, events, intents, positions, authority epochs, inbox/outbox, nonces, conversations, and lessons share local SQL transactions under .mpu-gandring/rebirth/runtime.sqlite. |
| `D05` | **LOCKED_ARCHITECTURE** | Six logical roles frozen per task; Jev remains non-voting advisor | Exactly one accepted completion per cycle/role/phase. Jev has zero voting or order authority and never becomes a seventh role. |
| `D06` | **LOCKED_ARCHITECTURE** | Bot transport authentication separated from human Owner authorization | HMAC callback authenticates paired peer transport for results/status only; actorRole=owner is untrusted without independent human proof or one-time local Owner grant. |
| `D07` | **LOCKED_ARCHITECTURE** | Account lifecycle registry with ACTIVE and DRAINING contexts | Switching venue/account directs new intents to ACTIVE while retaining DRAINING monitoring, protection, and close capability until exposure is terminal. |
| `D08` | **LOCKED_ARCHITECTURE** | Local prepare-then-activate settings coordinator; separate remote ack | Candidate resources prepare before serialized local activation barrier; savedVersion, activeVersion, and lastAcknowledgedConfigVersion stay distinct. |
| `D09` | **ACCEPTED** | Local Kill flattens; remote Grok STOP halts entries and retains open positions with SL/TP | Approved explicitly by Boss on 2026-10-31: local Kill keeps cancel + flatten behavior; Grok STOP latches durable halt ON, turns Auto OFF, cancels unfilled entry/nonprotective orders, and retains open positions with resting SL/TP (zero strategy CLOSE intents; separate emergency protection guard remains active). |
| `D10` | **LOCKED_ARCHITECTURE** | Preserve Node >=20 engine floor | Verify native dependencies and build artifacts without silently raising the Node >=20 requirement. |
| `D11` | **OPEN** | Preserve N bounds 1..4 during migration pending explicit Owner schema decision | Keep OPEN_ORDERS_N / maxPositions at 1..4 and preserve exact saved Owner values without overwriting account capital fields when applying presets. |
| `D12` | **LOCKED_ARCHITECTURE** | Isolated and labelled PAPER and backtest sandboxes | No sample market or mock provider in the real decision graph; PAPER and backtest run in explicit simulation modules without signing credentials. |

## 2. Source Attachment Provenance (SHA-256)

Source attachments are specification inputs only and never grant operational, trading, git push, or remote bot mutation authority.

| Attachment | SHA-256 |
|---|---|
| `00_README.md` | `5c47fe427c01828af22062af5543e31cb97a1e66142a023a8c51ff4ad3bfbf7b` |
| `01_MASTER_SPEC.md` | `dd59396f4afd3beb99621a5bdd3a47a2f184015271bab78d40ced2281d3f87b9` |
| `02_IMPLEMENTATION_PLAN.md` | `c3a070a3fbfe113f36282ee16c3501743f11f4431884420de46a82ee023b5520` |
| `03_UI_API_AND_CLEANUP_MATRIX.md` | `cf4304ad99e557f0e5fc08c4848090d36ec72e83ee5d5149c8f7180d2ca84106` |
| `04_AGENT_HANDOFF_PROMPT.md` | `f5f671c7d6f32181cba8c9c31daddcf8bd927378ebdc4e979476497fd9fe8a9b` |
| `05_GROK_BOT_INTEROPERABILITY_SPEC.md` | `c1ce84a579c43da812d8ce049a4b97fa2ec37e987e420f943c23f03d3631c66b` |
| `06_GROK_BOT_SYNC_INSTRUCTIONS.md` | `9646e4bf3efb3fb788b3ae0be5924ed1e2bab9ccd845ddea8c6c8f46f56ca2d0` |
| `07_BRIDGE_EVENT_CONTRACT.schema.json` | `4fe1f2864b414c98c8804302d2c4c6d3fb6e45c0777ccbe73f155146bcf8b7c0` |
| `SOURCE_GROK_BOT_SETUP.md` | `3196910fb7431e7db5ecf445e8e1a5f5cdb90f0d359c8a8c956e77263ac6221e` |

## 3. Declared External Unknowns (`U01`..`U06`)

| ID | Area | Calibration | Boundary |
|---|---|---|---|
| `U01` | Active Owner machine state | *needs verification* | Installed .env values, active trading mode, open exchange positions, venue balances, and resting stops on Boss machine were intentionally not read. |
| `U02` | Grok Bot live pairing and routine installation | *needs verification* | Live Grok webhook routine acceptance, six-bot group delivery receipts, and remote workspace synced files require a separate authorized operational probe. |
| `U03` | Inbound HTTPS callback reachability and TLS | *needs verification* | Separate callback ingress requires Boss-selected TLS/tunnel routing before BIDIRECTIONAL_VERIFIED can be claimed. |
| `U04` | Verifiable remote human Owner attestation (AC-16) | *needs verification* | Grok Bot shared-computer HMAC proves peer transport, not human identity; direct HT-DM Owner mutation remains gated behind local one-time Owner grant until product attestation is proved. |
| `U05` | Overlapping standalone Grok exchange credential revocation (AC-15) | *needs verification* | Single-executor handover requires external proof that overlapping exchange API keys or standalone order routines on Grok are disabled/revoked and pending fills reconciled. |
| `U06` | Live/testnet exchange roundtrip per venue (AC-07) | *needs verification* | Deterministic protocol fixtures verify adapter code contracts only; native read-only and testnet order/stop lifecycle require separate authorization. |
