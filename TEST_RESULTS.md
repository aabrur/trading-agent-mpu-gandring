# Trading Agent Mpu Gandring: offline verification results

Date: 2026-10-29, Asia/Jakarta. Certain, based on actual command output: the isolated install, typecheck, full tests, build and independent S5 retry passed. The first S5 attempt crashed at the Windows process level and is retained below as FAIL. No engineering result establishes live feed correctness, strategy performance, native Grok Bot deployment or exchange fills.

Implementation commit: `fbd6dd772b5211e1b90b206037d7b1bc3b293ead`. Baseline: `42d85251af9f7f9706a2dd6ec38aef7037c2d6e2`. Branch: `remediation/offline-integrity-gtc`. Final report commit changes documentation only; executable source and tests are unchanged from the S5-tested implementation commit.

Environment observed: Windows PowerShell, Node `v24.15.0`, npm `11.17.0`, Git `2.55.0.windows.5`, Python `3.12.10`. Node meets package.json >=20 and matches CI's major version 24. The optional Python worker's existing tests ran in the full suite; no runtime installation or worker activation was performed.

## Saved evidence

Machine-local evidence directory:

```text
C:\Users\abrur\AppData\Local\Temp\mpu-offline-audit-20261029-e31ac0cb
```

`verify.mjs` records each required command's stdout/stderr and exit code in this directory. `commands.json` records actual UTC start/end times. `install.log`, `typecheck.log`, `test.log` and `build.log` retain full command output. `implementation-sha.txt`, `changed-files.txt` and `implementation.diff` identify the exact implementation delta. The earlier `changed-tracked-files.txt` is an initial snapshot; `changed-files.txt` is the complete committed list, including new files.

Verification used `CI=true`, `DOTENV_CONFIG_PATH=__isolated_no_env__`, empty npm user/global configuration and an allowlist of OS runtime/PATH variables. Provider/exchange credentials and the Owner's `.env` were not inherited. Exchange HTTP and provider responses in regression tests are fixtures; local route tests use ephemeral loopback servers. The kill CLI regression now mocks its Office notification instead of contacting the fixed production port.

## Required command results

| Command | Exit | Result | Evidence |
| --- | --- | --- | --- |
| `npm ci --ignore-scripts --no-audit --no-fund` | 0 | PASS, 224 packages installed | `install.log`, 11:57:19 to 11:58:10 UTC |
| `npm run typecheck` | 0 | PASS, server and web tsconfigs | `typecheck.log` |
| `npm test` | 0 | PASS, 140 files and 1,161 tests | `test.log`, 11:58:13 to 12:01:48 UTC |
| `npm run build` | 0 | PASS, TypeScript and Vite | `build.log` |
| `npm run stage-gate -- --stage S5 --evidence-dir <evidence>/s5` | 1 | FAIL, test subprocess exited 3221226505 | `s5/S5-independent.json`, `s5/test.log` |
| `npm run stage-gate -- --stage S5 --evidence-dir <evidence>/s5-retry` | 0 | PASS, unchanged source; all three criteria exit 0 | `s5-retry/S5-independent.json` and its three logs |

The first four commands ran before the implementation commit, on the baseline HEAD with the remediation working-tree changes. The independent gate then verified the committed implementation itself. Neither the failed gate nor its retry changed source code.

Actual full-suite stdout excerpt:

```text
 Test Files  140 passed (140)
      Tests  1161 passed (1161)
   Start at  18:58:14
   Duration  213.64s (tests 52%, import 45%, transform 2%)
```

Actual S5 retry stdout excerpt:

```text
PASS typecheck
PASS test
PASS build
PASS: Independent S5 verification completed on fbd6dd772b; source tree 4920341aec51576af92f0a41a7002982dc62c8f3ca31208e458b52cbf848e1e2.
```

S5 retry manifest: `status=PASS`, `sourceStable=true`; source-tree SHA-256 before and after both equal `4920341aec51576af92f0a41a7002982dc62c8f3ca31208e458b52cbf848e1e2`. It records `sourceSha=fbd6dd772b5211e1b90b206037d7b1bc3b293ead`. Its test run passed the same 140 files and 1,161 tests in 202.14 seconds. Final report files were added afterward and are not represented as having been part of that source digest.

## Failure and retry accounting

Certain, based on the first S5 log: `stage-gate.test.ts` and `external-agent-parity.test.ts` passed, then the test process exited `3221226505`; no failed test assertion or JavaScript error was emitted. S5 correctly marked FAIL and did not run its build criterion. The source digest remained stable.

Uncertain, based on absent crash diagnostics: the underlying native Windows process-crash cause is not established. An unchanged retry completed successfully. No test, safety assertion or worker configuration was weakened to obtain that result. Both gate manifests and logs are retained. The runner/gate also emitted Node's existing DEP0190 shell-argument warning; commands here use static trusted arguments, and the warning is not recorded as an engineering PASS/FAIL assertion.

## Targeted regression coverage

| Suite | Passing tests in full run | Behavior covered |
| --- | --- | --- |
| `market-integrity-provenance.test.ts` | 19 | Exact 08:30/08:45 finality, 1h/4h intervals, duplicate/order/gap/stale/clock metadata, fallback identity, 41x prior median versus unchanged mean ranking, unit/source mismatch, zero/missing/tiny volume, historical event windows, 1000FLOKI diagnostics |
| `live-observations.test.ts` | 14 | Actual market observation seams, independent unavailable feeds, no fabricated live fallback, last completed bar retained with duplicate rows |
| `gb-evidence.test.ts` | 1 | Native tiny-volume precision and no second final-bar removal in CLI transport |
| `runtime-evidence.test.ts` | 4 | Canonical hashes versus unknown native profiles/phase, saved/active provenance without mutation or secret export, Setup 60% hot-apply/reload/reconstruction and 0.59 versus 0.60 entry boundary, Owner cadence docs |
| `killswitch-forensics.test.ts` | 8 | First activation origin, malformed-file protection, repeated/concurrent requests, sanitized append-only evidence, CLI/API audit failure, no duplicate close |
| `gtc-entry.test.ts` | 24 | Aster LIMIT+GTC request and side-aware ticks; legacy MARKET; 25%/100% fill progression; cancel races; unknown send/read; idempotency; crash/restart; explicit expiry; venue rejects/invalid lot/price/stop; net and undersized protection; failed/unknown stops; late fills after emergency close; kill and manual close |
| `gtc-cli.test.ts` | 9 | Explicit selection only, no implicit TTL, malformed flag rejection, no free-text limit parsing, strict entry shapes and cancellation route |
| `gtc-desk.test.ts` | 3 | Authenticated normal admission, resting versus filled evidence, one Owner slot per partial/pending intent, idempotent request, protection, manual CLOSE, cancellation and local-origin boundary |
| `channels.test.ts` | 22 | Existing signed/allowlisted channel handling, including the added valid and invalid signed Discord /status requests |

Existing external-agent, trading-settings, exchange/protection, incident, journal recovery, risk, secrets, local-origin and OPEN/CLOSE suites also passed in the full run. No existing suite was removed. Coverage here means tested behaviors; line/branch coverage instrumentation was not run, and no code-coverage percentage is claimed.

Red-capable loops were run before the relevant fixes: tiny CLI volume expected `4.123456789e-8` but returned `0`; duplicate candle history expected 21 rows but returned 11; a second kill write replaced the first origin; GTC adapter tests observed three order POSTs instead of one; GTC transport tests found missing entry fields; the late-fill protection test expected a second close for new exposure but observed only one. Their permanent regression tests now pass.

## Acceptance boundaries

PASS: offline code/contracts, native JSON precision, provenance, diagnostic volume semantics, saved/active 60% fixture, source identity, forensic audit, opt-in GTC lifecycle, compatibility defaults and required engineering checks.

UNKNOWN / NOT VERIFIED: actual installed Grok Bot roles/template/routine and phase, current Aster symbol/feed availability, host clock, independent web-tool event provenance, live permissions/connectivity/fills/protection, production Discord delivery and financial performance. No real order was submitted to establish those claims.

The original checkout remained clean on `main` at the baseline. The remediation and evidence are committed only on the isolated local branch. See `CODE_CHANGES.md` for the exact delta and `GROKBOT_HOST_READONLY_CHECKLIST.md` for separately authorized host inspection.
