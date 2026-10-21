# Trading Agent Mpu Gandring: office redesign verification

Date: 2026-10-21, Asia/Jakarta. Release: v0.0.0.3.5 (package 0.3.5).

## Scope

Replaced inline office scenery with optimized images from the supplied local asset library, refined six existing role characters, and redesigned dashboard surfaces. Preserved movement, agent selection, discussion, debate reactions, wallet/setup controls, chart/report panels, and trading commands. No exchange setup, credential access, mode change, or actual trading was performed.

## Verified

- `npm run typecheck`: passed.
- `npm run build`: passed; production output contains runtime assets and branding, without the source authoring library.
- `DOTENV_CONFIG_PATH=__isolated_no_env__ npx tsx scripts/verify-office-ui.ts`: passed with simulated API/WebSocket data. Covers room bounds, agent overlap, loaded images, HUD separation, wallet session changes, tool panels, discussion, daily-stop overview, reports, desktop, 375px phone, 812px landscape, night mode, reduced motion and absence of browser errors.
- Built app inspected through isolated preview at localhost:5180. The preview disables trading routes and uses sample/mock data.
- Six character poses and animation class names preserved. Original book/watch clipping corrected.
- Review fixes: night allocation-bar text contrast, explicit daily-loss-stop overview status, and room height on short screens.
- Sixteen WebP images total 277,934 bytes. Provenance is recorded in `web/public/office-assets/manifest.json`. The 455.7 MiB authoring library remains local and excluded from Git and production output.

## Existing failures

Full suite: 358 passed, 15 failed, 373 total across 43 files. The baseline before redesign had the same totals and failing tests. Files: `decision-engine.test.ts`, `learning.test.ts`, `trading-settings.test.ts`, `qa-fixes.test.ts`, `gb-regressions.test.ts`, `fixes.test.ts`, `gb.test.ts`.

Failures concern configured rebuttal rounds and snapshot freshness, preset defaults and leverage, minimum entry confidence masking other expected rejection messages, and guard-loosening lesson expectations. Those concerns are unresolved. Backend trading code and safety tests were not changed to make this visual release pass. The updater test's current and future version fixtures were advanced for the release.

The full-suite failure means this release cannot claim a green CI or validated trading safety. Interface checks do not establish exchange behavior, real-money readiness, profitability, or deployment.

## Work log

Approved visual redesign completed through separate office, dashboard, character and review passes, integrated on main. Verification used isolated fixtures. Release notes disclose the existing test failures.

## Screenshot-directed follow-up: v0.0.0.3.6

Implemented the eight requested corrections: removed the workspace headline/navigation and account summary; made the roster one equal-height compact row; added the supplied espresso machine; replaced wall text with the existing project logo; removed the discussion-table label and added coffee, a book and a plant; contained background scrolling while a tool panel is hovered; moved open-order controls, allocation, equity history and positions into the map rail; removed mode/source text from visible map PnL. Existing mode indication remains in the top bar and PnL provenance remains available to assistive technology.

Open-order content was moved into a shared component without changing its N-setting endpoint, position-close commands, calculations or server-side guards. The map rail scrolls within the room height on desktop and flows below the room on mobile. The roster keeps a single row with its own horizontal scrolling on narrow screens.

Verification: typecheck and production build passed. The offline browser verifier passed at 1440px desktop, 375px phone and 812px landscape, day/night themes and reduced motion. Added checks cover section removal, asset loading and logo/decor placement, single-row 44px roster items, tool-panel pointer enter/exit scroll locking, order controls in the map rail, and mode/source labels omitted from map PnL with a simulated LIVE snapshot. No real trading server was contacted. Full test suite remains 358 passed / 15 failed in the same seven baseline files.

Runtime artwork now has 18 WebP images, 285,218 bytes total. README screenshots were refreshed from isolated PAPER fixtures.

## Table keris replacement: v0.0.0.3.7

Replaced only the discussion-table KerisBlade drawing with an optimized WebP of the supplied `026_curved-blade_ornate-dagger.png`. Adjusted its size and position to fit among the existing decorations. Typecheck, production build and the offline office UI verifier passed; the resulting browser screenshot was inspected. Full-suite failures were not repaired or revalidated for this asset-only change. The existing baseline remains documented above.

## Matching keris stand: v0.0.0.3.8

Corrected the previous table placement: the ornate keris is now mounted upright in the supplied `026_curved-blade_wooden-display-stand.png`, with its base resting on the tabletop. Preserved surrounding decorations. Typecheck, production build and offline office UI checks passed; the resulting screenshot was visually inspected. Full-suite baseline failures remain unresolved and were not rerun for this artwork correction.


## Office arrangement: v0.0.0.3.9

Centered the discussion table at the center of the usable floor (x=50%, y=65% with the floor starting at y=30%). Aligned the six workstations in two balanced columns and updated agent seats, spectator positions, report-sharing destinations and table collision bounds to match. Separated the keris stand, cups, book and plant. Replaced repeated hue-shifted individual books with nine supplied assembled book groups across all four shelf levels. Removed the clipped coffee-corner caption and unused single-book runtime image.

Verification: 14 focused scene/updater tests passed, typecheck passed, production build passed, and offline browser checks passed at desktop, 375px phone and 812px landscape, with day/night and reduced-motion coverage. Browser assertions now verify table centering, separate tabletop decoration bounds and non-overlapping bookshelf groups on four levels. Desktop and mobile screenshots were inspected. Runtime assets total 363,320 bytes across 28 WebP files; the authoring library remains excluded from the production output. README screenshots were refreshed from simulated PAPER fixtures. The previously documented 15 full-suite failures were not rerun or repaired for this layout patch.
