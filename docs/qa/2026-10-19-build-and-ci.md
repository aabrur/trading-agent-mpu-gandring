# Trading Agent Mpu Gandring bundle and offline CI acceptance

## Measured bundle

The baseline build at d747661 emitted a 526.40 kB initial JavaScript chunk and the existing 500 kB warning. The final follow-up build emits 325.11 kB for the initial chunk, 168.36 kB for PriceChart, 35.21 kB for Setup, 8.27 kB for the JSX runtime and 2.83 kB for AgentPanel. CSS is 71.08 kB. No oversized JavaScript warning remains. The warning threshold and package versions are unchanged.

App.tsx defers chart, Setup and AgentPanel through local DeferredPanel boundaries. Desk Ops, command bar, office, Kill and Close remain outside them. Failure offers an explicit reload action, never an automatic desk restart.

## CI boundary

`.github/workflows/ci.yml` prepares offline validation for main pushes and pull requests, with contents:read, Node 24, a 15-minute job limit, no deployment and no secrets. It runs npm ci with lifecycle scripts disabled, typecheck, the existing test command and production build. DOTENV_CONFIG_PATH points at a nonexistent isolated path.

No push is authorized for this follow-up. Therefore no GitHub run, headSha, URL or remote CI success is claimed. Local results are recorded in the office acceptance report after the final validation cycle. A local Windows rehearsal is not proof that the Ubuntu job has completed.

Locally verified application tree: `1070718` (with prerequisite commits `c75d08d` and `a7d0d68`). The subsequent CI commit adds only the workflow and this evidence document. All 290 local tests, typecheck and build passed; no GitHub run exists for these local commits.
