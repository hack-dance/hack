#!/usr/bin/env python3
"""Preview-first, matched native-authoring versus legacy Compose CLI overhead.

Only --run touches Docker. Use a frozen, independently qualified current-branch
CLI/compiler, a qualified running proxy with curl, and an exclusive Docker test
slot. Default ingress uses host port 80; an explicit private receipt selects an
isolated proxy with no published ports. This measures reaped CLI-tree CPU, not
Docker/VM or application CPU.
"""
import argparse
import hashlib
import http.client
import json
import math
import os
from pathlib import Path
import platform
import re
import secrets
import signal
import ssl
import stat
import statistics
import subprocess
import tempfile
import threading
import time

IMAGE = re.compile(r"^sha256:[a-f0-9]{64}$")
OBJECT_ID = re.compile(r"^[a-f0-9]{64}$")
TOKEN = re.compile(r"^[a-f0-9]{32}$")
SHA = re.compile(r"^[a-f0-9]{40}$")
OWNER = "io.hack.benchmark.owner"
PROJECT = "com.docker.compose.project"
SERVICE = "com.docker.compose.service"
NATIVE_OWNER = "io.hack.native-config.owner"
ROOT_CA = "/data/caddy/pki/authorities/local/root.crt"
PRIVATE_TMPFS = "rw,noexec,nosuid,nodev,mode=700"
BUILD = re.compile(r"^(cargo|rustc|clang|clang\+\+|ld|ld64|zig|swiftc|swift-frontend|xcodebuild)$")
OUTPUT_LIMIT = 2 * 1024 * 1024
ACTIONS = ("up", "ps", "exec", "restart", "down")
GATES = {
    "rounds": 8,
    "cohorts": [1, 2],
    "fast_cpu_delta_s": 0.05,
    "lifecycle_cpu_delta_s": 0.25,
    "cpu_fraction": 0.25,
    "fast_wall_delta_s": 0.10,
    "lifecycle_wall_delta_s": 0.50,
    "wall_fraction": 0.15,
    "p95_fraction": 0.30,
    "p95_floor_s": 0.75,
    "baseline_mad_fraction": 0.20,
    "baseline_mad_floor_s": 0.02,
    "noise_load_per_cpu": 0.50,
    "total_seconds": 1800,
    "command_seconds": 90,
}
INITIALIZER = 'import { existsSync } from "node:fs"; if (!existsSync("/data/initialized")) await Bun.write("/data/initialized", "initializer-completed"); console.log("initialized")'
APP = '''import { readFileSync, existsSync } from "node:fs";
if (readFileSync("/data/initialized", "utf8") !== "initializer-completed") process.exit(24);
const boot = crypto.randomUUID();
Bun.serve({ hostname: "0.0.0.0", port: 3000, async fetch(request) {
  if (request.method === "POST") {
    const marker = await request.text();
    if (!/^[a-f0-9]{32}$/.test(marker)) return new Response("invalid", {status:400});
    await Bun.write("/data/marker", marker);
  }
  return Response.json({ boot, initialized: readFileSync("/data/initialized", "utf8"), marker: existsSync("/data/marker") ? readFileSync("/data/marker", "utf8") : null });
}});'''
HEALTH = 'const r = await fetch("http://127.0.0.1:3000/", {signal:AbortSignal.timeout(2000)}); process.exit(r.ok ? 0 : 1)'
INSPECT = '{"id":{{json .Id}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"owner":{{json (index .Config.Labels "io.hack.benchmark.owner")}},"nativeOwner":{{json (index .Config.Labels "io.hack.native-config.owner")}},"instance":{{json (index .Config.Labels "io.hack.native-config.instance")}},"oneoff":{{json (index .Config.Labels "com.docker.compose.oneoff")}},"state":{{json .State.Status}},"exit":{{json .State.ExitCode}},"health":{{with (index .State "Health")}}{{json .Status}}{{else}}null{{end}}}'
SEMANTICS = '{"image":{{json .Image}},"command":{{json .Config.Cmd}},"entrypoint":{{json .Config.Entrypoint}},"init":{{json .HostConfig.Init}},"signal":{{json .Config.StopSignal}},"grace":{{json (index .Config "StopTimeout")}},"restart":{{json .HostConfig.RestartPolicy}},"health":{{json (index .Config "Healthcheck")}},"memory":{{json .HostConfig.Memory}},"cpus":{{json .HostConfig.NanoCpus}},"mounts":{{json .Mounts}}}'
PROXY = '{"id":{{json .Id}},"image":{{json .Image}},"running":{{json .State.Running}},"started":{{json .State.StartedAt}},"network":{{with (index .NetworkSettings.Networks "hack-dev")}}{{json .NetworkID}}{{else}}null{{end}},"ports":{{json .NetworkSettings.Ports}}}'
PROXY_FIXTURE = '{"id":{{json .Id}},"image":{{json .Image}},"name":{{json .Name}},"running":{{json .State.Running}},"started":{{json .State.StartedAt}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"owner":{{json (index .Config.Labels "io.hack.benchmark.proxy-owner")}},"network":{{with (index .NetworkSettings.Networks "hack-dev")}}{{json .NetworkID}}{{else}}null{{end}},"networks":{{json .NetworkSettings.Networks}},"networkMode":{{json .HostConfig.NetworkMode}},"ports":{{json .HostConfig.PortBindings}},"publishAll":{{json .HostConfig.PublishAllPorts}},"publishedPorts":{{json .NetworkSettings.Ports}},"privileged":{{json .HostConfig.Privileged}},"mounts":{{json .Mounts}},"tmpfs":{{json .HostConfig.Tmpfs}}}'


class Failure(RuntimeError):
    pass


def fingerprint(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def private_json(path, with_anchor=False):
    """Read only a bounded, private, stable named receipt; never follow a replacement link."""
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        if not (stat.S_ISREG(before.st_mode) and before.st_uid == os.getuid() and before.st_mode & 0o777 == 0o600 and
                before.st_nlink == 1 and before.st_size <= 65536):
            raise Failure("Private fixture receipt has unsafe ownership or shape")
        data = os.read(descriptor, 65537)
        after = os.fstat(descriptor)
        named = os.lstat(path)
        anchor = lambda value: (value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        if len(data) > 65536 or anchor(before) != anchor(after) or anchor(after) != anchor(named):
            raise Failure("Private fixture receipt changed while observed")
        value = json.loads(data)
        return (value, anchor(named)) if with_anchor else value
    finally:
        os.close(descriptor)


def command(argv, *, cwd, env, timeout, capture=None, output_limit=OUTPUT_LIMIT):
    """wait4 isolates each terminated CLI and the children it actually reaped.

    Keep the session leader unreaped until interruption decisions are finished.
    Never signal a group after successful wait4: its numeric ID may be reused.
    Detached engine processes are deliberately outside this accounting boundary.
    """
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        started = time.monotonic()
        child = subprocess.Popen(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                 stdout=out, stderr=err, start_new_session=True)
        interrupted = None
        try:
            while True:
                pid, status, usage = os.wait4(child.pid, os.WNOHANG)
                if pid:
                    child.returncode = os.waitstatus_to_exitcode(status)
                    break
                if interrupted is None:
                    if time.monotonic() - started >= timeout:
                        interrupted = "timeout"
                    elif os.fstat(out.fileno()).st_size + os.fstat(err.fileno()).st_size > output_limit:
                        interrupted = "output-budget"
                    if interrupted:
                        # The unreaped owned leader pins this process/group identity.
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                time.sleep(0.01)
        except BaseException:
            if child.returncode is None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                _, status, _ = os.wait4(child.pid, 0)
                child.returncode = os.waitstatus_to_exitcode(status)
            raise
        wall = time.monotonic() - started
        out.seek(0)
        err.seek(0)
        stdout = out.read(output_limit + 1)
        stderr = err.read(output_limit + 1)
    if len(stdout) + len(stderr) > output_limit:
        interrupted = interrupted or "output-budget"
    if capture is not None:
        # Captures contain only this synthetic fixture's CLI output. Never capture
        # global proxy JSON, Docker context credentials or raw inspect environment.
        with open(capture, "xb") as file:
            os.chmod(capture, 0o600)
            file.write((stdout + b"\n" + stderr)[:output_limit])
    return {"exit": child.returncode, "stdout": stdout.decode(errors="replace"), "started_monotonic": started,
            "wall_s": wall, "cli_cpu_s": usage.ru_utime + usage.ru_stime,
            "child_maxrss_bytes": usage.ru_maxrss * (1 if platform.system() == "Darwin" else 1024),
            "interrupted": interrupted}


def fixture_documents(name, image, hostname, token):
    """One workload definition feeds both authored formats; live inspect checks it again."""
    common = {"image": image, "pull_policy": "never", "init": True,
              "restart": {"kind": "no"}, "shutdown": {"signal": "SIGTERM", "grace": "5s"},
              "mounts": [{"storage": "data", "target": "/data", "access": "read-write"}]}
    native = {"schema_version": 1, "name": name, "source": {"root": ".", "mode": "host-mounted"},
              "storage": {"data": {"kind": "persistent", "scope": "worktree"}},
              "services": {"web": {**common, "command": {"exec": ["bun", "-e", APP]},
                  "depends_on": [{"job": "initializer", "condition": "completed"}],
                  "readiness": {"kind": "exec", "command": {"exec": ["bun", "-e", HEALTH]},
                                "interval": "1s", "timeout": "3s", "retries": 30}}},
              "jobs": {"initializer": {**common, "command": {"exec": ["bun", "-e", INITIALIZER]}}},
              "routes": {"origin": f"http://{hostname}", "http": {
                  "web": {"service": "web", "port": 3000, "protocol": "http", "hostname": "project"}}}}
    labels = {OWNER: token}
    shared = {"image": image, "pull_policy": "never", "init": True, "restart": "no",
              "stop_signal": "SIGTERM", "stop_grace_period": "5s", "volumes": ["data:/data"],
              "labels": labels}
    legacy = {"name": name, "services": {
        "web": {**shared, "command": ["bun", "-e", APP],
            "depends_on": {"initializer": {"condition": "service_completed_successfully"}},
            "healthcheck": {"test": ["CMD", "bun", "-e", HEALTH], "interval": "1s", "timeout": "3s", "retries": 30},
            "networks": ["default", "hack-dev"],
            "labels": {**labels, "caddy_0": f"http://{hostname}",
                "caddy_0.reverse_proxy": "{{upstreams http 3000}}", "caddy_ingress_network": "hack-dev"}},
        "initializer": {**shared, "command": ["bun", "-e", INITIALIZER]}},
        "volumes": {"data": {"labels": labels}},
        "networks": {"default": {"labels": labels}, "hack-dev": {"external": True}}}
    config = {"name": name, "dev_host": hostname, "internal": {"dns": False, "tls": False},
              "oauth": {"enabled": False}, "logs": {"follow_backend": "compose", "clear_on_down": False}}
    return native, legacy, config


def environment(home, compiler):
    keys = ("PATH", "HOME", "TMPDIR", "USER", "SHELL", "DOCKER_HOST", "DOCKER_CONFIG", "DOCKER_CONTEXT")
    env = {key: os.environ[key] for key in keys if key in os.environ}
    env.update(HACK_HOME=str(home), HACK_GLOBAL_CONFIG_PATH=str(home / "hack.config.json"),
               HACK_CONFIG_COMPILER_BINARY=str(compiler), HACK_NO_INTERACTIVE="1", NO_COLOR="1",
               CLICOLOR="0", TERM="dumb", LANG="C", LC_ALL="C", HACK_RUNTIME_BACKEND="compose",
               HACK_DAEMON_DISABLE_DOCKER_EVENTS="1")
    return env


def paired_order(round_index):
    return ("legacy", "native") if round_index % 2 == 0 else ("native", "legacy")


def noise_snapshot(env, cwd):
    processes = command(["ps", "-axo", "comm="], cwd=cwd, env=env, timeout=3)
    names = [Path(name.strip()).name for name in processes["stdout"].splitlines()]
    reasons = []
    if processes["exit"] or processes["interrupted"]:
        reasons.append("process-observation-unavailable")
    if any(BUILD.fullmatch(name) for name in names):
        reasons.append("competing-build")
    load = os.getloadavg()[0]
    if load > (os.cpu_count() or 1) * GATES["noise_load_per_cpu"]:
        reasons.append("host-load")
    if platform.system() == "Darwin":
        pressure = command(["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"],
                           cwd=cwd, env=env, timeout=3)
        if pressure["exit"] or pressure["interrupted"] or pressure["stdout"].strip() != "1":
            reasons.append("memory-pressure-or-unavailable")
    elif platform.system() == "Linux":
        try:
            text = Path("/proc/pressure/memory").read_text()
            match = re.search(r"^some avg10=([\d.]+)", text, re.MULTILINE)
            if match is None or float(match.group(1)) > 0.5:
                reasons.append("memory-pressure-or-unavailable")
        except OSError:
            reasons.append("memory-pressure-or-unavailable")
    else:
        reasons.append("unsupported-host")
    return {"load1": load, "reasons": reasons, "admitted": not reasons}


class Admission:
    """Sample names/load/pressure during long commands too; never ignore missing observations."""
    def __init__(self, env, cwd):
        self.env, self.cwd = env, cwd
        self.stop = threading.Event()
        self.samples = []
        self.worker = threading.Thread(target=self.observe, daemon=True)

    def sample(self):
        started = time.monotonic()
        try:
            value = noise_snapshot(self.env, self.cwd)
        except (OSError, Failure):
            value = {"admitted": False, "reasons": ["noise-observation-unavailable"]}
        value["at_monotonic"] = started
        self.samples.append(value)

    def observe(self):
        while not self.stop.wait(1):
            self.sample()

    def __enter__(self):
        self.sample()
        self.worker.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.worker.join(timeout=10)
        if self.worker.is_alive():
            self.samples.append({"admitted": False, "reasons": ["noise-worker-unreaped"]})
        else:
            self.sample()

    def admitted(self):
        times = [row["at_monotonic"] for row in self.samples if "at_monotonic" in row]
        return (bool(self.samples) and len(times) == len(self.samples) and
                all(row["admitted"] for row in self.samples) and
                all(right - left <= 5 for left, right in zip(times, times[1:])))


def semantic_projection(row):
    """Normalize instance-specific storage names only, never process/resources policy."""
    result = {key: row.get(key) for key in
              ("image", "command", "entrypoint", "init", "signal", "grace", "restart", "health", "memory", "cpus")}
    mounts = row.get("mounts")
    if not isinstance(mounts, list) or not all(isinstance(item, dict) for item in mounts):
        raise Failure("Workload mount observation unavailable")
    result["mounts"] = sorted((item.get("Type"), item.get("Destination"), item.get("RW")) for item in mounts)
    return result


def require_matched(left, right):
    if left != right:
        raise Failure("Lane runtime semantics differ; comparison is inconclusive")


def require_ps(payload, lane, project):
    if not isinstance(payload, dict):
        raise Failure("Timed ps observation unavailable")
    if lane == "native":
        if payload.get("ok") is not True or not isinstance(payload.get("data"), dict):
            raise Failure("Timed native ps returned no successful envelope")
        value = payload["data"]
        items = value.get("services")
        healthy = isinstance(items, list) and any(isinstance(row, dict) and row.get("service") == "web" and
                   row.get("status") == "running" and row.get("health") == "healthy" for row in items)
    else:
        value = payload
        items = value.get("items")
        healthy = isinstance(items, list) and any(isinstance(row, dict) and row.get("Service") == "web" and
                   row.get("State") == "running" and row.get("Health") == "healthy" for row in items)
    if value.get("composeProject") != project or not healthy:
        raise Failure("Timed ps must identify this exact healthy fixture")


def owned_rows(rows, project, token, lane):
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise Failure("Fixture engine ownership observation unavailable; resources retained")
        expected = row.get("nativeOwner") if lane == "native" else row.get("owner")
        if not (isinstance(row.get("id"), str) and OBJECT_ID.fullmatch(row["id"]) and
                row["id"] not in seen and row.get("project") == project and expected == token and
                row.get("service") in ("web", "initializer") and row.get("oneoff") == "False" and
                (lane != "native" or row.get("instance") == project)):
            raise Failure("Fixture engine ownership is missing or conflicting; resources retained")
        seen.add(row["id"])
    return rows


def routes_for_host(servers, hostname):
    """Conservative route walker: wildcards and conditional/unknown matches cannot pass."""
    found = []
    presence = []
    def covers(pattern, name):
        return pattern == name or pattern == "*" or (pattern.startswith("*.") and name.endswith(pattern[1:]))
    def walk(routes, inherited=("*",), conditional=False, depth=0):
        if not isinstance(routes, list) or depth > 64:
            raise Failure("Active route configuration is ambiguous")
        for route in routes:
            if not isinstance(route, dict):
                raise Failure("Active route configuration is ambiguous")
            matches = route.get("match", [])
            if not isinstance(matches, list):
                raise Failure("Active route configuration is ambiguous")
            hosts = list(inherited)
            conditional_here = conditional
            alternatives = []
            for matcher in matches:
                if not isinstance(matcher, dict):
                    raise Failure("Active route configuration is ambiguous")
                conditional_here |= any(key != "host" for key in matcher)
                selected = matcher.get("host", ["*"])
                if not isinstance(selected, list) or not all(isinstance(host, str) for host in selected):
                    raise Failure("Active route configuration is ambiguous")
                for host in selected:
                    for parent in inherited:
                        if covers(parent, host):
                            alternatives.append(host)
                        elif covers(host, parent):
                            alternatives.append(parent)
            if matches:
                hosts = list(dict.fromkeys(alternatives))
            relevant = any(covers(host, hostname) for host in hosts)
            if relevant and matches:
                presence.append(True)
            handlers = route.get("handle", [])
            if not isinstance(handlers, list):
                raise Failure("Active route configuration is ambiguous")
            for handler in handlers:
                if not isinstance(handler, dict):
                    raise Failure("Active route configuration is ambiguous")
                if handler.get("handler") == "subroute":
                    walk(handler.get("routes"), hosts, conditional_here, depth + 1)
                elif relevant:
                    if handler.get("handler") != "reverse_proxy" or conditional_here or hosts != [hostname]:
                        raise Failure("Active fixture route cannot be attributed exactly")
                    upstreams = handler.get("upstreams")
                    if not isinstance(upstreams, list) or not all(isinstance(item, dict) and isinstance(item.get("dial"), str) for item in upstreams):
                        raise Failure("Active fixture upstreams are ambiguous")
                    if handler.get("transport", {"protocol": "http"}) != {"protocol": "http"}:
                        raise Failure("Active fixture upstream protocol is ambiguous")
                    found.extend(item["dial"] for item in upstreams)
    if not isinstance(servers, dict):
        raise Failure("Active route observation unavailable")
    for server in servers.values():
        if not isinstance(server, dict):
            raise Failure("Active route observation unavailable")
        walk(server.get("routes", []))
    return found if found or not presence else ["matched-route-without-upstream"]


def summary(records):
    """Only complete, correct, clean paired rounds enter comparisons; never replace failures."""
    result = {"qualified": True, "actions": {}, "failures": [], "flagged": []}
    for size in GATES["cohorts"]:
        for action in ACTIONS:
            selected = [row for row in records if row["cohort"] == size and row["action"] == action]
            clean = []
            for index in range(GATES["rounds"]):
                members = [row for row in selected if row["round"] == index]
                pair = {row["lane"]: row for row in members}
                if len(members) != 2 or set(pair) != {"native", "legacy"} or not all(row.get("ok") for row in pair.values()):
                    result["failures"].append({"cohort": size, "action": action, "round": index})
                    continue
                if not all(row.get("admitted") for row in pair.values()):
                    result["flagged"].append({"cohort": size, "action": action, "round": index})
                    continue
                clean.append(pair)
            cells = {"pairs": len(clean), "required": GATES["rounds"], "metrics": {}}
            for metric in ("wall_s", "ready_wall_s", "cli_cpu_s"):
                baseline = [pair["legacy"][metric] for pair in clean]
                candidate = [pair["native"][metric] for pair in clean]
                if not baseline:
                    cells["metrics"][metric] = None
                    continue
                legacy = statistics.median(baseline)
                native = statistics.median(candidate)
                deltas = [b - a for a, b in zip(baseline, candidate)]
                cpu = metric == "cli_cpu_s"
                fast = action in ("ps", "exec")
                floor = GATES[("fast_" if fast else "lifecycle_") + ("cpu_delta_s" if cpu else "wall_delta_s")]
                fraction = GATES["cpu_fraction" if cpu else "wall_fraction"]
                mad = statistics.median(abs(value - legacy) for value in baseline)
                noisy = mad > max(GATES["baseline_mad_floor_s"], legacy * GATES["baseline_mad_fraction"])
                p95_legacy = sorted(baseline)[math.ceil(len(baseline) * .95) - 1]
                p95_native = sorted(candidate)[math.ceil(len(candidate) * .95) - 1]
                accepted = statistics.median(deltas) <= max(floor, fraction * legacy)
                if not cpu:
                    accepted &= p95_native - p95_legacy <= max(GATES["p95_floor_s"], p95_legacy * GATES["p95_fraction"])
                gating = metric != "wall_s" or fast
                cells["metrics"][metric] = {"legacy_median": legacy, "native_median": native,
                    "paired_median_delta": statistics.median(deltas), "ratio": native / legacy if legacy > 0 else None,
                    "legacy_mad": mad, "p95_legacy": p95_legacy, "p95_native": p95_native,
                    "noise": noisy, "gating": gating, "accepted": accepted if gating else None,
                    "qualified": len(clean) == GATES["rounds"] and not noisy}
                if gating and (not accepted or noisy):
                    result["qualified"] = False
            if len(clean) != GATES["rounds"]:
                result["qualified"] = False
            result["actions"][f"{size}:{action}"] = cells
    return result


class Benchmark:
    def __init__(self, args):
        self.args = args
        self.records = []
        self.sequence = 0
        self.deadline = time.monotonic() + GATES["total_seconds"]
        self.root = Path(args.output_root).resolve()
        self.cli = Path(args.cli).resolve()
        self.compiler = Path(args.compiler).resolve()
        self.expected_hashes = {self.cli: args.cli_sha256, self.compiler: args.compiler_sha256}
        self.env = environment(self.root / "observer-home", self.compiler)
        self.proxy = None
        self.image = None
        self.uncertain = False
        self.proxy_fixture = None
        self.proxy_fixture_anchor = None
        self.proxy_fixture_path = None
        self.proxy_fixture_parent = None

    def budget(self):
        left = self.deadline - time.monotonic()
        if left <= 0:
            raise Failure("Experiment deadline expired; no new effect may start")
        return min(GATES["command_seconds"], left)

    def run(self, argv, *, cwd=None, env=None, capture=False, timeout=None, output_limit=OUTPUT_LIMIT):
        self.sequence += 1
        try:
            result = command(argv, cwd=cwd or self.root, env=env or self.env,
                             timeout=min(self.budget(), timeout) if timeout is not None else self.budget(),
                             capture=self.root / f"cli-{self.sequence:04d}.log" if capture else None,
                             output_limit=output_limit)
        except BaseException:
            self.uncertain = True
            raise
        if result["interrupted"]:
            self.uncertain = True
        if result["interrupted"] or result["exit"] != 0:
            raise Failure("Command failed or was interrupted; no sample qualifies; inspect private captures")
        return result

    def docker(self, *argv):
        return self.run(["docker", *argv])["stdout"].strip()

    def json_docker(self, *argv):
        try:
            return json.loads(self.docker(*argv))
        except ValueError:
            raise Failure("Structured engine observation unavailable") from None

    def assert_frozen(self):
        for path, expected in self.expected_hashes.items():
            if fingerprint(path) != expected:
                raise Failure("Qualified executable changed; stop instead of mixing revisions")

    def fixture_receipt_parent(self, path):
        for parent in (path, *path.parents):
            info = parent.lstat()
            if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.getuid()):
                raise Failure("Proxy fixture receipt directory ancestry changed")
            if info.st_mode & 0o022 and not info.st_mode & stat.S_ISVTX:
                raise Failure("Proxy fixture receipt directory ancestry is writable")
        info = path.lstat()
        if info.st_uid != os.getuid() or info.st_mode & 0o777 != 0o700:
            raise Failure("Proxy fixture receipt requires a private owned parent")
        return info

    def read_proxy_fixture(self, path):
        selected = Path(path)
        if not selected.is_absolute() or str(selected.resolve()) != str(selected):
            raise Failure("Proxy fixture receipt must be canonical")
        parent = self.fixture_receipt_parent(selected.parent)
        receipt, anchor = private_json(selected, with_anchor=True)
        fields = {"fixture_version", "phase", "engine_id", "docker_endpoint", "proxy_id", "proxy_name", "owner_token",
                  "image_id", "network_id", "started_at", "ca_sha256", "canary"}
        if not (isinstance(receipt, dict) and set(receipt) == fields and type(receipt["fixture_version"]) is int and
                receipt["fixture_version"] == 1 and receipt["phase"] == "qualified" and
                isinstance(receipt["engine_id"], str) and re.fullmatch(r"[A-Za-z0-9:-]{1,128}", receipt["engine_id"]) and
                isinstance(receipt["docker_endpoint"], str) and receipt["docker_endpoint"].startswith("unix://") and
                all(isinstance(receipt[key], str) and OBJECT_ID.fullmatch(receipt[key]) for key in ("proxy_id", "network_id", "ca_sha256")) and
                isinstance(receipt["image_id"], str) and IMAGE.fullmatch(receipt["image_id"]) and
                isinstance(receipt["owner_token"], str) and TOKEN.fullmatch(receipt["owner_token"]) and
                receipt["proxy_name"] == "nc03-overhead-proxy-" + receipt["owner_token"] and
                isinstance(receipt["started_at"], str) and 1 <= len(receipt["started_at"]) <= 128 and
                isinstance(receipt["canary"], dict) and set(receipt["canary"]) == {"hostname", "marker"} and
                receipt["canary"]["hostname"] == "canary-" + receipt["owner_token"] + ".benchmark.invalid" and
                isinstance(receipt["canary"]["marker"], str) and TOKEN.fullmatch(receipt["canary"]["marker"])):
            raise Failure("Proxy fixture receipt is malformed or unqualified")
        self.proxy_fixture, self.proxy_fixture_anchor, self.proxy_fixture_path = receipt, anchor, selected
        self.proxy_fixture_parent = (parent.st_dev, parent.st_ino, parent.st_uid, parent.st_mode)

    def assert_proxy_fixture(self):
        parent = self.fixture_receipt_parent(self.proxy_fixture_path.parent)
        if (parent.st_dev, parent.st_ino, parent.st_uid, parent.st_mode) != self.proxy_fixture_parent:
            raise Failure("Proxy fixture receipt parent changed")
        if str(self.proxy_fixture_path.resolve()) != str(self.proxy_fixture_path):
            raise Failure("Proxy fixture receipt ancestry changed")
        receipt, anchor = private_json(self.proxy_fixture_path, with_anchor=True)
        if receipt != self.proxy_fixture or anchor != self.proxy_fixture_anchor:
            raise Failure("Proxy fixture receipt changed")
        if self.env.get("DOCKER_HOST") != self.proxy_fixture["docker_endpoint"]:
            raise Failure("Proxy fixture engine endpoint changed")

    def fixture_proxy_binding(self, engine, id):
        self.assert_proxy_fixture()
        receipt = self.proxy_fixture
        if engine != receipt["engine_id"] or id != receipt["proxy_id"]:
            raise Failure("Proxy fixture engine or selected identity changed")
        proxy = self.json_docker("container", "inspect", "--format", PROXY_FIXTURE, id)
        expected = {"id": id, "image": receipt["image_id"], "name": "/" + receipt["proxy_name"],
                    "running": True, "started": receipt["started_at"], "project": "hack-dev-proxy", "service": "caddy",
                    "owner": receipt["owner_token"], "network": receipt["network_id"], "networkMode": receipt["network_id"],
                    "privileged": False, "publishAll": False, "tmpfs": {"/data": PRIVATE_TMPFS, "/config": PRIVATE_TMPFS}}
        if not (isinstance(proxy, dict) and set(proxy) == {*expected, "ports", "publishedPorts", "mounts", "networks"} and
                all(proxy[key] == value for key, value in expected.items()) and proxy["ports"] in (None, {}) and
                proxy["running"] is True and proxy["privileged"] is False and proxy["publishAll"] is False and
                isinstance(proxy["networks"], dict) and set(proxy["networks"]) == {"hack-dev"} and
                isinstance(proxy["networks"]["hack-dev"], dict) and proxy["networks"]["hack-dev"].get("NetworkID") == receipt["network_id"]):
            raise Failure("Proxy fixture ownership or isolation changed")
        published = proxy["publishedPorts"]
        if not (published is None or (isinstance(published, dict) and
                all(value is None or (isinstance(value, list) and not value) for value in published.values()))):
            raise Failure("Proxy fixture has published ports")
        mounts = proxy["mounts"]
        expected_mounts = [("/var/run/docker.sock", "/var/run/docker.sock", False)]
        if not (isinstance(mounts, list) and all(isinstance(item, dict) and item.get("Type") == "bind" and
                isinstance(item.get("Source"), str) and isinstance(item.get("Destination"), str) and type(item.get("RW")) is bool for item in mounts) and
                sorted((item.get("Source"), item.get("Destination"), item.get("RW")) for item in mounts) == expected_mounts):
            raise Failure("Proxy fixture mounts changed")
        network = self.json_docker("network", "inspect", "hack-dev", "--format", '{"id":{{json .Id}},"name":{{json .Name}}}')
        if network != {"id": receipt["network_id"], "name": "hack-dev"}:
            raise Failure("Proxy fixture network changed")
        certificate = self.run(["docker", "exec", id, "cat", ROOT_CA], timeout=5, output_limit=16384)["stdout"]
        try:
            ca_hash = hashlib.sha256(ssl.PEM_cert_to_DER_cert(certificate)).hexdigest()
        except ValueError:
            raise Failure("Proxy fixture public CA unavailable") from None
        if ca_hash != receipt["ca_sha256"]:
            raise Failure("Proxy fixture public CA changed")
        self.assert_proxy_fixture()
        return {"engine": engine, **proxy, "ca_sha256": ca_hash}

    def proxy_binding(self):
        engine = self.json_docker("info", "--format", "{{json .ID}}")
        ids = self.docker("container", "ls", "--no-trunc", "--filter", "label=com.docker.compose.project=hack-dev-proxy",
                          "--filter", "label=com.docker.compose.service=caddy", "--format", "{{.ID}}").split()
        if len(ids) != 1 or not OBJECT_ID.fullmatch(ids[0]):
            raise Failure("An already-running exact global proxy is required; no setup is performed")
        if self.proxy_fixture is not None:
            return self.fixture_proxy_binding(engine, ids[0])
        proxy = self.json_docker("container", "inspect", "--format", PROXY, ids[0])
        if not isinstance(proxy, dict):
            raise Failure("Structured proxy observation unavailable")
        ports = proxy.get("ports")
        ports = ports.get("80/tcp") if isinstance(ports, dict) else None
        if not (isinstance(engine, str) and re.fullmatch(r"[A-Za-z0-9:-]{1,128}", engine) and
                proxy.get("id") == ids[0] and proxy.get("running") is True and
                isinstance(proxy.get("network"), str) and OBJECT_ID.fullmatch(proxy["network"]) and
                isinstance(ports, list) and ports and all(isinstance(item, dict) and item.get("HostPort") == "80" for item in ports)):
            raise Failure("Standard verified HTTP ingress is required; no global configuration changes occur")
        return {"engine": engine, **proxy}

    def proxy_request(self, hostname, marker=None, canary=False):
        require_matched(self.proxy, self.proxy_binding())
        if canary:
            hostname = self.proxy_fixture["canary"]["hostname"]
        elif not re.fullmatch(r"nc03-[a-f0-9]{32}\.benchmark\.invalid", hostname):
            raise Failure("Synthetic app hostname required")
        if marker is not None and not TOKEN.fullmatch(marker):
            raise Failure("Synthetic app marker required")
        argv = ["docker", "exec", self.proxy["id"], "curl", "--disable", "--silent", "--show-error", "--fail",
                "--proxy", "", "--noproxy", "*", "--proto", "=https" if canary else "=http",
                "--connect-timeout", "2", "--max-time", "3", "--max-redirs", "0", "--max-filesize", "4096",
                "--write-out", "\n%{http_code}"]
        if canary:
            argv += ["--cacert", ROOT_CA, "--resolve", hostname + ":443:127.0.0.1", "--url", "https://" + hostname + "/"]
        else:
            argv += ["--header", "Host: " + hostname, "--url", "http://127.0.0.1:80/"]
        if marker is not None:
            argv += ["--request", "POST", "--data-raw", marker]
        text = self.run(argv, timeout=5, output_limit=4100)["stdout"]
        body, separator, status = text.rpartition("\n")
        if not separator or status != "200" or len(body.encode()) > 4096:
            raise Failure("Common proxy HTTP readiness failed")
        require_matched(self.proxy, self.proxy_binding())
        if canary and body != self.proxy_fixture["canary"]["marker"]:
            raise Failure("Proxy fixture TLS canary differs")
        return body

    def active_routes(self, hostname):
        require_matched(self.proxy, self.proxy_binding())
        # curl is an explicit prerequisite of the qualified proxy image. There is
        # no binary copying, sidecar, autosave fallback, admin publication or pull.
        text = self.docker("exec", self.proxy["id"], "curl", "--disable", "--silent", "--show-error",
                           "--noproxy", "*", "--connect-timeout", "2", "--max-time", "3",
                           "--max-redirs", "0", "--write-out", "\n%{http_code}",
                           "http://127.0.0.1:2019/config/apps/http/servers")
        body, separator, status = text.rpartition("\n")
        if not separator or status != "200":
            raise Failure("Live admin HTTP 200 required; no autosave/HTTPS-only fallback")
        try:
            found = routes_for_host(json.loads(body), hostname)
        except ValueError:
            raise Failure("Active route JSON unavailable") from None
        require_matched(self.proxy, self.proxy_binding())
        return found

    def preflight(self):
        self.assert_frozen()
        if self.root.exists():
            raise Failure("Output directory must be new; existing evidence is never overwritten")
        parent = self.root.parent
        if parent.is_symlink() or parent.stat().st_uid != os.getuid() or parent.stat().st_mode & 0o077:
            raise Failure("Output parent must be an existing private owned directory")
        if any((directory / ".git").exists() for directory in (parent, *parent.parents)):
            raise Failure("Raw results must remain outside a Git checkout")
        self.root.mkdir(mode=0o700)
        home = self.root / "home"
        home.mkdir(mode=0o700)
        (home / "hack.config.json").write_text(json.dumps({"controlPlane": {"daemon": {"autoStart": False}}}))
        self.env = environment(home, self.compiler)
        selected_context = self.env.get("DOCKER_CONTEXT")
        endpoint = (self.json_docker("context", "inspect", selected_context, "--format", "{{json .Endpoints.docker.Host}}")
                    if selected_context else self.env.get("DOCKER_HOST") or
                    self.json_docker("context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"))
        if not isinstance(endpoint, str) or not endpoint.startswith("unix://"):
            raise Failure("This host-local benchmark requires a Unix Docker endpoint")
        # Pin the actually selected local endpoint rather than rereading mutable
        # Docker context selection for later fixture effects.
        self.env["DOCKER_HOST"] = endpoint
        self.env.pop("DOCKER_CONTEXT", None)
        if self.args.proxy_fixture_receipt:
            self.read_proxy_fixture(self.args.proxy_fixture_receipt)
        self.image = self.json_docker("image", "inspect", self.args.image, "--format", "{{json .Id}}")
        if not isinstance(self.image, str) or not IMAGE.fullmatch(self.image):
            raise Failure("Exact cached image ID required; no images are pulled")
        self.proxy = self.proxy_binding()
        if self.proxy_fixture is not None:
            self.proxy_request(self.proxy_fixture["canary"]["hostname"], canary=True)
        self.active_routes(f"nc03-preflight-{secrets.token_hex(16)}.benchmark.invalid")
        self.metadata = {"protocol_version": 1, "source_sha": self.args.qualified_source_sha,
            "cli_sha256": self.args.cli_sha256, "compiler_sha256": self.args.compiler_sha256,
            "platform": platform.platform(), "architecture": platform.machine(), "python": platform.python_version(),
            "cpus": os.cpu_count(), "engine": self.proxy["engine"], "proxy_id": self.proxy["id"],
            "proxy_image": self.proxy["image"], "image_id": self.image,
            "proxy_mode": "isolated-no-ports" if self.proxy_fixture is not None else "host80",
            "compose_version": self.docker("compose", "version", "--short"), "gates": GATES,
            "docker_version": self.docker("version", "--format", "{{.Client.Version}}/{{.Server.Version}}"),
            "boundary": "reaped CLI-tree CPU and common readiness wall; container/shared engine CPU not measured"}
        self.persist()

    def persist(self):
        path = self.root / "results.json"
        temporary = self.root / "results.pending"
        with open(temporary, "w") as file:
            os.chmod(temporary, 0o600)
            json.dump({"metadata": self.metadata, "records": self.records}, file, indent=2)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, path)


class Fixture:
    def __init__(self, bench, lane, index, hostname):
        self.bench, self.lane, self.hostname = bench, lane, hostname
        self.token = secrets.token_hex(16)
        self.name = f"nc03-{self.token}-{index}"
        self.root = bench.root / self.name
        self.root.mkdir(mode=0o700)
        self.hack = self.root / ".hack"
        self.hack.mkdir(mode=0o700)
        self.home = bench.root / "home"
        self.env = environment(self.home, bench.compiler)
        self.env["DOCKER_HOST"] = bench.env["DOCKER_HOST"]
        self.env.pop("DOCKER_CONTEXT", None)
        self.anchors = [(path, path.stat().st_dev, path.stat().st_ino) for path in (self.root, self.hack)]
        self.project = self.name if lane == "legacy" else None
        self.owner = self.token if lane == "legacy" else None
        self.volume = None
        self.volume_created = None
        self.semantics = None
        self.boot = None
        self.marker = secrets.token_hex(16)
        self.started = False
        native, legacy, config = fixture_documents(self.name, bench.image, hostname, self.token)
        selected = {"hack.project.json": native} if lane == "native" else {"hack.config.json": config, "docker-compose.yml": legacy}
        for filename, document in selected.items():
            (self.hack / filename).write_text(json.dumps(document, indent=2) + "\n")
        bench.run(["git", "-c", "init.templateDir=", "-c", "core.hooksPath=/dev/null", "init", "-q", "-b", "main"], cwd=self.root)

    def cli(self, *args):
        self.check_root()
        self.bench.assert_frozen()
        require_matched(self.bench.proxy, self.bench.proxy_binding())
        result = self.bench.run([str(self.bench.cli), *args], cwd=self.root, env=self.env, capture=True)
        return result

    def check_root(self):
        for path, dev, ino in self.anchors:
            actual = path.lstat()
            if path.is_symlink() or (actual.st_dev, actual.st_ino) != (dev, ino) or actual.st_uid != os.getuid():
                raise Failure("Disposable checkout identity changed; no cleanup effects authorized")

    def identity(self):
        self.check_root()
        if self.lane == "legacy":
            return
        paths = list((self.hack / ".internal" / "native-compose").glob("*/receipt.json"))
        if len(paths) != 1 or paths[0].is_symlink() or paths[0].stat().st_size > 65536:
            raise Failure("Exact native fixture receipt unavailable; preserve fixture")
        receipt = private_json(paths[0])
        identity = receipt.get("identity") if isinstance(receipt, dict) else None
        if not isinstance(identity, dict):
            raise Failure("Native fixture receipt has no exact identity")
        if not (identity.get("checkoutRoot") == str(self.root.resolve()) and
                isinstance(identity.get("composeProject"), str) and identity["composeProject"].startswith("hack-nc-") and
                isinstance(identity.get("ownerToken"), str) and TOKEN.fullmatch(identity["ownerToken"])):
            raise Failure("Native receipt does not bind the exact disposable checkout")
        if self.project is not None and (self.project, self.owner) != (identity["composeProject"], identity["ownerToken"]):
            raise Failure("Fixture identity changed; preserve resources")
        self.project, self.owner = identity["composeProject"], identity["ownerToken"]

    def rows(self):
        self.identity()
        if self.project is None or self.owner is None:
            raise Failure("Exact fixture ownership unavailable")
        ids = self.bench.docker("container", "ls", "--all", "--no-trunc", "--filter", f"label={PROJECT}={self.project}", "--format", "{{.ID}}").split()
        if any(not OBJECT_ID.fullmatch(value) for value in ids) or len(ids) > 2:
            raise Failure("Unexpected fixture resource set; preserve resources")
        rows = [self.bench.json_docker("container", "inspect", "--format", INSPECT, value) for value in ids]
        return owned_rows(rows, self.project, self.owner, self.lane)

    def assert_resource_ownership(self):
        """Prove every selected resource before mutation, including same-name foreign objects."""
        self.identity()
        if self.project is None or self.owner is None:
            raise Failure("Exact fixture ownership unavailable")
        label = NATIVE_OWNER if self.lane == "native" else OWNER
        expected_network = f"{self.project}_default"
        expected_volume = (f"hack-{len(self.project)}-{self.project}-4-data" if self.lane == "native"
                           else f"{self.project}_data")
        if self.volume is not None and self.volume != expected_volume:
            raise Failure("Persistent fixture volume differs from the declared owned name")
        def inventory(kind, expected):
            id_field = ".Name" if kind == "volume" else ".ID"
            template = ('{"id":{{json ' + id_field + '}},"name":{{json .Name}},"project":{{json (.Label "' + PROJECT + '")}}}')
            output = self.bench.docker(kind, "ls", *([] if kind == "volume" else ["--no-trunc"]), "--format", template)
            selected = set()
            seen = set()
            for line in output.splitlines():
                row = json.loads(line)
                if not (isinstance(row, dict) and all(isinstance(row.get(key), str) for key in ("id", "name", "project")) and
                        row["id"] not in seen and (row["id"] == row["name"] if kind == "volume" else OBJECT_ID.fullmatch(row["id"]))):
                    raise Failure("Fixture resource inventory is ambiguous; preserve resources")
                seen.add(row["id"])
                if row["project"] == self.project or row["name"] == expected:
                    selected.add(row["id"])
            if len(selected) > 8:
                raise Failure("Unexpected fixture resource set; preserve resources")
            return selected
        networks = inventory("network", expected_network)
        network_format = ('{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Labels "' + PROJECT +
                          '")}},"owner":{{json (index .Labels "' + label + '")}}}')
        for network in sorted(networks):
            actual = self.bench.json_docker("network", "inspect", "--format", network_format, network)
            if actual != {"id": network, "name": expected_network, "project": self.project, "owner": self.owner}:
                raise Failure("Fixture network ownership is missing or conflicting; preserve resources")
        volumes = inventory("volume", expected_volume)
        if any(name != expected_volume for name in volumes):
            raise Failure("Fixture volume inventory is ambiguous; preserve resources")
        volume_format = ('{"name":{{json .Name}},"project":{{json (index .Labels "' + PROJECT +
                         '")}},"owner":{{json (index .Labels "' + label + '")}},"created":{{json .CreatedAt}}}')
        for volume in sorted(volumes):
            actual = self.bench.json_docker("volume", "inspect", "--format", volume_format, volume)
            if not (isinstance(actual, dict) and actual.get("name") == expected_volume and
                    actual.get("project") == self.project and actual.get("owner") == self.owner and
                    isinstance(actual.get("created"), str) and
                    (self.volume_created is None or actual["created"] == self.volume_created)):
                raise Failure("Fixture volume ownership is missing or conflicting; preserve resources")
        self.check_root()

    def request(self, write=False):
        if self.bench.proxy_fixture is not None:
            value = json.loads(self.bench.proxy_request(self.hostname, self.marker if write else None))
            return self.application_result(value)
        connection = http.client.HTTPConnection("127.0.0.1", 80, timeout=3)
        try:
            connection.request("POST" if write else "GET", "/", body=self.marker if write else None,
                               headers={"Host": self.hostname, "Connection": "close"})
            response = connection.getresponse()
            body = response.read(4097)
            if response.status != 200 or len(body) > 4096:
                raise Failure("Common application HTTP readiness failed")
            return self.application_result(json.loads(body))
        finally:
            connection.close()

    def application_result(self, value):
        if not (isinstance(value, dict) and value.get("initialized") == "initializer-completed" and
                isinstance(value.get("boot"), str) and
                (value.get("marker") == self.marker or (self.boot is None and value.get("marker") is None))):
            raise Failure("Application result or retained marker differs")
        return value

    def ready(self):
        deadline = time.monotonic() + min(45, self.bench.budget())
        while time.monotonic() < deadline:
            rows = self.rows()
            by_service = {row["service"]: row for row in rows}
            if set(by_service) == {"web", "initializer"} and by_service["web"]["state"] == "running" and by_service["web"]["health"] == "healthy" and by_service["initializer"]["state"] == "exited" and by_service["initializer"]["exit"] == 0:
                web = by_service["web"]["id"]
                network = self.bench.json_docker("container", "inspect", web, "--format", '{{with (index .NetworkSettings.Networks "hack-dev")}}{{json .IPAddress}}{{else}}null{{end}}')
                if self.bench.active_routes(self.hostname) == [f"{network}:3000"]:
                    value = self.request()
                    return value, rows
            time.sleep(0.25)
        raise Failure("Common readiness did not complete; sample remains failed")

    def observe_semantics(self, rows):
        result = {}
        for row in rows:
            actual = self.bench.json_docker("container", "inspect", row["id"], "--format", SEMANTICS)
            result[row["service"]] = semantic_projection(actual)
            mounts = actual["mounts"]
            data = [mount.get("Name") for mount in mounts if mount.get("Type") == "volume" and mount.get("Destination") == "/data"]
            if len(data) != 1 or not isinstance(data[0], str):
                raise Failure("Exact persistent fixture volume unavailable")
            if self.volume is not None and self.volume != data[0]:
                raise Failure("Persistent fixture volume changed")
            self.volume = data[0]
        created = self.bench.json_docker("volume", "inspect", self.volume, "--format", "{{json .CreatedAt}}")
        if self.volume_created is not None and self.volume_created != created:
            raise Failure("Persistent volume was replaced")
        self.volume_created = created
        if self.semantics is not None:
            require_matched(self.semantics, result)
        self.semantics = result

    def down_verified(self):
        if self.rows():
            raise Failure("Down left workload containers; claims/data cannot be retired")
        if self.bench.active_routes(self.hostname):
            raise Failure("Down left an active proxy route")
        networks = self.bench.docker("network", "ls", "--filter", f"label={PROJECT}={self.project}", "--format", "{{.ID}}").split()
        if networks:
            raise Failure("Down left fixture networks")
        if self.volume is not None:
            created = self.bench.json_docker("volume", "inspect", self.volume, "--format", "{{json .CreatedAt}}")
            if created != self.volume_created:
                raise Failure("Down changed retained storage")

    def step(self, action):
        if action == "up" and self.bench.active_routes(self.hostname):
            raise Failure("Foreign origin collision; no launch is authorized")
        if self.project is not None and action in ("up", "restart", "down"):
            self.rows()
            self.assert_resource_ownership()
        argv = {"up": ["up", "--detach", "--json"], "ps": ["ps", "--json"],
                "exec": ["exec", "web", "--", "bun", "-e", 'console.log(await Bun.file("/data/marker").text())'],
                "restart": ["restart", "--json"], "down": ["down", "--json"]}[action]
        if action == "up":
            self.started = True
        observed = self.cli(*argv)
        if action in ("up", "restart"):
            value, rows = self.ready()
            if action == "restart" and value["boot"] == self.boot:
                raise Failure("Restart did not replace the app process")
            self.boot = value["boot"]
            if value["marker"] is None:
                self.request(write=True)
            self.observe_semantics(rows)
        elif action == "exec":
            if observed["stdout"].strip() != self.marker:
                raise Failure("Timed exec did not read retained data")
            self.request()
        elif action == "ps":
            payload = json.loads(observed["stdout"])
            require_ps(payload, self.lane, self.project)
            self.ready()
        else:
            self.down_verified()
        return {"wall_s": observed["wall_s"], "cli_cpu_s": observed["cli_cpu_s"],
                "child_maxrss_bytes": observed["child_maxrss_bytes"], "ready_wall_s": time.monotonic() - observed["started_monotonic"]}

    def cleanup(self):
        if not self.started:
            return
        if self.bench.uncertain:
            raise Failure("Interrupted engine child: retain fixture and claims for explicit recovery")
        # No fallback kill/prune: failed CLI recovery or ambiguous ownership keeps
        # exact fixture and private records for explicit investigation.
        self.rows()
        self.assert_resource_ownership()
        self.cli("down", *( ["--recover"] if self.lane == "native" else []), "--json")
        self.down_verified()
        if self.volume is not None:
            label = NATIVE_OWNER if self.lane == "native" else OWNER
            actual = self.bench.json_docker("volume", "inspect", self.volume, "--format",
                '{"name":{{json .Name}},"created":{{json .CreatedAt}},"project":{{json (index .Labels "com.docker.compose.project")}},"owner":{{json (index .Labels "' + label + '")}}}')
            if actual != {"name": self.volume, "created": self.volume_created, "project": self.project, "owner": self.owner}:
                raise Failure("Final disposable volume ownership changed; preserve it")
            self.check_root()
            require_matched(self.bench.proxy, self.bench.proxy_binding())
            self.bench.docker("volume", "rm", self.volume)
        names = self.bench.docker("volume", "ls", "--filter", f"label={PROJECT}={self.project}", "--format", "{{.Name}}").split()
        if names:
            raise Failure("Final cleanup left volume references; preserve unknown storage")


def execute(args):
    bench = Benchmark(args)
    fixtures = []
    bench.preflight()
    failure = None
    try:
        for size in GATES["cohorts"]:
            hosts = [f"nc03-{secrets.token_hex(16)}.benchmark.invalid" for _ in range(size)]
            cohort = {lane: [Fixture(bench, lane, index, host) for index, host in enumerate(hosts)]
                      for lane in ("legacy", "native")}
            fixtures.extend(fixture for lane in cohort.values() for fixture in lane)
            # One untimed complete cycle warms images/data/CLI paths. Its correctness
            # and cleanup are mandatory; cold image/download cost is never mixed in.
            for lane in paired_order(0):
                for fixture in cohort[lane]:
                    fixture.step("up")
                for fixture in cohort[lane]:
                    fixture.step("down")
            for left, right in zip(cohort["legacy"], cohort["native"]):
                require_matched(left.semantics, right.semantics)
            for index in range(GATES["rounds"]):
                for lane in paired_order(index):
                    for action in ACTIONS:
                        with Admission(bench.env, bench.root) as admission:
                            cells = [fixture.step(action) for fixture in cohort[lane]]
                        bench.assert_frozen()
                        row = {"cohort": size, "round": index, "lane": lane, "action": action,
                               "ok": True, "admitted": admission.admitted(), "noise": admission.samples,
                               **{metric: sum(cell[metric] for cell in cells) for metric in ("wall_s", "ready_wall_s", "cli_cpu_s")},
                               "per_project": cells}
                        bench.records.append(row)
                        bench.persist()
                    for left, right in zip(cohort["legacy"], cohort["native"]):
                        require_matched(left.semantics, right.semantics)
    except (Failure, OSError, ValueError, KeyError) as error:
        failure = type(error).__name__
        bench.metadata["failure"] = failure
    finally:
        cleanup = []
        for fixture in fixtures:
            try:
                fixture.cleanup()
                cleanup.append({"lane": fixture.lane, "project": fixture.name, "ok": True})
            except (Failure, OSError, ValueError, KeyError) as error:
                cleanup.append({"lane": fixture.lane, "project": fixture.name, "ok": False, "reason": type(error).__name__})
        bench.metadata["cleanup"] = cleanup
        bench.persist()
    result = summary(bench.records)
    result["qualified"] &= failure is None and all(row["ok"] for row in cleanup)
    with open(bench.root / "summary.json", "x") as file:
        os.chmod(file.name, 0o600)
        json.dump(result, file, indent=2)
    return 0 if result["qualified"] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--exclusive-docker-slot", action="store_true")
    parser.add_argument("--cli")
    parser.add_argument("--compiler")
    parser.add_argument("--cli-sha256")
    parser.add_argument("--compiler-sha256")
    parser.add_argument("--qualified-source-sha")
    parser.add_argument("--output-root")
    parser.add_argument("--image", default="oven/bun:1.4.2-slim")
    parser.add_argument("--proxy-fixture-receipt", help="private qualified no-port proxy receipt; setup is separate from this run")
    args = parser.parse_args()
    if not args.run:
        print(json.dumps({"preview": True, "gates": GATES, "actions": ACTIONS,
            "cohort": "sequential lanes, up to two active projects, web + initializer each",
            "routing": "same per-pair HTTP origin through existing proxy; no DNS/trust/global configuration changes",
            "proxy_mode": "explicit qualified no-port fixture receipt" if args.proxy_fixture_receipt else "existing proxy host port 80",
            "prerequisites": ["frozen qualified CLI/compiler", "cached exact image", "existing proxy with curl",
                              "exclusive Docker slot", "new output root under private non-Git parent"],
            "not_measured": ["container CPU", "shared VM CPU/memory", "app-wide throughput", "cold installs"]}, indent=2))
        return 0
    required = (args.cli, args.compiler, args.cli_sha256, args.compiler_sha256, args.qualified_source_sha, args.output_root)
    if not all(required) or not args.exclusive_docker_slot:
        parser.error("--run requires frozen binary/source fingerprints, a private output root and --exclusive-docker-slot")
    if not SHA.fullmatch(args.qualified_source_sha) or not all(OBJECT_ID.fullmatch(value) for value in (args.cli_sha256, args.compiler_sha256)):
        parser.error("fingerprints must be exact SHA-1 source / SHA-256 executables")
    if not all(Path(value).is_absolute() for value in (args.cli, args.compiler, args.output_root)):
        parser.error("executable/output paths must be absolute")
    if args.proxy_fixture_receipt and not Path(args.proxy_fixture_receipt).is_absolute():
        parser.error("proxy fixture receipt path must be absolute")
    try:
        return execute(args)
    except (Failure, OSError, ValueError, KeyError):
        print("Benchmark refused; review prerequisites/private evidence. No result qualifies.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
