import { TRADING_PRESET_IDS, type TradingPresetId } from './trading-settings.js';

export type Command =
  | { type: 'invalid'; reason: string }
  | { type: 'set_profile'; profile: TradingPresetId }
  | { type: 'set_size'; value: number }
  | { type: 'set_leverage'; value: number }
  | { type: 'open'; symbol: string; side: 'LONG' | 'SHORT'; orderSizePct?: number; leverage?: number }
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
  if ((m = t.match(/^set\s+profile\s+(\S+)$/i))) {
    const profile = m[1].toLowerCase() as TradingPresetId;
    return TRADING_PRESET_IDS.includes(profile) ? { type: 'set_profile', profile } : { type: 'invalid', reason: 'Profile must be default, balance, profit or aggressive.' };
  }
  if ((m = t.match(/^set\s+(size|leverage)\s+(\d+(?:\.\d+)?)(%|x)?$/i))) {
    const value = Number(m[2]), size = m[1].toLowerCase() === 'size';
    if (size && m[3] !== '%' || !size && m[3] === '%' || value < (size ? 1.5 : 1) || value > (size ? 100 : 20) || !size && !Number.isInteger(value)) return { type: 'invalid', reason: size ? 'Usage: set size <1.5..100>%' : 'Usage: set leverage <1..20>' };
    return { type: size ? 'set_size' : 'set_leverage', value };
  }
  if ((m = t.match(/^(?:open\s+(long|short)|(buy|sell))\s+([a-z0-9/-]{2,20})(?:\s+(\d+(?:\.\d+)?)%)?(?:\s+(\d+)(?:x)?)?$/i))) {
    const orderSizePct = m[4] ? Number(m[4]) : undefined, leverage = m[5] ? Number(m[5]) : undefined;
    if (orderSizePct != null && (orderSizePct < 1.5 || orderSizePct > 100) || leverage != null && (leverage < 1 || leverage > 20)) return { type: 'invalid', reason: 'Order size must be 1.5..100%; leverage must be 1..20x.' };
    return { type: 'open', side: /^(long|buy)$/i.test(m[1] ?? m[2]) ? 'LONG' : 'SHORT', symbol: normSymbol(m[3]), orderSizePct, leverage };
  }
  if (/^(?:set\s+(?:profile|size|leverage)|open|buy|sell)\b/i.test(t) && !/^open\s+orders?\b/i.test(t)) return { type: 'invalid', reason: 'Usage: set profile <name>, set size <1.5..100>%, set leverage <1..20>, open long|short <symbol> [size%] [leverage].' };
  if ((m = t.match(/^(?:analy[sz]e|debate|scan|check|cek|analisa|debat)\s+([a-z0-9/-]{2,15})\b/i))) return { type: 'debate', symbol: normSymbol(m[1]) };
  if (/^(pause|stop|tahan|jeda)\b/i.test(t)) return { type: 'pause' };
  if (/^(resume|start|lanjut|unpause)\b/i.test(t)) return { type: 'resume' };
  if ((m = t.match(/^(?:set\s+)?(?:n|orders?|open\s+orders?|order)\s*(?:=|to|:)?\s*(\d+)\b/i))) return { type: 'set_n', n: Number(m[1]) };
  if ((m = t.match(/^(?:set\s+)?(?:safety(?:\s*net)?|sn)\s*(?:=|to|:)?\s*(\d+(?:\.\d+)?)/i))) return { type: 'set_safety', value: Number(m[1]) };
  if ((m = t.match(/^(?:set\s+)?(?:balance|saldo)\s*(?:=|to|:)?\s*(\d+(?:\.\d+)?)/i))) return { type: 'set_balance', value: Number(m[1]) };
  if (/^(close|tutup)\s+(all|semua|everything)$/i.test(t)) return { type: 'close_all' };
  if ((m = t.match(/^(?:close|tutup)\s+([a-z0-9]{2,15})$/i))) return { type: 'close', symbol: normSymbol(m[1]) };
  if (/^(close|tutup)\b/i.test(t)) return { type: 'invalid', reason: 'Usage: close <symbol> or close all.' };
  if (/^(?:be\s+)?(?:(?:more|lebih)\s+)?(?:cautious|careful|conservative|hati-hati|pelan)[.!]?$/i.test(t)) return { type: 'mood', delta: -1 };
  if (/^(?:be\s+)?(?:(?:more|lebih)\s+)?(?:aggressive|agresif|bold|berani)[.!]?$/i.test(t)) return { type: 'mood', delta: 1 };
  if (/^(calm down|reset mood|normal again|biasa saja|tenang dulu)[.!]?$/i.test(t)) return { type: 'mood', delta: 'reset' };
  if (/^(status|portfolio)\b/i.test(t)) return { type: 'status' };
  if (/^(help|\?)$/i.test(t)) return { type: 'help' };
  return { type: 'chat', text: t };
}

export const HELP = 'Commands: analyze ETHUSDT, set profile default|balance|profit|aggressive, set size 5%, set leverage 10, open long BTC [size%] [leverage], open short BTC [size%] [leverage], buy BTC, sell BTC, close BTC, close all, pause, resume, set n 3, set safety 20, set balance 100, be more cautious, be more aggressive, calm down, status.';

/** Model output is a proposal. Only a matching instruction in this owner's current message authorizes it. */
export function authorizedChatCommand(message: string, proposed: string): Command | null {
  if (/[?"`“”]|\b(?:not|never|don't|dont|jangan|bukan|if|unless|jika|kalau|misal|example|contoh|should|would|could|whether|explain|describe|what|how|why|jelaskan|arti|kenapa|bagaimana|apakah|bahas|ingat|remember|previous|kemarin|tadi)\b/i.test(message)) return null;
  message = message.replace(/\bbuka(?:\s+posisi)?\s+(long|short)\b/ig, 'open $1').replace(/\btutup\s+semua\b/ig, 'close all').replace(/\btutup\b/ig, 'close').replace(/\b(?:atur|ubah)\s+profil\b/ig, 'set profile').replace(/\b(?:atur|ubah)\s+(size|leverage)\b/ig, 'set $1');
  const command = parseCommand(proposed);
  const match = message.match(/\b(?:set\s+(?:profile\s+\w+|size\s+\d+(?:\.\d+)?%|leverage\s+\d+x?)|(?:open\s+(?:long|short)|buy|sell)\s+[a-z0-9/-]+(?:\s+\d+(?:\.\d+)?%)?(?:\s+\d+x?)?|close\s+[a-z0-9/-]+)(?=$|[\s,.!])/i);
  if (!match) return null;
  const prefix = message.slice(0, match.index).trim();
  if (prefix && !/^(?:(?:please|tolong|boss(?:\s+says)?|owner|hey|hi|okay|ok|now|langsung|sekarang|lead|market|research|strategist|risk|execution|i want you to|nice work|thanks|thank you)[\s,:!]*)+$/i.test(prefix)) return null;
  const intent = parseCommand(match[0]);
  const permitted = ['set_profile', 'set_size', 'set_leverage', 'open', 'close', 'close_all'];
  return permitted.includes(command.type) && JSON.stringify(command) === JSON.stringify(intent) ? command : null;
}
