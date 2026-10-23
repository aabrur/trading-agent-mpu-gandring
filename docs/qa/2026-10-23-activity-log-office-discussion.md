# Trading Agent Mpu Gandring: activity log and Office discussion

## Scope and evidence

Five issues addressed in the existing Setup, Log and Office discussion surfaces. Evidence comes from the supplied screenshots, source review, isolated PAPER HTTP/WebSocket tests and server-rendered markup. Browser interaction and viewport checks remain **NOT VERIFIED**: Computer Use was blocked by automatic approval review because the browser URL could not be established. No alternate computer automation was used to bypass that block.

| Issue | Severity | Category | Disposition |
| --- | --- | --- | --- |
| Research activity accumulated in Setup | P2 | Information placement | Removed activity rows; research controls now live inside the Codex connection card |
| Log lacked operational diagnostics and retained only 120 lines in snapshots | P1 | Observability | Shared structured activity events; 2,000 recent session entries; filters, search and error severity |
| Office discussion lacked a composer and opened above the newest message | P1 | Chat interaction | Shared command endpoint, recipient selection, latest-message scrolling and taller transcript |
| Room chat concealed later debate speech | P1 | Transcript correctness | Chronological merge of room messages and debate speech, with duplicate suppression |
| Activity log did not reliably open at the newest entry | P1 | Scroll behavior | Single scroll container, layout-time positioning and resize observation; removed estimated row heights |

## Reproduction and fixes

### 1. Research activity in Setup

Location: `http://localhost:5173/#setup`, Local CLI Agents.

Open Setup after research calls. Previously, recent MCP calls appeared below a separate research card. Setup should contain settings, while operational events belong in Log. The standalone research card and activity list were removed; research controls are nested inside Codex's existing card. Source placement reviewed; browser interaction NOT VERIFIED.

### 2. Operational log retention and diagnostics

Location: `http://localhost:5173/`, Log panel.

Previously, activity was fragmented and state snapshots returned only 120 log lines. Following the user's later clarification, Log contains system diagnostics: available model, CLI process, structured Codex tool/MCP/plugin, research collector, HTTP failure and browser error events. A new History menu contains trade records, chat sessions, agent discussion and commands. Tools, MCP, Plugins and Processes have separate Log filters. Both panels search retained entries by message, participants, source, category, status, date and duration before applying the visible-entry limit. Entries expose source, severity, status, timestamp and duration when available. HTTP logging excludes query strings, request bodies and headers. Known credentials are redacted. Browser reports require local access, strict input validation and a rate limit.

Verified using isolated HTTP/WebSocket fixtures, including failed MCP events, cross-origin rejection, malformed JSON, credential redaction and the 2,000-entry bound. These events remain in memory for the current server session; this change does not create a durable general-purpose log archive or inspect uninstrumented third-party processes.

### 3. Office discussion composer and latest messages

Location: `http://localhost:5173/`, Desk chat.

Previously, the popover displayed discussion without a composer and retained its opening scroll position. It now has a recipient selector, message field and send action. All-agent messages use the existing `@all` command path; specific recipients use the same authenticated command endpoint as individual chat. Enter submits, Shift+Enter preserves a newline. Failed requests retain the draft. Opening follows the newest message; scrolling up pauses following. The transcript height limit increased from 190px to 280px within the existing office bounds.

The HTTP fixture verified six group recipients, one selected recipient, Owner messages and replies in room history, and no opened positions. Actual input, keyboard, scrolling and viewport behavior remain NOT VERIFIED in a browser.

### 4. Debate speech after room chat

Previously, any room history caused the component to omit speech logs. Sending a chat and then starting a debate could hide newer debate lines. Room messages and speech now share a sorted, bounded transcript. Tests verify that a room reply is not duplicated and later debate speech remains visible.

### 5. Activity-log opening and resize

The supplied screenshot showed the log still requiring manual scrolling. Source inspection found nested scroll containers and estimated row heights from `content-visibility`. The log now uses one scroll container, measures after layout, and observes both content and viewport size changes. Opening resets follow mode. User scrolling up pauses it; Latest resumes it. Browser geometry and repeated-open interaction remain NOT VERIFIED.

## Verification

- `npm.cmd run typecheck`: passed.
- `npm.cmd run build`: passed after the scroll changes.
- `npm.cmd test`: 517 tests passed across 56 files after the History and search changes. Tests verify category isolation, system/history separation, retained-chat recovery, participant search, older matching entries and duplicate suppression between chat copies and room events.
- `git diff --check`: passed.
- An older fake-CLI test initially inherited the local research setting. Its fixture now explicitly disables research and clears additional MCP selections; production restrictions were preserved.
- No real model login, external provider call, live order, trading-mode change or manual LIVE runtime restart was performed for these checks.
- No new browser screenshots or console evidence were obtained. Full browser dogfood remains blocked, including desktop/mobile layout, keyboard interaction and scroll position.

## Code review

No remaining actionable findings were identified in the changed source after the fixes. The browser verification gaps above remain open and must not be treated as passing checks.
