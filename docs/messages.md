# Message bar

ClawTab collects your coding agents' questions, permission prompts, updates, and completion messages in one bar. Read what needs attention, answer from the card, or open the agent's session.

![An agent question in the ClawTab message bar](https://cdn.clawtab.cc/assets/home/message-bar-hero-v12e-poster.jpg)

[Watch the 66-second demo](https://cdn.clawtab.cc/assets/home/message-bar-hero-v12e-narrated.mp4).

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

Use the previous and next arrows to browse cards. Each card keeps its reply draft, and new requests queue behind the card you are reading. Messages from the same conversation share a card with the latest actions. A failed answer returns with its draft and error intact.

The list icon opens **Pending** and **History**. Dismissing a message moves it out of Pending without answering the agent. Collapsing the bar leaves the message pending. **Ignore agent** hides that session's messages and stops its notifications; restore it from **Ignored agents**.

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
