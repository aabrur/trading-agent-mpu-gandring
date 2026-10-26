import { describe, expect, it } from 'vitest';
import { ROLES } from '../server/agents/roles.js';
import { AGENT_IDS } from '../server/config.js';

describe('Six Agent Roster Invariant (Strict System Preservation)', () => {
  it('contains exactly six canonical agent identities', () => {
    expect(AGENT_IDS.length).toBe(6);
    expect([...AGENT_IDS]).toEqual(['lead', 'market', 'research', 'strategist', 'risk', 'execution']);
  });

  it('preserves exact role titles and office desk coordinates for each agent', () => {
    expect(ROLES.market).toEqual({
      id: 'market',
      name: 'Market Analyst',
      title: 'Tape, Momentum & Orderflow Hunter',
      color: '#38bdf8',
      desk: { x: 15, y: 48 },
    });

    expect(ROLES.research).toEqual({
      id: 'research',
      name: 'Research Analyst',
      title: 'Whale Flow, Macro & Catalyst Strategist',
      color: '#a78bfa',
      desk: { x: 84, y: 43 },
    });

    expect(ROLES.strategist).toEqual({
      id: 'strategist',
      name: 'Strategist',
      title: 'Quantitative Structure & Volatility Architect',
      color: '#f59e0b',
      desk: { x: 17, y: 78 },
    });

    expect(ROLES.lead).toEqual({
      id: 'lead',
      name: 'Desk Lead',
      title: 'Head of Prop Trading & Conviction Synthesis',
      color: '#10b981',
      desk: { x: 50, y: 39 },
    });

    expect(ROLES.risk).toEqual({
      id: 'risk',
      name: 'Risk Manager',
      title: 'Asymmetric Sizing & Stop-Width Optimizer',
      color: '#f43f5e',
      desk: { x: 83, y: 68 },
    });

    expect(ROLES.execution).toEqual({
      id: 'execution',
      name: 'Execution Trader',
      title: 'Low-Latency Order & Protection Specialist',
      color: '#06b6d4',
      desk: { x: 45, y: 91 },
    });
  });
});
