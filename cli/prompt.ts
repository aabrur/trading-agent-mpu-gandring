import readline from 'node:readline';
import { Writable } from 'node:stream';

// Prompts for the setup wizard. Secrets are read with echo off.
export function isInteractive() { return !!process.stdin.isTTY && !!process.stdout.isTTY; }

export async function ask(question: string, def = ''): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await new Promise<string>((res) => rl.question(`${question}${def ? ` [${def}]` : ''}: `, res));
  rl.close();
  return a.trim() || def;
}

export async function askSecret(question: string): Promise<string> {
  let muted = false;
  const out = new Writable({ write(chunk, enc, cb) { if (!muted) process.stdout.write(chunk, enc as BufferEncoding); cb(); } });
  const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
  const p = new Promise<string>((res) => rl.question(`${question} (hidden, Enter to skip): `, res));
  muted = true;
  const a = await p;
  rl.close();
  process.stdout.write('\n');
  return a.trim();
}

export async function askYes(question: string, def = false): Promise<boolean> {
  const a = (await ask(`${question} (y/n)`, def ? 'y' : 'n')).toLowerCase();
  return a.startsWith('y');
}

export async function choose<T extends string>(question: string, options: readonly T[], def: T): Promise<T> {
  for (;;) {
    const a = (await ask(`${question} (${options.join(' / ')})`, def)).toLowerCase() as T;
    if (options.includes(a)) return a;
    console.log(`  pick one of: ${options.join(', ')}`);
  }
}
