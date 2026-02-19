# Telegram Integration

ClawdTab can send job notifications and accept commands through a Telegram bot.

## Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and get the bot token
2. In ClawdTab, go to the Telegram panel
3. Enter the bot token -- ClawdTab validates it and shows the bot username
4. Send any message to your bot from Telegram
5. ClawdTab detects your chat ID via polling and adds it to the allowlist
6. Test the connection

### Configuration

```yaml
telegram:
  bot_token: "123456:ABC-DEF..."
  chat_ids: [12345678, 87654321]   # authorized chat IDs (allowlist)
  chat_names:
    "12345678": "Personal"
  notify_on_success: true
  notify_on_failure: true
  agent_enabled: false
```

## Notifications

Job completion notifications are sent automatically:

```
ClawdTab: Job daily-backup completed
ClawdTab: Job deploy failed (exit 1)
```

Controlled by `notify_on_success` and `notify_on_failure` flags.

### Per-Job Routing

Set `telegram_chat_id` on a job to route its notifications to a specific chat instead of the global `chat_ids` list.

### Real-Time Output Relay

For tmux jobs (Claude/Folder), the monitor captures pane output every 5 seconds and relays new lines to Telegram as `<pre>` blocks. Messages are auto-split at 4096 characters (Telegram's limit).

## Agent Mode

When `agent_enabled: true`, ClawdTab polls for incoming messages (8-second interval, 30-second long-poll timeout) and responds to slash commands.

Only messages from authorized `chat_ids` are processed.

### Commands

| Command | Action |
|---------|--------|
| `/help` or `/start` | Show available commands |
| `/jobs` or `/list` | List all jobs with type, cron, enabled status |
| `/status` | Show all job statuses with timestamps |
| `/run <name>` | Trigger a job |
| `/pause <name>` | Pause a running job |
| `/resume <name>` | Resume a paused job |
| `/agent <prompt>` | Run Claude Code with an ad-hoc prompt |

### Polling Behavior

- Agent polling and setup polling are mutually exclusive
- During Telegram setup in the GUI, agent polling pauses to avoid competing for `getUpdates`
- Resumes automatically when setup completes
