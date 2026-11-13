"""Private controlling PTY for the real Bun frontend, including compiled Bun."""
import fcntl
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import time

root = sys.argv[1]
command = sys.argv[2:]
for mode in ("normal", "child-kill", "frontend-kill", "cancel"):
    for name in ("reader.pid", "reader.closed"):
        try:
            os.unlink(os.path.join(root, name))
        except FileNotFoundError:
            pass
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    def session():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    process = subprocess.Popen(command + [root, mode], cwd=root, stdin=slave,
                               stdout=slave, stderr=slave, preexec_fn=session)
    reader = None
    output = bytearray()
    try:
        deadline = time.monotonic() + 15
        while b"child-ready\n" not in output:
            assert time.monotonic() < deadline, repr(output)
            if select.select([master], [], [], .1)[0]:
                output.extend(os.read(master, 8192))
            assert process.poll() is None or b"child-ready\n" in output, repr(output)
        with open(os.path.join(root, "reader.pid")) as file:
            reader = int(file.read())
        if mode == "child-kill":
            os.kill(reader, signal.SIGKILL)
        elif mode == "frontend-kill":
            process.kill()
        elif mode == "cancel":
            process.terminate()
        code = process.wait(timeout=10)
        if mode == "normal":
            assert code == 7, code
        else:
            assert code != 0, code
        if mode == "frontend-kill":
            until = time.monotonic() + 5
            while not os.path.exists(os.path.join(root, "reader.closed")):
                assert time.monotonic() < until, "frontend death did not close fd3"
                time.sleep(.01)
        assert termios.tcgetattr(slave) == original, "terminal left raw"
        while select.select([master], [], [], 0)[0]:
            output.extend(os.read(master, 8192))
        assert b"synthetic-private-envelope-canary" not in output
        if mode != "frontend-kill":
            assert b"session_cleanup_uncertain: session 00000000-0000-4000-8000-000000000001" in output, repr(output)
            assert b"hack down --path" in output and b"--branch 'topic'" in output
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        if reader is not None:
            try:
                if os.getsid(reader) == process.pid:
                    os.kill(reader, signal.SIGKILL)
            except ProcessLookupError:
                pass
        os.close(master)
        os.close(slave)
print("Frontend PTY: four cases passed")
