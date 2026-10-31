import { createHash, randomUUID } from 'node:crypto';
import type {
  AccountScope,
  Network,
  TradingMode,
  VenueId
} from '../contracts.js';
import type { RuntimeStore } from '../store/database.js';
import type { ExecutionAuthorityService } from './authority.js';

export interface AccountContext {
  scope: AccountScope;
  lifecycle: 'ACTIVE' | 'DRAINING';
  pendingIntentIds: string[];
  positionRefs: string[];
}

interface InternalAccountRecord {
  scope: AccountScope;
  nativeIdentityHash: string;
  lifecycle: 'ACTIVE' | 'DRAINING' | 'RETIRED';
  pendingIntentIds: string[];
  positionRefs: string[];
}

function hashNativeIdentity(params: {
  venue: VenueId;
  network: Network;
  mode: TradingMode;
  subaccountRef: string | null;
  nativeIdentity: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        venue: params.venue,
        network: params.network,
        mode: params.mode,
        subaccountRef: params.subaccountRef ?? '',
        nativeIdentity: params.nativeIdentity.trim().toLowerCase()
      })
    )
    .digest('hex');
}

export class AccountRegistry {
  private readonly records = new Map<string, InternalAccountRecord>();

  private constructor(
    private readonly store: RuntimeStore,
    private readonly authority: ExecutionAuthorityService
  ) {}

  static async open(
    store: RuntimeStore,
    authority: ExecutionAuthorityService
  ): Promise<AccountRegistry> {
    const registry = new AccountRegistry(store, authority);
    await registry.reload();
    return registry;
  }

  async reload(): Promise<void> {
    const rows = await this.store.execute(
      `SELECT account_ref, venue, network, mode, native_identity_hash, subaccount_ref, lifecycle_state, metadata_json
       FROM accounts`
    );
    const openPositions = await this.store.execute(
      `SELECT account_ref, position_key FROM managed_positions WHERE closed_at IS NULL`
    );
    const pendingIntents = await this.store.execute(
      `SELECT account_ref, intent_id FROM execution_intents
       WHERE order_state IN ('CREATED', 'JOURNALED', 'SUBMITTING', 'ACCEPTED', 'UNKNOWN', 'PARTIAL')`
    );

    const posByAcct = new Map<string, Set<string>>();
    for (const r of openPositions.rows) {
      const ref = String(r.account_ref);
      if (!posByAcct.has(ref)) posByAcct.set(ref, new Set());
      posByAcct.get(ref)!.add(String(r.position_key));
    }

    const intentByAcct = new Map<string, Set<string>>();
    for (const r of pendingIntents.rows) {
      const ref = String(r.account_ref);
      if (!intentByAcct.has(ref)) intentByAcct.set(ref, new Set());
      intentByAcct.get(ref)!.add(String(r.intent_id));
    }

    this.records.clear();
    for (const row of rows.rows) {
      const accountRef = String(row.account_ref);
      let meta: { pendingIntentIds?: string[]; positionRefs?: string[] } = {};
      try {
        meta = JSON.parse(String(row.metadata_json ?? '{}')) as typeof meta;
      } catch {
        meta = {};
      }
      const mergedPos = new Set<string>([
        ...(meta.positionRefs ?? []),
        ...(posByAcct.get(accountRef) ?? [])
      ]);
      const mergedIntents = new Set<string>([
        ...(meta.pendingIntentIds ?? []),
        ...(intentByAcct.get(accountRef) ?? [])
      ]);

      this.records.set(accountRef, {
        scope: {
          accountRef,
          venue: String(row.venue) as VenueId,
          network: String(row.network) as Network,
          mode: String(row.mode) as TradingMode,
          subaccountRef: row.subaccount_ref === null ? null : String(row.subaccount_ref)
        },
        nativeIdentityHash: String(row.native_identity_hash),
        lifecycle: String(row.lifecycle_state) as 'ACTIVE' | 'DRAINING' | 'RETIRED',
        pendingIntentIds: [...mergedIntents],
        positionRefs: [...mergedPos]
      });
    }
  }

  async register(input: {
    accountRef?: string;
    venue: VenueId;
    network: Network;
    mode: TradingMode;
    nativeIdentity: string;
    subaccountRef: string | null;
  }): Promise<AccountScope> {
    const identityHash = hashNativeIdentity(input);
    const existing = await this.store.execute(
      `SELECT account_ref, subaccount_ref FROM accounts
       WHERE venue = ? AND network = ? AND native_identity_hash = ? AND COALESCE(subaccount_ref, '') = ? AND mode = ?`,
      [input.venue, input.network, identityHash, input.subaccountRef ?? '', input.mode]
    );
    if (existing.rows.length > 0) {
      const accountRef = String(existing.rows[0]!.account_ref);
      await this.reload();
      return this.records.get(accountRef)!.scope;
    }

    const accountRef =
      input.accountRef ??
      `acct-${input.venue}-${input.network}-${identityHash.slice(0, 12)}`;
    const nowIso = new Date().toISOString();

    await this.store.transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO accounts (
          account_ref, venue, network, mode, native_identity_hash, subaccount_ref, lifecycle_state, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'RETIRED', '{}', ?, ?)`,
        [
          accountRef,
          input.venue,
          input.network,
          input.mode,
          identityHash,
          input.subaccountRef,
          nowIso,
          nowIso
        ]
      );
      await tx.append({
        eventId: `acct-registered-${accountRef}-${randomUUID()}`,
        scope: accountRef,
        kind: 'account.registered',
        createdAt: nowIso,
        correlationId: null,
        causationId: null,
        schemaVersion: 1,
        payload: {
          accountRef,
          venue: input.venue,
          network: input.network,
          mode: input.mode,
          subaccountRef: input.subaccountRef
        }
      });
    });

    await this.reload();
    return this.records.get(accountRef)!.scope;
  }

  async resolveOrRegister(input: {
    venue: VenueId;
    network: Network;
    mode: TradingMode;
    nativeIdentity: string;
    subaccountRef: string | null;
  }): Promise<AccountScope> {
    return this.register(input);
  }

  async activate(accountRef: string): Promise<void> {
    const target = this.records.get(accountRef);
    if (!target) {
      throw new Error(`Account "${accountRef}" is not registered.`);
    }

    const nowIso = new Date().toISOString();
    await this.store.transaction(async (tx) => {
      for (const [ref, rec] of this.records.entries()) {
        if (ref === accountRef) continue;
        if (rec.lifecycle === 'ACTIVE') {
          const hasOpenWork = rec.positionRefs.length > 0 || rec.pendingIntentIds.length > 0;
          const nextState = hasOpenWork ? 'DRAINING' : 'RETIRED';
          await tx.execute(
            `UPDATE accounts SET lifecycle_state = ?, updated_at = ? WHERE account_ref = ?`,
            [nextState, nowIso, ref]
          );
          await tx.append({
            eventId: `acct-transition-${ref}-${nextState}-${randomUUID()}`,
            scope: ref,
            kind: 'account.lifecycle_changed',
            createdAt: nowIso,
            correlationId: null,
            causationId: null,
            schemaVersion: 1,
            payload: { accountRef: ref, from: 'ACTIVE', to: nextState }
          });
        }
      }

      await tx.execute(
        `UPDATE accounts SET lifecycle_state = 'ACTIVE', updated_at = ? WHERE account_ref = ?`,
        [nowIso, accountRef]
      );
      await tx.append({
        eventId: `acct-activated-${accountRef}-${randomUUID()}`,
        scope: accountRef,
        kind: 'account.activated',
        createdAt: nowIso,
        correlationId: null,
        causationId: null,
        schemaVersion: 1,
        payload: { accountRef }
      });
    });

    await this.authority.claim(accountRef);
    await this.reload();
  }

  async attachExposure(
    accountRef: string,
    exposure: { positionRefs?: string[]; pendingIntentIds?: string[] }
  ): Promise<void> {
    const rec = this.records.get(accountRef);
    if (!rec) {
      throw new Error(`Account "${accountRef}" is not registered.`);
    }
    const nextPositions = [...new Set([...rec.positionRefs, ...(exposure.positionRefs ?? [])])];
    const nextIntents = [...new Set([...rec.pendingIntentIds, ...(exposure.pendingIntentIds ?? [])])];
    const nowIso = new Date().toISOString();

    await this.store.transaction(async (tx) => {
      await tx.execute(
        `UPDATE accounts SET metadata_json = ?, updated_at = ? WHERE account_ref = ?`,
        [
          JSON.stringify({
            positionRefs: nextPositions,
            pendingIntentIds: nextIntents
          }),
          nowIso,
          accountRef
        ]
      );
    });
    await this.reload();
  }

  async clearExposure(accountRef: string): Promise<void> {
    const rec = this.records.get(accountRef);
    if (!rec) return;
    const nowIso = new Date().toISOString();
    const nextLifecycle = rec.lifecycle === 'DRAINING' ? 'RETIRED' : rec.lifecycle;

    await this.store.transaction(async (tx) => {
      await tx.execute(
        `UPDATE accounts SET lifecycle_state = ?, metadata_json = ?, updated_at = ? WHERE account_ref = ?`,
        [
          nextLifecycle,
          JSON.stringify({ positionRefs: [], pendingIntentIds: [] }),
          nowIso,
          accountRef
        ]
      );
      if (rec.lifecycle === 'DRAINING') {
        await tx.append({
          eventId: `acct-retired-${accountRef}-${randomUUID()}`,
          scope: accountRef,
          kind: 'account.lifecycle_changed',
          createdAt: nowIso,
          correlationId: null,
          causationId: null,
          schemaVersion: 1,
          payload: { accountRef, from: 'DRAINING', to: 'RETIRED' }
        });
      }
    });
    await this.reload();
  }

  activeAccountRef(): string | null {
    for (const [ref, rec] of this.records.entries()) {
      if (rec.lifecycle === 'ACTIVE') return ref;
    }
    return null;
  }

  contexts(): AccountContext[] {
    const out: AccountContext[] = [];
    for (const rec of this.records.values()) {
      if (rec.lifecycle === 'ACTIVE' || rec.lifecycle === 'DRAINING') {
        out.push({
          scope: structuredClone(rec.scope),
          lifecycle: rec.lifecycle,
          pendingIntentIds: [...rec.pendingIntentIds],
          positionRefs: [...rec.positionRefs]
        });
      }
    }
    return out;
  }
}
