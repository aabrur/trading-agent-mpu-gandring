# Independent roadmap verification

On Windows, the isolated environment retains OS runtime-directory variables so the installed Python launcher can resolve its runtime. Provider keys, exchange credentials, and application configuration variables are not inherited. The gate certifies the recorded engineering commands, not activation of every roadmap module or LIVE exchange behavior.

Run `npm run stage-gate` to verify the current checkout. The command runs, in order:

1. `npm run typecheck`
2. `npm test`
3. `npm run build`

Each command receives a minimal environment containing `CI=true`, `DOTENV_CONFIG_PATH=__isolated_no_env__`, and the required process paths. npm user and global config are pointed at separate empty temporary config files. Each command's output is written to the evidence directory with a JSON manifest containing the exact Git `sourceSha`, source-tree digests captured before and after verification, command exit status, and SHA-256 for each output file. A failed command or source-tree change leaves a failed manifest and exits nonzero. To choose the evidence location explicitly:

```sh
npm run stage-gate -- --stage S5 --evidence-dir /path/to/temp/evidence
```

The evidence directory must be outside `docs/roadmap/stage-evidence`; this protects the historical `S1.json` through `S5.json` records from being overwritten. Run `node scripts/mpu-gate.mjs --verify S5` to check only those legacy records against the Git blob bytes at their recorded commits. Its `LEGACY INTEGRITY PASS` means the historical record matches its cited source blobs. It is not a fresh test, build, or current-source verification. `--next` is intentionally blocked until independent current evidence and an Owner decision are provided.
