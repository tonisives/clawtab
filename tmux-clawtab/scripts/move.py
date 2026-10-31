"""Move subview. The daemon owns the operation when this popup closes."""
import concurrent.futures
import curses
import json
from pathlib import PurePath
import subprocess
import sys
import textwrap
import threading
import time
import uuid


def command(*args):
    result = subprocess.run(['cwt', 'move', *args], capture_output=True, text=True, timeout=240)
    if result.returncode:
        raise ValueError(result.stderr.strip() or 'Move command unavailable')
    return json.loads(result.stdout)


def main(screen):
    screen.timeout(100)
    curses.curs_set(0)
    pane = sys.argv[1]
    machines, source, preview, operation = [], None, None, None
    selected, destination, error, mode = 0, '~/workspace/my-project', None, 'targets'
    setup, pending, last_poll = False, None, 0
    def submit(action, *args):
        future = concurrent.futures.Future()
        def run():
            try: future.set_result(command(*args))
            except Exception as error: future.set_exception(error)
        threading.Thread(target=run, daemon=True).start()
        return action, future

    pending = submit('targets', 'targets')

    def lines():
        result = ['Move', 'Choose another machine for this conversation.', '', 'Credentials stay on each machine. Move payloads are encrypted end to end.', 'Terminal output still uses the current relay connection.', '']
        if mode == 'targets':
            for index, machine in enumerate(machines):
                status = 'online' if machine.get('online') else 'offline'
                verified = 'verified' if machine.get('verified') else 'verify machine keys first'
                result.append(('> ' if index == selected else '  ') + machine['name'] + ' (' + status + ', ' + verified + ')')
            if not machines: result.append('No other machines configured.')
            result += ['', ('> ' if selected == len(machines) else '  ') + 'Add machine', '', 'Up/down: choose   Enter: next   Esc: back']
        elif mode == 'preview':
            result += ['Destination repository: ' + destination, 'Provider: ' + str(source.get('provider')), '', 'Additional files:']
            result += preview.get('files', []) or ['None']
            result += ['', 'Excluded working files: ' + ', '.join(preview.get('excluded', [])), 'Git history and conversation text may contain sensitive content.', '']
            missing = preview['target'].get('missing_tools', [])
            if preview['target'].get('setup_available'):
                result += ['Missing tools: ' + ', '.join(missing) if missing else 'Optional: prepare project dependencies on the target.', '[x] Remote project setup confirmed' if setup else '[ ] Confirm remote project setup (press s)']
            result += ['', 'Enter: confirm move   Esc: choose another target']
        elif mode == 'status':
            result += [operation.get('progress', operation['state']), operation.get('error') or '', 'Source stops after the remote confirms the existing conversation is ready.', '', 'c: cancel before activation   r: check handoff   Esc: close']
            if operation.get('remote', {}).get('pane_id'):
                result += ['Open the target conversation in the desktop or mobile app.']
        if pending: result += ['', 'Working...']
        if error: result += ['', error]
        return result

    try:
        while True:
            if pending and pending[1].done():
                action, future = pending
                pending = None
                try:
                    value = future.result()
                    error = None
                    if action == 'targets': machines = value.get('machines', [])
                    elif action == 'add':
                        error = value.get('instructions') or 'Add the machine in the desktop app, then reopen Move to refresh targets.'
                    elif action == 'source':
                        source = value
                        destination = '~/workspace/' + PurePath(source['cwd']).name
                        screen.timeout(-1)
                        curses.echo()
                        screen.erase()
                        screen.addstr(1, 2, 'Destination repository path (Enter keeps ' + destination + '):')
                        supplied = screen.getstr(3, 2, 512).decode('utf-8')
                        curses.noecho()
                        screen.timeout(100)
                        destination = supplied or destination
                        pending = submit('preflight', 'preflight', pane, source['execution_id'], machines[selected]['id'], destination)
                    elif action == 'preflight': preview, mode, setup = value, 'preview', False
                    elif action in ('start', 'status'): operation, mode = value, 'status'
                except Exception as failure:
                    error = str(failure)
            if mode == 'status' and not pending and time.monotonic() - last_poll > 2:
                last_poll = time.monotonic()
                pending = submit('status', 'status', operation['operation_id'])
            screen.erase()
            rows, cols = screen.getmaxyx()
            rendered = []
            for line in lines(): rendered += textwrap.wrap(line, max(1, cols - 4)) or ['']
            for index, line in enumerate(rendered[:rows - 1]):
                screen.addnstr(index, 2, line, max(1, cols - 3))
            screen.refresh()
            key = screen.getch()
            if key in (27, ord('q')):
                if mode == 'preview': mode = 'targets'
                else: break
            if pending: continue
            if mode == 'targets':
                if key in (curses.KEY_UP, ord('k')): selected = max(0, selected - 1)
                elif key in (curses.KEY_DOWN, ord('j')): selected = min(len(machines), selected + 1)
                elif key in (10, 13):
                    if selected == len(machines): pending = submit('add', 'add-machine')
                    elif not machines[selected].get('online'): error = 'Choose an online machine.'
                    else: pending = submit('source', 'source', pane)
            elif mode == 'preview':
                if key == ord('s'): setup = not setup
                elif key in (10, 13):
                    if preview['target'].get('missing_tools') and not setup: error = 'Confirm remote project setup first.'
                    else:
                        args = ['start', str(uuid.uuid4()), pane, source['execution_id'], machines[selected]['id'], destination]
                        if setup: args.append('--setup')
                        pending = submit('start', *args)
            elif mode == 'status':
                if key == ord('c'): pending = submit('cancel', 'cancel', operation['operation_id'])
                elif key == ord('r'): pending = submit('check', 'check', operation['operation_id'])
    finally:
        # Requests already accepted by the daemon continue after the popup closes.
        pass


if __name__ == '__main__':
    try: curses.wrapper(main)
    except (KeyboardInterrupt, curses.error): pass
