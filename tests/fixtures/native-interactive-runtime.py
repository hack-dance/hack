"""Fake Engine-side process: prove the frontend's fd3 and fallback restoration."""
import json
import os
import select
import signal
import socket
import sys
import termios
import tty

protected_keys = ["__PROTECTED_KEYS__"]  # Replaced by the test from the production key set.
assert "__PROTECTED_KEYS__" not in protected_keys
assert not any(key in os.environ for key in protected_keys)
session = sys.argv[sys.argv.index("--session" if "interactive-sessions" in sys.argv else "--session-id") + 1]
if "interactive-sessions" in sys.argv:
    with open("session.queried", "w") as file:
        file.write(session)
    sessions = [] if os.path.exists("session.cleared") else [{"session": session, "run": "a" * 32, "service": "web", "has_exec": True}]
    print(json.dumps({"version": 1, "reconciled": None, "sessions": sessions}))
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
with open("session.id", "w") as file:
    file.write(session)
with open("reader.pid", "w") as file:
    file.write(str(os.getpid()))
os.write(1, b"child-ready\n")
mode = sys.argv[-1]
if mode in ("refused", "old-launcher"):
    code = "graph_service_exec_launcher" if mode == "old-launcher" else "interactive_exec_refused"
    control.sendall(json.dumps({"version": 1, "outcome": "refused", "code": code, "session": None}).encode() + b"\n")
    sys.exit(1)
if mode == "cleared":
    with open("session.cleared", "w") as file:
        file.write("cleared")
    control.sendall(json.dumps({"version": 1, "outcome": "refused", "code": "session_cleanup_uncertain", "session": session}).encode() + b"\n")
    sys.exit(1)
if mode in ("normal", "retained", "retained-zero"):
    exit_code = 0 if mode == "retained-zero" else 7
    control.sendall(json.dumps({"version": 1, "outcome": "completed", "completion": {
        "session": session, "exit_code": exit_code, "retained": mode != "normal"}}).encode() + b"\n")
    # Deliberately leave raw mode: the frontend's independent snapshot owns it.
    sys.exit(exit_code)
assert select.select([control], [], [], 10)[0], "leash deadline"
assert control.recv(1) == b"", "unexpected post-envelope data"
previous = signal.signal(signal.SIGTTOU, signal.SIG_IGN)
termios.tcsetattr(0, termios.TCSANOW, original)
signal.signal(signal.SIGTTOU, previous)
with open("reader.closed", "w") as file:
    file.write("closed")
