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
import math
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
# Host services named separately inside background CPU: macOS security assessment of new
# executables (XProtect, Gatekeeper, code-signing checks) and Spotlight indexing. A fresh home's
# provider and engine binaries are new executables and its files are new files, so a run can
# induce this work. Membership is by process name only: it shows which service used the CPU, not
# what it examined or why. Named services stay in background, so admission is unchanged.
HOST_SERVICES = {
    "security_scan": re.compile(r"^(XprotectService|XProtect[A-Za-z]*|xprotectd|syspolicyd|amfid)$"),
    "indexing": re.compile(r"^(mds|mds_stores|mdworker|mdworker_shared|mdsync)$"),
}
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


def healthy(body):
    """A run or restore receipt records the requested readiness goals; the command itself
    succeeds only once they hold. Both are required."""
    return (body.get("readiness") or {}).get("web") == "healthy"


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


OBSERVATION_TIMEOUT = 30


def observed_output(argv, timeout=None):
    """Stdout of a short host observation (`ps`, `sysctl`), or None when it failed or did not
    finish within `timeout` seconds (default OBSERVATION_TIMEOUT). A hung observation must never
    hold a trial, or its cleanup, forever; every caller treats None as unobserved and fails
    closed."""
    try:
        result = subprocess.run(argv, capture_output=True, text=True,
                                timeout=OBSERVATION_TIMEOUT if timeout is None else timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return result.stdout if result.returncode == 0 else None


class Expired(Failure):
    """A deadline passed before an effect could start, or while it ran."""


class Deadline:
    """One monotonic end point for every command it bounds. `budget(requested)` is the timeout
    for the next command: its own bound, shortened to the time left, so a command still running
    at the deadline is killed there. Once no time is left, `budget` and `check` raise `Expired`
    instead, and no new effect starts. `seconds=None` is unbounded."""

    def __init__(self, seconds, label, clock=time.monotonic):
        self.seconds, self.label, self.clock = seconds, label, clock
        self.at = None if seconds is None else clock() + seconds

    def expired(self):
        return self.at is not None and self.clock() >= self.at

    def check(self):
        if self.expired():
            raise Expired(f"{self.label} expired")

    def budget(self, requested):
        if self.at is None:
            return requested
        left = self.at - self.clock()
        if left <= 0:
            raise Expired(f"{self.label} expired")
        return min(requested, left)


UNBOUNDED = Deadline(None, "no deadline")


def git(*argv, timeout=120):
    """Run Git without system or global configuration, templates, hooks or signing."""
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/"),
           "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "LC_ALL": "C"}
    try:
        result = subprocess.run(
            ["git", "-c", "init.templateDir=", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
             "-c", "user.name=Hack benchmark", "-c", "user.email=benchmark@example.invalid", *argv],
            env=env, capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise Failure(f"git {' '.join(argv)[:160]}: no result within {timeout:.1f} s") from None
    if result.returncode != 0:
        raise Failure(f"git {' '.join(argv)[:160]}: {result.stderr.strip()[-300:]}")
    return result.stdout.strip()


class Worktrees:
    """A harness-owned repository with `count` linked worktrees. Each is an ordinary
    `git worktree add` checkout on its own branch with a committed random marker; all share one
    common Git directory, and only each exact worktree root is shared with its own pool. Every
    Git command and observation is bounded by `deadline`."""

    def __init__(self, root, count, deadline=UNBOUNDED):
        self.dir = Path(root).resolve() / f"worktrees{count:02d}-{secrets.token_hex(3)}"
        self.repo = self.dir / "repo"
        self.count = count
        self.entries = []
        self.deadline = deadline

    def git(self, *argv):
        return git(*argv, timeout=self.deadline.budget(120))

    def create(self):
        self.deadline.check()
        self.dir.mkdir(mode=0o700)
        self.git("init", "--quiet", "--initial-branch=main", str(self.repo))
        (self.repo / "compose.yaml").write_text(WORKTREE_COMPOSE.format(image_id=PLACEHOLDER_IMAGE))
        self.git("-C", str(self.repo), "add", "compose.yaml")
        self.git("-C", str(self.repo), "commit", "--quiet", "-m", "fixture")
        for index in range(self.count):
            root, branch, marker = self.dir / f"w{index:02d}", f"wt-{index:02d}", secrets.token_hex(16)
            self.git("-C", str(self.repo), "worktree", "add", "--quiet", "-b", branch, str(root), "main")
            # The runtime refuses a share that other users can write.
            root.chmod(0o700)
            (root / "branch.txt").write_text(marker)
            self.git("-C", str(root), "add", "branch.txt")
            self.git("-C", str(root), "commit", "--quiet", "-m", branch)
            self.entries.append({"root": root, "branch": branch, "marker": marker,
                                 "head": self.git("-C", str(root), "rev-parse", "HEAD")})
        return self.entries

    def provenance(self):
        """Git's own view of the fixture: registered roots and branches, distinct heads, and the
        number of common directories (one for real linked worktrees)."""
        registered, current = {}, None
        for line in self.git("-C", str(self.repo), "worktree", "list", "--porcelain").splitlines():
            if line.startswith("worktree "):
                current = line[len("worktree "):]
            elif line.startswith("branch refs/heads/") and current:
                registered[current] = line[len("branch refs/heads/"):]
        common = {self.git("-C", str(e["root"]), "rev-parse", "--path-format=absolute", "--git-common-dir")
                  for e in self.entries}
        return {
            "registered": sum(registered.get(str(e["root"])) == e["branch"] for e in self.entries),
            "roots": len({str(e["root"]) for e in self.entries}),
            "branches": len({e["branch"] for e in self.entries}),
            "heads": len({e["head"] for e in self.entries}),
            "common_dirs": len(common),
            "checkout_allocated_bytes": allocated(self.dir),
        }

    def cleanup(self, pools_disposed):
        """Remove the fixture only after every pool that could mount one of its roots is
        confirmed disposed; otherwise keep every root, its registration and its source for
        diagnosis. A process listing without the path is an extra refusal, never proof."""
        if not self.dir.exists():
            return {"removed": True, "created": False}
        if not pools_disposed:
            return {"preserved": str(self.dir), "error": "an owned pool was not confirmed disposed"}
        try:
            listing = observed_output(["ps", "-A", "-ww", "-o", "pid=,args="], self.deadline.budget(OBSERVATION_TIMEOUT))
        except Expired as error:
            return {"preserved": str(self.dir), "error": f"{error}; the fixture is kept"}
        if listing is None or str(self.dir) in listing:
            return {"preserved": str(self.dir), "error": "a process may still reference this fixture"}
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


def cpu_seconds(text):
    """Cumulative CPU time as `ps` prints it ([dd-][hh:]mm:ss.cc; minutes may exceed 59), or None."""
    days, _, clock = text.strip().rpartition("-")
    try:
        seconds = 0.0
        for part in clock.split(":"):
            seconds = seconds * 60 + float(part)
        return seconds + (int(days) * 86400 if days else 0)
    except ValueError:
        return None


class Background:
    """CPU cores used, between consecutive observations, by processes this run does not own.

    A process is owned when its command line names the run root: trial homes, their VMs, CLI
    calls, fixtures and the harness itself. `watched` PIDs (for example an idle VM left running
    beside the run) count as background and are also reported on their own. A process that
    starts and exits between two observations is not seen, so short-lived work is undercounted.

    Every measurement spans at least 90% of `interval`. `ps` rounds CPU time to 10 ms, so a call
    that comes sooner (for example a trial's start or end check right after a continuous sample)
    returns the last measurement instead of dividing that rounding by a tiny interval."""

    def __init__(self, root, watched=(), listing=None, clock=time.monotonic, interval=1.0):
        self.root, self.watched, self.clock, self.interval = str(root), set(watched), clock, interval
        self.listing = listing or self._listing
        self.previous = None
        self.latest = (None, None, [])
        # The largest background contributors in the latest measurement, [[command, cores], ...],
        # so a flagged sample can be attributed (for example to Gatekeeper scanning new binaries).
        self.top = []
        # The latest measurement's cores per HOST_SERVICES entry, empty until an interval exists.
        self.services = {}
        self.lock = threading.Lock()

    @staticmethod
    def _listing():
        listing = observed_output(["ps", "-A", "-o", "pid=,time=,args="])
        if listing is None:
            raise RuntimeError("process listing unavailable")
        return listing

    def restart(self):
        """Begin a fresh interval now: the next measurement covers only what follows, not an
        untimed gap such as a trial's setup or the previous trial's cleanup."""
        with self.lock:
            self.previous = None
            self.latest = self._measure(self.clock())

    def observe(self):
        """(background cores, watched cores, names) over the latest full interval. Cores are None
        until an interval exists; names are every listed command, for build-tool detection."""
        with self.lock:
            now = self.clock()
            if self.previous is not None and now - self.previous[0] < 0.9 * self.interval:
                return self.latest
            self.latest = self._measure(now)
            return self.latest

    def _measure(self, now):
        """One new snapshot at `now`, measured against the previous one."""
        table, names = {}, []
        for line in self.listing().splitlines():
            fields = line.split(None, 2)
            if len(fields) < 3 or not fields[0].isdigit():
                continue
            names.append(fields[2].split()[0])
            seconds = cpu_seconds(fields[1])
            if seconds is not None:
                table[(int(fields[0]), fields[2])] = (seconds, self.root in fields[2])
        previous, self.previous = self.previous, (now, table)
        if previous is None or now <= previous[0]:
            self.top, self.services = [], {}
            return None, None, names
        background = watched = 0.0
        by_command = {}
        for key, (seconds, owned) in table.items():
            if owned or key not in previous[1]:
                continue
            delta = max(0.0, seconds - previous[1][key][0])
            background += delta
            command = Path(key[1].split()[0]).name
            by_command[command] = by_command.get(command, 0.0) + delta
            if key[0] in self.watched:
                watched += delta
        elapsed = now - previous[0]
        ranked = sorted(by_command.items(), key=lambda item: item[1], reverse=True)[:3]
        self.top = [[command, round(delta / elapsed, 3)] for command, delta in ranked if delta > 0]
        self.services = {name: round(sum(d for c, d in by_command.items() if pattern.match(c)) / elapsed, 3)
                         for name, pattern in HOST_SERVICES.items()}
        return round(background / elapsed, 3), round(watched / elapsed, 3), names


def measure_idle(meter, seconds, interval, pressure=None, sleep=time.sleep, clock=time.monotonic):
    """Sample the host for `seconds` of elapsed monotonic time while nothing of this run exists.
    The maximum background observed becomes the admission ceiling: a timed sample may not exceed
    what idle already showed.

    The first failed or timed-out observation (process listing or memory pressure) ends the
    baseline at once with `observer_failed`: an unobserved host sets no ceiling, and sampling on
    would only spend the window. It therefore takes at most `seconds`, plus one interval and the
    observations in progress (each at most OBSERVATION_TIMEOUT)."""
    pressure = pressure or (lambda: (observed_output(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"]) or "").strip())
    background, watched, levels, tools, ceiling_top, failed = [], [], set(), set(), [], False
    services, other, ceiling_services = {name: [] for name in HOST_SERVICES}, [], {}
    started = clock()
    try:
        meter.observe()
    except (OSError, RuntimeError):
        failed = True
    while not failed and clock() - started < seconds:
        sleep(interval)
        try:
            cores, vm, names = meter.observe()
        except (OSError, RuntimeError):
            failed = True
            break
        if cores is not None:
            background.append(cores)
            watched.append(vm)
            named = dict(getattr(meter, "services", {}))
            for name, value in named.items():
                services.setdefault(name, []).append(value)
            other.append(round(cores - sum(named.values()), 3))
            if cores == max(background):
                ceiling_top, ceiling_services = list(getattr(meter, "top", [])), named
        tools |= {Path(n).name for n in names if BUILD_TOOLS.match(Path(n).name)}
        level = pressure()
        levels.add(level or "unobserved")
        failed = not level

    def spread(values):
        ordered = sorted(values)
        return {"n": len(ordered), "median": round(statistics.median(ordered), 3), "max": ordered[-1],
                "p95": ordered[min(len(ordered) - 1, round(0.95 * (len(ordered) - 1)))]} if ordered else {"n": 0}

    refusals = ([] if len(background) >= 3 else ["too_few_samples"]) + (["build_tools"] if tools else []) \
        + ([] if levels == {"1"} else ["memory_pressure"]) + (["observer_failed"] if failed else [])
    return {"seconds": seconds, "elapsed_s": round(clock() - started, 3), "interval_s": interval,
            "background_cores": spread(background), "watched_cores": spread(watched),
            "pressure_levels": sorted(levels), "build_tools": sorted(tools),
            "ceiling_cores": max(background) if background else None, "ceiling_top": ceiling_top,
            "ceiling_services": ceiling_services,
            "host_services_cores": {name: spread(values) for name, values in services.items()},
            "other_cores": spread(other), "refusals": refusals}


def admission_from(load, names, pressure, cpus, background=None, ceiling=None):
    """Admission from one host observation. `None` marks an input that could not be observed;
    any unobserved input or failed condition flags the sample with its reason (fail closed).

    With a measured idle `ceiling`, background CPU from processes the run does not own must stay
    within it, and load (which includes the run's own VMs) is recorded but not judged. Without a
    ceiling the legacy rule applies: load above half the CPUs flags the sample."""
    reasons = []
    if load is None:
        reasons.append("load_unobserved")
    elif ceiling is None and load > cpus / 2:
        reasons.append("load_high")
    if ceiling is not None:
        if background is None:
            reasons.append("background_unobserved")
        elif background > ceiling:
            reasons.append("background_above_idle")
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
    observed = {"load1": None if load is None else round(load, 2), "build_tools": tools,
                "memory_pressure": pressure, "reasons": reasons, "admitted": not reasons}
    if ceiling is not None:
        observed.update(background_cores=background, idle_ceiling_cores=ceiling)
    return observed


def admission(meter=None, ceiling=None):
    try:
        load = os.getloadavg()[0]
    except OSError:
        load = None
    background = watched = None
    if meter is None:
        listing = observed_output(["ps", "-axo", "comm="])
        names = listing.split("\n") if listing and listing.strip() else None
    else:
        try:
            background, watched, names = meter.observe()
        except (OSError, RuntimeError):
            names = None
    level = observed_output(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"])
    pressure = level.strip() if level is not None else None
    observed = admission_from(load, names, pressure, os.cpu_count() or 1, background, ceiling)
    if meter is not None:
        observed.update(watched_cores=watched, background_top=list(getattr(meter, "top", [])),
                        host_services=dict(getattr(meter, "services", {})))
    return observed


def observe_admission(args):
    """Admission against the run's measured idle baseline when one was taken, else the legacy rule."""
    return admission(getattr(args, "background", None), getattr(args, "idle_ceiling", None))


def trial_start_admission(args, sleep=time.sleep):
    """Admission for the full interval right before a trial's timed work. With a meter, it restarts
    first, so the untimed setup and the previous trial's cleanup never enter the measurement."""
    meter = getattr(args, "background", None)
    if meter is not None:
        try:
            meter.restart()
        except (OSError, RuntimeError):
            pass
        sleep(meter.interval)
    return observe_admission(args)


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
        background = [s["background_cores"] for s in self.samples if s.get("background_cores") is not None]
        peak = max((s for s in self.samples if s.get("background_cores") is not None),
                   key=lambda s: s["background_cores"], default={})
        watched = [s["watched_cores"] for s in self.samples if s.get("watched_cores") is not None]
        return {"samples": len(self.samples), "interval_s": self.interval, "reasons": sorted(reasons),
                "max_gap_s": round(max(gaps), 3) if gaps else None,
                "max_load1": max(loads) if loads else None,
                "max_background_cores": max(background) if background else None,
                "max_background_top": peak.get("background_top"),
                "max_background_services": peak.get("host_services"),
                "max_watched_cores": max(watched) if watched else None, "admitted": not reasons,
                # Seconds since start and background split per sample, for phase attribution.
                "series": [{"t_s": round(t - self.started, 3), "background_cores": s.get("background_cores"),
                            **(s.get("host_services") or {})}
                           for s, t in zip(self.samples, self.times)] if self.started is not None else []}


class Trial:
    """One private candidate home and the projects it serves. Every command is bounded by
    `deadline`: a worktree cohort's deadline, then its separate cleanup budget."""

    def __init__(self, args, label):
        self.args = args
        self.dir = Path(args.root, f"{label}-{secrets.token_hex(3)}")
        self.home = self.dir / "home"
        self.samples = {}
        self.deadline = UNBOUNDED

    def cli(self, *argv, timeout=300, json_output=True):
        argv = list(argv)
        if json_output:
            # Options precede a `--` program separator.
            argv.insert(argv.index("--") if "--" in argv else len(argv), "--json")
        return command([self.args.bundle, "--candidate-root", str(self.home), *argv], self.deadline.budget(timeout))

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
            if self.deadline.expired():
                raise Expired(f"{name}: {self.deadline.label} expired: exit {code}")
            raise Failure(f"{name}: exit {code}: {json.dumps(body)[:400]}")
        return body

    def setup(self):
        self.deadline.check()
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
        """The provider tree the runtime returned (its identity-bound root and current
        descendants, whatever their executables), each process counted once. The tree must
        contain this home's provider binary. It holds only processes live at the snapshot,
        while each command's wait4 CPU covers only its terminated, reaped children, so adding
        the two never counts a process twice."""
        returned = (body.get("provider_resources") or {}).get("processes") or []
        tree = list({(p["identity"]["pid"], p["identity"]["start_micros"]): p for p in returned}.values())
        binary = str(self.home / ".hack-local/providers") + "/"
        own = [p for p in tree if str(p["identity"]["executable"]).startswith(binary)]
        if not own:
            return {}
        cpu = sum(p["user_cpu_nanoseconds"] + p["system_cpu_nanoseconds"] for p in tree) / 1e9
        try:
            libc = Libc()
            peaks = [libc.peak_footprint(p["identity"]["pid"]) for p in tree]
        except OSError:
            peaks = [None]
        memory = body.get("guest_memory_mib")
        # Resident size and physical footprint are measured; the guest's configured maximum is
        # not. They are reported side by side, never added together.
        return {
            "vm_identity": [own[0]["identity"]["pid"], own[0]["identity"]["start_micros"]],
            "tree_processes": len(tree),
            "tree_helpers": len(tree) - len(own),
            "vm_cpu_s": round(cpu, 3),
            "vm_resident_bytes": sum(p["resident_bytes"] for p in tree),
            "vm_footprint_bytes": sum(p["physical_footprint_bytes"] for p in tree),
            # Per-process lifetime peaks need not coincide: an upper bound on the tree's peak.
            "vm_peak_footprint_bytes": total(peaks),
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
            "--ready", "web=healthy", "--timeout-seconds", "120", timeout=180, check=healthy,
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
        """Stop this home's pool and remove only this trial's directory and provider alias. When
        the deadline ends first, or any readback fails, the home is kept for diagnosis."""
        result = {}
        if not self.dir.exists():
            return {"removed": True, "created": False}
        try:
            owner = json.loads((self.home / ".hack-local/run/smolvm/owner.json").read_text())
            alias = Path(owner["short_home"])
        except (OSError, ValueError, KeyError):
            alias = None
        try:
            if self.home.exists():
                code, body, _, _ = self.cli("runtime", "down", timeout=300)
                result["down"] = body.get("phase") or body.get("code")
                if code != 0:
                    # A down stopped at the deadline may or may not have stopped the pool.
                    failed = f"{self.deadline.label} expired during down" if self.deadline.expired() else "down failed"
                    result["error"] = f"{failed}: exit {code}: {json.dumps(body)[:300]}"
                    return result
                # The runtime's identity-checked readback, not a process listing, proves the VM stopped.
                code, body, _, _ = self.cli("runtime", "status")
                if code != 0 or body.get("process_alive") is not False:
                    result["error"] = f"pool not confirmed stopped after down: {json.dumps(body)[:300]}"
                    return result
            running = observed_output(["ps", "-axww", "-o", "pid=,command="], self.deadline.budget(OBSERVATION_TIMEOUT))
        except Expired as error:
            result["error"] = f"{error}; this trial's home is kept"
            return result
        if running is None:
            result["error"] = "process listing unavailable; this trial's home is kept"
            return result
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
        record["admission"] = trial_start_admission(args)
        sampler = Sampler(args.admission_interval, observe=lambda: observe_admission(args)).start()
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
            "--timeout-seconds", "120", timeout=180, check=healthy,
        )
        if trial.token(graph["run"], "restore_token") != graph["token"]:
            raise Failure("persistent token changed across restart")
        record["token_sha256"] = hashlib.sha256(graph["token"].encode()).hexdigest()[:16]
        record["admission_end"] = observe_admission(args)
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
        record["admission"] = trial_start_admission(args)
        sampler = Sampler(args.admission_interval, observe=lambda: observe_admission(args)).start()
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
        record["admission_end"] = observe_admission(args)
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
        record["admission"] = trial_start_admission(args)
        sampler = Sampler(args.admission_interval, observe=lambda: observe_admission(args)).start()
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
        record["admission_end"] = observe_admission(args)
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


def host_activity(series, phases):
    """Mean background cores per phase, split into HOST_SERVICES and the rest, over the sampler
    samples that ended inside each phase (seconds since the sampler started). A warm restart
    re-executes the binaries its cold start ran first, so security scanning seen in cold phases
    and not in warm ones is consistent with scans the run induced. That is timing evidence, not
    causal tracing. Unobserved samples are counted and left out of the means."""
    result = {}
    for phase, (start, end) in phases.items():
        inside = [s for s in series if start < s["t_s"] <= end]
        observed = [s for s in inside if s.get("background_cores") is not None
                    and all(s.get(name) is not None for name in HOST_SERVICES)]
        entry = {"seconds": round(end - start, 3), "samples": len(inside), "observed": len(observed)}
        if observed:
            entry["background_cores"] = round(statistics.fmean(s["background_cores"] for s in observed), 3)
            for name in HOST_SERVICES:
                entry[f"{name}_cores"] = round(statistics.fmean(s[name] for s in observed), 3)
            entry["other_cores"] = round(entry["background_cores"] - sum(entry[f"{n}_cores"] for n in HOST_SERVICES), 3)
        result[phase] = entry
    return result


def pool_resources(pools, statuses):
    """Cohort totals from one reading per pool, taken in turn rather than at one instant. A
    total is null when any pool's value is unobserved.
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
        # Lifetime peaks need not coincide: an upper bound, not a simultaneous cohort peak.
        "vm_peak_footprint_sum_bytes": total(v.get("vm_peak_footprint_bytes") for v in vms),
        "guest_memory_configured_bytes": total(v.get("guest_memory_configured_bytes") for v in vms),
        "disk_allocated_bytes": total(total(d.get("allocated") for d in disk.values()) for disk in disks),
        "disk_private_bytes": total(total(d.get("private") for d in disk.values()) for disk in disks),
        # Everything under each home, VM disks included, so it overlaps the disk totals. Block
        # counts are not clone-aware; clone-private bytes are.
        "homes_allocated_bytes": total(allocated(pool.dir) for pool in pools),
        "vms": vms,
    }


def worktree_trial(args, size, repeat, lane, clock=time.monotonic):
    """`size` linked worktrees, each exactly shared with its own fresh pool in its own private
    home, started `--worktree-parallel` at a time. Setup (provider, engine and network tools
    per home) is untimed.

    Everything before disposal runs under one cohort deadline (`--cohort-deadline`): every
    runtime and Git command's timeout is shortened to the time left, one still running at the
    deadline is killed, and none starts after it. Disposal then runs under its own
    `--cleanup-budget`, so an expired cohort still gets a bounded, ownership-checked cleanup;
    whatever that budget cannot confirm disposed is kept."""
    deadline = Deadline(getattr(args, "cohort_deadline", None), "cohort deadline", clock)
    fixture = Worktrees(args.root, size, deadline)
    pools = [Trial(args, f"wt{size:02d}r{repeat}-{lane}-{index:02d}") for index in range(size)]
    for pool in pools:
        pool.deadline = deadline
    record = {"mode": "worktrees", "size": size, "repeat": repeat, "lane": lane, "home": str(fixture.dir),
              "homes": [str(pool.dir) for pool in pools]}
    sampler, marks = None, {}
    try:
        entries = fixture.create()
        for pool in pools:
            pool.setup()
        deadline.check()
        record["admission"] = trial_start_admission(args)
        sampler = Sampler(args.admission_interval, observe=lambda: observe_admission(args)).start()
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
        origin = started - sampler.started
        marks["cold"] = [round(origin, 3), round(origin + record["all_ready_s"], 3)]
        record["ready_offsets_s"] = sorted(r["ready_s"] for r in ready)
        record["provenance"] = [r["provenance"] for r in ready]
        observed_from = round(time.monotonic() - started, 3)
        statuses = [pool.status() for pool in pools]
        record["resources"] = pool_resources(pools, statuses)
        # Pools are read one after another, so the cohort sums are a staggered snapshot over
        # this window (seconds since the cohort started), not one instant.
        record["resources"]["observed"] = {"kind": "staggered-per-pool", "from_s": observed_from,
                                           "to_s": round(time.monotonic() - started, 3)}

        record["fixture"] = fixture.provenance()
        record["isolation"] = {
            "pools": len({(s["machine"], s["guest_boot_id"]) for s in statuses
                          if s.get("machine") and s.get("guest_boot_id")}),
            "namespaces": len({r["graph"]["namespace"] for r in ready}),
            "tokens": len({r["graph"]["token"] for r in ready}),
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
            # A raw (non-normalized) graph restores only its exact accepted source; the runtime
            # honors a changed review only for normalized receipts. The source must therefore
            # still plan to the run's identity, checked before any restore effect.
            plan = pool.step("replan", "project", "plan", "--project", str(entry["root"]), "--branch", entry["branch"],
                             "--file", graph["compose"])["plan_id"]
            if plan != graph["plan"]:
                raise Failure(f"worktree {index} source changed since its run: plan {plan} != {graph['plan']}")
            pool.step(
                "restore", "graph", "restore", "--project", str(entry["root"]), "--branch", entry["branch"],
                "--file", graph["compose"], "--expect-plan", plan, "--run-id", graph["run"],
                "--shared-source", "--ready", "web=healthy", "--timeout-seconds", "120", timeout=180,
                check=healthy,
            )
            kept = {"token": pool.token(graph["run"], "restore_token") == graph["token"],
                    "marker": pool.read(graph["run"], "/workspace/branch.txt", "restore_marker") == entry["marker"]}
            if not all(kept.values()):
                raise Failure(f"worktree {index} did not retain data and source across down/up: {kept}")
            return {"provenance": provenance(body, lane, "warm"), "ready_s": round(time.monotonic() - warm_started, 3)}

        warm = each(retain, size, args.worktree_parallel)
        record["warm_all_ready_s"] = round(time.monotonic() - warm_started, 3)
        origin = warm_started - sampler.started
        marks["warm"] = [round(origin, 3), round(origin + record["warm_all_ready_s"], 3)]
        record["warm_provenance"] = [w["provenance"] for w in warm]
        record["retained"] = size

        # A fresh host edit in every root must reach exactly its own restored pool: each share is
        # live and attached to its own root. It comes last because it changes the source.
        deadline.check()
        live = [secrets.token_hex(16) for _ in range(size)]
        for entry, value in zip(entries, live):
            (entry["root"] / "live.txt").write_text(value)
        seen = each(lambda i: pools[i].read(ready[i]["graph"]["run"], "/workspace/live.txt", "live"),
                    size, args.worktree_parallel)
        record["isolation"]["live_edits_read_back"] = sum(a == b for a, b in zip(seen, live))
        if record["isolation"]["live_edits_read_back"] != size:
            raise Failure(f"a host edit did not reach exactly its own pool: {record['isolation']}")
        record["admission_end"] = observe_admission(args)
        record["ok"] = True
    except Failure as error:
        record["ok"] = False
        record["error"] = str(error)
    finally:
        expired = deadline.expired()
        if sampler:
            record["admission_during"] = sampler.stop()
            if marks:
                record["phases_s"] = marks
                record["host_activity"] = host_activity(record["admission_during"]["series"], marks)
        record["samples"] = [pool.samples for pool in pools]
        cleanup_started = clock()
        cleanup = Deadline(getattr(args, "cleanup_budget", None), "cleanup budget", clock)
        fixture.deadline = cleanup
        for pool in pools:
            pool.deadline = cleanup
        disposal = [pool.cleanup() for pool in pools]
        disposed = all(c.get("removed") is True and "error" not in c for c in disposal)
        record["cleanup"] = disposal + [fixture.cleanup(disposed)]
        record["cleanup_failed"] = any("error" in c or not c.get("removed") for c in record["cleanup"])
        record["deadline"] = {"cohort_s": deadline.seconds, "cohort_expired": expired,
                              "cleanup_budget_s": cleanup.seconds, "cleanup_expired": cleanup.expired(),
                              "cleanup_s": round(clock() - cleanup_started, 3)}
    return record


def run_worktrees(args, sizes, keep, deadline=None, clock=time.monotonic, distress=None):
    """Worktree cohorts in order. Returns None when every planned cohort ran, else why the rest
    did not start:
    - `cleanup_failed`: a failed cleanup can leave live pools and their roots behind, and any
      later cohort would exceed the planned peak and share the host with them;
    - `cohort_deadline`: the cohort's work outlived its deadline, so its pair is incomplete and
      the host or runtime was slower than the plan allows;
    - `budget`: the run budget was spent;
    - `distress: ...`: `distress.check` found host distress before the next cohort.
    A cohort in progress always finishes within its own deadline and cleanup budget."""
    previous = None
    for repeat in range(args.worktree_repeats):
        for size in sizes:
            lanes = ("stock", "prepared") if (repeat + size) % 2 == 0 else ("prepared", "stock")
            for lane in lanes:
                if deadline is not None and clock() >= deadline:
                    return "budget"
                reasons = distress.check(previous) if distress else []
                if reasons:
                    return "distress: " + "; ".join(reasons)
                previous = worktree_trial(args, size, repeat, lane)
                keep(previous)
                if previous["cleanup_failed"]:
                    return "cleanup_failed"
                if previous["deadline"]["cohort_expired"]:
                    return "cohort_deadline"
    return None


def process_identity(pid):
    """Start time and command of a live PID, or None; used to show an idle VM stayed the same."""
    output = observed_output(["ps", "-p", str(pid), "-o", "lstart=,args="])
    return (output.strip() or None) if output is not None else None


class Distress:
    """Host conditions after which no further cohort starts. A new crash or watchdog report since
    the run began, raised memory pressure, a build tool (now, or in the finished trial's own
    admission samples), or an idle VM that is no longer the same process."""

    PREFIXES = ("syspolicyd", "WindowServer", "panic", "Jetsam", "ResetCounter")
    REPORTS = (Path("/Library/Logs/DiagnosticReports"), Path("/Library/Logs/DiagnosticReports/Retired"))
    TRIAL = ("memory_pressure", "build_tools")

    def __init__(self, idle_vms, reports=REPORTS, identity=process_identity, host=None):
        self.idle_vms, self.dirs, self.identity = dict(idle_vms), reports, identity
        self.host = host or (lambda: admission())
        self.baseline = self.reports()

    def reports(self):
        return {p.name for d in self.dirs if d.is_dir() for p in d.iterdir() if p.name.startswith(self.PREFIXES)}

    def check(self, record=None):
        reasons = []
        new = sorted(self.reports() - self.baseline)
        if new:
            reasons.append("new_report: " + ", ".join(new))
        reasons += [f"idle_vm_changed: {pid}" for pid, identity in self.idle_vms.items() if self.identity(pid) != identity]
        now = self.host()
        reasons += [f"host: {reason}" for reason in now["reasons"] if reason in self.TRIAL]
        seen = set()
        for key in ("admission", "admission_during", "admission_end"):
            seen |= {r for r in ((record or {}).get(key) or {}).get("reasons", []) if r in self.TRIAL}
        reasons += [f"trial: {reason}" for reason in sorted(seen)]
        return reasons


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
    observed = resources.get("observed") or {}
    metrics = {
        "all_ready_s": r["all_ready_s"],
        "resource_snapshot_span_s": (round(observed["to_s"] - observed["from_s"], 3)
                                     if "to_s" in observed and "from_s" in observed else None),
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
    # Background during each phase, by named host service and the rest (records without it: null).
    activity = r.get("host_activity") or {}
    for phase in ("cold", "warm"):
        for name in (*HOST_SERVICES, "other"):
            metrics[f"{phase}_{name}_cores"] = (activity.get(phase) or {}).get(f"{name}_cores")
    return metrics


def flag_attribution(record):
    """What a flagged cohort's peak background sample consisted of: its excess over the idle
    ceiling, each named host service and the rest. Descriptive only: a flagged cohort stays
    flagged, and the idle baseline's own per-service figures are the reference for each part."""
    during = record.get("admission_during") or {}
    peak = during.get("max_background_cores")
    ceiling = (record.get("admission") or {}).get("idle_ceiling_cores")
    services = during.get("max_background_services") or {}
    return {**{k: record.get(k) for k in ("size", "repeat", "lane")},
            "peak_background_cores": peak, "idle_ceiling_cores": ceiling,
            "excess_cores": None if peak is None or ceiling is None else round(peak - ceiling, 3),
            "peak_services_cores": services,
            "peak_other_cores": None if peak is None or not services else round(peak - sum(services.values()), 3),
            "peak_top": during.get("max_background_top")}


def idle_vms_changed(started, ended):
    """PIDs of idle VMs whose identity at the end differs from the start (keys as strings)."""
    started = {str(k): v for k, v in (started or {}).items()}
    ended = {str(k): v for k, v in (ended or {}).items()}
    return sorted(pid for pid, identity in started.items() if ended.get(pid) != identity)


def summarize(records, cpus=None, idle_vms=None, idle_vms_end=None):
    """Summaries of raw records. When an idle VM measured by the baseline is no longer the same
    process at the end, the background every trial was admitted against changed, so no trial's
    timing is admitted; all records stay, in the flagged summaries."""
    cpus = cpus or os.cpu_count() or 1
    changed = idle_vms_changed(idle_vms, idle_vms_end) if idle_vms else []
    summary = {"admission_boundaries": {}, "timing_invalidated": [f"idle_vm_changed: {pid}" for pid in changed]}
    classified = []
    for r in records:
        ok, reasons, boundary = admitted(r, cpus)
        if changed:
            ok, reasons = False, reasons + ["run:idle_vm_changed"]
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
    # A cohort whose cleanup failed shared the host with pools it could not dispose of; its
    # timings and resources are unqualified whatever its admission.
    worktrees = [(r, ok, why) for r, ok, why in classified
                 if r["mode"] == "worktrees" and r.get("ok") and not r.get("cleanup_failed")]
    summary["worktrees_unqualified_cleanup"] = [
        {k: r.get(k) for k in ("size", "repeat", "lane", "home")}
        for r in records if r["mode"] == "worktrees" and r.get("cleanup_failed")]
    for admitted_flag, key in ((True, "worktrees_admitted"), (False, "worktrees_flagged")):
        chosen = [r for r, ok, _ in worktrees if ok == admitted_flag]
        summary[key] = {str(size): lanes([r for r in chosen if r["size"] == size], worktree_metrics)
                        for size in sorted({r["size"] for r in chosen})}
    summary["admitted_worktree_all_ready_ratio_by_size"] = paired(
        worktrees, lambda r: (r["size"], r["repeat"]), lambda r: r["all_ready_s"])
    summary["worktree_flag_attribution"] = [flag_attribution(r) for r, ok, why in worktrees
                                            if not ok and "during:background_above_idle" in why]
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


def positive_seconds(text):
    """An argparse type for a duration: a positive, finite number of seconds. Checked while the
    arguments are parsed, before any host observation or effect, so a negative, zero, NaN or
    infinite bound can never start a run."""
    try:
        value = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is not a number of seconds") from None
    if not math.isfinite(value) or value <= 0:
        raise argparse.ArgumentTypeError(f"{text!r} must be a positive, finite number of seconds")
    return value


def load_samples(path):
    """(context, records, idle-VM identities at the end) from a raw samples file; a trailing
    summary line is ignored."""
    context, records, ended = {}, [], None
    for line in Path(path).read_text().splitlines():
        entry = json.loads(line)
        if "context" in entry:
            context = entry["context"]
        elif "idle_vms_end" in entry:
            ended = entry["idle_vms_end"]
        elif "summary" not in entry:
            records.append(entry)
    return context, records, ended


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
    parser.add_argument("--idle-baseline", type=float, default=0.0,
                        help="seconds to measure idle background CPU first; its maximum becomes the admission ceiling")
    parser.add_argument("--idle-vm-pid", type=int, action="append", default=[],
                        help="a VM left running beside the run (repeatable); counted as background and reported")
    parser.add_argument("--budget", type=positive_seconds,
                        help="seconds after which no further worktree cohort starts (default: no budget)")
    parser.add_argument("--cohort-deadline", type=positive_seconds,
                        help="seconds a worktree cohort's work may take; later commands are refused (required to run)")
    parser.add_argument("--cleanup-budget", type=positive_seconds,
                        help="seconds a worktree cohort's disposal may take after its work; whatever it cannot "
                             "confirm disposed is kept (required to run)")
    parser.add_argument("--output", help="JSON lines of raw samples (default <root>/samples-<time>.jsonl)")
    parser.add_argument("--run", action="store_true", help="execute; without it only the plan is printed")
    args = parser.parse_args()
    if args.summarize:
        context, records, ended = load_samples(args.summarize)
        summary = summarize(records, (context.get("host") or {}).get("cpus"), context.get("idle_vms"), ended)
        print(json.dumps({"context": context, "summary": summary}, indent=2))
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
            + 2 * sum(worktree_sizes) * args.worktree_repeats,
            "idle_baseline_s": args.idle_baseline, "idle_vm_pids": args.idle_vm_pid, "budget_s": args.budget}
    probe = (observed_output(["sysctl", "-n", "hw.memsize"]) or "").strip()
    host_memory = int(probe) if probe.isdigit() else None
    if worktree_sizes:
        plan["worktrees"] = worktree_plan(worktree_sizes, args.worktree_repeats, args.worktree_parallel,
                                          args.profile, host_memory)
        bounds = (args.cohort_deadline, args.cleanup_budget)
        # Runtime and Git commands end within these; bounded host observations and local file
        # removal can run briefly past them (docs/performance.md).
        plan["worktrees"].update(cohort_deadline_s=args.cohort_deadline, cleanup_budget_s=args.cleanup_budget,
                                 cohort_bound_s=None if None in bounds else sum(bounds))
    if not args.run:
        print(json.dumps({"preview": plan}, indent=2))
        return
    if worktree_sizes and None in (args.cohort_deadline, args.cleanup_budget):
        parser.error("a worktree run needs --cohort-deadline and --cleanup-budget")
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        parser.error("native qualification requires macOS arm64")
    root = Path(args.root).resolve()
    args.root = str(root)
    if not root.is_dir() or root.stat().st_mode & 0o077 or root.stat().st_uid != os.geteuid():
        parser.error("--root must be an existing private (0700) directory owned by this user")
    if worktree_sizes and SENSITIVE_COMPONENTS & set(root.parts):
        parser.error(f"worktree mode needs a --root outside {sorted(SENSITIVE_COMPONENTS)} directories")
    output = Path(args.output or root / f"samples-{int(time.time())}.jsonl")
    started = time.monotonic()
    idle_vms = {pid: process_identity(pid) for pid in args.idle_vm_pid}
    if any(identity is None for identity in idle_vms.values()):
        parser.error(f"--idle-vm-pid must name running processes: {idle_vms}")
    # Reports and idle-VM identity are baselined before any measurement, so anything new during
    # the idle baseline refuses the run as well.
    distress = Distress(idle_vms)
    baseline = None
    if args.idle_baseline > 0:
        meter = Background(root, watched=args.idle_vm_pid, interval=args.admission_interval)
        baseline = measure_idle(meter, args.idle_baseline, args.admission_interval)
        baseline["refusals"] += distress.check()
        if baseline["refusals"]:
            print(json.dumps({"idle_baseline": baseline}, indent=2))
            parser.error(f"the idle baseline was not idle ({baseline['refusals']}); nothing was started")
        args.background, args.idle_ceiling = meter, baseline["ceiling_cores"]
    context = {
        "harness_sha256": sha256(__file__), "bundle_sha256": sha256(args.bundle),
        "host": {"model": (observed_output(["sysctl", "-n", "hw.model"]) or "").strip() or None,
                 "cpus": os.cpu_count(), "memory_bytes": host_memory, "os": platform.mac_ver()[0]},
        "image": args.image, "profile": args.profile, "plan": plan,
        # Shared by every prepared pool; reported once, apart from per-pool private disk.
        "base_store_allocated_bytes": allocated(args.store),
        "idle_baseline": baseline, "idle_vms": idle_vms,
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
        stopped = run_worktrees(args, worktree_sizes, keep, started + args.budget if args.budget is not None else None,
                                distress=distress) if worktree_sizes else None
        if stopped:
            print(json.dumps({"stopped": stopped}), flush=True)
        # An idle VM that restarted or vanished changed the background every trial was admitted
        # against; the end identity is kept in the raw file so --summarize reaches the same verdict.
        ended = {pid: process_identity(pid) for pid in idle_vms}
        sink.write(json.dumps({"idle_vms_end": ended}) + "\n")
        summary = summarize(records, context["host"]["cpus"], idle_vms, ended)
        summary["stopped"] = stopped
        sink.write(json.dumps({"summary": summary}) + "\n")
    print(json.dumps({"output": str(output), "summary": summary}, indent=2))


if __name__ == "__main__":
    main()
