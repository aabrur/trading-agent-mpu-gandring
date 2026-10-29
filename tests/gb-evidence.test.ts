import { describe, expect, it, vi } from 'vitest';

vi.mock('../server/market/index.js', async (original) => {
  const actual = await original<typeof import('../server/market/index.js')>();
  return { ...actual, getCandles: vi.fn(async () => ({
    tf: '15m', source: 'aster', example: false,
    candles: [{ t: 1793232000000, o: 1, h: 2, l: 1, c: 2, v: 0.00000004123456789 }]
  })) };
});

const { gb } = await import('../cli/gb.js');

describe('Grok Bot evidence transport', () => {
  it('preserves native volume precision and the already closed final bar', async () => {
    const result = await gb(['candles', 'NEARUSDT', '15m', '--source', 'aster'], { env: {} });
    const data = result.data as { candles: Array<{ t: number; v: number }> };
    expect(data.candles).toHaveLength(1);
    expect(data.candles[0].v).toBe(0.00000004123456789);
  });
});
