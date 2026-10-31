import { safe } from '../../../redact.js';
import type { BridgeEvent } from './protocol.js';
import type { VerifiedPeerEvent } from './auth.js';

export type BridgeReceiptStatus =
  | 'QUEUED'
  | 'ACCEPTED_BY_WEBHOOK'
  | 'REMOTE_PENDING'
  | 'REMOTE_COMPLETED'
  | 'REJECTED'
  | 'EXPIRED';

export interface BridgeReceipt {
  eventId: string;
  status: BridgeReceiptStatus;
  reason?: string;
}

export interface GrokIntegrationStatus {
  desiredMode: 'disabled' | 'enabled';
  observedHealth: 'HEALTHY' | 'OUTBOUND_ONLY' | 'DEGRADED' | 'DISCONNECTED';
  lastAcceptedAt: number | null;
  lastCallbackAt: number | null;
  lastAcknowledgedConfigVersion: number;
  pendingEvents: number;
  lastError: string | null;
}

export interface GrokBridgeOptions {
  webhookUrl?: string;
  webhookPoster?: (url: string, body: unknown) => Promise<{ ok: boolean; status: number; error?: string }>;
  gateway?: unknown;
}

export class GrokBridge {
  private cache = new Map<string, BridgeReceipt>();
  private pendingCount = 0;
  private lastAcceptedAt: number | null = null;
  private lastCallbackAt: number | null = null;
  private lastAckVersion = 0;
  private lastError: string | null = null;
  private health: GrokIntegrationStatus['observedHealth'] = 'DISCONNECTED';

  constructor(private options: GrokBridgeOptions = {}) {}

  public async enqueue(event: BridgeEvent): Promise<BridgeReceipt> {
    const cached = this.cache.get(event.eventId);
    if (cached) {
      return cached;
    }

    if (!this.options.webhookPoster || !this.options.webhookUrl) {
      const receipt: BridgeReceipt = {
        eventId: event.eventId,
        status: 'QUEUED',
        reason: 'Outbound webhook URL not configured'
      };
      this.cache.set(event.eventId, receipt);
      return receipt;
    }

    try {
      this.pendingCount += 1;
      const res = await this.options.webhookPoster(this.options.webhookUrl, event);

      if (res.ok) {
        this.lastAcceptedAt = Date.now();
        this.health = 'OUTBOUND_ONLY';
        const receipt: BridgeReceipt = {
          eventId: event.eventId,
          status: 'ACCEPTED_BY_WEBHOOK',
          reason: 'Webhook accepted outbound event; awaiting remote callback.'
        };
        this.cache.set(event.eventId, receipt);
        return receipt;
      } else {
        this.lastError = safe(res.error ?? `Webhook error HTTP ${res.status}`);
        this.health = 'DEGRADED';
        const receipt: BridgeReceipt = {
          eventId: event.eventId,
          status: 'REJECTED',
          reason: this.lastError
        };
        this.cache.set(event.eventId, receipt);
        return receipt;
      }
    } catch (err) {
      this.lastError = safe((err as Error).message);
      this.health = 'DEGRADED';
      const receipt: BridgeReceipt = {
        eventId: event.eventId,
        status: 'REJECTED',
        reason: this.lastError
      };
      this.cache.set(event.eventId, receipt);
      return receipt;
    } finally {
      this.pendingCount = Math.max(0, this.pendingCount - 1);
    }
  }

  public async ingest(verifiedEvent: VerifiedPeerEvent): Promise<BridgeReceipt> {
    const event = verifiedEvent.event;
    this.lastCallbackAt = Date.now();
    this.health = 'HEALTHY';

    // Bridge ingest NEVER executes direct native orders
    const receipt: BridgeReceipt = {
      eventId: event.eventId,
      status: 'REMOTE_COMPLETED',
      reason: 'Callback ingested and verified.'
    };
    this.cache.set(event.eventId, receipt);
    return receipt;
  }

  public status(): GrokIntegrationStatus {
    return {
      desiredMode: this.options.webhookUrl ? 'enabled' : 'disabled',
      observedHealth: this.health,
      lastAcceptedAt: this.lastAcceptedAt,
      lastCallbackAt: this.lastCallbackAt,
      lastAcknowledgedConfigVersion: this.lastAckVersion,
      pendingEvents: this.pendingCount,
      lastError: this.lastError
    };
  }
}

export interface RoleRouteContext {
  cycleId: string;
  role: string;
  currentAttempt: number;
}

export class GrokRoleRouter {
  private acknowledgedVersion = 0;
  private lastError: string | null = null;

  public evaluateAttempt(
    context: RoleRouteContext,
    attemptData: { cycleId: string; role: string; attempt: number }
  ): { accepted: boolean; reason?: string } {
    if (context.cycleId !== attemptData.cycleId) {
      return { accepted: false, reason: 'Cycle mismatch' };
    }
    if (context.role !== attemptData.role) {
      return { accepted: false, reason: 'Role mismatch' };
    }
    if (attemptData.attempt < context.currentAttempt) {
      return {
        accepted: false,
        reason: `Stale attempt: received attempt ${attemptData.attempt} while current is ${context.currentAttempt}`
      };
    }
    return { accepted: true };
  }

  public updateAcknowledgedVersion(version: number): void {
    if (version > this.acknowledgedVersion) {
      this.acknowledgedVersion = version;
    }
  }

  public getAcknowledgedVersion(): number {
    return this.acknowledgedVersion;
  }

  public recordRemoteError(error: string): void {
    this.lastError = safe(error);
  }

  public getLastError(): string | null {
    return this.lastError;
  }
}
