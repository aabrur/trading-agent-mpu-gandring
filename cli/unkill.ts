// npm run unkill -- --yes
// Clears the persisted kill switch. Run it on the machine itself, then restart the office to trade again.
// There is deliberately no HTTP route or gb command for this: agents can press the kill switch, only the owner releases it.
import { clearKill, readKill, DEFAULT_KILL_FILE } from '../server/killswitch.js';

export function unkill(argv: string[], file = process.env.KILL_SWITCH_FILE || DEFAULT_KILL_FILE): { ok: boolean; text: string } {
  const rec = readKill(file);
  if (!rec) return { ok: true, text: `kill switch is not on (${file} not found). Nothing to do.` };
  const when = rec.at ? new Date(rec.at).toISOString() : 'unknown time';
  if (!argv.includes('--yes')) return { ok: false, text: `kill switch is ON since ${when} (${rec.reason}). To release it run: npm run unkill -- --yes   then restart the office.` };
  clearKill(file);
  return { ok: true, text: `kill switch file released (was on since ${when}).` };
}

export async function notifyOfficeRelease(options: {
  port?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
} = {}): Promise<{ ok: boolean; reached: boolean; killed: boolean | null; text: string }> {
  const port = options.port || process.env.PORT || '8787';
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/unkill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ yes: true }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000)
    });
    const body = (await res.json()) as { ok?: boolean; killed?: boolean; message?: string };
    const killed = typeof body.killed === 'boolean' ? body.killed : null;
    if (!res.ok || body.ok === false || killed === true) {
      return {
        ok: false,
        reached: true,
        killed,
        text: body.message ?? 'Release failed: persisted halt latch remains active.'
      };
    }
    return {
      ok: true,
      reached: true,
      killed: killed ?? false,
      text: body.message ?? 'Kill switch released. Auto remains OFF.'
    };
  } catch {
    return { ok: true, reached: false, killed: null, text: 'Office not running. File latch cleared if present.' };
  }
}

async function main(argv: string[]): Promise<void> {
  const r = unkill(argv);
  if (!r.ok) {
    console.log(r.text);
    process.exit(1);
  }
  const notified = await notifyOfficeRelease();
  if (notified.reached && !notified.ok) {
    console.log(`${r.text} ${notified.text}`);
    process.exit(1);
  }
  console.log(
    notified.reached
      ? `${r.text} ${notified.text}`
      : `${r.text} Restart the office (npm run office or npm run trade) to trade again.`
  );
  process.exit(0);
}

if (process.argv[1] && /unkill\.(ts|js)$/.test(process.argv[1])) {
  void main(process.argv.slice(2));
}
