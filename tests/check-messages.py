#!/usr/bin/env python3
"""Validate message routing, replies, and notification settings on the shared worker."""
import json
import os
from pathlib import Path
import subprocess
import time

root = Path(__file__).resolve().parent.parent
if os.environ.get("BUILD_SERVICE_WORKER") != "1":
    raise SystemExit("Run with buildctl run --cwd desktop --prepare-node -- python3 ../tests/check-messages.py")

results = root / "dist/message-checks"
results.mkdir(parents=True, exist_ok=True)
checks = [
    ("lifecycle", ["cargo", "test", "--manifest-path", "desktop/src-tauri/Cargo.toml", "--no-default-features", "--lib", "nfn::", "-j4"]),
    ("cli", ["cargo", "check", "--manifest-path", "desktop/src-tauri/Cargo.toml", "--no-default-features", "--bin", "cwtctl", "-j4"]),
    ("relay", ["cargo", "test", "--manifest-path", "relay/Cargo.toml", "-j4"]),
    ("desktop", ["pnpm", "--dir", "desktop", "build"]),
    ("mobile", ["pnpm", "--dir", "remote", "exec", "tsc", "--noEmit"]),
    ("replies", ["node", "--test", "tests/message-actions.test.cjs", "tests/agent-alert-notifications.test.cjs", "tests/notification-details.test.cjs", "tests/remote-client.test.cjs", "remote/scripts/test-auto-yes.cjs"]),
    ("surface", ["bash", "desktop/tests/check-messages.sh"]),
]
report = {}
for name, command in checks:
    started = time.monotonic()
    print(f"Checking {name}", flush=True)
    log = results / f"{name}.log"
    with log.open("w") as output:
        result = subprocess.run(command, cwd=root, stdout=output, stderr=subprocess.STDOUT)
    report[name] = {"exit_code": result.returncode, "seconds": round(time.monotonic() - started, 1)}
    print(f"{name}: {'passed' if result.returncode == 0 else 'failed'} ({report[name]['seconds']}s)", flush=True)
    if result.returncode:
        print(log.read_text(errors="replace")[-6000:], flush=True)
    (results / "report.json").write_text(json.dumps(report, indent=2) + "\n")
raise SystemExit(int(any(item["exit_code"] for item in report.values())))
