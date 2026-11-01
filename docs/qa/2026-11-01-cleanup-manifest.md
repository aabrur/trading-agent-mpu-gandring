# Mpu Gandring V2 Legacy Cleanup and Lifecycle Manifest

**Date:** 2026-11-01 Asia/Jakarta  
**Author:** Maya  
**Branch:** `repair/v2-live-integrity`  
**Baseline Git SHA:** `49ba0c15235caecb1d7931e767aa7f6872e2838f`  
**Status:** Validated Technical Manifest  

---

## 1. Executive Summary & Policy

This manifest audits every major subsystem in the repository to establish exact boundaries between active Rebirth V2 runtime code, transitional compatibility bridges, and legacy components.

### Non-Negotiable Safety Constraints
1. **Zero Data Loss:** Never delete user trading state, journal databases (`.mpu-gandring/`, `runtime.sqlite`), `.env` files, or historical financial logs.
2. **Guards Are Immutable:** Official system guards (`server/live/guard.ts`, `server/live/resting-stop.ts`, `server/v2/execution/protection.ts`, kill switches, withdrawal prohibitions) remain strictly preserved.
3. **No Bulk Removals:** Never run bulk deletion commands like `rm -rf server` or `rm -rf data`. Every proposed retirement must be backed by import graph verification and a verified rollback path.

---

## 2. Classification Taxonomy

Each candidate artifact is assigned one of four operational statuses:

- `KEEP`: Essential to the active V2 runtime, official guards, or active CLI interfaces. Must not be modified or deleted without explicit architecture review.
- `CONSOLIDATE`: Overlapping functionality between legacy V1 and Rebirth V2 that will be unified into `server/v2/` after downstream consumers switch.
- `ARCHIVE`: Historical logs, evidence manifests, and test fixtures that must be retained read-only for reproducibility and compliance audits.
- `REMOVE_AFTER_EVIDENCE`: Dead code or abandoned prototypes that have zero active consumers across `bin/`, `server/v2/`, `web/`, and `tests/`. Can only be deleted after running full regression suites.

---

## 3. Subsystem Dependency & Lifecycle Matrix

| Subsystem / Path | Current Role | Target Classification | Evidence & Consumer Basis | Rollback Safety |
|---|---|---|---|---|
| `server/v2/*` | Active Rebirth V2 runtime, execution gateway, settings, and REST API | `KEEP` | Primary production engine mounted by `createReplacementApp` and `createReplacementRuntime` | Baseline git commit |
| `server/live/guard.ts` | Pre-flight trading checks, withdrawal prevention, and credential validation | `KEEP` | Mandatory system guard imported by CLI `doctor.ts` and `setup.ts` | Immediate rollback |
| `server/live/resting-stop.ts` | Verification that stop loss rests on the exchange | `KEEP` | Mandatory exchange guard required for TESTNET and LIVE trading | Immediate rollback |
| `server/live/executor.ts` | Legacy V1 execution pipeline | `CONSOLIDATE` | Used by legacy `tests/live.test.ts`; execution logic has been rebuilt in `server/v2/execution/gateway.ts` | Retain until V1 tests migrate |
| `server/config.ts` | Legacy environment parser and credential mapping | `CONSOLIDATE` | Consumed by CLI tools (`bin/mpu.mjs`, `cli/setup.ts`, `cli/doctor.ts`) | Keep until CLI fully migrates to V2 settings |
| `server/runtime.ts` | Legacy V1 in-memory runtime | `CONSOLIDATE` | Used by `server/desk.ts` and older unit tests; isolated from `server/v2/` | Keep until legacy tests are updated |
| `server/desk.ts` | Legacy V1 desk coordinator | `CONSOLIDATE` | Used by root `server/index.ts` when running in V1 mode | Keep until root server launcher switches default |
| `server/index.ts` | Primary HTTP and WebSocket server entrypoint | `KEEP` | Standard entrypoint booted by `npm run dev` and `npm start` | Git rollback |
| `bin/mpu.mjs` | Unified command-line interface entrypoint | `KEEP` | Core operator interface supporting `mpu setup`, `mpu doctor`, `mpu account`, `mpu kill` | Git rollback |
| `cli/setup.ts` | Interactive terminal setup wizard | `KEEP` | Primary onboarding mechanism for offline and local operators | Git rollback |
| `cli/doctor.ts` | Live credential and permission verification tool | `KEEP` | Primary safety audit tool for checking trade permissions and withdrawal restrictions | Git rollback |
| `cli/channels.ts` | Multi-channel supervisor notification tool | `KEEP` | Active supervisor interface for Telegram, Discord, Slack, and WhatsApp | Git rollback |
| `web/src/*` | React 19 single-page office interface | `KEEP` | Operator web application with AgentPanel, Discussion, and Setup views | Build artifacts in `dist/web` |
| `docs/roadmap/*` | Stage-gate verification evidence (S1-S5) | `ARCHIVE` | Required by `scripts/mpu-gate.mjs` for cryptographic evidence verification | Git history |
| `docs/qa/*` | Acceptance manifests and technical baseline documents | `ARCHIVE` | Audit trail for Rebirth V2 repairs and verification | Immutable documentation |
| `docs/superpowers/*` | Architecture design specs and task execution plans | `ARCHIVE` | Permanent design record for V2 implementation | Git history |
| `data/learnings.json` | Persistent autonomous agent reflections | `KEEP` | Owner lessons and agent reflection memory | File backup |

---

## 4. Verification & Certainty Assessment

- **System Guards Protection:** *certain* (based on direct inspection of `server/live/guard.ts` and `server/live/resting-stop.ts` dependencies).
- **V2 Runtime Isolation:** *certain* (verified with `node scripts/check-runtime-boundary.mjs` returning 0 boundary violations across 68 source files).
- **Type Safety & Build Cleanliness:** *certain* (verified with `npm run typecheck` and `npm run build` exiting with code 0).
- **Test Integrity:** *certain* (verified with 199 test files and 1364 tests passing with zero failures).

---

## 5. Deletion Rollback Protocol

When any candidate marked `REMOVE_AFTER_EVIDENCE` is scheduled for removal:
1. Capture current Git commit SHA: `git rev-parse HEAD`.
2. Delete the targeted file individually: `git rm <path>`.
3. Execute validation suite:
   ```bash
   npm run typecheck
   node scripts/check-runtime-boundary.mjs
   npm test
   npm run build
   ```
4. If any test or typecheck fails, immediately restore the file: `git checkout HEAD -- <path>`.
5. Only commit removals that pass the complete validation suite.
