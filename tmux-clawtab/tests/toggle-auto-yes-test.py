#!/usr/bin/env python3
"""Exercise toggle feedback without contacting the daemon or a real tmux server."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/toggle-auto-yes.sh"

class ToggleTest(unittest.TestCase):
    def run_toggle(self, result, enabled=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            tmux = root / "tmux"
            tmux.write_text('''#!/bin/bash
printf '%s\n' "$*" >> "$TEST_ROOT/log"
case "$1" in
 display-message) echo codex ;;
 show-option) exit 0 ;;
 set-option)
  if [[ "$*" == *auto-yes-pending* ]]; then
   if [[ "$*" == *-pqu* ]]; then rm -f "$TEST_ROOT/pending"
   else touch "$TEST_ROOT/pending"; fi
  fi ;;
esac
''')
            cwt = root / "cwt"
            cwt.write_text('''#!/bin/bash
if [ "$3" = toggle ]; then
 test -f "$TEST_ROOT/pending" || exit 90
 printf 'toggle\n' >> "$TEST_ROOT/log"
 exit "$TEST_RESULT"
fi
[ "$TEST_ENABLED" = 1 ]
''')
            tmux.chmod(0o755)
            cwt.chmod(0o755)
            env = dict(os.environ, PATH=f"{root}:" + os.environ["PATH"],
                       TEST_ROOT=str(root), TEST_RESULT=str(result),
                       TEST_ENABLED=str(int(enabled)))
            proc = subprocess.run(["bash", str(SCRIPT), "%42"], env=env,
                                  capture_output=True, text=True)
            log = (root / "log").read_text()
            self.assertFalse((root / "pending").exists())
            self.assertIn("set-option -pt %42 @clawtab-auto-yes-pending 1", log)
            self.assertIn("set-option -pqu -t %42 @clawtab-auto-yes-pending", log)
            self.assertEqual(log.count("refresh-client -S"), 2)
            return proc, log

    def test_enable(self):
        proc, log = self.run_toggle(0, True)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("set-option -pt %42 @clawtab-auto-yes 1", log)

    def test_disable(self):
        proc, log = self.run_toggle(0)
        self.assertEqual(proc.returncode, 0)
        self.assertIn("set-option -pqu -t %42 @clawtab-auto-yes\n", log)

    def test_failure_preserves_confirmed_state(self):
        proc, log = self.run_toggle(1)
        self.assertEqual(proc.returncode, 1)
        self.assertNotIn("set-option -pt %42 @clawtab-auto-yes 1", log)
        self.assertNotIn("set-option -pqu -t %42 @clawtab-auto-yes\n", log)
        self.assertIn("auto-yes toggle failed", log)

if __name__ == "__main__":
    unittest.main()
