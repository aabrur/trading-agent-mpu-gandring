/** Collapse only consecutive sentence/line loops of at least three identical units. */
export function normalizeAgentSpeech(text: string): string {
  const units = (text.match(/[\s\S]*?(?:[.!?]+(?=\s|$)\s*|\n+|$)/g) ?? []).filter(Boolean);
  const key = (unit: string) => unit.trim().replace(/\s+/g, ' ');
  const out: string[] = [];
  for (let i = 0; i < units.length;) {
    let end = i + 1;
    while (end < units.length && key(units[end]) === key(units[i])) end++;
    out.push(...units.slice(i, end - i >= 3 && key(units[i]) ? i + 1 : end));
    i = end;
  }
  return out.join('');
}
