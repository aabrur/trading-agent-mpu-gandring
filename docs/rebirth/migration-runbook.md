# Trading Agent Mpu Gandring: Migration and Cutover Runbook

This document details the cutover steps and rollback procedures for activating the v2 replacement runtime.

## 1. Prerequisites and Pre-Cutover Checks

Before cutover, verify:
1. No active trades are in a vulnerable state (check resting exchange stop losses via exchange web UI or app).
2. Existing `.env` file is backed up locally:
   ```bash
   cp .env .env.backup.v1
   ```
3. Existing journal records in `data/` are backed up:
   ```bash
   cp -r data data.backup.v1
   ```

## 2. Cutover Execution Steps

1. **Build and Typecheck Verification:**
   ```bash
   npm run typecheck
   npm run build:rebirth
   node scripts/check-runtime-boundary.mjs
   ```

2. **Run Full Rebirth Conformance Suite:**
   ```bash
   npx vitest run tests/rebirth/
   ```

3. **Verify Build Artifact:**
   Ensure `dist-rebirth/` or `dist/` contains the fresh entry points and built web bundle under `dist/web/`.

4. **Start in PAPER Mode:**
   Always start cutover in PAPER mode first:
   ```bash
   npm run dev
   ```
   Open `http://localhost:5173` and confirm:
   - All 6 agents appear in their respective workstations.
   - Financial fields show valid paper balance or honest unavailable indicators (never fake $0.00).
   - Test a paper sizing calculation via Desk Ops tab.

## 3. Rollback Procedure

If unexpected behavior or integration issues occur:
1. Stop the active process: `Ctrl+C` or `mpu kill`.
2. Restore the original `.env` and `data/` directories if needed:
   ```bash
   cp .env.backup.v1 .env
   cp -r data.backup.v1 data
   ```
3. Checkout the main branch:
   ```bash
   git checkout main
   npm install
   npm run dev
   ```
4. Note on Intent Safety: The v2 SQLite store (`store.db`) records immutable historical events. Rolling back to v1 will not resurrect previously filled or cancelled orders.
