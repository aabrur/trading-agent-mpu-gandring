# Trading Agent Mpu Gandring: Grok Integration Capability Proof

## 1. Architecture and Protocol Scope

The Grok asynchronous bridge adheres to the strict typed envelope `mpu.grok.v2`. All data exchanged between Mpu Gandring and remote Grok agents flows through typed discriminators with raw-body HMAC authentication.

### Supported Event Kinds:
1. `role.task.result`: Asynchronous results from remote Grok role subagents (`market`, `research`, `strategist`, `risk`, `execution`, `lead`).
2. `owner.command.request`: Proposed commands from Grok peers requiring one-time independent Owner grants.
3. `desk.state.sync`: Broadcast of desk state, active mode, and kill switch latch.
4. `peer.heartbeat`: Keepalive and latency monitoring probes.

## 2. Security Boundaries and Scope Fencing

- **Raw-Body HMAC Verification:** Signature covers `method\npath\ntimestamp\nnonce\nbodyDigest`, ensuring that JSON whitespace variations or body tampering are rejected before parsing.
- **Clock Skew Tolerance:** Timestamps exceeding 300 seconds (300,000 ms) are rejected.
- **Replay Protection:** Nonces are tracked per key ID in memory to prevent replaying valid requests.
- **Payload Bound:** Requests exceeding 128 KiB are rejected immediately.
- **Fencing Native Orders:** Ingesting bridge events writes exactly 0 native orders. Bridge messages cannot directly place exchange orders.
- **No Self-Promotion:** Remote bots cannot promote themselves to Owner. Commands require an explicit, unconsumed `grantId` bound to the exact SHA-256 digest of the command text.
- **Refused Remote Verbs:** Remote proposals attempting `unkill`, key modifications, or switching to `LIVE` mode are rejected unconditionally.

## 3. Decision D09 STOP Semantics Implementation

- **Remote Grok STOP (`HALT_ONLY`):**
  - Durable halt latch is engaged (`haltLatched: true`).
  - Auto Trading is switched to `OFF`.
  - Open entry orders and unfilled limit remainders are CANCELLED.
  - Open positions and their resting exchange stop loss / take profit orders are strictly RETAINED.
  - Zero strategy `CLOSE` intents are dispatched.
- **Local Kill Switch (`HALT_AND_FLATTEN`):**
  - Halt latch engaged (`haltLatched: true`).
  - Auto Trading switched to `OFF`.
  - All orders cancelled and open positions immediately flattened.
