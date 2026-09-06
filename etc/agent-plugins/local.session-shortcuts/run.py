"""Provider-specific shortcuts invoked through the authenticated ClawTab plugin host."""
import json
import os
import re
import subprocess
import sys


def host(*arguments):
    result = subprocess.run(
        [os.environ["CLAWTAB_CLI"], "plugin", "host", *arguments],
        capture_output=True, text=True, check=True, timeout=8,
    )
    return json.loads(result.stdout) if result.stdout.strip() else {}


def screen():
    return subprocess.run(
        ["tmux", "capture-pane", "-p", "-t", os.environ["CLAWTAB_PANE_ID"]],
        capture_output=True, text=True, check=True, timeout=3,
    ).stdout


def claude_composer_empty(captured):
    lines = captured.splitlines()
    prompts = [line.strip() for line in lines if line.lstrip().startswith("\u276f")]
    # Unknown UI states must not receive a slash command appended to user input.
    return bool(prompts) and prompts[-1] == "\u276f" and "esc to interrupt" not in captured.lower()


def main(action):
    provider = os.environ["CLAWTAB_PROVIDER"]
    if provider not in {"codex", "claude"}:
        raise ValueError("This provider has no session shortcuts")
    captured = screen()
    if provider == "codex":
        response = host("state")
        state = response.get("state", response)
        if not state.get("idle") or state.get("busy"):
            raise ValueError("Wait for the agent to become idle")
        if action != "toggle-plan" and state.get("draft_present"):
            raise ValueError("Send or clear the composer draft before using this shortcut")
    elif not claude_composer_empty(captured):
        raise ValueError("Wait for an empty Claude composer before using this shortcut")

    if action == "toggle-plan":
        if provider == "codex" or "plan mode" in "\n".join(captured.splitlines()[-6:]).lower():
            host("send-key", "BTab")
        else:
            host("submit-text", "/plan")
    elif action == "compact":
        host("submit-text", "/compact")
    elif action == "fork":
        host("submit-text", "/fork" if provider == "codex" else "/branch")
    elif action == "model" and provider == "claude":
        model = json.loads(os.environ.get("CLAWTAB_PARAMETERS_JSON", "{}"))["model"]
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", model):
            raise ValueError("Invalid model selection")
        host("submit-text", "/model " + model)
    else:
        raise ValueError("Unknown shortcut")
    host("progress", "100", "Shortcut sent to agent")
    host("result", json.dumps({"shortcut_sent": action}))


if __name__ == "__main__":
    try:
        main(sys.argv[1])
    except (KeyError, ValueError, subprocess.SubprocessError) as error:
        # Never include subprocess stdout, environment, or host credentials in errors.
        print(str(error) if isinstance(error, ValueError) else "Agent shortcut could not be sent", file=sys.stderr)
        sys.exit(1)
