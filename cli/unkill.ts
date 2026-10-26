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
  const port = process.env.PORT || '8787';
  try {
    void fetch(`http://127.0.0.1:${port}/api/ops/kill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: false })
    }).catch(() => {});
  } catch {}
  return { ok: true, text: `kill switch released (was on since ${when}). Restart the office (npm run office or npm run trade) to trade again.` };
}

if (process.argv[1] && /unkill\.(ts|js)$/.test(process.argv[1])) {
  const r = unkill(process.argv.slice(2));
  console.log(r.text);
  process.exit(r.ok ? 0 : 1);
}
