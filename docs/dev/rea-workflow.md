# Optional REA developer workflow

REA means Reverse Engineer Anything ([morluto/rea](https://github.com/morluto/rea), [rea.tools](https://rea.tools/)).

It is a coding-agent toolkit. It is not a trading model, not a seventh desk agent, and not part of the Mpu Gandring runtime.

Public users do not need REA to run PAPER, TESTNET, or LIVE.

## Status

If `npx rea-agents --help` works, reuse that install. Do not reinstall.

Typical CLI version observed during this integration: 6.7.0.

REA's Node.js requirement is independent of Mpu Gandring. Do not raise this project's Node engine solely to install REA.

## Register with a coding agent

Official installer:

```text
npx rea-agents setup
```

Register REA only with the coding agent you actually use (Codex, Antigravity, or similar). Do not commit personal MCP config, Hopper/Ghidra/IDA installs, or captured session material into this repository.

Do not install native reversing engines unless a real investigation needs them and the owner approves.

## When REA is useful

- Inspecting a JavaScript bundle.
- Tracing module relationships in a built artifact.
- Comparing source against a build.
- Investigating unexplained runtime behavior in authorized software.

For ordinary TypeScript in this repo, use the editor, tests, and git. Do not start REA for a routine read of `server/desk.ts`.

## Hard rules

REA must never:

- Run inside a trading cycle.
- Receive exchange API secrets or wallet private keys.
- Be injected into the six trading agents.
- Become an exchange adapter.
- Be a required dependency of `npm start` / `npm run mpu`.

## Bounded example (non-sensitive)

If you need to confirm a frontend bundle matches source, inspect the local Vite build output under `web/dist` after `npm run build`. Do not point REA at a live authenticated Office session, `.env`, or wallet material.

## Skill

The official skill is `reverse-engineer-anything` from `morluto/rea`. Load it in the coding agent when a reversing task starts. Absence of that skill must not block Jev or the desk.
