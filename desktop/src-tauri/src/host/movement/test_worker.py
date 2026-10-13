"""Isolated repository/session fixtures; never uses the developer's provider state."""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid
import zipfile

HERE = Path(__file__).parent


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name).resolve()
        self.home = self.base / 'source-home'
        self.home.mkdir()
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        for provider, version in [('claude', '2.1.296'), ('codex', '0.162.1')]:
            executable = self.bin / provider
            executable.write_text('#!/bin/sh\nif [ "$1" = "--version" ]; then printf "' + version + '\\n"; else printf \'{"loggedIn":true}\\n\'; fi\n')
            executable.chmod(0o700)
        self.environment = patch.dict(os.environ, {'HOME': str(self.home), 'CODEX_HOME': str(self.home / '.codex'), 'CLAUDE_CONFIG_DIR': str(self.home / '.claude'), 'PATH': str(self.bin) + ':' + os.environ['PATH']})
        self.environment.start()
        self.worker = {'__name__': 'move_worker_fixture', 'TRANSFER_SOURCE': (HERE.parent / 'transfer.py').read_text()}
        exec((HERE / 'worker.py').read_text(), self.worker)
        self.repo = self.base / 'source-repo'
        self.repo.mkdir()
        self.git('init', '-q')
        (self.repo / 'tracked.txt').write_text('committed\n')
        (self.repo / '.gitignore').write_text('.env\n')
        (self.repo / 'nested').mkdir()
        (self.repo / 'nested/keep.txt').write_text('nested\n')
        self.git('add', '.')
        self.git('-c', 'user.name=Move fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture')
        (self.repo / 'tracked.txt').write_text('staged\n')
        self.git('add', 'tracked.txt')
        (self.repo / 'tracked.txt').write_text('unstaged\n')
        (self.repo / 'extra.txt').write_text('additional\n')
        (self.repo / '.env').write_text('DO_NOT_TRANSFER_FIXTURE')
        (self.repo / '.mcp.json').write_text('DO_NOT_TRANSFER_FIXTURE')
        self.sid = str(uuid.uuid4())
        self.operation = str(uuid.uuid4())

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def git(self, *args, root=None):
        return subprocess.check_output(['git', '-C', str(root or self.repo), *args], stderr=subprocess.DEVNULL).decode().strip()

    def transcript(self, provider):
        cwd = str(self.repo / 'nested')
        if provider == 'claude':
            path = self.home / '.claude/projects/fixture' / (self.sid + '.jsonl')
            records = [{'type': 'user', 'sessionId': self.sid, 'cwd': cwd, 'message': {'role': 'user', 'content': 'Fixture question'}}, {'type': 'assistant', 'sessionId': self.sid, 'cwd': cwd, 'message': {'role': 'assistant', 'content': [{'type': 'text', 'text': 'Fixture answer'}]}}]
        else:
            path = self.home / '.codex/sessions/2026/10/13' / ('rollout-2026-10-13T00-00-00-' + self.sid + '.jsonl')
            timestamp = '2026-10-13T00:00:00.000Z'
            turn = str(uuid.uuid4())
            records = [{'type': 'session_meta', 'payload': {'id': self.sid, 'timestamp': timestamp, 'cwd': cwd, 'originator': 'codex_cli_rs', 'cli_version': '0.162.1', 'source': 'cli', 'model_provider': 'openai', 'base_instructions': {'text': 'Move fixture'}}}, {'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': turn, 'model_context_window': 258400}}, {'type': 'event_msg', 'payload': {'type': 'user_message', 'message': 'Fixture question', 'images': [], 'local_images': []}}, {'type': 'response_item', 'payload': {'type': 'message', 'role': 'user', 'content': [{'type': 'input_text', 'text': 'Fixture question'}]}}, {'type': 'response_item', 'payload': {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': 'Fixture answer'}]}}, {'type': 'event_msg', 'payload': {'type': 'agent_message', 'message': 'Fixture answer', 'phase': 'final_answer'}}, {'type': 'event_msg', 'payload': {'type': 'task_complete', 'turn_id': turn, 'last_agent_message': 'Fixture answer'}}]
            records = [{'timestamp': timestamp, **record} for record in records]
        path.parent.mkdir(parents=True)
        path.write_text(''.join(json.dumps(record) + '\n' for record in records))
        (self.home / ('.claude' if provider == 'claude' else '.codex') / 'auth.json').write_text('DO_NOT_TRANSFER_FIXTURE')
        return {'provider': provider, 'session_id': self.sid, 'cwd': cwd, 'operation_id': self.operation, 'model': 'fixture-model', 'effort': 'high'}

    def move_fixture(self, provider):
        request = self.transcript(provider)
        manifest = self.worker['prepare'](request)
        directory = self.home / '.config/clawtab/operations' / self.operation
        archive = directory / 'payload.zip'
        with zipfile.ZipFile(archive) as snapshot:
            self.assertIn('move-session.json', snapshot.namelist())
            for name in snapshot.namelist(): self.assertNotIn(b'DO_NOT_TRANSFER_FIXTURE', snapshot.read(name))
        target_home = self.base / 'target-home'
        target_home.mkdir()
        target = self.base / 'target-repo'
        os.environ.update(HOME=str(target_home), CODEX_HOME=str(target_home / '.codex'), CLAUDE_CONFIG_DIR=str(target_home / '.claude'))
        begin = self.worker['dispatch']({'action': 'transfer_begin', 'operation_id': self.operation, 'path': str(target), 'size': manifest['size'], 'sha256': manifest['sha256']})
        self.assertEqual(begin['offset'], 0)
        payload = archive.read_bytes()
        write = {'action': 'transfer_write', 'operation_id': self.operation, 'offset': 0, 'data': base64.b64encode(payload).decode()}
        self.worker['dispatch'](write)
        self.assertEqual(self.worker['dispatch'](write)['offset'], len(payload))
        imported = self.worker['import_session']({'operation_id': self.operation})
        self.assertEqual(imported, self.worker['import_session']({'operation_id': self.operation}))
        worktree = Path(imported['path'])
        self.assertEqual((worktree / 'tracked.txt').read_text(), 'unstaged\n')
        self.assertEqual(self.git('show', ':tracked.txt', root=worktree), 'staged')
        self.assertEqual((worktree / 'extra.txt').read_text(), 'additional\n')
        self.assertFalse((worktree / '.env').exists())
        self.assertFalse((worktree / '.mcp.json').exists())
        self.assertEqual(imported['session_id'], self.sid)
        self.assertEqual(imported['model'], 'fixture-model')
        transcripts = list(target_home.glob('**/*.jsonl'))
        self.assertEqual(len(transcripts), 1)
        self.assertIn(imported['cwd'], transcripts[0].read_text())
        self.assertNotIn(request['cwd'], transcripts[0].read_text())
        return imported

    def test_claude_conversation_and_git_changes_round_trip(self): self.move_fixture('claude')
    def test_codex_conversation_and_git_changes_round_trip(self): self.move_fixture('codex')

    def test_provider_collision_never_overwrites(self):
        path = self.home / 'session.jsonl'
        self.worker['write_once'](path, b'first')
        with self.assertRaises(ValueError): self.worker['write_once'](path, b'different')
        self.assertEqual(path.read_bytes(), b'first')

    def test_provider_symlink_and_unknown_version_fail_closed(self):
        target = self.home / 'regular'
        target.write_text('fixture')
        link = self.home / 'symlink'
        link.symlink_to(target)
        with self.assertRaises(ValueError): self.worker['regular'](link, self.home)
        (self.bin / 'codex').write_text('#!/bin/sh\nprintf "99.0.0\\n"\n')
        with self.assertRaises(ValueError): self.worker['version']('codex')

    def test_session_capture_is_bounded_and_only_selected_session(self):
        request = self.transcript('codex')
        other = self.home / '.codex/sessions/2026/10/13/other.jsonl'
        other.write_text('DO_NOT_TRANSFER_FIXTURE')
        data = self.worker['session_export']('codex', self.sid, request['cwd'])
        self.assertEqual(len(data['files']), 1)
        self.worker['SESSION_LIMIT'] = 1
        with self.assertRaises(ValueError): self.worker['session_export']('codex', self.sid, request['cwd'])

    def test_launch_claim_prevents_duplicate_and_does_not_send_a_resume_prompt(self):
        session = {'provider': 'codex', 'session_id': self.sid, 'cwd': str(self.repo), 'path': str(self.repo), 'model': None, 'effort': None}
        self.worker['import_session'] = lambda _: session
        calls = []
        self.worker['run'] = lambda args, *a, **k: calls.append(args) or (b'Tue Oct 13 10:00:00 2026\n' if args[0] == 'ps' else b'%123 456\n')
        directory = self.home / '.config/clawtab/operations' / self.operation
        directory.mkdir(parents=True)
        request = {'operation_id': self.operation, 'setup': False, 'secret_keys': []}
        first = self.worker['launch'](request)
        self.assertEqual(first, self.worker['launch'](request))
        self.assertEqual(len(calls), 2)
        launcher = (directory / 'move-launcher.py').read_text()
        self.assertIn("'resume'", launcher)
        self.assertIn("'--no-daemon'", launcher)
        self.assertNotIn("'--prompt'", launcher)

    def test_abort_barrier_blocks_late_launch_even_after_cleanup(self):
        directory = self.home / '.config/clawtab/operations' / self.operation
        directory.mkdir(parents=True)
        (directory / 'move-aborted.json').write_text('{"state":"stopped"}')
        self.worker['import_session'] = lambda _: self.fail('Aborted move must not import or launch')
        request = {'operation_id': self.operation}
        self.worker['dispatch']({'action': 'cleanup', **request})
        for setup in (False, True):
            with self.assertRaisesRegex(ValueError, 'aborted'):
                self.worker['launch']({**request, 'setup': setup})

    def test_unverified_provider_cannot_launch(self):
        self.worker['import_session'] = lambda _: {'provider': 'opencode'}
        with self.assertRaisesRegex(ValueError, 'not verified'):
            self.worker['launch']({'operation_id': self.operation})

    def test_setup_stop_barrier_preserves_original_handoff(self):
        directory = self.home / '.config/clawtab/operations' / self.operation
        directory.mkdir(parents=True)
        (directory / 'setup-stopped.json').write_text('{"state":"stopped"}')
        self.worker['import_session'] = lambda _: self.fail('Stopped setup must not launch again')
        with self.assertRaisesRegex(ValueError, 'setup was stopped'):
            self.worker['launch']({'operation_id': self.operation, 'setup': True})
        self.assertFalse((directory / 'move-aborted.json').exists())

    def test_cleanup_retains_recovery_metadata(self):
        directory = self.home / '.config/clawtab/operations' / self.operation
        directory.mkdir(parents=True)
        (directory / 'incoming.zip').write_bytes(b'fixture')
        (directory / 'move-launch.json').write_text('{}')
        self.worker['dispatch']({'action': 'cleanup', 'operation_id': self.operation})
        self.assertFalse((directory / 'incoming.zip').exists())
        self.assertTrue((directory / 'move-launch.json').exists())


if __name__ == '__main__': unittest.main()
