import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runApplicationEntry } from '../server/session-entry.js';

const commands = new Set(['setup', 'doctor', 'debate', 'gb', 'channels', 'unkill', 'trade', 'autostart', 'office-status', 'backtest', 'bench-models']);
const command = process.argv[2];
if (!commands.has(command)) throw new Error('Unknown application command');
const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
const target = path.join(path.dirname(fileURLToPath(import.meta.url)), command + extension);
process.argv = [process.argv[0], target, ...process.argv.slice(3)];
await runApplicationEntry(`cli:${command}`, () => import(pathToFileURL(target).href));
