import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { SessionLogger, listSessions, readSession, readSessionEvents } from '../server/session-log.js';

const roots: string[] = [], children: ChildProcess[] = [];
async function temp() { const root = await mkdtemp(path.join(os.tmpdir(), 'mpu-session-process-')); roots.push(root); return root; }
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode) return resolve(); child.once('exit', () => resolve()); child.kill(); })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function environment(root: string) {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC']) if (process.env[name]) env[name] = process.env[name];
  return { ...env, DOTENV_CONFIG_PATH: '__isolated_no_env__', MPU_LOG_ROOT: root, TRADING_MODE: 'PAPER', AUTO_TRADING: 'off', DEFAULT_PROVIDER: 'mock', MARKET_SOURCE: 'sample' };
}
const entry = pathToFileURL(path.resolve('server/session-entry.ts')).href;
async function childSession(root: string, parentSessionId?: string) {
  const code = `import {beginApplicationSession} from ${JSON.stringify(entry)}; const logger=await beginApplicationSession('fixture-child');logger.write({source:'fixture',eventName:'child.ready',message:'child ready'});process.stdout.write('stdout fixture line\\n');process.stderr.write('stderr fixture line\\n');await logger.flush();const timer=setInterval(()=>{},1000);process.once('message',()=>{clearInterval(timer);process.disconnect();});process.send({sessionId:logger.session.sessionId});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { env: { ...environment(root), ...(parentSessionId ? { MPU_PARENT_SESSION_ID: parentSessionId } : {}) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  children.push(child);
  const id = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Child did not initialize')), 10000);
    child.once('message', message => { clearTimeout(timeout); resolve((message as { sessionId: string }).sessionId); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Child exited before readiness: ${code}`)); });
  });
  return { child, id };
}
function exited(child: ChildProcess) { return new Promise<void>(resolve => { if (child.exitCode !== null || child.signalCode) resolve(); else child.once('exit', () => resolve()); }); }

describe('real isolated process lifecycle', () => {
  it('flushes normal completion and preserves concurrent child-session identity and order', async () => {
    const root = await temp(), parent = await SessionLogger.start({ root, entrypoint: 'fixture-parent' });
    const runs = await Promise.all([childSession(root, parent.session.sessionId), childSession(root, parent.session.sessionId)]);
    expect(runs[0].id).not.toBe(runs[1].id);
    await Promise.all(runs.map(async run => { const done = exited(run.child); run.child.send('complete'); await done; }));
    for (const run of runs) {
      expect(await readSession(root, run.id)).toMatchObject({ parentSessionId: parent.session.sessionId, outcome: 'CLEAN_SHUTDOWN', endedAt: expect.any(String) });
      const events = (await readSessionEvents(root, run.id, {})).events;
      expect(events.every(event => event.sessionId === run.id)).toBe(true);
      expect(events.map(event => event.sequence)).toEqual([...new Set(events.map(event => event.sequence))].sort((a, b) => a - b));
      expect(events.map(event => event.eventName)).toContain('session.end');
      expect(events.map(event => event.eventName)).toEqual(expect.arrayContaining(['stdout.line', 'stderr.line']));
    }
    await parent.finish('CLEAN_SHUTDOWN', 'test');
  });
  it('keeps the last persisted event and infers forced termination on the next run', async () => {
    const root = await temp(), run = await childSession(root);
    const done = exited(run.child); run.child.kill('SIGKILL'); await done;
    expect((await readSession(root, run.id)).outcome).toBeNull();
    const next = await SessionLogger.start({ root });
    expect(await readSession(root, run.id)).toMatchObject({ outcome: 'UNCLEAN_TERMINATION', endedAt: null, unclean: { inferred: true } });
    expect((await readSessionEvents(root, run.id, {})).events.some(event => event.eventName === 'child.ready')).toBe(true);
    expect((await readSessionEvents(root, run.id, {})).events.some(event => event.eventName === 'session.end')).toBe(false);
    await next.finish('CLEAN_SHUTDOWN', 'test');
  });
  it('captures actual server startup validation failure without any exchange credentials or network', async () => {
    const root = await temp();
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { env: { ...environment(root), TRADING_MODE: 'invalid' }, stdio: 'ignore', windowsHide: true });
    children.push(child); await exited(child);
    expect(child.exitCode).not.toBe(0);
    const sessions = (await listSessions(root)).sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ entrypoint: 'server', outcome: 'STARTUP_FAILURE' });
    expect((await readSessionEvents(root, sessions[0].sessionId, {})).events.map(event => event.eventName)).toContain('startup.configuration_failed');
  });
});
