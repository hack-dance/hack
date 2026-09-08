import json
import os
import pathlib
import pty
import signal
import subprocess
import sys
import tempfile
import time

if sys.argv[1] in ["worker", "grandchild"]:
    signal.signal(signal.SIGHUP, signal.SIG_IGN)

if sys.argv[1] == "worker":
    root = pathlib.Path(sys.argv[2])
    if sys.argv[3] == "ignore":
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
    else:
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        signal.signal(signal.SIGINT, lambda *_: sys.exit(0))
    child = subprocess.Popen([sys.executable, __file__, "grandchild", str(root)])
    (root / "child.pid").write_text(str(os.getpid()))
    while True:
        time.sleep(1)
elif sys.argv[1] == "grandchild":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    (pathlib.Path(sys.argv[2]) / "grandchild.pid").write_text(str(os.getpid()))
    while True:
        time.sleep(1)
else:
    bun, entrypoint, requested_signal, behavior = sys.argv[2:]
    with tempfile.TemporaryDirectory(prefix="hack-tty-") as tmp:
        root = pathlib.Path(tmp)
        config = root / ".hack"
        config.mkdir()
        (config / "hack.config.json").write_text('{"name":"tty-regression"}')
        (config / "docker-compose.yml").write_text("services:\n  noop:\n    image: alpine:3.20\n")
        (config / "hack.env.default.yaml").write_text("version: 1\nenvironment: default\nsecretsprovider: project_key\nvalues:\n  global: {}\n")
        wrapper, fd = pty.fork()
        if wrapper == 0:
            sibling = subprocess.Popen([sys.executable, "-c", "import signal,time; signal.signal(signal.SIGHUP, signal.SIG_IGN); time.sleep(30)"])
            (root / "sibling.pid").write_text(str(sibling.pid))
            env = dict(os.environ, HACK_HOME=str(root / "state"))
            os.execve(bun, [bun, entrypoint, "host", "exec", "--path", str(root), "--no-interactive", "--", sys.executable, __file__, "worker", str(root), behavior], env)
        status = None
        def alive(pid):
            result = subprocess.run(["ps", "-p", str(pid), "-o", "stat="], capture_output=True, text=True)
            return result.returncode == 0 and not result.stdout.strip().startswith("Z")
        try:
            deadline = time.monotonic() + 10
            while not (root / "grandchild.pid").exists() and time.monotonic() < deadline:
                time.sleep(.025)
            child = int((root / "child.pid").read_text())
            grandchild = int((root / "grandchild.pid").read_text())
            sibling = int((root / "sibling.pid").read_text())
            os.kill(wrapper, getattr(signal, requested_signal))
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                got, result = os.waitpid(wrapper, os.WNOHANG)
                if got:
                    status = result
                    break
                time.sleep(.025)
            print(json.dumps({"exit": os.waitstatus_to_exitcode(status) if status is not None else None, "childAlive": alive(child), "grandchildAlive": alive(grandchild), "siblingAlive": alive(sibling)}))
        finally:
            for name in ["child.pid", "grandchild.pid", "sibling.pid"]:
                if (root / name).exists():
                    try:
                        os.kill(int((root / name).read_text()), signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            if status is None:
                os.kill(wrapper, signal.SIGKILL)
                os.waitpid(wrapper, 0)
            os.close(fd)
