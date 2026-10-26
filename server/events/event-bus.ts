/**
 * Typed Event Bus Architecture for Mpu Gandring.
 *
 * Clean-room TypeScript implementation inspired by nautechsystems/nautilus_trader:
 * - Deterministic, immutable event dispatching.
 * - Monotonically increasing sequence clock for auditability and event replay.
 * - Strongly typed domain events (BAR, DEBATE, SIGNAL, ORDER, POSITION, RISK, ALERT).
 * - In-memory ring buffer for historical replay and financial reconciliation.
 */

export type MpuEventType =
  | 'BAR'
  | 'DEBATE'
  | 'SIGNAL'
  | 'ORDER'
  | 'POSITION'
  | 'RISK'
  | 'ALERT';

export interface MpuEvent<T = Record<string, unknown>> {
  id: string;
  seq: number;
  timestamp: number;
  type: MpuEventType;
  payload: T;
}

export type EventHandler<T = any> = (event: MpuEvent<T>) => void | Promise<void>;

export class TypedEventBus {
  private seqCounter = 0;
  private history: MpuEvent<any>[] = [];
  private maxHistorySize: number;
  private subscribers = new Map<MpuEventType, Set<EventHandler>>();
  private allSubscribers = new Set<EventHandler>();

  constructor(maxHistorySize: number = 10_000) {
    this.maxHistorySize = maxHistorySize;
  }

  /**
   * Publishes an immutable event, records it to the historical sequence buffer,
   * and notifies typed subscribers synchronously/asynchronously.
   */
  public publish<T = any>(type: MpuEventType, payload: T): MpuEvent<T> {
    this.seqCounter++;
    const event: MpuEvent<T> = Object.freeze({
      id: `evt-${this.seqCounter}-${Date.now()}`,
      seq: this.seqCounter,
      timestamp: Date.now(),
      type,
      payload: Object.freeze(payload),
    });

    this.history.push(event);
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }

    // Dispatch to specific subscribers
    const handlers = this.subscribers.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (err) {
          console.error(`[EventBus] Handler error for ${type}:`, err);
        }
      }
    }

    // Dispatch to global subscribers
    for (const handler of this.allSubscribers) {
      try {
        handler(event);
      } catch (err) {
        console.error(`[EventBus] Global handler error for ${type}:`, err);
      }
    }

    return event;
  }

  /**
   * Subscribes a handler to a specific event type.
   * Returns an unsubscribe function.
   */
  public subscribe<T = any>(type: MpuEventType, handler: EventHandler<T>): () => void {
    if (!this.subscribers.has(type)) {
      this.subscribers.set(type, new Set());
    }
    const handlers = this.subscribers.get(type)!;
    handlers.add(handler as EventHandler);

    return () => {
      handlers.delete(handler as EventHandler);
      if (handlers.size === 0) {
        this.subscribers.delete(type);
      }
    };
  }

  /**
   * Subscribes to all events across all types.
   */
  public subscribeAll(handler: EventHandler): () => void {
    this.allSubscribers.add(handler);
    return () => {
      this.allSubscribers.delete(handler);
    };
  }

  /**
   * Replays historical events between sequence numbers.
   */
  public replay(fromSeq: number = 1, toSeq: number = Number.MAX_SAFE_INTEGER, handler?: EventHandler): MpuEvent[] {
    const matched = this.history.filter(e => e.seq >= fromSeq && e.seq <= toSeq);
    if (handler) {
      for (const event of matched) {
        handler(event);
      }
    }
    return matched;
  }

  /**
   * Returns immutable slice of historical events.
   */
  public getHistory(type?: MpuEventType): ReadonlyArray<MpuEvent> {
    if (type) {
      return this.history.filter(e => e.type === type);
    }
    return [...this.history];
  }

  /**
   * Clears event history and resets sequence counter.
   */
  public clear(): void {
    this.history = [];
    this.seqCounter = 0;
  }

  /**
   * Returns current sequence clock value.
   */
  public currentSeq(): number {
    return this.seqCounter;
  }
}
