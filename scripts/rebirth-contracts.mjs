#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { API } from 'typescript/unstable/sync';
import {
  SyntaxKind,
  isArrayLiteralExpression,
  isCallExpression,
  isIdentifier,
  isJsxAttribute,
  isJsxExpression,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isRegularExpressionLiteral,
  isStringLiteral,
  isSwitchStatement,
  isTemplateExpression,
  isVariableDeclaration,
  isFunctionDeclaration
} from 'typescript/unstable/ast';

export const BASELINE_SHA = 'a725218a304bc32f5347ed150da9755eb8df7783';

const SOURCE_ATTACHMENT_HASHES = [
  { file: '00_README.md', sha256: '5c47fe427c01828af22062af5543e31cb97a1e66142a023a8c51ff4ad3bfbf7b' },
  { file: '01_MASTER_SPEC.md', sha256: 'dd59396f4afd3beb99621a5bdd3a47a2f184015271bab78d40ced2281d3f87b9' },
  { file: '02_IMPLEMENTATION_PLAN.md', sha256: 'c3a070a3fbfe113f36282ee16c3501743f11f4431884420de46a82ee023b5520' },
  { file: '03_UI_API_AND_CLEANUP_MATRIX.md', sha256: 'cf4304ad99e557f0e5fc08c4848090d36ec72e83ee5d5149c8f7180d2ca84106' },
  { file: '04_AGENT_HANDOFF_PROMPT.md', sha256: 'f5f671c7d6f32181cba8c9c31daddcf8bd927378ebdc4e979476497fd9fe8a9b' },
  { file: '05_GROK_BOT_INTEROPERABILITY_SPEC.md', sha256: 'c1ce84a579c43da812d8ce049a4b97fa2ec37e987e420f943c23f03d3631c66b' },
  { file: '06_GROK_BOT_SYNC_INSTRUCTIONS.md', sha256: '9646e4bf3efb3fb788b3ae0be5924ed1e2bab9ccd845ddea8c6c8f46f56ca2d0' },
  { file: '07_BRIDGE_EVENT_CONTRACT.schema.json', sha256: '4fe1f2864b414c98c8804302d2c4c6d3fb6e45c0777ccbe73f155146bcf8b7c0' },
  { file: 'SOURCE_GROK_BOT_SETUP.md', sha256: '3196910fb7431e7db5ecf445e8e1a5f5cdb90f0d359c8a8c956e77263ac6221e' }
];

const DECISIONS = [
  {
    id: 'D01',
    status: 'LOCKED_ARCHITECTURE',
    title: 'Modular monolith on single local host',
    summary: 'Single TypeScript process with account-scoped local SQL transactions; no Redis, Kafka, Kubernetes, or new trading framework.'
  },
  {
    id: 'D02',
    status: 'LOCKED_ARCHITECTURE',
    title: 'Fresh runtime composition root with one-way compatibility facade',
    summary: 'Do not import legacy server/app.ts, server/desk.ts, sample market fallbacks, or providers/mock into the replacement runtime.'
  },
  {
    id: 'D03',
    status: 'LOCKED_ARCHITECTURE',
    title: 'Bybit V5 linear as reference market; native venue readback for execution',
    summary: 'Reference market analysis uses Bybit linear (1m/5m/15m/1h/4h/1d); execution venues still read their own rules, quotes, positions, fills, and stops.'
  },
  {
    id: 'D04',
    status: 'LOCKED_ARCHITECTURE',
    title: 'Single embedded local SQLite ledger',
    summary: 'Settings, events, intents, positions, authority epochs, inbox/outbox, nonces, conversations, and lessons share local SQL transactions under .mpu-gandring/rebirth/runtime.sqlite.'
  },
  {
    id: 'D05',
    status: 'LOCKED_ARCHITECTURE',
    title: 'Six logical roles frozen per task; Jev remains non-voting advisor',
    summary: 'Exactly one accepted completion per cycle/role/phase. Jev has zero voting or order authority and never becomes a seventh role.'
  },
  {
    id: 'D06',
    status: 'LOCKED_ARCHITECTURE',
    title: 'Bot transport authentication separated from human Owner authorization',
    summary: 'HMAC callback authenticates paired peer transport for results/status only; actorRole=owner is untrusted without independent human proof or one-time local Owner grant.'
  },
  {
    id: 'D07',
    status: 'LOCKED_ARCHITECTURE',
    title: 'Account lifecycle registry with ACTIVE and DRAINING contexts',
    summary: 'Switching venue/account directs new intents to ACTIVE while retaining DRAINING monitoring, protection, and close capability until exposure is terminal.'
  },
  {
    id: 'D08',
    status: 'LOCKED_ARCHITECTURE',
    title: 'Local prepare-then-activate settings coordinator; separate remote ack',
    summary: 'Candidate resources prepare before serialized local activation barrier; savedVersion, activeVersion, and lastAcknowledgedConfigVersion stay distinct.'
  },
  {
    id: 'D09',
    status: 'ACCEPTED',
    title: 'Local Kill flattens; remote Grok STOP halts entries and retains open positions with SL/TP',
    summary: 'Approved explicitly by Boss on 2026-10-31: local Kill keeps cancel + flatten behavior; Grok STOP latches durable halt ON, turns Auto OFF, cancels unfilled entry/nonprotective orders, and retains open positions with resting SL/TP (zero strategy CLOSE intents; separate emergency protection guard remains active).'
  },
  {
    id: 'D10',
    status: 'LOCKED_ARCHITECTURE',
    title: 'Preserve Node >=20 engine floor',
    summary: 'Verify native dependencies and build artifacts without silently raising the Node >=20 requirement.'
  },
  {
    id: 'D11',
    status: 'OPEN',
    title: 'Preserve N bounds 1..4 during migration pending explicit Owner schema decision',
    summary: 'Keep OPEN_ORDERS_N / maxPositions at 1..4 and preserve exact saved Owner values without overwriting account capital fields when applying presets.'
  },
  {
    id: 'D12',
    status: 'LOCKED_ARCHITECTURE',
    title: 'Isolated and labelled PAPER and backtest sandboxes',
    summary: 'No sample market or mock provider in the real decision graph; PAPER and backtest run in explicit simulation modules without signing credentials.'
  }
];

const EXTERNAL_UNKNOWNS = [
  {
    id: 'U01',
    area: 'Active Owner machine state',
    calibration: 'needs verification',
    detail: 'Installed .env values, active trading mode, open exchange positions, venue balances, and resting stops on Boss machine were intentionally not read.'
  },
  {
    id: 'U02',
    area: 'Grok Bot live pairing and routine installation',
    calibration: 'needs verification',
    detail: 'Live Grok webhook routine acceptance, six-bot group delivery receipts, and remote workspace synced files require a separate authorized operational probe.'
  },
  {
    id: 'U03',
    area: 'Inbound HTTPS callback reachability and TLS',
    calibration: 'needs verification',
    detail: 'Separate callback ingress requires Boss-selected TLS/tunnel routing before BIDIRECTIONAL_VERIFIED can be claimed.'
  },
  {
    id: 'U04',
    area: 'Verifiable remote human Owner attestation (AC-16)',
    calibration: 'needs verification',
    detail: 'Grok Bot shared-computer HMAC proves peer transport, not human identity; direct HT-DM Owner mutation remains gated behind local one-time Owner grant until product attestation is proved.'
  },
  {
    id: 'U05',
    area: 'Overlapping standalone Grok exchange credential revocation (AC-15)',
    calibration: 'needs verification',
    detail: 'Single-executor handover requires external proof that overlapping exchange API keys or standalone order routines on Grok are disabled/revoked and pending fills reconciled.'
  },
  {
    id: 'U06',
    area: 'Live/testnet exchange roundtrip per venue (AC-07)',
    calibration: 'needs verification',
    detail: 'Deterministic protocol fixtures verify adapter code contracts only; native read-only and testnet order/stop lifecycle require separate authorization.'
  }
];

const VENUE_TARGET_TASK = {
  bybit: 'T11a',
  aster: 'T11b',
  hyperliquid: 'T11c',
  binance: 'T11d',
  okx: 'T11e',
  dydx: 'T11f',
  paradex: 'T11g',
  orderly: 'T11h'
};

const COMPONENT_METADATA = {
  AgentPanel: { screen: 'Office agent side drawer', owner: 'T13', test: 'tests/rebirth/office-browser.test.ts > agent_chat_history_and_cancel' },
  Bot: { screen: 'Office 2.5D character sprite', owner: 'T13', test: 'tests/rebirth/office-browser.test.ts > renders_six_agent_identities' },
  Channels: { screen: 'Setup section 7 chat channels', owner: 'T14', test: 'tests/rebirth/channels.test.ts > channel_setup_and_test_controls' },
  CodexResearchSetup: { screen: 'Setup Local Agents MCP research policy', owner: 'T06', test: 'tests/rebirth/research.test.ts > codex_research_policy_roundtrip' },
  CommandBar: { screen: 'Top command and emergency bar', owner: 'T13', test: 'tests/rebirth/office-browser.test.ts > command_bar_debate_kill_and_commands' },
  DataSourcesSetup: { screen: 'Setup optional news and whale sources', owner: 'T06', test: 'tests/rebirth/research.test.ts > optional_data_sources_save_and_mask' },
  DeferredPanel: { screen: 'Error-bounded lazy panel wrapper', owner: 'T13', test: 'tests/rebirth/office-browser.test.ts > deferred_panel_recovery_reload' },
  DeskOps: { screen: 'Workspace Tools Desk Ops tab', owner: 'T13', test: 'tests/rebirth/api-parity.test.ts > desk_ops_size_open_close_auto_scan' },
  JevSetup: { screen: 'Setup Jev advisory connection', owner: 'T07', test: 'tests/rebirth/jev.test.ts > jev_setup_and_connection_probe' },
  Keris: { screen: 'Header and studio SVG ornament', owner: 'T13', test: 'tests/rebirth/office-browser.test.ts > renders_six_agent_identities' },
  Lessons: { screen: 'Workspace Tools Lessons tab', owner: 'T12', test: 'tests/rebirth/learning.test.ts > account_scoped_lessons_list_and_add' },
  LocalAgentsSetup: { screen: 'Setup local CLI agents and login', owner: 'T07', test: 'tests/rebirth/provider-tools.test.ts > local_cli_discovery_login_and_probe' },
  MiniCharts: { screen: 'Portfolio SVG equity and slot bars', owner: 'T13', test: 'tests/rebirth/office-browser.test.ts > portfolio_and_open_orders_honesty' },
  ModelsSetup: { screen: 'Setup provider, model, and reasoning stack', owner: 'T07', test: 'tests/rebirth/roles.test.ts > model_change_applies_next_task' },
  Office: { screen: 'Main studio scene and workstations', owner: 'T13', test: 'tests/rebirth/office-browser.test.ts > renders_six_agent_identities' },
  OfficeDiscussion: { screen: 'Studio discussion popover and multi-session chat', owner: 'T13', test: 'tests/rebirth/office-browser.test.ts > office_discussion_conversations_and_send' },
  Panels: { screen: 'TopBar, TrakteerPopup, TickerStrip, FightMeter, Portfolio, OpenOrders, Verdicts, TradeLog, Roster', owner: 'T13', test: 'tests/rebirth/office-browser.test.ts > topbar_portfolio_verdicts_and_logs' },
  PreferencesSetup: { screen: 'Setup desk preferences and paper allocation', owner: 'T03', test: 'tests/rebirth/settings.test.ts > preferences_validation_and_hot_apply' },
  PriceChart: { screen: 'Canonical Lightweight Charts and TV toggle panel', owner: 'T13', test: 'tests/rebirth/office-browser.test.ts > chart_symbol_tf_selection_and_stream_epoch' },
  Reports: { screen: 'Periodic and on-demand desk reports panel', owner: 'T13', test: 'tests/rebirth/api-parity.test.ts > reports_list_and_generate_now' },
  SessionLogs: { screen: 'System log archived diagnostic sessions viewer', owner: 'T14', test: 'tests/rebirth/api-parity.test.ts > session_logs_list_events_and_download' },
  Setup: { screen: 'Setup wizard modal and venue/mode/key flow', owner: 'T03', test: 'tests/rebirth/office-browser.test.ts > setup_wizard_saved_vs_active_status' },
  Tour: { screen: 'Interactive guided UI spotlight tour', owner: 'T14', test: 'tests/rebirth/office-browser.test.ts > guided_tour_keyboard_and_dismiss' },
  TradingSetup: { screen: 'Setup network trading profile and risk limits', owner: 'T03', test: 'tests/rebirth/settings.test.ts > trading_profile_and_limits_preserve_capital_fields' },
  TradingViewChart: { screen: 'Optional browser-only TradingView embed', owner: 'T13', test: 'tests/rebirth/office-browser.test.ts > chart_symbol_tf_selection_and_stream_epoch' },
  UpdateModal: { screen: 'Self-update status and apply modal', owner: 'T14', test: 'tests/rebirth/launcher.test.ts > updater_status_and_local_apply' },
  Wallet: { screen: 'Delegated DEX wallet connect and agent approval', owner: 'T10', test: 'tests/rebirth/wallet.test.ts > delegated_wallet_challenge_and_approve' },
  WalletMenu: { screen: 'TopBar Connect Wallet dropdown trigger', owner: 'T10', test: 'tests/rebirth/office-browser.test.ts > wallet_dropdown_open_and_escape' },
  WorkspaceTools: { screen: 'Tabbed container for Book, Ops, Lessons, Logs, History', owner: 'T13', test: 'tests/rebirth/office-browser.test.ts > workspace_tools_tabs_and_counts' }
};

const ROUTE_METADATA = {
  'POST /api/logs/client': {
    auth: 'local-owner-origin',
    targetOwner: 'T14',
    hotApply: 'not-applicable',
    errorBehavior: '403 non-local, 429 over 30/min, 400 invalid client error payload',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > client_log_ingest_validates_and_rate_limits'
  },
  'GET /api/health': {
    auth: 'public-read',
    targetOwner: 'T01',
    hotApply: 'reflects-active-version',
    errorBehavior: '200 health envelope with explicit unavailable/degraded subsystem state; never reports mock fallback as healthy',
    behaviorTest: 'tests/rebirth/runtime-isolation.test.ts > health_and_state_expose_honest_unconfigured_status'
  },
  'GET /api/state': {
    auth: 'public-read',
    targetOwner: 'T01',
    hotApply: 'reflects-active-version',
    errorBehavior: '200 OfficeState snapshot with nullable/UNAVAILABLE financial fields when unverified',
    behaviorTest: 'tests/rebirth/runtime-isolation.test.ts > health_and_state_expose_honest_unconfigured_status'
  },
  'GET /api/jev': {
    auth: 'public-read',
    targetOwner: 'T07',
    hotApply: 'reflects-active-version',
    errorBehavior: '200 disabled/unavailable Jev status without side effects when off or unconfigured',
    behaviorTest: 'tests/rebirth/jev.test.ts > jev_off_does_not_remove_role'
  },
  'GET /api/conversations': {
    auth: 'public-read',
    targetOwner: 'T13',
    hotApply: 'not-applicable',
    errorBehavior: '200 account-scoped conversation list; legacy history read-only',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > conversations_list_and_create'
  },
  'POST /api/conversations/new': {
    auth: 'local-owner-origin',
    targetOwner: 'T13',
    hotApply: 'immediate-store-commit',
    errorBehavior: '403 non-local client; 500 redacted store failure',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > conversations_list_and_create'
  },
  'GET /api/chat/history/:agent': {
    auth: 'local-owner-origin',
    targetOwner: 'T13',
    hotApply: 'not-applicable',
    errorBehavior: '403 non-local; 400 unknown agent or invalid pagination',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > chat_history_read_delete_and_cancel'
  },
  'GET /api/chat/history/:agent/:id': {
    auth: 'local-owner-origin',
    targetOwner: 'T13',
    hotApply: 'not-applicable',
    errorBehavior: '403 non-local; 400 invalid params; 404 missing archived session',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > chat_history_read_delete_and_cancel'
  },
  'DELETE /api/chat/history/:agent/:id': {
    auth: 'local-owner-origin',
    targetOwner: 'T13',
    hotApply: 'immediate-store-commit',
    errorBehavior: '403 non-local; 400 missing confirm=true or unknown agent; 404 unknown session',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > chat_history_read_delete_and_cancel'
  },
  'POST /api/chat/cancel/:id': {
    auth: 'local-owner-origin',
    targetOwner: 'T13',
    hotApply: 'immediate-cancellation',
    errorBehavior: '403 non-local; 200 idempotent abort of active or unknown request id',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > chat_history_read_delete_and_cancel'
  },
  'GET /api/update/status': {
    auth: 'public-read',
    targetOwner: 'T14',
    hotApply: 'not-applicable',
    errorBehavior: '200 version comparison with offline/fetch error reported honestly in status payload',
    behaviorTest: 'tests/rebirth/launcher.test.ts > updater_status_and_local_apply'
  },
  'POST /api/update/apply': {
    auth: 'local-key-entry-access',
    targetOwner: 'T14',
    hotApply: 'requires-explicit-restart',
    errorBehavior: '403 non-local or remote host; 200 ok:false when dirty tree or git fast-forward fails',
    behaviorTest: 'tests/rebirth/launcher.test.ts > updater_status_and_local_apply'
  },
  'GET /api/trakteer/config': {
    auth: 'local-owner-origin',
    targetOwner: 'T14',
    hotApply: 'reflects-active-version',
    errorBehavior: '403 non-local client',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > trakteer_config_and_sanitized_tip_celebration'
  },
  'POST /api/trakteer/tip': {
    auth: 'rate-limited-untrusted-input',
    targetOwner: 'T14',
    hotApply: 'immediate-ui-event-only',
    errorBehavior: '429 over 20/min; sanitizes untrusted text; never authorizes commands or orders',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > trakteer_config_and_sanitized_tip_celebration'
  },
  'POST /api/trakteer/webhook': {
    auth: 'rate-limited-untrusted-input',
    targetOwner: 'T14',
    hotApply: 'immediate-ui-event-only',
    errorBehavior: '429 over 20/min; sanitizes untrusted text; never authorizes commands or orders',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > trakteer_config_and_sanitized_tip_celebration'
  },
  'GET /api/wallet': {
    auth: 'public-read-with-local-gate-flag',
    targetOwner: 'T10',
    hotApply: 'reflects-active-version',
    errorBehavior: '200 venue capability matrix with available:false reason when non-local',
    behaviorTest: 'tests/rebirth/wallet.test.ts > wallet_capabilities_and_balance_read'
  },
  'GET /api/wallet/balance': {
    auth: 'local-key-entry-access',
    targetOwner: 'T10',
    hotApply: 'not-applicable',
    errorBehavior: '403 non-local; returns nullable equityUsdt/availableUsdt when unconfigured or unreachable, never fake 0',
    behaviorTest: 'tests/rebirth/wallet.test.ts > wallet_capabilities_and_balance_read'
  },
  'POST /api/wallet/start': {
    auth: 'local-key-entry-access',
    targetOwner: 'T10',
    hotApply: 'challenge-only',
    errorBehavior: '403 non-local; 429 rate-limited; 400 refuses secret-like material, unsupported venue, or bad address/chainId',
    behaviorTest: 'tests/rebirth/wallet.test.ts > delegated_wallet_challenge_and_approve'
  },
  'POST /api/wallet/approve': {
    auth: 'local-key-entry-access',
    targetOwner: 'T10',
    hotApply: 'prepare-activate-credentials',
    errorBehavior: '403 non-local; 429 rate-limited; 400 expired/replayed/wrong-signer/wrong-chain signature',
    behaviorTest: 'tests/rebirth/wallet.test.ts > delegated_wallet_challenge_and_approve'
  },
  'GET /api/candles': {
    auth: 'public-read',
    targetOwner: 'T13',
    hotApply: 'reflects-bybit-hub',
    errorBehavior: '400 invalid symbol or TF; 429 chart busy; 503 canonical Bybit linear candles unavailable (no Binance/sample fallback)',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > canonical_candles_endpoint_and_stream_revision'
  },
  'GET /api/split': {
    auth: 'public-read',
    targetOwner: 'T03',
    hotApply: 'reflects-active-version',
    errorBehavior: '400 invalid balance, safetyNet, N, or orderSizePct',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > money_split_and_ticket_size_preview'
  },
  'POST /api/debate': {
    auth: 'local-owner-origin',
    targetOwner: 'T08',
    hotApply: 'uses-active-version-per-cycle',
    errorBehavior: '403 non-local; 409 halted, invalid symbol, or unavailable providers (never fake HOLD success)',
    behaviorTest: 'tests/rebirth/debate.test.ts > debate_endpoint_runs_six_roles_without_mock_fallback'
  },
  'POST /api/command': {
    auth: 'local-owner-origin',
    targetOwner: 'T13',
    hotApply: 'immediate-owner-dispatch',
    errorBehavior: '403 non-local; 400 empty/oversize/unknown agent/bad ids; 409 stale operational session',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > owner_command_provenance_and_session_guard'
  },
  'GET /api/reports': {
    auth: 'public-read',
    targetOwner: 'T13',
    hotApply: 'not-applicable',
    errorBehavior: '200 recent immutable reports with native financial certainty metadata',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > reports_list_and_generate_now'
  },
  'POST /api/reports/now': {
    auth: 'local-owner-origin',
    targetOwner: 'T13',
    hotApply: 'immediate-report-projection',
    errorBehavior: '403 non-local; 500 redacted storage error',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > reports_list_and_generate_now'
  },
  'POST /api/auto/cycle': {
    auth: 'local-owner-origin',
    targetOwner: 'T08',
    hotApply: 'uses-active-version-per-cycle',
    errorBehavior: '403 non-local; skips entry when halted or providers unavailable',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > auto_cycle_respects_halt_and_active_config'
  },
  'POST /api/kill': {
    auth: 'local-owner-origin',
    targetOwner: 'T09',
    hotApply: 'immediate-durable-halt-and-flatten',
    errorBehavior: '403 non-local; 409 unkill conflict; D09 local Kill latches halt ON, turns Auto OFF, cancels entries, and flattens managed exposure',
    behaviorTest: 'tests/rebirth/stop.test.ts > local_kill_cancels_and_flattens_while_grok_stop_retains_protected_positions'
  },
  'POST /api/unkill': {
    auth: 'local-owner-origin',
    targetOwner: 'T09',
    hotApply: 'immediate-halt-release-auto-stays-off',
    errorBehavior: '403 non-local; 409 unresolved emergency state; releasing halt never enables Auto or submits orders',
    behaviorTest: 'tests/rebirth/launcher.test.ts > unkill_does_not_enable_auto'
  },
  'POST /api/agent-event': {
    auth: 'bearer-agent-event-secret',
    targetOwner: 'T14',
    hotApply: 'scoped-legacy-compatibility',
    errorBehavior: '404 disabled; 401 bad secret; 429 rate-limited; 400 schema error; never grants Owner scope',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > agent_event_and_gb_routes_cannot_impersonate_owner'
  },
  'POST /api/gb/open': {
    auth: 'bearer-agent-event-secret',
    targetOwner: 'T14',
    hotApply: 'uses-active-version-gateway',
    errorBehavior: '404 no secret; 401 bad secret; 429 rate-limited; 400 invalid ticket; gated by single execution gateway',
    behaviorTest: 'tests/rebirth/cli.test.ts > gb_open_close_cancel_and_lessons_through_gateway'
  },
  'POST /api/gb/close': {
    auth: 'bearer-agent-event-secret',
    targetOwner: 'T14',
    hotApply: 'uses-active-version-gateway',
    errorBehavior: '404 no secret; 401 bad secret; 400 missing target; independent of entry confidence',
    behaviorTest: 'tests/rebirth/cli.test.ts > gb_open_close_cancel_and_lessons_through_gateway'
  },
  'POST /api/gb/cancel-entry': {
    auth: 'bearer-agent-event-secret',
    targetOwner: 'T14',
    hotApply: 'uses-active-version-gateway',
    errorBehavior: '404 no secret; 401 bad secret; 400 invalid clientId; reconciles partial fill during cancel',
    behaviorTest: 'tests/rebirth/cli.test.ts > gb_open_close_cancel_and_lessons_through_gateway'
  },
  'POST /api/gb/agent-close': {
    auth: 'bearer-agent-event-secret',
    targetOwner: 'T14',
    hotApply: 'uses-active-version-gateway',
    errorBehavior: '404 no secret; 401 bad secret; 400 missing typed trigger/positionId/expectedQty/reason',
    behaviorTest: 'tests/rebirth/exits.test.ts > verified_exit_triggers_close_independently_of_entry_gates'
  },
  'POST /api/gb/agent-open': {
    auth: 'bearer-agent-event-secret',
    targetOwner: 'T14',
    hotApply: 'uses-active-version-gateway',
    errorBehavior: '404 no secret; 401 bad secret; 400 missing Risk APPROVE or Lead probability_0_1 confidence',
    behaviorTest: 'tests/rebirth/cli.test.ts > gb_open_close_cancel_and_lessons_through_gateway'
  },
  'POST /api/gb/scan': {
    auth: 'bearer-agent-event-secret',
    targetOwner: 'T14',
    hotApply: 'read-only-diagnostic-log',
    errorBehavior: '404 no secret; 401 bad secret; 429 rate-limited',
    behaviorTest: 'tests/rebirth/cli.test.ts > gb_open_close_cancel_and_lessons_through_gateway'
  },
  'GET /api/gb/lessons': {
    auth: 'bearer-agent-event-secret',
    targetOwner: 'T12',
    hotApply: 'account-scoped-read',
    errorBehavior: '404 no secret; 401 bad secret; returns only scoped v2 advice, never legacy sample lessons',
    behaviorTest: 'tests/rebirth/learning.test.ts > account_scoped_memory'
  },
  'POST /api/gb/lessons': {
    auth: 'bearer-agent-event-secret',
    targetOwner: 'T12',
    hotApply: 'account-scoped-append',
    errorBehavior: '404 no secret; 401 bad secret; 400 invalid body; 422 learning off or guard-loosening attempt',
    behaviorTest: 'tests/rebirth/learning.test.ts > lesson_cannot_mutate_settings'
  },
  'POST /api/tradingview': {
    auth: 'body-passphrase-secret',
    targetOwner: 'T14',
    hotApply: 'untrusted-signal-triggers-debate-only',
    errorBehavior: '404 webhook off; 401 bad passphrase; 400 unknown symbol; 429 >1/min/symbol; never submits order directly',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > tradingview_webhook_starts_debate_never_orders'
  },
  'POST /api/bridge/probe': {
    auth: 'local-owner-origin',
    targetOwner: 'T16',
    hotApply: 'outbox-probe-only',
    errorBehavior: '403 non-local; reports honest outbound delivery/queued state without claiming bidirectional completion',
    behaviorTest: 'tests/rebirth/grok-bridge.test.ts > webhook_200_without_callback_stays_pending'
  },
  'GET /^\\/(?!api|ws).*/': {
    auth: 'public-spa-shell',
    targetOwner: 'T01',
    hotApply: 'static-asset-serving',
    errorBehavior: 'Serves built index.html for non-API/WS routes when web bundle is present',
    behaviorTest: 'tests/rebirth/office-browser.test.ts > spa_shell_loads_without_console_errors'
  },
  'GET /api/setup': {
    auth: 'local-owner-origin',
    targetOwner: 'T03',
    hotApply: 'returns-saved-active-remote-versions',
    errorBehavior: '403 non-local; 429 rate-limited; secrets always masked',
    behaviorTest: 'tests/rebirth/settings.test.ts > setup_status_masks_secrets_and_exposes_versions'
  },
  'GET /api/setup/guide/:venue': {
    auth: 'local-owner-origin',
    targetOwner: 'T03',
    hotApply: 'not-applicable',
    errorBehavior: '403 non-local; 404 unknown venue',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > setup_guides_cover_all_eight_venues'
  },
  'GET /api/setup/models': {
    auth: 'local-owner-origin',
    targetOwner: 'T07',
    hotApply: 'returns-saved-and-active-models',
    errorBehavior: '403 non-local; reports real provider key presence without mock fallback masking',
    behaviorTest: 'tests/rebirth/roles.test.ts > no_key_is_unavailable_not_mock'
  },
  'GET /api/setup/preferences': {
    auth: 'local-owner-origin',
    targetOwner: 'T03',
    hotApply: 'returns-saved-and-active-preferences',
    errorBehavior: '403 non-local; preserves exact Owner values',
    behaviorTest: 'tests/rebirth/settings.test.ts > preferences_validation_and_hot_apply'
  },
  'GET /api/setup/trading': {
    auth: 'local-owner-origin',
    targetOwner: 'T03',
    hotApply: 'returns-saved-and-active-trading-profile',
    errorBehavior: '403 non-local; 400 invalid stored profile',
    behaviorTest: 'tests/rebirth/settings.test.ts > trading_profile_and_limits_preserve_capital_fields'
  },
  'POST /api/setup/trading/limits': {
    auth: 'local-owner-origin',
    targetOwner: 'T03',
    hotApply: 'prepare-then-activate-versioned',
    errorBehavior: '403 non-local; 400 negative/nonfinite values; 409 version conflict; failed prepare keeps prior activeVersion',
    behaviorTest: 'tests/rebirth/settings.test.ts > trading_profile_and_limits_preserve_capital_fields'
  },
  'POST /api/setup/trading': {
    auth: 'local-owner-origin',
    targetOwner: 'T03',
    hotApply: 'prepare-then-activate-versioned',
    errorBehavior: '403 non-local; 400 out-of-range fields or N outside 1..4; preset never overwrites safetyNet/minOrderUsdt/maxOrderUsdt',
    behaviorTest: 'tests/rebirth/settings.test.ts > trading_profile_and_limits_preserve_capital_fields'
  },
  'POST /api/setup/preferences': {
    auth: 'local-owner-origin',
    targetOwner: 'T03',
    hotApply: 'prepare-then-activate-versioned',
    errorBehavior: '403 non-local; 400 safetyNet > balance or N outside 1..4; 409 version conflict',
    behaviorTest: 'tests/rebirth/settings.test.ts > preferences_validation_and_hot_apply'
  },
  'POST /api/setup/restart': {
    auth: 'local-owner-origin',
    targetOwner: 'T14',
    hotApply: 'in-place-or-managed-ipc-restart',
    errorBehavior: '403 non-local; 409 mode/venue change requires dedicated mode/venue flow; 400 invalid config',
    behaviorTest: 'tests/rebirth/launcher.test.ts > managed_restart_and_in_place_reload'
  },
  'GET /api/setup/local-agents': {
    auth: 'local-owner-origin',
    targetOwner: 'T07',
    hotApply: 'reflects-active-version',
    errorBehavior: '403 non-local; exposes honest UNSANDBOXED capability status for local CLIs',
    behaviorTest: 'tests/rebirth/provider-tools.test.ts > local_cli_discovery_login_and_probe'
  },
  'POST /api/setup/local-agents/models': {
    auth: 'local-key-entry-access',
    targetOwner: 'T07',
    hotApply: 'refreshes-catalog-metadata',
    errorBehavior: '403 non-local; 400 unknown CLI id; 503 metadata refresh failure',
    behaviorTest: 'tests/rebirth/provider-tools.test.ts > local_cli_discovery_login_and_probe'
  },
  'POST /api/setup/local-agents/settings': {
    auth: 'local-key-entry-access',
    targetOwner: 'T07',
    hotApply: 'prepare-then-activate-next-task',
    errorBehavior: '403 non-local; 400 invalid CLI setting value',
    behaviorTest: 'tests/rebirth/provider-tools.test.ts > local_cli_discovery_login_and_probe'
  },
  'GET /api/setup/data-sources': {
    auth: 'local-owner-origin',
    targetOwner: 'T06',
    hotApply: 'reflects-active-version',
    errorBehavior: '403 non-local; masks stored optional enrichment keys',
    behaviorTest: 'tests/rebirth/research.test.ts > optional_data_sources_save_and_mask'
  },
  'POST /api/setup/data-sources': {
    auth: 'local-key-entry-access',
    targetOwner: 'T06',
    hotApply: 'prepare-then-activate-versioned',
    errorBehavior: '403 non-local; 400 invalid source or key format; missing optional source never becomes entry veto',
    behaviorTest: 'tests/rebirth/research.test.ts > optional_data_sources_save_and_mask'
  },
  'GET /api/setup/local-agents/research': {
    auth: 'local-owner-origin',
    targetOwner: 'T06',
    hotApply: 'reflects-active-version',
    errorBehavior: '403 non-local; 503 MCP inspection failure without faking verified status',
    behaviorTest: 'tests/rebirth/research.test.ts > codex_research_policy_roundtrip'
  },
  'POST /api/setup/local-agents/research': {
    auth: 'local-key-entry-access',
    targetOwner: 'T06',
    hotApply: 'prepare-then-activate-next-task',
    errorBehavior: '403 non-local; 400 invalid MCP tool names; 503 unconfigured MCP server or secret leak rejected',
    behaviorTest: 'tests/rebirth/research.test.ts > codex_research_policy_roundtrip'
  },
  'POST /api/setup/local-agents/connect': {
    auth: 'local-key-entry-access',
    targetOwner: 'T07',
    hotApply: 'verified-probe-then-activate',
    errorBehavior: '403 non-local; 400 missing CLI or failed JSON probe preserves previous active settings',
    behaviorTest: 'tests/rebirth/provider-tools.test.ts > local_cli_discovery_login_and_probe'
  },
  'POST /api/setup/local-agents/login': {
    auth: 'local-key-entry-access',
    targetOwner: 'T07',
    hotApply: 'interactive-cli-signin',
    errorBehavior: '403 non-local; 400 CLI binary not installed',
    behaviorTest: 'tests/rebirth/provider-tools.test.ts > local_cli_discovery_login_and_probe'
  },
  'POST /api/setup/local-agents/status': {
    auth: 'local-key-entry-access',
    targetOwner: 'T07',
    hotApply: 'not-applicable',
    errorBehavior: '403 non-local; 400 unknown local agent id',
    behaviorTest: 'tests/rebirth/provider-tools.test.ts > local_cli_discovery_login_and_probe'
  },
  'POST /api/setup/local-agents/test': {
    auth: 'local-key-entry-access',
    targetOwner: 'T07',
    hotApply: 'read-only-probe',
    errorBehavior: '403 non-local; 429 over 3/min; 400 invalid model or probe failure',
    behaviorTest: 'tests/rebirth/provider-tools.test.ts > local_cli_discovery_login_and_probe'
  },
  'POST /api/setup/models': {
    auth: 'local-key-entry-access',
    targetOwner: 'T07',
    hotApply: 'prepare-then-activate-next-task',
    errorBehavior: '403 non-local; 400 invalid provider/model/whitespace key; missing key marks role unavailable, never mock',
    behaviorTest: 'tests/rebirth/roles.test.ts > model_change_applies_next_task'
  },
  'GET /api/setup/jev': {
    auth: 'local-owner-origin',
    targetOwner: 'T07',
    hotApply: 'reflects-active-version',
    errorBehavior: '403 non-local; masks JEV_API_KEY',
    behaviorTest: 'tests/rebirth/jev.test.ts > jev_setup_and_connection_probe'
  },
  'POST /api/setup/jev': {
    auth: 'local-key-entry-access',
    targetOwner: 'T07',
    hotApply: 'prepare-then-activate-versioned',
    errorBehavior: '403 non-local; 400 invalid URL/timeout/mode; enabling Jev never places orders',
    behaviorTest: 'tests/rebirth/jev.test.ts > jev_setup_and_connection_probe'
  },
  'POST /api/setup/jev/test': {
    auth: 'local-key-entry-access',
    targetOwner: 'T07',
    hotApply: 'read-only-probe',
    errorBehavior: '403 non-local; 429 over 3/min; 400 unreachable or unauthenticated Jev endpoint',
    behaviorTest: 'tests/rebirth/jev.test.ts > jev_setup_and_connection_probe'
  },
  'POST /api/setup/keys': {
    auth: 'local-key-entry-access',
    targetOwner: 'T03',
    hotApply: 'masked-secret-store-and-account-prepare',
    errorBehavior: '403 non-local; 400 main-wallet seed/withdraw-capable key refused; never logs or echoes secret',
    behaviorTest: 'tests/rebirth/accounts.test.ts > key_rotation_and_withdraw_permission_refusal'
  },
  'POST /api/setup/venue': {
    auth: 'local-key-entry-access',
    targetOwner: 'T03',
    hotApply: 'account-switch-retains-draining',
    errorBehavior: '403 non-local; 400 unknown venue; 409 prepare failure keeps prior active account; old exposure stays DRAINING',
    behaviorTest: 'tests/rebirth/accounts.test.ts > venue_switch_retains_draining_account_monitoring'
  },
  'POST /api/setup/mode': {
    auth: 'local-key-entry-access',
    targetOwner: 'T03',
    hotApply: 'verified-mode-gate-and-account-activate',
    errorBehavior: '403 non-local; 400 missing exact LIVE confirmation phrase, missing trade-only key, or experimental LIVE blocked',
    behaviorTest: 'tests/rebirth/launcher.test.ts > local_mode_flow_requires_typed_live_confirmation'
  },
  'POST /api/setup/doctor': {
    auth: 'local-owner-origin',
    targetOwner: 'T14',
    hotApply: 'read-only-permission-and-account-audit',
    errorBehavior: '403 non-local; reports trade/withdraw permission certainty without printing secrets',
    behaviorTest: 'tests/rebirth/cli.test.ts > doctor_checks_permissions_without_leaking_secrets'
  },
  'POST /api/ops/size': {
    auth: 'local-owner-origin',
    targetOwner: 'T13',
    hotApply: 'read-only-sizing-preview',
    errorBehavior: '403 non-local; 400 missing symbol/side/stop or invalid quantized size',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > money_split_and_ticket_size_preview'
  },
  'POST /api/ops/open': {
    auth: 'local-owner-origin',
    targetOwner: 'T09',
    hotApply: 'account-scoped-gateway-submit',
    errorBehavior: '403 non-local; 400 missing stop or invalid GTC clientId; blocked when halted, daily loss hit, or at safety net',
    behaviorTest: 'tests/rebirth/gateway.test.ts > journal_before_send_and_mandatory_resting_stop'
  },
  'POST /api/ops/close': {
    auth: 'local-owner-origin',
    targetOwner: 'T09',
    hotApply: 'account-scoped-owner-close',
    errorBehavior: '403 non-local; 400 missing symbol; never blocked by low entry confidence or full slots',
    behaviorTest: 'tests/rebirth/gateway.test.ts > owner_close_not_blocked_by_entry_confidence'
  },
  'POST /api/ops/cancel-entry': {
    auth: 'local-owner-origin',
    targetOwner: 'T09',
    hotApply: 'account-scoped-entry-cancel',
    errorBehavior: '403 non-local; 400 invalid clientId; protects any partial fill discovered during cancel',
    behaviorTest: 'tests/rebirth/protection.test.ts > partial_fill_during_cancel_is_protected'
  },
  'POST /api/ops/agent-close': {
    auth: 'local-owner-origin',
    targetOwner: 'T08',
    hotApply: 'verified-exit-gateway-close',
    errorBehavior: '403 non-local; 400 missing typed exit trigger, positionId, expectedQty, or reason',
    behaviorTest: 'tests/rebirth/exits.test.ts > verified_exit_triggers_close_independently_of_entry_gates'
  },
  'POST /api/ops/agent-open': {
    auth: 'local-owner-origin',
    targetOwner: 'T09',
    hotApply: 'thesis-revalidated-gateway-submit',
    errorBehavior: '403 non-local; 400 missing Risk APPROVE or Lead probability_0_1; rejects invalidated thesis under lock',
    behaviorTest: 'tests/rebirth/reversal.test.ts > reversal_after_lock_wait'
  },
  'POST /api/ops/scan': {
    auth: 'local-owner-origin',
    targetOwner: 'T13',
    hotApply: 'read-only-proactive-scan',
    errorBehavior: '403 non-local; reports missing stops, daily loss, safety net, authority conflict, and stale feeds',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > desk_ops_size_open_close_auto_scan'
  },
  'GET /api/ops/lessons': {
    auth: 'local-owner-origin',
    targetOwner: 'T12',
    hotApply: 'account-scoped-read',
    errorBehavior: '403 non-local; excludes legacy sample lessons from v2 active prompt memory',
    behaviorTest: 'tests/rebirth/learning.test.ts > legacy_lesson_not_used_as_new_evidence'
  },
  'POST /api/ops/lessons': {
    auth: 'local-owner-origin',
    targetOwner: 'T12',
    hotApply: 'account-scoped-append',
    errorBehavior: '403 non-local; 400 short/invalid lesson; 422 learning off or guard-loosening text refused',
    behaviorTest: 'tests/rebirth/learning.test.ts > lesson_cannot_mutate_settings'
  },
  'GET /api/ops/kill': {
    auth: 'local-owner-origin',
    targetOwner: 'T09',
    hotApply: 'reflects-durable-halt-latch',
    errorBehavior: '403 non-local; returns durable halt latch, source, persistence certainty, and unkill command',
    behaviorTest: 'tests/rebirth/stop.test.ts > local_kill_cancels_and_flattens_while_grok_stop_retains_protected_positions'
  },
  'POST /api/ops/kill': {
    auth: 'local-owner-origin',
    targetOwner: 'T09',
    hotApply: 'immediate-durable-halt-toggle',
    errorBehavior: '403 non-local; 400 missing explicit boolean; 409 unkill conflict; D09 local Kill flattens on engage',
    behaviorTest: 'tests/rebirth/stop.test.ts > local_kill_cancels_and_flattens_while_grok_stop_retains_protected_positions'
  },
  'POST /api/ops/restart': {
    auth: 'local-owner-origin',
    targetOwner: 'T14',
    hotApply: 'in-place-or-managed-ipc-restart',
    errorBehavior: '403 non-local; 409 mode/venue change blocked here; 400 invalid config',
    behaviorTest: 'tests/rebirth/launcher.test.ts > managed_restart_and_in_place_reload'
  },
  'POST /api/ops/auto': {
    auth: 'local-owner-origin',
    targetOwner: 'T03',
    hotApply: 'prepare-then-activate-versioned',
    errorBehavior: '403 non-local; 400 invalid interval/symbols or N outside 1..4; 409 blocked while kill/halt latch is ON',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > desk_ops_size_open_close_auto_scan'
  },
  'POST /api/channels/discord': {
    auth: 'ed25519-signature-plus-owner-allowlist',
    targetOwner: 'T14',
    hotApply: 'inbound-webhook-listener-only',
    errorBehavior: '404 inbound off; 429 rate-limited; 401 bad Ed25519 signature; refuses non-allowlisted user',
    behaviorTest: 'tests/rebirth/channels.test.ts > allowlisted_owner_command_matches_current_message'
  },
  'POST /api/channels/slack': {
    auth: 'slack-hmac-raw-body-plus-owner-allowlist',
    targetOwner: 'T14',
    hotApply: 'inbound-webhook-listener-only',
    errorBehavior: '404 inbound off; 429 rate-limited; 401 bad Slack signature; refuses non-allowlisted user',
    behaviorTest: 'tests/rebirth/channels.test.ts > allowlisted_owner_command_matches_current_message'
  },
  'GET /api/channels/whatsapp': {
    auth: 'meta-verify-token',
    targetOwner: 'T14',
    hotApply: 'inbound-webhook-listener-only',
    errorBehavior: '404 inbound off; 403 wrong verify token or malformed hub.challenge',
    behaviorTest: 'tests/rebirth/channels.test.ts > whatsapp_challenge_and_hmac_webhook'
  },
  'POST /api/channels/whatsapp': {
    auth: 'meta-hmac-sha256-raw-body-plus-owner-allowlist',
    targetOwner: 'T14',
    hotApply: 'inbound-webhook-listener-only',
    errorBehavior: '404 inbound off; 429 rate-limited; 401 bad X-Hub-Signature-256; ignores non-allowlisted sender',
    behaviorTest: 'tests/rebirth/channels.test.ts > whatsapp_challenge_and_hmac_webhook'
  },
  'GET /': {
    auth: 'public-banner-on-webhook-port',
    targetOwner: 'T14',
    hotApply: 'inbound-webhook-listener-only',
    errorBehavior: '200 plain-text banner confirming isolated webhook listener exposes no office/setup routes',
    behaviorTest: 'tests/rebirth/channels.test.ts > inbound_webhook_listener_isolates_office_routes'
  },
  'GET /api/setup/channels': {
    auth: 'local-owner-origin',
    targetOwner: 'T14',
    hotApply: 'reflects-active-version',
    errorBehavior: '403 non-local; masks all channel tokens/secrets',
    behaviorTest: 'tests/rebirth/channels.test.ts > channel_setup_and_test_controls'
  },
  'POST /api/setup/channels/discord-bot': {
    auth: 'local-key-entry-access',
    targetOwner: 'T14',
    hotApply: 'read-only-bot-inspection',
    errorBehavior: '403 non-local; 400 missing token; 422 Discord API failure with token redacted',
    behaviorTest: 'tests/rebirth/channels.test.ts > channel_setup_and_test_controls'
  },
  'POST /api/setup/channels/discord-sync': {
    auth: 'local-key-entry-access',
    targetOwner: 'T14',
    hotApply: 'remote-slash-command-registration',
    errorBehavior: '403 non-local; 422 missing credentials or Discord sync error',
    behaviorTest: 'tests/rebirth/channels.test.ts > no_real_notification_from_fixture'
  },
  'POST /api/setup/channels/telegram-sync': {
    auth: 'local-key-entry-access',
    targetOwner: 'T14',
    hotApply: 'remote-command-registration',
    errorBehavior: '403 non-local; 422 missing token or Telegram API failure',
    behaviorTest: 'tests/rebirth/channels.test.ts > no_real_notification_from_fixture'
  },
  'POST /api/setup/channels/slack-sync': {
    auth: 'local-key-entry-access',
    targetOwner: 'T14',
    hotApply: 'remote-command-verification',
    errorBehavior: '403 non-local; 422 missing webhook/signing config',
    behaviorTest: 'tests/rebirth/channels.test.ts > no_real_notification_from_fixture'
  },
  'POST /api/setup/channels/whatsapp-sync': {
    auth: 'local-key-entry-access',
    targetOwner: 'T14',
    hotApply: 'remote-command-verification',
    errorBehavior: '403 non-local; 422 missing WhatsApp Cloud API credentials',
    behaviorTest: 'tests/rebirth/channels.test.ts > no_real_notification_from_fixture'
  },
  'POST /api/setup/channels/save': {
    auth: 'local-key-entry-access',
    targetOwner: 'T14',
    hotApply: 'prepare-then-activate-channel-config',
    errorBehavior: '403 non-local; 400 bad body; 422 missing required channel fields; retains blank secrets without echoing',
    behaviorTest: 'tests/rebirth/channels.test.ts > channel_setup_and_test_controls'
  },
  'POST /api/setup/channels/reset': {
    auth: 'local-key-entry-access',
    targetOwner: 'T14',
    hotApply: 'clears-channel-and-reloads-supervisor',
    errorBehavior: '403 non-local; 400 unknown channel',
    behaviorTest: 'tests/rebirth/channels.test.ts > channel_setup_and_test_controls'
  },
  'POST /api/setup/channels/test': {
    auth: 'local-owner-origin',
    targetOwner: 'T14',
    hotApply: 'outbound-test-via-injected-transport',
    errorBehavior: '403 non-local; 400 unknown channel; 422 channel not configured or delivery failed',
    behaviorTest: 'tests/rebirth/channels.test.ts > no_real_notification_from_fixture'
  },
  'POST /api/setup/channels/telegram-chats': {
    auth: 'local-owner-origin',
    targetOwner: 'T14',
    hotApply: 'read-only-chat-id-lookup',
    errorBehavior: '403 non-local; ok:false when token unset or Telegram getUpdates fails',
    behaviorTest: 'tests/rebirth/channels.test.ts > channel_setup_and_test_controls'
  },
  'GET /api/research/close-review': {
    auth: 'local-owner-origin',
    targetOwner: 'T08',
    hotApply: 'fresh-exit-evidence-read',
    errorBehavior: '403 non-local; 400 invalid symbol/trigger; 503 evidence unavailable without inferring close authorization',
    behaviorTest: 'tests/rebirth/exits.test.ts > close_review_reports_verified_triggers_and_position_identity'
  },
  'GET /api/research/summary': {
    auth: 'local-owner-origin',
    targetOwner: 'T13',
    hotApply: 'reflects-active-version',
    errorBehavior: '403 non-local; 400 unsupported summary kind',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > research_summary_and_capabilities'
  },
  'GET /api/research/capabilities': {
    auth: 'local-owner-origin',
    targetOwner: 'T06',
    hotApply: 'reflects-active-version',
    errorBehavior: '403 non-local; reports honest tool availability and UNSANDBOXED local CLI capability',
    behaviorTest: 'tests/rebirth/research.test.ts > capabilities_expose_honest_tool_and_sandbox_status'
  },
  'GET /api/research': {
    auth: 'local-owner-origin',
    targetOwner: 'T06',
    hotApply: 'uses-bounded-research-host',
    errorBehavior: '403 non-local; 400 unsupported tool/symbol; 503 unavailable without sample/invented substitution',
    behaviorTest: 'tests/rebirth/research.test.ts > actual_navigation_and_extraction'
  },
  'POST /api/research/backtest': {
    auth: 'local-owner-origin',
    targetOwner: 'T12',
    hotApply: 'isolated-sandbox-simulation',
    errorBehavior: '403 non-local; 400 <3 candles or bad params; 503 candle fetch failure; never loads live gateway/signer',
    behaviorTest: 'tests/rebirth/sandbox.test.ts > backtest_never_imports_live_gateway'
  },
  'GET /api/logs/sessions': {
    auth: 'local-owner-origin',
    targetOwner: 'T14',
    hotApply: 'read-only-diagnostic-archive',
    errorBehavior: '403 non-local; 405 non-GET; 429 >120/min; 400 invalid cursor/limit',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > session_logs_list_events_and_download'
  },
  'GET /api/logs/sessions/:id/events': {
    auth: 'local-owner-origin',
    targetOwner: 'T14',
    hotApply: 'read-only-diagnostic-archive',
    errorBehavior: '403 non-local; 400 invalid query or cursor',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > session_logs_list_events_and_download'
  },
  'GET /api/logs/sessions/:id/download': {
    auth: 'local-owner-origin',
    targetOwner: 'T14',
    hotApply: 'read-only-diagnostic-archive',
    errorBehavior: '403 non-local; 400 invalid file kind; 404 unknown session; path-traversal impossible via enum allowlist',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > session_logs_list_events_and_download'
  },
  'GET /api/logs/sessions/:id': {
    auth: 'local-owner-origin',
    targetOwner: 'T14',
    hotApply: 'read-only-diagnostic-archive',
    errorBehavior: '403 non-local; 404 unknown diagnostic session',
    behaviorTest: 'tests/rebirth/api-parity.test.ts > session_logs_list_events_and_download'
  }
};

const TRADING_FIELD_ERRORS = {
  dailyLossLimitPct: '400 when nonfinite or outside 0.5..25%',
  maxLossPerTradePct: '400 when nonfinite or outside (0, 100]%',
  minEntryConfidencePct: '400 when nonfinite or outside 0..100%; evaluated only against Lead probability_0_1',
  maxLeverage: '400 when non-integer or outside 1..100',
  orderSizePct: '400 when present and outside 1.5..100%; preserved across preset switches when set',
  defaultStopPct: '400 when nonfinite, <=0, or >=100%',
  minStopPct: '400 when nonfinite, <0, or >=100%',
  takeProfitPct: '400 when present and <=0',
  takeProfitR: '400 when nonfinite or <0',
  maxOrderUsdt: '400 when nonfinite or <0; preserved across preset switches',
  minOrderUsdt: '400 when nonfinite or <0; preserved across preset switches',
  safetyNet: '400 when nonfinite or <0; preserved across preset switches',
  maxPositions: '400 when non-integer or outside 1..4 (D11 open; exact saved value preserved)'
};

const PREFERENCE_FIELD_ERRORS = {
  appMode: '400 when not local or grokbot',
  balance: '400 when nonfinite or <0; applies to PAPER book only',
  safetyNet: '400 when nonfinite, <0, or exceeds paper balance',
  n: '400 when non-integer or outside 1..4 (D11 open)',
  dailyLoss: '400 when nonfinite or outside 0.1..100%',
  auto: '400 when non-boolean; 409 when enabling while halt/kill latch is ON',
  debateInterval: '400 when non-integer or outside 1..1440 minutes',
  reportInterval: '400 when non-integer or outside 1..1440 minutes',
  maxHoldHours: '400 when non-integer or outside 0..720 hours; 0 keeps autonomous duration-only close disabled'
};

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function listFilesRecursive(dir, baseDir = dir) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const out = [];
  for (const entry of entries) {
    if (entry.name === 'mpu-gandring-assets' || entry.name === '.DS_Store') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(abs, baseDir));
    } else if (entry.isFile()) {
      const rel = path.relative(baseDir, abs).split(path.sep).join('/');
      out.push({ path: `web/public/${rel}`, bytes: statSync(abs).size, sha256: sha256File(abs) });
    }
  }
  return out;
}

function walkAst(node, visit) {
  visit(node);
  node.forEachChild((child) => walkAst(child, visit));
}

function normalizeTextSlug(raw) {
  return raw
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9:/._-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

function readJsxAttrMap(openingNode, sf) {
  const attrs = new Map();
  for (const prop of openingNode.attributes.properties) {
    if (!isJsxAttribute(prop)) continue;
    const attrName = prop.name.getText(sf);
    if (!prop.initializer) {
      attrs.set(attrName, 'true');
      continue;
    }
    if (isStringLiteral(prop.initializer)) {
      attrs.set(attrName, prop.initializer.text);
    } else if (isJsxExpression(prop.initializer) && prop.initializer.expression) {
      attrs.set(attrName, prop.initializer.expression.getText(sf));
    }
  }
  return attrs;
}

function deriveControlKey(tag, attrs, nodeText) {
  for (const attr of ['id', 'data-testid', 'name', 'aria-label', 'aria-controls']) {
    const val = attrs.get(attr);
    if (val) {
      const clean = normalizeTextSlug(val);
      if (clean) return `${attr}:${clean}`;
    }
  }
  const tMatch = nodeText.match(/\bt\(\s*['"]([\w.]+)['"]\s*\)/);
  if (tMatch) return `t:${tMatch[1]}`;
  for (const handler of ['onClick', 'onSubmit', 'onChange']) {
    const val = attrs.get(handler);
    if (val) {
      const apiMatch = val.match(/\/api\/[\w/:.-]+/);
      if (apiMatch) return `${handler}:${apiMatch[0]}`;
      const fnMatch = val.match(/\b([a-zA-Z_$][\w$]*)\s*\(/);
      if (fnMatch && !['setState', 'void', 'String', 'Number', 'Boolean'].includes(fnMatch[1])) {
        return `${handler}:${fnMatch[1]}`;
      }
      const clean = normalizeTextSlug(val);
      if (clean) return `${handler}:${clean}`;
    }
  }
  if (attrs.get('className')) {
    const clean = normalizeTextSlug(attrs.get('className'));
    if (clean) return `cls:${clean}`;
  }
  if (attrs.get('type')) {
    return `type:${normalizeTextSlug(attrs.get('type'))}`;
  }
  return tag;
}

function enclosingFunctionName(node, sf) {
  let cur = node.parent;
  while (cur) {
    if (isFunctionDeclaration(cur) && cur.name) return cur.name.getText(sf);
    if (isVariableDeclaration(cur) && isIdentifier(cur.name)) return cur.name.getText(sf);
    cur = cur.parent;
  }
  return 'module';
}

function extractObjectKeysFromZodDeclaration(sf, varName) {
  if (!sf) return [];
  const keys = [];
  walkAst(sf, (node) => {
    if (!isVariableDeclaration(node) || !isIdentifier(node.name) || node.name.text !== varName || !node.initializer) return;
    walkAst(node.initializer, (inner) => {
      if (isCallExpression(inner) && isPropertyAccessExpression(inner.expression) && inner.expression.name.text === 'object' && inner.arguments.length > 0) {
        const arg = inner.arguments[0];
        if (isObjectLiteralExpression(arg) && keys.length === 0) {
          for (const prop of arg.properties) {
            if (isPropertyAssignment(prop)) keys.push(prop.name.getText(sf));
          }
        }
      }
    });
  });
  return keys;
}

function extractStringArrayConst(sf, varName) {
  if (!sf) return [];
  const items = [];
  walkAst(sf, (node) => {
    if (!isVariableDeclaration(node) || !isIdentifier(node.name) || node.name.text !== varName || !node.initializer) return;
    walkAst(node.initializer, (inner) => {
      if (isArrayLiteralExpression(inner) && items.length === 0) {
        for (const el of inner.elements) {
          if (isStringLiteral(el)) items.push(el.text);
        }
      }
    });
  });
  return items;
}

function extractMpuCliHelp(root) {
  const mpuFile = path.join(root, 'bin/mpu.mjs');
  const content = readFileSync(mpuFile, 'utf8');
  const usageBlockMatch = content.match(/Usage:\r?\n([\s\S]*?)\r?\n`\);/);
  const lines = usageBlockMatch ? usageBlockMatch[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
  const dispatchFor = (command) => {
    if (command === '(default)' || command === 'office' || command === '--no-open') return 'launcher:start-office';
    if (command === 'restart') return 'launcher:restart-office';
    if (command === 'dev') return 'npm:run:dev';
    if (command === 'test') return 'npm:test';
    if (command === 'typecheck') return 'npm:run:typecheck';
    if (command === 'build') return 'npm:run:build';
    if (command === 'link') return 'npm:link';
    if (command === 'paper') return 'cli:setup:paper';
    if (command === 'testnet') return 'cli:setup:--trading-mode=testnet';
    if (command === 'live') return 'cli:setup:--trading-mode=live';
    if (command === 'status') return 'cli:setup:status';
    if (command === 'analyze') return 'cli:debate:--symbol';
    if (command === 'bench') return 'cli:bench-models';
    if (['positions', 'account', 'balance', 'scan', 'report', 'reports', 'lessons', 'open', 'close', 'size', 'split', 'market', 'candles', 'venues', 'event', 'health', 'context', 'capabilities', 'research'].includes(command)) {
      return `cli:gb:${command === 'balance' ? 'account' : command}`;
    }
    return `cli:${command}`;
  };
  const mpuHelp = [];
  for (const line of lines) {
    if (!line.startsWith('mpu')) continue;
    const rest = line.slice(3).trim();
    const firstToken = rest.split(/\s+/)[0] || '';
    const command = !firstToken || firstToken === 'Start' ? '(default)' : firstToken;
    mpuHelp.push({ command, syntax: line.split(/\s{2,}/)[0].trim(), dispatch: dispatchFor(command) });
  }
  return mpuHelp;
}

function extractEnvExampleKeys(root) {
  const envExamplePath = path.join(root, '.env.example');
  if (!existsSync(envExamplePath)) return [];
  const keys = new Set();
  for (const rawLine of readFileSync(envExamplePath, 'utf8').split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    const match = trimmed.match(/^#?\s*([A-Z][A-Z0-9_]+)=/);
    if (match) keys.add(match[1]);
  }
  return [...keys].sort();
}

function normCmpPath(p) {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

function findProject(snapshot, configPath) {
  const direct = snapshot.getProject(configPath);
  if (direct) return direct;
  const target = normCmpPath(configPath);
  for (const proj of snapshot.getProjects()) {
    if (normCmpPath(proj.configFileName) === target || normCmpPath(proj.id) === target) {
      return proj;
    }
  }
  return undefined;
}

function findSourceFile(project, absFile) {
  const direct = project.program.getSourceFile(absFile);
  if (direct) return direct;
  const slashFile = absFile.replace(/\\/g, '/');
  const slashMatch = project.program.getSourceFile(slashFile);
  if (slashMatch) return slashMatch;
  const target = normCmpPath(absFile);
  for (const sf of project.program.getSourceFiles()) {
    if (normCmpPath(sf.fileName) === target) return sf;
  }
  return undefined;
}

export function collectContracts(root) {
  const resolvedRoot = path.resolve(root);
  const pkg = JSON.parse(readFileSync(path.join(resolvedRoot, 'package.json'), 'utf8'));
  const lockfileHash = existsSync(path.join(resolvedRoot, 'package-lock.json'))
    ? sha256File(path.join(resolvedRoot, 'package-lock.json'))
    : null;

  const webConfig = path.join(resolvedRoot, 'tsconfig.web.json');
  const serverConfig = existsSync(path.join(resolvedRoot, 'tsconfig.server.json'))
    ? path.join(resolvedRoot, 'tsconfig.server.json')
    : path.join(resolvedRoot, 'tsconfig.rebirth.json');

  const api = new API({ cwd: resolvedRoot });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [webConfig, serverConfig] });
    const webProject = findProject(snapshot, webConfig);
    const serverProject = findProject(snapshot, serverConfig);
    if (!webProject || !serverProject) {
      throw new Error('Failed to load TypeScript projects for contract extraction.');
    }

    // 1. Components & actionable controls via TypeScript AST
    const componentsDir = path.join(resolvedRoot, 'web/src/components');
    const componentFileNames = readdirSync(componentsDir)
      .filter((f) => f.endsWith('.tsx'))
      .sort((a, b) => a.localeCompare(b));

    const components = componentFileNames.map((fileName) => {
      const name = fileName.replace(/\.tsx$/, '');
      const absFile = path.join(componentsDir, fileName);
      const relFile = `web/src/components/${fileName}`;
      const sf = findSourceFile(webProject, absFile);
      if (!sf) throw new Error(`Missing SourceFile in web tsconfig for ${relFile}`);
      const meta = COMPONENT_METADATA[name];
      if (!meta) throw new Error(`Unmapped component metadata for ${name}`);

      const apiCalls = new Set();
      const storageKeys = new Set();
      const controls = [];
      const additiveControls = [];
      const seenIds = new Map();

      walkAst(sf, (node) => {
        if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
          if (node.text.startsWith('/api/')) apiCalls.add(node.text.split('?')[0]);
        } else if (isTemplateExpression(node)) {
          if (node.head.text.startsWith('/api/')) apiCalls.add(node.head.text.split('?')[0].replace(/\/$/, '/:param'));
        }

        if (isCallExpression(node) && isPropertyAccessExpression(node.expression)) {
          const objText = node.expression.expression.getText(sf);
          const propText = node.expression.name.text;
          if (objText === 'localStorage' && ['getItem', 'setItem', 'removeItem'].includes(propText) && node.arguments[0] && isStringLiteral(node.arguments[0])) {
            storageKeys.add(node.arguments[0].text);
          }
        }

        if (isJsxOpeningElement(node) || isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText(sf);
          const interactiveTags = new Set(['button', 'input', 'select', 'textarea', 'form', 'summary']);
          if (!interactiveTags.has(tag)) return;
          const attrs = readJsxAttrMap(node, sf);
          const fullNodeText = (node.parent && node.parent.kind === SyntaxKind.JsxElement) ? node.parent.getText(sf) : node.getText(sf);
          const baseKey = `${name}:${tag}:${deriveControlKey(tag, attrs, fullNodeText)}`;
          const count = (seenIds.get(baseKey) ?? 0) + 1;
          seenIds.set(baseKey, count);
          const id = count === 1 ? baseKey : `${baseKey}#${count}`;
          const record = {
            id,
            tag,
            targetOwner: meta.owner,
            behaviorTest: meta.test,
            errorBehavior: 'Preserves disabled/busy/error role=status|alert feedback without clearing unsaved input or faking numeric 0'
          };
          if (attrs.has('data-rebirth-additive')) {
            additiveControls.push(record);
          } else {
            controls.push(record);
          }
        }
      });

      return {
        name,
        file: relFile,
        screen: meta.screen,
        controls,
        additiveControls,
        apiCalls: [...apiCalls].sort(),
        storageKeys: [...storageKeys].sort()
      };
    });

    // 2. Express routes via TypeScript AST
    const legacyRouteFiles = [
      'server/app.ts',
      'server/setup/routes.ts',
      'server/channels/routes.ts',
      'server/research/routes.ts',
      'server/session-log-routes.ts'
    ].filter((rel) => existsSync(path.join(resolvedRoot, rel)));

    const v2CompatRouteFiles = legacyRouteFiles.length > 0
      ? []
      : [
          'server/v2/app.ts',
          'server/v2/api/state.ts',
          'server/v2/api/setup.ts',
          'server/v2/api/operations.ts',
          'server/v2/api/chat.ts',
          'server/v2/api/history.ts',
          'server/v2/api/research.ts',
          'server/v2/channels.ts'
        ].filter((rel) => existsSync(path.join(resolvedRoot, rel)));

    const routeFilesToScan = legacyRouteFiles.length > 0 ? legacyRouteFiles : v2CompatRouteFiles;
    const routes = [];
    const seenRouteKeys = new Set();

    for (const relFile of routeFilesToScan) {
      const absFile = path.join(resolvedRoot, relFile);
      const sf = findSourceFile(serverProject, absFile);
      if (!sf) throw new Error(`Missing SourceFile in server tsconfig for ${relFile}`);

      walkAst(sf, (node) => {
        if (!isCallExpression(node) || !isPropertyAccessExpression(node.expression)) return;
        const receiver = node.expression.expression.getText(sf);
        const method = node.expression.name.text.toUpperCase();
        if (receiver !== 'app' || !['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) return;
        const firstArg = node.arguments[0];
        if (!firstArg) return;
        let routePath = null;
        if (isStringLiteral(firstArg) || isNoSubstitutionTemplateLiteral(firstArg)) {
          routePath = firstArg.text;
        } else if (isRegularExpressionLiteral(firstArg)) {
          routePath = firstArg.getText(sf);
        }
        if (!routePath) return;
        if (routePath.startsWith('/api/v2/')) return; // Additive v2 routes are tracked under Grok v2 protocol, not baseline v1 surface

        const fnScope = enclosingFunctionName(node, sf);
        const mount = fnScope === 'createInboundApp'
          ? 'standalone-inbound-webhook'
          : routePath.startsWith('/^')
            ? 'main-app-spa-fallback'
            : 'main-app';
        const key = `${method} ${routePath}`;
        if (seenRouteKeys.has(`${mount}:${key}`)) return;
        seenRouteKeys.add(`${mount}:${key}`);

        const meta = ROUTE_METADATA[key];
        if (!meta) {
          throw new Error(`Discovered unmapped Express route ${key} in ${relFile} (${fnScope})`);
        }
        routes.push({
          id: `${mount}:${method}:${routePath}`,
          method,
          path: routePath,
          sourceFile: relFile,
          mount,
          auth: meta.auth,
          hotApply: meta.hotApply,
          targetOwner: meta.targetOwner,
          errorBehavior: meta.errorBehavior,
          behaviorTest: meta.behaviorTest
        });
      });
    }

    routes.sort((a, b) => a.id.localeCompare(b.id));

    // 3. WebSocket events via AST
    const appSf = existsSync(path.join(resolvedRoot, 'server/app.ts'))
      ? findSourceFile(serverProject, path.join(resolvedRoot, 'server/app.ts'))
      : findSourceFile(serverProject, path.join(resolvedRoot, 'shared/office.ts'));
    const wsEvents = extractStringArrayConst(appSf, 'eventTypes');
    const serverEvents = wsEvents.length > 0
      ? wsEvents
      : ['state', 'speech', 'fight', 'meter', 'verdict', 'log', 'status', 'debate', 'report', 'execution', 'room', 'cendol'];

    // 4. Roles & Venues via AST
    const typesSf = findSourceFile(webProject, path.join(resolvedRoot, 'web/src/types.ts'));
    const roles = extractStringArrayConst(typesSf, 'AGENT_ORDER');

    const exchangeTypesPath = existsSync(path.join(resolvedRoot, 'server/exchange/types.ts'))
      ? path.join(resolvedRoot, 'server/exchange/types.ts')
      : path.join(resolvedRoot, 'server/v2/contracts.ts');
    const exchangeTypesSf = findSourceFile(serverProject, exchangeTypesPath);
    const venueIds = extractStringArrayConst(exchangeTypesSf, 'EXCHANGES');
    const resolvedVenueIds = venueIds.length > 0
      ? venueIds
      : ['bybit', 'binance', 'okx', 'hyperliquid', 'aster', 'dydx', 'paradex', 'orderly'];
    const venues = [...resolvedVenueIds].sort().map((id) => ({
      id,
      status: id === 'bybit' ? 'verified' : 'experimental',
      targetOwner: VENUE_TARGET_TASK[id]
    }));

    // 5. CLI commands (bin/mpu.mjs + cli/session-entry.ts + cli/gb.ts)
    const mpuHelp = extractMpuCliHelp(resolvedRoot);
    const sessionEntryPath = existsSync(path.join(resolvedRoot, 'cli/session-entry.ts'))
      ? path.join(resolvedRoot, 'cli/session-entry.ts')
      : path.join(resolvedRoot, 'cli/v2/main.ts');
    const sessionEntrySf = findSourceFile(serverProject, sessionEntryPath);
    const applicationCommandsSet = new Set();
    if (sessionEntrySf) {
      walkAst(sessionEntrySf, (node) => {
        if (isArrayLiteralExpression(node)) {
          const vals = node.elements.filter(isStringLiteral).map((e) => e.text);
          if (vals.includes('setup') && vals.includes('doctor') && vals.includes('gb')) {
            for (const v of vals) applicationCommandsSet.add(v);
          }
        }
      });
    }
    const applicationCommands = applicationCommandsSet.size > 0
      ? [...applicationCommandsSet].sort()
      : ['autostart', 'backtest', 'bench-models', 'channels', 'debate', 'doctor', 'gb', 'kill', 'office-status', 'setup', 'trade', 'unkill', 'version'];

    const gbPath = existsSync(path.join(resolvedRoot, 'cli/gb.ts'))
      ? path.join(resolvedRoot, 'cli/gb.ts')
      : path.join(resolvedRoot, 'cli/v2/main.ts');
    const gbSf = findSourceFile(serverProject, gbPath);
    const gbSubcommandsSet = new Set();
    if (gbSf) {
      walkAst(gbSf, (node) => {
        if (!isSwitchStatement(node)) return;
        for (const clause of node.caseBlock.clauses) {
          if ('expression' in clause && clause.expression && isStringLiteral(clause.expression)) {
            const val = clause.expression.text;
            if (val !== 'help' && val !== '--help') gbSubcommandsSet.add(val);
          }
        }
      });
    }
    const gbSubcommands = gbSubcommandsSet.size > 0
      ? [...gbSubcommandsSet].sort()
      : ['account', 'backtest', 'cancel-entry', 'candles', 'capabilities', 'close', 'close-review', 'context', 'entries', 'event', 'health', 'lessons', 'market', 'open', 'positions', 'report', 'reports', 'research', 'scan', 'size', 'split', 'summary', 'symbol', 'venues'];

    // 6. Settings schemas via AST
    const tradingSettingsPath = existsSync(path.join(resolvedRoot, 'server/trading-settings.ts'))
      ? path.join(resolvedRoot, 'server/trading-settings.ts')
      : path.join(resolvedRoot, 'server/v2/settings/schema.ts');
    const tradingSettingsSf = serverProject.program.getSourceFile(tradingSettingsPath);
    const tradingKeys = extractObjectKeysFromZodDeclaration(tradingSettingsSf, 'TradingFields');
    const resolvedTradingKeys = tradingKeys.length > 0 ? tradingKeys : Object.keys(TRADING_FIELD_ERRORS);
    const tradingFields = resolvedTradingKeys.map((name) => ({
      name,
      targetOwner: 'T03',
      hotApply: 'prepare-then-activate-versioned',
      errorBehavior: TRADING_FIELD_ERRORS[name] ?? '400 invalid numeric trading field'
    }));

    const preferencesPath = existsSync(path.join(resolvedRoot, 'server/setup/preferences.ts'))
      ? path.join(resolvedRoot, 'server/setup/preferences.ts')
      : path.join(resolvedRoot, 'server/v2/settings/schema.ts');
    const preferencesSf = serverProject.program.getSourceFile(preferencesPath);
    const preferenceKeys = extractObjectKeysFromZodDeclaration(preferencesSf, 'PreferencesBody');
    const resolvedPreferenceKeys = preferenceKeys.length > 0 ? preferenceKeys : Object.keys(PREFERENCE_FIELD_ERRORS);
    const preferenceFields = resolvedPreferenceKeys.map((name) => ({
      name,
      targetOwner: 'T03',
      hotApply: 'prepare-then-activate-versioned',
      errorBehavior: PREFERENCE_FIELD_ERRORS[name] ?? '400 invalid preference field'
    }));

    // 7. Public assets & dependencies
    const assets = listFilesRecursive(path.join(resolvedRoot, 'web/public'));

    return {
      baseline: {
        projectName: 'Trading Agent Mpu Gandring',
        sha: BASELINE_SHA,
        appVersion: String(pkg.appVersion ?? '0.0.0.4.11'),
        packageVersion: String(pkg.version ?? '0.4.11'),
        nodeEngine: String(pkg.engines?.node ?? '>=20'),
        packageLockSha256: lockfileHash,
        sourceAttachments: SOURCE_ATTACHMENT_HASHES
      },
      dependencies: {
        runtime: pkg.dependencies ?? {},
        dev: pkg.devDependencies ?? {}
      },
      components,
      routes,
      websocket: {
        path: '/ws',
        serverEvents,
        replyEvents: ['command_result'],
        clientCommands: ['command'],
        additiveV2Events: ['candle', 'config.status', 'integration.status', 'resync']
      },
      cli: {
        mpuHelp,
        gbSubcommands,
        applicationCommands
      },
      roles,
      venues,
      settings: {
        tradingFields,
        preferenceFields,
        envExampleVars: extractEnvExampleKeys(resolvedRoot)
      },
      assets,
      decisions: DECISIONS,
      externalUnknowns: EXTERNAL_UNKNOWNS
    };
  } finally {
    api.close();
  }
}

function renderUiContractMarkdown(manifest) {
  const lines = [
    '# Trading Agent Mpu Gandring: Frozen UI, API, CLI, and Asset Contract',
    '',
    `Baseline SHA: \`${manifest.baseline.sha}\` | App Version: \`${manifest.baseline.appVersion}\` | Package Version: \`${manifest.baseline.packageVersion}\``,
    '',
    '## 1. Summary Counts',
    '',
    `- React TSX components frozen: **${manifest.components.length}**`,
    `- Interactive JSX controls mapped: **${manifest.components.reduce((n, c) => n + c.controls.length, 0)}**`,
    `- HTTP routes mapped: **${manifest.routes.length}** (${manifest.routes.filter((r) => r.mount !== 'standalone-inbound-webhook').length} main-app + ${manifest.routes.filter((r) => r.mount === 'standalone-inbound-webhook').length} standalone inbound webhook)`,
    `- WebSocket server events: **${manifest.websocket.serverEvents.length}** (\`${manifest.websocket.serverEvents.join('`, `')}\`)`,
    `- CLI \`mpu --help\` entries: **${manifest.cli.mpuHelp.length}** | \`gb\` subcommands: **${manifest.cli.gbSubcommands.length}** | session-entry targets: **${manifest.cli.applicationCommands.length}**`,
    `- Canonical roles: **${manifest.roles.length}** (\`${manifest.roles.join('`, `')}\`)`,
    `- Trading venues: **${manifest.venues.length}** (\`${manifest.venues.map((v) => `${v.id}:${v.status}`).join('`, `')}\`)`,
    `- Tracked \`web/public\` assets hashed: **${manifest.assets.length}**`,
    '',
    '## 2. Component Inventory',
    '',
    '| Component | Screen / Surface | Controls | API Calls | Storage Keys | Owner | Behavior Test |',
    '|---|---|---:|---|---|---|---|'
  ];

  for (const c of manifest.components) {
    const meta = COMPONENT_METADATA[c.name];
    lines.push(
      `| \`${c.name}\` | ${c.screen} | ${c.controls.length} | ${c.apiCalls.map((x) => `\`${x}\``).join(', ') || 'none'} | ${c.storageKeys.map((x) => `\`${x}\``).join(', ') || 'none'} | \`${meta.owner}\` | \`${meta.test}\` |`
    );
  }

  lines.push(
    '',
    '## 3. HTTP Route Contract Inventory',
    '',
    '| Method | Path | Mount | Auth | Hot-Apply Semantics | Owner | Error Behavior | Behavior Test |',
    '|---|---|---|---|---|---|---|---|'
  );

  for (const r of manifest.routes) {
    lines.push(
      `| \`${r.method}\` | \`${r.path}\` | \`${r.mount}\` | \`${r.auth}\` | \`${r.hotApply}\` | \`${r.targetOwner}\` | ${r.errorBehavior} | \`${r.behaviorTest}\` |`
    );
  }

  lines.push(
    '',
    '## 4. Settings Field Ownership',
    '',
    '### Trading Profile Fields (`TradingFields`)',
    '',
    '| Field | Owner | Error Behavior |',
    '|---|---|---|'
  );
  for (const f of manifest.settings.tradingFields) {
    lines.push(`| \`${f.name}\` | \`${f.targetOwner}\` | ${f.errorBehavior} |`);
  }

  lines.push(
    '',
    '### Desk Preference Fields (`PreferencesBody`)',
    '',
    '| Field | Owner | Error Behavior |',
    '|---|---|---|'
  );
  for (const f of manifest.settings.preferenceFields) {
    lines.push(`| \`${f.name}\` | \`${f.targetOwner}\` | ${f.errorBehavior} |`);
  }

  lines.push(
    '',
    '## 5. CLI Dispatch Surface',
    '',
    '| `mpu` Command | Syntax | Target Dispatch |',
    '|---|---|---|'
  );
  for (const c of manifest.cli.mpuHelp) {
    lines.push(`| \`${c.command}\` | \`${c.syntax}\` | \`${c.dispatch}\` |`);
  }

  lines.push('');
  return lines.join('\n');
}

function renderDecisionsMarkdown(manifest) {
  const lines = [
    '# Trading Agent Mpu Gandring: Reconciled Rebirth Decisions and Unknowns',
    '',
    `Baseline SHA: \`${manifest.baseline.sha}\` | App Version: \`${manifest.baseline.appVersion}\``,
    '',
    '## 1. Architecture and Policy Decisions (`D01`..`D12`)',
    '',
    '| ID | Status | Decision | Rationale and Boundary |',
    '|---|---|---|---|'
  ];

  for (const d of manifest.decisions) {
    lines.push(`| \`${d.id}\` | **${d.status}** | ${d.title} | ${d.summary} |`);
  }

  lines.push(
    '',
    '## 2. Source Attachment Provenance (SHA-256)',
    '',
    'Source attachments are specification inputs only and never grant operational, trading, git push, or remote bot mutation authority.',
    '',
    '| Attachment | SHA-256 |',
    '|---|---|'
  );

  for (const s of manifest.baseline.sourceAttachments) {
    lines.push(`| \`${s.file}\` | \`${s.sha256}\` |`);
  }

  lines.push(
    '',
    '## 3. Declared External Unknowns (`U01`..`U06`)',
    '',
    '| ID | Area | Calibration | Boundary |',
    '|---|---|---|---|'
  );

  for (const u of manifest.externalUnknowns) {
    lines.push(`| \`${u.id}\` | ${u.area} | *${u.calibration}* | ${u.detail} |`);
  }

  lines.push('');
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = collectContracts(root);
  if (process.argv.includes('--write')) {
    const outDir = path.join(root, 'docs/rebirth');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'baseline.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeFileSync(path.join(outDir, 'ui-contract.md'), renderUiContractMarkdown(manifest));
    writeFileSync(path.join(outDir, 'decisions.md'), renderDecisionsMarkdown(manifest));
    console.log(`Wrote docs/rebirth/{baseline.json,ui-contract.md,decisions.md} (${manifest.components.length} components, ${manifest.routes.length} routes).`);
  } else {
    console.log(JSON.stringify({ components: manifest.components.length, routes: manifest.routes.length, cli: manifest.cli.mpuHelp.length }));
  }
}
