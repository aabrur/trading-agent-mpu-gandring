# Trading Agent Mpu Gandring QA

Date: 22 October 2026, Asia/Jakarta.

Certain, based on local automated checks and screenshot inspection: the requested changes pass the verification below. Zero unresolved issues were observed in the tested flows. This is bounded verification, not a claim that every possible runtime condition has been exercised.

## Scope

- Virtual-office seating, agent clicks, debate and cartoon-fight transitions, furniture and accessories inside the existing frame.
- Four Owner profiles, percentage allocation, venue minimum adjustment, shared execution and direct Office/channel commands.
- Six-agent chat, response recovery, modular personas and Telegram polling lifecycle.

## Verification

| Check | Result |
| --- | --- |
| Pre-edit baseline | 389 tests passed across 44 files |
| Final suite: `npm test` | 427 tests passed across 46 files |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| Built server persona imports | All six agents loaded their four Markdown files |
| `git diff --check` | Passed |
| Production frontend browser checks | Passed against `http://127.0.0.1:5179` |

The browser run used Chromium, fixture office feeds and a disposable PAPER Setup server with a temporary configuration. Viewports: 1920×936, 1440×1100, 1366×768, 1024×600, 375×812 and 812×375. Day, night and reduced-motion states were checked. No page JavaScript errors were observed.

## Issues addressed

| Category | Cause | Verified behavior |
| --- | --- | --- |
| Interaction | The global pressed-button rule replaced agent positioning | All six agent buttons retain their coordinates while pressed and open chat |
| Animation | Idle activity destinations moved agents away from their workstations | Completed debates return all six agents to their own seats; idle agents remain seated |
| Visual | Decorations extended outside the room; accessory anchors ignored artwork aspect ratios | Furniture, accessories and chairs remain inside the room across tested viewports |
| Chat | A shared 700-character schema rejected normal replies; input was a single line | Input accepts 2500 characters; Shift+Enter inserts a newline; replies trim to 4000 before validation |
| Setup | Discard restored an older manual draft after a preset save | Discard restores the loaded preset and its saved allocation percentage |
| Execution | Channels blocked direct Owner commands | Authenticated channel commands and local Office commands use the shared executor |
| Response recovery | Truncated JSON and missing confidence caused avoidable validation failures | Delimiter repair and confidence defaults work; invalid required trading fields still require a deterministic ticket check |
| Financial history | Large numeric identifiers lost precision during JSON parsing | Aster identifiers remain exact; missing identifiers use stable record-derived fallbacks |
| Telegram | Polling cancellation and duplicate-loop ownership were incomplete | One active poller per token, abort on stop, bounded retry backoff, connection probes and repeated-update suppression |

The frame sizing rules were retained. Artwork and furniture geometry changed within the frame.

## Owner settings and execution checks

| Profile | Confidence floor | Max loss per trade | Max leverage |
| --- | --- | --- | --- |
| default | 50% | 20% | 5x |
| balance | 60% | 30% | 10x |
| profit | 70% | 40% | 15x |
| aggressive | 80% | 50% | 20x |

Money Trade remains balance minus safety net. Percentage sizing supports 1.5–100%; omitting the percentage uses Money Trade divided by N. Exchange minimum adjustment requires sufficient available funds, entry fees and loss budget. Applied percentages are reflected in previews, reports and the CLI split.

Direct commands bypass debate, while sharing the execution checks. A model-proposed command must match an explicit instruction in the current Owner message. Questions, quotes, examples, negations and commands embedded in news or lessons do not authorize execution. HTTP and WebSocket writes enforce local Owner access; channel signatures and allowlists remain enforced. Missing executors in TESTNET/LIVE cannot produce local simulated fills or closes.

Malformed Risk output is not unconditional approval. A deterministic ticket preview must pass before execution is attempted, and the executor checks the ticket again. Explicit Risk rejections are retained. Lesson text can be stored without altering active settings or authorizing trades.

## Evidence

- Desktop: [office-fit-1366.png](screenshots/office-fit-1366.png)
- Active fight: [office-hot-debate.png](screenshots/office-hot-debate.png)
- Night: [office-night-room.png](screenshots/office-night-room.png)
- Mobile: [office-room-375.png](screenshots/office-room-375.png)
- Saved preset and allocation: [trading-profiles.png](screenshots/trading-profiles.png)

## Code review and limits

No unresolved actionable issues were found in the changed paths after the checks above. Existing unrelated changes in `MUSE.md` were preserved.

Needs verification: actual model-provider responses, exchange minimums and resting stops on a live venue, Telegram connectivity and cross-process duplicate-poller behavior. Tests used mock providers and fake exchange/channel transports. The configured backend was unavailable during initial inspection and was not started or restarted. Auto Trading was not enabled, no real orders or Telegram messages were sent, and no real settings or credentials were changed. QA completed before the separately authorized commit, push and release.

No before/after performance gain is claimed. The production build and browser checks establish functionality and layout; field Core Web Vitals and a performance trace were not collected.
