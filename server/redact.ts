// Strips anything that looks like a credential before text reaches a log, a report,
// the browser, or the Grok Bot bridge.
const PATTERNS: RegExp[] = [
  /\bxai-[A-Za-z0-9_-]{10,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b0x[a-fA-F0-9]{64}\b/g, // private-key shaped hex
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /((?:api[_-]?key|secret|token|password|x-automation-key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi
];

export function redact(input: string, extraSecrets: string[] = []): string {
  let out = String(input);
  for (const s of extraSecrets) {
    if (s && s.length >= 6) out = out.split(s).join('[REDACTED]');
  }
  for (const re of PATTERNS) {
    out = out.replace(re, (m, p1) => (typeof p1 === 'string' && m.startsWith(p1) ? `${p1}[REDACTED]` : '[REDACTED]'));
  }
  return out;
}

let known: string[] = [];
export function registerSecrets(values: (string | undefined)[]) {
  known = values.filter((v): v is string => !!v && v.length >= 6);
}
export function safe(input: unknown): string {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  return redact(text, known);
}
export function log(...parts: unknown[]) {
  console.log(parts.map((p) => safe(p instanceof Error ? p.message : p)).join(' '));
}
