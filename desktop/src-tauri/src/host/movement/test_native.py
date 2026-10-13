"""Opt-in native provider compatibility checks, using isolated homes and fixture data.

CLAWTAB_NATIVE_PROVIDER_TESTS=1 python3 -m unittest discover -s <this-directory>
No provider requests or source credentials are used.
"""
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import unittest
from unittest.mock import patch
import uuid
import test_worker


@unittest.skipUnless(os.environ.get('CLAWTAB_NATIVE_PROVIDER_TESTS') == '1', 'native CLI tests are opt-in')
class NativeProviderTests(unittest.TestCase):
    setUp = test_worker.WorkerTests.setUp
    tearDown = test_worker.WorkerTests.tearDown
    git = test_worker.WorkerTests.git
    transcript = test_worker.WorkerTests.transcript
    move_fixture = test_worker.WorkerTests.move_fixture
    def test_native_codex_reads_relocated_rollout(self):
        executable = shutil.which('codex', path=os.environ['PATH'].split(':', 1)[1])
        if not executable: self.skipTest('Codex CLI not installed')
        imported = self.move_fixture('codex')
        environment = {'PATH': os.environ['PATH'], 'HOME': os.environ['HOME'], 'CODEX_HOME': os.environ['CODEX_HOME'], 'TMPDIR': str(self.base), 'TERM': 'xterm-256color'}
        process = subprocess.Popen([executable, 'app-server'], cwd=imported['cwd'], env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        try:
            process.stdin.write(json.dumps({'id': 0, 'method': 'initialize', 'params': {'clientInfo': {'name': 'move-fixture', 'version': '1'}, 'capabilities': {'experimentalApi': True}}}) + '\n')
            process.stdin.flush()
            self.assertTrue(selector.select(15), 'Native initialize timed out')
            self.assertIn('result', json.loads(process.stdout.readline()))
            process.stdin.write(json.dumps({'method': 'initialized'}) + '\n' + json.dumps({'id': 1, 'method': 'thread/read', 'params': {'threadId': self.sid, 'includeTurns': True}}) + '\n')
            process.stdin.flush()
            for _ in range(15):
                if not selector.select(1): continue
                response = json.loads(process.stdout.readline())
                if response.get('id') != 1: continue
                thread = response['result']['thread']
                self.assertEqual(thread['id'], self.sid)
                self.assertEqual(thread['cwd'], imported['cwd'])
                self.assertEqual(len(thread['turns']), 1)
                self.assertGreaterEqual(len(thread['turns'][0]['items']), 2)
                break
            else: self.fail('Native Codex thread read timed out')
        finally:
            selector.close()
            process.terminate()
            try: process.wait(timeout=5)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
            process.stdin.close()
            process.stdout.close()

    def test_native_opencode_moves_selected_conversation_between_homes(self):
        executable = shutil.which('opencode')
        if not executable: self.skipTest('OpenCode CLI not installed')
        self.sid = 'ses_' + uuid.uuid4().hex
        message = 'msg_' + uuid.uuid4().hex
        part = 'prt_' + uuid.uuid4().hex
        fixture = {'info': {'id': self.sid, 'slug': 'move-fixture', 'projectID': 'global', 'directory': str(self.repo), 'title': 'Move fixture', 'version': '1.19.0', 'time': {'created': 1, 'updated': 1}}, 'messages': [{'info': {'id': message, 'sessionID': self.sid, 'role': 'user', 'time': {'created': 1}, 'agent': 'build', 'model': {'providerID': 'anthropic', 'modelID': 'claude-sonnet-4-5'}}, 'parts': [{'id': part, 'sessionID': self.sid, 'messageID': message, 'type': 'text', 'text': 'Move fixture question'}]}]}
        artifact = self.base / 'opencode-fixture.json'
        artifact.write_text(json.dumps(fixture))
        def environment(home):
            return {'PATH': os.environ['PATH'], 'HOME': str(home), 'XDG_CONFIG_HOME': str(home / '.config'), 'XDG_DATA_HOME': str(home / '.local/share'), 'XDG_STATE_HOME': str(home / '.local/state'), 'XDG_CACHE_HOME': str(home / '.cache'), 'OPENCODE_DISABLE_AUTOUPDATE': 'true', 'OPENCODE_DISABLE_MODELS_FETCH': 'true'}
        with patch.dict(os.environ, environment(self.home), clear=True):
            subprocess.run([executable, 'import', str(artifact), '--pure'], cwd=self.repo, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
            manifest = self.worker['prepare']({'provider': 'opencode', 'session_id': self.sid, 'cwd': str(self.repo), 'operation_id': self.operation})
            archive = self.home / '.config/clawtab/operations' / self.operation / 'payload.zip'
            payload = archive.read_bytes()
            target_home = self.base / 'native-target-home'
            target_home.mkdir()
            with patch.dict(os.environ, environment(target_home), clear=True):
                self.worker['dispatch']({'action': 'transfer_begin', 'operation_id': self.operation, 'path': str(self.base / 'native-target'), 'size': manifest['size'], 'sha256': manifest['sha256']})
                self.worker['dispatch']({'action': 'transfer_write', 'operation_id': self.operation, 'offset': 0, 'data': __import__('base64').b64encode(payload).decode()})
                imported = self.worker['import_session']({'operation_id': self.operation})
                result = subprocess.run([executable, 'export', self.sid, '--pure'], cwd=imported['cwd'], check=True, capture_output=True, timeout=60)
                actual = json.loads(result.stdout)
                self.assertEqual(actual['info']['id'], self.sid)
                self.assertEqual(actual['info']['directory'], imported['cwd'])
                self.assertEqual(actual['messages'][0]['parts'][0]['text'], 'Move fixture question')


if __name__ == '__main__': unittest.main()
