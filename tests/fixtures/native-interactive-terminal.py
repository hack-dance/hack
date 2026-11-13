"""Exercise the actual native terminal guard in a private process and PTY."""
import os
import pty
import select
import signal
import socket
import subprocess
import sys
import termios
import time
import fcntl
import struct


def run(mode):
    master, slave = pty.openpty()
    # Unknown dimensions must produce a usable default before admission.
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
    original = termios.tcgetattr(slave)
    control, child_control = socket.socketpair()
    engine, child_engine = socket.socketpair()
    finish, child_finish = socket.socketpair()
    env = {"PATH": "/usr/bin:/bin", "HACK_INTERACTIVE_CHILD": mode,
           "HACK_INTERACTIVE_CONTROL": str(child_control.fileno()),
           "HACK_INTERACTIVE_ENGINE": str(child_engine.fileno()),
           "HACK_INTERACTIVE_FINISH": str(child_finish.fileno())}

    def session():
        os.setsid()
        fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

    process = subprocess.Popen(
        [sys.argv[1], "--exact", "provider::interactive_terminal::tests::child_session",
         "--nocapture", "--test-threads=1"],
        stdin=slave, stdout=slave, stderr=slave, env=env,
        pass_fds=(child_control.fileno(), child_engine.fileno(), child_finish.fileno(), slave),
        preexec_fn=session,
    )
    child_control.close()
    child_engine.close()
    child_finish.close()
    control.sendall(bytes(4))
    try:
        deadline = time.monotonic() + 10
        while termios.tcgetattr(slave)[3] & termios.ICANON:
            assert process.poll() is None, "child exited before raw mode"
            assert time.monotonic() < deadline, "raw mode deadline"
            time.sleep(.005)
        os.set_blocking(master, False)
        engine.setblocking(False)
        control.settimeout(10)
        # Discard the Rust test runner's prelude, before any fixture output.
        while select.select([master], [], [], 0)[0]:
            os.read(master, 8192)
        if mode == "flood":
            incoming = b"i" * 200000
            outgoing = b"o" * 200000
            sent_input = sent_output = 0
            got_input = bytearray()
            got_output = bytearray()
            while len(got_input) < len(incoming) or len(got_output) < len(outgoing):
                assert time.monotonic() < deadline, "bidirectional relay stalled"
                reads, writes, _ = select.select(
                    [master, engine],
                    ([master] if sent_input < len(incoming) else []) +
                    ([engine] if sent_output < len(outgoing) else []), [], .1)
                if master in writes:
                    sent_input += os.write(master, incoming[sent_input:sent_input + 4096])
                if engine in writes:
                    sent_output += engine.send(outgoing[sent_output:sent_output + 4096])
                if master in reads:
                    got_output.extend(os.read(master, 8192))
                if engine in reads:
                    got_input.extend(engine.recv(8192))
            assert got_input == incoming and got_output == outgoing
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 43, 91, 0, 0))
            assert control.recv(1) == b"R", "resize was not observed"
            engine.shutdown(socket.SHUT_WR)
        elif mode == "leash":
            control.shutdown(socket.SHUT_WR)
        elif mode == "signal":
            process.send_signal(signal.SIGTERM)
        else:
            raise AssertionError("unknown scenario")
        assert control.recv(1) == b"D", "child did not finish and restore"
        before_read = termios.tcgetattr(slave)
        # Darwin sets PENDIN when TIOCSETA restores ICANON. The next tty read
        # processes it, as the shell would. Keep full equality after that read;
        # don't mask flags or flush user input to satisfy the assertion.
        os.set_blocking(slave, False)
        try:
            pending = os.read(slave, 1)
        except BlockingIOError:
            pending = None
        finally:
            os.set_blocking(slave, True)
        assert pending is None, f"unexpected pending input after restore ({mode})"
        actual = termios.tcgetattr(slave)
        names = ("iflag", "oflag", "cflag", "lflag", "ispeed", "ospeed", "cc")
        differences = [names[i] for i in range(7) if actual[i] != original[i]]
        assert actual == original, (
            f"terminal attributes not restored ({mode}): {differences}; "
            f"lflag xor before read={original[3] ^ before_read[3]:#x}, "
            f"after read={original[3] ^ actual[3]:#x}"
        )
        # Keep the session leader alive until the tty read and comparison finish.
        finish.sendall(b"F")
        assert process.wait(timeout=5) == 0
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        control.close()
        engine.close()
        finish.close()
        os.close(master)
        os.close(slave)


for mode in ("flood", "leash", "signal"):
    run(mode)
print("Native terminal: flood, resize, idle leash and signal restoration passed")
