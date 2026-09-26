#!/usr/bin/env python3
"""Managed MCP startup and idle cohorts; complete CPU requires an isolated Linux cgroup."""
import argparse
import concurrent.futures
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import stat
import tempfile
import time

spec = importlib.util.spec_from_file_location("mcp_sessions", Path(__file__).with_name("benchmark-mcp-sessions.py"))
sessions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sessions)


class Cgroup:
    def __init__(self):
        self.root = Path("/sys/fs/cgroup")
        if Path("/proc/self/cgroup").read_text().strip() != "0::/":
            raise RuntimeError("A private cgroup v2 namespace is required")
        self.memory_limit = int((self.root / "memory.max").read_text())
        self.cpu_limit = (self.root / "cpu.max").read_text().strip()
        if self.memory_limit > 4 * 1024**3 or self.cpu_limit.startswith("max"):
            raise RuntimeError("Use a bounded isolated toolchain cgroup (at most 4 GiB)")
        self.assert_idle()

    def assert_idle(self):
        allowed = {os.getpid()}
        pid = os.getpid()
        while pid > 1:
            fields = Path(f"/proc/{pid}/status").read_text().splitlines()
            pid = int(next(line.split()[1] for line in fields if line.startswith("PPid:")))
            if pid in allowed:
                break
            allowed.add(pid)
        actual = {int(value) for value in (self.root / "cgroup.procs").read_text().split()}
        if not actual <= allowed:
            raise RuntimeError("Unrelated or leftover processes share the measurement cgroup")

    def sample(self):
        cpu = dict(line.split() for line in (self.root / "cpu.stat").read_text().splitlines())
        memory = dict(line.split() for line in (self.root / "memory.stat").read_text().splitlines())
        return {"cpu_seconds": int(cpu["usage_usec"]) / 1_000_000,
                "throttled_seconds": int(cpu.get("throttled_usec", 0)) / 1_000_000,
                "memory_current_bytes": int((self.root / "memory.current").read_text()),
                "anonymous_bytes": int(memory["anon"]), "file_bytes": int(memory["file"])}


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def record(path):
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077 or metadata.st_uid != os.getuid() or metadata.st_nlink != 1 or metadata.st_size > 4096:
        raise RuntimeError("Unsafe measurement receipt")
    return json.loads(path.read_text())


def backend_identity(root):
    value = record(root / "benchmark-process.json")
    for key in ("pid", "supervisor"):
        if type(value.get(key)) is not int or value[key] <= 1:
            raise RuntimeError("Invalid measured process identity")
    return value


def wait_until(check, seconds):
    deadline = time.monotonic() + seconds
    while not check():
        if time.monotonic() >= deadline:
            raise TimeoutError("Owned benchmark state did not settle")
        time.sleep(0.02)


def isolated_environment(root, executable):
    empty_bin = root / "empty-bin"
    empty_bin.mkdir(mode=0o700)
    docker_config = root / "docker-config"
    docker_config.mkdir(mode=0o700)
    return {"PATH": str(empty_bin), "LANG": "C", "TMPDIR": str(root),
            "HACK_MCP_COMMAND": executable, "HACK_NO_INTERACTIVE": "1",
            "DOCKER_HOST": f"unix://{root}/unavailable-docker.sock",
            "DOCKER_CONFIG": str(docker_config)}


def verify_isolated_tool(tool, executable):
    structured = tool.get("structuredContent", {})
    data = structured.get("data")
    if (tool.get("isError") or structured.get("exitCode") != 0
            or not structured.get("command", "").startswith(executable + " ")
            or not isinstance(data, dict) or data.get("projects") != []
            or data.get("runtime_ok") is not False):
        # Never include tool output: a failed boundary may contain host metadata.
        raise RuntimeError("Pinned selected CLI runtime isolation validation failed")


def compatible_schema_hash(schema):
    """Only normalize the known additive optional output-budget indicator."""
    normalized = json.loads(json.dumps(schema))
    for tool in normalized["tools"]:
        output = tool.get("outputSchema", {})
        properties = output.get("properties", {})
        if "outputTruncated" not in properties:
            continue
        if (properties["outputTruncated"] != {"type": "boolean"}
                or "outputTruncated" in output.get("required", [])):
            raise RuntimeError("Unsupported outputTruncated contract")
        del properties["outputTruncated"]
    return hashlib.sha256(json.dumps(normalized, sort_keys=True).encode()).hexdigest()


def run_cohort(binaries, variant, count, idle_seconds, cgroup=None, rss_ceiling=3 * 1024**2, allow_optional_output_truncation=False):
    root = Path(tempfile.mkdtemp(prefix="hack-mm-", dir="/tmp")).resolve()
    root.chmod(0o700)
    backend_root = root / "backend"
    backend_root.mkdir(mode=0o700)
    active = []
    result = {"variant": variant, "clients": count, "startup_cpu_complete": cgroup is not None}
    identity = None
    cpu_start = None
    try:
        if cgroup:
            cgroup.assert_idle()
            cpu_start = cgroup.sample()
        arguments = None if variant == "stdio" else ["--socket", str(backend_root / "mcp.sock"), "--backend-id", "managed-benchmark-v1", "--owner", binaries["owner"], "--backend", binaries["backend"]]
        env = isolated_environment(root, binaries["stdio"])
        start = time.monotonic()
        for index in range(count):
            home = root / f"client-{index}"
            home.mkdir(mode=0o700)
            # Native adapter errors contain fixed descriptions, not client values.
            # Capture only that binary's errors; full CLI diagnostics stay suppressed.
            if variant == "managed":
                with (home / "adapter-error.log").open("xb") as errors:
                    active.append(sessions.Session(binaries["adapter"], str(home), arguments, environment=env, error_output=errors))
            else:
                active.append(sessions.Session(binaries["stdio"], str(home), arguments, environment=env))
        with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
            initialized = list(pool.map(lambda client: client.initialize(), active))
        result.update(ready_ms=(time.monotonic() - start) * 1000, initialized=initialized)
        if variant == "managed":
            identity = backend_identity(backend_root)
            wait_until(lambda: not alive(identity["supervisor"]), 3)
            publication = record(backend_root / ".mcp-receipt.json")
            if publication.get("version") != 1:
                raise RuntimeError("Missing native ownership publication")
        roots = [client.proc.pid for client in active] + ([identity["pid"]] if identity else [])
        before = sessions.snapshot(roots)
        if set(before) != set(roots):
            raise RuntimeError("Missing or unexpected managed process")
        ready_sample = cgroup.sample() if cgroup else None
        result.update(startup_cpu_seconds=(ready_sample["cpu_seconds"] - cpu_start["cpu_seconds"]) if cgroup else None,
                      rss_ready_kib=sum(row["rss_kib"] for row in before.values()), cgroup_ready=ready_sample)
        if result["rss_ready_kib"] > rss_ceiling:
            raise RuntimeError("Cohort exceeded post-initialization RSS ceiling")
        time.sleep(3)
        before = sessions.snapshot(roots)
        idle_start = cgroup.sample() if cgroup else None
        start = time.monotonic()
        time.sleep(idle_seconds)
        after = sessions.snapshot(roots)
        idle_end = cgroup.sample() if cgroup else None
        if set(before) != set(after) or set(after) != set(roots):
            raise RuntimeError("Process family changed during idle sample")
        result.update(idle_seconds=time.monotonic() - start,
                      idle_cpu_seconds=(idle_end["cpu_seconds"] - idle_start["cpu_seconds"]) if cgroup else sum(after[pid]["cpu_s"] - before[pid]["cpu_s"] for pid in roots),
                      rss_idle_kib=sum(row["rss_kib"] for row in after.values()), process_count=len(after),
                      cgroup_idle_start=idle_start, cgroup_idle_end=idle_end)
        # Verify the same schema again after idle, then exercise one real read-only
        # command against the pinned selected CLI outside the timed idle window.
        schemas = {item["tools_schema_sha256"] for item in initialized}
        for client in active:
            client.list_tools(3)
            schemas.add(client.tools_schema_sha256)
        if len(schemas) != 1:
            raise RuntimeError("Tool schema changed across clients or idle")
        if list(root.rglob("projects.json*")):
            raise RuntimeError("Initialization/discovery wrote a project registry")
        tool = active[0].request(4, "tools/call", {"name": "hack.projects.list", "arguments": {}})
        verify_isolated_tool(tool, binaries["stdio"])
        result["pinned_cli_tool_verified"] = True
        result["runtime_isolation_verified"] = True
        result["tools_schema_sha256"] = schemas.pop()
        result["tools_contract_sha256"] = result["tools_schema_sha256"]
        if allow_optional_output_truncation:
            schema = active[0].request(5, "tools/list", {})
            raw_hash = hashlib.sha256(json.dumps(schema, sort_keys=True).encode()).hexdigest()
            if raw_hash != result["tools_schema_sha256"]:
                raise RuntimeError("Tool schema changed during compatibility validation")
            result["tools_contract_sha256"] = compatible_schema_hash(schema)
    except Exception as failure:
        result["error"] = f"{type(failure).__name__}: {failure}"
    finally:
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, len(active))) as pool:
            closed = list(pool.map(close_client, active))
        result["client_cleanup"] = closed
        if any(item["forced"] or item["exit_code"] != 0 for item in closed):
            result.setdefault("error", "Client cleanup failed")
        if "error" in result and variant == "managed":
            result["adapter_errors"] = []
            for path in sorted(root.glob("client-*/adapter-error.log")):
                with path.open("rb") as errors:
                    message = errors.read(4096).decode("utf-8", errors="replace").strip()
                if message:
                    result["adapter_errors"].append({"client": path.parent.name, "message": message})
        try:
            if variant == "managed":
                if identity is None and (backend_root / "benchmark-process.json").exists():
                    identity = backend_identity(backend_root)
                if identity:
                    wait_until(lambda: (backend_root / "benchmark-exit.json").exists() and not alive(identity["pid"]) and not alive(identity["supervisor"]), 12)
                    exited = record(backend_root / "benchmark-exit.json")
                    result["backend_cleanup"] = exited
                    if exited != {"pid": identity["pid"], "code": 0}:
                        raise RuntimeError("Backend exited unsuccessfully")
                    for name in ("mcp.sock", ".mcp-owner", ".mcp-receipt.json"):
                        if os.path.lexists(backend_root / name):
                            raise RuntimeError("Backend left owned socket state")
                    lease = (backend_root / ".mcp-lease").lstat()
                    if not stat.S_ISREG(lease.st_mode) or lease.st_size or lease.st_mode & 0o077 or lease.st_nlink != 1:
                        raise RuntimeError("Unexpected retained lease")
                    result["retained_lease_bytes"] = lease.st_size
                elif "error" not in result or list(backend_root.iterdir()):
                    raise RuntimeError("No measured backend identity; preserve uncertain ownership state")
            if cgroup:
                wait_until(lambda: cgroup_idle(cgroup), 3)
                final = cgroup.sample()
                result["cgroup_after_cleanup"] = final
                if cpu_start is not None:
                    result["cohort_cpu_seconds"] = final["cpu_seconds"] - cpu_start["cpu_seconds"]
            result["cleanup_verified"] = True
        except Exception as failure:
            result["cleanup_error"] = f"{type(failure).__name__}: {failure}"
            result.setdefault("error", result["cleanup_error"])
        if result.get("cleanup_verified"):
            shutil.rmtree(root)
        else:
            # Preserve uncertain live state; never delete it to manufacture cleanup.
            result["retained_fixture"] = str(root)
    return result


def close_client(client):
    try:
        return client.close()
    except Exception as failure:
        if client.proc.poll() is None:
            client.proc.kill()
        client.proc.wait(timeout=3)
        client.reader.join(timeout=1)
        for pipe in (client.proc.stdin, client.proc.stdout):
            try:
                pipe.close()
            except BrokenPipeError:
                pass
        return {"exit_code": client.proc.returncode, "forced": True, "error": type(failure).__name__}


def cgroup_idle(cgroup):
    try:
        cgroup.assert_idle()
        return True
    except RuntimeError:
        return False


def binary_hashes(binaries):
    result = {}
    for name, path in binaries.items():
        digest = hashlib.sha256()
        with Path(path).open("rb") as binary:
            for chunk in iter(lambda: binary.read(1024 * 1024), b""):
                digest.update(chunk)
        result[name] = digest.hexdigest()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("stdio", "adapter", "backend", "owner", "output"):
        parser.add_argument(f"--{name}", required=True)
    parser.add_argument("--trials", type=int, choices=[1, 2, 3], default=3)
    parser.add_argument("--counts", type=int, nargs="+", default=[1, 8, 32])
    parser.add_argument("--idle-seconds", type=int, choices=range(5, 61), default=30)
    parser.add_argument("--isolated-cgroup", action="store_true")
    parser.add_argument("--rss-ceiling-mib", type=int, choices=[3072, 4096], default=3072, help="Post-initialization process RSS ceiling; shared pages may be counted repeatedly")
    parser.add_argument("--allow-optional-output-truncation", action="store_true", help="Allow only the known optional Boolean outputTruncated result field difference")
    args = parser.parse_args()
    if not args.counts or any(count not in (1, 8, 32) for count in args.counts):
        parser.error("Counts must be selected from 1, 8 and 32")
    binaries = {name: str(Path(getattr(args, name)).resolve(strict=True)) for name in ("stdio", "adapter", "backend", "owner")}
    cgroup = Cgroup() if args.isolated_cgroup else None
    expected_hashes = binary_hashes(binaries)
    report = {"platform": platform.platform(), "architecture": platform.machine(),
              "source_head": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
              "binaries": {name: {"path": path, "sha256": expected_hashes[name]} for name, path in binaries.items()},
              "scope": "Managed startup, 3s settle, idle, then one untimed projects-list command pinned to the selected CLI. Synthetic private homes; no Docker application workload.",
              "rss_ceiling_mib": args.rss_ceiling_mib,
              "schema_comparison": "optional Boolean outputTruncated only" if args.allow_optional_output_truncation else "exact",
              "measurement": "RSS sums may repeat shared pages. Linux isolated cgroup CPU includes all helpers, controller and init; excludes outer VM/host. Native startup CPU is intentionally absent; idle ps CPU is quantized.",
              "observer": "Backend differs only by private PID/exit records and a 1s post-disconnect idle timeout; startup observer overhead is included.",
              "cgroup_limits": {"memory_bytes": cgroup.memory_limit, "cpu_max": cgroup.cpu_limit} if cgroup else None,
              "samples": []}
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    for trial in range(args.trials):
        counts = args.counts if trial % 2 == 0 else list(reversed(args.counts))
        for count in counts:
            for variant in (["stdio", "managed"] if trial % 2 == 0 else ["managed", "stdio"]):
                if binary_hashes(binaries) != expected_hashes:
                    raise RuntimeError("Benchmark executable changed before cohort")
                sample = run_cohort(binaries, variant, count, args.idle_seconds, cgroup, rss_ceiling=args.rss_ceiling_mib * 1024, allow_optional_output_truncation=args.allow_optional_output_truncation)
                if binary_hashes(binaries) != expected_hashes:
                    sample.setdefault("error", "Benchmark executable changed during cohort")
                sample["trial"] = trial + 1
                report["samples"].append(sample)
                schemas = {item["tools_contract_sha256"] for item in report["samples"] if "tools_contract_sha256" in item}
                if len(schemas) > 1:
                    sample.setdefault("error", "Tool schemas differ between variants")
                output.write_text(json.dumps(report, indent=2) + "\n")
                print(json.dumps({key: sample.get(key) for key in ("trial", "variant", "clients", "ready_ms", "rss_idle_kib", "startup_cpu_seconds", "idle_cpu_seconds", "error")}), flush=True)
                if "error" in sample:
                    raise RuntimeError(sample["error"])


if __name__ == "__main__":
    main()
