# Work Journal API

Clawtab can expose a local Work Journal through its existing outbound daemon
connection. This is a restricted, read-only HTTP API, not a job invocation or a
general reverse proxy. The journal application, daemon and SQLite data remain
independent of Clawtab; the bridge only asks its Unix socket for approved context.

## Machine setup

Install and run Work Journal on the selected machine. Its default socket is
`~/Library/Application Support/Work Journal/control.sock` on macOS. Both services
may override the path using WORK_JOURNAL_SOCKET. Keep the socket user-private.

The updated Clawtab daemon advertises `journal_query_v1`. Deploy the updated relay
(including migration 015) and update the local daemon before enabling a CRM
connection. Older machines return an explicit unsupported-capability response.
Closing either desktop window does not stop the background services.

Local scheduled agents can read the broader approved-only writing export without
opening the Work Journal socket to their repository sandbox:

```sh
cwtctl journal approved --days 7
```

The daemon asks Work Journal for its bounded writing context and returns up to
80 approved facts in the requested 1–30 day window, selected in rounds across
projects, plus at most six self-authored writing examples. Work Journal also
applies a 384 KiB item budget. Older versions retain the previous timeline-scan
fallback during upgrades.
Screen observations and fields outside the documented provenance/context set are
removed. The command cannot read originals or pending/private items and cannot
change reviews, sources, settings, or collection state.

## Credentials

Owner-authenticated token management routes:

- `POST /machines/{id}/journal-tokens` with `{ "label": "CRM journal" }` creates
  a token, returning id, machine_id, token and scope (`journal:query`) once.
- `GET /machines/{id}/journal-tokens` lists metadata, never token values.
- `DELETE /machines/{machine}/journal-tokens/{id}` revokes a token immediately,
  including requests already waiting for the machine's answer.

Only the machine owner may create/list tokens. Guests and shared workspaces do
not receive journal access. Store the returned token server-side as a CRM secret;
never use the owner's login credential as the CRM service credential. The relay
stores only the SHA-256 hash of the random token. Journal tokens cannot authorize
login, WebSocket control, shell commands, files, jobs, or token management.

## Query

`POST /v1/machines/{id}/journal/context`, Authorization Bearer journal token:

```json
{
  "topic": "Someone bought a Mac app and improved its website",
  "project": "trend-seeker",
  "days": 5,
  "exclude_ids": []
}
```

Only topic, optional project, days (1–30, default 5), and exclusion IDs are
accepted. The relay returns the journal's version-1 context: origin, checked_at,
up to three approved facts, up to six approved writing_examples and a style
instruction. Each item carries its source_ref, author, event time and revision.
No pending/private records, raw files, or collection controls are exposed.

The relay has a six-second response deadline and at most four in-flight queries
per machine. The daemon's local socket deadline is four seconds. Offline,
unsupported, unavailable and timeout states return 409; invalid credentials 401,
unauthorized ownership 403, overload 429. CRM should fall back to its last approved
synced snapshot and show freshness, rather than present stale context as live.
Request IDs are machine-scoped; responses and late responses never broadcast to
other connected clients.

## Checks

`cargo check -j4 --manifest-path desktop/src-tauri/Cargo.toml --no-default-features
--bin clawtab-daemon` and `cargo test -j4 --manifest-path relay/Cargo.toml` verify
the bridge and relay regression suite. Private context and malformed queries are
rejected by contract tests. Full relay Clippy currently also reports pre-existing
findings in unrelated modules; journal changes add no lint exceptions.
