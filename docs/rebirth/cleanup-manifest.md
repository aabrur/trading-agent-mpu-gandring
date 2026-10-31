# Rebirth Runtime Cleanup Manifest

This manifest documents the classification of codebase paths between the legacy v1 runtime and the replacement v2 architecture.

## 1. Classification Principles

1. **Zero Data Loss**: User `.env`, session logs, journals, and reports are protected and never deleted.
2. **Explicit Replacement**: A legacy file is marked for retirement only when its functionality is completely implemented and verified in `server/v2/` with matching test coverage.
3. **Safety Isolation**: Legacy files remain intact until Boss explicitly reviews and approves the retirement execution step.

## 2. Component Inventory & Classification

| Path | Classification | Replacement in v2 | Test Coverage | Retention Reason |
|---|---|---|---|---|
| `server/v2/**` | Retain (Core v2) | N/A | `tests/rebirth/**` | Active replacement runtime |
| `shared/**` | Retain (Shared) | N/A | `tests/rebirth/api-parity.test.ts` | Wire contracts between backend and web office |
| `cli/v2/**` | Retain (CLI v2) | N/A | `tests/rebirth/cli.test.ts` | Modern CLI client and supervisor |
| `server/index.ts` | Retain (Entry) | N/A | `tests/rebirth/launcher.test.ts` | Production server entry point pointing to v2 runtime |
| `server/session-entry.ts` | Retain (Diagnostics) | N/A | `tests/rebirth/launcher.test.ts` | Session bootstrap and diagnostic context |
| `server/session-log.ts` | Retain (Logging) | N/A | `tests/rebirth/launcher.test.ts` | Redacted session logging |
| `server/redact.ts` | Retain (Security) | N/A | `tests/rebirth/tool-security.test.ts` | Secret masking and sanitization |
| `server/untrusted.ts` | Retain (Security) | N/A | `tests/rebirth/tool-security.test.ts` | Untrusted external content boundary |
| `web/**` | Retain (UI) | N/A | `tests/rebirth/office-browser.test.ts` | Virtual office frontend (100% UI parity) |
| `server/auto.ts` | Candidate for Retirement | `server/v2/decision/cycle.ts` | `tests/rebirth/debate.test.ts` | Replaced by deterministic CycleRunner |
| `server/debate.ts` | Candidate for Retirement | `server/v2/decision/cycle.ts` | `tests/rebirth/debate.test.ts` | Replaced by multi-agent debate pipeline |
| `server/engine.ts` | Candidate for Retirement | `server/v2/runtime.ts` | `tests/rebirth/system.test.ts` | Replaced by ReplacementRuntime |
| `server/roles.ts` | Candidate for Retirement | `server/v2/agents/runner.ts` | `tests/rebirth/roles.test.ts` | Replaced by SixRoleRunner and persona matrix |
| `server/risk.ts` | Candidate for Retirement | `server/v2/execution/protection.ts` | `tests/rebirth/protection.test.ts` | Replaced by ProtectionService |
| `server/money.ts` | Candidate for Retirement | `server/v2/execution/gateway.ts` | `tests/rebirth/gateway.test.ts` | Replaced by ExecutionGateway and sizing rules |
| `server/exchange/**` | Candidate for Retirement | `server/v2/execution/adapters/**` | `tests/rebirth/venue-*.test.ts` | Replaced by 8 standard venue adapters |
| `server/live/**` | Candidate for Retirement | `server/v2/execution/gateway.ts` | `tests/rebirth/gateway.test.ts` | Replaced by ExecutionGateway |
| `server/channels/**` | Candidate for Retirement | `server/v2/channels.ts` | `tests/rebirth/channels.test.ts` | Replaced by v2 Desk Lead channels supervisor |
| `server/setup/**` | Candidate for Retirement | `server/v2/settings/**` | `tests/rebirth/settings.test.ts` | Replaced by versioned SettingsService |

## 3. Protected Paths (Never Deleted)

- `.env` and `.env.*`
- `data/`
- `reports/`
- Historical git commit tree
