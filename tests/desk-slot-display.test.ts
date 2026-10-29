import { describe, expect, it } from 'vitest';
import { deskSlotOccupancy } from '../web/src/components/DeskOps.tsx';

describe('LIVE slot line uses backend occupancy', () => {
  it('counts a pending entry when the book has no position, and keeps PAPER on position rows', () => {
    expect(deskSlotOccupancy({
      mode: 'LIVE', positionCount: 0, configuredN: 3,
      accountState: { occupiedSlots: 1, pendingOpenCount: 1, maxPositions: 3, status: 'confirmed' }
    })).toEqual({ used: 1, n: 3, pending: 1, statusNote: '' });
    expect(deskSlotOccupancy({
      mode: 'PAPER', positionCount: 1, configuredN: 4,
      accountState: { occupiedSlots: 0, pendingOpenCount: 1, maxPositions: 4, status: 'current' }
    })).toEqual({ used: 1, n: 4, pending: 0, statusNote: '' });
    expect(deskSlotOccupancy({
      mode: 'LIVE', positionCount: 0, configuredN: 3,
      accountState: { occupiedSlots: 3, pendingOpenCount: 0, maxPositions: 3, status: 'unverified' }
    }).statusNote).toBe('unverified');
  });
});
