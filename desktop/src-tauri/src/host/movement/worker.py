"""Provider-scoped snapshots and remote resume. Never reads login credentials."""
import base64
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sqlite3
import sys
import time
import uuid
from urllib.parse import urlsplit, urlunsplit
import zipfile

transfer = {'__name__': 'clawtab_transfer'}
exec(TRANSFER_SOURCE, transfer)
original_sensitive = transfer['sensitive']
SESSION_LIMIT = 128 * 1024 * 1024
# These CLI versions form the initial compatibility matrix. Unknown versions fail closed.
VERSIONS = {'claude': {'2.1.296'}, 'codex': {'0.162.1'}, 'opencode': {'1.19.0'}}


def run(arguments, cwd=None, timeout=30, env=None):
    result = subprocess.run(arguments, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout)
    if result.returncode:
        raise ValueError('Remote command failed; inspect the target terminal or tool configuration')
    if len(result.stdout) > SESSION_LIMIT:
        raise ValueError('Provider output exceeds the session limit')
    return result.stdout


def version(provider):
    if provider not in VERSIONS or not shutil.which(provider):
        raise ValueError('Install a supported provider CLI on this machine')
    found = re.search(rb'\b(\d+\.\d+\.\d+)\b', run([provider, '--version']))
    if not found or found.group(1).decode() not in VERSIONS[provider]:
        raise ValueError('This provider version has not been verified for cross-machine resume')
    return found.group(1).decode()


def regular(path, root):
    path, root = Path(path), Path(root)
    if not path.is_file() or path.is_symlink() or any(p.is_symlink() for p in path.parents):
        raise ValueError('Unsafe or missing session artifact')
    if not path.resolve().is_relative_to(root.resolve()) or path.stat().st_size > SESSION_LIMIT:
        raise ValueError('Session artifact is outside its provider directory or exceeds the limit')
    return path.read_bytes()


def read_jsonl(content):
    lines = content.splitlines()
    if not lines or len(lines) > 1000000:
        raise ValueError('Invalid provider transcript')
    return [json.loads(line) for line in lines if line.strip()]


def session_export(provider, session, cwd):
    home = Path.home()
    if provider in ('claude', 'codex'):
        uuid.UUID(session)
    if provider == 'claude':
        root = Path(os.environ.get('CLAUDE_CONFIG_DIR', home / '.claude')) / 'projects'
        matches = [p for p in root.glob('*/' + session + '.jsonl') if p.is_file()]
        if len(matches) != 1:
            raise ValueError('Claude conversation is missing or ambiguous')
        main = matches[0]
        content = regular(main, root)
        records = read_jsonl(content)
        if not any(r.get('sessionId') == session and r.get('type') in ('user', 'assistant') for r in records):
            raise ValueError('Unsupported Claude conversation format')
        files = {'session.jsonl': base64.b64encode(content).decode()}
        for path in sorted((main.parent / session / 'subagents').glob('agent-*.jsonl')):
            files['subagents/' + path.name] = base64.b64encode(regular(path, root)).decode()
        return {'provider': provider, 'id': session, 'cwd': cwd, 'files': files}
    if provider == 'codex':
        root = Path(os.environ.get('CODEX_HOME', home / '.codex'))
        matches = list((root / 'sessions').glob('**/*-' + session + '.jsonl'))
        if len(matches) != 1:
            raise ValueError('Codex rollout is missing or ambiguous')
        content = regular(matches[0], root / 'sessions')
        records = read_jsonl(content)
        metadata = next((r.get('payload', {}) for r in records if r.get('type') == 'session_meta'), {})
        if metadata.get('id') != session or metadata.get('cwd') != cwd:
            raise ValueError('Codex rollout does not match this execution')
        if any(r.get('type') == 'event_msg' and r.get('payload', {}).get('type') in ('goal_started', 'goal_resumed') for r in records):
            raise ValueError('Conversations with Codex goal history are not supported by this adapter yet')
        # A native rollout is resumed directly; never import another machine's SQLite database.
        return {'provider': provider, 'id': session, 'cwd': cwd, 'files': {matches[0].name: base64.b64encode(content).decode()}}
    if provider == 'opencode':
        if not re.fullmatch(r'ses_[A-Za-z0-9]+', session):
            raise ValueError('Invalid OpenCode session ID')
        data = json.loads(run(['opencode', 'export', session, '--pure'], cwd, timeout=60))
        if not isinstance(data.get('info'), dict) or data['info'].get('id') != session or not isinstance(data.get('messages'), list):
            raise ValueError('Unsupported OpenCode export format')
        return {'provider': provider, 'id': session, 'cwd': cwd, 'export': data}
    raise ValueError('This provider does not support cross-machine continuation')


def dependencies(cwd):
    path = Path(cwd)
    tools = []
    if (path / 'package.json').exists():
        tools += ['node']
        tools += ['pnpm' if (path / 'pnpm-lock.yaml').exists() else 'yarn' if (path / 'yarn.lock').exists() else 'npm']
    if (path / 'Cargo.toml').exists(): tools += ['cargo']
    if (path / 'go.mod').exists(): tools += ['go']
    if (path / 'pyproject.toml').exists() or (path / 'requirements.txt').exists(): tools += ['python3']
    return tools


def sensitive(name):
    return original_sensitive(name) or any(p in ('.claude', '.codex', '.opencode', '.mcp.json', '.worktrees', '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.secrets', 'secrets.json', 'secrets.yaml', 'secrets.yml', 'secrets.age', 'secrets.enc', 'credentials.json', 'auth.json') for p in Path(name).parts)


def source_info(request):
    cwd = str(Path(request['cwd']).resolve())
    root = Path(transfer['git'](cwd, 'rev-parse', '--show-toplevel'))
    if (root / '.gitmodules').exists():
        status = transfer['git'](root, 'submodule', 'status', '--recursive')
        if any(line.startswith(('-', '+', 'U')) for line in status.splitlines()):
            raise ValueError('Initialize submodules at their committed revisions before moving')
        transfer['git'](root, 'submodule', 'foreach', '--recursive', 'test -z "$(git status --porcelain)"')
        urls = transfer['git'](root, 'config', '-f', '.gitmodules', '--get-regexp', r'^submodule\..*\.url$')
        for line in urls.splitlines():
            url = line.split(None, 1)[1]
            if not safe_origin(url):
                raise ValueError('Move requires independent network URLs for submodule dependencies')
    # Preflight must remain usable during a turn, while the transcript may contain a partial last line.
    session_size = 0
    if request.get('capture'):
        data = session_export(request['provider'], request['session_id'], cwd)
        session_size = len(json.dumps(data).encode())
        if session_size > SESSION_LIMIT: raise ValueError('Conversation exceeds the session limit')
    model = request.get('model')
    if request['provider'] == 'opencode' and not model:
        database = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share')) / 'opencode/opencode.db'
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
            row = connection.execute("select json_extract(data,'$.model.providerID'),json_extract(data,'$.model.modelID') from message where session_id=? and json_extract(data,'$.role')='user' order by time_created desc limit 1", (request['session_id'],)).fetchone()
        if not row or not all(isinstance(value, str) and value for value in row):
            raise ValueError('OpenCode model identity has not been discovered yet')
        model = '/'.join(row)
    files = [f for f in transfer['git'](root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0') if f]
    excluded = [f for f in files if sensitive(f)]
    excluded += [f for f in transfer['git'](root, 'ls-files', '-z').split('\0') if f and sensitive(f)]
    files = [f for f in files if not sensitive(f)]
    if len(files) > 999: raise ValueError('Move supports at most 999 additional working files')
    if len(json.dumps(files + excluded).encode()) > 256 * 1024: raise ValueError('Move file preview exceeds the configured limit')
    for file in files: transfer['source_file'](root, file)
    return {'root': str(root), 'cwd_relative': str(Path(cwd).relative_to(root)),
            'provider_version': version(request['provider']), 'required_tools': dependencies(cwd),
            'files': files, 'excluded': excluded, 'session_size': session_size, 'model': model,
            'auth_provider': model.split('/', 1)[0] if request['provider'] == 'opencode' else None}


def safe_origin(url):
    parsed = urlsplit(url)
    if parsed.scheme in ('https', 'http', 'ssh') and parsed.hostname not in (None, 'localhost', '127.0.0.1', '::1'):
        # Never carry HTTP credentials, query parameters, or fragments between hosts.
        authority = parsed.netloc if parsed.scheme == 'ssh' and not parsed.password else parsed.netloc.rsplit('@', 1)[-1]
        return urlunsplit((parsed.scheme, authority, parsed.path, '', ''))
    if re.fullmatch(r'[A-Za-z0-9_-]+@[A-Za-z0-9.-]+:[^\s]+', url) and '@localhost:' not in url:
        return url
    return None


def preflight(request):
    provider = request['provider']
    current = version(provider)
    if current != request['provider_version']:
        raise ValueError('Source and target provider versions must match the verified compatibility matrix')
    for tool in ('git', 'tmux', 'python3'):
        if not shutil.which(tool): raise ValueError('Install Git, tmux, and Python 3 on the target')
    # Only the exit status is used; credential values are never read or returned.
    if provider == 'codex': run(['codex', 'login', 'status'])
    elif provider == 'claude':
        status = json.loads(run(['claude', 'auth', 'status', '--json']))
        if status.get('loggedIn') is not True: raise ValueError('Sign in to Claude on the target first')
    else:
        provider_id = request.get('auth_provider')
        if not isinstance(provider_id, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', provider_id):
            raise ValueError('Selected OpenCode provider is unavailable')
        auth_file = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share')) / 'opencode/auth.json'
        available = False
        if auth_file.exists():
            auth = json.loads(regular(auth_file, auth_file.parent))
            entry = auth.get(provider_id, {})
            available = entry.get('type') in ('api', 'oauth') and bool(entry.get('key') or entry.get('access') or entry.get('refresh'))
        environment_key = {'anthropic': 'ANTHROPIC_API_KEY', 'openai': 'OPENAI_API_KEY', 'opencode': 'OPENCODE_API_KEY'}.get(provider_id)
        if not available and not (environment_key and os.environ.get(environment_key)):
            raise ValueError('Configure credentials for the selected OpenCode provider on the target first')
    destination = Path(request['destination']).expanduser()
    if not destination.is_absolute() or '..' in destination.parts or any(p.is_symlink() for p in (destination, *destination.parents)):
        raise ValueError('Choose an absolute destination without symlinks')
    parent = destination
    while not parent.exists(): parent = parent.parent
    if not parent.is_dir() or not os.access(parent, os.W_OK): raise ValueError('Destination is not writable')
    if destination.exists() and (not destination.is_dir() or not (destination / '.git').exists()):
        raise ValueError('Existing destination must be a Git repository')
    if shutil.disk_usage(parent).free < 2 * transfer['LIMIT']:
        raise ValueError('Target needs at least twice the configured transfer limit in free space')
    missing = [tool for tool in request.get('required_tools', []) if not shutil.which(tool)]
    return {'destination': str(destination), 'provider_version': current, 'missing_tools': missing,
            'setup_available': bool(request.get('required_tools')), 'needs_setup': bool(missing), 'ready': not missing}


def prepare(request):
    info = source_info({**request, 'capture': True})
    operation = request['operation_id']
    transfer['sensitive'] = sensitive
    manifest = transfer['main']({'action': 'transfer_prepare', 'operation_id': operation,
                                 'path': info['root'], 'files': info['files']})
    directory = Path.home() / '.config/clawtab/operations' / operation
    archive = directory / 'payload.zip'
    session = session_export(request['provider'], request['session_id'], request['cwd'])
    session.update(version=info['provider_version'], cwd_relative=info['cwd_relative'], model=info['model'], effort=request.get('effort'))
    content = json.dumps(session).encode()
    with zipfile.ZipFile(archive) as source:
        if 'move-session.json' in source.namelist():
            if source.read('move-session.json') != content: raise ValueError('Conversation changed after capture')
        else:
            with zipfile.ZipFile(archive, 'a', zipfile.ZIP_DEFLATED) as output:
                output.writestr('move-session.json', content)
    if archive.stat().st_size > transfer['LIMIT']: raise ValueError('Move exceeds the configured transfer limit')
    manifest.update(size=archive.stat().st_size, sha256=transfer['digest'](archive))
    manifest['excluded'] = sorted(set(manifest['excluded'] + info['excluded']))
    (directory / 'manifest.json').write_text(json.dumps(manifest))
    return manifest


def write_once(path, content):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if any(p.is_symlink() for p in (path, *path.parents)): raise ValueError('Unsafe provider destination')
    if path.exists():
        if regular(path, path.parent) != content: raise ValueError('Provider session already exists with different contents')
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    with os.fdopen(fd, 'wb') as target:
        target.write(content)
        target.flush()
        os.fsync(target.fileno())


def persist(path, value):
    temporary = path.with_name('.' + str(uuid.uuid4()) + '.tmp')
    write_once(temporary, json.dumps(value).encode())
    temporary.replace(path)
    fd = os.open(path.parent, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)


def import_session(request):
    operation = str(uuid.UUID(request['operation_id']))
    directory = Path.home() / '.config/clawtab/operations' / operation
    marker = directory / 'move-import.json'
    if marker.exists(): return json.loads(marker.read_text())
    received = transfer['main']({'action': 'transfer_finish', 'operation_id': operation})
    old_worktree = Path(received['path'])
    worktree = old_worktree.with_name('move-' + operation)
    if not worktree.exists():
        transfer['git'](old_worktree.parent.parent, 'worktree', 'move', str(old_worktree), str(worktree))
    with zipfile.ZipFile(directory / 'incoming.zip') as archive:
        if archive.getinfo('move-session.json').file_size > SESSION_LIMIT: raise ValueError('Session exceeds limit')
        session = json.loads(archive.read('move-session.json'))
    provider, sid = session['provider'], session['id']
    if version(provider) != session['version']: raise ValueError('Provider version changed; rerun readiness checks')
    relative = Path(session['cwd_relative'])
    if relative.is_absolute() or '..' in relative.parts: raise ValueError('Unsafe session working directory')
    cwd = worktree / relative
    if not cwd.is_dir() or not cwd.resolve().is_relative_to(worktree.resolve()): raise ValueError('Session working directory is missing')
    old_cwd = session['cwd']
    if provider == 'claude':
        uuid.UUID(sid)
        root = Path(os.environ.get('CLAUDE_CONFIG_DIR', Path.home() / '.claude')) / 'projects'
        encoded = re.sub(r'[^A-Za-z0-9]', '-', str(cwd))
        if len(encoded) > 200: raise ValueError('Claude destination path is too long for the verified adapter')
        for name, text in session['files'].items():
            if name != 'session.jsonl' and not re.fullmatch(r'subagents/agent-[A-Za-z0-9_-]+\.jsonl', name): raise ValueError('Unsafe Claude artifact name')
            records = read_jsonl(base64.b64decode(text, validate=True))
            for record in records:
                if record.get('cwd') == old_cwd: record['cwd'] = str(cwd)
            content = b''.join(json.dumps(record).encode() + b'\n' for record in records)
            path = root / encoded / (sid + '.jsonl') if name == 'session.jsonl' else root / encoded / sid / name
            write_once(path, content)
    elif provider == 'codex':
        uuid.UUID(sid)
        if len(session['files']) != 1: raise ValueError('Unsupported Codex artifact set')
        name, text = next(iter(session['files'].items()))
        if not re.fullmatch(r'rollout-[A-Za-z0-9:T._-]+-' + re.escape(sid) + r'\.jsonl', name): raise ValueError('Unsafe Codex artifact name')
        records = read_jsonl(base64.b64decode(text, validate=True))
        for record in records:
            if record.get('type') in ('session_meta', 'turn_context'):
                payload = record.get('payload', {})
                if payload.get('cwd') == old_cwd: payload['cwd'] = str(cwd)
        root = Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')) / 'sessions'
        date = re.search(r'rollout-(\d{4})-(\d{2})-(\d{2})', name)
        if not date: raise ValueError('Unsupported Codex rollout name')
        write_once(root.joinpath(*date.groups(), name), b''.join(json.dumps(r).encode() + b'\n' for r in records))
    elif provider == 'opencode':
        data = session['export']
        data['info']['directory'] = str(cwd)
        data['info'].pop('parentID', None)
        database = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local/share')) / 'opencode/opencode.db'
        if database.exists():
            if database.is_symlink(): raise ValueError('Unsafe OpenCode session storage')
            with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True) as connection:
                if connection.execute('select 1 from session where id=?', (sid,)).fetchone():
                    raise ValueError('OpenCode conversation already exists on the target; inspect it before moving')
        exported = directory / 'opencode-session.json'
        write_once(exported, json.dumps(data).encode())
        run(['opencode', 'import', str(exported), '--pure'], str(cwd), timeout=60)
    else: raise ValueError('Unsupported provider')
    value = {'path': str(worktree), 'cwd': str(cwd), 'provider': provider, 'session_id': sid,
             'model': session.get('model'), 'effort': session.get('effort')}
    persist(marker, value)
    return value


def launch(request):
    operation = str(uuid.UUID(request['operation_id']))
    directory = Path.home() / '.config/clawtab/operations' / operation
    if (directory / 'move-aborted.json').exists():
        raise ValueError('This move was aborted; create a new move instead of launching it again')
    if request.get('setup') and (directory / 'setup-stopped.json').exists():
        raise ValueError('Remote setup was stopped; it cannot be launched again')
    state_file = directory / ('setup-launch.json' if request.get('setup') else 'move-launch.json')
    if state_file.exists(): return json.loads(state_file.read_text())
    session = import_session(request)
    provider = session['provider']
    if provider not in ('claude', 'codex'):
        raise ValueError('Interactive idle handoff is not verified for this provider yet')
    if request.get('setup'):
        prompt = ('Prepare this project to run independently on this remote machine. Install missing project dependencies and verify the documented build/test commands. '
                  'Use only credentials already configured here. Do not contact the source machine, copy credentials, deploy, or change project behavior. '
                  'Ask before privileged or destructive operations. Finish with a report of remaining requirements.')
        arguments = [provider, prompt] if provider == 'claude' else [provider, '--prompt', prompt] if provider == 'opencode' else [provider, '--no-daemon', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', prompt]
    else:
        arguments = ['claude', '--resume', session['session_id']] if provider == 'claude' else ['codex', 'resume', session['session_id'], '-C', session['cwd'], '--no-daemon', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'] if provider == 'codex' else ['opencode', '--session', session['session_id']]
        if session.get('model'): arguments += ['--model', session['model']]
        if session.get('effort'):
            if provider == 'codex': arguments += ['-c', 'model_reasoning_effort=' + session['effort']]
            elif provider == 'claude': arguments += ['--effort', session['effort']]
    launcher = directory / ('setup-launcher.py' if request.get('setup') else 'move-launcher.py')
    # Only target-side values arrive here, through the worker's inherited environment.
    required_keys = request.get('secret_keys', [])
    values = {key: os.environ[key] for key in required_keys if key in os.environ}
    if len(values) != len(required_keys): raise ValueError('Required target secret is unavailable')
    script = ('import os\nfrom pathlib import Path\n'
              'Path(__file__).unlink()\n'
              'environment = dict(os.environ)\n'
              'environment.update(' + repr(values) + ')\n'
              'arguments = ' + repr(arguments) + '\n'
              'os.execvpe(arguments[0], arguments, environment)\n')
    write_once(launcher, script.encode())
    name = ('clawtab-setup-' if request.get('setup') else 'clawtab-move-') + operation
    # A durable claim precedes launch. A crash here is ambiguous and must not auto-launch again.
    launched_at = int(time.time() * 1000)
    persist(state_file, {'state': 'launching', 'tmux_session': name, 'launched_at': launched_at, **session})
    command = shlex.join(['python3', str(launcher)])
    pane, pid = run(['tmux', 'new-session', '-d', '-s', name, '-c', session['cwd'], '-P', '-F', '#{pane_id} #{pane_pid}', command]).decode().strip().split()
    if not re.fullmatch(r'%[0-9]+', pane) or not pid.isdigit(): raise ValueError('Invalid target pane acknowledgement')
    started = run(['ps', '-p', pid, '-o', 'lstart='], env={**os.environ, 'LC_ALL': 'C'}).decode().strip()
    pane_started = int(datetime.datetime.strptime(started, '%a %b %d %H:%M:%S %Y').timestamp())
    value = {'state': 'launched', 'pane_id': pane, 'pane_pid': pid, 'pane_started': pane_started, 'tmux_session': name, 'launched_at': launched_at, **session}
    persist(state_file, value)
    return value


def dispatch(request):
    action = request['action']
    if action == 'source_info': return source_info(request)
    if action == 'preflight': return preflight(request)
    if action == 'prepare': return prepare(request)
    if action == 'import': return import_session(request)
    if action == 'launch': return launch(request)
    if action == 'cleanup':
        directory = Path.home() / '.config/clawtab/operations' / str(uuid.UUID(request['operation_id']))
        for name in ('payload.zip', 'incoming.zip', 'payload.partial', 'history.bundle', 'staged.patch', 'unstaged.patch', 'opencode-session.json', 'setup-launcher.py', 'move-launcher.py'):
            (directory / name).unlink(missing_ok=True)
        return {'cleaned': True}
    if action == 'transfer_read':
        operation = str(uuid.UUID(request['operation_id']))
        archive = Path.home() / '.config/clawtab/operations' / operation / 'payload.zip'
        with archive.open('rb') as source:
            source.seek(request['offset'])
            data = source.read(32 * 1024)
        return {'data': base64.b64encode(data).decode(), 'offset': request['offset'] + len(data)}
    if action.startswith('transfer_'): return transfer['main'](request)
    raise ValueError('Unsupported move worker operation')


if __name__ == '__main__':
    os.umask(0o077)
    try:
        transfer['signal'].alarm(600)
        transfer['resource'].setrlimit(transfer['resource'].RLIMIT_FSIZE, (transfer['LIMIT'], transfer['LIMIT']))
        if sys.platform == 'linux':
            transfer['resource'].setrlimit(transfer['resource'].RLIMIT_AS, (2 * transfer['LIMIT'] + 256 * 1024 ** 2, 2 * transfer['LIMIT'] + 256 * 1024 ** 2))
        request = json.load(sys.stdin)
        if request.get('operation_id'):
            operation = str(uuid.UUID(request['operation_id']))
            directory = Path.home() / '.config/clawtab/operations' / operation
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            if any(p.is_symlink() for p in (directory, *directory.parents)): raise ValueError('Unsafe operation directory')
            fd = os.open(directory / 'move-worker.lock', os.O_CREAT | os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0), 0o600)
            with os.fdopen(fd, 'r+') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                result = dispatch(request)
        else: result = dispatch(request)
        print(json.dumps({'result': result}))
    except Exception as error:
        # Exceptions from subprocesses and parsers may contain private content.
        message = str(error) if type(error) is ValueError and not isinstance(error, json.JSONDecodeError) else 'Move worker failed; inspect the target configuration'
        print(json.dumps({'error': message}))
        sys.exit(1)
