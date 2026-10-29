// mpu kill [confirm] or npm run kill
// Trips the persisted kill switch and signals the running office to stop auto-trading and flatten.
import { writeKill, killContext, DEFAULT_KILL_FILE } from '../server/killswitch.js';
import { safe } from '../server/redact.js';

export async function killCmd(argv: string[], file = process.env.KILL_SWITCH_FILE || DEFAULT_KILL_FILE): Promise<{ ok: boolean; text: string }> {
  const isConfirm = argv.includes('confirm') || argv.includes('--yes') || argv.includes('-y');
  if (!isConfirm) {
    return {
      ok: false,
      text: 'Emergency kill switch: this stops auto-trading, cancels orders, and flattens positions. To proceed, run: mpu kill confirm'
    };
  }
  const context = killContext('cli');
  let evidenceWarning = '';
  try {
    const written = writeKill(file, { at: Date.now(), reason: 'CLI emergency kill switch', ...context });
    if (!written.audit.ok) evidenceWarning = ' Kill switch persisted, but local audit recording failed: ' + written.audit.error;
  } catch (error) { evidenceWarning = ' Local kill persistence failed: ' + safe((error as Error).message); }
  const port = process.env.PORT || '8787';
  let officeNotified = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ops/kill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: true, requestId: context.requestId })
    });
    if (res.ok) officeNotified = true;
  } catch {
    // Office might not be running; file-based kill switch still protects future starts
  }
  return {
    ok: !evidenceWarning,
    text: evidenceWarning
      ? `KILL confirmation incomplete.${evidenceWarning}${officeNotified ? ' Running office notified.' : ' Office notification was not confirmed.'}`
      : `KILL SWITCH ENGAGED.${officeNotified ? ' Running office notified and stopped.' : ' Persisted to kill switch file.'} To release, run: mpu unkill --yes, then restart.`
  };
}

if (process.argv[1] && /kill\.(ts|js)$/.test(process.argv[1])) {
  killCmd(process.argv.slice(2)).then((r) => {
    console.log(r.text);
    process.exit(r.ok ? 0 : 1);
  });
}
