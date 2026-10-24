// Benchmark runner: npm run bench:models -- [--stack current|performance|cost|all] [--dry-run] [--budget-usd <n>] [--fixtures <path>] [--json]
import { readFileSync, existsSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { runAgent } from '../server/agents/run.js';
import { makeCaller, type ModelCaller } from '../server/providers/index.js';
import { MODEL_PRESETS } from '../server/setup/models.js';
import { AGENT_IDS } from '../server/config.js';
import type { AgentId } from '../server/types.js';
import type { TaskKind } from '../server/schemas.js';

export interface BenchmarkMetrics {
  stack: string;
  totalCalls: number;
  validJsonCount: number;
  schemaCompliantCount: number;
  retriesCount: number;
  timeoutsCount: number;
  providerErrorsCount: number;
  resolvedModels: Record<string, string>;
  medianLatencyMs: number;
  p95LatencyMs: number;
  directionalAgreementPct: number;
  spentUsd: number;
  budgetExceeded: boolean;
  tradingEvaluationNote: string;
}

// Conservative model pricing per 1M tokens (USD)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'anthropic/claude-opus-5.5': { input: 15.0, output: 75.0 },
  'anthropic/claude-sonnet-5.5': { input: 3.0, output: 15.0 },
  'anthropic/claude-haiku-5.5': { input: 0.8, output: 4.0 },
  'openai/gpt-6.1-sol': { input: 3.0, output: 15.0 },
  'openai/gpt-6-luna': { input: 2.5, output: 10.0 },
  'openai/gpt-6-astra': { input: 5.0, output: 20.0 },
  'google/gemini-4-argon': { input: 1.5, output: 6.0 },
  'deepseek/deepseek-v4.1-flash': { input: 0.15, output: 0.6 },
  'deepseek/deepseek-v4.1-flash-1017': { input: 0.15, output: 0.6 },
  'z-ai/glm-5.3': { input: 1.0, output: 2.0 },
  'z-ai/glm-5.3-flash': { input: 0.2, output: 0.8 },
  'moonshotai/kimi-k3': { input: 1.5, output: 5.0 },
  'xiaomi/mimo-v2.6-flash': { input: 0.2, output: 0.8 },
  'minimax/minimax-m3.1-flash': { input: 0.2, output: 0.8 },
  'stepfun/step-5-preview': { input: 1.0, output: 4.0 }
};

export function estimateCallCost(provider: string, model: string, inputTokens = 1500, outputTokens = 500): number {
  if (provider === 'mock' || provider === 'local') return 0;
  const pricing = MODEL_PRICING[model] ?? { input: 3.0, output: 12.0 };
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return Number((inputCost + outputCost).toFixed(6));
}

export function parseArgs(argv: string[]) {
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true') : undefined;
  };
  return {
    stack: flag('stack') ?? 'all',
    budgetUsd: flag('budget-usd') ? Number(flag('budget-usd')) : 0,
    dryRun: flag('dry-run') === 'true' || flag('dry') === 'true',
    json: flag('json') === 'true',
    fixtures: flag('fixtures')
  };
}

export async function runStackBenchmark(
  stackName: string,
  dryRun: boolean,
  budgetUsd: number,
  customCaller?: ModelCaller,
  fixturesPath?: string
): Promise<BenchmarkMetrics> {
  if (!dryRun && (!budgetUsd || budgetUsd <= 0)) {
    throw new Error('Running live model benchmarks requires an explicit --budget-usd > 0 to prevent unexpected API costs.');
  }

  const baseConfig = loadConfig({ TRADING_MODE: 'PAPER' });
  const cfg = structuredClone(baseConfig);

  if (stackName === 'performance') {
    const preset = MODEL_PRESETS.find(p => p.id === 'performance_first')!;
    cfg.defaultProvider = preset.defaultProvider;
    cfg.defaultModels.openrouter = preset.defaultModel;
    for (const a of AGENT_IDS) {
      cfg.agents[a] = { provider: preset.agents[a].provider, model: preset.agents[a].model, fellBackToMock: false };
    }
  } else if (stackName === 'cost') {
    const preset = MODEL_PRESETS.find(p => p.id === 'cost_optimized')!;
    cfg.defaultProvider = preset.defaultProvider;
    cfg.defaultModels.openrouter = preset.defaultModel;
    for (const a of AGENT_IDS) {
      cfg.agents[a] = { provider: preset.agents[a].provider, model: preset.agents[a].model, fellBackToMock: false };
    }
  }

  // Load custom market fixture if provided
  let fixtureData: Record<string, unknown> = { symbol: 'BTCUSDT' };
  if (fixturesPath && existsSync(fixturesPath)) {
    try {
      const parsed = JSON.parse(readFileSync(fixturesPath, 'utf8'));
      fixtureData = { symbol: 'BTCUSDT', fixture: Array.isArray(parsed) ? parsed.slice(0, 5) : parsed };
    } catch {
      // Keep default fixtureData on parse failure
    }
  }

  const caller = customCaller ?? (dryRun
    ? async (req) => {
        if (req.task === 'opinion') return JSON.stringify({ stance: 'LONG', confidence: 0.85, argument: 'Clean breakout observed.' });
        if (req.task === 'research') return JSON.stringify({ vote: 'LONG', confidence: 0.8, argument: 'Positive catalyst flow.', sources: ['exchange'] });
        if (req.task === 'rebuttal') return JSON.stringify({ stance: 'LONG', confidence: 0.85, target: 'risk', rebuttal: 'Momentum is established.' });
        if (req.task === 'lead') return JSON.stringify({ action: 'OPEN_LONG', confidence: 0.85, reason: 'Decisive technical breakout.' });
        if (req.task === 'risk') return JSON.stringify({ decision: 'APPROVE', sizeFactor: 1, leverage: 5, stopPct: 2, reason: 'Risk acceptable.' });
        if (req.task === 'review') return JSON.stringify({ lesson: 'Disciplined trade execution.', grade: 'A' });
        return JSON.stringify({ reply: 'Ready for market review.' });
      }
    : makeCaller(cfg));

  // Benchmark all six desk agents: market, research, strategist, risk, execution, lead
  const tasks: Array<{ agent: AgentId; task: TaskKind; input: any }> = [
    { agent: 'market', task: 'opinion', input: { instruction: 'Assess technical trend for BTCUSDT.', data: fixtureData, context: {} } },
    { agent: 'research', task: 'research', input: { instruction: 'Analyze news and order flow.', data: fixtureData, context: {} } },
    { agent: 'strategist', task: 'opinion', input: { instruction: 'Evaluate tactical scenarios.', data: fixtureData, context: {} } },
    { agent: 'risk', task: 'risk', input: { instruction: 'Review proposal.', data: fixtureData, context: {} } },
    { agent: 'execution', task: 'opinion', input: { instruction: 'Assess liquidity and execution timing.', data: fixtureData, context: {} } },
    { agent: 'lead', task: 'lead', input: { instruction: 'Issue final action.', data: fixtureData, context: {} } }
  ];

  let validJson = 0;
  let schemaCompliant = 0;
  let retries = 0;
  let timeouts = 0;
  let errors = 0;
  let spentUsd = 0;
  let budgetExceeded = false;
  const latencies: number[] = [];
  const directions: string[] = [];

  for (const item of tasks) {
    // Hard spending cap check before dispatching external request
    if (!dryRun) {
      const estimatedCost = estimateCallCost(cfg.agents[item.agent].provider, cfg.agents[item.agent].model);
      if (spentUsd + estimatedCost > budgetUsd) {
        budgetExceeded = true;
        break;
      }
      spentUsd = Number((spentUsd + estimatedCost).toFixed(6));
    }

    const started = Date.now();
    try {
      const res = await runAgent(cfg, caller, item.agent, item.task, item.input);
      latencies.push(Date.now() - started);
      if (res.attempts > 1) retries += (res.attempts - 1);
      if (!res.fallback) {
        validJson++;
        schemaCompliant++;
      } else {
        if (res.failureKind === 'timeout') timeouts++;
        else if (res.failureKind === 'provider') errors++;
      }
      if ('stance' in res.data) directions.push(String(res.data.stance));
      if ('action' in res.data) directions.push(String(res.data.action));
      if ('vote' in res.data) directions.push(String(res.data.vote));
    } catch {
      errors++;
      latencies.push(Date.now() - started);
    }
  }

  latencies.sort((a, b) => a - b);
  const medianLatencyMs = latencies.length ? latencies[Math.floor(latencies.length / 2)] : 0;
  const p95LatencyMs = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : 0;

  // True directional consensus: majority agreement among directional outputs
  let longCount = 0;
  let shortCount = 0;
  let neutralCount = 0;
  for (const d of directions) {
    if (/LONG/i.test(d)) longCount++;
    else if (/SHORT/i.test(d)) shortCount++;
    else neutralCount++;
  }
  const maxConsensus = Math.max(longCount, shortCount, neutralCount);
  const directionalAgreementPct = directions.length ? Math.round((maxConsensus / directions.length) * 100) : 100;

  const resolvedModels = Object.fromEntries(AGENT_IDS.map(a => [a, `${cfg.agents[a].provider}:${cfg.agents[a].model}`]));

  return {
    stack: stackName,
    totalCalls: tasks.length,
    validJsonCount: validJson,
    schemaCompliantCount: schemaCompliant,
    retriesCount: retries,
    timeoutsCount: timeouts,
    providerErrorsCount: errors,
    resolvedModels,
    medianLatencyMs,
    p95LatencyMs,
    directionalAgreementPct,
    spentUsd,
    budgetExceeded,
    tradingEvaluationNote: 'Trading PnL, drawdown, and walk-forward metrics require historical walk-forward trade execution labeled fixtures; not evaluated in synthetic dry run.'
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stacks = args.stack === 'all' ? ['current', 'performance', 'cost'] : [args.stack];

  if (!args.json) {
    console.log(`\nMpu Gandring Model Benchmark Runner (dryRun=${args.dryRun}, budget=${args.budgetUsd} USD)`);
    console.log('--------------------------------------------------------------------------------');
  }

  const results: BenchmarkMetrics[] = [];
  for (const stack of stacks) {
    try {
      const res = await runStackBenchmark(stack, args.dryRun, args.budgetUsd, undefined, args.fixtures);
      results.push(res);
      if (!args.json) {
        console.log(`Stack [${res.stack}]: validJson=${res.validJsonCount}/${res.totalCalls}, schemaCompliant=${res.schemaCompliantCount}/${res.totalCalls}, consensus=${res.directionalAgreementPct}%, retries=${res.retriesCount}, cost=$${res.spentUsd}, budgetHalted=${res.budgetExceeded}, latency: median=${res.medianLatencyMs}ms, p95=${res.p95LatencyMs}ms`);
      }
    } catch (e) {
      if (!args.json) console.error(`Stack [${stack}] failed: ${(e as Error).message}`);
      else results.push({ stack, totalCalls: 0, validJsonCount: 0, schemaCompliantCount: 0, retriesCount: 0, timeoutsCount: 0, providerErrorsCount: 1, resolvedModels: {}, medianLatencyMs: 0, p95LatencyMs: 0, directionalAgreementPct: 0, spentUsd: 0, budgetExceeded: false, tradingEvaluationNote: (e as Error).message });
    }
  }

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  }
}

if (process.argv[1] && /bench-models\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
