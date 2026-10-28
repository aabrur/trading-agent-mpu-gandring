import { describe, it, expect } from 'vitest';
import { OpinionSchema, LeadSchema, extractJson } from '../server/schemas.js';

describe('Schema Null Normalization', () => {
  it('OpinionSchema accepts null for optional entry and exit fields', () => {
    const raw = {
      stance: 'NEUTRAL',
      confidence: 0.5,
      argument: 'Tape is flat.',
      entryScenarioId: null,
      entryZone: null,
      invalidationLevel: null,
      exitSignal: null,
    };
    const res = OpinionSchema.safeParse(raw);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.entryScenarioId).toBeUndefined();
      expect(res.data.entryZone).toBeUndefined();
      expect(res.data.invalidationLevel).toBeUndefined();
      expect(res.data.exitSignal).toBeUndefined();
    }
  });

  it('LeadSchema accepts null for optional scenario, zone, trigger, and exit fields', () => {
    const raw = {
      action: 'HOLD',
      confidence: 0.6,
      reason: 'No clear directional structure.',
      entryScenarioId: null,
      entryZone: null,
      invalidationLevel: null,
      closeTrigger: null,
      exitSignal: null,
    };
    const res = LeadSchema.safeParse(raw);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.entryScenarioId).toBeUndefined();
      expect(res.data.entryZone).toBeUndefined();
      expect(res.data.closeTrigger).toBeUndefined();
      expect(res.data.exitSignal).toBeUndefined();
    }
  });

  it('extractJson parses markdown wrapped JSON containing nulls', () => {
    const raw = '```json\n{"action":"HOLD","confidence":0.7,"reason":"Wait for breakout.","entryScenarioId":null,"closeTrigger":null}\n```';
    const extracted = extractJson(raw, 'lead');
    const res = LeadSchema.safeParse(extracted);
    expect(res.success).toBe(true);
  });
});
