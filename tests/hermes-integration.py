"""Run the opt-in Rust workflow against real Hermes and a local model.

Requires tmux, a Hermes v0.22.4 environment, clawtab-hook, and the compiled
clawtab_lib test binary. All profiles, terminal sessions and hook events are
disposable. Does not use a paid model or the installed ClawTab daemon.
"""

import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time


def run(argv, **kwargs):
    return subprocess.run(argv, check=True, text=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hermes", required=True, type=Path)
    parser.add_argument("--hook", required=True, type=Path)
    parser.add_argument("--test-binary", required=True, type=Path)
    parser.add_argument("--tui", action="store_true", help="Exercise the built node TUI instead of classic CLI")
    parser.add_argument("--inline-launcher", action="store_true", help="Exercise the bundled Python -c launcher shape (venv source installs)")
    parser.add_argument("--keep", action="store_true", help="Keep diagnostic files after stopping the test processes")
    args = parser.parse_args()
    hermes, hook, binary = (str(path.absolute()) for path in (args.hermes, args.hook, args.test_binary))
    for executable in (hermes, hook, binary):
        if not os.access(executable, os.X_OK):
            parser.error(f"Executable not found: {executable}")
    tmux = shutil.which("tmux")
    if not tmux:
        parser.error("tmux is required")
    root = Path(tempfile.mkdtemp(prefix="clawtab-hermes-test-")).resolve()
    if args.inline_launcher:
        python = Path(hermes).parent / "python3"
        if not python.is_file():
            parser.error("--inline-launcher requires python3 beside the Hermes executable")
        source = "import os, site, sys; sys.argv[0]='hermes'; from hermes_cli.main import main; sys.exit(main())"
        launcher = root / "hermes"
        launcher.write_text("#!/bin/sh\nexec " + shlex.join([str(python), "-I", "-c", source]) + ' "$@"\n')
        launcher.chmod(0o700)
        hermes = str(launcher)
    socket_name = root.name
    # A named profile pins identity even if a default active_profile exists.
    home = root / "profiles" / "test"
    home.mkdir(parents=True)
    spool = root / "clawtab-events"
    env = {**os.environ, "HERMES_HOME": str(home), "CLAWTAB_AGENT_HOOKS_DIR": str(spool), "CLAWTAB_SESSION_DIR": str(root / "managed-sessions")}
    for key in ("TMUX", "TMUX_PANE"):
        env.pop(key, None)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    base_url = f"http://127.0.0.1:{port}/v1"
    # Force an approval for one fixed harmless command; everything else follows
    # the real Hermes hook, tool, gateway and human-input implementations.
    approval = root / "require-approval.py"
    approval.write_text("import json,sys\np=json.load(sys.stdin)\nprint(json.dumps({'action':'approve','message':'ClawTab harmless test approval'} if p.get('tool_name')=='terminal' else {}))\n")
    events = ("on_session_start", "pre_llm_call", "on_human_input_request", "on_human_input_resolved", "on_session_end", "on_session_finalize")
    hooks = {event: [{"command": shlex.join([hook, "hermes", event]), "timeout": 3}] for event in events}
    hooks["pre_tool_call"] = [{"command": shlex.join([sys.executable, str(approval)]), "timeout": 3}]
    config = {
        "model": {"default": "clawtab-test", "provider": "custom", "base_url": base_url, "api_key": "local-test"},
        "display": {"interface": "cli"},
        "cli": {"expose_on_path": False},
        "memory": {"memory_enabled": False, "user_profile_enabled": False},
        "telemetry": {"shared_metrics": {"enabled": False, "send": False, "offer_version": 2}},
        "terminal": {"backend": "local"}, "hooks": hooks,
    }
    (home / "config.yaml").write_text(json.dumps(config))
    (home / "shell-hooks-allowlist.json").write_text(json.dumps({"approvals": [
        {"event": event, "command": entries[0]["command"]} for event, entries in hooks.items()
    ]}))
    wrapper_dir = root / "bin"
    wrapper_dir.mkdir()
    wrapper = wrapper_dir / "tmux"
    wrapper.write_text("#!/bin/sh\nexec " + shlex.join([tmux, "-L", socket_name]) + ' "$@"\n')
    wrapper.chmod(0o700)
    # A symlink is adopted by Hermes's launcher self-repair. Keep this wrapper
    # owned by the fixture so resume continues to use the tested environment.
    hermes_wrapper = wrapper_dir / "hermes"
    hermes_wrapper.write_text('#!/bin/sh\nexec "$CLAWTAB_HERMES_TEST_EXECUTABLE" "$@"\n')
    hermes_wrapper.chmod(0o700)
    env["CLAWTAB_HERMES_TEST_EXECUTABLE"] = hermes
    env["PATH"] = str(wrapper_dir) + os.pathsep + env.get("PATH", "")
    env["CLAWTAB_HERMES_TEST_SOCKET"] = socket_name
    model_log = (root / "model.log").open("w")
    model = subprocess.Popen([sys.executable, str(Path(__file__).with_name("hermes-model-server.py")), "--port", str(port)], stdout=model_log, stderr=subprocess.STDOUT)
    code = 1
    try:
        for _ in range(100):
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.05)
        else:
            raise RuntimeError("test model did not start")
        for index, prompt in enumerate(("CLAWTAB_TEST_HELLO", "CLAWTAB_TEST_SECOND")):
            prompt_file = root / f"prompt-{index}.md"
            prompt_file.write_text(prompt)
            interface = ["--tui"] if args.tui else ["--cli", "--base-url", base_url, "--api-key", "local-test"]
            query = ["--query", prompt] if args.tui else ["--query-file", str(prompt_file)]
            command = shlex.join(["/usr/bin/env", f"HERMES_HOME={home}", f"CLAWTAB_AGENT_HOOKS_DIR={spool}", hermes,
                "chat", *interface, "--provider", "custom", "--model", "clawtab-test", *query]) + "; exec /bin/sh"
            create = ["new-session", "-d", "-s", "hermes-test", "-x", "120", "-y", "40"] if index == 0 else ["new-window", "-d", "-t", "hermes-test", "-n", "second"]
            pane = run([tmux, "-L", socket_name, "-f", "/dev/null", *create, "-P", "-F", "#{pane_id}", "-c", str(root), command], capture_output=True, env=env).stdout.strip()
            env[f"CLAWTAB_HERMES_TEST_PANE_{'AB'[index]}"] = pane
            if index == 0:
                # Let the shared gateway finish its first boot before attaching
                # another client; concurrent cold boots can race profile locks.
                for _ in range(300):
                    screen = run([tmux, "-L", socket_name, "capture-pane", "-p", "-t", pane], capture_output=True).stdout
                    if "HERMES_TEST_REPLY" in screen:
                        break
                    time.sleep(0.1)
                else:
                    raise RuntimeError("first Hermes client did not complete its startup prompt")
        print(f"Isolated Hermes test: {root}", flush=True)
        result = subprocess.run([binary, "hermes_live_remote_workflow", "--ignored", "--nocapture", "--test-threads=1"], env=env, timeout=240)
        code = result.returncode
        if not code:
            title = run([hermes, "chat", "--cli", "--oneshot", "--quiet", "--toolsets", "clarify",
                         "--query", "Give a short title. Do not use tools."],
                        env=env, capture_output=True, timeout=60)
            if "HERMES_TEST_REPLY" not in title.stdout:
                raise AssertionError("Hermes one-shot title response missing")
            print("passed: one-shot title generation command", flush=True)
        if code:
            panes = subprocess.run([tmux, "-L", socket_name, "list-panes", "-a", "-F", "#{pane_id}"], capture_output=True, text=True).stdout.splitlines()
            for pane in set(panes):
                capture = subprocess.run([tmux, "-L", socket_name, "capture-pane", "-p", "-t", pane, "-S", "-100"], capture_output=True, text=True)
                (root / f"pane-{pane.lstrip('%')}.txt").write_text(capture.stdout)
    finally:
        subprocess.run([tmux, "-L", socket_name, "kill-server"], capture_output=True)
        # The private gateway records its owning profile. Check that exact path
        # before terminating it; never invoke host service-management commands.
        for owner in (home, root):
            pid_file = owner / "gateway.pid"
            if not pid_file.exists():
                continue
            record = json.loads(pid_file.read_text())
            if Path(record.get("hermes_home", "")).resolve() == owner:
                try:
                    os.kill(int(record["pid"]), signal.SIGTERM)
                except ProcessLookupError:
                    pass
        model.terminate()
        model.wait(timeout=10)
        model_log.close()
        if args.keep or code:
            print(f"Diagnostics retained: {root}", flush=True)
        else:
            shutil.rmtree(root)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
