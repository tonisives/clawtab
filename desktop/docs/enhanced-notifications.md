# Messages and notifications

Use `cwtctl message` for updates, questions, approvals, and completion messages. Desktop, mobile, and Telegram share a stored message ID and response. Existing `cwtctl nfn` commands and `cwtctl telegram send TEXT` remain available as aliases.

```sh
cwtctl message send "Build finished" --kind completed
cwtctl message send "Which branch should I use?" --kind question --wait
cwtctl message send "Ship this release?" --choice "ship=Ship" --choice "revise=Revise" --wait
cwtctl message send "Review needed" --channel desktop --channel telegram
cwtctl message send "Build failed" --kind failed --channel mobile
cwtctl message list --pending
cwtctl message reply MESSAGE_ID "Use beta"
cwtctl message reply MESSAGE_ID --action ship
cwtctl message dismiss MESSAGE_ID
```

### Desktop and mobile delivery

Messages appear locally by default. While a message is still pending, ClawTab also sends it to mobile after 60 seconds without keyboard or mouse activity, or when the Mac locks or its screen sleeps. A message that arrives while the Mac is idle goes to mobile immediately. Reading or collapsing a card keeps it pending; answering or dismissing it stops escalation. Delivery receipts prevent repeat pushes for the same message.

Set `mobile_when_idle: false` to keep automatic delivery local, or change `idle_seconds` in notification settings. Explicit `--channel mobile` sends immediately. Repeat `--channel` to include several channels; `--channel telegram` alone sends only to Telegram. Mobile push uses the signed-in account's registered iOS devices and requires a relay with push configured. Pending messages and recent history also appear in the mobile inbox. Replies made offline are saved and submitted when the originating host reconnects.

Telegram uses the configured chats; `--chat ID` selects one. Questions include choice buttons and accept a reply to the bot's message. The first accepted answer resolves the shared message, and buttons are removed from its Telegram copies. Terminal log streaming and typing indicators continue using their existing Telegram settings.

The daemon owns the notification queue and the macOS overlay. Cards remain available while the desktop app is closed. On macOS 12 or later, cards appear below the notch on the selected display, or in a right column on displays without a notch. Settings also allow the right column on every display.

Click the ClawTab icon to configure position, display, delivery, sound, and Focus inside the notification surface. Changes save immediately to `notifications.yaml`. The desktop app also offers **Settings > Notifications** and layout previews. The first card shows the message, quick choices, and a reply field with a Send button. Its colors and action buttons follow the remote app. Review, question, and permission cards stay open until answered or collapsed. Status updates collapse to a pending count after eight seconds, pausing on hover.

Use the previous/next arrows to move between notifications, or Command/Ctrl + Shift + [ / ]. Each card keeps its reply draft. Once you start browsing or answering, cards stay open until the queue is finished or you collapse it. Got it, replies, answer choices, Auto-yes, Open agent, and Dismiss immediately advance to the next card while the action completes. A failed action returns after the card being read, with its error and reply draft intact. New requests queue without replacing the current card. Click the bar background to open or collapse it. The ClawTab icon opens notification settings. The list icon opens Pending and History; click it again to return to the previous card. Drag the bar background to move it, including away from the notch. The dropped position is saved. Pending rows have selection checkboxes and a dismiss button. Select all includes unloaded pages, and Dismiss keeps the cards in History without sending a decision to an agent. Details widens the card and adds a larger scrollable area for the full message, attachments, and recent output. Details stays at the bottom left, including when expanded. Open agent is available on agent cards; Go to job reveals the originating job folder in Finder. Open agent selects the originating conversation in an attached terminal, including when that terminal currently shows a different tmux session.

The black, borderless notch surface reaches the physical top edge of the screen and covers the camera cutout's lower corners. Its collapsed width matches the measured cutout. Width and height animate together while the top stays attached. Display space limits the expanded size. Reduce Motion disables size animations.

The native canvas stays fixed while the card animates inside it, and transparent space passes pointer events through to the app below. Text keeps its final reading width during the resize. Recent output preserves terminal colors, omits unused trailing terminal rows, and opens at the latest line. Scrolling up pauses following until the view returns to the bottom.

Send sits below the full-width reply field. Command + Enter sends the reply; standard macOS editing shortcuts work in the field, including Command + A to select all.

Answer options scroll horizontally without a scrollbar, with Auto-yes on its own row below the answers for questions. Cards answered or dismissed from another client leave the active stack after 180 ms. They remain readable when opened from History. Status-update payloads can put supporting information in `data.details` to show it only after opening Details.

Clicking another app releases keyboard focus while keeping a review card visible. Once a card has appeared, changes to macOS Focus do not hide it. Click the bar background or press Escape to fold it away without answering. Permission cards follow the live terminal prompt and remain pending through temporary session-metadata lookup failures. Replies still check the bound agent and current prompt before sending.

Following macOS Focus requires notification and Focus access for **ClawTab Daemon**. When Focus status is unavailable or Focus is active, delivery goes through macOS notifications. macOS then applies its notification settings and Focus allowlist. Independent mode allows the overlay and its sound regardless of Focus. Selecting Both uses the native notification for sound.

## Settings file

The daemon reads `~/.config/clawtab/notifications.yaml` and reloads edits within a second. The desktop app is optional. Existing preferences migrate to this file when the daemon starts.

```sh
cwtctl message settings                       # Open settings in the notification surface
cwtctl message settings --json                # Show the path and current values
cwtctl message settings ./notifications.yaml  # Apply a YAML file
cwtctl message settings --stdin < ./notifications.yaml
cwtctl message settings --ui                  # Also opens the notification settings surface
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
mobile_when_idle: true
idle_seconds: 60          # 10–3600; keyboard and mouse inactivity
position: null
```

Dragging sets `placement: custom`, records the display ID, and saves `position: {right: 100, top: 40}` in points from the display's usable top-right corner. Cards grow left and down from this anchor and stay within the display. Choose Notch or Right column to restore an automatic position.

The daemon owns the optional macOS menu bar icon. Clicking it opens the latest pending notification, or the collapsed bar when there are none. With no pending notifications, clicking the title opens History; collapsing History keeps the bar visible. Click the menu bar icon again to hide it. The collapsed count is plain text within the clickable, draggable title bar.

Use the list icon for Pending and History, and the ClawTab icon inside the window for notification settings. **Close bar** hides the window without dismissing notifications. A new notification or another menu bar click can open it again. The desktop app has a Dock icon and does not create a second menu bar icon. Change `menu_bar_icon` in this file or use the **Menu bar icon** checkbox in notification settings; no desktop app or restart is needed.

New notifications open their card when Pending or History is visible. A card being reviewed, an active bulk selection, and the settings form keep their current view.

## Submit a request

Agent prompts and job notifications enter the queue automatically. Agents and scripts can also submit JSON:

```sh
cwtctl message send --stdin --wait --timeout 300 <<'JSON'
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

For progress reports that need no decision, send `"template": "update"` without `--wait`. Update cards show **Got it**, which dismisses the notification without submitting a result or checking the agent session. Use question or permission templates when the workflow needs an answer. Sending a notification alone does not pause an agent; the workflow must wait for and consume its response.

Interactive agents started from a terminal or ClawTab send an update card when they finish a turn. **Open session** returns to the originating conversation and dismisses the notification from Pending; it stays in History. **Open agent** does the same for other agent cards. If opening the session fails, the card stays available to retry. **Got it** dismisses the completion without sending a response. Desktop and remote agent completion notifications are enabled by default and can be changed separately in Settings → Notifications. Permission waits and errors do not count as completions, and restarting the daemon does not replay old completions. Scheduled jobs use their own finish notification settings.

```sh
cwtctl message get REQUEST_ID
cwtctl message wait REQUEST_ID --timeout 60
cwtctl message cancel REQUEST_ID
cwtctl message show
cwtctl message settings
cwtctl message templates list
cwtctl message templates validate ./my-review.yaml
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

Agent cards have a **…** menu beside their title with **Auto-yes**, Agent controls, and Dismiss. Job cards omit the agent menu. Clicking the ClawTab icon or right-clicking the bar opens inline settings; `cwtctl message settings` opens the same view. Questions and permission cards show a yellow Auto-yes button on its own row below the answers. Their reply composer starts collapsed; click **Reply to agent** to open it. Reply drafts and open composers survive navigation. Cards show more context in a scrollable body. Auto-yes uses the same pane-specific setting as the remote app and tmux: future prompts from that agent are automatically answered until it is turned off. Its state stays synchronized with other clients, and stale sessions cannot toggle a replacement agent.

Action kinds are `choice` (default), `focus`, `auto_yes`, `model`, and `plugin`. Model and plugin actions use `value` for the model or installed action ID and `parameters` for string values, such as reasoning `effort`. The **… > Agent controls** menu offers Codex model selection and available installed plugin actions without opening Details.

## Tasks in the message bar

The circular indicator opens a checklist grouped by ClawTab group. Its number shows remaining tasks; the ring shows completion. Add a task with its group, check completed items, or open the linked agent. Agent progress appears below each task. An agent's `done` status stays separate from the source checkbox so the controller can review the result.

Link an existing Markdown checklist instead of importing a copy:

```sh
cwtctl nfn todos link /path/to/todo-today.md /path/to/agents.json
cwtctl nfn todos list
```

The source and optional agent mapping can also be changed under **Source and agent settings**. Level-two Markdown headings define groups; indented checkboxes remain subtasks. The daemon rereads the source, mapping, and agent status files every three seconds. Adding or checking a task writes back to the same note, preserving surrounding content. Repeated additions of the same text in the same group leave one task.

Agent mappings use the controller's `tasks` and `existing` arrays: `match` or `covers` associates task text, `session` identifies the group, `pane` and `window_id` identify the agent, and `status` points to its progress JSON. Subtasks share their parent's agent unless they have their own assignment.

For unassigned tasks, enter a working directory under **Source and agent settings**, then choose **Start agent**. ClawTab opens a new window in that group's existing tmux session with Codex Sol 6.1 and high reasoning. It registers the agent in the linked controller mapping. Links, prompts, and new-agent status files live under the ClawTab configuration directory; the note remains authoritative across restarts.

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

Run Rust tests and frontend builds through the shared macOS worker:

```sh
~/.agents/scripts/buildctl status
~/.agents/scripts/buildctl cargo -- test --no-default-features --lib nfn:: -j4
~/.agents/scripts/buildctl run --prepare-node -- pnpm --dir desktop build
```

Run local GUI checks in Tart from the parent checkout with `python3 scripts/test-notifications-tart.py`. The runner uses the shared bmux VM queue, copies only test sources into the guest, runs message and todo renderer checks in WebKit and native keyboard, geometry, settings, and menu bar checks, then saves logs and screenshots under `artifacts/tart/`. Set `CLAWTAB_TART_RUNNER` if the shared runner is elsewhere. Use `--public-root` to test a separate public worktree.

On a disposable macOS CI desktop, generate a fixture with `node desktop/tests/nfn-fixture.mjs /tmp/clawtab-nfn-fixture.html` and run `nfn-webkit.m` with that HTML and `nfn-browser-check.js`. The renderer checks cover stable arrivals, drafts, custom layout order, duplicate clicks, log polling, and queue pagination. Use `--native` when generating the fixture for `nfn-native.m`.
