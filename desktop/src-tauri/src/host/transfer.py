"""Explicit immutable Git transfers. Invoked by the host with JSON on stdin."""
import base64
import fcntl
import resource
import signal
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import time
import uuid
import zipfile

LIMIT = int(os.environ.get('CLAWTAB_TRANSFER_MAX_BYTES', 1024 ** 3))
CHUNK = 256 * 1024


def git(root, *args, binary=False):
    result = subprocess.run(['git', '-C', str(root), *args], capture_output=True,
                            env={**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GIT_SSH_COMMAND': 'ssh -o BatchMode=yes'}, timeout=180)
    if result.returncode:
        raise ValueError('Git operation failed; check the repository and host credentials')
    return result.stdout if binary else result.stdout.decode().strip()


def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(CHUNK), b''):
            value.update(chunk)
    return value.hexdigest()


def safe_relative(value):
    path = PurePosixPath(value)
    if not value or path.is_absolute() or '..' in path.parts or '.git' in path.parts or '\\' in value:
        raise ValueError('unsafe transfer path')
    return path


def sensitive(value):
    parts = PurePosixPath(value).parts
    return any(p in ('.ssh', '.aws', '.gnupg', 'credentials', 'id_rsa', 'id_ed25519') or
               p == '.env' or p.startswith('.env.') or p.endswith(('.pem', '.key')) for p in parts)


def source_file(root, name):
    relative = safe_relative(name)
    target = root.joinpath(*relative.parts)
    if target.is_symlink() or any(parent.is_symlink() for parent in target.parents if parent != root and root in parent.parents):
        raise ValueError('symlinks cannot be selected for transfer')
    if not target.is_file() or not target.resolve().is_relative_to(root.resolve()):
        raise ValueError('only regular repository files can be transferred')
    return target


def prepare(request, directory):
    archive = directory / 'payload.zip'
    metadata = directory / 'prepare.json'
    if metadata.exists() and json.loads(metadata.read_text()) != request:
        raise ValueError('transfer ID already used for another source')
    metadata.write_text(json.dumps(request))
    if archive.exists() and (directory / 'manifest.json').exists():
        return json.loads((directory / 'manifest.json').read_text())
    root = Path(git(request['path'], 'rev-parse', '--show-toplevel'))
    selected = request['files']
    if len(selected) > 1000 or len(selected) != len(set(selected)):
        raise ValueError('select at most 1000 unique files')
    if sum(source_file(root, name).stat().st_size for name in selected) > LIMIT:
        raise ValueError('selected files exceed size limit')
    tracked = git(root, 'ls-files', '-z', binary=True).decode().split('\0')
    excluded = [name for name in tracked if name and sensitive(name) and name not in selected]
    specs = ['.'] + [':(literal,exclude)' + name for name in excluded]
    head = git(root, 'rev-parse', 'HEAD')
    def patches():
        return (git(root, 'diff', '--binary', '--no-ext-diff', '--no-textconv', '--cached', 'HEAD', '--', *specs, binary=True),
                git(root, 'diff', '--binary', '--no-ext-diff', '--no-textconv', '--', *specs, binary=True))
    staged, unstaged = patches()
    if len(staged) + len(unstaged) > LIMIT:
        raise ValueError('patches exceed size limit')
    files = {name: {'sha256': digest(source_file(root, name)), 'mode': source_file(root, name).stat().st_mode & 0o777} for name in selected}
    # HEAD includes unpublished commits without changing refs in the source repository.
    git(root, 'bundle', 'create', str(directory / 'history.bundle'), 'HEAD')
    if (directory / 'history.bundle').stat().st_size + len(staged) + len(unstaged) + sum(source_file(root, name).stat().st_size for name in selected) > LIMIT:
        (directory / 'history.bundle').unlink(missing_ok=True)
        raise ValueError('repository history and working changes exceed size limit')
    manifest = {'head': head, 'files': files, 'excluded': excluded,
                'changes': git(root, 'status', '--short'), 'created_at': time.time()}
    temporary = directory / 'payload.partial'
    with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as output:
        output.write(directory / 'history.bundle', 'history.bundle')
        output.writestr('staged.patch', staged)
        output.writestr('unstaged.patch', unstaged)
        output.writestr('manifest.json', json.dumps(manifest))
        for index, name in enumerate(selected):
            output.write(source_file(root, name), 'files/' + str(index))
    if head != git(root, 'rev-parse', 'HEAD') or patches() != (staged, unstaged) or any(digest(source_file(root, name)) != meta['sha256'] for name, meta in files.items()):
        temporary.unlink(missing_ok=True)
        raise ValueError('source changed during capture; retry the transfer')
    if temporary.stat().st_size > LIMIT:
        temporary.unlink()
        raise ValueError('transfer exceeds configured size limit')
    temporary.replace(archive)
    manifest.update(size=archive.stat().st_size, sha256=digest(archive))
    (directory / 'manifest.json').write_text(json.dumps(manifest))
    (directory / 'history.bundle').unlink(missing_ok=True)
    return manifest


def begin(request, directory):
    if request['size'] < 0 or request['size'] > LIMIT or len(request['sha256']) != 64:
        raise ValueError('invalid transfer size or hash')
    metadata = directory / 'receive.json'
    if metadata.exists() and json.loads(metadata.read_text()) != request:
        raise ValueError('transfer ID already used for another payload')
    metadata.write_text(json.dumps(request))
    archive = directory / 'incoming.zip'
    archive.touch(exist_ok=True)
    return {'offset': archive.stat().st_size}


def write(request, directory):
    metadata = json.loads((directory / 'receive.json').read_text())
    content = base64.b64decode(request['data'], validate=True)
    archive = directory / 'incoming.zip'
    if request['offset'] < 0 or not content or len(content) > CHUNK or request['offset'] + len(content) > metadata['size']:
        raise ValueError('invalid transfer chunk')
    if request['offset'] < archive.stat().st_size:
        with archive.open('rb') as source:
            source.seek(request['offset'])
            if source.read(len(content)) == content:
                return {'offset': request['offset'] + len(content)}
    if request['offset'] != archive.stat().st_size:
        raise ValueError('transfer offset mismatch')
    with archive.open('ab') as target:
        target.write(content)
    return {'offset': archive.stat().st_size}


def finish(request, directory):
    result_path = directory / 'completed.json'
    if result_path.exists():
        return json.loads(result_path.read_text())
    metadata = json.loads((directory / 'receive.json').read_text())
    archive = directory / 'incoming.zip'
    if archive.stat().st_size != metadata['size'] or digest(archive) != metadata['sha256']:
        raise ValueError('transfer hash or length mismatch')
    destination = Path(metadata['path']).expanduser()
    if not destination.is_absolute() or '..' in destination.parts:
        raise ValueError('absolute destination repository path required')
    if (destination / '.worktrees').is_symlink():
        raise ValueError('destination must not contain symlinks')
    destination = destination.resolve()
    worktree = destination / '.worktrees' / ('transfer-' + request['operation_id'])
    if worktree.exists():
        raise ValueError('destination worktree already exists; inspect it before retrying')
    with zipfile.ZipFile(archive) as source:
        names = [entry.filename for entry in source.infolist()]
        if len(names) != len(set(names)) or len(names) > 1004:
            raise ValueError('invalid transfer archive entries')
        if sum(entry.file_size for entry in source.infolist()) > LIMIT:
            raise ValueError('expanded transfer exceeds size limit')
        manifest = json.loads(source.read('manifest.json'))
        for name in manifest['files']:
            safe_relative(name)
        for name in ('history.bundle', 'staged.patch', 'unstaged.patch'):
            with source.open(name) as incoming, (directory / name).open('wb') as outgoing:
                shutil.copyfileobj(incoming, outgoing, CHUNK)
        bundle = directory / 'history.bundle'
        if not destination.exists():
            destination.mkdir(parents=True)
            git(destination, 'init', '-q')
        git(destination, 'bundle', 'verify', str(bundle))
        git(destination, 'fetch', str(bundle), 'HEAD')
        if git(destination, 'rev-parse', 'FETCH_HEAD') != manifest['head']:
            raise ValueError('bundle revision mismatch')
        git(destination, 'worktree', 'add', '--detach', str(worktree), manifest['head'])
        try:
            for name, flags in [('staged.patch', ['--index']), ('unstaged.patch', [])]:
                patch = directory / name
                if patch.stat().st_size:
                    git(worktree, 'apply', *flags, '--binary', str(patch))
            for index, (name, details) in enumerate(manifest['files'].items()):
                path = worktree.joinpath(*safe_relative(name).parts)
                if not path.resolve().is_relative_to(worktree.resolve()) or path.is_symlink():
                    raise ValueError('transfer path escapes worktree')
                path.parent.mkdir(parents=True, exist_ok=True)
                with source.open('files/' + str(index)) as incoming, path.open('wb') as outgoing:
                    shutil.copyfileobj(incoming, outgoing, CHUNK)
                if digest(path) != details['sha256']:
                    raise ValueError('file hash mismatch')
                path.chmod(details['mode'] & 0o777)
            if (worktree / '.gitmodules').exists():
                git(worktree, 'submodule', 'update', '--init', '--recursive')
            if (worktree / '.gitattributes').exists() and 'filter=lfs' in (worktree / '.gitattributes').read_text():
                git(worktree, 'lfs', 'pull')
        except Exception as error:
            raise ValueError('transfer is incomplete at ' + str(worktree) + ': ' + str(error)) from error
    result = {'path': str(worktree), 'head': manifest['head'], 'status': 'completed'}
    result_path.write_text(json.dumps(result))
    return result


def dispatch(request, directory):
    action = request['action']
    if action == 'transfer_prepare':
        return prepare(request, directory)
    if action == 'transfer_begin':
        return begin(request, directory)
    if action == 'transfer_write':
        return write(request, directory)
    if action == 'transfer_finish':
        return finish(request, directory)
    if action == 'transfer_cancel':
        (directory / 'cancelled').touch()
        for name in ('payload.zip', 'incoming.zip', 'payload.partial'):
            (directory / name).unlink(missing_ok=True)
        return {'cancelled': True}
    if action == 'transfer_read':
        if request['offset'] < 0:
            raise ValueError('invalid transfer offset')
        with (directory / 'payload.zip').open('rb') as source:
            source.seek(request['offset'])
            data = source.read(CHUNK)
        return {'data': base64.b64encode(data).decode(), 'offset': request['offset'] + len(data)}
    raise ValueError('unsupported transfer operation')


def main(request):
    os.umask(0o077)
    operation_id = str(uuid.UUID(request['operation_id']))
    directory = Path.home() / '.config/clawtab/operations' / operation_id
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    if directory.is_symlink():
        raise ValueError('unsafe operation directory')
    with (directory / 'transfer.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (directory / 'cancelled').exists() and request['action'] != 'transfer_cancel':
            raise ValueError('transfer was cancelled; create a new transfer')
        metadata = directory / 'receive.json'
        source_metadata = directory / 'prepare.json'
        existing = metadata if metadata.exists() else source_metadata
        if existing.exists() and time.time() - existing.stat().st_mtime > 24 * 60 * 60:
            for name in ('payload.zip', 'incoming.zip', 'payload.partial', 'history.bundle'):
                (directory / name).unlink(missing_ok=True)
            raise ValueError('transfer expired after 24 hours; create a new transfer')
        return dispatch(request, directory)


if __name__ == '__main__':
    try:
        signal.alarm(600)
        resource.setrlimit(resource.RLIMIT_FSIZE, (LIMIT, LIMIT))
        if sys.platform == 'linux':
            resource.setrlimit(resource.RLIMIT_AS, (2 * LIMIT + 256 * 1024 ** 2, 2 * LIMIT + 256 * 1024 ** 2))
        print(json.dumps({'result': main(json.load(sys.stdin))}))
    except Exception as error:
        print(json.dumps({'error': str(error)}))
        sys.exit(1)
