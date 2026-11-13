"""Private controlling PTY for the real Bun frontend, including compiled Bun."""
import fcntl
import json
import os
import pty
import select
import signal
import socket
import subprocess
import sys
import termios
import time


def hold_session():
    """Stand in for the shell, keeping Darwin's controlling tty alive."""
    control = socket.socket(fileno=int(sys.argv[2]))
    gate_read, gate_write = os.pipe()
    child = os.fork()
    if child == 0:
        control.close()
        os.close(gate_write)
        os.setpgid(0, 0)
        assert os.read(gate_read, 1) == b"G"
        os.close(gate_read)
        try:
            os.execvpe(sys.argv[3], sys.argv[3:], os.environ)
        except BaseException:
            os._exit(127)
    os.close(gate_read)
    os.setpgid(child, child)
    previous = signal.signal(signal.SIGTTOU, signal.SIG_IGN)
    os.tcsetpgrp(0, child)
    signal.signal(signal.SIGTTOU, previous)
    control.sendall(b"P" + child.to_bytes(4, "big"))
    os.write(gate_write, b"G")
    os.close(gate_write)
    _, status = os.waitpid(child, 0)
    code = os.waitstatus_to_exitcode(status)
    control.sendall(b"E" + code.to_bytes(4, "big", signed=True))
    control.settimeout(15)
    assert control.recv(1) == b"F"
    control.close()


if sys.argv[1] == "--hold-session":
    hold_session()
    sys.exit(0)


def drain(master, output, timeout):
    if select.select([master], [], [], timeout)[0]:
        output.extend(os.read(master, 8192))
        assert len(output) <= 1024 * 1024, "frontend output exceeded fixture bound"


def wait_draining(process, master, output, timeout, mode):
    # A PTY consumer must keep reading while its session exits. Darwin can wait
    # for tty output to drain during close, even after the child is signalled.
    deadline = time.monotonic() + timeout
    while process.poll() is None:
        assert time.monotonic() < deadline, f"frontend exit deadline ({mode})"
        drain(master, output, .05)
    return process.returncode


def record(control, master, output, expected, timeout, mode):
    deadline = time.monotonic() + timeout
    data = bytearray()
    while len(data) < 5:
        assert time.monotonic() < deadline, f"session {expected!r} deadline ({mode})"
        ready, _, _ = select.select([control, master], [], [], .05)
        if master in ready:
            drain(master, output, 0)
        if control in ready:
            part = control.recv(5 - len(data))
            assert part, "session holder closed before reporting"
            data.extend(part)
    assert data[:1] == expected
    return int.from_bytes(data[1:], "big", signed=expected == b"E")


root = sys.argv[1]
protected_keys = json.loads(sys.argv[2])
command = sys.argv[3:]
assert all(os.environ.get(key) == "synthetic-parent-key-canary" for key in protected_keys)
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
    control, holder_control = socket.socketpair()
    process = subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "--hold-session",
         str(holder_control.fileno()), *command, root, mode],
        cwd=root, stdin=slave, stdout=slave, stderr=slave, preexec_fn=session,
        pass_fds=(holder_control.fileno(),),
    )
    holder_control.close()
    frontend = None
    code = None
    reader = None
    output = bytearray()
    try:
        frontend = record(control, master, output, b"P", 10, mode)
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
            os.kill(frontend, signal.SIGKILL)
        elif mode == "cancel":
            os.kill(frontend, signal.SIGTERM)
        code = record(control, master, output, b"E", 10, mode)
        if mode == "normal":
            assert code == 7, code
        else:
            assert code != 0, code
        if mode == "frontend-kill":
            until = time.monotonic() + 5
            while not os.path.exists(os.path.join(root, "reader.closed")):
                assert time.monotonic() < until, "frontend death did not close fd3"
                drain(master, output, .01)
        before_read = termios.tcgetattr(slave)
        # As in the native terminal fixture, let Darwin process PENDIN before
        # comparing every termios field while the shell's session stays alive.
        os.set_blocking(slave, False)
        try:
            pending = os.read(slave, 1)
        except BlockingIOError:
            pending = None
        finally:
            os.set_blocking(slave, True)
        assert pending is None, f"unexpected pending terminal input ({mode})"
        actual = termios.tcgetattr(slave)
        names = ("iflag", "oflag", "cflag", "lflag", "ispeed", "ospeed", "cc")
        differences = [names[i] for i in range(7) if actual[i] != original[i]]
        assert actual == original, (
            f"terminal left raw ({mode}): {differences}; "
            f"lflag xor before read={original[3] ^ before_read[3]:#x}, "
            f"after read={original[3] ^ actual[3]:#x}"
        )
        while select.select([master], [], [], 0)[0]:
            output.extend(os.read(master, 8192))
        assert b"synthetic-private-envelope-canary" not in output
        assert b"synthetic-parent-key-canary" not in output
        if mode != "frontend-kill":
            assert b"session_cleanup_uncertain: session 00000000-0000-4000-8000-000000000001" in output, repr(output)
            assert b"hack down --path" in output and b"--branch 'topic'" in output
    finally:
        body_failed = sys.exc_info()[0] is not None
        cleanup_error = None
        try:
            for pid in (reader, frontend if code is None else None):
                if pid is not None:
                    try:
                        if os.getsid(pid) == process.pid:
                            os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            if frontend is not None and code is None:
                record(control, master, output, b"E", 5, mode)
            control.sendall(b"F")
            assert wait_draining(process, master, output, 5, mode) == 0
        except Exception as error:
            cleanup_error = error
        finally:
            control.close()
            try:
                if process.poll() is None:
                    process.kill()
                    wait_draining(process, master, output, 5, mode)
            except Exception as error:
                cleanup_error = cleanup_error or error
            finally:
                os.close(master)
                os.close(slave)
        if cleanup_error is not None:
            if not body_failed:
                raise cleanup_error
            print(f"session cleanup also failed ({mode}): {type(cleanup_error).__name__}",
                  file=sys.stderr)
print("Frontend PTY: four cases passed")
