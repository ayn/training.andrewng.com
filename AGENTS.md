# Calendar archive

- Use feature branches and pull requests; never push to main.
- Use red/green TDD for behavior changes. Run `npm test`, `npm run check`, and a Wrangler dry-run before pushing.
- Public repository: use synthetic fixtures only. Never commit source URLs, subscription tokens, real calendars, database exports, or credentials.
- Missing events are retained. Explicit edits and cancellations update existing UID + recurrence identities. Do not add automatic deletions.
- Keep dependency changes deliberate; use an RFC 5545 parser rather than splitting ICS with regular expressions.
- Archive reads must never trigger upstream refreshes. Calendar clients receive read-only capability URLs; operator writes require a separate bearer secret.
