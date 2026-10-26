# Enhanced notifications

The daemon owns the notification queue and the macOS overlay. Cards remain available while the desktop app is closed. On macOS 12 or later, cards appear below the notch on the selected display, or in a right column on displays without a notch. Settings also allow the right column on every display.

Configure delivery, display, sound, Focus behavior, and layouts in **Settings > General > Notifications**. Existing local notification preferences still apply. The first card shows the message, quick choices, and a reply field with a Send button. Its colors and action buttons follow the remote app. Review, question, and permission cards stay open until answered or closed. Status updates collapse to a pending count after eight seconds, pausing on hover.

Use the previous/next arrows to move between notifications, or Command/Ctrl + Shift + [ / ]. Each card keeps its reply draft. New requests queue without replacing the card being read, and a successful reply advances to the next request. The position count opens the full list; History is available there. Details widens the card and adds a larger scrollable area for the full message, attachments, and recent output. Agent controls are behind a separate button inside Details. Open agent returns to the originating conversation.

The notch surface overlaps the camera cutout's lower corners with a black, borderless shape. Its width and height animate together while the top stays attached. Display space limits the expanded size. Reduce Motion disables size animations.

Following macOS Focus requires notification and Focus access for **ClawTab Daemon**. When Focus status is unavailable or Focus is active, delivery goes through macOS notifications. macOS then applies its notification settings and Focus allowlist. Independent mode allows the overlay and its sound regardless of Focus. Selecting Both uses the native notification for sound.

## Submit a request

Agent prompts and job notifications enter the queue automatically. Agents and scripts can also submit JSON:

```sh
cwtctl nfn send --stdin --wait --timeout 300 <<'JSON'
{
  "title": "Review the launch post",
  "body": "The caption and video are ready for review.",
  "template": "social-review",
  "data": { "platform": "YouTube Shorts" },
  "media": [{ "kind": "video", "src": "/absolute/path/draft.mp4", "alt": "Launch video" }],
  "dedupe_key": "launch-post-42",
  "response_destination": "result"
}
JSON
```

`send` returns the persisted request, including its ID. `--wait` returns the final record and response. A wait timeout returns `wait_timed_out: true` and leaves the request pending. Set `expires_at` to a Unix timestamp in milliseconds to expire the request itself.

For progress reports that need no decision, send `"template": "update"` without `--wait`. Update cards show **Update** and **Got it**, with no reply composer. Use question or permission templates when the workflow needs an answer. Sending a notification alone does not pause an agent; the workflow must wait for and consume its response.

```sh
cwtctl nfn get REQUEST_ID
cwtctl nfn wait REQUEST_ID --timeout 60
cwtctl nfn cancel REQUEST_ID
cwtctl nfn show
cwtctl nfn templates list
cwtctl nfn templates validate ./my-review.yaml
```

The CLI infers the originating pane from `CLAWTAB_SESSION_ID` or `TMUX_PANE`. An explicit `source.pane_id` takes precedence. Binary jobs should set `source.job_id` and `source.run_id`; they then use that run's log and do not inherit a terminal pane. Media supports HTTPS URLs and absolute local file paths. The native overlay streams local video in bounded chunks and releases it when the card closes. Local media is displayed by the daemon overlay; the in-app inbox supports HTTPS media.

The default response destination, `result`, records a choice for the caller to consume. `agent_message` sends the decision and optional feedback to the originating live agent instead; it cannot be combined with `--wait`. Posting to a social network, touching a security key, granting permissions, and installing a background job remain the responsibility of the requesting workflow.

An explicit request can supply up to 32 actions. The first card displays three; More choices shows the rest:

```json
{
  "title": "Approve a background job",
  "template": "permission",
  "data": { "command": "the proposed command", "diff": "the proposed changes" },
  "actions": [
    { "id": "approve", "label": "Approve" },
    { "id": "revise", "label": "Request changes" },
    { "id": "reject", "label": "Reject" }
  ]
}
```

Permission cards and detected agent prompts expose **Auto-yes for this agent** beside the choices. It uses the same pane-specific setting as the remote app and tmux: future prompts from that agent are automatically answered until it is turned off. Its state stays synchronized with other clients, and stale sessions cannot toggle a replacement agent.

Action kinds are `choice` (default), `focus`, `auto_yes`, `model`, and `plugin`. Model and plugin actions use `value` for the model or installed action ID and `parameters` for string values, such as reasoning `effort`. Details > Agent controls offers auto-yes on other card types, Codex model selection, and available installed plugin actions.

## Custom layouts

Built-in layouts include status updates, questions, agent approvals, social reviews, permissions, YubiKey attention, and quick actions. Edit or create layouts in the settings editor, which previews the same renderer used by the daemon. Preview actions are inert. Save a layout to `~/.config/clawtab/notification-templates/ID.yaml`; external edits reload automatically. The filename must match the template ID. A user layout with a built-in ID overrides that layout.

```yaml
version: 1
id: my-review
name: My review
layout:
  - type: text
    field: body
  - type: media
  - type: row
    children:
      - type: diff
        field: data.changes
      - type: plan
        field: data.steps
  - type: reply
  - type: choices
  - type: logs
actions:
  - id: approve
    label: Approve
  - id: revise
    label: Request changes
  - id: reject
    label: Reject
```

Layout primitives are `row`, `column`, `text`, `metadata`, `media`, `command`, `diff`, `plan`, `choices`, `reply`, and `logs`. Text and code blocks bind to fields such as `body` or `data.caption`. Blocks can have a label. Custom content follows the layout inside Details; choices and reply stay on the first card so they are always easy to reach. Layouts contain data and primitives; executable HTML and JavaScript are rejected.

## Request lifecycle

Requests and results are stored in `~/.config/clawtab/notifications.sqlite`. Reading or hiding a request preserves its decision state. A response, cancellation, or expiry ends it. The inbox includes history; resolved records are retained for 30 days.

Deduplication keys apply to pending requests from the same source and session. Re-submission updates the existing request without clearing its read state. Responses are claimed atomically. Agent input validates the original process and session, and detected prompts are rechecked against the visible terminal before submission. A delivery interrupted by daemon restart is cancelled and never replayed. Ordinary pending requests survive restarts.

Only an actively viewed pane suppresses an automatic alert. ClawTab reports the focused pane per window, and external terminal suppression requires the foreground terminal to identify that pane. Ambiguous terminal windows keep alerts enabled.

## Verification

Run Rust tests with the repository's build guard and four workers:

```sh
python3 /path/to/clawtab/scripts/build-guard.py --cwd "$PWD/desktop/src-tauri" -- cargo test --no-default-features --lib nfn:: -j4
pnpm --dir desktop build
```

For renderer interaction checks, generate a standalone fixture with `node desktop/tests/nfn-fixture.mjs /tmp/clawtab-nfn-fixture.html`, open it in a browser, and evaluate `desktop/tests/nfn-browser-check.js`. It checks stable arrivals, drafts, custom layout order, duplicate clicks, log polling, and queue pagination.
