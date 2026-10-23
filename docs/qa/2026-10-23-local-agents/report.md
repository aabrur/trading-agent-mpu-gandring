# Local CLI setup verification

Date: 2026-10-23, Asia/Jakarta. Release: v0.0.0.3.17.

## Scope

Connect action, authentication completion, model selection, model Save, running provider identity, compact CLI setup, and support popup. Checks use local PAPER/mock fixtures. The Owner's existing LIVE process was not restarted or reconfigured.

## Findings and fixes

| Issue | Cause | Fix |
| --- | --- | --- |
| Connected before clicking | Setup queried existing CLI authentication on mount | Only an explicit Connect action starts the connection flow |
| Premature success during login | Existing credentials could pass status checks before the new login process ended | Pending or cancelled login cannot report Connected |
| Codex model list too short | Picker was derived from two fixed IDs plus default | Merge visible model IDs from Codex's local catalog cache |
| Other CLI model choices restricted | Selection validator accepted only fixed entries | All eight adapters accept a validated exact CLI model ID |
| Saved local mapping but chats still mock | Save wrote configuration without updating running model configuration | Save applies only agents, provider keys and base URLs, then emits updated state |
| Saved and running selections looked identical | UI only displayed the saved summary | Show a warning when saved and active provider/model mappings differ |
| Old per-agent overrides reappeared after Save | Deleted file entries remained in the process environment | Synchronize only the validated model updates and clear deleted overrides |
| Local CLI controls too large | General Setup spacing and control heights | Scoped compact spacing, 14px maximum headings, 12px body, 32px controls |
| Support popup retained secondary dismissal CTA | Previous popup markup | Remove Maybe later, keep close button, enlarge popup and primary support link |

## Evidence

- Final local checks: `npm run typecheck`, all 476 tests across 49 files, and `npm run build` passed.
- Test-first reproduction: model Save returned HTTP 200 but `/api/state` still reported `mock`; the regression test failed before the fix and passed afterward.
- Test-first reproduction: a visible model in a fixture Codex catalog did not appear in model setup; the regression failed before the fix and passed afterward. Hidden entries remain excluded.
- API tests save and apply a custom CLI model for Codex, Claude Code, Pi, Kimi Code, Kilo, Cline, Grok Build and Antigravity; invalid flag-shaped IDs are rejected.
- A PAPER fixture follows Save -> chat command -> caller request -> rendered chat state. The caller receives the new local provider/model and its fixture response appears in the desk chat.
- Login lifecycle fixtures cover pending, cancelled, and completed login for all eight adapters without requesting real OAuth codes.
- Earlier isolated browser checks confirmed all eight agents remain Connect on mount/refresh, pending login does not show Connected, successful confirmation does, and reopening does not reuse Connected state.
- Earlier browser layout checks at 1440px, 375px and 812px in day/night mode measured heading maximum 14px, body maximum 12px, and no horizontal overflow. Supervisor text also measured 12px.
- Support popup checks covered the same three widths and themes; direct link, close control and removal of Maybe later are covered by tests. The remote embed returned HTTP 403 when inspected.

## Limits

- Windows Computer Use was stopped automatically because it could not establish the browser URL confidently enough to enforce access policy. No further Computer Use actions were attempted. Browser verification of the latest model input and active-mapping warning is incomplete.
- Codex discovery reads cached model metadata, not OAuth tokens. Cache entries can be stale and do not prove account entitlement. Other CLIs offer configured choices and manual IDs; this release does not claim complete automatic account catalogs for them.
- Real model replies and OAuth completion across all eight providers are not verified. Fixtures prove routing and validation, not provider availability, billing, rate limits or model quality.
- Existing processes must load the new server code before Save can apply model mappings immediately. This release does not activate Auto Trade, restart LIVE, or verify exchange execution.
