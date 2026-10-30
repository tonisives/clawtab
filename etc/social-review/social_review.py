#!/usr/bin/env python3
"""Review platform variants in ClawTab and publish through BMUX social plugins."""
import argparse
import contextlib
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
STATE = Path.home() / '.local/state/clawtab/social-review'
LIBRARY = Path.home() / 'Movies/video-library'
MEDIA_ROOT = Path('/Volumes/sam/movies/tonisdev/social-reviews')
VIDEO_SITES = {'tiktok', 'instagram', 'youtube'}


class WorkflowError(RuntimeError):
    pass


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def file_hash(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.social-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
        fd = os.open(path.parent, os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)
    finally:
        if os.path.exists(temporary): os.unlink(temporary)


@contextlib.contextmanager
def locked(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.with_suffix('.lock').open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def run_json(argv, payload=None, timeout=60, env=None):
    result = subprocess.run([str(arg) for arg in argv], input=json.dumps(payload) if payload is not None else None,
                            capture_output=True, text=True, timeout=timeout, env=env)
    if result.returncode:
        raise WorkflowError(f'{argv[0]} {argv[1]} failed (exit {result.returncode})')
    try: value = json.loads(result.stdout)
    except ValueError as error: raise WorkflowError(f'{argv[0]} returned invalid JSON') from error
    if isinstance(value, dict) and value.get('ok') is False:
        raise WorkflowError(str(value.get('error', 'Command failed')))
    return value


def message(*args, payload=None):
    return run_json(['cwtctl', 'message', *args], payload, timeout=75 if args[0] == 'wait' else 60)


def accounts():
    # Per-machine overrides retain the same explicit account/session contract.
    override = Path.home() / '.config/clawtab/social-accounts.json'
    return read(override if override.exists() else HERE / 'accounts.json')


def revision(target):
    return digest({key: value for key, value in target.items() if key != 'revision'})


def validate(bundle, bindings=None, verify_media=True):
    bindings = accounts() if bindings is None else bindings
    if not isinstance(bundle, dict) or bundle.get('schema_version') != 1:
        raise WorkflowError('Use schema_version: 1')
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}', bundle.get('id', '')):
        raise WorkflowError('Use a stable bundle id')
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', bundle.get('date', '')) or not bundle.get('title', '').strip():
        raise WorkflowError('Supply date and title')
    targets = bundle.get('targets', [])
    if not isinstance(targets, list) or not 1 <= len(targets) <= 8:
        raise WorkflowError('Include 1 to 8 platform targets')
    ids, sites = set(), set()
    for target in targets:
        site = target.get('platform'); binding = bindings.get(site)
        if not binding: raise WorkflowError(f'Configure the personal account for {site}')
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}', target.get('id', '')) or target['id'] in ids or site in sites:
            raise WorkflowError('Target IDs and platforms must be unique')
        ids.add(target['id']); sites.add(site)
        for key in ('account', 'account_url', 'profile', 'session', 'window'):
            if target.get(key) != binding.get(key): raise WorkflowError(f'{site} {key} differs from the configured personal account binding')
        body = target.get('body')
        if not isinstance(body, str) or not body.strip() or body != body.strip() or len(body.encode()) > 32000:
            raise WorkflowError('Supply trimmed post text, up to 32 KiB; long X posts are supported')
        media = target.get('media', [])
        if not isinstance(media, list) or len(media) > 10: raise WorkflowError('Invalid media list')
        if site in VIDEO_SITES and (len(media) != 1 or media[0].get('kind') != 'video' or not target.get('title') or len(target['title']) > 100):
            raise WorkflowError('Video platforms need one video and a title up to 100 characters')
        for item in media:
            path = Path(item.get('path', ''))
            if item.get('kind') not in ('image', 'video') or not path.is_absolute() or not re.fullmatch(r'[a-f0-9]{64}', item.get('sha256', '')):
                raise WorkflowError('Media needs kind, absolute path and SHA-256')
            if verify_media and (not path.is_file() or path.stat().st_size > 128 * 1024 * 1024 or file_hash(path) != item['sha256']):
                raise WorkflowError('Media changed, is missing, or exceeds the review limit of 128 MiB')
        if target.get('revision') and target['revision'] != revision(target): raise WorkflowError('Draft revision changed')
    if len(json.dumps(bundle).encode()) > 256 * 1024: raise WorkflowError('Bundle exceeds 256 KiB')
    return bundle


def freeze(bundle, media_root=MEDIA_ROOT):
    frozen = copy.deepcopy(validate(bundle))
    for target in frozen['targets']:
        target.pop('revision', None)
        target.setdefault('media', [])
        for item in target.get('media', []):
            if not os.path.ismount('/Volumes/sam') or not str(media_root.resolve()).startswith('/Volumes/sam/movies/'):
                raise WorkflowError('Mount /Volumes/sam before preparing review media')
            source = Path(item['path'])
            destination = media_root / frozen['id'] / item['sha256'] / source.name
            destination.parent.mkdir(parents=True, exist_ok=True)
            if not destination.exists():
                fd, name = tempfile.mkstemp(dir=destination.parent)
                os.close(fd)
                try:
                    shutil.copyfile(source, name)
                    if file_hash(name) != item['sha256']: raise WorkflowError('Media changed while copying')
                    os.chmod(name, 0o444); os.replace(name, destination)
                finally:
                    if os.path.exists(name): os.unlink(name)
            if file_hash(destination) != item['sha256']: raise WorkflowError('Frozen media changed')
            item['path'] = str(destination)
        target['revision'] = revision(target)
    return validate(frozen)


def sync_library(bundle_path, receipt_path=None, library=LIBRARY):
    script = library / 'scripts/import-social.ts'
    if not script.is_file(): raise WorkflowError('Install the content library social importer before review')
    return run_json([library / 'node_modules/.bin/tsx', script, bundle_path, *([receipt_path] if receipt_path else [])])


def request_for(bundle, library_url):
    media, targets = [], []
    for target in bundle['targets']:
        indices = []
        for item in target.get('media', []):
            indices.append(len(media)); media.append({'kind': item['kind'], 'src': item['path'], 'alt': item.get('alt', bundle['title'])})
        targets.append({key: target[key] for key in ('id', 'revision', 'platform', 'account', 'body')} | {
            'title': target.get('title', ''), 'media_indices': indices,
            'session': target['session'], 'window': target['window']})
    if len(media) > 32: raise WorkflowError('Review supports 32 attachments across platforms')
    return {'title': bundle['title'], 'body': bundle.get('summary', 'Review each platform, then send your publication decisions.'),
            'template': 'social-review', 'kind': 'approval', 'channels': ['desktop', 'mobile'],
            'response_destination': 'result', 'media': media, 'data': {'targets': targets, 'library_url': library_url,
            'details': bundle.get('rationale', '')}, 'dedupe_key': 'social:' + digest(bundle),
            'actions': [{'id': 'decide', 'label': 'Send platform decisions', 'kind': 'choice'}],
            'expires_at': int((time.time() + 86400) * 1000)}


def review(bundle, state_root=STATE):
    bundle = freeze(bundle); directory = state_root / digest(bundle)
    receipt_path, bundle_path = directory / 'receipt.json', directory / 'bundle.json'
    with locked(receipt_path):
        if receipt_path.exists():
            receipt = read(receipt_path)
            if receipt.get('message_id'): return receipt_path
        atomic_json(bundle_path, bundle)
        receipt = {'schema_version': 1, 'bundle': str(bundle_path), 'bundle_sha256': digest(bundle), 'targets': {
            target['id']: {'phase': 'pending', 'revision': target['revision']} for target in bundle['targets']}}
        atomic_json(receipt_path, receipt)
        library = sync_library(bundle_path, receipt_path)
        receipt['library_url'] = library['url']; receipt['request'] = request_for(bundle, library['url'])
        atomic_json(receipt_path, receipt)
        sent = message('send', '--stdin', payload=receipt['request'])
        record = sent.get('record', sent)
        receipt['message_id'] = record.get('id') or sent.get('id')
        if not receipt['message_id']: raise WorkflowError('ClawTab did not return a message ID')
        # ClawTab fills source attribution and typed action defaults on delivery.
        # Keep that exact saved request for subsequent approval comparisons.
        if not isinstance(record.get('request'), dict):
            record = message('get', receipt['message_id']); record = record.get('record', record)
        if not isinstance(record.get('request'), dict): raise WorkflowError('ClawTab did not return the saved review request')
        receipt['request'] = record['request']
        atomic_json(receipt_path, receipt)
        sync_library(bundle_path, receipt_path)
    return receipt_path


def decisions_for(record, receipt, reconcile=False):
    wanted, response = receipt['request'], record.get('response') or {}
    if record.get('id') != receipt['message_id'] or any(record.get('request', {}).get(key) != value for key, value in wanted.items()):
        raise WorkflowError('The reviewed content changed')
    if record.get('wait_timed_out') or record.get('status') != 'resolved' or response.get('status') != 'resolved' or response.get('request_id') != receipt['message_id'] or response.get('action_id') != 'decide':
        raise WorkflowError('No saved platform decisions')
    if (response.get('text') or '').strip(): raise WorkflowError('Bundle comments require a new review')
    if response.get('responded_at', 0) > wanted['expires_at'] or not reconcile and time.time() * 1000 > wanted['expires_at']:
        raise WorkflowError('The review expired')
    decisions = response.get('decisions')
    if not isinstance(decisions, list) or len(decisions) != len(wanted['data']['targets']): raise WorkflowError('Missing platform decisions')
    result = {}
    for decision in decisions:
        target_id = decision.get('target_id'); state = receipt['targets'].get(target_id)
        if not state or target_id in result or decision.get('revision') != state['revision'] or decision.get('decision') not in ('approve', 'revise', 'deny'):
            raise WorkflowError('Invalid platform decision or revision')
        if decision['decision'] == 'approve' and (decision.get('comment') or '').strip(): raise WorkflowError('Commented drafts need revision')
        result[target_id] = decision
    return result


class Bmux:
    def __init__(self):
        self.env = {**os.environ, 'BMUX_AGENT_TYPE': 'tmux', 'BMUX_AGENT_NAME': 'Social review publisher',
                    'BMUX_AGENT_PURPOSE': 'Publish the exact human-approved platform drafts through BMUX plugins'}

    def call(self, *args):
        value = run_json(['bmux', *args], env=self.env)
        return value.get('result', value)

    def binding(self, target, binding):
        matches = []
        for session in self.call('list-sessions'):
            if session['name'] != target['session']: continue
            for window in session.get('windows', []):
                if target['window'] not in (window['id'], window['name']): continue
                if binding.get('locked') and not window.get('locked'):
                    raise WorkflowError('The configured account window is no longer locked')
                for pane in window.get('panes', []):
                    host = urlparse(pane.get('url', '')).hostname or ''
                    expected = {'youtube': ('youtube.com',), 'bluesky': ('bsky.app',), 'mastodon': ('mastodon.social',), 'threads': ('threads.com', 'threads.net')}.get(target['platform'], (target['platform'] + '.com',))
                    if pane.get('profileId') == target['profile'] and any(host == site or host.endswith('.' + site) for site in expected):
                        matches.append({'pane': pane['id'], 'window_id': window['id'], 'session': session['name'], 'profile': pane['profileId'], 'url': pane['url']})
        if len(matches) != 1: raise WorkflowError('Expected one platform pane in the configured account session/window; update social-accounts.json')
        return matches[0]

    def poll(self, run_id, timeout):
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            run = next((item for item in self.call('plugin', 'runs') if item['id'] == run_id), None)
            if run and run.get('status') in ('completed', 'failed', 'cancelled'):
                value = run.get('result') or {}
                if run['status'] != 'completed': raise WorkflowError(f'Plugin run {run_id} {run["status"]}: {value.get("error", "inspect its saved result")}')
                return value
            time.sleep(1)
        raise WorkflowError(f'Plugin run {run_id} still pending; reconcile this run before continuing')

    def invoke(self, site, action, pane, parameters, target_state, save, timeout=240):
        previous = target_state.get('inflight')
        if previous:
            if previous['action'] != action: raise WorkflowError('Resolve the saved plugin run first')
            run_id = previous['id']
        else:
            run_id = self.call('plugin', 'run', f'bmux.{site}/{action}', '-t', pane, '--parameters', json.dumps(parameters))['id']
            target_state['inflight'] = {'id': run_id, 'action': action}; save()
        value = self.poll(run_id, timeout)
        target_state['last_plugin_run'] = target_state.pop('inflight'); target_state['last_plugin_result'] = value; save()
        return value


def prepared_manifest(target, state, path):
    if target['platform'] not in VIDEO_SITES:
        manifest = {**target, 'media': target.get('media', [])}
        atomic_json(path, manifest)
        return {'post_file': str(path)}
    binding = accounts()[target['platform']]
    destination = {'site': target['platform'], 'profileId': target['profile'], 'session': target['session'], 'window': state['binding']['window_id'],
                   'pane': state['binding']['pane'], 'account': {'url': target['account_url'], 'label': target['account'].lstrip('@')},
                   'caption': f'{target["title"]}\n\n{target["body"]}', 'listingUrl': binding['listing'], 'madeForKids': False}
    manifest = {'id': f'{path.parent.name[:28]}-{target["id"]}-{target["revision"][:12]}', 'media': target['media'][0],
                'title': target['title'], 'description': target['body'], 'publishNow': True, 'timezone': 'Asia/Bangkok',
                'receiptDirectory': str(path.parent / ('publication-' + target['id'])), 'targets': [destination]}
    atomic_json(path, manifest)
    return {'batch_file': str(path), 'no_repair': True, 'no_human': True}


def publish(receipt_path, browser=None):
    receipt_path = Path(receipt_path); browser = browser or Bmux()
    with locked(receipt_path):
        receipt = read(receipt_path); bundle = validate(read(receipt['bundle']))
        if digest(bundle) != receipt['bundle_sha256']: raise WorkflowError('Frozen bundle changed')
        record = message('get', receipt['message_id']); record = record.get('record', record)
        decisions = decisions_for(record, receipt)
        save = lambda: atomic_json(receipt_path, receipt)
        for target in bundle['targets']:
            state = receipt['targets'][target['id']]; choice = decisions[target['id']]
            state.update(decision=choice['decision'], comment=choice.get('comment') or '')
            if state['phase'] == 'verified': continue
            if choice['decision'] != 'approve': state['phase'] = 'revision_requested' if choice['decision'] == 'revise' else 'denied'; save(); continue
            if state['phase'] in ('submitting', 'uncertain'):
                state['phase'] = 'uncertain'; state['error'] = 'Reconcile the existing plugin run or permalink; no new submission'; save(); continue
            try:
                binding = browser.binding(target, accounts()[target['platform']])
                if state.get('binding') and any(state['binding'].get(key) != binding.get(key) for key in ('pane', 'window_id', 'session', 'profile')) and state.get('prepared'): raise WorkflowError('The prepared pane changed')
                state['binding'] = binding; save()
                pane, site = binding['pane'], target['platform']
                available = {item['id']: item for item in browser.call('plugin', 'list') if item.get('enabled')}
                actions = {action['id'] for action in available.get('bmux.' + site, {}).get('actions', [])}
                if not {'posting-capabilities', 'prepare-post', 'publish-post', 'verify-post', 'simulate'} <= actions: raise WorkflowError('Install the BMUX social publication actions')
                capability = state.get('capabilities') or browser.invoke(site, 'posting-capabilities', pane, {}, state, save)
                state['capabilities'] = capability; save()
                if any(not capability.get(item['kind']) for item in target.get('media', [])) or not target.get('media') and not capability.get('text'):
                    raise WorkflowError('This plugin does not support the approved content type')
                if not state.get('browsing'):
                    browser.call('navigate', '-t', pane, accounts()[site]['feed'])
                    state['phase'] = 'browsing'; save()
                    browsing = browser.invoke(site, 'simulate', pane, {'seconds': '90', 'allow_like': False, 'use_decisions': False,
                        'session': 'social-' + receipt['bundle_sha256'][:32], 'preset': 'observed-fast'}, state, save, timeout=240)
                    if browsing.get('status') != 'completed' or browsing.get('elapsedSeconds', 0) < 85 or not browsing.get('seen'):
                        raise WorkflowError('Pre-publication browsing needs input; inspect the plugin result')
                    state['browsing'] = {key: browsing.get(key) for key in ('status', 'elapsedSeconds', 'reportPath', 'seen')}; save()
                parameters = prepared_manifest(target, state, receipt_path.parent / f'{target["id"]}.json')
                if not state.get('prepared'):
                    state['phase'] = 'preparing'; save()
                    prepared = browser.invoke(site, 'prepare-post', pane, parameters, state, save, timeout=2400 if site in VIDEO_SITES else 240)
                    if prepared.get('status') != 'prepared': raise WorkflowError('Plugin preparation needs input; inspect its saved result')
                    state['prepared'] = prepared; state['draft_id'] = prepared.get('draftId'); save()
                validate(bundle)
                latest = message('get', receipt['message_id']); latest = latest.get('record', latest)
                if decisions_for(latest, receipt) != decisions: raise WorkflowError('Platform decisions changed before submission')
                state['phase'] = 'submitting'; save()
                parameters = parameters if site in VIDEO_SITES else {'draft_id': state['draft_id']}
                result = browser.invoke(site, 'publish-post', pane, parameters, state, save, timeout=2400 if site in VIDEO_SITES else 240)
                state['plugin_receipt'] = result
                url = result.get('url') or (result.get('receipt') or {}).get('url')
                if result.get('status') != 'published' or not url: raise WorkflowError('Submitted post is awaiting permalink verification')
                if site not in VIDEO_SITES:
                    browser.call('navigate', '-t', pane, url)
                    verified = browser.invoke(site, 'verify-post', pane, {'draft_id': state['draft_id'], 'url': url}, state, save)
                    if verified.get('status') != 'published' or verified.get('url') != url: raise WorkflowError('Public permalink verification needs input')
                    state['verification'] = verified
                state.update(phase='verified', url=url, verified_at=int(time.time() * 1000)); state.pop('error', None); save()
            except (WorkflowError, subprocess.TimeoutExpired) as error:
                state['phase'] = 'uncertain' if state['phase'] == 'submitting' else 'needs_input'
                state['error'] = str(error); save()
            finally:
                try: sync_library(receipt['bundle'], receipt_path)
                except WorkflowError as error: receipt['library_error'] = str(error); save()
        sync_library(receipt['bundle'], receipt_path)
        if not receipt.get('completion_sent') and all(state['phase'] in ('verified', 'denied', 'revision_requested') for state in receipt['targets'].values()):
            text = '\n'.join(f'{target["platform"]}: {receipt["targets"][target["id"]].get("url") or receipt["targets"][target["id"]]["phase"]}' for target in bundle['targets'])
            message('send', '--stdin', payload={'kind': 'completed', 'template': 'update', 'title': 'Social review decisions processed', 'body': text + '\n' + receipt['library_url'], 'dedupe_key': 'social-result:' + receipt['bundle_sha256']})
            receipt['completion_sent'] = True; save()
        return receipt


def reconcile(receipt_path, target_id, url=None, browser=None):
    receipt_path = Path(receipt_path); browser = browser or Bmux()
    with locked(receipt_path):
        receipt = read(receipt_path); bundle = validate(read(receipt['bundle']))
        if digest(bundle) != receipt['bundle_sha256']: raise WorkflowError('Frozen bundle changed')
        record = message('get', receipt['message_id']); record = record.get('record', record)
        choices = decisions_for(record, receipt, reconcile=True)
        if choices.get(target_id, {}).get('decision') != 'approve': raise WorkflowError('This target was not approved')
        target = next(item for item in bundle['targets'] if item['id'] == target_id)
        state = receipt['targets'][target_id]
        if state['phase'] == 'verified': return state
        if state['phase'] not in ('submitting', 'uncertain'): raise WorkflowError('Only a saved submission can be reconciled')
        save = lambda: atomic_json(receipt_path, receipt)
        binding = browser.binding(target, accounts()[target['platform']])
        if any(state['binding'].get(key) != binding.get(key) for key in ('pane', 'window_id', 'session', 'profile')):
            raise WorkflowError('Restore the original account pane before reconciliation')
        if state.get('inflight') and state['inflight']['action'] == 'publish-post':
            result = browser.poll(state['inflight']['id'], 2400)
            state['plugin_receipt'] = result; state['last_plugin_run'] = state.pop('inflight'); save()
        result = state.get('plugin_receipt') or state.get('last_plugin_result') or {}
        url = url or result.get('url') or (result.get('receipt') or {}).get('url')
        site, pane = target['platform'], binding['pane']
        if site in VIDEO_SITES:
            parameters = prepared_manifest(target, state, receipt_path.parent / f'{target["id"]}.json')
        else:
            if not url or not url.startswith('https://'): raise WorkflowError('Supply the exact existing post permalink with --url')
            browser.call('navigate', '-t', pane, url)
            parameters = {'draft_id': state['draft_id'], 'url': url}
        verified = browser.invoke(site, 'verify-post', pane, parameters, state, save, timeout=2400 if site in VIDEO_SITES else 240)
        verified_url = verified.get('url') or (verified.get('receipt') or {}).get('url')
        if verified.get('status') != 'published' or not verified_url or url and verified_url != url:
            raise WorkflowError('The existing post has not verified; preserve the saved attempt')
        state.update(phase='verified', url=verified_url, verification=verified, verified_at=int(time.time() * 1000)); state.pop('error', None); save()
        sync_library(receipt['bundle'], receipt_path)
        return state


def watch(receipt_path):
    receipt = read(receipt_path)
    failures = 0
    while True:
        try:
            result = message('wait', receipt['message_id'], '--timeout', '60')
        except (WorkflowError, OSError, subprocess.TimeoutExpired):
            failures += 1
            if failures >= 12: raise
            print('ClawTab wait interrupted; reconnecting in 5 seconds', file=sys.stderr, flush=True)
            time.sleep(5)
            continue
        failures = 0
        record = result.get('record', result)
        if record.get('wait_timed_out') or record.get('status') in ('pending', 'delivering'): continue
        if record.get('status') != 'resolved': return {'status': record.get('status'), 'receipt': str(receipt_path)}
        return publish(receipt_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('preview', 'review', 'publish', 'watch', 'sync'):
        command = commands.add_parser(name); command.add_argument('file', type=Path)
    command = commands.add_parser('verify'); command.add_argument('file', type=Path); command.add_argument('--target', required=True); command.add_argument('--url')
    args = parser.parse_args()
    try:
        if args.command == 'preview': value = validate(read(args.file))
        elif args.command == 'review': value = {'receipt': str(review(read(args.file)))}
        elif args.command == 'publish': value = publish(args.file)
        elif args.command == 'watch': value = watch(args.file)
        elif args.command == 'verify': value = reconcile(args.file, args.target, args.url)
        else:
            receipt = read(args.file); value = sync_library(receipt['bundle'], args.file)
        print(json.dumps(value, ensure_ascii=False, indent=2))
    except (WorkflowError, OSError, ValueError) as error:
        print(str(error), file=sys.stderr); return 1
    return 0


if __name__ == '__main__': sys.exit(main())
