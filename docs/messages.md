# Message bar

ClawTab collects your coding agents' questions, permission prompts, updates, and completion messages in one bar. Read what needs attention, answer from the card, or open the agent's session.

![An agent question in the ClawTab message bar](https://cdn.clawtab.cc/assets/home/message-bar-hero-v12e-poster.jpg)

[Watch the 66-second demo](https://cdn.clawtab.cc/assets/home/message-bar-hero-v12e-narrated.mp4).

## Markdown bodies

Desktop and mobile messages render Markdown: paragraphs, lists, headings, bold,
emphasis, inline code, fenced code blocks, quotes, tables, and links. Bare web
URLs are clickable. Keep titles plain text. Use short paragraphs or bullets,
backticks around paths and commands, and descriptive link labels. Add images
and videos through the attachment options.

For multiline messages, pass a JSON body through a quoted heredoc:

```sh
cwt message send --stdin <<'JSON'
{
  "title": "Review X browsing recordings",
  "body": "Open **Plugins > Built in > Recordings**.\n\n- Select the X collection sessions.\n- Check search, scrolling, and opened replies.\n- Compare the [collection dashboard](https://example.com/dashboard).\n\nFiles: `/Volumes/sam/movies/bmux/observations/`",
  "kind": "update",
  "template": "update"
}
JSON
```

## Get started on macOS

The message bar requires macOS 12 or later. Install the daemon and CLI, then start the background service:

```sh
brew install --cask tonisives/tap/clawtab
cwt daemon install
cwt daemon ping
```

The daemon owns the bar, so the desktop app can stay closed. Use Claude Code, Codex, or OpenCode with ClawTab's provider integration to receive agent prompts and turn-completion messages. Active-pane suppression avoids interrupting you with a question you are already viewing.

Press **Ctrl+Option+W** to expand the bar and give it keyboard focus. Press the shortcut again to collapse it and return to the previous app. Open **notification settings** from the ClawTab icon to change the shortcut, display, position, sound, or Focus behavior.

## Answer, inspect, or open the session

Questions and permissions show their available choices. Choose an answer or open **Reply** to type one. **Command+Enter** sends the reply. **Open** returns to the originating conversation; **Details** adds the full message, attachments, and recent terminal output in a scrollable area.

When a message includes web links, **Open** lists those destinations alongside
**Agent**. Completion cards discover links in the latest assistant reply for
Codex, Claude Code, OpenCode, and Hermes. Markdown labels become menu labels;
bare HTTP and HTTPS URLs work too. Duplicate destinations appear once. Links
stay with that completion when the agent starts another turn. The same Open
menu is available on desktop, web, iOS, and Android.

Use the previous and next arrows to browse cards. Each card keeps its reply draft, and new requests queue behind the card you are reading. Messages from the same conversation share a card with the latest actions. A failed answer returns with its draft and error intact.

The list icon opens **Pending** and **History**. Dismissing a message moves it out of Pending without answering the agent. Collapsing the bar leaves the message pending. **Ignore agent** hides that session's messages and stops its notifications; restore it from **Ignored agents**.

The bell beside a job's title toggles **Ignore successful runs** for that job. It uses the static job ID, such as `bmux/ci-repair`, across runs and agent title changes. Successful completion messages stay in History; failures, questions, approvals, and other updates keep their existing delivery settings. Restore success notifications with the bell in History or **Notify on success** under **Ignored agents**. The setting persists on the machine that runs the job and applies to all message channels.

Use `cwt message ignore-job-success GROUP/JOB` or `cwt message unignore-job-success GROUP/JOB` from the CLI. `cwt message ignored-agents` also lists jobs whose successful runs are ignored.

## Update a preview in place

Agents can edit a pending informational message by its returned ID:

```sh
cwt message update MESSAGE_ID --stdin <<'JSON'
{
  "data": {
    "outreach": { "body": "Revised reply text." }
  }
}
JSON
```

Updates keep the message ID, original queue position, source and links. `data`
merges recursively, so changing the draft body preserves the recipient and
original post URL. Optional `title`, `body` and `media` fields replace those
parts of the preview. An open card refreshes without a new arrival notification.

Outreach previews remain independent of other messages from the producing
agent. Dismissing a summary or closing that agent leaves its drafts pending.
Dismiss each draft when finished. Answered or dismissed messages and approval
reviews cannot be edited with this command.

## Use the keyboard

| Control | Action |
| --- | --- |
| Ctrl+Option+W | Focus or collapse the bar |
| h / l | Previous or next card while the bar has focus |
| o / d / r | Open the session, show Details, or open Reply |
| Command+Enter | Send from the reply field |
| Escape | Collapse without answering |
| Double-tap Option | Toggle keyboard hints while the bar has focus |

Reply fields keep normal text editing. Keyboard hints appear only while the bar has focus.

## Continue from your phone

Web Remote and iOS share the message queue and replies. By default, a still-pending message goes to mobile after 60 seconds without keyboard or mouse activity, or when the Mac locks or its screen sleeps. Messages arriving while the Mac is already idle go to mobile immediately. Answering or dismissing a message stops escalation.

Immediate mobile delivery is available with `--channel mobile`; Telegram delivery uses `--channel telegram`. These channels use your configured Remote account and Telegram chats. Web Remote is deployed separately, and native mobile changes require their corresponding app update.

## Add your own questions from a script

```sh
cwt message send "Ship this release?" \
  --choice "ship=Ship" --choice "revise=Revise" --wait
```

The command returns the stored message and its response. A wait timeout leaves the message pending. Your workflow decides what to do with the answer.

```sh
cwt message list --pending
cwt message focus MESSAGE_ID
cwt message reply MESSAGE_ID --action ship
cwt message send "Build finished" --kind completed
```

See the [CLI reference](cli-tui.md) for commands and the [message renderer and delivery reference](https://github.com/tonisives/clawtab/blob/main/desktop/docs/enhanced-notifications.md) for JSON requests, settings, and custom cards.

## Schedule a reminder

```sh
cwt message schedule "Check the embedding cap and backlog" --in 24h
cwt message schedule "Check the embedding cap and backlog" --at '2026-11-03T09:00:00+07:00'
cwt message scheduled
cwt message cancel MESSAGE_ID
```

Times passed to `--at` include a timezone. Durations support seconds, minutes,
hours, days, and weeks (`30s`, `15m`, `24h`, `1d`, `1w`). `message send` also
accepts these scheduling flags. The daemon stores reminders until they are due
and delivers overdue reminders when it next starts or wakes.

An agent-created reminder records its creator and conversation. **Open** returns
to that conversation, resuming it when needed. **Reply** resumes the conversation
and sends your text. **Got it** completes the reminder without opening a session.
Scheduling never starts an agent automatically.

Run the command from your own terminal, or add `--as-user`, to create a reminder
without a linked agent session. These reminders show who created them and can
be completed with **Got it**.

## Keep your task list beside your messages

The circular indicator opens a checklist grouped by ClawTab group. Add and complete tasks, inspect agent progress, or open the linked agent. Link an existing Markdown checklist to keep the note as the source:

```sh
cwt nfn todos link /path/to/todo-today.md /path/to/agents.json
cwt nfn todos list
```

The agent mapping is optional. Checkbox changes write back to the same note. Agent completion stays separate from the source checkbox so a controller can review the work.


## CRM draft previews

An update can carry `data.outreach` with `channel` (`email` or `social`),
`recipient`, `subject`, `body`, `platform`, `source_url`, `profile_url`,
`email_source` and `review_url`. The shared renderer shows an email or message
card with the exact copy and HTTPS source links. Review in CRM opens the saved
draft. Each draft stays separate in the queue even when several share a job or
conversation. Include the Codex `source.session_id`, `provider`, `cwd`, job/run
identity and a focus action to open or resume its drafting conversation.

## Agent identification

Messages can carry `source.agent` with `id`, `type`, and a string map `data`.
For tmux, use `{"id":"my-agent","type":"tmux","data":{"paneId":"%7"}}`.
`cwt message source` prints the current context. Send it using `--agent-id`,
`--agent-type`, and `--agent-data`, or `CWT_AGENT_ID`, `CWT_AGENT_TYPE`, and
`CWT_AGENT_DATA`. Explicit flags override JSON, then environment defaults.
Missing terminal context is resolved when sending; Open uses the recorded pane.
A changed or closed pane returns an error rather than searching other panes.

Message settings include **Require agent identification**. In
`notifications.yaml`, configure `require_agent_identity` and custom types:

```yaml
require_agent_identity: true
agent_definitions:
  editor:
    required_fields: [workspace]
    identifier_field: workspace
    focus_command: /absolute/path/to/focus-editor
```

Focus commands receive `CWT_AGENT_ID`, `CWT_AGENT_TYPE`, `CWT_AGENT_DATA`, and
`CWT_AGENT_ORIGIN` as environment variables. They have a ten second timeout.
Plain messages, jobs, browser messages, and standalone reminders remain supported.

### Overviews and swipeable sections

An update can keep an overview in `body` and include named card sections in
`data.sections`. Section IDs are unique within the message and card IDs are unique
across its sections. Top chevrons and keyboard navigation, and mobile swipes,
change cards within a section while preserving the overview and message identity.
This layout works for research results, reviews and other collections.

```json
{
  "kind": "update",
  "template": "update",
  "title": "Outreach review",
  "body": "Seven drafts ready for review.",
  "data": {
    "sections": [{
      "id": "posts",
      "title": "Posts",
      "cards": [{
        "id": "draft-1",
        "title": "Feedback on a DJ app",
        "body": "The author is testing transition recommendations.",
        "data": {"outreach": {"platform": "Reddit", "recipient": "builder", "source_excerpt": "Original post excerpt", "body": "Suggested reply text"}},
        "source": {"provider": "codex", "session_id": "saved-session", "cwd": "/workspace/crm"},
        "open_options": [
          {"label": "Original post", "url": "https://reddit.com/r/example/comments/post"},
          {"label": "Profile", "url": "https://reddit.com/user/builder"},
          {"label": "CRM", "url": "https://crm.tonis.dev/leads/lead"},
          {"label": "Agent", "kind": "agent"}
        ]
      }]
    }]
  }
}
```

Cards support Markdown `body`, optional `media`, an outreach preview in
`data.outreach`, and a recorded agent `source`. Agent opens resume that card's
conversation; each card remembers its opened pane separately. Without a card
source, Agent uses the message source.

Set `open_options` on a card or `data.open_options` on a message to configure
its Open menu. URL destinations use HTTPS and `kind: "agent"` opens the recorded
agent. An empty array hides the destinations. Outreach previews default to
Original post, Profile, CRM and Agent, plus Published email when available. Their
links appear in Open instead of below the draft.

Use at most 16 sections and 100 cards per section, within the existing payload
size limit. Sections remain independent of ordinary agent update threads.

Card stacks use a stable reading area with chevrons above it. The existing bottom Open button uses the selected card’s destinations. Outreach cards show the author once, an original-post excerpt and a reply arrow; project labels and repeated draft headings are omitted.
