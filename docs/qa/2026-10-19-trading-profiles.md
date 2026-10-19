# Trading Agent Mpu Gandring: trading profile verification

## Implemented scope

Dashboard Default/Manual entry points open Setup → Trading & Risk. The form edits independent testnet/mainnet profiles, with an explicit preset review and save. Existing installations retain legacy settings until a profile is selected. Entry confidence is enforced for Lead decisions, signed proposals and agent CLI tickets, including the local ops path. CLOSE remains available. Settings application shares the exchange mutation queue and preserves existing exposure, equity and the daily stop latch.

Two integration defects were reproduced and covered: legacy reload overwriting an active profile's allocation, and an already-computed Risk gate carrying leverage above a newly active cap. The execution boundary now caps leverage against current settings.

## Local verification, 2026-10-19

- `npx.cmd vitest run tests/trading-settings.test.ts`: 13 tests passed.
- `npm.cmd test`: 303 tests passed across 35 files.
- `npm.cmd run typecheck`: passed for server and web.
- `npm.cmd run build`: passed; entry JS 325.98 kB, deferred Setup 41.97 kB. No oversized chunk warning.
- `git diff --check`: passed.

Temporary persistence and the existing MemoryAdapter were used. No real or testnet exchange order was sent. Initial test-authoring errors concerning template initialization and the paper equity accessor were corrected; the final commands above passed after the last code change.

## Browser checks

Used an isolated `scripts/office-preview.ts` PAPER/sample/mock server. Its own `.superpowers/qa-settings.env` held synthetic settings. Browser permission was explicitly renewed by the owner. Production startup, keys and the owner's checkout were not used.

All six Setup sections were visited at each viewport. Their modal rectangles matched exactly within each viewport:

| Viewport | Modal x / y | Modal width / height | Horizontal page overflow |
| --- | --- | --- | --- |
| 1440 × 1000 | 162.5 / 90 | 1100 / 820 | None |
| 1366 × 900 | 125.5 / 40 | 1100 / 820 | None |
| 390 × 844 | 12 / 16 | 366 / 812 | None |

Default showed ten disabled preset fields before saving. Manual testnet confidence was edited to 75%, retained while switching to mainnet and back, saved, then restored on reopening/reloading. PAPER remained the running mode; mainnet values stayed separate. Success feedback identified the inactive network and unchanged running mode. Day and night forms were inspected; mobile inputs used 16px type. Reduced motion was enabled: the modal animation was `none` and transition duration was `0.00001s`. No browser console errors were captured during the section matrix. Viewport/media overrides were cleared afterwards.

Screenshots were saved outside the repository:

- `<temp-dir>/mpu-trading-profile-night-1366.png`
- `<temp-dir>/mpu-trading-profile-mobile-390.png`

Browser validation covered configuration UI only. Profile application to a running exchange desk was exercised with mocks, not the owner's LIVE process. No claim is made about profitability or live fills. Previous office-specific fixture limitations remain documented in `2026-10-19-office-acceptance.md`. CI results must be checked against the pushed SHA; the local commands above are not CI evidence.
