"""Real Linux PTY boundary for the guest launcher; all values are synthetic."""
import base64
import json
import os
import pty
import select
import subprocess
import sys
import termios
import time


def read_line(fd, limit=128, timeout=7):
    result = bytearray()
    until = time.monotonic() + timeout
    while not result.endswith(b"\n"):
        assert len(result) < limit, "handshake overflow"
        wait = until - time.monotonic()
        assert wait > 0 and select.select([fd], [], [], wait)[0], "handshake timeout"
        result.extend(os.read(fd, 1))
    return bytes(result)


def no_output(fd):
    assert not select.select([fd], [], [], .1)[0], "unexpected PTY output"


def case(binary, mode):
    master, slave = pty.openpty()
    original = termios.tcgetattr(slave)
    original[3] |= termios.ECHO | termios.ECHONL | termios.ICANON | termios.ISIG
    original[1] |= termios.OPOST | termios.ONLCR
    termios.tcsetattr(slave, termios.TCSANOW, original)
    command = (
        "import os,sys; "
        "assert os.environ['TOKEN'] == 'synthetic-private-canary\\x10\\x11\\n'; "
        "print('command-ready',flush=True); "
        "assert sys.stdin.readline() == 'user-input\\n'; sys.exit(7)"
    )
    process = subprocess.Popen(
        [binary, "--exec-environment-tty-v2", sys.executable, "-c", command],
        stdin=slave, stdout=slave, stderr=slave, close_fds=True,
        env={"PATH": "/usr/bin:/bin"},
    )
    try:
        marker = read_line(master)
        assert marker.startswith(b"HKEE2 ") and marker.endswith(b"\n")
        started = int(marker[6:-1])
        raw = termios.tcgetattr(slave)
        assert raw[3] & (termios.ECHO | termios.ECHONL | termios.ICANON | termios.ISIG | termios.IEXTEN) == 0
        assert raw[0] & (termios.IXON | termios.ICRNL | termios.INLCR | termios.IGNCR | termios.ISTRIP | termios.BRKINT) == 0
        assert raw[1] & termios.OPOST == 0
        assert raw[6][termios.VMIN] == 1 and raw[6][termios.VTIME] == 0
        payload = json.dumps({
            "version": 1, "expires": started + (0 if mode == "expired" else 30),
            "values": {"TOKEN": "synthetic-private-canary\x10\x11\n"},
        }).encode()
        encoded = base64.b64encode(payload)
        assert all(c not in encoded for c in (0x10, 0x11, 0x0a, 0x0d))
        if mode == "invalid":
            encoded = b"!!!!"
        length = len(encoded) + (1 if mode == "short" else 0)
        wire = b"HKEE2 " + str(length).encode() + b"\n" + encoded
        if mode == "extra":
            wire += b"unexpected-input"
        if mode != "timeout":
            # One write ensures the unexpected suffix is pending before parsing.
            assert os.write(master, wire) == len(wire)
        if mode == "success":
            assert read_line(master) == b"HKEE2 OK\r\n", "private input echoed or ACK missing"
            assert termios.tcgetattr(slave) == original, "terminal not restored before ACK"
            assert read_line(master) == b"command-ready\r\n"
            os.write(master, b"user-input\n")
            assert read_line(master) == b"user-input\r\n"
            assert process.wait(timeout=3) == 7
        else:
            assert process.wait(timeout=7) == 125
            assert termios.tcgetattr(slave) == raw, "error restored echo"
            no_output(master)
            os.write(master, b"late-private-canary\n")
            no_output(master)
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=3)
        os.close(master)
        os.close(slave)


for scenario in ("success", "invalid", "expired", "extra", "short", "timeout"):
    case(sys.argv[1], scenario)
non_tty = subprocess.run(
    [sys.argv[1], "--exec-environment-tty-v2", "/bin/true"],
    input=b"", stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=7,
    env={"PATH": "/usr/bin:/bin"},
)
assert non_tty.returncode == 125 and non_tty.stdout == b"" and non_tty.stderr == b""
print("PTY handshake: seven cases passed")
