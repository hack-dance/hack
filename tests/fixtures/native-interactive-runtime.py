"""Fake Engine-side process: prove the frontend's fd3 and fallback restoration."""
import json
import os
import select
import signal
import socket
import sys
import termios
import tty

session = "00000000-0000-4000-8000-000000000001"
if "interactive-sessions" in sys.argv:
    print(json.dumps({"version": 1, "sessions": [session]}))
    sys.exit(0)
control = socket.socket(fileno=3)
length = control.recv(4)
assert len(length) == 4
remaining = int.from_bytes(length, "big")
payload = bytearray()
while len(payload) < remaining:
    data = control.recv(remaining - len(payload))
    assert data
    payload.extend(data)
assert payload == b"synthetic-private-envelope-canary"
assert os.getpgrp() == os.tcgetpgrp(0)
original = termios.tcgetattr(0)
tty.setraw(0)
# Like the native guard, survive session-leader loss long enough to observe
# the leash and restore. Rust's separate process fixture tests its real handler.
signal.signal(signal.SIGHUP, lambda *_: None)
with open("reader.pid", "w") as file:
    file.write(str(os.getpid()))
os.write(1, b"child-ready\n")
mode = sys.argv[-1]
if mode == "normal":
    control.sendall(json.dumps({"version": 1, "outcome": "completed", "completion": {
        "session": session, "exit_code": 7, "retained": True}}).encode() + b"\n")
    # Deliberately leave raw mode: the frontend's independent snapshot owns it.
    sys.exit(7)
assert select.select([control], [], [], 10)[0], "leash deadline"
assert control.recv(1) == b"", "unexpected post-envelope data"
termios.tcsetattr(0, termios.TCSANOW, original)
with open("reader.closed", "w") as file:
    file.write("closed")
