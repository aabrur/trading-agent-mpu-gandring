# Trading Agent Mpu Gandring: compatibility and rollback

## Defaults and authorization

Certain, based on unchanged admission code and fixtures: omitted `entry` means MARKET. No saved trading mode, strategy formula, allocation, leverage, N, safety net, daily loss limit, symbol list, confidence threshold, cadence or environment file is changed by this patch. Existing guards and network-scoped Setup flows remain authoritative.

The additional API input is:

```ts
entry?: { type: 'MARKET' } | { type: 'LIMIT_GTC'; price: number; expireAt?: number };
clientId?: string;
```

Strict discriminated validation rejects MARKET with a price and LIMIT_GTC without a finite positive price. A supplied `clientId` requires LIMIT_GTC and follows the repo's 32-character client ID bound, leaving room for protection suffixes. `expireAt` is an optional absolute UTC millisecond timestamp. There is no implicit expiration.

Existing local-owner and bearer-authenticated OPEN routes accept the additive selection through the same risk/sizing/execution path. Agent OPEN still requires Risk APPROVE and the active Owner confidence. No free-text reason or agent proposal is parsed for limit flags. Model-generated instructions do not authorize selecting a new order type; role instructions require explicit Owner selection.

CLI additions, for a separately authorized operational session:

```text
gb open SYMBOL LONG|SHORT --limit PRICE [--ttl-min MINUTES] [--client-id ID]
gb entries --json
gb cancel-entry CLIENT_ID --json
gb symbol 1000FLOKIUSDT 15m --network mainnet --json
```

`--ttl-min` is a relative convenience input. Repeating it later creates a different deadline. For an identical API replay, retain the original `entry.expireAt` or inspect `entries` instead. Never create a new client ID to retry an ambiguous order. Unsupported adapters refuse explicit GTC; they do not silently submit MARKET. PAPER has no GTC simulator and refuses that new selection without an attached Aster executor.

## Pending-entry representation

`context.pendingEntries` and `gb entries` expose recorded intent/order ID, symbol, side, intended/filled/remaining quantities, limit, venue/network, times, explicit expiration and protection status. Historical GTC records are included with their terminal state until normal journal retention removes them. These reads do not send an exchange request.

RESTING is not a fill. A zero-filled resting entry occupies one slot. A partial entry and its filled position together occupy one slot through the existing pending-slot calculation. N is neither increased nor reduced. Sizing uses the side-aware tick-adjusted explicit limit and the current Owner profile. The native quote remains separately labeled as the observed ticker price.

States: CREATED, SUBMITTED, RESTING, PARTIAL, FILLED, CANCEL_REQUESTED, CANCELLED, EXPIRED, REJECTED and UNKNOWN. The existing synchronization pass performs GET-order reconciliation and optional explicit expiry cancellation. No new background timer or debate-change cancellation is installed. Deadline enforcement occurs on the next existing reconciliation, not at an exact independent timer instant.

The journal is persisted before submission. Recovery reads the same client ID and never resubmits an uncertain entry. A crash before/after send can leave UNKNOWN, which is deliberately unresolved until exchange readback. Order acceptance timestamps mean the first successful readback observed by the process, not an invented matching-engine timestamp.

Actual partial/full exposure is protected after it is observed. Aster close-all stops cover the current net position; existing quantity-limited stops must demonstrate sufficient quantity. Unknown readback is labeled unknown. A confirmed missing stop cancels the remaining entry and uses the established reduce-only protective close path. Stop read/placement errors do not justify duplicating entry or protection requests.

`cancel-entry` targets the entry's client ID only. It does not sweep symbol orders or remove protection from already-filled exposure. Manual CLOSE cancels the pending remainder, reconciles late fills, and closes observed filled exposure. An unresolved cancellation remains recorded and later fills are reconciled/protected. Kill retains its emergency cancel-all/flatten contract, includes resting-entry symbols and avoids duplicating unresolved emergency closes.

## Persistent compatibility

Execution journal additions are optional fields on existing intents. Existing MARKET journals remain readable without conversion. New GTC intents include entry selection/state, venue/network, IDs, limit, cumulative quantities, timing, cancellation/protection state and emergency covered-fill checkpoints. Invalid or mismatched GTC venue/network records fail closed. There is no automatic migration of the Owner's journals.

Kill records retain `{at, reason}` compatibility and add optional source/request ID. The first activation is preserved using exclusive creation; an unreadable existing record remains protected. Audit events append to `<kill-file>.audit.jsonl` with sanitized reason and UUID correlation, without user identifiers. The default audit path is ignored by Git. Custom kill-file locations need equivalent local exclusion. Audit append failure is surfaced in CLI output, API `auditConfirmed` and state `killAuditConfirmed`; a latched kill remains active. Reset permissions and release behavior are unchanged.

Market/news/runtime metadata are additive. Legacy candle fields and raw numeric volumes remain valid. Existing rounded tape fields remain for compatibility; full-precision values are in `rawVolumes`. Unknown diagnostic measurements are null rather than synthetic 1.0. No code-coverage percentage is implied by fixture coverage.

## Rollback boundary

Do not start an older executable while a GTC intent is RESTING, PARTIAL, CANCEL_REQUESTED or UNKNOWN: older code cannot manage this lifecycle. Under separate Owner authorization, first reconcile the venue, cancel remaining entries, confirm final fills, and confirm current positions remain protected. Preserve current journals, audit files, reports, secret store and `.env`. Never delete unknown intents to make rollback start.

With no unresolved GTC entries, code rollback can select the baseline in an isolated checkout and rebuild it. Preserve the current journal and additional optional fields. A LIVE process restart or a host/routine/profile update still needs its own authorization. This patch performed none of those actions.
