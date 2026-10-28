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
            run_json(['cwtctl', 'message', 'help'])
            message.group = 'message'
        except WorkflowError:
            run_json(['cwtctl', 'nfn', 'help'])
            message.group = 'nfn'
    timeout = int(args[-1]) + 15 if args[0] == 'wait' else 60
    return run_json(['cwtctl', message.group, *args], payload, timeout=timeout)


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
    # Source attribution is filled by cwtctl. Every reviewed content field stays bound.
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


POSTS_JS = r'''(() => Array.from(document.querySelectorAll('article[data-testid="tweet"]')).map(a => {
 const t = a.querySelector('[data-testid="tweetText"]');
 const c = t?.cloneNode(true);
 c?.querySelectorAll('a').forEach(l => {
   const title=l.getAttribute('title'), href=l.getAttribute('href');
   if (title?.startsWith('http')) l.replaceWith(title);
   else if (href?.startsWith('https://') && !href.startsWith('https://t.co/')) l.replaceWith(href);
 });
 const owner=a.querySelector('[data-testid="User-Name"] a[href]')?.getAttribute('href');
 const links=Array.from(a.querySelectorAll('a[href]')).filter(l =>
   new RegExp('^' + owner + '/status/[0-9]+$','i').test(l.getAttribute('href')));
 const link=links.find(l => l.getAttribute('href') === location.pathname) ||
   links.find(l => l.querySelector('time'));
 const path=link?.getAttribute('href');
 // Main detail timestamps may have no <time>; a quoted post can have the first one.
 // Snowflake layout: twitter-archive/snowflake, IdWorker.scala (2010 branch).
 const id=path?.split('/').pop();
 const at=id ? new Date(Number((BigInt(id) >> 22n) + 1288834974657n)).toISOString() : null;
 return {text:c?.textContent || '', path, at};
}))()'''


class Browser:
    def __init__(self, draft):
        self.draft = draft
        self.pane = None
        os.environ.setdefault('BMUX_AGENT_TYPE', 'tmux')
        os.environ.setdefault('BMUX_AGENT_NAME', 'X post review')
        os.environ.setdefault('BMUX_AGENT_PURPOSE', 'Publish the human-selected X draft and verify its URL')

    def command(self, *args):
        return run_json(['bmux', *args])['result']

    def open(self):
        profiles = self.command('profile', 'list')
        if not any(p['id'] == self.draft['profile'] for p in profiles):
            raise WorkflowError('The reviewed browser profile is unavailable')
        window = self.command('new-window', '-t', 'bot', '-n', 'x-post-review',
                              '--profile', self.draft['profile'], '--url', 'https://x.com/home')
        self.pane = window['panes'][0]['id']
        self.window = window['id']
        self.wait('[data-testid="SideNav_AccountSwitcher_Button"]')
        self.identity()

    def close(self):
        if self.pane:
            self.command('kill-window', '-t', self.window, '--confirm')

    def wait(self, selector):
        self.command('wait', '-t', self.pane, '--selector', selector, '--state', 'visible')

    def evaluate(self, code):
        return self.command('eval', '-t', self.pane, code)

    def identity(self):
        path = self.evaluate('document.querySelector("a[data-testid=AppTabBar_Profile_Link]")?.getAttribute("href")')
        if (path or '').lower() != '/' + self.draft['account'].lower():
            raise WorkflowError('Signed-in X account differs from the reviewed destination')

    def posts(self):
        return self.evaluate(POSTS_JS)

    def profile(self):
        self.command('navigate', '-t', self.pane, 'https://x.com/' + self.draft['account'])
        self.wait('article[data-testid="tweet"]')
        self.identity()
        return self.posts()

    def prepare(self):
        before = {p['path'] for p in self.profile() if p.get('path')}
        self.command('navigate', '-t', self.pane, 'https://x.com/home')
        self.wait('[data-testid="tweetTextarea_0"]')
        self.identity()
        selector = '[data-testid="tweetTextarea_0"]'
        if normalized(self.evaluate('document.querySelector(' + json.dumps(selector) + ').innerText')):
            raise WorkflowError('X composer already contains a draft')
        self.command('type', '-t', self.pane, '--selector', selector, '--text', self.draft['text'])
        actual = self.evaluate('document.querySelector(' + json.dumps(selector) + ').innerText')
        if normalized(actual) != normalized(self.draft['text']):
            raise WorkflowError('X composer text differs from the reviewed draft')
        self.identity()
        self.command('wait', '-t', self.pane, '--expression',
                     'document.querySelector("[data-testid=tweetButtonInline]")?.disabled === false')
        return before

    def submit(self):
        # Caller durably records submitting before this single non-retriable click.
        self.command('click', '-t', self.pane, '--selector', '[data-testid="tweetButtonInline"]')

    def verify(self, before, submitted_at):
        self.command('wait', '-t', self.pane, '--expression',
                     '!document.querySelector("[data-testid=tweetTextarea_0]")?.innerText.trim()')
        matches = [p for p in self.profile() if p.get('path') not in before and
                   matches_post(p, self.draft, submitted_at)]
        if len(matches) != 1:
            raise WorkflowError('Could not identify one newly published post; inspect the receipt before retrying')
        url = 'https://x.com' + matches[0]['path']
        return self.verify_url(url, submitted_at)

    def verify_url(self, url, submitted_at):
        path = canonical_path(url, self.draft['account'])
        self.command('navigate', '-t', self.pane, 'https://x.com' + path)
        self.command('wait', '-t', self.pane, '--expression',
                     'location.pathname === ' + json.dumps(path) +
                     ' && !!document.querySelector(' +
                     json.dumps('article[data-testid="tweet"] a[href="' + path + '"]') + ')')
        matches = [p for p in self.posts() if p.get('path') == path and
                   matches_post(p, self.draft, submitted_at)]
        if len(matches) != 1:
            raise WorkflowError('Post permalink did not verify account, text, and publication time')
        return {'url': 'https://x.com' + path, 'post': matches[0], 'verified_at': time.time()}


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
