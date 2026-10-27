import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('x_post_review', Path(__file__).with_name('x_post_review.py'))
x = importlib.util.module_from_spec(spec)
spec.loader.exec_module(x)


class FakeBrowser:
    clicks = 0
    fail = None

    def __init__(self, draft):
        self.draft = draft

    def open(self):
        if self.fail == 'open':
            raise x.WorkflowError('Signed out')

    def prepare(self):
        return {'/totovoto/status/1'}

    def submit(self):
        FakeBrowser.clicks += 1
        if self.fail == 'submit':
            raise x.WorkflowError('Connection lost after click')

    def verify(self, before, at):
        if self.fail == 'verify':
            raise x.WorkflowError('Permalink not visible')
        return self.verify_url('https://x.com/totovoto/status/2', at)

    def verify_url(self, url, at):
        x.canonical_path(url, self.draft['account'])
        return {'url': url, 'verified_at': time.time()}

    def close(self):
        pass


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.draft = {'account': 'totovoto', 'profile': 'profile_test', 'text': 'I keep my agents in tmux.',
                      'sources': ['local evidence'], 'rationale': 'A small workflow improvement.'}
        self.request = x.request_for(self.draft, x.fingerprint(self.draft))
        self.receipt = {'draft': self.draft, 'sha256': x.fingerprint(self.draft), 'phase': 'pending',
                        'message_id': 'review-1', 'request': self.request}
        self.record = {'id': 'review-1', 'request': copy.deepcopy(self.request), 'status': 'resolved',
                       'response': {'request_id': 'review-1', 'action_id': 'post', 'status': 'resolved',
                                    'responded_at': int(time.time() * 1000), 'text': None}}
        self.path = Path(self.tmp.name) / 'receipt.json'
        x.atomic_json(self.path, self.receipt)
        FakeBrowser.clicks = 0
        FakeBrowser.fail = None

    def call(self, verify_url=None):
        with patch.object(x, 'message', return_value=self.record):
            return x.publish(self.path, verify_url, FakeBrowser)

    def test_pending_rejected_revised_and_cancelled_never_click(self):
        for state, action in [('pending', 'post'), ('cancelled', 'post'),
                              ('resolved', 'reject'), ('resolved', 'revise')]:
            self.record['status'] = state
            self.record['response']['action_id'] = action
            with self.assertRaises(x.WorkflowError):
                self.call()
        self.assertEqual(FakeBrowser.clicks, 0)

    def test_changed_review_fields_never_click(self):
        for field, value in [('body', 'changed'), ('data', {}), ('actions', []),
                             ('expires_at', 1), ('dedupe_key', 'other')]:
            with self.subTest(field=field):
                original = self.record['request'][field]
                self.record['request'][field] = value
                with self.assertRaises(x.WorkflowError):
                    self.call()
                self.record['request'][field] = original
        self.assertEqual(FakeBrowser.clicks, 0)

    def test_feedback_and_expired_decisions_need_new_review(self):
        self.record['response']['text'] = 'change the first sentence'
        with self.assertRaises(x.WorkflowError):
            self.call()
        self.record['response']['text'] = None
        self.record['response']['responded_at'] = self.request['expires_at'] + 1
        with self.assertRaises(x.WorkflowError):
            self.call()
        self.assertEqual(FakeBrowser.clicks, 0)

    def test_verified_receipt_is_not_replayed(self):
        self.assertEqual(self.call()['phase'], 'verified')
        self.call()
        self.assertEqual(FakeBrowser.clicks, 1)

    def test_submission_or_verification_failure_is_never_replayed(self):
        for failure in ['submit', 'verify']:
            with self.subTest(failure=failure):
                x.atomic_json(self.path, self.receipt)
                FakeBrowser.fail = failure
                with self.assertRaises(x.WorkflowError):
                    self.call()
                self.assertEqual(json.loads(self.path.read_text())['phase'], 'uncertain')
                clicks = FakeBrowser.clicks
                with self.assertRaises(x.WorkflowError):
                    self.call()
                self.assertEqual(FakeBrowser.clicks, clicks)

    def test_preparation_failure_can_retry_before_any_click(self):
        FakeBrowser.fail = 'open'
        with self.assertRaises(x.WorkflowError):
            self.call()
        self.assertEqual(json.loads(self.path.read_text())['phase'], 'pending')
        self.assertEqual(FakeBrowser.clicks, 0)
        FakeBrowser.fail = None
        self.assertEqual(self.call()['phase'], 'verified')

    def test_reconcile_uncertain_url_does_not_click(self):
        r = copy.deepcopy(self.receipt)
        r.update(phase='uncertain', submitted_at=time.time())
        x.atomic_json(self.path, r)
        self.assertEqual(self.call('https://x.com/totovoto/status/2')['phase'], 'verified')
        self.assertEqual(FakeBrowser.clicks, 0)

    def test_pre_submit_state_survives_crash(self):
        class CrashBrowser(FakeBrowser):
            def submit(self):
                raise KeyboardInterrupt()
        with patch.object(x, 'message', return_value=self.record):
            with self.assertRaises(KeyboardInterrupt):
                x.publish(self.path, browser_factory=CrashBrowser)
        self.assertEqual(json.loads(self.path.read_text())['phase'], 'submitting')
        with self.assertRaises(x.WorkflowError):
            self.call()
        self.assertEqual(FakeBrowser.clicks, 0)

    def test_draft_tampering_fails(self):
        self.receipt['draft']['text'] = 'changed'
        x.atomic_json(self.path, self.receipt)
        with self.assertRaises(x.WorkflowError):
            self.call()
        self.assertEqual(FakeBrowser.clicks, 0)

    def test_review_creation_is_idempotent(self):
        with patch.object(x, 'message', return_value={'id': 'review-1'}) as send:
            first = x.review(self.draft, Path(self.tmp.name))
            second = x.review(self.draft, Path(self.tmp.name))
        self.assertEqual(first['receipt'], second['receipt'])
        self.assertEqual(send.call_count, 1)
        self.assertEqual(FakeBrowser.clicks, 0)

    def test_post_verification_requires_exact_author_text_and_recent_time(self):
        from datetime import datetime, timezone
        now = time.time()
        post = {'path': '/totovoto/status/2', 'text': self.draft['text'],
                'at': datetime.fromtimestamp(now, timezone.utc).isoformat()}
        self.assertTrue(x.matches_post(post, self.draft, now))
        for field, value in [('path', '/other/status/2'), ('path', '/totovoto/status/2/photo/1'),
                             ('text', 'wrong text'), ('at', '2000-01-01T00:00:00Z')]:
            with self.subTest(field=field, value=value):
                p = dict(post, **{field: value})
                self.assertFalse(x.matches_post(p, self.draft, now))

    def test_validation_rejects_overlong_posts_and_attachments(self):
        for changes in [{'text': 'a' * 281}, {'text': '界' * 141}, {'media': []},
                        {'profile': 'personal'}, {'account': '@totovoto'}]:
            with self.assertRaises(x.WorkflowError):
                x.validate(dict(self.draft, **changes))

    def test_watch_returns_revision_without_publishing(self):
        self.record['response'].update(action_id='revise', text='Use a concrete example')
        with patch.object(x, 'message', return_value=self.record):
            result = x.watch(self.path)
        self.assertEqual(result['decision'], 'revise')
        self.assertEqual(result['feedback'], 'Use a concrete example')
        self.assertEqual(FakeBrowser.clicks, 0)

    def test_watch_waits_for_the_human_decision(self):
        with patch.object(x, 'message', side_effect=[{'wait_timed_out': True}, self.record]), \
                patch.object(x, 'publish', return_value={'phase': 'verified'}) as publish:
            self.assertEqual(x.watch(self.path)['phase'], 'verified')
            publish.assert_called_once_with(self.path)

    def test_failed_completion_message_preserves_publication_receipt(self):
        with patch.object(x, 'message', side_effect=[self.record, self.record,
                          x.WorkflowError('Daemon offline after verification')]):
            result = x.publish(self.path, browser_factory=FakeBrowser)
        self.assertEqual(result['phase'], 'verified')
        self.assertIn('completion_message_error', result)
        self.assertEqual(self.call()['url'], result['url'])
        self.assertEqual(FakeBrowser.clicks, 1)


if __name__ == '__main__':
    unittest.main()
