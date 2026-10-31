#!/usr/bin/env python3
"""Review an X text post in ClawTab, publish the chosen draft, and verify its URL."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import unicodedata


class WorkflowError(RuntimeError):
    pass


def normalized(text):
    return ' '.join(unicodedata.normalize('NFC', text).split())


def validate(draft):
    if set(draft) - {'account', 'profile', 'text', 'sources', 'rationale'}:
        raise WorkflowError('Draft fields: account, profile, text, sources, rationale')
    if not re.fullmatch(r'[A-Za-z0-9_]{1,15}', draft.get('account', '')):
        raise WorkflowError('Provide the destination X handle without @')
    if not re.fullmatch(r'profile_[A-Za-z0-9_]+', draft.get('profile', '')):
        raise WorkflowError('Provide an exact BMUX profile ID')
    text = draft.get('text', '')
    if not isinstance(text, str) or not text.strip() or text != text.strip():
        raise WorkflowError('Provide trimmed post text')
    # Conservative bound for ordinary posts, including double-width characters.
    weighted = sum(1 if ord(c) <= 0x10ff or 0x2000 <= ord(c) <= 0x200d or
                   0x2010 <= ord(c) <= 0x201f or 0x2032 <= ord(c) <= 0x2037 else 2
                   for c in text)
    if weighted > 280:
        raise WorkflowError('Use a text post of at most 280 weighted characters')
    if not isinstance(draft.get('sources', []), list) or not all(
            isinstance(s, str) and len(s) <= 2048 for s in draft.get('sources', [])):
        raise WorkflowError('Sources must be a list of paths or URLs')
    if not isinstance(draft.get('rationale', ''), str):
        raise WorkflowError('Rationale must be text')
    if len(json.dumps(draft)) > 32768:
        raise WorkflowError('Draft exceeds 32 KiB')
    return draft


def fingerprint(draft):
    return hashlib.sha256(json.dumps(draft, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.receipt-')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, path)
        dfd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        if os.path.exists(name):
            os.unlink(name)


@contextlib.contextmanager
def locked(path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.with_suffix('.lock').open('a') as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        yield


def run_json(argv, payload=None, timeout=60):
    p = subprocess.run(argv, input=None if payload is None else json.dumps(payload),
                       capture_output=True, text=True, timeout=timeout)
    if p.returncode:
        raise WorkflowError(f'{argv[0]} {argv[1]} failed (exit {p.returncode})')
    try:
        result = json.loads(p.stdout)
    except ValueError as e:
        raise WorkflowError(f'{argv[0]} returned invalid JSON') from e
    if result.get('ok') is False:
        raise WorkflowError(str(result.get('error', 'Command failed')))
    return result


def message(*args, payload=None):
    # Discover once; nfn remains the compatibility alias on older installations.
    if not hasattr(message, 'group'):
        try:
            run_json(['cwt', 'message', 'help'])
            message.group = 'message'
        except WorkflowError:
            run_json(['cwt', 'nfn', 'help'])
            message.group = 'nfn'
    timeout = int(args[-1]) + 15 if args[0] == 'wait' else 60
    return run_json(['cwt', message.group, *args], payload, timeout=timeout)


def request_for(draft, digest):
    return {
        'title': f'Post to X as @{draft["account"]}',
        'body': draft['text'], 'template': 'social-review', 'media': [],
        'response_destination': 'result', 'dedupe_key': f'x-post:{digest}',
        'data': {'platform': 'X', 'account': '@' + draft['account'],
                 'profile': draft['profile'], 'draft_sha256': digest,
                 'details': '\n'.join([draft.get('rationale', ''), *draft.get('sources', [])])},
        'actions': [{'id': i, 'label': label, 'kind': 'choice', 'value': '', 'parameters': {}}
                    for i, label in [('post', 'Post to X'), ('revise', 'Request changes'),
                                     ('reject', 'Reject')]],
        'expires_at': int((time.time() + 86400) * 1000),
    }


def approved(record, receipt, reconcile=False):
    request = record.get('request', {})
    response = record.get('response') or {}
    wanted = receipt['request']
    # Source attribution is filled by cwt. Every reviewed content field stays bound.
    if record.get('id') != receipt['message_id'] or any(
            request.get(k) != wanted[k] for k in wanted):
        raise WorkflowError('Review payload changed; create a new review')
    if (record.get('wait_timed_out') or record.get('status') != 'resolved'
            or response.get('status') != 'resolved'
            or response.get('request_id') != receipt['message_id']
            or response.get('action_id') != 'post'):
        raise WorkflowError('This draft has no Post to X decision')
    if (response.get('text') or '').strip():
        raise WorkflowError('Feedback requires a revised draft and a new review')
    if response.get('responded_at', 0) > wanted['expires_at']:
        raise WorkflowError('Review expired before the decision')
    if not reconcile and time.time() * 1000 > wanted['expires_at']:
        raise WorkflowError('Review has expired; create a new draft review')


class Browser:
    """Compatibility transport for old X receipts, using BMUX plugin actions."""
    def __init__(self, draft):
        import importlib.util
        spec = importlib.util.spec_from_file_location('social_review_compat', Path(__file__).parents[1] / 'social-review/social_review.py')
        self.social = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.social)
        self.browser = self.social.Bmux(); self.draft = draft
        self.file = Path.home() / '.local/state/clawtab/x-post-review/plugins' / (fingerprint(draft) + '.json')
        self.state = json.loads(self.file.read_text()) if self.file.exists() else {}

    def save(self): atomic_json(self.file, self.state)

    def open(self):
        binding = self.social.accounts()['x']
        if self.draft['profile'] != binding['profile'] or self.draft['account'].lower() != binding['account'].lstrip('@').lower():
            raise WorkflowError('The legacy receipt differs from the configured personal X account')
        self.target = {**binding, 'platform': 'x'}
        self.binding = self.browser.binding(self.target, binding)
        self.pane = self.binding['pane']

    def close(self): pass

    def action(self, action, parameters, timeout=240):
        try: return self.browser.invoke('x', action, self.pane, parameters, self.state, self.save, timeout)
        except self.social.WorkflowError as error: raise WorkflowError(str(error)) from error

    def prepare(self):
        if not self.state.get('browsing'):
            self.browser.call('navigate', '-t', self.pane, 'https://x.com/home')
            result = self.action('simulate', {'seconds': '90', 'allow_like': False, 'use_decisions': False, 'session': 'legacy-' + fingerprint(self.draft)[:32]})
            if result.get('status') != 'completed' or result.get('elapsedSeconds', 0) < 85:
                raise WorkflowError('Pre-publication browsing needs input')
            self.state['browsing'] = result; self.save()
        prepared = self.action('prepare-post', {'account_url': 'https://x.com/' + self.draft['account'], 'body': self.draft['text']})
        if prepared.get('status') != 'prepared': raise WorkflowError('The X plugin needs input before publication')
        self.state['draft_id'] = prepared['draftId']; self.save()
        return set()

    def submit(self):
        self.state['publication'] = self.action('publish-post', {'draft_id': self.state['draft_id']}); self.save()

    def verify(self, before, submitted_at):
        result = self.state.get('publication', {})
        if result.get('status') != 'published' or not result.get('url'): raise WorkflowError('Reconcile the saved plugin publication before continuing')
        return self.verify_url(result['url'], submitted_at)

    def verify_url(self, url, submitted_at):
        canonical_path(url, self.draft['account'])
        if not self.state.get('draft_id'): raise WorkflowError('No plugin draft is associated with this legacy receipt')
        self.browser.call('navigate', '-t', self.pane, url)
        result = self.action('verify-post', {'draft_id': self.state['draft_id'], 'url': url})
        if result.get('status') != 'published' or result.get('url') != url: raise WorkflowError('The X plugin could not verify this permalink')
        return {'url': url, 'post': result, 'verified_at': time.time()}


def canonical_path(url, account):
    match = re.fullmatch(r'https://x\.com/([A-Za-z0-9_]+)/status/([0-9]+)', url)
    if not match or match[1].lower() != account.lower():
        raise WorkflowError('Pass an exact post URL for the reviewed account')
    return f'/{match[1]}/status/{match[2]}'


def matches_post(post, draft, submitted_at):
    from datetime import datetime
    try:
        canonical_path('https://x.com' + post['path'], draft['account'])
        at = datetime.fromisoformat(post['at'].replace('Z', '+00:00')).timestamp()
        return (normalized(post['text']) == normalized(draft['text']) and
                submitted_at - 5 <= at <= submitted_at + 300)
    except (KeyError, TypeError, ValueError, WorkflowError):
        return False


def review(draft, state_dir, wait=0):
    validate(draft)
    digest = fingerprint(draft)
    path = state_dir / (digest + '.json')
    with locked(path):
        if path.exists():
            receipt = json.loads(path.read_text())
        else:
            receipt = {'draft': draft, 'sha256': digest, 'phase': 'reviewing',
                       'request': request_for(draft, digest), 'created_at': time.time()}
            atomic_json(path, receipt)
        if not receipt.get('message_id'):
            record = message('send', '--stdin', payload=receipt['request'])
            receipt.update(message_id=record['id'], phase='pending')
            atomic_json(path, receipt)
    if wait:
        record = message('wait', receipt['message_id'], '--timeout', str(wait))
        if not record.get('wait_timed_out'):
            return publish(path)
    return {'receipt': str(path), 'message_id': receipt['message_id'], 'phase': receipt['phase']}


def publish(path, verify_url=None, browser_factory=Browser):
    with locked(path):
        receipt = json.loads(path.read_text())
        if fingerprint(validate(receipt['draft'])) != receipt['sha256']:
            raise WorkflowError('Receipt draft hash mismatch')
        if receipt['phase'] == 'verified':
            return receipt
        approved(message('get', receipt['message_id']), receipt, reconcile=bool(verify_url))
        if receipt['phase'] in ('submitting', 'uncertain') and not verify_url:
            raise WorkflowError('Submission may have completed; use verify with its URL, never repost')
        if verify_url and receipt['phase'] not in ('submitting', 'uncertain'):
            raise WorkflowError('Only an uncertain submission can be reconciled')
        browser = browser_factory(receipt['draft'])
        try:
            browser.open()
            if verify_url:
                result = browser.verify_url(verify_url, receipt['submitted_at'])
            else:
                before = browser.prepare()
                # Reload approval after browser preparation, immediately before submission.
                approved(message('get', receipt['message_id']), receipt)
                receipt.update(phase='submitting', submitted_at=time.time(), before=sorted(before))
                atomic_json(path, receipt)
                browser.submit()
                result = browser.verify(before, receipt['submitted_at'])
            receipt.update(phase='verified', **result)
            receipt.pop('error', None)
            atomic_json(path, receipt)
        except Exception as e:
            if receipt['phase'] == 'submitting':
                receipt.update(phase='uncertain', error=str(e))
                atomic_json(path, receipt)
            raise
        finally:
            try:
                browser.close()
            except Exception:
                pass
        try:
            message('send', '--stdin', payload={
                'kind': 'completed',
                'title': f'Posted to X as @{receipt["draft"]["account"]}',
                'template': 'update', 'body': receipt['url'],
                'dedupe_key': 'x-post-verified:' + receipt['sha256'],
                'data': {'details': 'Verified author, reviewed text, publication time, and permalink.'}})
        except (WorkflowError, OSError, subprocess.TimeoutExpired) as error:
            receipt['completion_message_error'] = str(error)
            atomic_json(path, receipt)
        return receipt


def watch(path):
    receipt = json.loads(path.read_text())
    while True:
        record = message('wait', receipt['message_id'], '--timeout', '60')
        if record.get('wait_timed_out'):
            continue
        response = record.get('response') or {}
        if record.get('status') == 'resolved' and response.get('action_id') == 'post':
            return publish(path)
        return {'receipt': str(path), 'phase': record.get('status'),
                'decision': response.get('action_id'), 'feedback': response.get('text')}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--state-dir', type=Path, default=Path.home() / '.local/state/clawtab/x-post-review')
    sub = p.add_subparsers(dest='command', required=True)
    for name in ('preview', 'review'):
        q = sub.add_parser(name)
        q.add_argument('draft', type=Path)
        if name == 'review':
            q.add_argument('--wait', type=int, default=0, choices=range(0, 301), metavar='0..300')
    for name in ('publish', 'watch'):
        q = sub.add_parser(name)
        q.add_argument('receipt', type=Path)
    q = sub.add_parser('verify')
    q.add_argument('receipt', type=Path)
    q.add_argument('--url', required=True)
    args = p.parse_args()
    if args.command in ('review', 'preview'):
        draft = validate(json.loads(args.draft.read_text()))
        result = request_for(draft, fingerprint(draft)) if args.command == 'preview' else review(draft, args.state_dir, args.wait)
    elif args.command == 'watch':
        result = watch(args.receipt)
    else:
        result = publish(args.receipt, getattr(args, 'url', None))
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except (WorkflowError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
