import { existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';

// Small .env editor: keeps comments and order, replaces values in place, appends new keys at the end.
export function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export function ensureEnv(path: string, example = '.env.example') {
  if (!existsSync(path)) {
    if (existsSync(example)) copyFileSync(example, path); else writeFileSync(path, '');
  }
  try { chmodSync(path, 0o600); } catch { /* windows */ }
}

const quote = (v: string) => (/[\s#"']/.test(v) ? JSON.stringify(v) : v);

export function setEnv(path: string, updates: Record<string, string | null>) {
  ensureEnv(path);
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const left = { ...updates };
  const out: string[] = [];
  const active = new Set(lines.map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1]).filter(Boolean) as string[]);
  for (const line of lines) {
    // a live KEY=value line, or a commented example "# KEY=value" (no spaces) when no live line exists
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=/) ?? (line.match(/^#\s*([A-Z0-9_]+)=\S*$/) && !active.has(line.match(/^#\s*([A-Z0-9_]+)=/)![1]) ? line.match(/^#\s*([A-Z0-9_]+)=/) : null);
    if (m && m[1] in left) {
      const v = left[m[1]];
      delete left[m[1]];
      if (v === null) continue;
      out.push(`${m[1]}=${quote(v)}`);
    } else out.push(line);
  }
  const extra = Object.entries(left).filter(([, v]) => v !== null);
  if (extra.length) { if (out.at(-1) !== '') out.push(''); for (const [k, v] of extra) out.push(`${k}=${quote(v as string)}`); }
  writeFileSync(path, out.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
}

/** For printing: shows that a secret is set without showing it. */
export const mask = (v: string | undefined) => (!v ? '(empty)' : `set, ${v.length} chars`);
