#!/usr/bin/env python3
"""Bounded, isolated native MCP idle-session baseline. No project tools are invoked."""
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import platform
import queue
import subprocess
import tempfile
import threading
import time


def cpu_seconds(value):
    days = 0
    if "-" in value:
        day_text, value = value.split("-", 1)
        days = int(day_text)
    parts = value.split(":")
    return days * 86400 + sum(float(part) * 60**index for index, part in enumerate(reversed(parts)))


def snapshot(roots):
    output = subprocess.check_output(
        ["ps", "-axo", "pid=,ppid=,rss=,time="], text=True
    )
    rows = {}
    for line in output.splitlines():
        pid, ppid, rss, cpu = line.split()
        rows[int(pid)] = {"ppid": int(ppid), "rss_kib": int(rss), "cpu_s": cpu_seconds(cpu)}
    selected = set(roots)
    while True:
        expanded = selected | {pid for pid, row in rows.items() if row["ppid"] in selected}
        if expanded == selected:
            break
        selected = expanded
    return {pid: rows[pid] for pid in selected if pid in rows}


class Session:
    def __init__(self, executable, root, arguments=None, environment=None, error_output=subprocess.DEVNULL):
        env = dict(os.environ if environment is None else environment)
        env.update(HOME=root, HACK_HOME=str(Path(root) / "state"),
                   HACK_GLOBAL_CONFIG_PATH=str(Path(root) / "state/config.json"))
        self.started = time.monotonic()
        self.proc = subprocess.Popen(
            [executable, *(arguments if arguments is not None else ["mcp", "serve"])], cwd=root, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=error_output,
            text=True, bufsize=1,
        )
        self.messages = queue.Queue()
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        try:
            for line in self.proc.stdout:
                self.messages.put(json.loads(line))
        except Exception as error:
            self.messages.put({"reader_error": type(error).__name__})
        finally:
            self.messages.put({"eof": True})

    def send(self, message):
        self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", **message}) + "\n")
        self.proc.stdin.flush()

    def request(self, request_id, method, params):
        self.send({"id": request_id, "method": method, "params": params})
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            message = self.messages.get(timeout=max(0.01, deadline - time.monotonic()))
            if message.get("id") == request_id:
                if "error" in message:
                    raise RuntimeError(f"{method} returned a protocol error")
                return message["result"]
            if message.get("eof") or "reader_error" in message:
                raise RuntimeError("MCP stream ended before response")
        raise TimeoutError(method)

    def initialize(self):
        result = self.request(1, "initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "hack-session-benchmark", "version": "1"},
        })
        self.send({"method": "notifications/initialized"})
        self.list_tools(2)
        return {"initialize_and_discover_ms": (time.monotonic() - self.started) * 1000,
                "server": result.get("serverInfo"),
                "tools_schema_sha256": self.tools_schema_sha256}

    def list_tools(self, request_id):
        start = time.monotonic()
        result = self.request(request_id, "tools/list", {})
        if "hack.projects.list" not in {tool["name"] for tool in result["tools"]}:
            raise RuntimeError("Expected Hack tools are missing")
        self.tools_schema_sha256 = hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
        return (time.monotonic() - start) * 1000

    def close(self):
        forced = False
        if not self.proc.stdin.closed:
            self.proc.stdin.close()
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            forced = True
            self.proc.terminate()
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=3)
        self.reader.join(timeout=1)
        self.proc.stdout.close()
        return {"exit_code": self.proc.returncode, "forced": forced}


def cohort(executable, count, idle_seconds, rss_ceiling, settle_seconds, arguments=None, extra_pids=()):
    sessions = []
    result = {"clients": count}
    with tempfile.TemporaryDirectory(prefix="hack-mcp-benchmark-") as root:
        try:
            start = time.monotonic()
            for index in range(count):
                session_root = Path(root) / str(index)
                session_root.mkdir()
                sessions.append(Session(executable, str(session_root), arguments))
            with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
                initialized = list(pool.map(lambda session: session.initialize(), sessions))
            ready_ms = (time.monotonic() - start) * 1000
            roots = [session.proc.pid for session in sessions] + list(extra_pids)
            before = snapshot(roots)
            if len(before) != count + len(extra_pids):
                raise RuntimeError("Unexpected child process or missing MCP server")
            result["observed_rss_kib"] = sum(row["rss_kib"] for row in before.values())
            if result["observed_rss_kib"] > rss_ceiling:
                raise RuntimeError("Cohort exceeded RSS ceiling")
            ready_cpu = sum(row["cpu_s"] for row in before.values())
            time.sleep(settle_seconds)
            before = snapshot(roots)
            start_idle = time.monotonic()
            time.sleep(idle_seconds)
            after = snapshot(roots)
            elapsed = time.monotonic() - start_idle
            if before.keys() != after.keys():
                raise RuntimeError("Process tree changed during idle window")
            with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
                latency = list(pool.map(lambda session: session.list_tools(3), sessions))
            registry_files = list(Path(root).rglob("projects.json*"))
            if registry_files:
                raise RuntimeError("Idle/tool-discovery unexpectedly wrote a projects registry")
            result = {
                "clients": count, "ready_ms": ready_ms, "ready_cpu_seconds": ready_cpu, "initialized": initialized,
                "idle_seconds": elapsed, "settle_seconds": settle_seconds,
                "rss_before_kib": sum(row["rss_kib"] for row in before.values()),
                "rss_after_kib": sum(row["rss_kib"] for row in after.values()),
                "idle_cpu_seconds": sum(after[pid]["cpu_s"] - before[pid]["cpu_s"] for pid in before),
                "process_count": len(after), "tools_list_ms": latency,
                "registry_files": len(registry_files),
            }
        except Exception as error:
            result["error"] = f"{type(error).__name__}: {error}"
        finally:
            with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(sessions))) as pool:
                closed = list(pool.map(lambda session: session.close(), sessions))
        result["cleanup"] = closed
        if any(row["forced"] or row["exit_code"] != 0 for row in closed):
            result["error"] = "Cohort required forced cleanup or exited unsuccessfully"
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--compare-executable")
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--idle-seconds", type=float, default=2)
    parser.add_argument("--settle-seconds", type=float, default=0)
    parser.add_argument("--rss-ceiling-mib", type=int, default=3072)
    args = parser.parse_args()
    if not 256 <= args.rss_ceiling_mib <= 8192:
        parser.error("RSS ceiling must be 256..8192 MiB")
    if not 0 <= args.settle_seconds <= 10:
        parser.error("Settle seconds must be 0..10")
    if not 1 <= args.trials <= 5 or not 1 <= args.idle_seconds <= 10:
        parser.error("Trials must be 1..5 and idle seconds 1..10")
    executable = str(Path(args.executable).resolve(strict=True))
    report = {"executable": executable,
              "sha256": hashlib.sha256(Path(executable).read_bytes()).hexdigest(),
              "platform": platform.platform(), "architecture": platform.machine(),
              "source_sha": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
              "rss_ceiling_mib": args.rss_ceiling_mib,
              "measurement": "sum of owned process RSS; shared pages may be counted repeatedly",
              "cpu_resolution": "ps cumulative CPU time; short idle windows have limited resolution",
              "samples": []}
    variants = [("baseline", executable)]
    if args.compare_executable:
        compared = str(Path(args.compare_executable).resolve(strict=True))
        variants.append(("candidate", compared))
        report["comparison_executable"] = compared
        report["comparison_sha256"] = hashlib.sha256(Path(compared).read_bytes()).hexdigest()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        for trial in range(args.trials):
            counts = [1, 8, 32] if trial % 2 == 0 else [32, 8, 1]
            for count in counts:
                order = variants if trial % 2 == 0 else list(reversed(variants))
                for variant, binary in order:
                    result = cohort(binary, count, args.idle_seconds, args.rss_ceiling_mib * 1024, args.settle_seconds)
                    result.update(trial=trial + 1, variant=variant)
                    report["samples"].append(result)
                    output.write_text(json.dumps(report, indent=2) + "\n")
                    if "error" in result:
                        raise RuntimeError(result["error"])
                    print(json.dumps({key: result[key] for key in
                                      ["trial", "variant", "clients", "ready_ms", "rss_after_kib", "idle_cpu_seconds"]}), flush=True)
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        output.write_text(json.dumps(report, indent=2) + "\n")
        raise


if __name__ == "__main__":
    main()
