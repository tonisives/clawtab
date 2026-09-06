import importlib.util
import os
import unittest
from pathlib import Path
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / 'etc/agent-plugins/local.session-shortcuts/run.py'
spec = importlib.util.spec_from_file_location('shortcuts', source)
shortcuts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(shortcuts)

class ShortcutsTests(unittest.TestCase):
    def run_shortcut(self, provider, action, captured='\u276f\n', state=None, parameters='{}'):
        calls = []
        def host(*args):
            calls.append(args)
            return {'state': state or {'idle': True, 'busy': False, 'draft_present': False}}
        with patch.dict(os.environ, CLAWTAB_PROVIDER=provider, CLAWTAB_PARAMETERS_JSON=parameters), patch.object(shortcuts, 'host', host), patch.object(shortcuts, 'screen', lambda: captured):
            shortcuts.main(action)
        return calls

    def test_codex_toggle_preserves_draft(self):
        calls = self.run_shortcut('codex', 'toggle-plan', state={'idle': True, 'draft_present': True})
        self.assertIn(('send-key', 'BTab'), calls)
        self.assertFalse(any(call[0] == 'submit-text' for call in calls))

    def test_compact_rejects_unsent_draft(self):
        with self.assertRaisesRegex(ValueError, 'draft'):
            self.run_shortcut('codex', 'compact', state={'idle': True, 'draft_present': True})

    def test_busy_agent_rejects_shortcuts(self):
        with self.assertRaisesRegex(ValueError, 'idle'):
            self.run_shortcut('codex', 'fork', state={'idle': False, 'busy': True})

    def test_claude_mode_uses_plan_from_normal_and_backtab_from_plan(self):
        self.assertIn(('submit-text', '/plan'), self.run_shortcut('claude', 'toggle-plan'))
        self.assertIn(('send-key', 'BTab'), self.run_shortcut('claude', 'toggle-plan', '\u276f\nplan mode on'))

    def test_claude_rejects_unknown_or_nonempty_composer(self):
        for screen in ['unknown menu', '\u276f unfinished draft', '\u276f\nesc to interrupt']:
            with self.assertRaises(ValueError):
                self.run_shortcut('claude', 'compact', screen)

    def test_provider_specific_fork_and_model(self):
        self.assertIn(('submit-text', '/fork'), self.run_shortcut('codex', 'fork'))
        self.assertIn(('submit-text', '/branch'), self.run_shortcut('claude', 'fork'))
        self.assertIn(('submit-text', '/model claude-opus-5'), self.run_shortcut('claude', 'model', parameters='{"model":"claude-opus-5"}'))
        with self.assertRaisesRegex(ValueError, 'Invalid model'):
            self.run_shortcut('claude', 'model', parameters='{"model":"bad\\ncommand"}')

if __name__ == '__main__':
    unittest.main()
