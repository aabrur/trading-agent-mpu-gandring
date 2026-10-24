import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LOCAL_AGENTS, localLoginStatus, openAgentLogin } from '../server/providers/local.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('explicit agent login completion', () => {
  it.each(LOCAL_AGENTS.map((agent) => [agent.id, agent.bin] as const))('%s cannot connect while login is pending or cancelled, even with an existing account', async (id, name) => {
    const folder = mkdtempSync(path.join(tmpdir(), 'mpu-login-lifecycle-'));
    writeFileSync(path.join(folder, `${name}${process.platform === 'win32' ? '.cmd' : ''}`), process.platform === 'win32' ? '@"%dp0%\\fake.js"' : '', { mode: 0o755 });
    writeFileSync(path.join(folder, 'fake.js'), '');
    vi.stubEnv('PATH', folder);
    const children: EventEmitter[] = [];
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(),
        stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
        unref: vi.fn(), kill: vi.fn(),
      });
      children.push(child);
      setImmediate(() => child.emit('spawn'));
      // Status/model subprocesses always report an already authenticated account.
      if (children.length > 2) setImmediate(() => {
        child.stdout.emit('data', Buffer.from('{"loggedIn":true,"reply":"connected"}'));
        child.emit('close', 0);
      });
      return child as unknown as ReturnType<typeof spawn>;
    });
    await openAgentLogin(id);
    expect(await localLoginStatus(id, true)).toEqual({ connected: false, state: 'pending' });
    expect(children).toHaveLength(1);
    children[0].emit('close', 1);
    expect(await localLoginStatus(id, true)).toEqual({ connected: false, state: 'failed' });
    await openAgentLogin(id);
    expect(await localLoginStatus(id, true)).toEqual({ connected: false, state: 'pending' });
    children[1].emit('close', 0);
    expect((await localLoginStatus(id, true)).connected).toBe(true);
  });
});
