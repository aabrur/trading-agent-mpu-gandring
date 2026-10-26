import { describe, expect, it } from 'vitest';
import { ARCHETYPES, getArchetype, formatArchetypePrompt, type ArchetypeId } from '../server/agents/archetypes.js';
import { ROLES } from '../server/agents/roles.js';

describe('Investor Archetype Personas', () => {
  it('defines all four legendary investor archetypes', () => {
    const ids: ArchetypeId[] = ['buffett', 'soros', 'simons', 'lynch'];
    for (const id of ids) {
      const arch = ARCHETYPES[id];
      expect(arch).toBeDefined();
      expect(arch.name.length).toBeGreaterThan(0);
      expect(arch.philosophy.length).toBeGreaterThan(20);
      expect(arch.keyMetrics.length).toBeGreaterThanOrEqual(3);
      expect(arch.rhetoricalAttacks.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('retrieves archetypes case-insensitively with getArchetype', () => {
    expect(getArchetype('BUFFETT')?.name).toBe('Warren Buffett');
    expect(getArchetype('Soros')?.name).toBe('George Soros');
    expect(getArchetype('simons')?.name).toBe('Jim Simons');
    expect(getArchetype('LYNCH')?.name).toBe('Peter Lynch');
    expect(getArchetype('unknown')).toBeUndefined();
  });

  it('formats archetype prompt for injection into agent reasoning', () => {
    const prompt = formatArchetypePrompt('simons');
    expect(prompt).toContain('Jim Simons');
    expect(prompt).toContain('Alpha158 composite score');
    expect(prompt).toContain('Evaluation Focus:');
  });

  it('preserves the six canonical agents without altering ROLES definitions', () => {
    const roleKeys = Object.keys(ROLES);
    expect(roleKeys.length).toBe(6);
    expect(roleKeys).toEqual(['market', 'research', 'strategist', 'lead', 'risk', 'execution']);
  });
});
