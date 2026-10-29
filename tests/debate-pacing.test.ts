import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../server/config.js';
import { Desk } from '../server/desk.js';
import { makeCaller, type ModelCaller } from '../server/providers/index.js';
import { AutoTrader } from '../server/auto.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

async function finish<T>(run: Promise<T>, desk?: Desk): Promise<T> {
  let done = false;
  const result = run.finally(() => { done = true; });
  for (let i = 0; i < 180 && !done; i++) await vi.advanceTimersByTimeAsync(1000);
  expect(done, JSON.stringify({ phase: desk?.debate?.phase, timers: vi.getTimerCount() })).toBe(true);
  return result;
}

function fixture(mode: 'normal' | 'fast', override?: ModelCaller) {
  vi.stubEnv('COINMARKETCAP_API_KEY', '');
  vi.stubEnv('CMC_API_KEY', '');
  const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_PROVIDER: 'mock',
    DEBATE_MODE: mode, DEBATE_PACE_MS: '700', AUTO_TRADING: 'off', AUTO_SYMBOLS: 'ETHUSDT' });
  const desk = new Desk(cfg, override ?? makeCaller(cfg), { reportsDir: null, learningsPath: null, conversationsPath: null, killFile: null, jevEnv: {} });
  const phases: Array<{ phase: string; at: number }> = [];
  const submissions: Array<{ phase: string | undefined; at: number }> = [];
  desk.on('debate', (event) => phases.push({ phase: event.phase, at: Date.now() }));
  desk.on('execution', (event) => { if (event.status === 'submitted') submissions.push({ phase: desk.debate?.phase, at: Date.now() }); });
  return { desk, phases, submissions };
}

describe('visible debate lifecycle', () => {
  it('normalizes the HYPE repeated execution status before speech, history and Lead synthesis', async () => {
    vi.useFakeTimers();
    const base = makeCaller(loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_PROVIDER: 'mock' }));
    let executionAssessment = '';
    const caller: ModelCaller = async request => {
      if (request.agent === 'execution' && request.task === 'chat') return JSON.stringify({ reply: 'No order sent. '.repeat(1200) + 'Exchange snapshot is flat; 3 entry slots are available.' });
      if (request.agent === 'lead' && request.task === 'lead') executionAssessment = String((request.context.roleAnalysis as { execution?: { assessment?: string } } | undefined)?.execution?.assessment ?? request.user);
      return base(request);
    };
    const { desk, phases } = fixture('fast', caller);
    const diagnostics = vi.spyOn(desk, 'diagnostic');
    const speech: string[] = [];
    desk.on('speech', event => { if (event.agent === 'execution' && event.done) speech.push(event.text); });
    const verdict = await finish(desk.runDebate('HYPEUSDT'), desk);
    const expected = 'No order sent. Exchange snapshot is flat; 3 entry slots are available.';
    expect(speech[0]).toBe(expected);
    expect(desk.logs.find(line => line.kind === 'speech' && line.agent === 'execution')?.text).toBe(expected);
    const completed = diagnostics.mock.calls.map(([input]) => input).find(input => input.eventName === 'agent.completed' && input.source === 'agent:execution');
    expect(completed?.details?.speechNormalization).toMatchObject({ fields: ['reply'], originalResponse: expect.stringContaining('No order sent. No order sent.') });
    expect(executionAssessment).toContain(expected);
    expect(executionAssessment).not.toContain('No order sent. No order sent.');
    expect(phases.map(p => p.phase)).toContain('done');
    expect(verdict).toBeDefined();
  });

  it('bounds speech animation while retaining a distinct long reply in chat and events', async () => {
    vi.useFakeTimers();
    const reply = '\n\n' + Array.from({ length: 600 }, (_, i) => `Observation ${i}: distinct measured value ${i + 1}.25.`).join('\n');
    const { desk } = fixture('normal', async () => JSON.stringify({ reply }));
    const events: Array<{ text: string; done: boolean }> = [];
    desk.on('speech', event => events.push(event));
    await finish(desk.command('Explain the observations', 'execution', 'long-reply'), desk);
    expect(events.length).toBeLessThanOrEqual(25);
    expect(events.at(-1)).toMatchObject({ text: reply, done: true });
    expect(desk.roomHistory.find(message => message.from === 'execution')?.text).toBe(reply);
  });

  it.each(['normal', 'fast'] as const)('%s gathers, debates and prepares before submitting a paper order', async (mode) => {
    vi.useFakeTimers();
    const { desk, phases, submissions } = fixture(mode);
    const run = desk.runDebate('ETHUSDT');
    await finish(run);
    const names = phases.map((p) => p.phase);
    const expected = ['opening', 'reading', 'strategy', 'gathering', 'verdict', 'risk gate', 'preparation', 'execution', 'done'];

    expect(names).toEqual(expect.arrayContaining(expected));
    expect(names.includes('round 1')).toBe(false);
    expect(submissions).toHaveLength(1);
    expect(submissions[0].phase).toBe('execution');
    expect(submissions[0].at - phases.find((p) => p.phase === 'preparation')!.at).toBeGreaterThanOrEqual(mode === 'normal' ? 2800 : 1400);
  });

  it('runs round 1 in fast mode when analysts disagree', async () => {
    vi.useFakeTimers();
    const base = makeCaller(loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_PROVIDER: 'mock' }));
    const disagreeCaller: ModelCaller = async (req) => {
      if (req.agent === 'market' && req.task === 'opinion') {
        return JSON.stringify({ stance: 'LONG', confidence: 0.9, argument: 'Tape is bullish' });
      }
      if (req.agent === 'research' && req.task === 'research') {
        return JSON.stringify({ vote: 'SHORT', confidence: 0.9, argument: 'Opposing thesis', sources: [] });
      }
      if (req.agent === 'strategist' && req.task === 'opinion') {
        return JSON.stringify({ stance: 'LONG', confidence: 0.9, argument: 'Trend is long' });
      }
      return base(req);
    };
    const { desk, phases } = fixture('fast', disagreeCaller);
    const run = desk.runDebate('ETHUSDT');
    await finish(run);
    const names = phases.map((p) => p.phase);
    expect(names).toEqual(expect.arrayContaining(['gathering', 'round 1', 'verdict']));
  });

  it.each(['manual', 'scheduled'] as const)('%s cycles use the same paced lifecycle', async (trigger) => {
    vi.useFakeTimers();
    const { desk, phases } = fixture('fast');
    const auto = new AutoTrader(desk);
    const run = auto.cycle(trigger);
    expect((await finish(run, desk)).ran).toEqual(['ETHUSDT']);
    expect(phases.map((p) => p.phase)).toEqual(expect.arrayContaining(['gathering', 'preparation', 'execution']));
    expect(desk.autoState.running).toBe(false);
  });

  it('stops a paused debate during gathering before any order is submitted', async () => {
    vi.useFakeTimers();
    const { desk, submissions } = fixture('normal');
    desk.on('debate', (event) => { if (event.phase === 'gathering') void desk.command('pause'); });
    const result = desk.runDebate('ETHUSDT').catch((error: Error) => error);
    expect(await finish(result)).toBeInstanceOf(Error);
    expect(submissions).toHaveLength(0);
    expect(desk.book.positions).toHaveLength(0);
    expect(desk.debate).toBeNull();
  });

  it('keeps an opposing exchange visible before the next speaker or phase', async () => {
    vi.useFakeTimers();
    const cfg = loadConfig({ TRADING_MODE: 'PAPER', MARKET_SOURCE: 'sample', DEFAULT_PROVIDER: 'mock' });
    const base = makeCaller(cfg);
    const caller: ModelCaller = async (request) => {
      if (request.task === 'opinion' && request.agent === 'market') return JSON.stringify({ stance: 'LONG', confidence: 0.9, argument: 'Fixture bullish evidence.' });
      if (request.task === 'research') return JSON.stringify({ vote: 'SHORT', confidence: 0.9, argument: 'Fixture opposing evidence.', sources: [] });
      return base(request);
    };
    const { desk, phases } = fixture('fast', caller);
    const fights: number[] = [];
    desk.on('fight', () => fights.push(Date.now()));
    await finish(desk.runDebate('ETHUSDT'));
    expect(fights.length).toBeGreaterThan(0);
    const verdictAt = phases.find((p) => p.phase === 'verdict')!.at;
    expect(verdictAt - Math.max(...fights)).toBeGreaterThanOrEqual(2450);
  });
});
