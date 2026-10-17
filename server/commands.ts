export type Command =
  | { type: 'debate'; symbol: string }
  | { type: 'pause' } | { type: 'resume' }
  | { type: 'set_n'; n: number }
  | { type: 'set_safety'; value: number }
  | { type: 'set_balance'; value: number }
  | { type: 'close_all' }
  | { type: 'close'; symbol: string }
  | { type: 'mood'; delta: number | 'reset' }
  | { type: 'status' } | { type: 'help' }
  | { type: 'chat'; text: string };

export function normSymbol(s: string): string {
  const up = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!up) return '';
  return /USDT$|USDC$|USD$/.test(up) ? up : `${up}USDT`;
}

// Plain language command parser. English plus a few Bahasa Indonesia words.
export function parseCommand(input: string): Command {
  const t = input.trim().replace(/^\//, '');
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^(?:analy[sz]e|debate|scan|check|cek|analisa|debat)\s+([a-z0-9/-]{2,15})\b/i))) return { type: 'debate', symbol: normSymbol(m[1]) };
  if (/^(pause|stop|tahan|jeda)\b/i.test(t)) return { type: 'pause' };
  if (/^(resume|start|lanjut|unpause)\b/i.test(t)) return { type: 'resume' };
  if ((m = t.match(/^(?:set\s+)?(?:n|orders?|open\s+orders?|order)\s*(?:=|to|:)?\s*(\d+)\b/i))) return { type: 'set_n', n: Number(m[1]) };
  if ((m = t.match(/^(?:set\s+)?(?:safety(?:\s*net)?|sn)\s*(?:=|to|:)?\s*(\d+(?:\.\d+)?)/i))) return { type: 'set_safety', value: Number(m[1]) };
  if ((m = t.match(/^(?:set\s+)?(?:balance|saldo)\s*(?:=|to|:)?\s*(\d+(?:\.\d+)?)/i))) return { type: 'set_balance', value: Number(m[1]) };
  if (/^(close|tutup)\s+(all|semua|everything)\b/i.test(t)) return { type: 'close_all' };
  if ((m = t.match(/^(?:close|tutup)\s+([a-z0-9]{2,15})\b/i))) return { type: 'close', symbol: normSymbol(m[1]) };
  if (/\b(more\s+)?(cautious|careful|conservative|hati-hati|pelan)\b/i.test(t)) return { type: 'mood', delta: -1 };
  if (/\b(more\s+)?(aggressive|bold|berani)\b/i.test(t)) return { type: 'mood', delta: 1 };
  if (/\b(calm down|reset mood|normal again|biasa saja)\b/i.test(t)) return { type: 'mood', delta: 'reset' };
  if (/^(status|portfolio)\b/i.test(t)) return { type: 'status' };
  if (/^(help|\?)$/i.test(t)) return { type: 'help' };
  return { type: 'chat', text: t };
}

export const HELP = 'Commands: analyze ETHUSDT, pause, resume, set n 3, set safety 20, set balance 100, close all, close BTC, be more cautious, be more aggressive, calm down, status.';
