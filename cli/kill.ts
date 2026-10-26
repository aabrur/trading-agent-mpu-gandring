// mpu kill [confirm] or npm run kill
// Trips the persisted kill switch and signals the running office to stop auto-trading and flatten.
import { writeKill, DEFAULT_KILL_FILE } from '../server/killswitch.js';

export async function killCmd(argv: string[], file = process.env.KILL_SWITCH_FILE || DEFAULT_KILL_FILE): Promise<{ ok: boolean; text: string }> {
  const isConfirm = argv.includes('confirm') || argv.includes('--yes') || argv.includes('-y');
  if (!isConfirm) {
    return {
      ok: false,
      text: 'Emergency kill switch: this stops auto-trading, cancels orders, and flattens positions. To proceed, run: mpu kill confirm'
    };
  }
  writeKill(file, { at: Date.now(), reason: 'CLI emergency kill switch' });
  const port = process.env.PORT || '8787';
  let officeNotified = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ops/kill`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on: true })
    });
    if (res.ok) officeNotified = true;
  } catch {
    // Office might not be running; file-based kill switch still protects future starts
  }
  return {
    ok: true,
    text: `KILL SWITCH ENGAGED.${officeNotified ? ' Running office notified and stopped.' : ' Persisted to kill switch file.'} To release, run: mpu unkill --yes, then restart.`
  };
}

if (process.argv[1] && /kill\.(ts|js)$/.test(process.argv[1])) {
  killCmd(process.argv.slice(2)).then((r) => {
    console.log(r.text);
    process.exit(r.ok ? 0 : 1);
  });
}
