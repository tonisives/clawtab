# Enhanced notifications

The daemon owns the notification queue and the macOS overlay. Cards remain available while the desktop app is closed. On macOS 12 or later, cards appear below the notch on the selected display, or in a right column on displays without a notch. Settings also allow the right column on every display.

Click the ClawTab icon to configure position, display, delivery, sound, and Focus inside the notification surface. Changes save immediately to `notifications.yaml`. The desktop app also offers **Settings > Notifications** and layout previews. The first card shows the message, quick choices, and a reply field with a Send button. Its colors and action buttons follow the remote app. Review, question, and permission cards stay open until answered or collapsed. Status updates collapse to a pending count after eight seconds, pausing on hover.

Use the previous/next arrows to move between notifications, or Command/Ctrl + Shift + [ / ]. Each card keeps its reply draft. New requests queue without replacing the card being read, and a successful reply advances to the next request. Click the bar background to open or collapse it. The ClawTab icon opens notification settings. The list icon opens Pending and History; click it again to return to the previous card. Drag the bar background to move it, including away from the notch. The dropped position is saved. Pending rows have selection checkboxes and a dismiss button. Select all includes unloaded pages, and Dismiss keeps the cards in History without sending a decision to an agent. Details widens the card and adds a larger scrollable area for the full message, attachments, and recent output. Details stays at the bottom left, including when expanded. Open agent is available on agent cards; Go to job reveals the originating job folder in Finder. Open agent selects the originating conversation in an attached terminal, including when that terminal currently shows a different tmux session.

The black, borderless notch surface reaches the physical top edge of the screen and covers the camera cutout's lower corners. Its collapsed width matches the measured cutout. Width and height animate together while the top stays attached. Display space limits the expanded size. Reduce Motion disables size animations.

The native canvas stays fixed while the card animates inside it, and transparent space passes pointer events through to the app below. Text keeps its final reading width during the resize. Recent output preserves terminal colors, omits unused trailing terminal rows, and opens at the latest line. Scrolling up pauses following until the view returns to the bottom.

Send sits below the full-width reply field. Command + Enter sends the reply; standard macOS editing shortcuts work in the field, including Command + A to select all.

Answer options scroll horizontally without a scrollbar, with Auto-yes fixed on the right for questions. Resolved or dismissed cards leave the active stack after 180 ms, including when answered from another client. They remain readable when opened from History. Status-update payloads can put supporting information in `data.details` to show it only after opening Details.

Clicking another app releases keyboard focus while keeping a review card visible. Once a card has appeared, changes to macOS Focus do not hide it. Click the bar background or press Escape to fold it away without answering. Permission cards follow the live terminal prompt and remain pending through temporary session-metadata lookup failures. Replies still check the bound agent and current prompt before sending.

Following macOS Focus requires notification and Focus access for **ClawTab Daemon**. When Focus status is unavailable or Focus is active, delivery goes through macOS notifications. macOS then applies its notification settings and Focus allowlist. Independent mode allows the overlay and its sound regardless of Focus. Selecting Both uses the native notification for sound.

## Settings file

The daemon reads `~/.config/clawtab/notifications.yaml` and reloads edits within a second. The desktop app is optional. Existing preferences migrate to this file when the daemon starts.

```sh
cwtctl nfn settings                       # Open settings in the notification surface
cwtctl nfn settings --json                # Show the path and current values
cwtctl nfn settings ./notifications.yaml  # Apply a YAML file
cwtctl nfn settings --stdin < ./notifications.yaml
cwtctl nfn settings --ui                  # Also opens the notification settings surface
```

Applying a partial file preserves unspecified values. Invalid values and unknown keys are rejected. Direct edits that are temporarily invalid leave the running configuration unchanged.

```yaml
delivery: enhanced       # enhanced, native, both
placement: notch         # notch, right, custom
focus: follow            # follow, independent
display: primary         # primary, built_in, pointer, or a display ID
preview_seconds: 8       # 2–120; status updates only
hover_expand: false
sound: true
menu_bar_icon: true      # ClawTab Daemon's menu bar icon
position: null
```

Dragging sets `placement: custom`, records the display ID, and saves `position: {right: 100, top: 40}` in points from the display's usable top-right corner. Cards grow left and down from this anchor and stay within the display. Choose Notch or Right column to restore an automatic position.

The daemon owns the optional macOS menu bar icon. Clicking it opens the latest pending notification, or the collapsed bar when there are none. With no pending notifications, clicking the title opens History; collapsing History keeps the bar visible. Click the menu bar icon again to hide it. The collapsed count is plain text within the clickable, draggable title bar.

Use the list icon for Pending and History, and the ClawTab icon inside the window for notification settings. **Close bar** hides the window without dismissing notifications. A new notification or another menu bar click can open it again. The desktop app has a Dock icon and does not create a second menu bar icon. Change `menu_bar_icon` in this file or use the **Menu bar icon** checkbox in notification settings; no desktop app or restart is needed.

New notifications open their card when Pending or History is visible. A card being reviewed, an active bulk selection, and the settings form keep their current view.

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

For progress reports that need no decision, send `"template": "update"` without `--wait`. Update cards show **Got it**, with no reply composer. Use question or permission templates when the workflow needs an answer. Sending a notification alone does not pause an agent; the workflow must wait for and consume its response.

```sh
cwtctl nfn get REQUEST_ID
cwtctl nfn wait REQUEST_ID --timeout 60
cwtctl nfn cancel REQUEST_ID
cwtctl nfn show
cwtctl nfn settings
cwtctl nfn templates list
cwtctl nfn templates validate ./my-review.yaml
```

The CLI uses `CODEX_THREAD_ID` to find the sending Codex conversation, since shared command runners can carry another pane's `TMUX_PANE`. Managed agents use `CLAWTAB_SESSION_ID`, with the conversation checked by the daemon. Without a Codex thread, the CLI infers the pane from `CLAWTAB_SESSION_ID` or `TMUX_PANE`. An explicit `source.pane_id` takes precedence. Binary jobs should set `source.job_id` and `source.run_id`; they then use that run's log and do not inherit a terminal pane. Media supports HTTPS URLs and absolute local file paths. The native overlay streams local video in bounded chunks and releases it when the card closes. Local media is displayed by the daemon overlay; the in-app inbox supports HTTPS media.

Agent card headings show the group on the left and the tmux window title in the center. The pane title, agent title, and notification title are fallbacks when the window has no name. Senders can set `source.group` and `source.agent_title` to override the displayed labels. Questions use their matched ClawTab group; other tmux notifications use the owning session. Full labels are available on hover.

The default response destination, `result`, records a choice for the caller to consume. `agent_message` sends the decision and optional feedback to the originating live agent instead; it cannot be combined with `--wait`. Posting to a social network, touching a security key, granting permissions, and installing a background job remain the responsibility of the requesting workflow.

An explicit request can supply up to 32 actions. All options appear in one horizontally scrolling row of rounded, single-line buttons:

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

Agent cards have a **…** menu beside their title with **Auto-yes**, Agent controls, and Dismiss. Job cards omit the agent menu. Clicking the ClawTab icon or right-clicking the bar opens inline settings; `cwtctl nfn settings` opens the same view. Questions and permission cards show a yellow Auto-yes button on its own row below the answers. Their reply composer starts collapsed; click **Reply to agent** to open it. Reply drafts and open composers survive navigation. Cards show more context in a scrollable body. Auto-yes uses the same pane-specific setting as the remote app and tmux: future prompts from that agent are automatically answered until it is turned off. Its state stays synchronized with other clients, and stale sessions cannot toggle a replacement agent.

Action kinds are `choice` (default), `focus`, `auto_yes`, `model`, and `plugin`. Model and plugin actions use `value` for the model or installed action ID and `parameters` for string values, such as reasoning `effort`. The **… > Agent controls** menu offers Codex model selection and available installed plugin actions without opening Details.

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

Run local GUI checks in Tart from the parent checkout with `python3 scripts/test-notifications-tart.py`. The runner uses the shared bmux VM queue, copies only test sources into the guest, runs renderer checks in WebKit and native keyboard, geometry, settings, and menu bar checks, then saves logs and screenshots under `artifacts/tart/`. Set `CLAWTAB_TART_RUNNER` if the shared runner is elsewhere. Unit tests and type checks can run on the host.

On a disposable macOS CI desktop, generate a fixture with `node desktop/tests/nfn-fixture.mjs /tmp/clawtab-nfn-fixture.html` and run `nfn-webkit.m` with that HTML and `nfn-browser-check.js`. The renderer checks cover stable arrivals, drafts, custom layout order, duplicate clicks, log polling, and queue pagination. Use `--native` when generating the fixture for `nfn-native.m`.
