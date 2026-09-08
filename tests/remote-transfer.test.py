import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

spec = importlib.util.spec_from_file_location('transfer', Path(__file__).parents[1] / 'desktop/src-tauri/src/host/transfer.py')
transfer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(transfer)

class TransferTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.home = patch.object(Path, 'home', return_value=self.root)
        self.home.start()
        self.source = self.root / 'source'
        self.source.mkdir()
        self.git('init', '-q')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        (self.source / 'tracked.txt').write_text('original\n')
        (self.source / '.env').write_text('fixture original\n')
        self.git('add', '.')
        self.git('add', '-f', '.env')
        self.git('commit', '-qm', 'fixture')
    def tearDown(self):
        self.home.stop()
        self.temp.cleanup()
    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.source), *args]).decode().strip()
    def copy(self, files=()):
        sender = str(uuid.uuid4())
        receiver = str(uuid.uuid4())
        manifest = transfer.main(dict(action='transfer_prepare', operation_id=sender, path=str(self.source), files=list(files)))
        destination = self.root / 'received'
        transfer.main(dict(action='transfer_begin', operation_id=receiver, path=str(destination), size=manifest['size'], sha256=manifest['sha256']))
        offset = 0
        while offset < manifest['size']:
            chunk = transfer.main(dict(action='transfer_read', operation_id=sender, offset=offset))
            ack = transfer.main(dict(action='transfer_write', operation_id=receiver, offset=offset, data=chunk['data']))
            duplicate = transfer.main(dict(action='transfer_write', operation_id=receiver, offset=offset, data=chunk['data']))
            self.assertEqual(ack, duplicate)
            offset = ack['offset']
        request = dict(action='transfer_finish', operation_id=receiver)
        result = transfer.main(request)
        self.assertEqual(result, transfer.main(request))
        return Path(result['path']), manifest
    def test_round_trip_preserves_index_binary_deletions_and_unpublished_commit(self):
        (self.source / 'unpublished.txt').write_text('local commit\n')
        self.git('add', '.'); self.git('commit', '-qm', 'unpublished')
        (self.source / 'tracked.txt').write_text('staged\n'); self.git('add', 'tracked.txt')
        (self.source / 'tracked.txt').write_text('unstaged\n')
        (self.source / 'unpublished.txt').unlink()
        (self.source / 'new.bin').write_bytes(bytes(range(256)))
        (self.source / '.env').write_text('fixture private edit\n')
        result, manifest = self.copy(['new.bin'])
        self.assertEqual((result / 'tracked.txt').read_text(), 'unstaged\n')
        self.assertEqual(subprocess.check_output(['git', '-C', str(result), 'show', ':tracked.txt']), b'staged\n')
        self.assertFalse((result / 'unpublished.txt').exists())
        self.assertEqual((result / 'new.bin').read_bytes(), bytes(range(256)))
        self.assertEqual((result / '.env').read_text(), 'fixture original\n')
        self.assertIn('.env', manifest['excluded'])
        self.assertEqual((self.source / 'tracked.txt').read_text(), 'unstaged\n')
    def test_explicit_sensitive_file_selection(self):
        (self.source / '.env').write_text('explicit fixture\n')
        result, _ = self.copy(['.env'])
        self.assertEqual((result / '.env').read_text(), 'explicit fixture\n')
    def test_rejects_traversal_and_symlink_selection(self):
        for name in ('../escape', '/absolute', '.git/config', 'a/../../escape'):
            with self.assertRaises(ValueError): transfer.safe_relative(name)
        (self.source / 'link').symlink_to(self.root)
        with self.assertRaises(ValueError): transfer.source_file(self.source, 'link')
    def test_wrong_hash_does_not_create_destination(self):
        operation = str(uuid.uuid4())
        transfer.main(dict(action='transfer_begin', operation_id=operation, path=str(self.root / 'absent'), size=0, sha256='0' * 64))
        with self.assertRaises(ValueError): transfer.main(dict(action='transfer_finish', operation_id=operation))
        self.assertFalse((self.root / 'absent').exists())

    def test_transfer_ids_are_bound_to_the_source_and_cancellation_is_final(self):
        operation = str(uuid.uuid4())
        request = dict(action='transfer_prepare', operation_id=operation, path=str(self.source), files=[])
        original = transfer.main(request)
        self.assertEqual(original, transfer.main(request))
        with self.assertRaises(ValueError): transfer.main({**request, 'files': ['tracked.txt']})
        transfer.main(dict(action='transfer_cancel', operation_id=operation))
        with self.assertRaises(ValueError): transfer.main(request)
    def test_destination_worktree_symlink_is_rejected(self):
        destination = self.root / 'destination'
        destination.mkdir()
        outside = self.root / 'outside'
        outside.mkdir()
        (destination / '.worktrees').symlink_to(outside)
        operation = str(uuid.uuid4())
        manifest = transfer.main(dict(action='transfer_prepare', operation_id=operation, path=str(self.source), files=[]))
        transfer.main(dict(action='transfer_begin', operation_id=operation, path=str(destination), size=manifest['size'], sha256=manifest['sha256']))
        offset = 0
        while offset < manifest['size']:
            chunk = transfer.main(dict(action='transfer_read', operation_id=operation, offset=offset))
            offset = transfer.main(dict(action='transfer_write', operation_id=operation, offset=offset, data=chunk['data']))['offset']
        with self.assertRaises(ValueError): transfer.main(dict(action='transfer_finish', operation_id=operation))
        self.assertEqual(list(outside.iterdir()), [])

if __name__ == '__main__': unittest.main()
