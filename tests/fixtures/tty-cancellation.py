import json
import os
import pathlib
import pty
import signal
import subprocess
import sys
import tempfile
import time


def write_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def worker(root, behavior):
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    signal.signal(signal.SIGTSTP, signal.SIG_DFL)
    signal.signal(signal.SIGCONT, lambda *_: (root / 'continued').write_text('yes'))
    for sig in [signal.SIGINT, signal.SIGTERM]:
        signal.signal(sig, signal.SIG_IGN if behavior == 'ignore' else lambda *_: sys.exit(0))
    with open('/dev/tty') as tty:
        write_json(root / 'tty.json', {
            'stdin': os.isatty(0), 'stdout': os.isatty(1), 'stderr': os.isatty(2),
            'devTty': os.isatty(tty.fileno()),
            'foreground': os.tcgetpgrp(tty.fileno()) == os.getpgrp(),
        })
    # Publish the parent before spawning the grandchild: its readiness can never race this file.
    (root / 'child.pid').write_text(str(os.getpid()))
    if behavior != 'normal':
        subprocess.Popen([sys.executable, __file__, 'grandchild', str(root)])
    if behavior in ['normal', 'io', 'pipe']:
        if behavior == 'pipe':
            (root / 'pipe-input.txt').write_text(sys.stdin.readline())
            with open('/dev/tty') as tty:
                (root / 'input.txt').write_text(tty.readline())
        else:
            (root / 'input.txt').write_text(sys.stdin.readline())
        print('child stdout', flush=True)
        print('child stderr', file=sys.stderr, flush=True)
        if behavior == 'normal':
            sys.exit(7)
    while True:
        time.sleep(1)


def launcher(root, bun, entrypoint, behavior):
    # This shell stand-in survives terminal signals and observes foreground restoration.
    for sig in [signal.SIGHUP, signal.SIGINT, signal.SIGTERM, signal.SIGTSTP]:
        signal.signal(sig, signal.SIG_IGN)
    original_group = os.tcgetpgrp(0)
    sibling = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
    (root / 'sibling.pid').write_text(str(sibling.pid))
    wrapper = os.fork()
    if wrapper == 0:
        for sig in [signal.SIGHUP, signal.SIGINT, signal.SIGTERM, signal.SIGTSTP]:
            signal.signal(sig, signal.SIG_DFL)
        if behavior in ['normal', 'io', 'pipe']:
            for number, name in [(1, 'stdout.txt'), (2, 'stderr.txt')]:
                output = os.open(str(root / name), os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
                os.dup2(output, number)
                os.close(output)
        if behavior == 'pipe':
            reader, writer = os.pipe()
            os.write(writer, b'piped data\n')
            os.close(writer)
            os.dup2(reader, 0)
            os.close(reader)
        env = dict(os.environ, HACK_HOME=str(root / 'state'))
        os.execve(bun, [bun, *([entrypoint] if entrypoint else []), 'host', 'exec', '--path', str(root), '--no-interactive', '--', sys.executable, __file__, 'worker', str(root), behavior], env)
    (root / 'wrapper.pid').write_text(str(wrapper))
    while True:
        got, status = os.waitpid(wrapper, os.WNOHANG | os.WUNTRACED | os.WCONTINUED)
        if got and os.WIFSTOPPED(status):
            write_json(root / 'stopped.json', {'foregroundRestored': os.tcgetpgrp(0) == original_group})
        if (root / 'resume.request').exists():
            (root / 'resume.request').unlink()
            os.tcsetpgrp(0, original_group)
            os.killpg(os.getpgid(wrapper), signal.SIGCONT)
        if got and (os.WIFEXITED(status) or os.WIFSIGNALED(status)):
            write_json(root / 'completion.json', {
                'exit': os.waitstatus_to_exitcode(status),
                'foregroundRestored': os.tcgetpgrp(0) == original_group,
            })
            # Keep the terminal alive until the outer harness verifies the result.
            while True:
                time.sleep(1)
        time.sleep(.01)


def process_alive(pid):
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True)
    return result.returncode == 0 and not result.stdout.strip().startswith('Z')


def probe(bun, entrypoint, requested_signal, behavior, mode):
    with tempfile.TemporaryDirectory(prefix='hack-tty-') as temporary:
        root = pathlib.Path(temporary)
        config = root / '.hack'
        config.mkdir()
        (config / 'hack.config.json').write_text('{"name":"tty-regression"}')
        (config / 'docker-compose.yml').write_text('services:\n  noop:\n    image: alpine:3.20\n')
        (config / 'hack.env.default.yaml').write_text('version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global: {}\n')
        shell, fd = pty.fork()
        if shell == 0:
            launcher(root, bun, entrypoint, behavior)
            os._exit(0)
        os.set_blocking(fd, False)
        terminal_output = bytearray()

        def drain():
            while True:
                try:
                    data = os.read(fd, 65536)
                    if not data:
                        return
                    terminal_output.extend(data)
                except (BlockingIOError, OSError):
                    return

        def wait_for(names, seconds=8):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                drain()
                if all((root / name).exists() for name in names):
                    return True
                time.sleep(.01)
            return False

        try:
            ready = ['child.pid', 'sibling.pid', 'wrapper.pid', 'tty.json']
            if behavior != 'normal':
                ready.append('grandchild.pid')
            if not wait_for(ready, 10):
                raise RuntimeError('TTY fixture did not start: ' + terminal_output.decode(errors='replace'))
            wrapper = int((root / 'wrapper.pid').read_text())
            stopped = None
            if mode == 'resume':
                os.write(fd, b'\x1a')
                if not wait_for(['stopped.json']):
                    raise RuntimeError('Wrapper did not stop after foreground Ctrl-Z')
                stopped = json.loads((root / 'stopped.json').read_text())
                (root / 'resume.request').write_text('resume')
                if not wait_for(['continued']):
                    raise RuntimeError('Command did not resume after fg')
            if behavior in ['normal', 'io', 'pipe']:
                os.write(fd, b'hello tty\n')
                if not wait_for(['input.txt']):
                    raise RuntimeError('Command did not read terminal stdin')
            if behavior != 'normal':
                if mode == 'paused':
                    os.kill(wrapper, signal.SIGSTOP)
                if mode in ['foreground', 'paused', 'resume']:
                    os.write(fd, b'\x03')
                else:
                    os.kill(wrapper, getattr(signal, requested_signal))
                if mode == 'paused':
                    time.sleep(.15)
                    os.kill(wrapper, signal.SIGCONT)
            completed = wait_for(['completion.json'])
            drain()
            completion = json.loads((root / 'completion.json').read_text()) if completed else {'exit': None, 'foregroundRestored': False}
            output = {
                **completion,
                'childAlive': process_alive(int((root / 'child.pid').read_text())),
                'grandchildAlive': process_alive(int((root / 'grandchild.pid').read_text())) if (root / 'grandchild.pid').exists() else False,
                'siblingAlive': process_alive(int((root / 'sibling.pid').read_text())),
                'tty': json.loads((root / 'tty.json').read_text()),
                'stopped': stopped,
            }
            records = list((root / 'state' / 'host-commands').glob('*.json'))
            if records:
                record = json.loads(records[0].read_text())
                output['record'] = {
                    'status': record['status'], 'exitCode': record['exitCode'],
                    'ownsProcessGroup': record['ownsProcessGroup'],
                    'childMatches': record['child']['pid'] == int((root / 'child.pid').read_text()),
                    'groupDifferentFromChild': record['processGroupId'] != record['child']['pid'],
                    'maxRssBytes': record['maxRssBytes'], 'cpuTimeMs': record['cpuTimeMs'],
                }
            if behavior in ['normal', 'io', 'pipe']:
                output.update({name: (root / path).read_text() for name, path in [('input', 'input.txt'), ('stdout', 'stdout.txt'), ('stderr', 'stderr.txt')]})
            if behavior == 'pipe':
                output['pipeInput'] = (root / 'pipe-input.txt').read_text()
            print(json.dumps(output))
        finally:
            # Every PID below was created by this fixture. Never signal the shared outer group.
            for name in ['child.pid', 'grandchild.pid', 'wrapper.pid', 'sibling.pid']:
                if (root / name).exists():
                    try:
                        os.kill(int((root / name).read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            drain()
            os.close(fd)
            try:
                os.kill(shell, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(shell, 0)


if sys.argv[1] == 'worker':
    worker(pathlib.Path(sys.argv[2]), sys.argv[3])
elif sys.argv[1] == 'grandchild':
    for sig in [signal.SIGHUP, signal.SIGINT, signal.SIGTERM]:
        signal.signal(sig, signal.SIG_IGN)
    signal.signal(signal.SIGTSTP, signal.SIG_DFL)
    (pathlib.Path(sys.argv[2]) / 'grandchild.pid').write_text(str(os.getpid()))
    while True:
        time.sleep(1)
else:
    probe(*sys.argv[2:6], sys.argv[6] if len(sys.argv) > 6 else 'wrapper')
