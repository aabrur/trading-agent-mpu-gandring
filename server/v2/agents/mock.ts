import type { RoleId } from '../contracts.js';
import type { RolePhase } from './providers.js';

export interface MockAgentReplyRequest {
  role: RoleId;
  phase?: RolePhase;
  user: string;
  system?: string;
  turn?: number;
}

/**
 * Intelligent, deterministic mock agent generator for offline demo mode.
 * Operates without API keys or external network, providing natural deliberation,
 * healthy debate disagreements for UI sparring animations, valid risk approvals,
 * and conversational chat support in Indonesian and English.
 */
export async function generateMockAgentReply(req: MockAgentReplyRequest): Promise<string> {
  // Pacing delay so frontend UI smoothly animates avatar speeches and debate bubbles
  await new Promise((resolve) => setTimeout(resolve, 220 + Math.floor(Math.random() * 80)));

  const role = req.role;
  const phase = req.phase ?? 'final';
  const user = String(req.user ?? '');

  // 1. CHAT MODE (/ask or direct room chat)
  const isChat = !user.includes('promptContext') && (user.includes('Live desk snapshot') || user.length < 600);
  if (isChat) {
    const q = user.toLowerCase();
    let reply = '';

    if (role === 'lead') {
      if (q.includes('aman') || q.includes('situasi') || q.includes('kondisi') || q.includes('safe') || q.includes('status')) {
        reply = 'Semua sistem terpantau aman dan terkendali. Risk gate aktif, kill switch OFF, dan paper portfolio standby. Siap jalankan cycle kapan pun Boss instruksikan.';
      } else if (q.includes('cycle') || q.includes('trading') || q.includes('trade') || q.includes('mulai')) {
        reply = 'Auto trading dan cycle runner siap dieksekusi. Ketik "/cycle" atau jalankan analisa symbol untuk memulai putaran konsensus.';
      } else if (q.includes('halo') || q.includes('hai') || q.includes('hello') || q.includes('hi')) {
        reply = 'Halo Boss! Desk Lead ready di meja trading. Semua agen siaga memantau pasar.';
      } else {
        reply = 'Desk Lead online. Portfolio dalam pengawasan ketat dan seluruh 6 agen aktif di pos masing-masing. Ada instruksi khusus, Boss?';
      }
    } else if (role === 'risk') {
      if (q.includes('stop') || q.includes('rugi') || q.includes('loss') || q.includes('leverage')) {
        reply = 'Risk gate aktif dengan profil Owner. Batas leverage, safety net modal, dan kewajiban resting stop loss ditegakkan tanpa kompromi.';
      } else {
        reply = 'Risk Manager siaga. Setiap usulan tiket dari Execution wajib melalui evaluasi risiko sebelum diizinkan masuk pasar.';
      }
    } else if (role === 'market') {
      reply = 'Market Analyst membaca tape dan orderbook secara real-time. Struktur likuiditas dan momentum harga terus kami perbarui.';
    } else if (role === 'research') {
      reply = 'Research Analyst memfilter katalis dan sentimen makro. Berita terverifikasi bersih tanpa indikasi exploit atau delisting.';
    } else if (role === 'strategist') {
      reply = 'Trading Strategist siap. Indikator EMA9/21/50 dan level invalidasi teknikal siap memvalidasi konfirmasi setup entri.';
    } else if (role === 'execution') {
      reply = 'Execution Trader standby. Order dieksekusi dengan presisi tinggi beserta stop loss dan take profit langsung di exchange book.';
    } else {
      reply = `Agent ${role} standby dan siap bertugas.`;
    }

    return JSON.stringify({
      role,
      reply,
      stance: 'HOLD',
      confidence: 0.85,
      reasoning: reply
    });
  }

  // 2. DELIBERATION CYCLE MODE
  // Extract market summary metrics from prompt context
  let lastPrice = 75000;
  let change24h = 2.5;
  let symbol = 'BTCUSDT';
  try {
    const mPrice = user.match(/"last"\s*:\s*([\d.]+)/);
    if (mPrice) lastPrice = Number(mPrice[1]);
    const mChange = user.match(/"change24hPct"\s*:\s*([-\d.]+)/);
    if (mChange) change24h = Number(mChange[1]);
    const mSym = user.match(/"symbol"\s*:\s*"([^"]+)"/);
    if (mSym) symbol = mSym[1].toUpperCase();
  } catch {}

  const isBull = change24h >= 0;
  const directionalStance: 'LONG' | 'SHORT' = isBull ? 'LONG' : 'SHORT';
  const oppositeStance: 'LONG' | 'SHORT' = isBull ? 'SHORT' : 'LONG';
  const stopRatio = isBull ? 0.975 : 1.025;
  const tpRatio = isBull ? 1.05 : 0.95;
  const priceDecimals = lastPrice >= 100 ? 2 : lastPrice >= 1 ? 4 : 6;
  const stopPrice = Number((lastPrice * stopRatio).toFixed(priceDecimals));
  const tpPrice = Number((lastPrice * tpRatio).toFixed(priceDecimals));

  if (role === 'market') {
    return JSON.stringify({
      role: 'market',
      stance: directionalStance,
      confidence: 0.78,
      claimRefs: [`${symbol}-tape-momentum`],
      contraryRefs: [],
      reasoning: `${symbol}: Tape mengonfirmasi momentum ${directionalStance} (${change24h >= 0 ? '+' : ''}${change24h}% 24h). Orderbook menunjukkan volume penyerapan konsisten pada level support.`
    });
  }

  if (role === 'research') {
    // In observe phase, offer a cautious counter-view to spark healthy debate and UI sparring animation
    if (phase === 'observe') {
      return JSON.stringify({
        role: 'research',
        stance: oppositeStance,
        confidence: 0.62,
        claimRefs: [`${symbol}-macro-caution`],
        contraryRefs: [],
        reasoning: `Perlu waspada volatilitas jangka pendek pada ${symbol}. Rasio derivatif mendekati batas jenuh dan open interest melonjak tajam.`
      });
    }
    // In challenge/rebuttal phase, catalyst confirmation resolves consensus
    return JSON.stringify({
      role: 'research',
      stance: directionalStance,
      confidence: 0.75,
      claimRefs: [`${symbol}-catalyst-clear`],
      contraryRefs: [],
      reasoning: `Katalis berita terverifikasi positif dan tidak ada ancaman delisting atau anomali likuiditas. Mendukung bias ${directionalStance} bersama Market Analyst.`
    });
  }

  if (role === 'strategist') {
    return JSON.stringify({
      role: 'strategist',
      stance: directionalStance,
      confidence: 0.77,
      claimRefs: [`${symbol}-ema-alignment`],
      contraryRefs: [],
      proposedStop: String(stopPrice),
      proposedTp: String(tpPrice),
      invalidationPredicate: {
        kind: isBull ? 'PRICE_BELOW' : 'PRICE_ABOVE',
        level: String(stopPrice),
        description: `Breakout invalidation level at ${stopPrice}`
      },
      reasoning: `Price action bertahan di atas dynamic EMA9/21. Struktur higher highs terbentuk valid dengan batas invalidasi di ${stopPrice}.`
    });
  }

  if (role === 'execution') {
    return JSON.stringify({
      role: 'execution',
      stance: directionalStance,
      confidence: 0.82,
      proposedOrderType: 'MARKET',
      proposedStop: String(stopPrice),
      proposedTp: String(tpPrice),
      claimRefs: [`${symbol}-exec-ticket`],
      contraryRefs: [],
      reasoning: `Candidate order ticket disiapkan: MARKET order ${directionalStance} ${symbol} dengan resting stop di ${stopPrice} dan take profit di ${tpPrice}.`
    });
  }

  if (role === 'risk') {
    return JSON.stringify({
      role: 'risk',
      decision: 'APPROVE',
      stance: directionalStance,
      confidence: 0.86,
      claimRefs: [`${symbol}-risk-pass`],
      contraryRefs: [],
      reasoning: `Ukuran posisi dan toleransi leverage ${symbol} berada dalam batas aman Owner profile. Safety net modal terjaga. APPROVED.`
    });
  }

  if (role === 'lead') {
    return JSON.stringify({
      role: 'lead',
      stance: directionalStance,
      confidence: 0.84,
      proposedOrderType: 'MARKET',
      proposedStop: String(stopPrice),
      proposedTp: String(tpPrice),
      invalidationPredicate: {
        kind: isBull ? 'PRICE_BELOW' : 'PRICE_ABOVE',
        level: String(stopPrice),
        description: `Stop invalidation level at ${stopPrice}`
      },
      claimRefs: [`${symbol}-consensus`],
      contraryRefs: [],
      reasoning: `Konsensus 3 analis tercapai searah ${directionalStance}. Risk gate menyetujui tiket eksekusi. Keputusan: OPEN_${directionalStance} ${symbol}.`
    });
  }

  return JSON.stringify({
    role,
    stance: 'HOLD',
    confidence: 0.5,
    reasoning: 'Standby in demo mode.'
  });
}
