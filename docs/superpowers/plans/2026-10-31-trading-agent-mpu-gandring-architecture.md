# Trading Agent Mpu Gandring: Rancangan Arsitektur Pengganti

Tanggal: 31 Oktober 2026, Asia/Jakarta. Status: **PROPOSED FOR OWNER REVIEW**.

**fairly certain, based on the validated source graph.** Pengganti sebaiknya berupa modular monolith TypeScript dengan satu authority lokal untuk konfigurasi, intent eksekusi, dan accounting. Pertahankan frontend React/Vite; ganti composition root dan decision runtime. Browser dijalankan sebagai child worker yang terisolasi dari signer. Grok menjadi connector asynchronous, bukan executor kedua.

Dasar: [validation report](2026-10-31-trading-agent-mpu-gandring-validation.md), seluruh sembilan lampiran yang di-hash di sana, dan HEAD lokal a725218a304bc32f5347ed150da9755eb8df7783. Sumber lampiran tetap di folder Downloads yang dicatat report; implementer harus menerima sumber tersebut beserta tiga dokumen ini. Lampiran tidak menjadi instruksi operasional aktif.

## 1. Keputusan arsitektur

| ID | Rancangan yang dipilih | Alasan dan batas |
|---|---|---|
| D01 | Modular monolith, bukan microservices | Satu laptop/host, transaksi account-local, debugging sederhana. Tidak ada Redis, Kafka, Kubernetes, atau bot/framework trading baru |
| D02 | Entry runtime baru dan compatibility facade satu arah | Tidak meng-import server/app.ts atau Desk lama. Facade menerjemahkan DTO/events, tidak memanggil keputusan lama |
| D03 | Bybit V5 linear sebagai reference market | Native execution venue tetap wajib membaca quote, rules, positions, fills, dan protection sendiri |
| D04 | Satu embedded SQL ledger lokal | Settings, accepted events, intents, inbox/outbox, dan projections berbagi transaksi. Financial ledger bukan file chat atau book bot |
| D05 | Enam logical roles, routing dibekukan per task | Satu accepted completion per cycle/role/phase. Jev terpisah dan tidak mempunyai vote atau order authority |
| D06 | Bot authentication berbeda dari Owner authentication | Callback results-only dapat aktif lebih awal. Tidak ada remote Owner mutation tanpa bukti manusia independen |
| D07 | Account lifecycle registry, bukan satu current executor | Account aktif memilih intent baru. Account lama tetap dipantau sepanjang ada exposure/pending settlement |
| D08 | Prepare lalu activate settings secara lokal | Remote effects tidak dimasukkan ke transaksi atomik lokal. Saved/local-active/remote-ack ditampilkan terpisah |
| D09 | ACCEPTED: pertahankan Kill lokal; STOP Grok hanya halt entry dan cancel order nonprotektif | Keputusan eksplisit Boss di chat, 31 Oktober 2026. Kill lokal tetap cancel dan flatten posisi. STOP Grok menghentikan entry, menonaktifkan Auto, dan membatalkan order nonprotektif; posisi serta resting SL/TP tetap dipertahankan. Keduanya memakai durable halt latch yang sama |
| D10 | Node >=20 dipertahankan | Node lokal 24.15.0 bukan alasan menaikkan floor diam-diam. Dependency dan artifact diuji di Node 20/22/24 sebelum diterima |
| D11 | N tetap mengikuti kontrak aktif saat migrasi | Tidak mengubah nilai tersimpan atau diam-diam membuka/mengurangi batas 1..4. Perluasan schema N adalah keputusan Owner terpisah dan harus konsisten di UI, CLI, setup, sizing, profile, dan gateway |
| D12 | PAPER/backtest tetap ada sebagai sandbox yang diberi label | Tidak ada sample market atau mock model fallback pada real-decision graph. PAPER memakai reference Bybit bila tersedia; test replay/synthetic preview tidak berubah menjadi fakta exchange |

**certain, berdasarkan pilihan eksplisit Boss di chat pada 31 Oktober 2026:** D09 telah disetujui untuk rancangan. D11 masih membutuhkan review. Persetujuan D09 menetapkan perilaku target; ini bukan instruksi implementasi atau aktivasi runtime.

## 2. Diagram komponen dan jalur kritis

~~~mermaid
flowchart TD
  UI[Existing React Office] --> API[Local HTTP and WebSocket facade]
  CLI[Existing mpu CLI and channels] --> API
  API --> SET[Versioned Owner settings and command authorization]
  BY[Bybit linear REST and WS] --> HUB[Market hub and deterministic indicators]
  WEB[Public sources and optional enrichment APIs] --> RES[Research worker and tool host]
  HUB --> EV[Immutable evidence snapshots]
  RES --> EV
  EV --> ROLES[Six logical roles and optional Jev]
  ROLES --> DEC[Debate, Owner risk and thesis revalidation]
  DEC --> GW[Account-scoped execution gateway]
  SET --> GW
  GW --> VEN[Native venue adapters and delegated signer]
  VEN --> MON[Continuous reconciliation and protection]
  MON --> GW
  GW --> DB[(Local canonical SQL ledger)]
  SET --> DB
  ROLES --> DB
  DB --> API
  ROLES --> OUT[Durable bridge outbox]
  OUT --> GROK[Grok webhook routine and group]
  GROK --> IN[Separate scoped HTTPS callback ingress]
  IN --> ROLES
  DB --> OUT
  HALT[Local halt, Kill and verified exit intents] --> GW
~~~

CLOSE/protection/reconciliation tidak menunggu browser, Jev, remote callback, atau OPEN debate. Pengiriman notification terjadi setelah durable state commit. Bot result tidak memanggil adapter order secara langsung.

## 3. Boundary dan kepemilikan file

Semua path berikut adalah target implementasi, belum dibuat. Folder fitur boleh berisi beberapa file ketika kepemilikannya berbeda; tidak perlu membuat satu file untuk setiap kata dalam diagram.

| Target | Tanggung jawab |
|---|---|
| server/v2/runtime.ts, app.ts | Composition root, start/stop, local listener, dependency wiring |
| server/v2/contracts.ts | Common IDs, sourced evidence, account scope, events dan public DTO roots |
| server/v2/store/{database,schema,events}.ts | Local SQL connection, migrations, append/transaction/projection; tanpa keputusan trading |
| server/v2/settings/{schema,service,secrets}.ts | Existing fields, import, validate, prepare/activate, secret references |
| server/v2/accounts/{registry,authority}.ts | Stable account identity, position ownership, writer epoch, handover |
| server/v2/market/{bybit,candles,orderbook}.ts | REST/WS ingestion dan finality, reconnect/gap repair |
| server/v2/market/{indicators,intelligence,instruments}.ts | Pure math, units dan explicit reference-to-native instrument mapping |
| server/v2/research/{host,browser-worker,provenance}.ts | Actual public browsing/fetching, URL policy, dated findings dan tool traces |
| server/v2/agents/{providers,local,roles,runner,jev}.ts | Provider transport, local CLI capability, role/tool protocol, visible Jev review |
| server/v2/decision/{cycle,revalidate,exits}.ts | Debate state, actual Risk judgment, thesis invalidation, independent exits |
| server/v2/execution/{gateway,protection,reconcile,decimal}.ts | Single intent writer, native lifecycle, protection readback, exact tick/quantity math |
| server/v2/execution/adapters/*.ts | Delapan venue yang saat ini diekspos, transport/signing native tanpa strategi |
| server/v2/wallet.ts | Fresh delegated-agent connect, signed approval, server-side recovery |
| server/v2/api/{state,setup,operations,chat,history,research}.ts | Existing HTTP compatibility, validation, authorization, serialization |
| server/v2/office.ts | Existing WS events dan additive candle/config/integration status |
| server/v2/reports.ts, channels.ts | Reports/alerts/projections dan verified Owner channel commands |
| server/v2/learning.ts, sandbox/{paper,backtest}.ts | New account-scoped advice; isolated simulation yang tidak mendapat signer |
| server/v2/connectors/grok/{protocol,auth,bridge,commands}.ts | Typed bridge, verified paired-machine origin, inbox/outbox, role routing, settings sync |
| cli/v2/{main,client,setup,doctor}.ts | Port existing CLI semantics ke runtime baru; no legacy decision imports |
| tsconfig.rebirth.json | Production include/entry terkontrol; legacy keluar dari emitted artifact |
| scripts/check-runtime-boundary.mjs | Static/import/packed artifact closure audit dengan existing TypeScript compiler API |

Frontend yang dipertahankan: web/src/App.tsx, useDesk.ts, officeApi.ts, types.ts, sceneDirector.ts, seluruh 29 komponen TSX yang ditemukan, i18n, styles/tokens.css, dan asset referensi. Perubahan frontend hanya wiring yang diperlukan serta status/error yang jujur. Tidak ada route, menu, karakter, atau tema yang dihapus.

Audited low-level signing, redaction, logging, dan precision knowledge boleh di-port. Jangan menulis ulang kriptografi SDK yang sudah benar. Shared infrastructure harus melalui allowlist transitive import, bukan barrel yang membawa Desk, market fallback, atau provider mock. Old guard/adapter code hanya menjadi oracle tes selama migrasi, bukan dependency runtime baru.

## 4. Kontrak data dan numeric truth

~~~ts
type RoleId = 'lead' | 'market' | 'research' | 'strategist' | 'risk' | 'execution';
type TradingMode = 'PAPER' | 'TESTNET' | 'LIVE';
type Venue = 'bybit' | 'binance' | 'okx' | 'hyperliquid' | 'aster' | 'dydx' | 'paradex' | 'orderly';
type TF = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
type DecimalString = string;
type Certainty = 'VERIFIED' | 'REPORTED' | 'INFERRED';
type Availability = 'AVAILABLE' | 'UNAVAILABLE';
type Freshness = 'CURRENT' | 'STALE' | 'UNKNOWN';
interface Evidence<T> {
  id: string; value: T | null;
  certainty: Certainty | null; availability: Availability; freshness: Freshness;
  source: string; sourceAt: number | null; observedAt: number;
  publishedAt: number | null; eventAt: number | null;
  unit: string | null; reason: string | null;
}
interface AccountScope {
  accountRef: string; venue: Venue; network: 'testnet' | 'mainnet';
  mode: TradingMode; subaccountRef: string | null;
}
interface Candle {
  symbol: string; tf: TF; startAt: number; endAt: number;
  open: DecimalString; high: DecimalString; low: DecimalString; close: DecimalString;
  volume: DecimalString; volumeUnit: string;
  confirmed: boolean; sourceAt: number; observedAt: number;
}
interface MarketFrame {
  evidenceId: string; revision: number; symbol: string; venue: 'bybit'; category: 'linear';
  asOf: number; last: Evidence<DecimalString>; bid: Evidence<DecimalString>; ask: Evidence<DecimalString>;
  closed: Record<TF, Candle[]>; current: Partial<Record<TF, Candle>>;
  tradesEvidenceId: string | null; bookEvidenceId: string | null;
  funding: Evidence<DecimalString>; openInterest: Evidence<DecimalString>;
}
~~~

- DecimalString harus divalidasi finite decimal, sign, scale, dan units di boundary. Native quantity/price/notional/protection memakai decimal strings dan scaled BigInt untuk rounding; Number hanya untuk derivasi indikator dengan validasi range dan tampilan DTO. Tidak menambah decimal library bila quantize dengan BigInt sudah mencukupi.
- Account identity berasal dari native account/subaccount readback atau delegated user identity yang diverifikasi. Opaque accountRef disimpan lokal. Pergantian API key pada akun yang sama tidak membuat akun keuangan baru; key dari akun lain tidak boleh memakai scope lama.
- Position key mencakup accountRef, native instrument, position mode/index, side, dan native position ID bila tersedia. Satu symbol dapat mempunyai LONG dan SHORT pada hedge mode.
- Reference instrument dan execution instrument mempunyai mapping base/quote/settlement/contract multiplier, termasuk 1000-token contracts. Bila tidak dapat dipetakan, status execution unavailable; tidak memakai heuristic string replacement atau Bybit price sebagai fill venue lain.
- UNAVAILABLE bukan nol. PublishedAt bukan eventAt. STALE adalah freshness, PENDING adalah status pekerjaan/delivery. Compatibility DTO boleh memproyeksikan status lama, tetapi sumber asli tidak hilang.
- SourceAsOf adalah vector dari timestamp tiap feed, bukan janji semua stream terjadi serentak. Snapshot menyimpan revision, watermark/cursors dan timestamp setiap unsur agar debate dapat direplay.

## 5. Persistence dan transaksi

**Pilihan usulan:** @libsql/client 0.18.0 untuk file SQLite lokal melalui node entry, tanpa syncUrl/authToken/cloud replication. Versi itu ditemukan di registry; package resmi menyediakan local-file dan transaction usage. **needs verification** untuk install/prebuilt dan durability pada kombinasi Node/Windows yang didukung, dilakukan T02 sebelum fitur bergantung padanya. [Primary package source](https://raw.githubusercontent.com/tursodatabase/libsql-client-ts/main/packages/libsql-client/package.json), [official local/transaction examples](https://github.com/tursodatabase/libsql-client-ts/tree/main/packages/libsql-client).

Alasan tidak memakai node:sqlite langsung: floor Node >=20 harus dipertahankan. Library tambahan untuk transaksi durable ini mempunyai kebutuhan nyata. Tidak perlu ORM. Path baru berada di .mpu-gandring/rebirth/runtime.sqlite, yang termasuk folder private yang sudah di-ignore. Gunakan filesystem lokal, foreign_keys ON, WAL dan synchronous FULL jika driver membuktikan support; unsupported durability adalah acceptance failure, bukan silent downgrade.

| Table/record | Constraints utama |
|---|---|
| schema_migrations | version primary key, ordered migration, rollback backup manifest |
| accounts | accountRef PK; unique venue/network/native identity hash/subaccount/mode |
| config_versions + active_config | Immutable validated settings snapshots; satu active pointer; optimistic expectedActiveVersion |
| config_applies | requestId unique; PREPARING/ACTIVE/FAILED; subsystem results; candidate versus active version |
| events | seq PK, eventId unique, scope/causation/correlation/schema version, redacted payload, append-only |
| cycles + role_tasks | unique cycleId/role/phase/taskAttempt; satu accepted current attempt; evidence/config binding |
| execution_intents | unique accountRef/intentId dan accountRef/clientOrderId; order/protection state terpisah |
| fills + financial_records | Native record ID/accountRef unique; fee/funding/PnL nullable dengan provenance |
| managed_positions | Native position identity unique; lifecycle account tetap terikat |
| execution_authority | accountRef PK, holder dan monotonically increasing epoch |
| bridge_inbox + bridge_outbox | peerId/eventId unique; raw body digest, receipt, attempt, result/expiry terpisah |
| bridge_nonces | peer/keyId/nonce unique sampai security expiry |
| conversations + lessons | Account scope, request/cancellation/parent context; imported legacy history read-only |

Append event dan update projection terkait dilakukan dalam satu transaksi pendek. Tidak ada network await di dalam transaksi database. Semua callback/event processing memakai at-least-once delivery dengan idempotent apply. Tidak mengklaim exactly-once network exchange execution.

Simpan accepted input snapshot dan tool evidence yang dipakai keputusan. Tick/orderbook raw dibuffer bounded; tidak perlu menyimpan setiap tick selamanya. Bounded logs tidak boleh menjatuhkan intent/fill/protection events. Disk full/corrupt menghalangi entry yang tidak dapat dijournal; fungsi halt tetap dapat mengunci in-memory segera dan menunjukkan bahwa restart persistence belum terbukti.

## 6. Settings hot-apply dan account lifecycle

1. Parse existing UI/CLI fields dengan satu schema dan expectedActiveVersion. Secret values masuk hidden/masked local flow, tidak disimpan pada event atau response.
2. Import .env settings satu kali sebagai candidate; snapshot lengkap nilai Owner sebelum/after. Sesudah migrasi, SQL settings adalah authority. .env secrets tetap dilayani mekanisme lokal; nonsecret env compatibility export bukan writer kedua. External file edit dideteksi sebagai draft yang perlu apply eksplisit.
3. Prepare model client, Bybit subscription set, timers, browser source registry, venue permissions, dan account contexts. Tidak mengirim order. Key presence tidak dianggap connectivity.
4. Persist PREPARING dan candidate version. Jika prepare gagal, simpan failure dan tetap gunakan active lama; dispose candidate resources.
5. Di serialized activation barrier, commit active pointer lalu publish immutable settings/resource handle yang sudah siap. New intent dispatch tertahan selama barrier pendek. Existing account monitors tetap berjalan. Crash pada commit/publish dipulihkan dari active pointer sebelum dispatch baru.
6. Kembalikan applied hanya setelah snapshot lokal sudah dipublish. Identitas runtime menyertakan savedVersion, activeVersion, appliedAt, applyStatus, reason, dan subsystem results.
7. Kirim remote projection lewat outbox sesudah local commit. lastAcknowledgedConfigVersion terpisah; callback lama tidak menurunkan active version.

Settings role model berlaku pada task baru. Trading-critical version yang berubah saat debate membuat intent lama perlu re-evaluate dengan nilai baru atau dibatalkan, bukan dieksekusi dengan campuran policy. UI-only theme change tidak memaksa debate ulang. Venue switch mengarahkan entry baru, mempertahankan lifecycle akun lama; switching ke PAPER tidak menghapus atau menyatakan flat posisi real.

Preserve exact existing profile fields: dailyLossLimitPct, maxLossPerTradePct, minEntryConfidencePct, maxLeverage, orderSizePct, defaultStopPct, minStopPct, takeProfitPct, takeProfitR, maxOrderUsdt, minOrderUsdt, safetyNet, maxPositions. Preserve network profiles, preset/manual distinction, watchlist/Auto/schedule, providers/reasoning, Jev, optional sources, channels, local login/research tools, and wallet controls. Nilai preset tidak boleh mengganti capital fields account-specific tanpa explicit edit.

## 7. Market dan indikator

- REST bootstrap category=linear; interval 1/5/15/60/240/D. Core strategy memerlukan lima TF 1m/5m/1h/4h/1d; 15m tetap tersedia karena UI aktual mengeksposnya. Tidak ada secondary market fallback.
- Subscribe ticker, publicTrade, orderbook.50, dan kline untuk desired symbols ditambah symbols dari pending orders/open positions. Watchlist removal tidak mematikan position monitoring.
- Register WS dan buffer incoming events selama REST bootstrap; merge/dedupe per candle/trade/revision. REST results diurut chronological. Candle current dan confirmed dipisahkan. Gap di-backfill; current candle tidak dijumlahkan lagi sebagai closed volume.
- Process orderbook snapshot/reset/delta sesuai spesifikasi resmi; jangan memaksakan seq+1 yang tidak dijanjikan exchange. Sequence regression, reconnect dan invalid local book memerlukan new snapshot. Ticker delta di-merge dengan last complete state, bukan menghapus field yang tidak disertakan.
- Semua clocks mencatat sourceAt, observedAt, age dan skew. Indicator warmup yang tidak cukup menghasilkan null dengan reason, bukan zero atau trend fiktif.

**certain, based on official documentation:** interval tersebut tersedia, kline confirm menandai candle selesai, dan orderbook snapshot baru harus mengganti local book. [REST kline](https://bybit-exchange.github.io/docs/v5/market/kline), [WS kline](https://bybit-exchange.github.io/docs/v5/websocket/public/kline), [WS orderbook](https://bybit-exchange.github.io/docs/v5/websocket/public/orderbook).

Konvensi indikator v1: SMA 20; EMA 9/21/50/200 dengan SMA seed dan alpha=2/(n+1); Wilder RSI/ATR 14; MACD 12/26/9; Bollinger 20 dengan population SD dan 2 SD; UTC-session VWAP dari trades bila tersedia, atau candle approximation yang dilabel INFERRED; confirmed swing pivot dengan dua bar kiri dan kanan. Publish definisi, warmup, formula version dan source bars. Divergence/HH-HL/BOS/CHoCH memakai pivot yang sudah confirmed, tanpa melihat bar masa depan. Volume relatif memakai prior comparable window yang disebutkan, tidak memasukkan bar yang sedang dinilai ke baseline.

Funding, OI, liquidation, book imbalance dan taker flow membawa unit/window/coverage. Field yang tidak didukung channel tetap unavailable. Tidak menamai sebuah wallet “whale” hanya dari volume candle. Derived features adalah evidence untuk Risk/Lead; bukan tambahan global entry gate.

## 8. Research dan agent tools

ResearchHost mengeksekusi search_web, browse_url, read_official_announcement, search_news, get_market_snapshot, get_orderbook, get_candles, get_funding_oi, get_portfolio, get_evidence, write_debate_note. Existing research MCP dan optional provider fields dipetakan ke host ini, bukan membangun broker paralel yang sama fungsinya.

- Native fetch cukup untuk JSON/public endpoints. Gunakan existing playwright-core untuk page navigation/click/extraction yang memerlukan DOM. Pindahkan dependency ke runtime jika worker membutuhkannya, tanpa dependency browser library kedua. Browser executable harus dikonfigurasi/dideteksi dan diuji; tidak mengasumsikan core membundel browser.
- Public research memakai isolated browser context/workdir, tanpa wallet sessions, .env, signer, atau shared Owner profile. URL policy memblokir file/data/javascript URLs, credentials-in-URL, localhost/private/link-local/metadata targets; validasi DNS/redirect dan page subrequests. Fixture HTTP lokal hanya di test policy.
- Untrusted page text hanya menjadi data. Tool args berupa schema, bukan shell command/eval. Query/URL disanitasi, credentials tidak diteruskan. Robots/access restrictions/captcha failures menjadi unavailable dengan alternatif sumber publik.
- Tool trace menyimpan actual operation, resolved URL, event/publish/observation time, excerpt hash, result/error dan measured duration. Search hit belum sama dengan article verified. Repetition tidak menaikkan certainty.
- Raw execution secrets tidak masuk model prompt atau child environment. Local CLI dijalankan sebagai inference transport dengan host tools terbatas. Jika CLI tidak bisa membatasi arbitrary shell/file access, jangan menyebut same-user process sebagai sandbox: tandai UNSANDBOXED, minta isolated OS execution context yang terbukti sebelum autonomous use. Chat capability tidak membuktikan keamanan autonomous execution.
- Tidak mengarang universal provider tool API. Adapter remote memakai API resmi provider; adapter CLI menerjemahkan structured host-tool requests atau existing verified MCP contract. Login/model/effort discovery dan cancellation tetap dipertahankan. Kegagalan tidak memanggil mock model.

## 9. Six-role debate, routing dan exits

Alias tetap: Head of Trading=lead, Technical Market=market, Macro Research=research, Trading Systems=strategist, Head of Risk=risk, Execution Trader=execution. Rendering memakai identitas karakter existing UI.

Task identity: cycleId, role, phase, taskAttempt, evidenceId, configVersion, route dan deadline. Phase memungkinkan observation/challenge/final dari role yang sama; mereka bukan tiga vote. Untuk setiap phase hanya current assigned attempt yang diterima. Remote mirror memiliki originEventId dan tidak menjadi additional completion. Late result dicatat sebagai evidence terlambat dan tidak menghidupkan intent lama.

Confidence membawa value dan scale asli: probability_0_1, ordinal_1_5, atau score_0_100. Confidence 1..5 pada Grok TM bukan probabilitas dan tidak boleh dikalikan menjadi persentase untuk melewati minEntryConfidencePct. Entry confidence mengikuti reported Lead probability 0..1 bila policy Owner mengharuskannya; missing atau beda scale tetap explicit unavailable. Score TS tetap skor strategi, bukan fabricated probability atau historical win rate.

Urutan: market/research/strategy observations, structured challenge, Risk dan Execution feasibility, Lead intent. Role yang gagal berstatus unavailable; tidak diisi template seolah sudah berbicara. Remote role fallback ke LOCAL hanya jika Owner sudah memilih fallback policy, dengan attempt lama difence sebelum dispatch baru. Bila final authoritative decision belum lengkap, tidak ada OPEN approval yang dibuat-buat. Ketiadaan optional research/Jev sendiri bukan market veto.

Grok 2-of-3 hanya aktif ketika connectedConsensus dipilih Owner. Default migrasi mengikuti policy aktif, tanpa menambah voting gate. Risk dapat reject berdasarkan Owner policy atau opposing facts yang jelas; no hidden confidence floor, leverage haircut, slot reserve, delay, atau forced five-TF alignment.

Revalidation membandingkan thesis invalidation dan facts terbaru, bukan persetujuan model. Thesis rule harus berbentuk structural/timestamped predicate yang dapat dire-evaluate atau secara eksplisit unresolved untuk direview ulang. Tidak ada aiApproved bypass. Selama execution lock tertahan, market tetap update; lakukan re-read setelah lock didapat sebelum submit.

Exit triggers yang dipertahankan: INVALIDATION_HIT, MOMENTUM_REVERSAL, SENTIMENT_REVERSAL, OPPOSING_NEWS, WHALE_EXIT, EXCHANGE_STOP_OR_TP, EARLY_TAKE_PROFIT, DATA_ANOMALY_OR_CONFLICT, GUARD_THREATENED. Satu applicable verified trigger cukup bagi autonomous CLOSE atas posisi yang memang dikelola. Tidak ada duration-only close. Explicit Owner close langsung mengikuti authorization dan native position reality, tidak menunggu entry confidence/consensus/free slots. Protection failure memakai emergency response guard, terpisah dari strategy debate.

## 10. Execution dan protection lifecycle

State order: CREATED -> JOURNALED -> SUBMITTING -> ACCEPTED/UNKNOWN -> PARTIAL/FILLED/CANCELLED/REJECTED. Protection state terpisah: NOT_APPLICABLE/PENDING/VERIFIED/UNVERIFIED/MISSING. Acknowledged order tidak sama dengan filled order.

1. Validate trusted intent, accountRef/epoch, Owner config version, stop requirements, venue instrument/position identity, and native limits.
2. Untuk OPEN, check daily loss, safety net, kill, Owner N, dan available venue balance. Occupancy menghitung satu posisi/pending intent tanpa double count partial fill. Bukan reserve slot strategi baru.
3. Acquire account-scoped execution lock; refresh quote/position/market thesis, re-evaluate risk parameter versi yang berlaku. Re-check halt tepat sebelum network write.
4. Persist unique intent dan stable clientOrderId sebelum submit. Account switch tidak mengubah account target intent yang sudah dikirim.
5. Submit sekali. Timeout menghasilkan UNKNOWN dan native lookup dengan clientOrderId/orderId. Jangan membuat ID baru lalu resend. Venue yang tidak mendukung reliable lookup tetap menahan ambiguous exposure sebagai unresolved.
6. Partial fill segera diproteksi untuk actual current exposure. Readback symbol/side/position index/quantity, reduce-only atau native position-bound stop, trigger basis, dan active status. Intended stop value bukan bukti resting stop.
7. Missing/unverified protection mengikuti bounded repair/cancel-entry/emergency-close behavior yang diwajibkan existing guard. Tidak membatalkan last protective stop sebelum replacement terverifikasi atau exposure telah flat. Race antara additional fill dan cancel harus direconcile lagi.
8. Financial record bersumber native fills/funding/fees. Unknown tidak dihitung sebagai profit nol. Partial close, entry/exit fees, funding dan remaining quantity tetap terpisah.

Account mode one-way/hedge, reduce-only semantics, leverage/rules, market/limit GTC, native precision, close lookup dan stop coverage adalah adapter conformance requirements. Preserve existing Aster opt-in LIMIT_GTC; jangan mengklaim semua venue mendukung tipe order itu jika belum ada capability proof.

Semua delapan venue tetap berada pada capability matrix. Pengganti adapter boleh dikirim bertahap dalam engineering branch, tetapi full UI/venue parity belum diterima selama pilihan yang sebelumnya tersedia belum mempunyai pengganti teruji. Experimental status tidak dinaikkan oleh fixtures saja.

## 11. Grok bridge: protocol, identity dan reachability

### Mode dipisahkan dari health

- desiredMode: DISCONNECTED, OBSERVER, CONNECTED, GROK_STANDALONE.
- observedHealth: NOT_CONFIGURED, OUTBOUND_ONLY, BIDIRECTIONAL_VERIFIED, DEGRADED, AUTHORITY_CONFLICT.
- Tidak otomatis berpindah ke standalone karena callback timeout. Local market/position lifecycle tetap independen.

Dokumentasi publik mendukung scheduled/webhook routines, group dengan sampai enam bot, dan persistent shared computer. Itu bukan bukti bot/group/route akun Boss telah dipasang. Tidak ada direct group transcript API yang diverifikasi pada sesi ini. [Grok routines](https://docs.x.ai/grok-bot/skills-routines-and-automations), [Grok groups](https://docs.x.ai/grok-bot/chat-and-collaboration), [Grok shared computer](https://docs.x.ai/grok-bot/computer-and-apps).

### Protocol draft pengganti

Gunakan schemaVersion=mpu.grok.v2 untuk typed contract pengganti; sumber envelope v1 tetap disimpan sebagai evidence desain. Tidak mengubah v1 diam-diam. Unsupported version ditolak saat handshake. Pairing harus menegosiasikan v2 sebelum remote hasil dihitung.

Common envelope: eventId, originEventId, correlationId, sourceSurface, kind, createdAt, observedAt, expiresAt, configVersion, payload. Normative role result menambah cycleId, logicalRole, phase, taskAttempt, evidenceId dan accountRef yang wajib cocok dengan task host. Kind-specific strict schema memberi required fields per event, bukan payload object bebas.

| Kind family | Wajib dan pengaruh |
|---|---|
| integration.hello/heartbeat/error | Peer/version/capabilities, explicit observed time. Bukan Owner authority |
| research.request/result, market.summary | Task/source/time refs; remote price diberi CONTEXT_EXTERNAL_VENUE dan tidak menimpa Bybit |
| debate.role.request/result, risk.verdict | Assigned role/phase/attempt/evidence/config binding; satu completion current attempt |
| trade.proposal/status, position.status | Intent/account/native evidence reference; tidak dapat submit/cancel order |
| settings.projection/ack | Active local version dan applied remote version; ack monotonik, tidak mengubah settings lokal |
| owner.command.request/result | Independent Owner grant diperlukan; bot scope saja tidak diterima |
| kill.status, journal.entry, report.digest | Projections redacted dengan originEventId; loop suppressed |

HMAC-SHA256 callback canonical input: HTTP method, exact callback path, Unix-seconds timestamp, nonce, dan SHA256 raw UTF-8 body, dipisahkan newline. Headers: X-Mpu-Key-Id, X-Mpu-Timestamp, X-Mpu-Nonce, X-Mpu-Signature. Independent secrets per direction, constant-time comparison, rotate/revoke. Baseline security skew 300 detik, nonce retention 600 detik, body limit 128 KiB; ini security controls, bukan trading thresholds. Verify raw body sebelum JSON parse. Same eventId+same digest mengembalikan durable receipt tanpa apply ulang; eventId+different digest ditolak. Retry memakai nonce baru untuk eventId yang sama. Expired task tidak diterapkan walaupun signature valid.

Outbound memakai documented Bearer webhook key; callback HMAC adalah protokol milik aplikasi yang harus dipasang dan dibuktikan pada bot computer, bukan fitur signing bawaan Grok yang diasumsikan. Per-task capability mengikat hasil ke assigned task. Karena shared computer, role bot identity tetap REPORTED bila product tidak memberi signed per-bot attestation.

### Owner authentication

Bridge key hanya punya scope results:write/status:read pada peer yang dipair. Ia tidak boleh meminta mode LIVE, keys, wallet signing, transfer, withdraw, unkill, atau settings/order mutation. actorRole=owner adalah data yang tidak dipercaya.

Remote mutations menggunakan salah satu bukti independen yang benar-benar tersedia: verified product attestation yang divalidasi server, atau one-time local Owner grant bound ke command digest/account/expected version/expiry. Default implementasi adalah propose di Grok lalu review/confirm di local UI. Ini sengaja belum memenuhi direct trusted HT-DM command bila attestation tidak tersedia; AC-16 harus dilabel partial/unverified. Jangan mengarang API/identity proof demi green acceptance. Remote unkill dan mode/key flows tetap dedicated local-only.

### Network boundary

Office/API LIVE tetap loopback-only. Callback memakai listener ingress terpisah dengan hanya POST /api/v2/integrations/grok-bot/events dan signed receipt response, melalui TLS/private routing yang dipilih Boss saat integrasi operasional. /pair dan /status tetap local Owner-only. Tidak expose seluruh port 8787 atau memperluas localhost authorization dengan trust proxy. Tidak memasang tunnel/publikasi otomatis dalam coding plan.

Local-only tests dapat membuktikan auth/replay/queue. BIDIRECTIONAL_VERIFIED memerlukan real outbound acceptance dan inbound completed callback yang correlated. Group/DM delivery mempunyai receipt terpisah; HTTP callback tidak membuktikan pesan tampil di group. Bot-written delivery claims dilabel reported bila tidak ada verifikasi tambahan.

### Source workflow crosswalk

| Standalone source feature | Connected projection dan acceptance |
|---|---|
| HT private Owner chat, six-bot group | HT report destination dan group collaboration tetap; endpoint callback tidak dianggap group transcript API |
| Ticket exchange/pair/side/entry/SL/TP/size/leverage/liquidation/reason/invalidation | Typed ticket menyimpan seluruh field, native account/instrument, config/evidence refs. Liquidation estimate nullable dan berlabel REPORTED/INFERRED bila bukan native observation |
| Risk APPROVE/VETO dan TM/MR/TS 2-of-3 | Preserve source semantics di standalone; connected memakai consensus hanya jika dipilih Owner. Veto tidak menambah CLOSE prerequisite |
| Auto ON versus manual permission | Preserve chosen approval policy. Manual approval terikat ticket digest/version/account; approved ticket yang berubah perlu persetujuan ulang. Jangan mengubah Auto atau mode hanya karena bridge paired |
| Daily summary dan weekly review | Source cadence: first cycle after 22:00 daily dan Sunday 20:00 weekly dalam timezone Owner; dedupe per local calendar period, termasuk restart/DST. Jangan mengganti jadwal report Mpu yang sudah dipilih Owner |
| Scheduled routine >=5 minutes | Batas Grok schedule dipisahkan dari event webhook dan monitoring Bybit; bukan cap/minimum tersembunyi untuk interval Mpu |
| config.md, positions.md, trades.csv, daily journal, weekly reports | History standalone retained; connected writes hanya namespaced synced projection, misalnya /workspace/mpu-gandring/synced/mpu/. Tidak overwrite original history atau menganggap bot notebook sebagai native financial ledger |
| STOP dan partial TP/close | Accepted D09 plus explicit native execution intent; partial quantity/protection/PnL mengikuti gateway, tidak disimpulkan dari EXEC: DONE |

Pemasangan role prompts/routine/projection writer pada komputer Grok adalah sesi integrasi yang terpisah setelah connector selesai dan Boss mengotorisasi remote changes. Acceptance source parity dapat diuji dengan fixtures dahulu; deployment dan delivery tetap membutuhkan bukti nyata.

## 12. Execution authority dan STOP

CONNECTED hanya bisa memiliki Mpu writer setelah standalone routine/order authority untuk akun overlap dinonaktifkan atau dicabut secara terbukti dan pending exchange activity direconcile. Lease/epoch menolak stale local writer, tetapi tidak mencabut key independen di exchange. Credential revocation/readback adalah bagian wajib handover.

Urutan handover: halt new entries di owner lama; snapshot native posisi/open orders/fills/protection; revoke/disable credential dan routine overlap; tunggu/rekonsiliasi in-flight native outcomes tanpa blind resend; import durable ledger; verify eligible local permissions/protection; advance authority epoch; baru izinkan entry baru dengan instruksi aktivasi Owner. Kalau old writer masih mungkin aktif, account health AUTHORITY_CONFLICT. Monitoring/close tidak dimatikan.

D09 yang disetujui Boss: STOP Grok -> latch halt ON, Auto OFF, abort new debates/entries, cancel entry/nonprotective remainder, retain current position SL/TP. Existing local Kill -> latch halt ON plus explicit emergency flatten operation seperti perilaku UI sekarang. Local UI menampilkan perbedaan dengan copy singkat; jangan mengganti handler diam-diam. STOP Grok sendiri tidak menghasilkan intent CLOSE. Emergency protection close tetap berlaku melalui guard terpisah bila proteksi posisi gagal.

STOP lokal tidak menunggu Grok ack. Remote command tanpa connectivity tidak boleh menyatakan applied. Release halt tetap local Owner action, tidak mengaktifkan Auto atau memesan order. Runtime restart membaca durable halt terlebih dahulu.

## 13. Compatibility UI, CLI dan reports

Inventory final dibekukan oleh T00. Cakupan minimal yang sudah teramati:

| Surface | Kontrak yang dipertahankan |
|---|---|
| Office dan discussion | /api/state, /ws; state/speech/fight/meter/verdict/log/status/debate/report/execution/room/cendol |
| Setup, preferences, profile | /api/setup/*, saved/active identity, all existing numeric fields, mode/key local flow |
| Models/local CLI/research/Jev | Discovery, login/status/test, reasoning, configured MCP/tool controls, Jev test/status |
| Trading operations | /api/debate, /api/command, /api/ops/*, /api/auto, /api/kill, /api/unkill, /api/split |
| Wallet dan delapan venues | /api/wallet/start/approve/balance, readiness dan delegated wallet recovery |
| Chat | /api/conversations*, /api/chat/history*, /api/chat/cancel/:id; persistence/correlation/cancellation |
| Reports dan session logs | /api/reports*, /api/logs/sessions*, downloads/filtering, native financial certainty |
| Lessons/research/backtest | /api/ops/lessons, /api/research*, source honesty, sandbox simulation labels |
| Channels | Telegram, Discord, Slack, WhatsApp setup/tests/allowlists/signatures; no real messages during fixture tests |
| Support/update | /api/trakteer/*, /api/update/*, tour; keep existing visuals/actions |
| External automation/CLI | mpu, gb, setup, doctor, trade, service/autostart, report, positions, analyze, scan, lessons, kill/unkill, reports/backtest/capabilities |
| Existing external ingress | /api/agent-event, /api/gb/*, /api/tradingview, /api/bridge/probe with clearly scoped compatibility and no shared Owner impersonation |

New WS envelope menambah sequence, streamEpoch, stateVersion, dan request/correlation IDs secara additive. Reconnect memulai authoritative state snapshot plus cursor; gaps memicu resync. Candle stream memakai symbol+TF+revision; UI tidak menerima late response dari symbol/TF sebelumnya. HTTP bootstrap tetap ada. Do not stream seluruh state pada setiap trade tick.

Pertahankan Lightweight Charts dan TradingView widget view. Widget bukan Advanced Charts self-hosted library; tidak perlu lisensi atau integrasi datafeed baru untuk canonical local chart. [TradingView widget data limits](https://www.tradingview.com/widget-docs/faq/data/), [Advanced Charts datafeed responsibility](https://www.tradingview.com/charting-library-docs/latest/connecting_data/).

UI acceptance mencakup keyboard/focus, loading/error/empty states, cancellation/tab switch, long model names, day/night, English/Indonesian dan reduced motion. Screenshot parity tidak menggantikan functional test. Gunakan existing test tree tests/ dan playwright-core; tidak menambah Dify, Jotai, atau TanStack hanya untuk migrasi.

## 14. Migration, cleanup dan rollback

Engineering dilakukan di branch/worktree terisolasi setelah instruksi implementasi. Main dan runtime terpasang tidak dijadikan tempat eksperimen. Tempatkan data baru terpisah; tidak auto-import lessons/sample, tidak menghapus real journal. Historical conversations/reports tetap tersedia sebagai archive-only, tidak diklaim active ledger atau prompt evidence baru.

Tahap replacement bisa melakukan observation/shadow replay tanpa signer. Tidak ada parallel live writers. Cutover runtime adalah operasi terpisah yang memerlukan bukti akun aktual dan instruksi aktivasi Boss.

Cleanup setelah semua replacement/parity checks: klasifikasi path, dependency closure, asset references, CLI compiled roots, .env.example/docs, old tests yang menjadi obsolete, dan package artifact. Tidak melakukan reorganisasi binary assets hanya agar folder terlihat rapi. Hash duplicates baru dihapus jika semua referensinya terbukti dan tidak mengubah pixel UI.

Rollback setelah side effect nyata tidak boleh sekadar checkout kode lama. Halt entries; pertahankan protection; reconcile native state; transfer journal/authority secara versioned; baru restart owner lama secara eksplisit. Jangan memulihkan database snapshot lama lalu mengulang intent yang sudah terkirim. Native open positions dan fills selalu direconcile sebelum resume.

## 15. Acceptance dan status klaim

- Deterministic fixture pass membuktikan perilaku kode, bukan koneksi atau trading nyata.
- Public Bybit/browser probe membuktikan source retrieval saat probe, bukan kemampuan venue privat.
- Grok real round trip membuktikan callback path, bukan Owner identity atau single executor.
- Native read-only proof membuktikan posisi/permissions/protection yang terbaca saat itu; order lifecycle membutuhkan testnet atau operasi yang secara terpisah diotorisasi.
- Production activation belum menjadi bagian rencana engineering. “Selesai perombakan” hanya boleh dipakai bila AC-01 sampai AC-17 beserta tambahan acceptance pada plan mempunyai bukti, bukan status unknown yang disembunyikan.

Lanjutkan melalui [implementation plan](2026-10-31-trading-agent-mpu-gandring-rebirth.md).
