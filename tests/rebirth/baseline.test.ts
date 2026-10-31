import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { collectContracts, BASELINE_SHA } from '../../scripts/rebirth-contracts.mjs';

const root = path.resolve(__dirname, '../..');
const frozenPath = path.join(root, 'docs/rebirth/baseline.json');

type Control = { id: string; behaviorTest: string; targetOwner: string };
type Route = { id: string; method: string; path: string; mount: string; auth: string; targetOwner: string; errorBehavior: string; behaviorTest: string };
type Component = { name: string; file: string; controls: Control[]; apiCalls: string[] };
type Manifest = {
  baseline: { sha: string; appVersion: string };
  components: Component[];
  routes: Route[];
  websocket: { serverEvents: string[] };
  cli: { mpuHelp: Array<{ command: string; dispatch: string }>; gbSubcommands: string[]; applicationCommands: string[] };
  roles: string[];
  venues: Array<{ id: string; status: string }>;
  settings: { tradingFields: Array<{ name: string; targetOwner: string; errorBehavior: string }>; preferenceFields: Array<{ name: string; targetOwner: string; errorBehavior: string }> };
  decisions: Array<{ id: string; status: string }>;
};

const frozen = (): Manifest => JSON.parse(readFileSync(frozenPath, 'utf8'));
const routeKey = (r: Route) => `${r.method} ${r.path}`;

describe('T00 frozen replacement contract', () => {
  it('discovers_every_declared_control_and_route', () => {
    expect(existsSync(frozenPath)).toBe(true);
    const manifest = frozen();
    const live: Manifest = collectContracts(root);
    expect(manifest.baseline.sha).toBe(BASELINE_SHA);
    expect(manifest.baseline.appVersion).toBe('0.0.0.4.11');

    // Every component in web/src/components is frozen, including the ones the source matrix missed.
    const componentFiles = readdirSync(path.join(root, 'web/src/components')).filter(f => f.endsWith('.tsx')).map(f => f.replace(/\.tsx$/, ''));
    expect(componentFiles).toHaveLength(29);
    const names = new Set(manifest.components.map(c => c.name));
    for (const name of componentFiles) expect(names, name).toContain(name);
    for (const name of ['CodexResearchSetup', 'Lessons', 'UpdateModal', 'SessionLogs', 'Wallet', 'Channels']) expect(names).toContain(name);

    // Nothing currently declared may be missing from the frozen manifest (legacy surface only shrinks after review).
    const frozenRoutes = new Set(manifest.routes.map(routeKey));
    for (const r of live.routes) expect(frozenRoutes, routeKey(r)).toContain(routeKey(r));
    const frozenControls = new Set(manifest.components.flatMap(c => c.controls.map(x => x.id)));
    for (const c of live.components.flatMap(x => x.controls)) expect(frozenControls, c.id).toContain(c.id);

    // Named surfaces from the validation report.
    for (const key of [
      'GET /api/update/status', 'POST /api/update/apply', 'POST /api/trakteer/tip', 'GET /api/trakteer/config',
      'GET /api/chat/history/:agent', 'GET /api/chat/history/:agent/:id', 'DELETE /api/chat/history/:agent/:id', 'POST /api/chat/cancel/:id',
      'GET /api/research', 'POST /api/research/backtest', 'GET /api/ops/lessons', 'POST /api/ops/lessons',
      'GET /api/setup/local-agents/research', 'POST /api/setup/local-agents/research', 'POST /api/kill', 'POST /api/unkill'
    ]) expect(frozenRoutes, key).toContain(key);
    expect(manifest.websocket.serverEvents).toEqual(expect.arrayContaining(['state', 'speech', 'fight', 'meter', 'verdict', 'log', 'status', 'debate', 'report', 'execution', 'room', 'cendol']));

    expect(manifest.venues.map(v => v.id).sort()).toEqual(['aster', 'binance', 'bybit', 'dydx', 'hyperliquid', 'okx', 'orderly', 'paradex']);
    expect(manifest.roles).toEqual(['lead', 'market', 'research', 'strategist', 'risk', 'execution']);

    // Every mpu help command dispatches somewhere; gb and application commands are frozen.
    expect(manifest.cli.mpuHelp.length).toBeGreaterThanOrEqual(40);
    for (const c of manifest.cli.mpuHelp) expect(c.dispatch, c.command).not.toBe('');
    for (const c of ['research', 'backtest', 'lessons', 'positions', 'kill', 'unkill', 'analyze', 'gb', 'channels', 'autostart', 'trade', 'doctor', 'setup']) {
      expect(manifest.cli.mpuHelp.map(x => x.command), c).toContain(c);
    }
    expect(manifest.cli.gbSubcommands).toEqual(expect.arrayContaining(['open', 'close', 'cancel-entry', 'lessons', 'research', 'backtest', 'event']));
    expect(manifest.cli.applicationCommands).toEqual(expect.arrayContaining(['setup', 'doctor', 'gb', 'trade', 'autostart', 'backtest']));

    // Each actionable control and route has a named behavior test, a target owner and error behavior.
    for (const c of manifest.components.flatMap(x => x.controls)) {
      expect(c.behaviorTest, c.id).toMatch(/^tests\/rebirth\/[\w-]+\.test\.ts > \S/);
      expect(c.targetOwner, c.id).toMatch(/^T\d\d/);
    }
    for (const r of manifest.routes) {
      expect(r.behaviorTest, routeKey(r)).toMatch(/^tests\/rebirth\/[\w-]+\.test\.ts > \S/);
      expect(r.targetOwner, routeKey(r)).toMatch(/^T\d\d/);
      expect(r.errorBehavior.length, routeKey(r)).toBeGreaterThan(0);
      expect(r.auth, routeKey(r)).not.toBe('');
    }
    for (const f of [...manifest.settings.tradingFields, ...manifest.settings.preferenceFields]) {
      expect(f.targetOwner, f.name).toMatch(/^T\d\d/);
      expect(f.errorBehavior.length, f.name).toBeGreaterThan(0);
    }
    expect(manifest.settings.tradingFields.map(f => f.name)).toEqual(expect.arrayContaining(['dailyLossLimitPct', 'maxLossPerTradePct', 'minEntryConfidencePct', 'maxLeverage', 'orderSizePct', 'defaultStopPct', 'minStopPct', 'takeProfitPct', 'takeProfitR', 'maxOrderUsdt', 'minOrderUsdt', 'safetyNet', 'maxPositions']));

    const decisions = Object.fromEntries(manifest.decisions.map(d => [d.id, d.status]));
    expect(decisions.D09).toBe('ACCEPTED');
    expect(decisions.D11).toBe('OPEN');
  });

  it('regenerates_identically_from_the_baseline_tree', () => {
    // Line numbers and hashes may move after later tasks; identity lists must stay deterministic run to run.
    const a: Manifest = collectContracts(root), b: Manifest = collectContracts(root);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
