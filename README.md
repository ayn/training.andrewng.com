# Calendar Archive Worker

A small Cloudflare Worker that turns a rolling ICS feed into a permanent calendar subscription. Originally built for training calendars that remove past workouts.

Every hour it fetches one HTTPS feed, saves a snapshot in D1, and updates events by their original UID and recurrence identity. Events that disappear stay archived. Edits, moved dates, descriptions, recurrence exceptions, alarms, time zones, and explicit `STATUS:CANCELLED` values are preserved. No workout parsing or calendar-account credentials are needed.

## Semantics

- One source feed per deployment. Use another deployment/database for another person or feed.
- Disappearance never deletes an event, including a future event. This is an archive, not a strict mirror. A coach deleting and recreating an event with a different UID can leave both copies; inspect those manually.
- Explicit cancellation updates the event's status. Calendar clients choose how to display cancelled events.
- Recurring masters and exceptions are preserved without expanding occurrences. Changes to a recurring master can therefore change its historical expansion.
- Repeated identical snapshots are stored once. Changed snapshots are retained indefinitely, along with the latest copy of each event. Monitor storage and export backups as the archive grows.
- A failed or malformed refresh leaves the previous calendar readable. A valid empty feed is saved without deleting history.
- Keeping old events cannot recover anything that vanished before collection began. Historical ICS or PDF exports can backfill gaps.

## Deploy

Requires Node 22.13+ and a Cloudflare account with Workers, D1, and a zone for the custom domain. Copy `wrangler.example.jsonc` to the ignored `wrangler.jsonc`, change the domain, and set the account ID if your token covers multiple accounts.

```sh
npm ci
npx wrangler d1 create training-calendar-archive
# Copy the resulting database ID into wrangler.jsonc.
npx wrangler d1 migrations apply training-calendar-archive --remote
npx wrangler secret put SOURCE_URL
npx wrangler secret put FEED_TOKEN
npx wrangler secret put ADMIN_TOKEN
npm run deploy
```

Generate two independent random tokens of at least 32 characters (for example with `openssl rand -hex 32`). Store them in your password manager and enter them at Wrangler's prompts. `SOURCE_URL` must be the full private HTTPS ICS URL, not an HTML calendar page. Redirects are rejected; use the final HTTPS URL. Secrets belong in Cloudflare secrets, not vars or Git. Local test credentials can use ignored `.dev.vars`.

The subscription URL is `https://YOUR_DOMAIN/calendar/FEED_TOKEN.ics`. Add it as a calendar subscription in Apple Calendar, Fantastical, or Google Calendar. Anyone with the link can read the entire archive; treat it as a password. No Cloudflare Access login is required because calendar clients cannot normally perform one. Worker request logging is disabled by default to avoid recording capability URLs; also consider any account-wide logs/analytics you enable.

- `GET /health`: public process liveness only, not upstream freshness.
- `GET /status/FEED_TOKEN`: private event count, last success/attempt timestamps (Unix milliseconds), and sanitized error state. Use this to monitor freshness; it never returns the source URL.
- `POST /admin/refresh`: fetch immediately, with `Authorization: Bearer ADMIN_TOKEN`.
- `POST /admin/import`: import an ICS body with the same operator authorization. Use for oldest-to-newest historical snapshots, then refresh the current source last. Imports are treated as newly observed updates; do not replay old snapshots over newer live edits.

Rotate `FEED_TOKEN` to invalidate an old subscription URL. Never share `ADMIN_TOKEN` with calendar clients. Keep the source URL stable; changing to an unrelated source can mix calendars and identities.

## Backfill

Import original feed snapshots first, oldest to newest, retaining their UIDs. Fetch the resulting archive to a private file. If you have the SQLite history produced by the personal running tools' Final Surge PDF importer, reconstruct older missing dates:

```sh
node scripts/import-history.js --database /PRIVATE/running.sqlite3 \
  --before 2026-01-01 --existing /PRIVATE/archive.ics \
  --output /PRIVATE/pdf-backfill.ics
```

The cutoff is exclusive. PDF events are all-day and marked as reconstructed; PDFs lack original calendar UIDs and exact event times. Multiple planned entries remain separate. Dates represented by original ICS events are skipped to avoid ambiguous duplicate matching. Stable synthetic UIDs make repeated imports update rather than duplicate PDF events. The importer includes planned titles/descriptions, not completed-activity data or athlete comments. Review the private output before importing it. Upload files via a client that reads the operator token from a secure environment; do not put tokens in shell history, committed files, or logged URLs.

For older calendar history without this SQLite schema, import an ICS export directly. This service does not scrape Final Surge or recover missing history from Strava.

## Development

```sh
npm ci
npm test
npm run check
npx wrangler deploy --dry-run --config wrangler.example.jsonc
```

Tests use synthetic calendars and the real SQLite migration/queries through a D1 interface adapter. They cover retention, updates, cancellations, recurrence exceptions, timezone/alarm preservation, invalid feed isolation, refresh ordering, private read-only access, and historical import deduplication. Wrangler's dry-run verifies the Worker bundle; test a deployment against real D1 before subscribing.

MIT licensed. The RFC 5545 parser, ical.js, is MPL-2.0 licensed; see its package license. No personal training data is included in this repository.
A persistent ICS calendar archive on Cloudflare Workers and D1. Retains events after they disappear from rolling feeds.
