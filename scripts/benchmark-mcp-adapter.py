#!/usr/bin/env python3
"""Matched fresh-process cohorts: stdio versus native adapters plus one shared backend."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import queue
import stat
import subprocess
import tempfile
import threading
import time

spec = importlib.util.spec_from_file_location("mcp_sessions", Path(__file__).with_name("benchmark-mcp-sessions.py"))
sessions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sessions)


def shared_cohort(adapter, backend_binary, count, owner=None):
    with tempfile.TemporaryDirectory(prefix="hack-mb-", dir="/tmp") as root:
        root = str(Path(root).resolve())
        os.chmod(root, 0o700)
        env = {key: value for key, value in os.environ.items() if key in ("PATH", "LANG", "TMPDIR")}
        env.update(HOME=root, HACK_HOME=root)
        started = time.monotonic()
        command = [backend_binary, root, "benchmark-v1"]
        if owner:
            command = [owner, "--directory", root, "--", *command]
        proc = subprocess.Popen(command, env=env, cwd=root,
                                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True)
        ready = queue.Queue()
        thread = threading.Thread(target=lambda: ready.put(proc.stdout.readline()), daemon=True)
        thread.start()
        result = {}
        try:
            greeting = json.loads(ready.get(timeout=10))
            if greeting.get("backendId") != "benchmark-v1":
                raise RuntimeError("Unexpected backend identity")
            if greeting.get("socketPath") != str(Path(root, "mcp.sock")):
                raise RuntimeError("Unexpected backend socket path")
            if owner:
                receipt = Path(root, ".mcp-receipt.json")
                if not stat.S_ISREG(receipt.lstat().st_mode) or json.loads(receipt.read_text()).get("version") != 1 or receipt.lstat().st_mode & 0o077:
                    raise RuntimeError("Missing private native ownership publication")
            backend_ready_ms = (time.monotonic() - started) * 1000
            result = sessions.cohort(adapter, count, 5, 4096 * 1024, 3,
                ["--socket", greeting["socketPath"], "--backend-id", "benchmark-v1"], [proc.pid])
            result["native_ownership_publication"] = bool(owner)
            result["backend_ready_ms"] = backend_ready_ms
            result["ready_ms"] = result.get("ready_ms", 0) + backend_ready_ms
            if list(Path(root).rglob("projects.json*")):
                result["error"] = "Shared backend unexpectedly wrote a registry"
        except Exception as error:
            result.update(clients=count, error=f"{type(error).__name__}: {error}")
        finally:
            proc.terminate()
            forced = False
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                forced = True
                proc.kill()
                proc.wait(timeout=3)
            thread.join(timeout=1)
            proc.stdout.close()
            result["backend_cleanup"] = {"exit_code": proc.returncode, "forced": forced}
            if forced or proc.returncode != 0 or sessions.snapshot([proc.pid]):
                result["cleanup_error"] = "Shared backend cleanup failed"
                result.setdefault("error", result["cleanup_error"])
            if any(os.path.lexists(Path(root, name)) for name in ("mcp.sock", ".mcp-owner", ".mcp-receipt.json")):
                result["cleanup_error"] = "Shared backend left its socket, ownership claim or receipt"
                result.setdefault("error", result["cleanup_error"])
            if owner:
                try:
                    lease = Path(root, ".mcp-lease").lstat()
                    result["retained_lease"] = {"bytes": lease.st_size, "allocated_bytes": lease.st_blocks * 512, "mode": oct(lease.st_mode & 0o777), "links": lease.st_nlink}
                    if not stat.S_ISREG(lease.st_mode) or lease.st_size != 0 or lease.st_nlink != 1 or lease.st_mode & 0o077:
                        result.setdefault("error", "Unexpected retained lease state")
                except OSError:
                    result["retained_lease"] = None
                    result.setdefault("error", "Missing retained lease file")
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stdio", required=True)
    parser.add_argument("--adapter", required=True)
    parser.add_argument("--backend", required=True)
    parser.add_argument("--owner", help="Optional native lease owner; includes its exec handoff in startup")
    parser.add_argument("--output", required=True)
    parser.add_argument("--trials", type=int, choices=[1, 2, 3], default=3)
    args = parser.parse_args()
    binaries = {name: str(Path(getattr(args, name)).resolve(strict=True)) for name in ("stdio", "adapter", "backend")}
    if args.owner:
        binaries["owner"] = str(Path(args.owner).resolve(strict=True))
    report = {
        "platform": platform.platform(), "architecture": platform.machine(),
        "binaries": {name: {"path": path, "sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest(), "bytes": Path(path).stat().st_size} for name, path in binaries.items()},
        "scope": "Fresh-process init and tool discovery, then 3s settle and 5s idle; OS caches are not flushed. Shared totals include every adapter and backend. No project tools or Docker workload.",
        "measurement": "Sum of process RSS (shared pages can repeat); ps cumulative CPU, limited resolution for near-zero idle CPU.",
        "samples": [],
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    for trial in range(args.trials):
        counts = [1, 8, 32] if trial % 2 == 0 else [32, 8, 1]
        variants = ["stdio", "shared"] if trial % 2 == 0 else ["shared", "stdio"]
        for count in counts:
            for variant in variants:
                result = (sessions.cohort(binaries["stdio"], count, 5, 4096 * 1024, 3)
                          if variant == "stdio" else shared_cohort(binaries["adapter"], binaries["backend"], count, binaries.get("owner")))
                result.update(trial=trial + 1, variant=variant)
                report["samples"].append(result)
                output.write_text(json.dumps(report, indent=2) + "\n")
                if "error" in result:
                    raise RuntimeError(result["error"])
                schemas = {item["tools_schema_sha256"] for sample in report["samples"] for item in sample["initialized"]}
                if len(schemas) != 1:
                    raise RuntimeError("Tools schemas differ across variants")
                print(json.dumps({key: result[key] for key in ("trial", "variant", "clients", "ready_ms", "rss_after_kib", "ready_cpu_seconds", "idle_cpu_seconds")}), flush=True)


if __name__ == "__main__":
    main()
