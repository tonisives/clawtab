"""Run IAP persistence regressions against a disposable worker-local database."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
os.environ["LC_ALL"] = "C"
os.environ["LANG"] = "C"
binary = shutil.which("initdb")
if binary is None:
    binary = next((str(path) for version in ("18", "17", "16")
                   if (path := Path(f"/opt/homebrew/opt/postgresql@{version}/bin/initdb")).exists()), None)
if binary is None:
    raise SystemExit("PostgreSQL is required in the shared build worker")
tools = Path(binary).parent
with tempfile.TemporaryDirectory(prefix="iap-", dir="/tmp") as temporary:
    data = Path(temporary) / "data"
    subprocess.run([binary, "-D", str(data), "-U", "postgres", "-A", "trust", "--no-locale"], check=True, stdout=subprocess.DEVNULL)
    try:
        started = subprocess.run([str(tools / "pg_ctl"), "-D", str(data), "-l", str(Path(temporary) / "postgres.log"), "-o", f"-h 127.0.0.1 -p 55439 -k {temporary}", "-w", "start"])
        if started.returncode:
            raise RuntimeError((Path(temporary) / "postgres.log").read_text())
        env = dict(os.environ, IAP_TEST_DATABASE_URL="postgresql://postgres@127.0.0.1:55439/postgres")
        subprocess.run(["cargo", "test", "-j4", "routes::iap::tests", "--", "--ignored", "--test-threads=1"], cwd=root / "relay", env=env, check=True)
    finally:
        subprocess.run([str(tools / "pg_ctl"), "-D", str(data), "-m", "immediate", "-w", "stop"], check=False)
