#!/usr/bin/env python3
"""Build and validate the remote message surface on the shared macOS worker."""
import json
import hashlib
import os
from pathlib import Path
import subprocess
import time

if os.environ.get("BUILD_SERVICE_WORKER") != "1":
    raise SystemExit("Run with buildctl run --cwd remote --prepare-node -- python3 ../tests/check-mobile-message-ui.py")

root = Path(__file__).resolve().parent.parent
results = root / "dist/mobile-message-checks"
results.mkdir(parents=True, exist_ok=True)
(results / "source.json").write_text(json.dumps({
    "revision": os.environ.get("BUILD_SOURCE_REVISION"),
    "remote_version": json.loads((root / "remote/package.json").read_text())["version"],
    "sha256": {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in [
        "shared/src/nfn/surface.html", "shared/src/nfn/surface.css", "shared/src/nfn/surface.js",
        "remote/src/lib/messageSurfaceDocument.generated.ts",
    ]},
}, indent=2) + "\n")
checks = [
    ("assets", ["node", "remote/scripts/message-surface.cjs"]),
    ("types", ["pnpm", "--dir", "remote", "exec", "tsc", "--noEmit"]),
    ("routing", ["node", "--test", "tests/mobile-message-ui.test.cjs", "tests/message-groups.test.cjs", "tests/agent-alert-notifications.test.cjs", "tests/notification-details.test.cjs", "tests/message-actions.test.cjs", "tests/remote-client.test.cjs", "remote/scripts/test-auto-yes.cjs"]),
    ("host", ["cargo", "test", "--manifest-path", "desktop/src-tauri/Cargo.toml", "--no-default-features", "--lib", "nfn::", "-j4"]),
    ("history", ["cargo", "test", "--manifest-path", "desktop/src-tauri/Cargo.toml", "--no-default-features", "--lib", "history::notification_sources::", "-j4"]),
    ("failure-source", ["cargo", "test", "--manifest-path", "desktop/src-tauri/Cargo.toml", "--no-default-features", "--lib", "failure_delivery_binds_the_exact_run_before_a_newer_job_can_start", "-j4"]),
    ("cli", ["cargo", "check", "--manifest-path", "desktop/src-tauri/Cargo.toml", "--no-default-features", "--bin", "cwtctl", "-j4"]),
    ("relay", ["cargo", "test", "--manifest-path", "relay/Cargo.toml", "-j4"]),
    ("desktop", ["pnpm", "--dir", "desktop", "build"]),
    ("web", ["pnpm", "--dir", "remote", "exec", "expo", "export", "--platform", "web", "--output-dir", "../dist/mobile-message-web"]),
    ("ios", ["pnpm", "--dir", "remote", "exec", "expo", "export", "--platform", "ios", "--output-dir", "../dist/mobile-message-ios"]),
]
report = {}
for name, command in checks:
    started = time.monotonic()
    print(f"Checking {name}", flush=True)
    with (results / f"{name}.log").open("w") as output:
        result = subprocess.run(command, cwd=root, stdout=output, stderr=subprocess.STDOUT)
    report[name] = {"exit_code": result.returncode, "seconds": round(time.monotonic() - started, 1)}
    print(f"{name}: {'passed' if result.returncode == 0 else 'failed'} ({report[name]['seconds']}s)", flush=True)
    if result.returncode:
        print((results / f"{name}.log").read_text(errors="replace")[-7000:], flush=True)
    (results / "report.json").write_text(json.dumps(report, indent=2) + "\n")
raise SystemExit(int(any(value["exit_code"] for value in report.values())))
