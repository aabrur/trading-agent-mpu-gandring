import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Lang = 'en' | 'id';

export const en = {
  // Brand & TopBar
  subtitle: 'six little bots, one book, plenty of arguing',
  paperMode: 'PAPER MODE',
  killSwitchOn: 'kill switch on',
  dailyLossStop: 'daily loss stop',
  dataPrefix: 'data:',
  connectWallet: 'Connect Wallet',
  setup: 'Setup',
  tutorial: 'Tutorial',
  paused: 'paused',
  liveConn: 'live',
  reconnecting: 'reconnecting',
  nightMode: '☾ night',
  dayMode: '☀ day',
  updateAvailable: 'Update available',
  upToDate: 'Up to date',

  // Ticker & Roster
  waitingPrices: 'waiting for prices...',
  rosterHint: 'Click anyone to chat or give orders',

  // CommandBar
  watchlistGroup: 'Watchlist',
  popularPerpsGroup: 'Popular Perps',
  customTokenOpt: '+ Custom token...',
  customTokenPrompt: 'Enter token symbol, for example PEPEUSDT, DOGEUSDT, AVAXUSDT:',
  startDebate: 'Start debate',
  debatingPrefix: 'Debating',
  resume: 'Resume',
  pause: 'Pause',
  closeAll: 'Close all',
  killSwitch: 'Kill switch',
  killed: 'Killed',
  commandPlaceholder: 'analyze ETHUSDT · set n 3 · set safety 150 · be more cautious · help',
  runBtn: 'Run',

  // PriceChart
  candles15m: '15m candles',
  loading: 'loading',
  deskChart: 'desk chart',
  addTokenBtn: '+ Token',
  entryLegend: 'entry',
  stopLegend: 'stop',
  tpLegend: 'take profit',
  lastPriceLegend: 'last price',
  noOpenPositionOn: 'No open position on',
  chartLinesNote: 'Entry, stop and take profit lines show up here when one opens.',

  // FightMeter
  fightMeter: 'Fight meter',
  fullBrawl: 'full brawl',
  fistsOut: 'fists out',
  heated: 'heated',
  mostlyAgree: 'mostly agree',
  quiet: 'quiet',
  consensus: 'consensus',
  disagreementSuffix: '% disagreement',
  brawl: 'brawl',
  bulls: 'Bulls',
  bears: 'Bears',
  fence: 'Fence',
  none: 'none',

  // Verdicts
  verdictsTitle: 'Verdicts',
  verdictsSub: 'Desk Lead signs, Risk gates',
  noVerdictYet: 'No verdict yet. Start a debate.',
  paperFilled: 'paper filled',
  noFill: 'no fill',

  // Portfolio & Venue Balance
  paperBook: 'Paper book',
  liveBook: 'Live book · exchange mirror',
  testnetBook: 'Testnet book · exchange mirror',
  totalBalance: 'Total balance',
  safetyNet: 'Safety net',
  moneyTrade: 'Money Trade',
  perOrder: 'Per order',
  openOrdersN: 'Open orders N',
  usedSuffix: 'used',
  atSafetyNet: 'at safety net, no new orders',
  noOpenPositions: 'No open positions.',
  closeBtn: 'close',
  equityLabel: 'Equity',
  usedMarginLabel: 'Used margin',
  closedLabel: 'Closed',
  venueBalanceTitle: 'Venue balance',
  availableUsdt: 'Available',
  equityUsdt: 'Equity',
  depositOfficial: 'Official deposit page',
  refreshBalance: 'Refresh',
  notConnectedBalance: 'Connect wallet or add API key in Setup to display live venue balance.',

  // DeskLog
  deskLog: 'Desk log',
  allFilter: 'all',
  tradesFilter: 'trades',
  noTradesYet: 'No trades yet. Completed trades and verdicts appear here.',
  noDeskActivity: 'No desk activity yet. Agent updates and trades appear here.',

  // DeskOps
  deskOpsTitle: 'Desk ops',
  deskOpsSub: 'same as npm run gb',
  entryPlaceholder: 'entry, blank for live',
  stopPlaceholder: 'stop, required',
  tpPlaceholder: 'tp',
  levPlaceholder: 'lev',
  sizeTicket: 'Size ticket',
  openWithStop: 'Open with stop',
  closeSymbolPrefix: 'Close',
  proaktifScan: 'Proaktif scan',
  lessonPlaceholder: 'add a lesson, cannot loosen a guard',
  addLessonBtn: 'Add lesson',

  // Reports & Lessons
  reportsTitle: 'Reports',
  everyMinPrefix: 'every',
  reportNow: 'report now',
  lessonsTitle: 'Lessons',
  learningOn: 'learning on',
  learningOff: 'learning off',
  proactiveScanTitle: 'Proactive scan',
  standingRulesTitle: 'Standing rules',

  // Connect Wallet Modal
  dexOnlyLabel: 'DEX Venues',
  connectBrowserWallet: 'Connect browser wallet',
  mainWalletDisplayOnly: 'Main wallet · display only',
  waitingWallet: 'Waiting for your wallet...',
  approveAgentPrefix: 'Approve a trade-only agent on',
  agentAddressLabel: 'Agent address',
  walletSafetyNote: 'Trade only, cannot withdraw. Your main wallet key and seed never leave your wallet.',
  revokeAnyTime: 'Revoke any time:',
  officialDocs: 'Official docs',
  closeModal: 'Close',

  // Update Modal
  versionModalTitle: 'Version & Update Adapter',
  currentVersionLabel: 'Current version',
  latestVersionLabel: 'Latest version',
  checkUpdateBtn: 'Check for updates',
  applyUpdateBtn: 'Update now',
  updatingBtn: 'Updating...',
  releaseNotesTitle: 'What is in this version',
  viewRepoLink: 'Open GitHub repository',

  // Interactive Tour
  tourSkip: 'Skip tutorial',
  tourNext: 'Next',
  tourBack: 'Back',
  tourDone: 'Finish',
  tourStepOf: 'of',
  tour1Title: '1. Virtual Trading Office',
  tour1Body: 'Your 6 AI agents work, walk, argue, and cartoon-fight here in real time before any trade passes the Risk gate.',
  tour2Title: '2. Agent Roster & Direct Chat',
  tour2Body: 'Click any agent in the roster to inspect their role, model provider, or send direct instructions.',
  tour3Title: '3. Command Bar & Instant Debate',
  tour3Body: 'Pick any crypto perp from Watchlist, Popular Perps, or type a custom token to start a debate, pause, or trigger the Kill Switch.',
  tour4Title: '4. Multi-Token Price Chart & TradingView',
  tour4Body: 'Switch tokens from the dropdown or + Token button, view entry/SL/TP lines, or toggle the embedded TradingView chart.',
  tour5Title: '5. Fight Meter & Verdicts',
  tour5Body: 'Watch bull vs bear disagreement heat up and read signed verdicts from Desk Lead and Risk Manager.',
  tour6Title: '6. Portfolio Book & Live Venue Balance',
  tour6Body: 'Monitor Paper or Live balance, Safety Net, Money Trade split, open positions, and official venue deposit links.',
  tour7Title: '7. Desk Ops Manual Ticket',
  tour7Body: 'Size tickets, open LONG or SHORT positions with a mandatory stop loss, close positions, or run a proactive scan.',
  tour8Title: '8. Connect Wallet for DEX',
  tour8Body: 'Connect MetaMask or Rabby for DEX venues, read live DEX balance, or open official DEX deposit pages.',
  tour9Title: '9. Left-Sidebar Setup Wizard',
  tour9Body: 'Configure AI providers, 200+ models, CEX/DEX keys, TradingView, and notification channels in a clean sidebar layout.',

  // Trakteer Popup
  trakteerTitle: 'Support Mpu Gandring with Cendol!',
  trakteerBody: 'Enjoying the 6-agent trading desk? Treat the creator to a glass of Cendol on Trakteer to keep updates and new adapters coming.',
  trakteerDismiss: 'Maybe later',

  // Footer
  footerNote: 'Paper trading simulation for learning. Not financial advice. No profit promised. Trading Agent Mpu Gandring, MIT license.'
} as const;

export type TranslationKey = keyof typeof en;

export const id: Record<TranslationKey, string> = {
  // Brand & TopBar
  subtitle: 'enam bot kecil, satu buku kas, penuh debat seru',
  paperMode: 'MODE PAPER',
  killSwitchOn: 'kill switch aktif',
  dailyLossStop: 'batas rugi harian kena',
  dataPrefix: 'data:',
  connectWallet: 'Connect Wallet',
  setup: 'Pengaturan',
  tutorial: 'Tutorial',
  paused: 'dijeda',
  liveConn: 'terhubung',
  reconnecting: 'menyambung ulang',
  nightMode: '☾ malam',
  dayMode: '☀ siang',
  updateAvailable: 'Update tersedia',
  upToDate: 'Versi terbaru',

  // Ticker & Roster
  waitingPrices: 'menunggu harga pasar...',
  rosterHint: 'Klik agen mana saja untuk chat atau beri perintah',

  // CommandBar
  watchlistGroup: 'Watchlist',
  popularPerpsGroup: 'Perp Populer',
  customTokenOpt: '+ Token kustom...',
  customTokenPrompt: 'Masukkan simbol token, contohnya PEPEUSDT, DOGEUSDT, AVAXUSDT:',
  startDebate: 'Mulai debat',
  debatingPrefix: 'Debat',
  resume: 'Lanjutkan',
  pause: 'Jeda',
  closeAll: 'Tutup semua',
  killSwitch: 'Kill switch',
  killed: 'Dihentikan',
  commandPlaceholder: 'analyze ETHUSDT · set n 3 · set safety 150 · lebih hati-hati · help',
  runBtn: 'Jalankan',

  // PriceChart
  candles15m: 'candle 15m',
  loading: 'memuat',
  deskChart: 'chart meja',
  addTokenBtn: '+ Token',
  entryLegend: 'entry',
  stopLegend: 'stop',
  tpLegend: 'take profit',
  lastPriceLegend: 'harga terakhir',
  noOpenPositionOn: 'Belum ada posisi terbuka di',
  chartLinesNote: 'Garis entry, stop, dan take profit tampil otomatis saat posisi dibuka.',

  // FightMeter
  fightMeter: 'Meteran debat',
  fullBrawl: 'ribut besar',
  fistsOut: 'adu jotos',
  heated: 'memanas',
  mostlyAgree: 'hampir sepakat',
  quiet: 'tenang',
  consensus: 'sepakat',
  disagreementSuffix: '% beda pendapat',
  brawl: 'ribut',
  bulls: 'Bull',
  bears: 'Bear',
  fence: 'Netral',
  none: 'kosong',

  // Verdicts
  verdictsTitle: 'Keputusan',
  verdictsSub: 'Desk Lead tanda tangan, Risk menyaring',
  noVerdictYet: 'Belum ada keputusan. Mulai debat dulu.',
  paperFilled: 'paper tereksekusi',
  noFill: 'tidak dieksekusi',

  // Portfolio & Venue Balance
  paperBook: 'Buku Paper',
  liveBook: 'Buku Live · cerminan bursa',
  testnetBook: 'Buku Testnet · cerminan bursa',
  totalBalance: 'Total saldo',
  safetyNet: 'Dana aman',
  moneyTrade: 'Modal Trading',
  perOrder: 'Per order',
  openOrdersN: 'Jumlah order N',
  usedSuffix: 'terpakai',
  atSafetyNet: 'menyentuh dana aman, order baru ditahan',
  noOpenPositions: 'Belum ada posisi terbuka.',
  closeBtn: 'tutup',
  equityLabel: 'Ekuitas',
  usedMarginLabel: 'Margin terpakai',
  closedLabel: 'Ditutup',
  venueBalanceTitle: 'Saldo bursa',
  availableUsdt: 'Tersedia',
  equityUsdt: 'Ekuitas',
  depositOfficial: 'Halaman deposit resmi',
  refreshBalance: 'Muat ulang',
  notConnectedBalance: 'Hubungkan wallet atau isi API key di Pengaturan untuk melihat saldo asli.',

  // DeskLog
  deskLog: 'Log aktivitas',
  allFilter: 'semua',
  tradesFilter: 'transaksi',
  noTradesYet: 'Belum ada transaksi. Order selesai dan keputusan tampil di sini.',
  noDeskActivity: 'Belum ada aktivitas meja. Update agen dan transaksi tampil di sini.',

  // DeskOps
  deskOpsTitle: 'Operasi meja',
  deskOpsSub: 'setara npm run gb',
  entryPlaceholder: 'entry, kosongkan untuk harga pasar',
  stopPlaceholder: 'stop, wajib diisi',
  tpPlaceholder: 'tp',
  levPlaceholder: 'lev',
  sizeTicket: 'Hitung ukuran',
  openWithStop: 'Buka dengan stop',
  closeSymbolPrefix: 'Tutup',
  proaktifScan: 'Scan proaktif',
  lessonPlaceholder: 'tambah pelajaran baru, tidak boleh melonggarkan guard',
  addLessonBtn: 'Simpan pelajaran',

  // Reports & Lessons
  reportsTitle: 'Laporan',
  everyMinPrefix: 'setiap',
  reportNow: 'buat laporan',
  lessonsTitle: 'Pelajaran',
  learningOn: 'belajar aktif',
  learningOff: 'belajar nonaktif',
  proactiveScanTitle: 'Scan proaktif',
  standingRulesTitle: 'Aturan tetap',

  // Connect Wallet Modal
  dexOnlyLabel: 'Bursa DEX',
  connectBrowserWallet: 'Hubungkan wallet browser',
  mainWalletDisplayOnly: 'Wallet utama · hanya tampilan',
  waitingWallet: 'Menunggu konfirmasi wallet...',
  approveAgentPrefix: 'Setujui agen khusus-trading di',
  agentAddressLabel: 'Alamat agen',
  walletSafetyNote: 'Hanya bisa trading, tidak bisa withdraw. Private key dan seed wallet utama tidak pernah keluar dari wallet kamu.',
  revokeAnyTime: 'Cabut akses kapan saja:',
  officialDocs: 'Dokumentasi resmi',
  closeModal: 'Tutup',

  // Update Modal
  versionModalTitle: 'Versi & Adapter Update',
  currentVersionLabel: 'Versi saat ini',
  latestVersionLabel: 'Versi terbaru',
  checkUpdateBtn: 'Cek pembaruan',
  applyUpdateBtn: 'Update sekarang',
  updatingBtn: 'Memperbarui...',
  releaseNotesTitle: 'Pembaruan di versi ini',
  viewRepoLink: 'Buka repositori GitHub',

  // Interactive Tour
  tourSkip: 'Lewati tutorial',
  tourNext: 'Lanjut',
  tourBack: 'Kembali',
  tourDone: 'Selesai',
  tourStepOf: 'dari',
  tour1Title: '1. Kantor Virtual Agen Trading',
  tour1Body: 'Keenam agen AI kamu bekerja, berjalan, berdebat, dan adu jotos kartun secara real time sebelum order lolos gerbang Risk.',
  tour2Title: '2. Daftar Agen & Chat Langsung',
  tour2Body: 'Klik agen mana saja di baris ini untuk melihat peran, provider AI, atau memberi instruksi langsung.',
  tour3Title: '3. Bar Perintah & Debat Instan',
  tour3Body: 'Pilih token dari Watchlist, Perp Populer, atau ketik token kustom untuk mulai debat, jeda, atau aktifkan Kill Switch.',
  tour4Title: '4. Chart Harga Multi-Token & TradingView',
  tour4Body: 'Ganti token lewat dropdown atau tombol + Token, pantau garis entry/SL/TP, atau beralih ke chart TradingView.',
  tour5Title: '5. Meteran Debat & Keputusan',
  tour5Body: 'Pantau panasnya debat kubu Bull vs Bear serta baca alasan keputusan yang ditandatangani Desk Lead dan Risk.',
  tour6Title: '6. Buku Portofolio & Saldo Bursa',
  tour6Body: 'Pantau saldo Paper atau Live, Dana Aman, pembagian Modal Trading, posisi terbuka, dan link deposit resmi.',
  tour7Title: '7. Operasi Meja Manual',
  tour7Body: 'Hitung ukuran order, buka posisi LONG atau SHORT dengan stop loss wajib, tutup posisi, atau jalankan scan proaktif.',
  tour8Title: '8. Connect Wallet Khusus DEX',
  tour8Body: 'Hubungkan MetaMask atau Rabby ke DEX, baca saldo DEX langsung, atau buka halaman deposit resmi DEX.',
  tour9Title: '9. Menu Pengaturan Sidebar Kiri',
  tour9Body: 'Atur provider AI, 200+ model, API key CEX/DEX, TradingView, dan channel notifikasi lewat navigasi kiri yang rapi.',

  // Trakteer Popup
  trakteerTitle: 'Trakteer Cendol untuk Mpu Gandring!',
  trakteerBody: 'Suka dengan meja trading 6 agen ini? Trakteer pembuatnya segelas Cendol supaya update fitur dan adapter baru terus jalan.',
  trakteerDismiss: 'Nanti dulu',

  // Footer
  footerNote: 'Simulasi paper trading untuk belajar. Bukan saran keuangan. Tidak menjanjikan keuntungan. Trading Agent Mpu Gandring, lisensi MIT.'
};

export const DICTIONARIES: Record<Lang, Record<TranslationKey, string>> = { en, id };

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  toggleLang: () => void;
  t: (k: TranslationKey) => string;
}

const Context = createContext<I18nCtx>({
  lang: 'en',
  setLang: () => {},
  toggleLang: () => {},
  t: (k) => en[k]
});

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem('mg-lang');
    if (saved === 'en' || saved === 'id') return saved;
  } catch { /* ignore */ }
  return 'en';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  useEffect(() => {
    try { localStorage.setItem('mg-lang', lang); } catch { /* ignore */ }
    document.documentElement.lang = lang;
  }, [lang]);
  const setLang = (l: Lang) => setLangState(l);
  const toggleLang = () => setLangState((prev) => (prev === 'en' ? 'id' : 'en'));
  const t = (k: TranslationKey): string => DICTIONARIES[lang][k] ?? en[k];
  return <Context.Provider value={{ lang, setLang, toggleLang, t }}>{children}</Context.Provider>;
}

export function useI18n() {
  return useContext(Context);
}
