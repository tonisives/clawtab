import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('social_review', Path(__file__).with_name('social_review.py'))
s = importlib.util.module_from_spec(spec); spec.loader.exec_module(s)


class FakeBmux:
    def __init__(self, fail=None): self.submits = []; self.fail = fail; self.actions = []
    def binding(self, target, binding): return {'pane': '%' + target['id'], 'window_id': target['window'], 'session': target['session'], 'profile': target['profile'], 'url': binding['feed']}
    def call(self, *args):
        if args == ('plugin', 'list'):
            return [{'id': 'bmux.' + site, 'enabled': True, 'actions': [{'id': action} for action in ('posting-capabilities', 'prepare-post', 'publish-post', 'verify-post', 'simulate')]} for site in ('x', 'threads')]
        return {}
    def invoke(self, site, action, pane, parameters, state, save, timeout=240):
        self.actions.append((site, action, parameters))
        if action == 'posting-capabilities': return {'text': True, 'image': True, 'video': True}
        if action == 'simulate': return {'status': 'completed', 'elapsedSeconds': 90, 'seen': ['post-1']}
        if action == 'prepare-post': return {'status': 'prepared', 'draftId': site + '-draft'}
        if action == 'publish-post':
            self.submits.append(site)
            if self.fail == site: raise s.WorkflowError('Lost connection after publication input')
            if self.fail == 'crash': raise KeyboardInterrupt()
            return {'status': 'published', 'url': f'https://{site}.com/own/post/123'}
        if action == 'verify-post': return {'status': 'published', 'url': parameters['url']}
        raise AssertionError(action)


class SocialReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.path = self.root / 'receipt.json'
        self.bundle = {'schema_version': 1, 'id': 'daily-2026-10-30', 'date': '2026-10-30', 'title': 'Agent decisions', 'targets': []}
        for site in ('x', 'threads'):
            target = {**{key: s.accounts()[site][key] for key in ('account', 'account_url', 'profile', 'session', 'window')}, 'id': site, 'platform': site, 'body': f'Original {site} copy', 'media': []}
            target['revision'] = s.revision(target); self.bundle['targets'].append(target)
        self.bundle_path = self.root / 'bundle.json'; s.atomic_json(self.bundle_path, self.bundle)
        self.receipt = {'bundle': str(self.bundle_path), 'bundle_sha256': s.digest(self.bundle), 'message_id': 'review-1', 'library_url': 'https://content.tonis.dev/tonisdev', 'request': s.request_for(self.bundle, 'https://content.tonis.dev/tonisdev'), 'targets': {t['id']: {'phase': 'pending', 'revision': t['revision']} for t in self.bundle['targets']}}
        self.record = {'id': 'review-1', 'status': 'resolved', 'request': copy.deepcopy(self.receipt['request']), 'response': {'request_id': 'review-1', 'status': 'resolved', 'action_id': 'decide', 'responded_at': int(time.time() * 1000), 'decisions': [{'target_id': t['id'], 'revision': t['revision'], 'decision': 'approve'} for t in self.bundle['targets']]}}
        s.atomic_json(self.path, self.receipt)

    def publish(self, browser):
        with patch.object(s, 'message', return_value=self.record), patch.object(s, 'sync_library', return_value={}):
            return s.publish(self.path, browser)

    def test_comments_are_scoped_and_require_revision(self):
        self.record['response']['decisions'][1].update(decision='revise', comment='Shorten the hook')
        browser = FakeBmux(); result = self.publish(browser)
        self.assertEqual(browser.submits, ['x'])
        self.assertEqual(result['targets']['threads']['phase'], 'revision_requested')
        self.assertEqual(result['targets']['threads']['comment'], 'Shorten the hook')
        self.assertTrue(any(a[2].get('seconds') == '90' and a[2]['allow_like'] is False for a in browser.actions))

    def test_review_preserves_clawtab_normalization_for_approval_comparison(self):
        def delivered(*args, payload=None):
            request = copy.deepcopy(payload)
            request['source'] = {'pane_id': '%20', 'group': 'clawtab'}
            request['actions'][0].update(value='', parameters={})
            return {'id': 'normalized-review', 'request': request, 'status': 'pending'}
        with patch.object(s, 'message', side_effect=delivered), patch.object(s, 'sync_library', return_value={'url': 'https://content.tonis.dev/tonisdev'}):
            path = s.review(self.bundle, self.root / 'reviews')
        saved = s.read(path)
        record = {'id': saved['message_id'], 'request': saved['request'], 'status': 'resolved', 'response': {
            **self.record['response'], 'request_id': saved['message_id']}}
        self.assertEqual(len(s.decisions_for(record, saved)), 2)
        record['request'] = copy.deepcopy(record['request']); record['request']['data']['targets'][0]['body'] = 'Changed'
        with self.assertRaises(s.WorkflowError): s.decisions_for(record, saved)

    def test_partial_publication_failure_does_not_replay_success_or_uncertainty(self):
        browser = FakeBmux(fail='x'); result = self.publish(browser)
        self.assertEqual(result['targets']['x']['phase'], 'uncertain')
        self.assertEqual(result['targets']['threads']['phase'], 'verified')
        self.publish(browser); self.assertEqual(browser.submits, ['x', 'threads'])

    def test_crash_persists_attempt_before_plugin_submission(self):
        browser = FakeBmux(fail='crash')
        with self.assertRaises(KeyboardInterrupt): self.publish(browser)
        self.assertEqual(s.read(self.path)['targets']['x']['phase'], 'submitting')
        browser.fail = None; self.publish(browser)
        self.assertEqual(browser.submits, ['x', 'threads'])

    def test_changed_or_incomplete_decisions_never_submit(self):
        mutations = [lambda r: r['response']['decisions'].pop(), lambda r: r['response']['decisions'][0].update(revision='b' * 64), lambda r: r['response']['decisions'][0].update(comment='Change this'), lambda r: r['request'].update(body='Other'), lambda r: r.update(wait_timed_out=True)]
        for change in mutations:
            original = copy.deepcopy(self.record); change(self.record); browser = FakeBmux()
            with self.assertRaises(s.WorkflowError): self.publish(browser)
            self.assertEqual(browser.submits, []); self.record = original

    def test_binding_and_media_tampering_require_a_new_review(self):
        altered = copy.deepcopy(self.bundle); altered['targets'][0]['session'] = 'brand'
        with self.assertRaises(s.WorkflowError): s.validate(altered)
        file = self.root / 'screen.png'; file.write_bytes(b'first')
        target = self.bundle['targets'][0]; target.pop('revision'); target['media'] = [{'kind': 'image', 'path': str(file), 'sha256': s.file_hash(file)}]
        s.validate(self.bundle); file.write_bytes(b'changed')
        with self.assertRaises(s.WorkflowError): s.validate(self.bundle)

    def test_long_single_x_posts_are_accepted(self):
        target = self.bundle['targets'][0]; target.pop('revision'); target['body'] = ('A concrete experience. ' * 30).strip()
        self.assertIs(s.validate(self.bundle), self.bundle)

    def test_missing_locked_window_never_selects_another_session(self):
        browser = s.Bmux(); target = self.bundle['targets'][1]
        with patch.object(browser, 'call', return_value=[{'name': 'brand', 'windows': [{'id': target['window'], 'name': target['window'], 'locked': True, 'panes': [{'id': '%1', 'profileId': target['profile'], 'url': 'https://www.threads.com/'}]}]}]):
            with self.assertRaises(s.WorkflowError): browser.binding(target, s.accounts()['threads'])

    def test_denial_publishes_nothing(self):
        for choice in self.record['response']['decisions']: choice['decision'] = 'deny'
        browser = FakeBmux(); result = self.publish(browser)
        self.assertEqual(browser.submits, []); self.assertTrue(all(value['phase'] == 'denied' for value in result['targets'].values()))


if __name__ == '__main__': unittest.main()
