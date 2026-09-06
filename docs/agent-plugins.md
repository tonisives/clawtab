# Local Executable Plugins

No actions are installed by default. ClawTab has no built-in plugin actions. Local plugins are optional packages that you place on your machine.

## Package layout

Each plugin lives at:

```text
~/.config/clawtab/agent-plugins/<plugin-id>/plugin.yaml
```

The directory can also contain executable files referenced by an action's `command`. Relative command paths resolve inside the plugin directory. ClawTab uses hot discovery: it scans plugin directories when it lists or starts actions, so adding or editing a package does not require a daemon restart.

The manifest ID must start with `local.`. The directory name must exactly match the manifest ID.

## Manifest

Manifests use `schema_version: 2` and have these top-level fields:

| Field | Meaning |
| --- | --- |
| `schema_version` | Must be `2`. |
| `id` | Plugin identifier. It must use the `local.*` namespace. |
| `name` | Human-readable plugin name. |
| `version` | Plugin version shown in the installed-plugin list. |
| `actions` | One or more action definitions. |

Each action defines `id`, `title`, `description`, an argv-array `command`, `activation.providers`, optional `activation.versions`, `capabilities`, `timeout_seconds`, and `parameters`:

```yaml
schema_version: 2
id: local.example
name: Example local actions
version: 1.0.0
actions:
  - id: inspect
    title: Inspect the current session
    description: Read the current agent session and report a short result.
    command: ["./inspect.sh", "--json"]
    activation:
      providers: ["codex"]
      versions: ["0.151.*"]
    capabilities: ["agent.read"]
    timeout_seconds: 60
    parameters:
      - name: mode
        title: Mode
        description: How much session information to include.
        kind: choice
        required: true
        default_value: quick
        placeholder: Choose a mode
        options: [quick, full]
```

`command` is an argv array. Each item is one process argument. Use a relative path for an executable in the package, or a program name resolved through `PATH`; it is not a shell command string.

`activation.providers` is required. `activation.versions` is optional. A version entry can be an exact version such as `0.151.2` or a patch-family pattern such as `0.151.*`. There are no comparator ranges. If `versions` is omitted, the action matches any version of the listed provider.

`timeout_seconds` must be between `1` and `3600`.

## Parameters

Each parameter has `name`, `title`, `kind`, and `required`. `required` is a boolean and defaults to `false`. These fields are optional:

- `description`
- `default_value`
- `placeholder`
- `options`

Supported `kind` values are:

| Kind | Use |
| --- | --- |
| `string` | Free-form text. |
| `boolean` | The string value `true` or `false`. |
| `choice` | One value from `options`. `options` is required for this kind. |
| `model` | A provider model. Without explicit `options`, ClawTab supplies the enabled models for the current provider. |
| `effort` | A reasoning-effort value. Without explicit `options`, ClawTab supplies `low`, `medium`, `high`, `xhigh`, and `max`. |

Parameter values are passed to the executable as a JSON object in `CLAWTAB_PARAMETERS_JSON`. CLI parameters use `name=value`.

## Capabilities

Actions declare the host operations they need:

| Capability | Allows |
| --- | --- |
| `agent.read` | Read agent session and state. |
| `pane.input` | Send text, send keys, or submit text to the pane. |
| `agent.wait` | Wait for an agent state. |
| `agent.model` | Select a model or restore the baseline model and effort. |
| `composer.draft` | Stash or restore a composer draft. |

Progress, context, and result reporting do not need an extra capability. A host operation that needs a capability the action did not declare fails.

## Runtime environment

Plugin processes receive a sanitized environment. ClawTab exposes these plugin-facing variables:

```text
CLAWTAB_CLI
CLAWTAB_PLUGIN_ID
CLAWTAB_ACTION_ID
CLAWTAB_RUN_ID
CLAWTAB_PANE_ID
CLAWTAB_PROVIDER
CLAWTAB_AGENT_VERSION
CLAWTAB_WORKING_DIRECTORY
CLAWTAB_PARAMETERS_JSON
```

`CLAWTAB_CLI` is the `cwtctl` executable to use for host calls. `CLAWTAB_PARAMETERS_JSON` contains the validated parameter map. `CLAWTAB_WORKING_DIRECTORY` is the working directory of the target pane.

`CLAWTAB_PLUGIN_TOKEN` and `CLAWTAB_PLUGIN_SOCKET` are injected internals used to authenticate host calls. Do not log, print, or include them in results.

## Host commands

Plugin scripts call the ClawTab host through `CLAWTAB_CLI`:

```sh
"$CLAWTAB_CLI" plugin host context
"$CLAWTAB_CLI" plugin host progress <percent> <message>
"$CLAWTAB_CLI" plugin host result [json]
"$CLAWTAB_CLI" plugin host session
"$CLAWTAB_CLI" plugin host state
"$CLAWTAB_CLI" plugin host send-text [text]
"$CLAWTAB_CLI" plugin host send-key <key>
"$CLAWTAB_CLI" plugin host submit-text [text]
"$CLAWTAB_CLI" plugin host wait-state <state> [timeout_ms]
"$CLAWTAB_CLI" plugin host select-model <model> [effort]
"$CLAWTAB_CLI" plugin host restore-baseline
"$CLAWTAB_CLI" plugin host stash
"$CLAWTAB_CLI" plugin host restore
```

`context`, `session`, and `state` return JSON. `progress` updates the run shown by ClawTab. `result` accepts a JSON value. `send-text`, `submit-text`, and `result` read from standard input when their optional argument is omitted. Use standard input for text that should not appear in a process argument list.

The host token is valid only during the active run. The target pane is checked again for host operations, so a plugin cannot continue operating on a different agent process after the pane changes.

## Approval and trust

Local executables are trusted user code. ClawTab does not sandbox them. They run with the permissions of the user who runs ClawTab and can access the filesystem, network, and other local resources available to that user.

Review a plugin's command paths and capabilities before approving it:

```sh
cwtctl plugin installed --json
cwtctl plugin approve <plugin-id> <fingerprint>
cwtctl plugin revoke <plugin-id>
```

Approval controls access to the ClawTab host API and is tied to the plugin fingerprint. If the fingerprint changes, approval is no longer valid and must be renewed after reviewing the new package.

Activation mismatches are hidden from the action list. A matching action from an untrusted plugin is shown as unavailable until approval. Invalid plugin packages are unavailable and are reported by `cwtctl plugin installed --json`.

## Action commands

Use these commands for actions in the current pane:

```sh
cwtctl plugin list [pane_id] [--json]
cwtctl plugin <name> run [pane_id] [key=value ...]
cwtctl plugin <name> status <run_id>
cwtctl plugin <name> cancel <run_id>
```

When `pane_id` is omitted, `cwtctl` uses `$TMUX_PANE`. `<name>` can be a full action ID or a unique action suffix, with dashes and underscores treated equivalently. Runs return a JSON record immediately. Use `status` to poll the run.

Codex model switching also has a first-class command for latency-sensitive local integrations:

```sh
cwtctl codex set-model <model> <effort> [pane_id]
```

The command waits for the live Codex TUI to confirm the selection and preserves any composer draft. It does not launch an external plugin process. If `pane_id` is omitted, it uses `$TMUX_PANE`.

## Small Bash example

This package declares one Codex-only action with no parameters. The action submits literal text through standard input, so the note is not exposed in a process argument. It reports a JSON result the same way.

```text
~/.config/clawtab/agent-plugins/local.codex-note/
├── plugin.yaml
└── run.sh
```

`plugin.yaml`:

```yaml
schema_version: 2
id: local.codex-note
name: Codex note
version: 1.0.0
actions:
  - id: submit-note
    title: Submit note
    description: Submit a fixed note to the current Codex pane.
    command: ["./run.sh"]
    activation:
      providers: ["codex"]
    capabilities: ["pane.input"]
    timeout_seconds: 30
    parameters: []
```

`run.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

"$CLAWTAB_CLI" plugin host progress 10 "Submitting note"

printf '%s' 'Please review the current task.' |
  "$CLAWTAB_CLI" plugin host submit-text

"$CLAWTAB_CLI" plugin host progress 80 "Reporting result"
printf '%s' '{"submitted":true}' |
  "$CLAWTAB_CLI" plugin host result
```

## Session shortcuts on mobile

The pane's `...` menu opens **Agent actions and pane details** on mobile, including
provider-specific plugin parameters, run progress, and cancellation. Native process
screens and running job screens use the same action list as the wider layout.

`etc/agent-plugins/local.session-shortcuts` contains an optional package for Codex
and Claude: plan/normal mode, compaction, conversation forking, and Claude model
selection from desktop's enabled models. Install it in the local plugin directory,
then review and approve its fingerprint as described above. Codex model selection
continues to use the separate `local.codex-model` package when installed.

Compaction, forking, and Claude model selection require an idle agent and an empty
composer. Unknown Claude terminal layouts are rejected instead of appending a
command to a draft. Shortcut completion means the command was sent; the terminal
shows any subsequent agent dialog or compaction progress.

The command mappings follow the [Codex CLI command reference](https://developers.openai.com/codex/cli/slash-commands/)
and [Claude command reference](https://code.claude.com/docs/en/commands).
