#!/usr/bin/env python3
"""Matched fresh-pool startup: stock disk templates versus an independently verified prepared base.

Preview-first: without --run this prints the plan and changes nothing. Every trial owns a fresh
private candidate home under --root and must reach real service readiness (a healthy graph
service whose volume token reads back) before its timing counts. Trials then stop their pool and
remove only the directories and provider aliases they created, with a readback.

Modes:
  pairs       alternating stock/prepared fresh pools: create-to-ready, service-ready, restart,
              restore and persistent readback (the prepared base only changes pool creation).
  cohort      N registered graphs in ONE shared pool per lane (N from --cohorts), started with
              bounded parallelism; distinct per-graph data. Normal source-mounted worktree
              startup is the `worktrees` mode.
  concurrent  K pools created at once from one base; distinct identities and data.
  worktrees   N real linked Git worktrees of one harness-owned repository (N from --worktrees),
              each on its own branch and exactly shared with its own fresh pool, because a pool
              cannot add a different source root. Each graph serves its worktree through the
              share. The mode checks pool, namespace, data and live-source isolation, then
              restarts every pool and requires its data and source back.

Timing admission is observed at the start and end of each trial's timed work and every
--admission-interval seconds in between. A sample is flagged when build tools run, the 1-minute
load exceeds half the CPU count, memory pressure is raised, or any of those could not be observed
at any of those points; a failed observation or an unobserved gap also flags it. Flagged samples are kept and
summarized separately. Resource metrics keep unobserved values as null, report coverage and
are labeled unqualified when incomplete.
"""
import argparse
import base64
import concurrent.futures
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import statistics
import subprocess
import tempfile
import threading
import time

BUILD_TOOLS = re.compile(r"^(cargo|rustc|clang|clang\+\+|ld|ld64|zig|swift-frontend|swiftc|xcodebuild|cc1|cc1plus)$")
COMPOSE = """services:
  web:
    image: {image_id}
    restart: "no"
    network_mode: none
    command:
      - sh
      - -c
      - test -s /data/token || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \\n' > /data/token; exec httpd -f -p 8080 -h /data
    volumes:
      - data:/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/token"]
      interval: 1s
      timeout: 2s
      retries: 30
volumes:
  data: {{}}
"""
TOKEN = re.compile(r"^[0-9a-f]{32}$")
# The committed fixture compose names no pullable image; each worktree's copy is rewritten
# with the ensured image ID before planning.
WORKTREE_COMPOSE = """services:
  web:
    image: {image_id}
    restart: "no"
    network_mode: none
    command:
      - sh
      - -c
      - test -s /data/token || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \\n' > /data/token; exec httpd -f -p 8080 -h /workspace
    volumes:
      - .:/workspace
      - data:/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/branch.txt"]
      interval: 1s
      timeout: 2s
      retries: 30
volumes:
  data: {{}}
"""
PLACEHOLDER_IMAGE = "sha256:" + "0" * 64
# Configured guest maxima per pool, from Profile::memory_mib and Profile::cpus in
# packages/runtime-core/src/provider/profile.rs; plan metadata, not measured use. A project
# share requires `development`.
GUEST_MEMORY_MIB = {"research": 2048, "development": 6144}
GUEST_CPUS = {"research": 2, "development": 4}
# The runtime refuses project shares below these components (a Codex worktree only at its
# exact registered path), so fixture roots must avoid them.
SENSITIVE_COMPONENTS = {".codex", ".aws", ".ssh", ".gnupg", ".config"}


class Failure(RuntimeError):
    pass


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def command(argv, timeout):
    """Run one command; return (exit, parsed JSON or text, wall seconds, CPU seconds of its tree)."""
    with tempfile.TemporaryFile() as out:
        started = time.monotonic()
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT)
        timer = threading.Timer(timeout, process.kill)
        timer.start()
        try:
            # wait4 reports this child's own tree, so concurrent commands stay separable.
            _, status, usage = os.wait4(process.pid, 0)
        finally:
            timer.cancel()
        process.returncode = os.waitstatus_to_exitcode(status)
        wall = time.monotonic() - started
        out.seek(0)
        text = out.read().decode(errors="replace")
    try:
        body = json.loads(text)
    except ValueError:
        body = {"raw": text[-2000:]}
    return process.returncode, body, wall, usage.ru_utime + usage.ru_stime


class Libc:
    """Clone-aware private bytes and lifetime peak footprint (macOS)."""

    def __init__(self):
        self.lib = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)

    def private_bytes(self, path):
        # getattrlist(ATTR_CMNEXT_PRIVATESIZE): bytes of this file not shared with any clone.
        # struct attrlist: bitmapcount=5, then common/vol/dir/file/fork masks; the fork slot
        # carries common-extended attributes under FSOPT_ATTR_CMN_EXTENDED.
        request = ctypes.create_string_buffer(
            (5).to_bytes(2, "little") + bytes(18) + (0x8).to_bytes(4, "little"), 24
        )
        out = ctypes.create_string_buffer(64)
        getattrlist = self.lib.getattrlist
        getattrlist.argtypes = [ctypes.c_char_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32]
        if getattrlist(str(path).encode(), request, out, 64, 0x1 | 0x20) != 0:
            return None
        return int.from_bytes(out.raw[4:12], "little", signed=True)

    def peak_footprint(self, pid):
        # proc_pid_rusage(RUSAGE_INFO_V4): ri_lifetime_max_phys_footprint at byte offset 240.
        buffer = ctypes.create_string_buffer(512)
        if self.lib.proc_pid_rusage(ctypes.c_int(pid), ctypes.c_int(4), buffer) != 0:
            return None
        return int.from_bytes(buffer.raw[240:248], "little")


def allocated(root):
    total = 0
    for directory, _, files in os.walk(root):
        for name in files:
            try:
                total += os.lstat(os.path.join(directory, name)).st_blocks * 512
            except FileNotFoundError:
                pass
    return total


def git(*argv):
    """Run Git without system or global configuration, templates, hooks or signing."""
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/"),
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "LC_ALL": "C"}
    result = subprocess.run(
        ["git", "-c", "init.templateDir=", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
         "-c", "user.name=Hack benchmark", "-c", "user.email=benchmark@example.invalid", *argv],
        env=env, capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        raise Failure(f"git {' '.join(argv)[:160]}: {result.stderr.strip()[-300:]}")
    return result.stdout.strip()


class Worktrees:
    """A harness-owned repository with `count` linked worktrees. Each is an ordinary
    `git worktree add` checkout on its own branch with a committed random marker; all share one
    common Git directory, and only each exact worktree root is shared with its own pool."""

    def __init__(self, root, count):
        self.dir = Path(root).resolve() / f"worktrees{count:02d}-{secrets.token_hex(3)}"
        self.repo = self.dir / "repo"
        self.count = count
        self.entries = []

    def create(self):
        self.dir.mkdir(mode=0o700)
        git("init", "--quiet", "--initial-branch=main", str(self.repo))
        (self.repo / "compose.yaml").write_text(WORKTREE_COMPOSE.format(image_id=PLACEHOLDER_IMAGE))
        git("-C", str(self.repo), "add", "compose.yaml")
        git("-C", str(self.repo), "commit", "--quiet", "-m", "fixture")
        for index in range(self.count):
            root, branch, marker = self.dir / f"w{index:02d}", f"wt-{index:02d}", secrets.token_hex(16)
            git("-C", str(self.repo), "worktree", "add", "--quiet", "-b", branch, str(root), "main")
            # The runtime refuses a share that other users can write.
            root.chmod(0o700)
            (root / "branch.txt").write_text(marker)
            git("-C", str(root), "add", "branch.txt")
            git("-C", str(root), "commit", "--quiet", "-m", branch)
            self.entries.append({"root": root, "branch": branch, "marker": marker,
                                 "head": git("-C", str(root), "rev-parse", "HEAD")})
        return self.entries

    def provenance(self):
        """Git's own view of the fixture: registered roots and branches, distinct heads, and the
        number of common directories (one for real linked worktrees)."""
        registered, current = {}, None
        for line in git("-C", str(self.repo), "worktree", "list", "--porcelain").splitlines():
            if line.startswith("worktree "):
                current = line[len("worktree "):]
            elif line.startswith("branch refs/heads/") and current:
                registered[current] = line[len("branch refs/heads/"):]
        common = {git("-C", str(e["root"]), "rev-parse", "--path-format=absolute", "--git-common-dir")
                  for e in self.entries}
        return {
            "registered": sum(registered.get(str(e["root"])) == e["branch"] for e in self.entries),
            "roots": len({str(e["root"]) for e in self.entries}),
            "branches": len({e["branch"] for e in self.entries}),
            "heads": len({e["head"] for e in self.entries}),
            "common_dirs": len(common),
            "checkout_allocated_bytes": allocated(self.dir),
        }

    def cleanup(self):
        """Remove the fixture once no process references it (its pools must be down)."""
        if not self.dir.exists():
            return {"removed": True, "created": False}
        listing = subprocess.run(["ps", "-A", "-ww", "-o", "pid=,args="], capture_output=True, text=True)
        if listing.returncode != 0 or str(self.dir) in listing.stdout:
            return {"error": "a process may still reference this fixture"}
        shutil.rmtree(self.dir)
        return {"removed": not self.dir.exists()}


def each(function, count, workers):
    """Call `function(i)` for every index with bounded parallelism. Every call settles before the
    first failure is raised, so cleanup never races a start still in flight."""
    results, errors = [None] * count, []
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(function, index): index for index in range(count)}
        for future in concurrent.futures.as_completed(futures):
            try:
                results[futures[future]] = future.result()
            except Failure as error:
                errors.append((futures[future], str(error)))
    if errors:
        raise Failure("; ".join(f"{index}: {error}" for index, error in sorted(errors))[:1500])
    return results


SEEN_BASES, SEEN_LOCK = set(), threading.Lock()


def provenance(body, lane, start):
    """Where a pool's first-start disks came from, and whether this start created the pool
    (`cold`) or restarted a retained one (`warm`). Host caches are never purged, so `base_use`
    says only whether this harness process had cloned the same base before."""
    prepared = body.get("prepared_base") or {}
    selection = prepared.get("selection") or {}
    base = selection.get("base_id")
    use = None
    if start == "cold" and base:
        with SEEN_LOCK:
            use = "repeat-in-run" if base in SEEN_BASES else "first-in-run"
            SEEN_BASES.add(base)
    return {"start": start, "lane": lane, "source": selection.get("source") or "stock", "base_id": base,
            "reason": selection.get("reason"), "activation": prepared.get("activation"), "base_use": use}


def admission_from(load, names, pressure, cpus):
    """Admission from one host observation. `None` marks an input that could not be observed;
    any unobserved input or failed condition flags the sample with its reason (fail closed)."""
    reasons = []
    if load is None:
        reasons.append("load_unobserved")
    elif load > cpus / 2:
        reasons.append("load_high")
    tools = []
    if names is None:
        reasons.append("processes_unobserved")
    else:
        tools = sorted({Path(n.strip()).name for n in names if BUILD_TOOLS.match(Path(n.strip()).name or "")})
        if tools:
            reasons.append("build_tools")
    if not pressure:
        reasons.append("pressure_unobserved")
    elif pressure != "1":
        reasons.append("memory_pressure")
    return {"load1": None if load is None else round(load, 2), "build_tools": tools,
            "memory_pressure": pressure, "reasons": reasons, "admitted": not reasons}


def admission():
    try:
        load = os.getloadavg()[0]
    except OSError:
        load = None
    listing = subprocess.run(["ps", "-axo", "comm="], capture_output=True, text=True)
    names = listing.stdout.split("\n") if listing.returncode == 0 and listing.stdout.strip() else None
    level = subprocess.run(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"], capture_output=True, text=True)
    pressure = level.stdout.strip() if level.returncode == 0 else None
    return admission_from(load, names, pressure, os.cpu_count() or 1)


def admitted(record, cpus):
    """(admitted, reasons, boundary) for a record. Records written before admission carried
    reasons are re-evaluated from their recorded fields; their process listing's exit status was
    not recorded, so that limitation is named rather than assumed."""
    reasons, legacy = [], False
    for key, label in (("admission", "start"), ("admission_during", "during"), ("admission_end", "end")):
        observed = record.get(key)
        if observed is None:
            if key == "admission":
                reasons.append("start:unobserved")
            continue
        if "reasons" not in observed:
            legacy = True
            observed = admission_from(observed.get("load1"), observed.get("build_tools"), observed.get("memory_pressure"), cpus)
        reasons += [f"{label}:{reason}" for reason in observed["reasons"]]
    if record.get("admission_during") is not None:
        boundary = "continuous"
    else:
        boundary = "start-and-end" if record.get("admission_end") is not None else "start-only"
    if legacy:
        boundary += " (legacy: process listing status unrecorded)"
    return not reasons, reasons, boundary


class Sampler:
    """Admission observed every `interval` seconds while a trial's timed work runs. Its own cost
    is one process listing and one sysctl per sample.

    It fails closed: an observation that raises becomes an `observer_failed` sample, and a gap
    longer than `GAP_INTERVALS` intervals between samples (or before the first, or after the last
    until stop) is reported as `sampling_gap`, since load during that gap was not observed."""

    GAP_INTERVALS = 5

    def __init__(self, interval, observe=None, clock=time.monotonic):
        self.interval, self.observe, self.clock = interval, observe or admission, clock
        self.samples, self.times = [], []
        self.started = self.stopped = None
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.started = self.clock()
        self._thread.start()
        return self

    def _run(self):
        while True:
            try:
                sample = self.observe()
            except Exception:  # noqa: BLE001 - any observer failure must flag, not end sampling.
                sample = {"reasons": ["observer_failed"], "load1": None}
            self.samples.append(sample)
            self.times.append(self.clock())
            if self._stop.wait(self.interval):
                return

    def stop(self):
        self._stop.set()
        self._thread.join()
        self.stopped = self.clock()
        return self.result()

    def result(self):
        reasons = {reason for sample in self.samples for reason in sample["reasons"]}
        if not self.samples:
            reasons.add("unobserved")
        edges = [t for t in (self.started, *self.times, self.stopped) if t is not None]
        gaps = [later - earlier for earlier, later in zip(edges, edges[1:])]
        if gaps and max(gaps) > self.GAP_INTERVALS * self.interval:
            reasons.add("sampling_gap")
        loads = [sample["load1"] for sample in self.samples if sample["load1"] is not None]
        return {"samples": len(self.samples), "interval_s": self.interval, "reasons": sorted(reasons),
                "max_gap_s": round(max(gaps), 3) if gaps else None,
                "max_load1": max(loads) if loads else None, "admitted": not reasons}


class Trial:
    """One private candidate home and the projects it serves."""

    def __init__(self, args, label):
        self.args = args
        self.dir = Path(args.root, f"{label}-{secrets.token_hex(3)}")
        self.home = self.dir / "home"
        self.samples = {}

    def cli(self, *argv, timeout=300, json_output=True):
        argv = list(argv)
        if json_output:
            # Options precede a `--` program separator.
            argv.insert(argv.index("--") if "--" in argv else len(argv), "--json")
        return command([self.args.bundle, "--candidate-root", str(self.home), *argv], timeout)

    def step(self, name, *argv, timeout=300, check=None, json_output=True):
        """Run one timed command. Graph operations in one pool serialize on the provider lock and
        refuse with `provider_busy` rather than wait, so a refused attempt is retried and counted;
        the sample spans every attempt."""
        started, cpu, retries = time.monotonic(), 0.0, 0
        while True:
            code, body, _, attempt_cpu = self.cli(*argv, timeout=timeout, json_output=json_output)
            cpu += attempt_cpu
            if body.get("code") != "provider_busy" or time.monotonic() - started > timeout:
                break
            retries += 1
            time.sleep(0.2)
        self.samples[name] = {"wall_s": round(time.monotonic() - started, 3), "cli_cpu_s": round(cpu, 3), "busy_retries": retries}
        if code != 0 or (check and not check(body)):
            raise Failure(f"{name}: exit {code}: {json.dumps(body)[:400]}")
        return body

    def setup(self):
        self.dir.mkdir(mode=0o700)
        self.home.mkdir(mode=0o700)
        (self.dir / "projects").mkdir(mode=0o700)
        for name, argv in (
            ("prepare", ["runtime", "prepare", "--archive", self.args.provider_archive]),
            ("prepare_engine", ["runtime", "prepare-engine", "--archive", self.args.engine_archive]),
            ("prepare_network_tools", ["runtime", "prepare-network-tools", "--directory", self.args.network_tools]),
        ):
            self.step(f"setup_{name}", *argv, json_output=False)

    def up(self, name, lane, share=None):
        argv = ["runtime", "up", "--profile", self.args.profile]
        if share:
            argv += ["--project-share", str(share), "--unfiltered-source"]
        if lane == "prepared":
            argv += ["--prepared-base", "require", "--prepared-base-store", self.args.store]
        body = self.step(name, *argv, timeout=600, check=lambda b: b.get("phase") == "running")
        selection = (body.get("prepared_base") or {}).get("selection") or {}
        if lane == "prepared" and name == "up" and (selection.get("source") != "prepared" or (body.get("prepared_base") or {}).get("activation") != "consumed"):
            raise Failure(f"prepared lane did not start from the base: {body.get('prepared_base')}")
        if lane == "stock" and body.get("prepared_base"):
            raise Failure("stock lane recorded a prepared-base selection")
        self.samples[name].update(self.provider(body))
        return body

    def provider(self, body):
        resources = (body.get("provider_resources") or {}).get("processes") or []
        binary = str(self.home / ".hack-local/providers")
        own = [p for p in resources if str(p["identity"]["executable"]).startswith(binary)]
        if not own:
            return {}
        cpu = sum(p["user_cpu_nanoseconds"] + p["system_cpu_nanoseconds"] for p in own) / 1e9
        peak = Libc().peak_footprint(own[0]["identity"]["pid"])
        memory = body.get("guest_memory_mib")
        # Resident size and physical footprint are measured; the guest's configured maximum is
        # not. They are reported side by side, never added together.
        return {
            "vm_identity": [own[0]["identity"]["pid"], own[0]["identity"]["start_micros"]],
            "vm_cpu_s": round(cpu, 3),
            "vm_resident_bytes": sum(p["resident_bytes"] for p in own),
            "vm_footprint_bytes": sum(p["physical_footprint_bytes"] for p in own),
            "vm_peak_footprint_bytes": peak,
            "guest_memory_configured_bytes": None if memory is None else memory << 20,
        }

    def disks(self):
        # The pool's provider HOME holds each machine's disks under SmolVM's cache directory.
        vms = self.home.joinpath(".hack-local", "run", "smolvm", "home", "Library", "Caches", "smolvm", "vms")
        disks = sorted(vms.glob("*/*.raw"))
        # macOS-only; loaded only when there are disks to measure.
        libc = Libc() if disks else None
        result = {}
        for disk in disks:
            stat = disk.stat()
            result[disk.name] = {"logical": stat.st_size, "allocated": stat.st_blocks * 512, "private": libc.private_bytes(disk)}
        return result

    def project(self, index, image_id):
        project = self.dir / "projects" / f"g{index}"
        project.mkdir(mode=0o700)
        (project / "compose.yaml").write_text(COMPOSE.format(image_id=image_id))
        return project

    def graph(self, project, prefix, branch=None, shared_source=False):
        compose = str(project / "compose.yaml")
        selector = ["--branch", branch] if branch else []
        plan = self.step(f"{prefix}plan", "project", "plan", "--project", str(project), *selector, "--file", compose)
        run = secrets.token_hex(16)
        self.step(
            f"{prefix}run", "graph", "run", "--project", str(project), *selector, "--file", compose,
            "--expect-plan", plan["plan_id"], "--run-id", run, *(["--shared-source"] if shared_source else []),
            "--ready", "web=healthy", "--timeout-seconds", "120", timeout=180,
            check=lambda b: (b.get("readiness") or {}).get("web") == "healthy",
        )
        return {"project": project, "compose": compose, "plan": plan["plan_id"],
                "namespace": (plan.get("plan") or {}).get("namespace"), "run": run,
                "token": self.token(run, f"{prefix}token")}

    def read(self, run, path, name):
        body = self.step(name, "graph", "exec", "--run-id", run, "--service", "web", "--", "/bin/cat", path)
        return base64.b64decode(body.get("stdout_base64") or "").decode()

    def token(self, run, name):
        value = self.read(run, "/data/token", name)
        if not TOKEN.match(value):
            raise Failure(f"{name}: unexpected token {value!r}")
        return value

    def status(self):
        code, body, _, _ = self.cli("runtime", "status")
        return body if code == 0 else {}

    def cleanup(self):
        """Stop this home's pool and remove only this trial's directory and provider alias."""
        result = {}
        if not self.dir.exists():
            return {"removed": True, "created": False}
        try:
            owner = json.loads((self.home / ".hack-local/run/smolvm/owner.json").read_text())
            alias = Path(owner["short_home"])
        except (OSError, ValueError, KeyError):
            alias = None
        if self.home.exists():
            code, body, _, _ = self.cli("runtime", "down", timeout=300)
            result["down"] = body.get("phase") or body.get("code")
            if code != 0:
                result["error"] = f"down failed: {json.dumps(body)[:300]}"
                return result
        running = subprocess.run(["ps", "-axww", "-o", "pid=,command="], capture_output=True, text=True).stdout
        if str(self.dir) in running:
            result["error"] = "a process still references this trial"
            return result
        result["allocated_after_down"] = allocated(self.dir)
        shutil.rmtree(self.dir)
        if alias and alias.is_symlink() and os.readlink(alias).startswith(str(self.dir) + "/"):
            alias.unlink()
        result["removed"] = not self.dir.exists() and not (alias and os.path.lexists(alias))
        return result


def pair_trial(args, index, lane):
    trial = Trial(args, f"pair{index:02d}-{lane}")
    record = {"mode": "pairs", "index": index, "lane": lane, "home": str(trial.dir)}
    sampler = None
    try:
        trial.setup()
        record["admission"] = admission()
        sampler = Sampler(args.admission_interval).start()
        trial.up("up", lane)
        record["disks_at_ready"] = trial.disks()
        image = trial.step("ensure_image", "runtime", "ensure-image", "--reference", args.image, timeout=600)
        graph = trial.graph(trial.project(0, image["image_id"]), "")
        record["service_ready_s"] = round(sum(trial.samples[k]["wall_s"] for k in ("up", "ensure_image", "plan", "run", "token")), 3)
        status = trial.status()
        record["after_service"] = trial.provider(status)
        trial.step("graph_cleanup", "graph", "cleanup", "--run-id", graph["run"])
        trial.step("down", "runtime", "down")
        trial.up("restart_up", lane)
        trial.step(
            "restore", "graph", "restore", "--project", str(graph["project"]), "--file", graph["compose"],
            "--expect-plan", graph["plan"], "--run-id", graph["run"], "--ready", "web=healthy",
            "--timeout-seconds", "120", timeout=180,
        )
        if trial.token(graph["run"], "restore_token") != graph["token"]:
            raise Failure("persistent token changed across restart")
        record["token_sha256"] = hashlib.sha256(graph["token"].encode()).hexdigest()[:16]
        record["admission_end"] = admission()
        record["ok"] = True
    except Failure as error:
        record["ok"] = False
        record["error"] = str(error)
    finally:
        if sampler:
            record["admission_during"] = sampler.stop()
        record["samples"] = trial.samples
        record["cleanup"] = trial.cleanup()
    return record


def cohort_trial(args, size, repeat, lane):
    trial = Trial(args, f"cohort{size:02d}r{repeat}-{lane}")
    record = {"mode": "cohort", "size": size, "repeat": repeat, "lane": lane, "home": str(trial.dir)}
    sampler = None
    try:
        trial.setup()
        record["admission"] = admission()
        sampler = Sampler(args.admission_interval).start()
        started = time.monotonic()
        trial.up("up", lane)
        image = trial.step("ensure_image", "runtime", "ensure-image", "--reference", args.image, timeout=600)
        projects = [trial.project(i, image["image_id"]) for i in range(size)]
        graphs, ready = [], []
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.parallel) as pool:
            futures = {pool.submit(trial.graph, project, f"g{i}_"): i for i, project in enumerate(projects)}
            for future in concurrent.futures.as_completed(futures):
                graphs.append(future.result())
                ready.append(round(time.monotonic() - started, 3))
        record["all_ready_s"] = round(time.monotonic() - started, 3)
        record["ready_offsets_s"] = sorted(ready)
        tokens = {g["token"] for g in graphs}
        if len(tokens) != size:
            raise Failure("graphs shared a data token")
        record["distinct_tokens"] = len(tokens)
        record["after_all_ready"] = trial.provider(trial.status())
        record["disks_at_ready"] = trial.disks()
        record["busy_retries"] = sum(v.get("busy_retries", 0) for v in trial.samples.values())
        record["admission_end"] = admission()
        record["ok"] = True
    except Failure as error:
        record["ok"] = False
        record["error"] = str(error)
    finally:
        if sampler:
            record["admission_during"] = sampler.stop()
        record["samples"] = trial.samples
        record["cleanup"] = trial.cleanup()
    return record


def concurrent_trial(args, count):
    trials = [Trial(args, f"concurrent{i}-prepared") for i in range(count)]
    record = {"mode": "concurrent", "count": count, "homes": [str(t.dir) for t in trials]}
    sampler = None
    try:
        for trial in trials:
            trial.setup()
        record["admission"] = admission()
        sampler = Sampler(args.admission_interval).start()
        with concurrent.futures.ThreadPoolExecutor(max_workers=count) as pool:
            bodies = list(pool.map(lambda t: t.up("up", "prepared"), trials))
        record["up_wall_s"] = [t.samples["up"]["wall_s"] for t in trials]
        machines = {b.get("machine") for b in bodies}
        boots = {b.get("guest_boot_id") for b in bodies}
        disks = [t.disks() for t in trials]
        image = trials[0].step("ensure_image", "runtime", "ensure-image", "--reference", args.image, timeout=600)
        for trial in trials[1:]:
            trial.step("ensure_image", "runtime", "ensure-image", "--reference", args.image, timeout=600)
        tokens = {trial.graph(trial.project(0, image["image_id"]), "")["token"] for trial in trials}
        if len(machines) != count or len(boots) != count or len(tokens) != count:
            raise Failure(f"identities collided: machines={len(machines)} boots={len(boots)} tokens={len(tokens)}")
        record["distinct"] = {"machines": len(machines), "guest_boots": len(boots), "tokens": len(tokens)}
        record["disk_private_bytes"] = [{k: v["private"] for k, v in d.items()} for d in disks]
        record["admission_end"] = admission()
        record["ok"] = True
    except Failure as error:
        record["ok"] = False
        record["error"] = str(error)
    finally:
        if sampler:
            record["admission_during"] = sampler.stop()
        record["samples"] = [t.samples for t in trials]
        record["cleanup"] = [t.cleanup() for t in trials]
    return record


def pool_resources(pools, statuses):
    """Cohort totals at one instant. A total is null when any pool's value is unobserved.
    `cli_cpu_s` covers every timed command so far (excluding setup); `vm_cpu_s` is each live
    VM process's CPU since it started."""
    vms = [pool.provider(status) for pool, status in zip(pools, statuses)]
    disks = [pool.disks() for pool in pools]
    cli = total(v.get("cli_cpu_s") for pool in pools for k, v in pool.samples.items() if not k.startswith("setup_"))
    vm = total(v.get("vm_cpu_s") for v in vms)
    return {
        "cli_cpu_s": cli,
        "vm_cpu_s": vm,
        "cpu_attributed_s": total([cli, vm]),
        "vm_resident_bytes": total(v.get("vm_resident_bytes") for v in vms),
        "vm_footprint_bytes": total(v.get("vm_footprint_bytes") for v in vms),
        # Lifetime peaks need not coincide, so their sum bounds the simultaneous peak from above.
        "vm_peak_footprint_sum_bytes": total(v.get("vm_peak_footprint_bytes") for v in vms),
        "guest_memory_configured_bytes": total(v.get("guest_memory_configured_bytes") for v in vms),
        "disk_allocated_bytes": total(total(d.get("allocated") for d in disk.values()) for disk in disks),
        "disk_private_bytes": total(total(d.get("private") for d in disk.values()) for disk in disks),
        # Everything under each home, VM disks included, so it overlaps the disk totals. Block
        # counts are not clone-aware; clone-private bytes are.
        "homes_allocated_bytes": total(allocated(pool.dir) for pool in pools),
        "vms": vms,
    }


def worktree_trial(args, size, repeat, lane):
    """`size` linked worktrees, each exactly shared with its own fresh pool in its own private
    home, started `--worktree-parallel` at a time. Setup (provider, engine and network tools
    per home) is untimed."""
    fixture = Worktrees(args.root, size)
    pools = [Trial(args, f"wt{size:02d}r{repeat}-{lane}-{index:02d}") for index in range(size)]
    record = {"mode": "worktrees", "size": size, "repeat": repeat, "lane": lane, "home": str(fixture.dir),
              "homes": [str(pool.dir) for pool in pools]}
    sampler = None
    try:
        entries = fixture.create()
        for pool in pools:
            pool.setup()
        record["admission"] = admission()
        sampler = Sampler(args.admission_interval).start()
        started = time.monotonic()

        def start(index):
            pool, entry = pools[index], entries[index]
            body = pool.up("up", lane, share=entry["root"])
            image = pool.step("ensure_image", "runtime", "ensure-image", "--reference", args.image, timeout=600)
            (entry["root"] / "compose.yaml").write_text(WORKTREE_COMPOSE.format(image_id=image["image_id"]))
            graph = pool.graph(entry["root"], "", branch=entry["branch"], shared_source=True)
            if pool.read(graph["run"], "/workspace/branch.txt", "marker") != entry["marker"]:
                raise Failure(f"worktree {index} did not serve its own committed marker")
            return {"graph": graph, "provenance": provenance(body, lane, "cold"),
                    "ready_s": round(time.monotonic() - started, 3)}

        ready = each(start, size, args.worktree_parallel)
        record["all_ready_s"] = round(time.monotonic() - started, 3)
        record["ready_offsets_s"] = sorted(r["ready_s"] for r in ready)
        record["provenance"] = [r["provenance"] for r in ready]
        statuses = [pool.status() for pool in pools]
        record["resources"] = pool_resources(pools, statuses)

        # A fresh host edit in every root must reach exactly its own pool.
        live = [secrets.token_hex(16) for _ in range(size)]
        for entry, value in zip(entries, live):
            (entry["root"] / "live.txt").write_text(value)
        seen = each(lambda i: pools[i].read(ready[i]["graph"]["run"], "/workspace/live.txt", "live"),
                    size, args.worktree_parallel)
        record["fixture"] = fixture.provenance()
        record["isolation"] = {
            "pools": len({(s["machine"], s["guest_boot_id"]) for s in statuses
                          if s.get("machine") and s.get("guest_boot_id")}),
            "namespaces": len({r["graph"]["namespace"] for r in ready}),
            "tokens": len({r["graph"]["token"] for r in ready}),
            "live_edits_read_back": sum(a == b for a, b in zip(seen, live)),
        }
        counts = {**record["isolation"], **{k: record["fixture"][k] for k in ("registered", "roots", "branches", "heads")}}
        if any(value != size for value in counts.values()) or record["fixture"]["common_dirs"] != 1:
            raise Failure(f"worktree isolation failed: {counts}, common_dirs={record['fixture']['common_dirs']}")

        # Warm: stop every pool, start it again and restore; data and source must come back.
        warm_started = time.monotonic()

        def retain(index):
            pool, entry, graph = pools[index], entries[index], ready[index]["graph"]
            pool.step("graph_cleanup", "graph", "cleanup", "--run-id", graph["run"])
            pool.step("down", "runtime", "down")
            body = pool.up("restart_up", lane, share=entry["root"])
            pool.step(
                "restore", "graph", "restore", "--project", str(entry["root"]), "--branch", entry["branch"],
                "--file", graph["compose"], "--expect-plan", graph["plan"], "--run-id", graph["run"],
                "--shared-source", "--ready", "web=healthy", "--timeout-seconds", "120", timeout=180,
            )
            kept = {"token": pool.token(graph["run"], "restore_token") == graph["token"],
                    "marker": pool.read(graph["run"], "/workspace/branch.txt", "restore_marker") == entry["marker"],
                    "live": pool.read(graph["run"], "/workspace/live.txt", "restore_live") == live[index]}
            if not all(kept.values()):
                raise Failure(f"worktree {index} did not retain data and source across down/up: {kept}")
            return {"provenance": provenance(body, lane, "warm"), "ready_s": round(time.monotonic() - warm_started, 3)}

        warm = each(retain, size, args.worktree_parallel)
        record["warm_all_ready_s"] = round(time.monotonic() - warm_started, 3)
        record["warm_provenance"] = [w["provenance"] for w in warm]
        record["retained"] = size
        record["admission_end"] = admission()
        record["ok"] = True
    except Failure as error:
        record["ok"] = False
        record["error"] = str(error)
    finally:
        if sampler:
            record["admission_during"] = sampler.stop()
        record["samples"] = [pool.samples for pool in pools]
        record["cleanup"] = [pool.cleanup() for pool in pools] + [fixture.cleanup()]
    return record


def stats(values):
    """Median/min/max over observed values. `of` counts every sample; a metric with any
    unobserved sample is labeled unqualified instead of treating the gap as zero."""
    observed = [v for v in values if v is not None]
    result = {"n": len(observed), "of": len(values), "qualified": bool(values) and len(observed) == len(values)}
    if observed:
        result.update(median=round(statistics.median(observed), 3), min=round(min(observed), 3), max=round(max(observed), 3))
    return result


def total(parts):
    """Sum of parts, or None when there are none or any part is unobserved."""
    parts = list(parts)
    return None if not parts or any(p is None for p in parts) else sum(parts)


def pair_metrics(r):
    up = r["samples"]["up"]
    after = r.get("after_service") or {}
    disks = (r.get("disks_at_ready") or {}).values()
    return {
        "up_wall_s": up["wall_s"],
        "up_cpu_s": total([up["cli_cpu_s"], up.get("vm_cpu_s")]),
        "service_ready_s": r["service_ready_s"],
        "restart_up_wall_s": r["samples"]["restart_up"]["wall_s"],
        "vm_footprint_after_service_bytes": after.get("vm_footprint_bytes"),
        "vm_peak_footprint_bytes": after.get("vm_peak_footprint_bytes", up.get("vm_peak_footprint_bytes")),
        "disk_allocated_bytes": total(d.get("allocated") for d in disks),
        "disk_private_bytes": total(d.get("private") for d in disks),
        "home_allocated_after_down_bytes": (r.get("cleanup") or {}).get("allocated_after_down"),
    }


def cohort_metrics(r):
    after = r.get("after_all_ready") or {}
    disks = (r.get("disks_at_ready") or {}).values()
    return {
        "all_ready_s": r["all_ready_s"],
        "up_wall_s": r["samples"]["up"]["wall_s"],
        "cli_cpu_s": total(v.get("cli_cpu_s") for k, v in r["samples"].items() if not k.startswith("setup_")),
        "vm_cpu_s": after.get("vm_cpu_s"),
        "vm_footprint_bytes": after.get("vm_footprint_bytes"),
        "vm_peak_footprint_bytes": after.get("vm_peak_footprint_bytes"),
        "disk_private_bytes": total(d.get("private") for d in disks),
    }


def median_of(samples, step):
    values = [s[step]["wall_s"] for s in samples if step in s]
    return round(statistics.median(values), 3) if values else None


def worktree_metrics(r):
    """Cold (`up`, create-to-ready) and warm (`restart_up`) starts stay separate; image
    acquisition into each fresh home is reported on its own."""
    resources = r.get("resources") or {}
    metrics = {
        "all_ready_s": r["all_ready_s"],
        "warm_all_ready_s": r.get("warm_all_ready_s"),
        "cold_up_median_s": median_of(r["samples"], "up"),
        "warm_up_median_s": median_of(r["samples"], "restart_up"),
        "image_median_s": median_of(r["samples"], "ensure_image"),
        "checkout_allocated_bytes": (r.get("fixture") or {}).get("checkout_allocated_bytes"),
    }
    for name in ("cpu_attributed_s", "cli_cpu_s", "vm_cpu_s", "vm_resident_bytes", "vm_footprint_bytes",
                 "vm_peak_footprint_sum_bytes", "guest_memory_configured_bytes", "disk_allocated_bytes",
                 "disk_private_bytes", "homes_allocated_bytes"):
        metrics[name] = resources.get(name)
    return metrics


def summarize(records, cpus=None):
    cpus = cpus or os.cpu_count() or 1
    summary = {"admission_boundaries": {}}
    classified = []
    for r in records:
        ok, reasons, boundary = admitted(r, cpus)
        summary["admission_boundaries"][boundary] = summary["admission_boundaries"].get(boundary, 0) + 1
        classified.append((r, ok, reasons))

    def lanes(chosen, metrics):
        return {
            lane: {name: stats([metrics(r)[name] for r in chosen if r["lane"] == lane])
                   for name in metrics(chosen[0]) } if any(r["lane"] == lane for r in chosen) else None
            for lane in ("stock", "prepared")
        } if chosen else None

    def paired(rs, key, metric):
        groups = {}
        for r, ok, _ in rs:
            groups.setdefault(key(r), {})[r["lane"]] = (r, ok)
        ratios = {}
        for group, pair in groups.items():
            if len(pair) == 2 and all(ok for _, ok in pair.values()):
                ratios.setdefault(group[0] if isinstance(group, tuple) else "all", []).append(
                    metric(pair["prepared"][0]) / metric(pair["stock"][0]))
        return {str(k): stats(v) for k, v in ratios.items()}

    pairs = [(r, ok, why) for r, ok, why in classified if r["mode"] == "pairs" and r.get("ok")]
    summary["pairs_admitted"] = lanes([r for r, ok, _ in pairs if ok], pair_metrics)
    summary["pairs_flagged"] = lanes([r for r, ok, _ in pairs if not ok], pair_metrics)
    summary["admitted_pair_ratios"] = {
        "up_wall": paired(pairs, lambda r: r["index"], lambda r: r["samples"]["up"]["wall_s"]).get("all"),
        "service_ready": paired(pairs, lambda r: r["index"], lambda r: r["service_ready_s"]).get("all"),
    }
    cohorts = [(r, ok, why) for r, ok, why in classified if r["mode"] == "cohort" and r.get("ok")]
    for admitted_flag, key in ((True, "cohorts_admitted"), (False, "cohorts_flagged")):
        chosen = [r for r, ok, _ in cohorts if ok == admitted_flag]
        summary[key] = {str(size): lanes([r for r in chosen if r["size"] == size], cohort_metrics)
                        for size in sorted({r["size"] for r in chosen})}
    summary["admitted_cohort_all_ready_ratio_by_size"] = paired(
        cohorts, lambda r: (r["size"], r["repeat"]), lambda r: r["all_ready_s"])
    worktrees = [(r, ok, why) for r, ok, why in classified if r["mode"] == "worktrees" and r.get("ok")]
    for admitted_flag, key in ((True, "worktrees_admitted"), (False, "worktrees_flagged")):
        chosen = [r for r, ok, _ in worktrees if ok == admitted_flag]
        summary[key] = {str(size): lanes([r for r in chosen if r["size"] == size], worktree_metrics)
                        for size in sorted({r["size"] for r in chosen})}
    summary["admitted_worktree_all_ready_ratio_by_size"] = paired(
        worktrees, lambda r: (r["size"], r["repeat"]), lambda r: r["all_ready_s"])
    selections = {}
    for r, _, _ in worktrees:
        for p in r.get("provenance", []) + r.get("warm_provenance", []):
            key = "/".join(str(p.get(k)) for k in ("lane", "start", "source", "base_use"))
            selections[key] = selections.get(key, 0) + 1
    summary["worktree_selections"] = dict(sorted(selections.items()))
    summary["concurrent"] = [
        {"count": r["count"], "ok": r.get("ok"), "admitted": ok, "reasons": why, "distinct": r.get("distinct"),
         "up_wall_s": r.get("up_wall_s"), "disk_private_bytes": r.get("disk_private_bytes")}
        for r, ok, why in classified if r["mode"] == "concurrent"
    ]
    summary["flag_reasons"] = sorted({reason for _, ok, why in classified for reason in why})
    summary["failures"] = [{k: r.get(k) for k in ("mode", "index", "size", "lane", "error")} for r in records if not r.get("ok")]
    summary["cleanup_failures"] = [r.get("home") or r.get("homes") for r in records if any("error" in c or not c.get("removed") for c in (r["cleanup"] if isinstance(r["cleanup"], list) else [r["cleanup"]]))]
    return summary


def worktree_plan(sizes, repeats, parallel, profile, host_memory):
    """Preview metadata for worktree cohorts. The configured guest maxima are not measured use and
    never block a run: the runtime's own admission decides each start, measured footprint is
    recorded per trial, and a refused start is recorded as the cohort's outcome."""
    peak = max(sizes)
    memory = peak * GUEST_MEMORY_MIB[profile] << 20
    plan = {"sizes": sizes, "repeats": repeats, "parallel": parallel, "peak_simultaneous_pools": peak,
            "peak_configured_guest_memory_bytes": memory, "peak_configured_guest_cpus": peak * GUEST_CPUS[profile],
            "host_memory_bytes": host_memory}
    if host_memory is not None and memory > host_memory:
        plan["warning"] = (f"{peak} pools configure {memory >> 30} GiB of guest memory, more than this host's "
                           f"{host_memory >> 30} GiB. These are maxima, not measured footprint; the runtime's "
                           "admission decides whether each start proceeds.")
    return plan


def load_samples(path):
    """(context, records) from a raw samples file; a trailing summary line is ignored."""
    context, records = {}, []
    for line in Path(path).read_text().splitlines():
        entry = json.loads(line)
        if "context" in entry:
            context = entry["context"]
        elif "summary" not in entry:
            records.append(entry)
    return context, records


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--summarize", metavar="SAMPLES", help="only summarize a raw samples file; runs nothing")
    parser.add_argument("--bundle", help="absolute hack-native executable")
    parser.add_argument("--root", help="absolute private (0700) directory for trial homes")
    parser.add_argument("--store", help="absolute store holding a verified base for these pins")
    parser.add_argument("--provider-archive")
    parser.add_argument("--engine-archive")
    parser.add_argument("--network-tools", help="directory of pinned network-tool packages")
    parser.add_argument("--image", help="pinned image reference (repository@sha256:...)")
    parser.add_argument("--profile", default="development", choices=("development", "research"))
    parser.add_argument("--mode", action="append", choices=("pairs", "cohort", "concurrent", "worktrees"),
                        help="repeatable; default pairs, cohort and concurrent")
    parser.add_argument("--pairs", type=int, default=5)
    parser.add_argument("--cohorts", default="1,8,32")
    parser.add_argument("--cohort-repeats", type=int, default=2)
    parser.add_argument("--parallel", type=int, default=4, help="concurrent graph start requests within one pool (they serialize)")
    parser.add_argument("--concurrent", type=int, default=4)
    parser.add_argument("--worktrees", default="1,8,32", help="worktree cohort sizes (one pool per worktree)")
    parser.add_argument("--worktree-repeats", type=int, default=1)
    parser.add_argument("--worktree-parallel", type=int, default=4, help="worktree pools started at once")
    parser.add_argument("--admission-interval", type=float, default=1.0, help="seconds between admission samples during timed work")
    parser.add_argument("--output", help="JSON lines of raw samples (default <root>/samples-<time>.jsonl)")
    parser.add_argument("--run", action="store_true", help="execute; without it only the plan is printed")
    args = parser.parse_args()
    if args.summarize:
        context, records = load_samples(args.summarize)
        print(json.dumps({"context": context, "summary": summarize(records, (context.get("host") or {}).get("cpus"))}, indent=2))
        return
    modes = args.mode or ["pairs", "cohort", "concurrent"]
    if not args.image:
        parser.error("--image is required")
    for name in ("bundle", "root", "store", "provider_archive", "engine_archive", "network_tools"):
        if not getattr(args, name) or not os.path.isabs(getattr(args, name)):
            parser.error(f"--{name.replace('_', '-')} must be absolute")
    sizes = [int(s) for s in args.cohorts.split(",") if s]
    worktree_sizes = [int(s) for s in args.worktrees.split(",") if s] if "worktrees" in modes else []
    if worktree_sizes and args.profile != "development":
        parser.error("worktree mode shares exact source roots, which requires --profile development")
    if any(n < 1 for n in worktree_sizes) or args.worktree_repeats < 1 or args.worktree_parallel < 1:
        parser.error("worktree sizes, repeats and parallelism must be positive")
    plan = {"modes": modes, "pairs": args.pairs, "cohorts": sizes, "cohort_repeats": args.cohort_repeats,
            "parallel": args.parallel, "concurrent": args.concurrent, "root": args.root,
            "admission_interval_s": args.admission_interval,
            "pools_created": (2 * args.pairs if "pairs" in modes else 0)
            + (2 * len(sizes) * args.cohort_repeats if "cohort" in modes else 0)
            + (args.concurrent if "concurrent" in modes else 0)
            + 2 * sum(worktree_sizes) * args.worktree_repeats}
    try:
        probe = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True)
    except OSError:
        probe = None
    host_memory = int(probe.stdout) if probe and probe.returncode == 0 and probe.stdout.strip().isdigit() else None
    if worktree_sizes:
        plan["worktrees"] = worktree_plan(worktree_sizes, args.worktree_repeats, args.worktree_parallel,
                                          args.profile, host_memory)
    if not args.run:
        print(json.dumps({"preview": plan}, indent=2))
        return
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        parser.error("native qualification requires macOS arm64")
    root = Path(args.root).resolve()
    args.root = str(root)
    if not root.is_dir() or root.stat().st_mode & 0o077 or root.stat().st_uid != os.geteuid():
        parser.error("--root must be an existing private (0700) directory owned by this user")
    if worktree_sizes and SENSITIVE_COMPONENTS & set(root.parts):
        parser.error(f"worktree mode needs a --root outside {sorted(SENSITIVE_COMPONENTS)} directories")
    output = Path(args.output or root / f"samples-{int(time.time())}.jsonl")
    context = {
        "harness_sha256": sha256(__file__), "bundle_sha256": sha256(args.bundle),
        "host": {"model": subprocess.run(["sysctl", "-n", "hw.model"], capture_output=True, text=True).stdout.strip(),
                 "cpus": os.cpu_count(), "memory_bytes": host_memory, "os": platform.mac_ver()[0]},
        "image": args.image, "profile": args.profile, "plan": plan,
        # Shared by every prepared pool; reported once, apart from per-pool private disk.
        "base_store_allocated_bytes": allocated(args.store),
    }
    records = []
    with output.open("a") as sink:
        sink.write(json.dumps({"context": context}) + "\n")

        def keep(record):
            records.append(record)
            sink.write(json.dumps(record) + "\n")
            sink.flush()
            print(json.dumps({k: record.get(k) for k in ("mode", "index", "size", "lane", "ok", "error")}), flush=True)

        if "pairs" in modes:
            for index in range(args.pairs):
                lanes = ("stock", "prepared") if index % 2 == 0 else ("prepared", "stock")
                for lane in lanes:
                    keep(pair_trial(args, index, lane))
        if "cohort" in modes:
            for repeat in range(args.cohort_repeats):
                for size in sizes:
                    lanes = ("stock", "prepared") if (repeat + size) % 2 == 0 else ("prepared", "stock")
                    for lane in lanes:
                        keep(cohort_trial(args, size, repeat, lane))
        if "concurrent" in modes:
            keep(concurrent_trial(args, args.concurrent))
        for repeat in range(args.worktree_repeats if worktree_sizes else 0):
            for size in worktree_sizes:
                lanes = ("stock", "prepared") if (repeat + size) % 2 == 0 else ("prepared", "stock")
                for lane in lanes:
                    keep(worktree_trial(args, size, repeat, lane))
        summary = summarize(records, context["host"]["cpus"])
        sink.write(json.dumps({"summary": summary}) + "\n")
    print(json.dumps({"output": str(output), "summary": summary}, indent=2))


if __name__ == "__main__":
    main()
