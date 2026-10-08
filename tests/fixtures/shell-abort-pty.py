"""Real PTY controls for shell.run's optional signal; no product CLI or engine."""
import json
import os
import pathlib
import pty
import signal
import subprocess
import sys
import tempfile
import time


def alive(pid):
    result = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True)
    return result.returncode == 0 and not result.stdout.strip().startswith('Z')


def worker(root, mode):
    for sig in [signal.SIGHUP, signal.SIGINT, signal.SIGTERM]:
        signal.signal(sig, signal.SIG_IGN)
    with open('/dev/tty') as tty:
        (root / 'tty.json').write_text(json.dumps({
            'stdin': os.isatty(0), 'devTty': os.isatty(tty.fileno()),
            'foreground': os.tcgetpgrp(tty.fileno()) == os.getpgrp(),
        }))
    (root / 'child.pid').write_text(str(os.getpid()))
    if mode == 'late-abort':
        sys.exit(7)
    subprocess.Popen([sys.executable, __file__, 'grandchild', str(root)])
    while True:
        time.sleep(1)


def launcher(root, bun, program, mode):
    for sig in [signal.SIGHUP, signal.SIGINT, signal.SIGTERM]:
        signal.signal(sig, signal.SIG_IGN)
    original = os.tcgetpgrp(0)
    sibling = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
    (root / 'sibling.pid').write_text(str(sibling.pid))
    child = subprocess.Popen([bun, program, mode, str(root), sys.executable, __file__])
    (root / 'wrapper.pid').write_text(str(child.pid))
    code = child.wait()
    (root / 'completion.json').write_text(json.dumps({
        'wrapperCode': code, 'foregroundRestored': os.tcgetpgrp(0) == original,
    }))
    while True:
        time.sleep(1)


def probe(bun, program, mode):
    with tempfile.TemporaryDirectory(prefix='hack-shell-abort-tty-') as directory:
        root = pathlib.Path(directory)
        shell, fd = pty.fork()
        if shell == 0:
            launcher(root, bun, program, mode)
            os._exit(0)
        os.set_blocking(fd, False)
        output = bytearray()

        def drain():
            while True:
                try:
                    data = os.read(fd, 65536)
                    if not data:
                        return
                    output.extend(data)
                except (BlockingIOError, OSError):
                    return

        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                drain()
                if (root / 'completion.json').exists() and (root / 'result.json').exists():
                    break
                time.sleep(.01)
            else:
                raise RuntimeError('PTY run did not settle: ' + output.decode(errors='replace'))
            completion = json.loads((root / 'completion.json').read_text())
            if completion['wrapperCode'] != 0:
                raise RuntimeError('PTY runner failed: ' + output.decode(errors='replace'))
            result = json.loads((root / 'result.json').read_text())
            result.update(completion)
            for name in ['child', 'grandchild', 'sibling']:
                path = root / (name + '.pid')
                result[name + 'Alive'] = alive(int(path.read_text())) if path.exists() else False
            if (root / 'tty.json').exists():
                result['tty'] = json.loads((root / 'tty.json').read_text())
            print(json.dumps(result))
        finally:
            for name in ['child', 'grandchild', 'wrapper', 'sibling']:
                path = root / (name + '.pid')
                if path.exists():
                    try:
                        os.kill(int(path.read_text()), signal.SIGKILL)
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
    (pathlib.Path(sys.argv[2]) / 'grandchild.pid').write_text(str(os.getpid()))
    while True:
        time.sleep(1)
else:
    probe(*sys.argv[2:5])
