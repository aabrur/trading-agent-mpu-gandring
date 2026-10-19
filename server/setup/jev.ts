import { z } from 'zod';
import { setEnv } from '../../cli/envfile.js';
import { loadJevSettings, publicJevStatus, type JevMetrics } from '../decision/jev.js';
import { JEV_MODEL } from '../decision/schemas.js';

export const JevSetupBody = z.object({
  enabled: z.boolean(),
  mode: z.enum(['off', 'shadow', 'assist']),
  key: z.string().max(400).optional()
}).strict();

export function jevSetupInfo(env: NodeJS.ProcessEnv, tradingMode: string, metrics: JevMetrics, lastDecision: Record<string, unknown> | null = null) {
  const settings = loadJevSettings(env, tradingMode);
  return publicJevStatus(settings, metrics, {
    lastDecision,
    tradingMode,
    liveAssist: settings.effectiveMode === 'assist' && tradingMode === 'LIVE',
    liveAssistBlocked: settings.mode === 'assist' && tradingMode === 'LIVE' && !settings.allowLive,
    modelLocked: JEV_MODEL
  });
}

export function saveJevSetup(envFile: string, input: z.infer<typeof JevSetupBody>) {
  if (input.key && !/^\S{1,400}$/.test(input.key)) throw new Error('Invalid Jev API key input.');
  const updates: Record<string, string | null> = {
    JEV_ENABLED: input.enabled ? 'true' : 'false',
    JEV_MODE: input.mode === 'off' ? 'shadow' : input.mode,
    JEV_PROVIDER: 'openrouter',
    JEV_MODEL
  };
  if (input.mode === 'off') updates.JEV_ENABLED = 'false';
  if (input.key) updates.JEV_OPENROUTER_API_KEY = input.key;
  setEnv(envFile, updates);
  return updates;
}
