import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { setEnv } from '../../cli/envfile.js';

export const PreferencesBody = z.object({
  appMode: z.enum(['local', 'grokbot']),
  balance: z.number().finite().nonnegative(),
  safetyNet: z.number().finite().nonnegative(),
  n: z.number().int().min(1).max(4),
  dailyLoss: z.number().finite().min(0.1).max(100),
  auto: z.boolean(),
  debateInterval: z.number().int().min(1).max(1440),
  reportInterval: z.number().int().min(1).max(1440),
  maxHoldHours: z.number().int().min(0).max(720).optional().default(0)
}).strict().refine((v) => v.safetyNet <= v.balance, { message: 'Safety net must not exceed paper balance.' });

export function preferencesInfo(env: NodeJS.ProcessEnv) {
  const cfg = loadConfig({ ...env, TRADING_MODE: 'PAPER' });
  return {
    appMode: cfg.appMode,
    balance: cfg.paper.balance,
    safetyNet: cfg.paper.safetyNet,
    n: cfg.paper.n,
    dailyLoss: cfg.risk.dailyLossLimitPct,
    auto: cfg.auto.on,
    debateInterval: cfg.auto.intervalMin,
    reportInterval: cfg.reports.intervalMin,
    maxHoldHours: cfg.auto.maxHoldHours
  };
}

export function savePreferences(file: string, env: NodeJS.ProcessEnv, input: unknown) {
  const p = PreferencesBody.safeParse(input);
  if (!p.success) return { ok: false, detail: 'Check the amounts, safety net, N (1-4), loss cap (0.1-100%), intervals (1-1440 minutes), and max hold hours (0-720 hours).' };
  const v = p.data;
  const updates: Record<string, string> = {
    APP_MODE: v.appMode,
    PAPER_BALANCE: String(v.balance),
    SAFETY_NET: String(v.safetyNet),
    OPEN_ORDERS_N: String(v.n),
    DAILY_LOSS_LIMIT_PCT: String(v.dailyLoss),
    AUTO_TRADING: v.auto ? 'on' : 'off',
    DEBATE_INTERVAL_MIN: String(v.debateInterval),
    REPORT_INTERVAL_MIN: String(v.reportInterval),
    MAX_HOLD_HOURS: String(v.maxHoldHours ?? 0)
  };
  if (v.appMode === 'grokbot' && !env.AGENT_EVENT_SECRET) updates.AGENT_EVENT_SECRET = randomBytes(32).toString('base64url');
  setEnv(file, updates);
  return { ok: true, detail: `Settings saved. Apply and restart to use them.${v.appMode === 'grokbot' ? ' AGENT_EVENT_SECRET is set locally; use your bot platform’s secret store for its copy.' : ''}` };
}
