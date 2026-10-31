# Trading Agent Mpu Gandring: Frozen UI, API, CLI, and Asset Contract

Baseline SHA: `a725218a304bc32f5347ed150da9755eb8df7783` | App Version: `0.0.0.4.11` | Package Version: `0.4.11`

## 1. Summary Counts

- React TSX components frozen: **29**
- Interactive JSX controls mapped: **274**
- HTTP routes mapped: **105** (100 main-app + 5 standalone inbound webhook)
- WebSocket server events: **12** (`state`, `speech`, `fight`, `meter`, `verdict`, `log`, `status`, `debate`, `report`, `execution`, `room`, `cendol`)
- CLI `mpu --help` entries: **43** | `gb` subcommands: **24** | session-entry targets: **13**
- Canonical roles: **6** (`lead`, `market`, `research`, `strategist`, `risk`, `execution`)
- Trading venues: **8** (`aster:experimental`, `binance:experimental`, `bybit:verified`, `dydx:experimental`, `hyperliquid:experimental`, `okx:experimental`, `orderly:experimental`, `paradex:experimental`)
- Tracked `web/public` assets hashed: **52**

## 2. Component Inventory

| Component | Screen / Surface | Controls | API Calls | Storage Keys | Owner | Behavior Test |
|---|---|---:|---|---|---|---|
| `AgentPanel` | Office agent side drawer | 14 | `/api/chat/cancel/:param`, `/api/chat/history/:param` | none | `T13` | `tests/rebirth/office-browser.test.ts > agent_chat_history_and_cancel` |
| `Bot` | Office 2.5D character sprite | 0 | none | none | `T13` | `tests/rebirth/office-browser.test.ts > renders_six_agent_identities` |
| `Channels` | Setup section 7 chat channels | 27 | `/api/setup/channels`, `/api/setup/channels/discord-bot`, `/api/setup/channels/discord-sync`, `/api/setup/channels/reset`, `/api/setup/channels/save`, `/api/setup/channels/slack-sync`, `/api/setup/channels/telegram-chats`, `/api/setup/channels/telegram-sync`, `/api/setup/channels/test`, `/api/setup/channels/whatsapp-sync` | none | `T14` | `tests/rebirth/channels.test.ts > channel_setup_and_test_controls` |
| `CodexResearchSetup` | Setup Local Agents MCP research policy | 5 | `/api/setup/local-agents/research` | none | `T06` | `tests/rebirth/research.test.ts > codex_research_policy_roundtrip` |
| `CommandBar` | Top command and emergency bar | 9 | `/api/ops/kill` | none | `T13` | `tests/rebirth/office-browser.test.ts > command_bar_debate_kill_and_commands` |
| `DataSourcesSetup` | Setup optional news and whale sources | 5 | `/api/setup/data-sources` | none | `T06` | `tests/rebirth/research.test.ts > optional_data_sources_save_and_mask` |
| `DeferredPanel` | Error-bounded lazy panel wrapper | 1 | none | none | `T13` | `tests/rebirth/office-browser.test.ts > deferred_panel_recovery_reload` |
| `DeskOps` | Workspace Tools Desk Ops tab | 27 | `/api/ops/auto`, `/api/ops/close`, `/api/ops/kill`, `/api/ops/open`, `/api/ops/size`, `/api/setup/trading` | none | `T13` | `tests/rebirth/api-parity.test.ts > desk_ops_size_open_close_auto_scan` |
| `JevSetup` | Setup Jev advisory connection | 7 | `/api/setup/jev`, `/api/setup/jev/test` | none | `T07` | `tests/rebirth/jev.test.ts > jev_setup_and_connection_probe` |
| `Keris` | Header and studio SVG ornament | 0 | none | none | `T13` | `tests/rebirth/office-browser.test.ts > renders_six_agent_identities` |
| `Lessons` | Workspace Tools Lessons tab | 6 | `/api/ops/:param`, `/api/setup/restart` | none | `T12` | `tests/rebirth/learning.test.ts > account_scoped_lessons_list_and_add` |
| `LocalAgentsSetup` | Setup local CLI agents and login | 15 | `/api/setup/local-agents`, `/api/setup/local-agents/:param`, `/api/setup/local-agents/connect`, `/api/setup/local-agents/models`, `/api/setup/local-agents/settings`, `/api/setup/local-agents/status` | none | `T07` | `tests/rebirth/provider-tools.test.ts > local_cli_discovery_login_and_probe` |
| `MiniCharts` | Portfolio SVG equity and slot bars | 0 | none | none | `T13` | `tests/rebirth/office-browser.test.ts > portfolio_and_open_orders_honesty` |
| `ModelsSetup` | Setup provider, model, and reasoning stack | 13 | `/api/setup/models` | none | `T07` | `tests/rebirth/roles.test.ts > model_change_applies_next_task` |
| `Office` | Main studio scene and workstations | 3 | none | none | `T13` | `tests/rebirth/office-browser.test.ts > renders_six_agent_identities` |
| `OfficeDiscussion` | Studio discussion popover and multi-session chat | 9 | none | none | `T13` | `tests/rebirth/office-browser.test.ts > office_discussion_conversations_and_send` |
| `Panels` | TopBar, TrakteerPopup, TickerStrip, FightMeter, Portfolio, OpenOrders, Verdicts, TradeLog, Roster | 39 | `/api/ops/auto`, `/api/wallet/balance` | `mg-currency`, `mg-wallet-address`, `mg-wallet-network`, `mg-wallet-venue` | `T13` | `tests/rebirth/office-browser.test.ts > topbar_portfolio_verdicts_and_logs` |
| `PreferencesSetup` | Setup desk preferences and paper allocation | 8 | `/api/setup/preferences` | none | `T03` | `tests/rebirth/settings.test.ts > preferences_validation_and_hot_apply` |
| `PriceChart` | Canonical Lightweight Charts and TV toggle panel | 11 | none | none | `T13` | `tests/rebirth/office-browser.test.ts > chart_symbol_tf_selection_and_stream_epoch` |
| `Reports` | Periodic and on-demand desk reports panel | 5 | `/api/reports/now` | none | `T13` | `tests/rebirth/api-parity.test.ts > reports_list_and_generate_now` |
| `SessionLogs` | System log archived diagnostic sessions viewer | 10 | `/api/logs/sessions`, `/api/logs/sessions/:param` | none | `T14` | `tests/rebirth/api-parity.test.ts > session_logs_list_events_and_download` |
| `Setup` | Setup wizard modal and venue/mode/key flow | 26 | `/api/setup`, `/api/setup/doctor`, `/api/setup/guide/:param`, `/api/setup/keys`, `/api/setup/mode`, `/api/setup/venue` | `mg-wallet-network`, `mg-wallet-venue` | `T03` | `tests/rebirth/office-browser.test.ts > setup_wizard_saved_vs_active_status` |
| `Tour` | Interactive guided UI spotlight tour | 5 | none | none | `T14` | `tests/rebirth/office-browser.test.ts > guided_tour_keyboard_and_dismiss` |
| `TradingSetup` | Setup network trading profile and risk limits | 11 | `/api/setup/trading`, `/api/setup/trading/limits` | none | `T03` | `tests/rebirth/settings.test.ts > trading_profile_and_limits_preserve_capital_fields` |
| `TradingViewChart` | Optional browser-only TradingView embed | 0 | none | none | `T13` | `tests/rebirth/office-browser.test.ts > chart_symbol_tf_selection_and_stream_epoch` |
| `UpdateModal` | Self-update status and apply modal | 5 | `/api/update/apply` | none | `T14` | `tests/rebirth/launcher.test.ts > updater_status_and_local_apply` |
| `Wallet` | Delegated DEX wallet connect and agent approval | 9 | `/api/wallet`, `/api/wallet/approve`, `/api/wallet/balance`, `/api/wallet/start` | `mg-wallet-address`, `mg-wallet-network`, `mg-wallet-venue` | `T10` | `tests/rebirth/wallet.test.ts > delegated_wallet_challenge_and_approve` |
| `WalletMenu` | TopBar Connect Wallet dropdown trigger | 2 | none | none | `T10` | `tests/rebirth/office-browser.test.ts > wallet_dropdown_open_and_escape` |
| `WorkspaceTools` | Tabbed container for Book, Ops, Lessons, Logs, History | 2 | none | none | `T13` | `tests/rebirth/office-browser.test.ts > workspace_tools_tabs_and_counts` |

## 3. HTTP Route Contract Inventory

| Method | Path | Mount | Auth | Hot-Apply Semantics | Owner | Error Behavior | Behavior Test |
|---|---|---|---|---|---|---|---|
| `GET` | `/^\/(?!api|ws).*/` | `main-app-spa-fallback` | `public-spa-shell` | `static-asset-serving` | `T01` | Serves built index.html for non-API/WS routes when web bundle is present | `tests/rebirth/office-browser.test.ts > spa_shell_loads_without_console_errors` |
| `DELETE` | `/api/chat/history/:agent/:id` | `main-app` | `local-owner-origin` | `immediate-store-commit` | `T13` | 403 non-local; 400 missing confirm=true or unknown agent; 404 unknown session | `tests/rebirth/api-parity.test.ts > chat_history_read_delete_and_cancel` |
| `GET` | `/api/candles` | `main-app` | `public-read` | `reflects-bybit-hub` | `T13` | 400 invalid symbol or TF; 429 chart busy; 503 canonical Bybit linear candles unavailable (no Binance/sample fallback) | `tests/rebirth/api-parity.test.ts > canonical_candles_endpoint_and_stream_revision` |
| `GET` | `/api/chat/history/:agent` | `main-app` | `local-owner-origin` | `not-applicable` | `T13` | 403 non-local; 400 unknown agent or invalid pagination | `tests/rebirth/api-parity.test.ts > chat_history_read_delete_and_cancel` |
| `GET` | `/api/chat/history/:agent/:id` | `main-app` | `local-owner-origin` | `not-applicable` | `T13` | 403 non-local; 400 invalid params; 404 missing archived session | `tests/rebirth/api-parity.test.ts > chat_history_read_delete_and_cancel` |
| `GET` | `/api/conversations` | `main-app` | `public-read` | `not-applicable` | `T13` | 200 account-scoped conversation list; legacy history read-only | `tests/rebirth/api-parity.test.ts > conversations_list_and_create` |
| `GET` | `/api/gb/lessons` | `main-app` | `bearer-agent-event-secret` | `account-scoped-read` | `T12` | 404 no secret; 401 bad secret; returns only scoped v2 advice, never legacy sample lessons | `tests/rebirth/learning.test.ts > account_scoped_memory` |
| `GET` | `/api/health` | `main-app` | `public-read` | `reflects-active-version` | `T01` | 200 health envelope with explicit unavailable/degraded subsystem state; never reports mock fallback as healthy | `tests/rebirth/runtime-isolation.test.ts > health_and_state_expose_honest_unconfigured_status` |
| `GET` | `/api/jev` | `main-app` | `public-read` | `reflects-active-version` | `T07` | 200 disabled/unavailable Jev status without side effects when off or unconfigured | `tests/rebirth/jev.test.ts > jev_off_does_not_remove_role` |
| `GET` | `/api/logs/sessions` | `main-app` | `local-owner-origin` | `read-only-diagnostic-archive` | `T14` | 403 non-local; 405 non-GET; 429 >120/min; 400 invalid cursor/limit | `tests/rebirth/api-parity.test.ts > session_logs_list_events_and_download` |
| `GET` | `/api/logs/sessions/:id` | `main-app` | `local-owner-origin` | `read-only-diagnostic-archive` | `T14` | 403 non-local; 404 unknown diagnostic session | `tests/rebirth/api-parity.test.ts > session_logs_list_events_and_download` |
| `GET` | `/api/logs/sessions/:id/download` | `main-app` | `local-owner-origin` | `read-only-diagnostic-archive` | `T14` | 403 non-local; 400 invalid file kind; 404 unknown session; path-traversal impossible via enum allowlist | `tests/rebirth/api-parity.test.ts > session_logs_list_events_and_download` |
| `GET` | `/api/logs/sessions/:id/events` | `main-app` | `local-owner-origin` | `read-only-diagnostic-archive` | `T14` | 403 non-local; 400 invalid query or cursor | `tests/rebirth/api-parity.test.ts > session_logs_list_events_and_download` |
| `GET` | `/api/ops/kill` | `main-app` | `local-owner-origin` | `reflects-durable-halt-latch` | `T09` | 403 non-local; returns durable halt latch, source, persistence certainty, and unkill command | `tests/rebirth/stop.test.ts > local_kill_cancels_and_flattens_while_grok_stop_retains_protected_positions` |
| `GET` | `/api/ops/lessons` | `main-app` | `local-owner-origin` | `account-scoped-read` | `T12` | 403 non-local; excludes legacy sample lessons from v2 active prompt memory | `tests/rebirth/learning.test.ts > legacy_lesson_not_used_as_new_evidence` |
| `GET` | `/api/reports` | `main-app` | `public-read` | `not-applicable` | `T13` | 200 recent immutable reports with native financial certainty metadata | `tests/rebirth/api-parity.test.ts > reports_list_and_generate_now` |
| `GET` | `/api/research` | `main-app` | `local-owner-origin` | `uses-bounded-research-host` | `T06` | 403 non-local; 400 unsupported tool/symbol; 503 unavailable without sample/invented substitution | `tests/rebirth/research.test.ts > actual_navigation_and_extraction` |
| `GET` | `/api/research/capabilities` | `main-app` | `local-owner-origin` | `reflects-active-version` | `T06` | 403 non-local; reports honest tool availability and UNSANDBOXED local CLI capability | `tests/rebirth/research.test.ts > capabilities_expose_honest_tool_and_sandbox_status` |
| `GET` | `/api/research/close-review` | `main-app` | `local-owner-origin` | `fresh-exit-evidence-read` | `T08` | 403 non-local; 400 invalid symbol/trigger; 503 evidence unavailable without inferring close authorization | `tests/rebirth/exits.test.ts > close_review_reports_verified_triggers_and_position_identity` |
| `GET` | `/api/research/summary` | `main-app` | `local-owner-origin` | `reflects-active-version` | `T13` | 403 non-local; 400 unsupported summary kind | `tests/rebirth/api-parity.test.ts > research_summary_and_capabilities` |
| `GET` | `/api/setup` | `main-app` | `local-owner-origin` | `returns-saved-active-remote-versions` | `T03` | 403 non-local; 429 rate-limited; secrets always masked | `tests/rebirth/settings.test.ts > setup_status_masks_secrets_and_exposes_versions` |
| `GET` | `/api/setup/channels` | `main-app` | `local-owner-origin` | `reflects-active-version` | `T14` | 403 non-local; masks all channel tokens/secrets | `tests/rebirth/channels.test.ts > channel_setup_and_test_controls` |
| `GET` | `/api/setup/data-sources` | `main-app` | `local-owner-origin` | `reflects-active-version` | `T06` | 403 non-local; masks stored optional enrichment keys | `tests/rebirth/research.test.ts > optional_data_sources_save_and_mask` |
| `GET` | `/api/setup/guide/:venue` | `main-app` | `local-owner-origin` | `not-applicable` | `T03` | 403 non-local; 404 unknown venue | `tests/rebirth/api-parity.test.ts > setup_guides_cover_all_eight_venues` |
| `GET` | `/api/setup/jev` | `main-app` | `local-owner-origin` | `reflects-active-version` | `T07` | 403 non-local; masks JEV_API_KEY | `tests/rebirth/jev.test.ts > jev_setup_and_connection_probe` |
| `GET` | `/api/setup/local-agents` | `main-app` | `local-owner-origin` | `reflects-active-version` | `T07` | 403 non-local; exposes honest UNSANDBOXED capability status for local CLIs | `tests/rebirth/provider-tools.test.ts > local_cli_discovery_login_and_probe` |
| `GET` | `/api/setup/local-agents/research` | `main-app` | `local-owner-origin` | `reflects-active-version` | `T06` | 403 non-local; 503 MCP inspection failure without faking verified status | `tests/rebirth/research.test.ts > codex_research_policy_roundtrip` |
| `GET` | `/api/setup/models` | `main-app` | `local-owner-origin` | `returns-saved-and-active-models` | `T07` | 403 non-local; reports real provider key presence without mock fallback masking | `tests/rebirth/roles.test.ts > no_key_is_unavailable_not_mock` |
| `GET` | `/api/setup/preferences` | `main-app` | `local-owner-origin` | `returns-saved-and-active-preferences` | `T03` | 403 non-local; preserves exact Owner values | `tests/rebirth/settings.test.ts > preferences_validation_and_hot_apply` |
| `GET` | `/api/setup/trading` | `main-app` | `local-owner-origin` | `returns-saved-and-active-trading-profile` | `T03` | 403 non-local; 400 invalid stored profile | `tests/rebirth/settings.test.ts > trading_profile_and_limits_preserve_capital_fields` |
| `GET` | `/api/split` | `main-app` | `public-read` | `reflects-active-version` | `T03` | 400 invalid balance, safetyNet, N, or orderSizePct | `tests/rebirth/api-parity.test.ts > money_split_and_ticket_size_preview` |
| `GET` | `/api/state` | `main-app` | `public-read` | `reflects-active-version` | `T01` | 200 OfficeState snapshot with nullable/UNAVAILABLE financial fields when unverified | `tests/rebirth/runtime-isolation.test.ts > health_and_state_expose_honest_unconfigured_status` |
| `GET` | `/api/trakteer/config` | `main-app` | `local-owner-origin` | `reflects-active-version` | `T14` | 403 non-local client | `tests/rebirth/api-parity.test.ts > trakteer_config_and_sanitized_tip_celebration` |
| `GET` | `/api/update/status` | `main-app` | `public-read` | `not-applicable` | `T14` | 200 version comparison with offline/fetch error reported honestly in status payload | `tests/rebirth/launcher.test.ts > updater_status_and_local_apply` |
| `GET` | `/api/wallet` | `main-app` | `public-read-with-local-gate-flag` | `reflects-active-version` | `T10` | 200 venue capability matrix with available:false reason when non-local | `tests/rebirth/wallet.test.ts > wallet_capabilities_and_balance_read` |
| `GET` | `/api/wallet/balance` | `main-app` | `local-key-entry-access` | `not-applicable` | `T10` | 403 non-local; returns nullable equityUsdt/availableUsdt when unconfigured or unreachable, never fake 0 | `tests/rebirth/wallet.test.ts > wallet_capabilities_and_balance_read` |
| `POST` | `/api/agent-event` | `main-app` | `bearer-agent-event-secret` | `scoped-legacy-compatibility` | `T14` | 404 disabled; 401 bad secret; 429 rate-limited; 400 schema error; never grants Owner scope | `tests/rebirth/api-parity.test.ts > agent_event_and_gb_routes_cannot_impersonate_owner` |
| `POST` | `/api/auto/cycle` | `main-app` | `local-owner-origin` | `uses-active-version-per-cycle` | `T08` | 403 non-local; skips entry when halted or providers unavailable | `tests/rebirth/api-parity.test.ts > auto_cycle_respects_halt_and_active_config` |
| `POST` | `/api/bridge/probe` | `main-app` | `local-owner-origin` | `outbox-probe-only` | `T16` | 403 non-local; reports honest outbound delivery/queued state without claiming bidirectional completion | `tests/rebirth/grok-bridge.test.ts > webhook_200_without_callback_stays_pending` |
| `POST` | `/api/chat/cancel/:id` | `main-app` | `local-owner-origin` | `immediate-cancellation` | `T13` | 403 non-local; 200 idempotent abort of active or unknown request id | `tests/rebirth/api-parity.test.ts > chat_history_read_delete_and_cancel` |
| `POST` | `/api/command` | `main-app` | `local-owner-origin` | `immediate-owner-dispatch` | `T13` | 403 non-local; 400 empty/oversize/unknown agent/bad ids; 409 stale operational session | `tests/rebirth/api-parity.test.ts > owner_command_provenance_and_session_guard` |
| `POST` | `/api/conversations/new` | `main-app` | `local-owner-origin` | `immediate-store-commit` | `T13` | 403 non-local client; 500 redacted store failure | `tests/rebirth/api-parity.test.ts > conversations_list_and_create` |
| `POST` | `/api/debate` | `main-app` | `local-owner-origin` | `uses-active-version-per-cycle` | `T08` | 403 non-local; 409 halted, invalid symbol, or unavailable providers (never fake HOLD success) | `tests/rebirth/debate.test.ts > debate_endpoint_runs_six_roles_without_mock_fallback` |
| `POST` | `/api/gb/agent-close` | `main-app` | `bearer-agent-event-secret` | `uses-active-version-gateway` | `T14` | 404 no secret; 401 bad secret; 400 missing typed trigger/positionId/expectedQty/reason | `tests/rebirth/exits.test.ts > verified_exit_triggers_close_independently_of_entry_gates` |
| `POST` | `/api/gb/agent-open` | `main-app` | `bearer-agent-event-secret` | `uses-active-version-gateway` | `T14` | 404 no secret; 401 bad secret; 400 missing Risk APPROVE or Lead probability_0_1 confidence | `tests/rebirth/cli.test.ts > gb_open_close_cancel_and_lessons_through_gateway` |
| `POST` | `/api/gb/cancel-entry` | `main-app` | `bearer-agent-event-secret` | `uses-active-version-gateway` | `T14` | 404 no secret; 401 bad secret; 400 invalid clientId; reconciles partial fill during cancel | `tests/rebirth/cli.test.ts > gb_open_close_cancel_and_lessons_through_gateway` |
| `POST` | `/api/gb/close` | `main-app` | `bearer-agent-event-secret` | `uses-active-version-gateway` | `T14` | 404 no secret; 401 bad secret; 400 missing target; independent of entry confidence | `tests/rebirth/cli.test.ts > gb_open_close_cancel_and_lessons_through_gateway` |
| `POST` | `/api/gb/lessons` | `main-app` | `bearer-agent-event-secret` | `account-scoped-append` | `T12` | 404 no secret; 401 bad secret; 400 invalid body; 422 learning off or guard-loosening attempt | `tests/rebirth/learning.test.ts > lesson_cannot_mutate_settings` |
| `POST` | `/api/gb/open` | `main-app` | `bearer-agent-event-secret` | `uses-active-version-gateway` | `T14` | 404 no secret; 401 bad secret; 429 rate-limited; 400 invalid ticket; gated by single execution gateway | `tests/rebirth/cli.test.ts > gb_open_close_cancel_and_lessons_through_gateway` |
| `POST` | `/api/gb/scan` | `main-app` | `bearer-agent-event-secret` | `read-only-diagnostic-log` | `T14` | 404 no secret; 401 bad secret; 429 rate-limited | `tests/rebirth/cli.test.ts > gb_open_close_cancel_and_lessons_through_gateway` |
| `POST` | `/api/kill` | `main-app` | `local-owner-origin` | `immediate-durable-halt-and-flatten` | `T09` | 403 non-local; 409 unkill conflict; D09 local Kill latches halt ON, turns Auto OFF, cancels entries, and flattens managed exposure | `tests/rebirth/stop.test.ts > local_kill_cancels_and_flattens_while_grok_stop_retains_protected_positions` |
| `POST` | `/api/logs/client` | `main-app` | `local-owner-origin` | `not-applicable` | `T14` | 403 non-local, 429 over 30/min, 400 invalid client error payload | `tests/rebirth/api-parity.test.ts > client_log_ingest_validates_and_rate_limits` |
| `POST` | `/api/ops/agent-close` | `main-app` | `local-owner-origin` | `verified-exit-gateway-close` | `T08` | 403 non-local; 400 missing typed exit trigger, positionId, expectedQty, or reason | `tests/rebirth/exits.test.ts > verified_exit_triggers_close_independently_of_entry_gates` |
| `POST` | `/api/ops/agent-open` | `main-app` | `local-owner-origin` | `thesis-revalidated-gateway-submit` | `T09` | 403 non-local; 400 missing Risk APPROVE or Lead probability_0_1; rejects invalidated thesis under lock | `tests/rebirth/reversal.test.ts > reversal_after_lock_wait` |
| `POST` | `/api/ops/auto` | `main-app` | `local-owner-origin` | `prepare-then-activate-versioned` | `T03` | 403 non-local; 400 invalid interval/symbols or N outside 1..4; 409 blocked while kill/halt latch is ON | `tests/rebirth/api-parity.test.ts > desk_ops_size_open_close_auto_scan` |
| `POST` | `/api/ops/cancel-entry` | `main-app` | `local-owner-origin` | `account-scoped-entry-cancel` | `T09` | 403 non-local; 400 invalid clientId; protects any partial fill discovered during cancel | `tests/rebirth/protection.test.ts > partial_fill_during_cancel_is_protected` |
| `POST` | `/api/ops/close` | `main-app` | `local-owner-origin` | `account-scoped-owner-close` | `T09` | 403 non-local; 400 missing symbol; never blocked by low entry confidence or full slots | `tests/rebirth/gateway.test.ts > owner_close_not_blocked_by_entry_confidence` |
| `POST` | `/api/ops/kill` | `main-app` | `local-owner-origin` | `immediate-durable-halt-toggle` | `T09` | 403 non-local; 400 missing explicit boolean; 409 unkill conflict; D09 local Kill flattens on engage | `tests/rebirth/stop.test.ts > local_kill_cancels_and_flattens_while_grok_stop_retains_protected_positions` |
| `POST` | `/api/ops/lessons` | `main-app` | `local-owner-origin` | `account-scoped-append` | `T12` | 403 non-local; 400 short/invalid lesson; 422 learning off or guard-loosening text refused | `tests/rebirth/learning.test.ts > lesson_cannot_mutate_settings` |
| `POST` | `/api/ops/open` | `main-app` | `local-owner-origin` | `account-scoped-gateway-submit` | `T09` | 403 non-local; 400 missing stop or invalid GTC clientId; blocked when halted, daily loss hit, or at safety net | `tests/rebirth/gateway.test.ts > journal_before_send_and_mandatory_resting_stop` |
| `POST` | `/api/ops/restart` | `main-app` | `local-owner-origin` | `in-place-or-managed-ipc-restart` | `T14` | 403 non-local; 409 mode/venue change blocked here; 400 invalid config | `tests/rebirth/launcher.test.ts > managed_restart_and_in_place_reload` |
| `POST` | `/api/ops/scan` | `main-app` | `local-owner-origin` | `read-only-proactive-scan` | `T13` | 403 non-local; reports missing stops, daily loss, safety net, authority conflict, and stale feeds | `tests/rebirth/api-parity.test.ts > desk_ops_size_open_close_auto_scan` |
| `POST` | `/api/ops/size` | `main-app` | `local-owner-origin` | `read-only-sizing-preview` | `T13` | 403 non-local; 400 missing symbol/side/stop or invalid quantized size | `tests/rebirth/api-parity.test.ts > money_split_and_ticket_size_preview` |
| `POST` | `/api/reports/now` | `main-app` | `local-owner-origin` | `immediate-report-projection` | `T13` | 403 non-local; 500 redacted storage error | `tests/rebirth/api-parity.test.ts > reports_list_and_generate_now` |
| `POST` | `/api/research/backtest` | `main-app` | `local-owner-origin` | `isolated-sandbox-simulation` | `T12` | 403 non-local; 400 <3 candles or bad params; 503 candle fetch failure; never loads live gateway/signer | `tests/rebirth/sandbox.test.ts > backtest_never_imports_live_gateway` |
| `POST` | `/api/setup/channels/discord-bot` | `main-app` | `local-key-entry-access` | `read-only-bot-inspection` | `T14` | 403 non-local; 400 missing token; 422 Discord API failure with token redacted | `tests/rebirth/channels.test.ts > channel_setup_and_test_controls` |
| `POST` | `/api/setup/channels/discord-sync` | `main-app` | `local-key-entry-access` | `remote-slash-command-registration` | `T14` | 403 non-local; 422 missing credentials or Discord sync error | `tests/rebirth/channels.test.ts > no_real_notification_from_fixture` |
| `POST` | `/api/setup/channels/reset` | `main-app` | `local-key-entry-access` | `clears-channel-and-reloads-supervisor` | `T14` | 403 non-local; 400 unknown channel | `tests/rebirth/channels.test.ts > channel_setup_and_test_controls` |
| `POST` | `/api/setup/channels/save` | `main-app` | `local-key-entry-access` | `prepare-then-activate-channel-config` | `T14` | 403 non-local; 400 bad body; 422 missing required channel fields; retains blank secrets without echoing | `tests/rebirth/channels.test.ts > channel_setup_and_test_controls` |
| `POST` | `/api/setup/channels/slack-sync` | `main-app` | `local-key-entry-access` | `remote-command-verification` | `T14` | 403 non-local; 422 missing webhook/signing config | `tests/rebirth/channels.test.ts > no_real_notification_from_fixture` |
| `POST` | `/api/setup/channels/telegram-chats` | `main-app` | `local-owner-origin` | `read-only-chat-id-lookup` | `T14` | 403 non-local; ok:false when token unset or Telegram getUpdates fails | `tests/rebirth/channels.test.ts > channel_setup_and_test_controls` |
| `POST` | `/api/setup/channels/telegram-sync` | `main-app` | `local-key-entry-access` | `remote-command-registration` | `T14` | 403 non-local; 422 missing token or Telegram API failure | `tests/rebirth/channels.test.ts > no_real_notification_from_fixture` |
| `POST` | `/api/setup/channels/test` | `main-app` | `local-owner-origin` | `outbound-test-via-injected-transport` | `T14` | 403 non-local; 400 unknown channel; 422 channel not configured or delivery failed | `tests/rebirth/channels.test.ts > no_real_notification_from_fixture` |
| `POST` | `/api/setup/channels/whatsapp-sync` | `main-app` | `local-key-entry-access` | `remote-command-verification` | `T14` | 403 non-local; 422 missing WhatsApp Cloud API credentials | `tests/rebirth/channels.test.ts > no_real_notification_from_fixture` |
| `POST` | `/api/setup/data-sources` | `main-app` | `local-key-entry-access` | `prepare-then-activate-versioned` | `T06` | 403 non-local; 400 invalid source or key format; missing optional source never becomes entry veto | `tests/rebirth/research.test.ts > optional_data_sources_save_and_mask` |
| `POST` | `/api/setup/doctor` | `main-app` | `local-owner-origin` | `read-only-permission-and-account-audit` | `T14` | 403 non-local; reports trade/withdraw permission certainty without printing secrets | `tests/rebirth/cli.test.ts > doctor_checks_permissions_without_leaking_secrets` |
| `POST` | `/api/setup/jev` | `main-app` | `local-key-entry-access` | `prepare-then-activate-versioned` | `T07` | 403 non-local; 400 invalid URL/timeout/mode; enabling Jev never places orders | `tests/rebirth/jev.test.ts > jev_setup_and_connection_probe` |
| `POST` | `/api/setup/jev/test` | `main-app` | `local-key-entry-access` | `read-only-probe` | `T07` | 403 non-local; 429 over 3/min; 400 unreachable or unauthenticated Jev endpoint | `tests/rebirth/jev.test.ts > jev_setup_and_connection_probe` |
| `POST` | `/api/setup/keys` | `main-app` | `local-key-entry-access` | `masked-secret-store-and-account-prepare` | `T03` | 403 non-local; 400 main-wallet seed/withdraw-capable key refused; never logs or echoes secret | `tests/rebirth/accounts.test.ts > key_rotation_and_withdraw_permission_refusal` |
| `POST` | `/api/setup/local-agents/connect` | `main-app` | `local-key-entry-access` | `verified-probe-then-activate` | `T07` | 403 non-local; 400 missing CLI or failed JSON probe preserves previous active settings | `tests/rebirth/provider-tools.test.ts > local_cli_discovery_login_and_probe` |
| `POST` | `/api/setup/local-agents/login` | `main-app` | `local-key-entry-access` | `interactive-cli-signin` | `T07` | 403 non-local; 400 CLI binary not installed | `tests/rebirth/provider-tools.test.ts > local_cli_discovery_login_and_probe` |
| `POST` | `/api/setup/local-agents/models` | `main-app` | `local-key-entry-access` | `refreshes-catalog-metadata` | `T07` | 403 non-local; 400 unknown CLI id; 503 metadata refresh failure | `tests/rebirth/provider-tools.test.ts > local_cli_discovery_login_and_probe` |
| `POST` | `/api/setup/local-agents/research` | `main-app` | `local-key-entry-access` | `prepare-then-activate-next-task` | `T06` | 403 non-local; 400 invalid MCP tool names; 503 unconfigured MCP server or secret leak rejected | `tests/rebirth/research.test.ts > codex_research_policy_roundtrip` |
| `POST` | `/api/setup/local-agents/settings` | `main-app` | `local-key-entry-access` | `prepare-then-activate-next-task` | `T07` | 403 non-local; 400 invalid CLI setting value | `tests/rebirth/provider-tools.test.ts > local_cli_discovery_login_and_probe` |
| `POST` | `/api/setup/local-agents/status` | `main-app` | `local-key-entry-access` | `not-applicable` | `T07` | 403 non-local; 400 unknown local agent id | `tests/rebirth/provider-tools.test.ts > local_cli_discovery_login_and_probe` |
| `POST` | `/api/setup/local-agents/test` | `main-app` | `local-key-entry-access` | `read-only-probe` | `T07` | 403 non-local; 429 over 3/min; 400 invalid model or probe failure | `tests/rebirth/provider-tools.test.ts > local_cli_discovery_login_and_probe` |
| `POST` | `/api/setup/mode` | `main-app` | `local-key-entry-access` | `verified-mode-gate-and-account-activate` | `T03` | 403 non-local; 400 missing exact LIVE confirmation phrase, missing trade-only key, or experimental LIVE blocked | `tests/rebirth/launcher.test.ts > local_mode_flow_requires_typed_live_confirmation` |
| `POST` | `/api/setup/models` | `main-app` | `local-key-entry-access` | `prepare-then-activate-next-task` | `T07` | 403 non-local; 400 invalid provider/model/whitespace key; missing key marks role unavailable, never mock | `tests/rebirth/roles.test.ts > model_change_applies_next_task` |
| `POST` | `/api/setup/preferences` | `main-app` | `local-owner-origin` | `prepare-then-activate-versioned` | `T03` | 403 non-local; 400 safetyNet > balance or N outside 1..4; 409 version conflict | `tests/rebirth/settings.test.ts > preferences_validation_and_hot_apply` |
| `POST` | `/api/setup/restart` | `main-app` | `local-owner-origin` | `in-place-or-managed-ipc-restart` | `T14` | 403 non-local; 409 mode/venue change requires dedicated mode/venue flow; 400 invalid config | `tests/rebirth/launcher.test.ts > managed_restart_and_in_place_reload` |
| `POST` | `/api/setup/trading` | `main-app` | `local-owner-origin` | `prepare-then-activate-versioned` | `T03` | 403 non-local; 400 out-of-range fields or N outside 1..4; preset never overwrites safetyNet/minOrderUsdt/maxOrderUsdt | `tests/rebirth/settings.test.ts > trading_profile_and_limits_preserve_capital_fields` |
| `POST` | `/api/setup/trading/limits` | `main-app` | `local-owner-origin` | `prepare-then-activate-versioned` | `T03` | 403 non-local; 400 negative/nonfinite values; 409 version conflict; failed prepare keeps prior activeVersion | `tests/rebirth/settings.test.ts > trading_profile_and_limits_preserve_capital_fields` |
| `POST` | `/api/setup/venue` | `main-app` | `local-key-entry-access` | `account-switch-retains-draining` | `T03` | 403 non-local; 400 unknown venue; 409 prepare failure keeps prior active account; old exposure stays DRAINING | `tests/rebirth/accounts.test.ts > venue_switch_retains_draining_account_monitoring` |
| `POST` | `/api/tradingview` | `main-app` | `body-passphrase-secret` | `untrusted-signal-triggers-debate-only` | `T14` | 404 webhook off; 401 bad passphrase; 400 unknown symbol; 429 >1/min/symbol; never submits order directly | `tests/rebirth/api-parity.test.ts > tradingview_webhook_starts_debate_never_orders` |
| `POST` | `/api/trakteer/tip` | `main-app` | `rate-limited-untrusted-input` | `immediate-ui-event-only` | `T14` | 429 over 20/min; sanitizes untrusted text; never authorizes commands or orders | `tests/rebirth/api-parity.test.ts > trakteer_config_and_sanitized_tip_celebration` |
| `POST` | `/api/trakteer/webhook` | `main-app` | `rate-limited-untrusted-input` | `immediate-ui-event-only` | `T14` | 429 over 20/min; sanitizes untrusted text; never authorizes commands or orders | `tests/rebirth/api-parity.test.ts > trakteer_config_and_sanitized_tip_celebration` |
| `POST` | `/api/unkill` | `main-app` | `local-owner-origin` | `immediate-halt-release-auto-stays-off` | `T09` | 403 non-local; 409 unresolved emergency state; releasing halt never enables Auto or submits orders | `tests/rebirth/launcher.test.ts > unkill_does_not_enable_auto` |
| `POST` | `/api/update/apply` | `main-app` | `local-key-entry-access` | `requires-explicit-restart` | `T14` | 403 non-local or remote host; 200 ok:false when dirty tree or git fast-forward fails | `tests/rebirth/launcher.test.ts > updater_status_and_local_apply` |
| `POST` | `/api/wallet/approve` | `main-app` | `local-key-entry-access` | `prepare-activate-credentials` | `T10` | 403 non-local; 429 rate-limited; 400 expired/replayed/wrong-signer/wrong-chain signature | `tests/rebirth/wallet.test.ts > delegated_wallet_challenge_and_approve` |
| `POST` | `/api/wallet/start` | `main-app` | `local-key-entry-access` | `challenge-only` | `T10` | 403 non-local; 429 rate-limited; 400 refuses secret-like material, unsupported venue, or bad address/chainId | `tests/rebirth/wallet.test.ts > delegated_wallet_challenge_and_approve` |
| `GET` | `/` | `standalone-inbound-webhook` | `public-banner-on-webhook-port` | `inbound-webhook-listener-only` | `T14` | 200 plain-text banner confirming isolated webhook listener exposes no office/setup routes | `tests/rebirth/channels.test.ts > inbound_webhook_listener_isolates_office_routes` |
| `GET` | `/api/channels/whatsapp` | `standalone-inbound-webhook` | `meta-verify-token` | `inbound-webhook-listener-only` | `T14` | 404 inbound off; 403 wrong verify token or malformed hub.challenge | `tests/rebirth/channels.test.ts > whatsapp_challenge_and_hmac_webhook` |
| `POST` | `/api/channels/discord` | `standalone-inbound-webhook` | `ed25519-signature-plus-owner-allowlist` | `inbound-webhook-listener-only` | `T14` | 404 inbound off; 429 rate-limited; 401 bad Ed25519 signature; refuses non-allowlisted user | `tests/rebirth/channels.test.ts > allowlisted_owner_command_matches_current_message` |
| `POST` | `/api/channels/slack` | `standalone-inbound-webhook` | `slack-hmac-raw-body-plus-owner-allowlist` | `inbound-webhook-listener-only` | `T14` | 404 inbound off; 429 rate-limited; 401 bad Slack signature; refuses non-allowlisted user | `tests/rebirth/channels.test.ts > allowlisted_owner_command_matches_current_message` |
| `POST` | `/api/channels/whatsapp` | `standalone-inbound-webhook` | `meta-hmac-sha256-raw-body-plus-owner-allowlist` | `inbound-webhook-listener-only` | `T14` | 404 inbound off; 429 rate-limited; 401 bad X-Hub-Signature-256; ignores non-allowlisted sender | `tests/rebirth/channels.test.ts > whatsapp_challenge_and_hmac_webhook` |

## 4. Settings Field Ownership

### Trading Profile Fields (`TradingFields`)

| Field | Owner | Error Behavior |
|---|---|---|
| `dailyLossLimitPct` | `T03` | 400 when nonfinite or outside 0.5..25% |
| `maxLossPerTradePct` | `T03` | 400 when nonfinite or outside (0, 100]% |
| `minEntryConfidencePct` | `T03` | 400 when nonfinite or outside 0..100%; evaluated only against Lead probability_0_1 |
| `maxLeverage` | `T03` | 400 when non-integer or outside 1..100 |
| `orderSizePct` | `T03` | 400 when present and outside 1.5..100%; preserved across preset switches when set |
| `defaultStopPct` | `T03` | 400 when nonfinite, <=0, or >=100% |
| `minStopPct` | `T03` | 400 when nonfinite, <0, or >=100% |
| `takeProfitPct` | `T03` | 400 when present and <=0 |
| `takeProfitR` | `T03` | 400 when nonfinite or <0 |
| `maxOrderUsdt` | `T03` | 400 when nonfinite or <0; preserved across preset switches |
| `minOrderUsdt` | `T03` | 400 when nonfinite or <0; preserved across preset switches |
| `safetyNet` | `T03` | 400 when nonfinite or <0; preserved across preset switches |
| `maxPositions` | `T03` | 400 when non-integer or outside 1..4 (D11 open; exact saved value preserved) |

### Desk Preference Fields (`PreferencesBody`)

| Field | Owner | Error Behavior |
|---|---|---|
| `appMode` | `T03` | 400 when not local or grokbot |
| `balance` | `T03` | 400 when nonfinite or <0; applies to PAPER book only |
| `safetyNet` | `T03` | 400 when nonfinite, <0, or exceeds paper balance |
| `n` | `T03` | 400 when non-integer or outside 1..4 (D11 open) |
| `dailyLoss` | `T03` | 400 when nonfinite or outside 0.1..100% |
| `auto` | `T03` | 400 when non-boolean; 409 when enabling while halt/kill latch is ON |
| `debateInterval` | `T03` | 400 when non-integer or outside 1..1440 minutes |
| `reportInterval` | `T03` | 400 when non-integer or outside 1..1440 minutes |
| `maxHoldHours` | `T03` | 400 when non-integer or outside 0..720 hours; 0 keeps autonomous duration-only close disabled |

## 5. CLI Dispatch Surface

| `mpu` Command | Syntax | Target Dispatch |
|---|---|---|
| `(default)` | `mpu` | `launcher:start-office` |
| `dev` | `mpu dev` | `npm:run:dev` |
| `restart` | `mpu restart` | `launcher:restart-office` |
| `office` | `mpu office` | `launcher:start-office` |
| `status` | `mpu status` | `cli:setup:status` |
| `version` | `mpu version [args]` | `cli:version` |
| `doctor` | `mpu doctor [args]` | `cli:doctor` |
| `setup` | `mpu setup [args]` | `cli:setup` |
| `link` | `mpu link` | `npm:link` |
| `paper` | `mpu paper` | `cli:setup:paper` |
| `testnet` | `mpu testnet [args]` | `cli:setup:--trading-mode=testnet` |
| `live` | `mpu live [args]` | `cli:setup:--trading-mode=live` |
| `positions` | `mpu positions [args]` | `cli:gb:positions` |
| `account` | `mpu account [args]` | `cli:gb:account` |
| `split` | `mpu split` | `cli:gb:split` |
| `scan` | `mpu scan [args]` | `cli:gb:scan` |
| `report` | `mpu report [args]` | `cli:gb:report` |
| `reports` | `mpu reports [args]` | `cli:gb:reports` |
| `analyze` | `mpu analyze <symbol>` | `cli:debate:--symbol` |
| `debate` | `mpu debate [args]` | `cli:debate` |
| `open` | `mpu open <sym> <side>` | `cli:gb:open` |
| `close` | `mpu close <sym|all>` | `cli:gb:close` |
| `size` | `mpu size [args]` | `cli:gb:size` |
| `market` | `mpu market <sym> [args]` | `cli:gb:market` |
| `candles` | `mpu candles <sym> [tf]` | `cli:gb:candles` |
| `venues` | `mpu venues` | `cli:gb:venues` |
| `health` | `mpu health [args]` | `cli:gb:health` |
| `context` | `mpu context [args]` | `cli:gb:context` |
| `capabilities` | `mpu capabilities [args]` | `cli:gb:capabilities` |
| `research` | `mpu research <tool> <sym> Run shared backend research tool` | `cli:gb:research` |
| `backtest` | `mpu backtest <sym> [args] Run simulation backtest on historical data` | `cli:backtest` |
| `lessons` | `mpu lessons [list|add]` | `cli:gb:lessons` |
| `kill` | `mpu kill [confirm]` | `cli:kill` |
| `unkill` | `mpu unkill [--yes]` | `cli:unkill` |
| `channels` | `mpu channels [args]` | `cli:channels` |
| `trade` | `mpu trade` | `cli:trade` |
| `bench` | `mpu bench [args]` | `cli:bench-models` |
| `test` | `mpu test [args]` | `npm:test` |
| `typecheck` | `mpu typecheck` | `npm:run:typecheck` |
| `build` | `mpu build` | `npm:run:build` |
| `autostart` | `mpu autostart` | `cli:autostart` |
| `gb` | `mpu gb [cmd] [args]` | `cli:gb` |
| `--no-open` | `mpu --no-open` | `launcher:start-office` |
