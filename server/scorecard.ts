import type { AgentId, Stance } from './types.js';
import { ROLES } from './agents/roles.js';

// Desk Lead supervision: a small scorecard per employee, shown in every report.
// Analysts are scored on closed trades: did the stance they held at entry match the result?

export interface RoleScore { role: AgentId; name: string; calls: number; right: number; wrong: number; note: string }
export interface OpenCall { side: 'LONG' | 'SHORT'; stances: Partial<Record<AgentId, Stance | null>>; riskDecision: string }

export class Scorecard {
  private s: Record<AgentId, { calls: number; right: number; wrong: number }> = {
    lead: { calls: 0, right: 0, wrong: 0 }, market: { calls: 0, right: 0, wrong: 0 }, research: { calls: 0, right: 0, wrong: 0 },
    strategist: { calls: 0, right: 0, wrong: 0 }, risk: { calls: 0, right: 0, wrong: 0 }, execution: { calls: 0, right: 0, wrong: 0 }
  };
  risk = { approve: 0, reduce: 0, reject: 0 };
  exec = { fills: 0, noFills: 0 };
  lead = { verdicts: 0, journaled: 0, wins: 0, losses: 0 };
  private open = new Map<string, OpenCall>();

  verdict() { this.lead.verdicts++; this.s.lead.calls++; }
  riskDecision(d: string) { const k = d.toLowerCase() as 'approve' | 'reduce' | 'reject'; if (k in this.risk) this.risk[k]++; this.s.risk.calls++; }
  fill(ok: boolean) { if (ok) this.exec.fills++; else this.exec.noFills++; this.s.execution.calls++; if (ok) this.s.execution.right++; }
  opened(symbol: string, call: OpenCall) { this.open.set(symbol, call); }

  /** Scores everyone who had a view when the position opened. Returns the roles that were wrong. */
  closed(symbol: string, side: 'LONG' | 'SHORT', pnl: number): AgentId[] {
    const call = this.open.get(symbol); this.open.delete(symbol);
    const win = pnl > 0;
    if (win) { this.lead.wins++; this.s.lead.right++; } else { this.lead.losses++; this.s.lead.wrong++; }
    if (call) { if (win) this.s.risk.right++; else if (call.riskDecision === 'APPROVE') this.s.risk.wrong++; }
    const wrong: AgentId[] = [];
    for (const [role, st] of Object.entries(call?.stances ?? {}) as [AgentId, Stance | null][]) {
      if (!st || st === 'NEUTRAL') continue;
      this.s[role].calls++;
      const backed = st === side;
      if (backed === win) this.s[role].right++; else { this.s[role].wrong++; wrong.push(role); }
    }
    return wrong;
  }
  journaled() { this.lead.journaled++; }

  rows(): RoleScore[] {
    const note: Record<AgentId, string> = {
      lead: `${this.lead.verdicts} verdicts, ${this.lead.wins} wins, ${this.lead.losses} losses, ${this.lead.journaled} journal entries`,
      market: 'stance at entry vs result', research: 'vote at entry vs result', strategist: 'rule side at entry vs result',
      risk: `${this.risk.approve} approve, ${this.risk.reduce} reduce, ${this.risk.reject} reject`,
      execution: `${this.exec.fills} fills, ${this.exec.noFills} no-fills`
    };
    return (Object.keys(this.s) as AgentId[]).map((role) => ({ role, name: ROLES[role].name, ...this.s[role], note: note[role] }));
  }
}

export function scoreLine(r: RoleScore): string {
  const n = r.right + r.wrong;
  return `${r.name}: ${n ? `${r.right}/${n} right (${Math.round((r.right / n) * 100)}%)` : 'no scored calls yet'}. ${r.note}`;
}
