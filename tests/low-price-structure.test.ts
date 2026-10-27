import { describe, expect, it } from 'vitest';
import { detectHarmonicPatterns } from '../server/market/harmonics.js';
import { analyzeSMC } from '../server/market/smc.js';

const scale = 9.5e-8;

describe('low-price structural precision', () => {
  it('keeps PEPE-scale SMC range levels off zero', () => {
    const candles = Array.from({ length: 12 }, (_, i) => {
      const mid = 0.0000095 + i * 1e-8;
      return { t: i, o: mid, h: mid + 2e-9, l: mid - 2e-9, c: mid + 1e-9, v: 10 };
    });
    const smc = analyzeSMC(candles);
    expect(smc).not.toBeNull();
    expect(smc!.premiumDiscountZone.rangeHigh).toBeGreaterThan(0);
    expect(smc!.premiumDiscountZone.rangeLow).toBeGreaterThan(0);
    expect(smc!.premiumDiscountZone.equilibrium).toBeGreaterThan(0);
    expect(smc!.premiumDiscountZone.rangeLow).toBeLessThan(0.00002);
  });

  it('keeps a scaled Gartley PRZ off zero', () => {
    const bars = [];
    let t = 0;
    const px = (n: number) => Number((n * scale).toPrecision(12));
    for (let i = 0; i < 3; i++) bars.push({ t: t++, o: px(105), h: px(106), l: px(104), c: px(105), v: 10 });
    bars.push({ t: t++, o: px(104), h: px(105), l: px(100), c: px(102), v: 10 });
    for (let i = 0; i < 3; i++) bars.push({ t: t++, o: px(110 + i * 20), h: px(115 + i * 20), l: px(108 + i * 20), c: px(114 + i * 20), v: 10 });
    bars.push({ t: t++, o: px(195), h: px(200), l: px(194), c: px(196), v: 10 });
    for (let i = 0; i < 3; i++) bars.push({ t: t++, o: px(180 - i * 10), h: px(182 - i * 10), l: px(160 - i * 10), c: px(165 - i * 10), v: 10 });
    bars.push({ t: t++, o: px(140), h: px(142), l: px(138), c: px(140), v: 10 });
    for (let i = 0; i < 3; i++) bars.push({ t: t++, o: px(145 + i * 5), h: px(152 + i * 5), l: px(144 + i * 5), c: px(150 + i * 5), v: 10 });
    bars.push({ t: t++, o: px(163), h: px(165), l: px(161), c: px(163), v: 10 });
    for (let i = 0; i < 3; i++) bars.push({ t: t++, o: px(150 - i * 8), h: px(152 - i * 8), l: px(135 - i * 8), c: px(140 - i * 8), v: 10 });
    bars.push({ t: t++, o: px(125), h: px(127), l: px(121), c: px(124), v: 10 });
    for (let i = 0; i < 3; i++) bars.push({ t: t++, o: px(126), h: px(128), l: px(125), c: px(127), v: 10 });

    const patterns = detectHarmonicPatterns(bars);
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    const prz = patterns[0].prz;
    for (const level of [prz.entryMin, prz.entryMax, prz.stopLoss, prz.target1, prz.target2]) {
      expect(level).not.toBe(0);
      expect(Math.abs(level)).toBeLessThan(0.0001);
    }
  });
});
