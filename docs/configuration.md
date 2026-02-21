# Configuration

All configuration lives under `~/.config/clawtab/`.

## Directory Layout

```
~/.config/clawtab/
  settings.yaml              # App settings
  history.db                 # SQLite run history
  jobs/
    <project-slug>/          # grouped by project
      <job-name>/
        job.yaml             # Job definition
        logs/
          <run-id>.log       # Captured output per run
```

## settings.yaml

```yaml
default_tmux_session: tgs        # tmux session for job windows
default_work_dir: ~/workspace    # fallback working directory
claude_path: claude              # path to claude binary
preferred_editor: nvim           # editor for job.md files
preferred_terminal: auto         # terminal emulator (auto-detected)
setup_completed: true
secrets_backend: both            # "keychain", "gopass", or "both"
preferred_browser: chrome
tool_paths: {}                   # override tool paths, e.g. { tmux: /opt/bin/tmux }

telegram:                        # optional
  bot_token: "123456:ABC..."
  chat_ids: [12345678]
  chat_names:
    "12345678": "My Chat"
  notify_on_success: true
  notify_on_failure: true
  agent_enabled: false
```

All fields have defaults. The file is created by the setup wizard or on first settings save.

## Job Definition (job.yaml)

Each job is stored at `~/.config/clawtab/jobs/<project-slug>/<job-name>/job.yaml`.

```yaml
name: myapp/deploy               # display name (project/job)
job_type: folder                  # binary | claude | folder
enabled: true
path: ""                          # binary path or prompt file
args: []                          # command arguments (binary jobs)
cron: "0 0 * * *"                # standard cron expression
secret_keys: [AWS_KEY, DB_PASS]  # secrets injected as env vars
env:                              # static env vars
  ENVIRONMENT: production
work_dir: null                    # overrides default_work_dir
tmux_session: main               # overrides default_tmux_session
aerospace_workspace: "3"         # move tmux window to this workspace
folder_path: /project/.cwt       # .cwt directory (folder jobs)
job_name: deploy                  # subfolder within .cwt/ (folder jobs)
telegram_chat_id: 12345678       # per-job notification routing
group: default                   # grouping label
slug: myapp/deploy               # auto-generated identifier
```

### Slug Generation

Slugs are derived from `folder_path` (or `name`) + `job_name`:

1. Project part: last path component (excluding `.cwt`), slugified
2. Job part: `job_name` field (defaults to `"default"`), slugified
3. Combined as `project-slug/job-name`
4. Slugify: lowercase, keep `[a-z0-9-]`, collapse dashes, truncate at 20 chars
5. Deduplicate with `-2`, `-3` suffixes

### Cron Expressions

Standard 5-field cron format: `minute hour day month weekday`

| Expression | Schedule |
|------------|----------|
| `0 0 * * *` | Daily at midnight |
| `*/5 * * * *` | Every 5 minutes |
| `0 9 * * 1-5` | Weekdays at 9am |
| `30 */2 * * *` | Every 2 hours at :30 |

The scheduler polls every 30 seconds and checks if any scheduled time falls within the last polling window.
