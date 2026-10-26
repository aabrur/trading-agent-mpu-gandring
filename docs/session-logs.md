# Session logs

The server entrypoint starts diagnostics before dynamically importing configuration and the application graph. npm application CLI commands use `cli/session-entry.ts`; the launcher and trade supervisor link child runs through `parentSessionId`. These changes do not add restart attempts or activate automation.

The office's **System Log → Archived sessions** view browses local process sessions. Select a session to see its summary and chronological diagnostic events. Search the message/details, filter by severity or source, and click a correlation ID to narrow the view. Older event pages are fetched on demand and the browser retains at most 500 events at a time. The existing live System Log and History views remain separate.

Each session stores a metadata file and rotated console, error, and structured event logs under `data/logs/sessions` by default. Set `MPU_LOG_ROOT` to choose another local directory. The active console/error/event file size defaults to 16 MiB (`MPU_LOG_FILE_BYTES`); the in-memory write queue defaults to 8 MiB (`MPU_LOG_QUEUE_BYTES`).

Session logs are diagnostic records. The archive provides downloads for console output, error output, structured events, and session metadata. The application does not automatically delete old sessions; manage disk retention at the chosen local log directory.

Queued records are redacted before disk writes. Request bodies, raw model prompts, credential fields, and private wallet fields are excluded. Write failures and queue saturation report through the original stderr fallback and counters; they do not reject orders. Storage or power failure can lose events that have not yet been persisted. A later startup labels an abandoned session as inferred unclean only when its recorded process is absent; it never invents a shutdown timestamp.

Journal and report files remain separate accounting and reporting authorities. Download routes are local-only, read-only, and limited to fixed file kinds within validated session directories. Browser pages retain bounded windows while paging through older sessions and events.

Offline end-to-end verification: after `npm run build`, run `npx tsx scripts/verify-session-logging.ts` in a checkout without production configuration and with `DOTENV_CONFIG_PATH=__isolated_no_env__`. It creates clearly labeled synthetic PAPER sample sessions and desktop/mobile screenshots beneath `data/logs/`, opens disposable local services, and closes only those services. It does not start the auto trader or contact a venue.
