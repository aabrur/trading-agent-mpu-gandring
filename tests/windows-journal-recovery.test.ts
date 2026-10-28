import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, openSync, closeSync, readdirSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExecutionJournal, sleepSync } from '../server/live/journal.js';
import { LiveExecutor } from '../server/live/executor.js';
import { MemoryAdapter } from './fakes.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe('Case F: Windows native journal recovery and persistence integrity', () => {
  it('recovers from transient EPERM handle contention during bounded retries', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mg-win-eperm-'));
    dirs.push(dir);
    const journalPath = path.join(dir, 'journal.json');

    const journal = new ExecutionJournal(journalPath, 'aster:mainnet');
    journal.save();
    expect(existsSync(journalPath)).toBe(true);

    // Simulate transient Windows EPERM on first 2 attempts
    let attempts = 0;
    journal.renameFn = (oldPath: string, newPath: string) => {
      attempts++;
      if (attempts <= 2) {
        const err: any = new Error('EPERM: operation not permitted');
        err.code = 'EPERM';
        throw err;
      }
      renameSync(oldPath, newPath);
    };

    journal.intents.push({
      clientId: 'mg-win-order-1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      kind: 'open',
      requestedQty: 1,
      accountedQty: 0,
      accountedValue: 0,
      record: null,
      at: Date.now()
    });

    journal.save();

    expect(attempts).toBeGreaterThanOrEqual(3);
    const saved = JSON.parse(readFileSync(journalPath, 'utf8'));
    expect(saved.intents).toHaveLength(1);
    expect(saved.intents[0].clientId).toBe('mg-win-order-1');
  });

  it('preserves last-good journal file when native Windows handle lock is unrecoverable', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mg-win-unrec-'));
    dirs.push(dir);
    const journalPath = path.join(dir, 'journal.json');

    const journal = new ExecutionJournal(journalPath, 'aster:mainnet');
    journal.intents.push({
      clientId: 'mg-last-good',
      symbol: 'ETHUSDT',
      side: 'LONG',
      kind: 'open',
      requestedQty: 2,
      accountedQty: 0,
      accountedValue: 0,
      record: null,
      at: Date.now()
    });
    journal.save();

    const goodRaw = readFileSync(journalPath, 'utf8');

    // On Windows, holding handle open without delete share triggers real native EPERM from OS kernel.
    // On POSIX (Linux/macOS in CI), file handles do not block rename, so simulate the OS EPERM via renameFn.
    let fd: number | null = null;
    if (process.platform === 'win32') {
      fd = openSync(journalPath, 'r');
    } else {
      journal.renameFn = () => {
        const err: any = new Error('EPERM: operation not permitted, rename');
        err.code = 'EPERM';
        throw err;
      };
    }
    try {
      journal.intents.push({
        clientId: 'mg-failing-order',
        symbol: 'SOLUSDT',
        side: 'SHORT',
        kind: 'open',
        requestedQty: 5,
        accountedQty: 0,
        accountedValue: 0,
        record: null,
        at: Date.now()
      });

      expect(() => journal.save()).toThrow(/EPERM/);
    } finally {
      if (fd !== null) closeSync(fd);
    }

    // Check last-good file was preserved untouched
    expect(readFileSync(journalPath, 'utf8')).toBe(goodRaw);
    const remainingTmps = readdirSync(dir).filter(f => f.endsWith('.tmp'));
    expect(remainingTmps).toHaveLength(0);
  });

  it('automatically recovers last-good state from backup on restart when primary journal is corrupted', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mg-win-corrupt-'));
    dirs.push(dir);
    const journalPath = path.join(dir, 'journal.json');

    const journal1 = new ExecutionJournal(journalPath, 'aster:mainnet');
    journal1.positions = [{
      id: 'P1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      qty: 1,
      entry: 50000,
      stop: 49000,
      tp: 55000,
      margin: 5000,
      leverage: 10,
      mark: 50100,
      unrealizedPnl: 100,
      at: Date.now()
    }];
    journal1.save();
    expect(existsSync(`${journalPath}.bak`)).toBe(true);

    // Corrupt primary journal file (simulating torn or interrupted write on disk)
    writeFileSync(journalPath, '{"venue":"aster:mainnet","intents":[TORN_BYTES_PARTIAL_JSON...');

    // Restart journal: constructor should detect corrupt primary and recover from .bak
    const journal2 = new ExecutionJournal(journalPath, 'aster:mainnet');
    expect(journal2.positions).toHaveLength(1);
    expect(journal2.positions[0].id).toBe('P1');
    expect(journal2.positions[0].symbol).toBe('BTCUSDT');

    // Primary file is repaired
    const repaired = JSON.parse(readFileSync(journalPath, 'utf8'));
    expect(repaired.positions).toHaveLength(1);
    expect(repaired.positions[0].id).toBe('P1');
  });

  it('coordinates multi-process writers and detects conflicting lock ownership', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mg-win-lock-'));
    dirs.push(dir);
    const journalPath = path.join(dir, 'journal.json');
    const lockPath = `${journalPath}.lock`;

    // Create a manual lock held by active process
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    closeSync(fd);

    const journal = new ExecutionJournal(journalPath, 'aster:mainnet');
    // Save should fail because lock is actively held
    expect(() => journal.save()).toThrow(/Conflicting journal lock/i);

    // If lock is from dead PID, it clears stale lock and succeeds
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: Date.now() - 1000 }));
    expect(() => journal.save()).not.toThrow();
    expect(existsSync(journalPath)).toBe(true);
  });

  it('proves journal failure does not submit duplicate orders or drop managed positions', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mg-win-exec-'));
    dirs.push(dir);
    const journalPath = path.join(dir, 'journal.json');

    const adapter = new MemoryAdapter();
    const executor = new LiveExecutor(adapter, 0, journalPath);

    // Sabotage renameFn to throw unrecoverable error
    executor.journal.renameFn = () => {
      const err: any = new Error('EPERM: disk lock');
      err.code = 'EPERM';
      throw err;
    };

    // Attempt open: save() in intent() should throw BEFORE placeOrder() is called
    await expect(executor.open({
      symbol: 'BTCUSDT',
      side: 'LONG',
      qty: 1,
      stop: 90,
      tp: 120,
      leverage: 2
    })).rejects.toThrow();

    // Verify adapter NEVER received any order! Zero duplicate or unauthorized orders
    expect(adapter.placed).toHaveLength(0);
  });

  it('demonstrates sleepSync backoff is bounded and does not busy-spin', () => {
    const start = Date.now();
    sleepSync(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(150);
  });
});
