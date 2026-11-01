# Source Baseline and Dependency Verification

Date: 2026-11-01 Asia/Jakarta
Repository: aabrur/trading-agent-mpu-gandring
Verified Commit SHA: 49ba0c15235caecb1d7931e767aa7f6872e2838f
Active Worktree Branch: repair/v2-live-integrity
Parent Merge Base: 49ba0c15235caecb1d7931e767aa7f6872e2838f

## Runtime Environment
- Node: v24.15.0
- npm: 11.17.0
- OS: Windows 11 / PowerShell

## Clean Baseline Checks
- `git status --short`: clean working tree at SHA 49ba0c15235caecb1d7931e767aa7f6872e2838f
- `git rev-parse HEAD`: 49ba0c15235caecb1d7931e767aa7f6872e2838f
- `npm run typecheck`: Passed (exit code 0, 3 tsconfigs: server, web, rebirth)
- `npm test`: Passed (195 test files, 1348 tests passed, 0 failures, 337.85s)
- `npm run build`: Passed (Vite client bundle generated in dist/web, server in dist/server)
- `npm run build:rebirth`: Passed (tsc -p tsconfig.rebirth.json exit code 0)
- `git apply --check mpu_v2_surgical_repairs.patch`: Passed with exit code 0 against baseline SHA 49ba0c15235caecb1d7931e767aa7f6872e2838f

## Candidate Patch Inspection
The candidate patch `mpu_v2_surgical_repairs.patch` covers 16 files (329 insertions, 154 deletions):
1. `server/v2/agents/runner.ts`: Typed `RoleRunner.chat()` method added.
2. `server/v2/api/chat.ts`: Returns `conversationId: conv.id`, adds `DELETE /api/conversations/:id`, sets default id to `office`.
3. `server/v2/contracts.ts`: Extends `handleCommand` interface to include `conversationId`.
4. `server/v2/api/operations.ts`: Forwards `conversationId` to `runtime.handleCommand`.
5. `server/v2/runtime.ts`: Scopes chat to `conversationId`, handles `@all` fanout across 6 roles, replaces private field reflection with `roleRunner.chat()`.
6. `web/src/useDesk.ts`: Fixes `requestNewConversation` to read both `conversationId` and `conversation.id`, adds `deleteConversation`.
7. `web/src/App.tsx`: Plumbs `deleteConversation` and `onNewConversation` to panels.
8. `web/src/components/Office.tsx`: Passes `deleteConversation` down to `OfficeDiscussion`.
9. `web/src/components/OfficeDiscussion.tsx`: Adds Delete button with confirm dialog for non-office conversations.
10. `web/src/components/AgentPanel.tsx`: Adds New chat and Delete chat controls.
11. `server/v2/api/local-agents.ts`: Replaces fake `connected: true` with `state: 'installed_unverified'`, rejects unverified CLI model flags with 422, returns 501 for unpersisted `/settings`.
12. `web/src/components/LocalAgentsSetup.tsx`: Fixes `refreshModels` to update single row from `discovery` without wiping roster.
13. `server/v2/api/setup.ts`: Mounts all 10 V2 API providers plus local and mock from `MODEL_CHOICES`.
14. `web/src/components/ModelsSetup.tsx`: Clarifies active catalog source text.
15. `tests/repair-contracts.node.test.mjs`: Structural assertion suite (9 tests).
16. `tests/rebirth/chat-repair.test.ts`: Vitest conversation lifecycle tests.

## Missing Tasks in Initial Candidate Patch
As noted in the spec and plan, the candidate patch is only an initial partial repair. Remaining required work:
- T3: SQLite durable persistence for conversations and chat messages in `server/v2/store/`.
- T4: Responsive discussion layout and visual error handling.
- T5: Full CLI capability verification (actual probes, model flags, settings persistence).
- T6: Authenticated model catalog for all 10 API providers with up to 25 verified real models and manual ID support.
- T7: Active six-role runtime model assignment wired dynamically to SettingsService.
- T8: LIVE execution reconciliation: distinguish SUBMITTED ACK from FILLED, verify CLOSE on venue.
- T9: Wallet delegated agent verification and persistence callbacks in production mount.
- T10: Modern Whale Alert live subscription, CCXT read-only optional integration, TradingView distinct alert queue.
- T12: Removal of undocumented strategy throttles while preserving system guards.
- T11: Evidence-based legacy cleanup manifest.
- T13: End-to-end acceptance report in `docs/qa/2026-11-01-acceptance.md`.
