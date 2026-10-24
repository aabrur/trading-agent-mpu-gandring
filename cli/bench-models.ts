// Benchmark runner: npm run bench:models -- [--stack current|performance|cost|all] [--dry-run] [--budget-usd <n>] [--json]
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
  tradingEvaluationNote: string;
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
  customCaller?: ModelCaller
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

  const tasks: Array<{ agent: AgentId; task: TaskKind; input: any }> = [
    { agent: 'market', task: 'opinion', input: { instruction: 'Assess technical trend for BTCUSDT.', data: { symbol: 'BTCUSDT' }, context: {} } },
    { agent: 'research', task: 'research', input: { instruction: 'Analyze news and order flow.', data: { symbol: 'BTCUSDT' }, context: {} } },
    { agent: 'strategist', task: 'opinion', input: { instruction: 'Evaluate tactical scenarios.', data: { symbol: 'BTCUSDT' }, context: {} } },
    { agent: 'risk', task: 'risk', input: { instruction: 'Review proposal.', data: { symbol: 'BTCUSDT' }, context: {} } },
    { agent: 'lead', task: 'lead', input: { instruction: 'Issue final action.', data: { symbol: 'BTCUSDT' }, context: {} } }
  ];

  let validJson = 0;
  let schemaCompliant = 0;
  let retries = 0;
  let timeouts = 0;
  let errors = 0;
  const latencies: number[] = [];
  const directions: string[] = [];

  for (const item of tasks) {
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

  const longs = directions.filter(d => /LONG/i.test(d)).length;
  const directionalAgreementPct = directions.length ? Math.round((longs / directions.length) * 100) : 100;

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
      const res = await runStackBenchmark(stack, args.dryRun, args.budgetUsd);
      results.push(res);
      if (!args.json) {
        console.log(`Stack [${res.stack}]: validJson=${res.validJsonCount}/${res.totalCalls}, schemaCompliant=${res.schemaCompliantCount}/${res.totalCalls}, retries=${res.retriesCount}, latency: median=${res.medianLatencyMs}ms, p95=${res.p95LatencyMs}ms`);
      }
    } catch (e) {
      if (!args.json) console.error(`Stack [${stack}] failed: ${(e as Error).message}`);
      else results.push({ stack, totalCalls: 0, validJsonCount: 0, schemaCompliantCount: 0, retriesCount: 0, timeoutsCount: 0, providerErrorsCount: 1, resolvedModels: {}, medianLatencyMs: 0, p95LatencyMs: 0, directionalAgreementPct: 0, tradingEvaluationNote: (e as Error).message });
    }
  }

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
  }
}

if (process.argv[1] && /bench-models\.(ts|js)$/.test(process.argv[1])) {
  void main();
}
