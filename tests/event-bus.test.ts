import { describe, expect, it } from 'vitest';
import { TypedEventBus, type MpuEvent } from '../server/events/event-bus.js';

describe('Typed Event Bus Architecture', () => {
  it('publishes immutable events with strictly monotonic sequence numbers', () => {
    const bus = new TypedEventBus();

    const ev1 = bus.publish('BAR', { symbol: 'BTCUSDT', close: 100 });
    const ev2 = bus.publish('DEBATE', { symbol: 'BTCUSDT', verdict: 'OPEN_LONG' });
    const ev3 = bus.publish('ORDER', { symbol: 'BTCUSDT', side: 'LONG', qty: 1 });

    expect(ev1.seq).toBe(1);
    expect(ev2.seq).toBe(2);
    expect(ev3.seq).toBe(3);
    expect(Object.isFrozen(ev1)).toBe(true);
    expect(Object.isFrozen(ev1.payload)).toBe(true);
  });

  it('delivers events to typed subscribers and unsubscribes cleanly', () => {
    const bus = new TypedEventBus();
    const orderEvents: MpuEvent[] = [];

    const unsubscribe = bus.subscribe('ORDER', (ev) => {
      orderEvents.push(ev);
    });

    bus.publish('BAR', { close: 100 });
    bus.publish('ORDER', { orderId: 'ord-1', symbol: 'ETHUSDT' });
    bus.publish('ORDER', { orderId: 'ord-2', symbol: 'SOLUSDT' });

    expect(orderEvents.length).toBe(2);
    expect(orderEvents[0].payload.orderId).toBe('ord-1');
    expect(orderEvents[1].payload.orderId).toBe('ord-2');

    unsubscribe();
    bus.publish('ORDER', { orderId: 'ord-3', symbol: 'ADAUSDT' });
    expect(orderEvents.length).toBe(2); // No new events received after unsubscribe
  });

  it('replays historical events accurately by sequence range', () => {
    const bus = new TypedEventBus();
    for (let i = 1; i <= 10; i++) {
      bus.publish('SIGNAL', { step: i });
    }

    const replayed = bus.replay(4, 7);
    expect(replayed.length).toBe(4);
    expect(replayed[0].seq).toBe(4);
    expect(replayed[3].seq).toBe(7);
  });
});
