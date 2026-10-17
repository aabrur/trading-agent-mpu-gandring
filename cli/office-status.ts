// npm run office:status  ->  is the office up, and on which ports. Prints no secrets.
import 'dotenv/config';

const api = Number(process.env.PORT || 8787), web = Number(process.env.WEB_PORT || 5173);
async function probe(url: string) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(2500) }); return { up: r.ok, status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null }; }
  catch { return { up: false, status: 0, body: null }; }
}
const [a, w] = await Promise.all([probe(`http://127.0.0.1:${api}/api/health`), probe(`http://127.0.0.1:${web}/`)]);
const h = a.body as { mode?: string; appMode?: string; killed?: boolean } | null;
const out = {
  backend: { up: a.up, port: api, url: `http://localhost:${api}`, mode: h?.mode ?? null, appMode: h?.appMode ?? null, killed: h?.killed ?? null },
  ui: { up: w.up, port: web, url: `http://localhost:${web}` }
};
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`backend ${out.backend.up ? 'UP' : 'down'} on ${out.backend.url}${h ? ` (${h.mode}, ${h.appMode}${h.killed ? ', KILLED' : ''})` : ''}`);
  console.log(`office UI ${out.ui.up ? 'UP' : 'down'} on ${out.ui.url}${!out.ui.up && out.backend.up ? ` (a built UI is also served on ${out.backend.url})` : ''}`);
  if (!out.backend.up) console.log('start it with: npm run office   (or in the background: nohup npm run office > office.log 2>&1 &)');
}
process.exitCode = out.backend.up ? 0 : 1;
