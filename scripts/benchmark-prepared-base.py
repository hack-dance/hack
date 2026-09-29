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
              startup is out of scope.
  concurrent  K pools created at once from one base; distinct identities and data.

Timing admission: a sample is flagged when build tools run or the 1-minute load exceeds half
the CPU count at its start. Flagged samples are kept and summarized separately.
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


def admission():
    load = os.getloadavg()[0]
    names = subprocess.run(["ps", "-axo", "comm="], capture_output=True, text=True).stdout.split("\n")
    tools = sorted({Path(n.strip()).name for n in names if BUILD_TOOLS.match(Path(n.strip()).name or "")})
    pressure = subprocess.run(["sysctl", "-n", "kern.memorystatus_vm_pressure_level"], capture_output=True, text=True).stdout.strip()
    admitted = not tools and load <= (os.cpu_count() or 1) / 2 and pressure in ("", "1")
    return {"load1": round(load, 2), "build_tools": tools, "memory_pressure": pressure, "admitted": admitted}


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

    def up(self, name, lane):
        argv = ["runtime", "up", "--profile", self.args.profile]
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
        return {
            "vm_identity": [own[0]["identity"]["pid"], own[0]["identity"]["start_micros"]],
            "vm_cpu_s": round(cpu, 3),
            "vm_footprint_bytes": sum(p["physical_footprint_bytes"] for p in own),
            "vm_peak_footprint_bytes": peak,
        }

    def disks(self):
        libc = Libc()
        # The pool's provider HOME holds each machine's disks under SmolVM's cache directory.
        vms = self.home.joinpath(".hack-local", "run", "smolvm", "home", "Library", "Caches", "smolvm", "vms")
        result = {}
        for disk in sorted(vms.glob("*/*.raw")):
            stat = disk.stat()
            result[disk.name] = {"logical": stat.st_size, "allocated": stat.st_blocks * 512, "private": libc.private_bytes(disk)}
        return result

    def project(self, index, image_id):
        project = self.dir / "projects" / f"g{index}"
        project.mkdir(mode=0o700)
        (project / "compose.yaml").write_text(COMPOSE.format(image_id=image_id))
        return project

    def graph(self, project, prefix):
        compose = str(project / "compose.yaml")
        plan = self.step(f"{prefix}plan", "project", "plan", "--project", str(project), "--file", compose)["plan_id"]
        run = secrets.token_hex(16)
        self.step(
            f"{prefix}run", "graph", "run", "--project", str(project), "--file", compose, "--expect-plan", plan,
            "--run-id", run, "--ready", "web=healthy", "--timeout-seconds", "120", timeout=180,
            check=lambda b: (b.get("readiness") or {}).get("web") == "healthy",
        )
        return {"project": project, "compose": compose, "plan": plan, "run": run, "token": self.token(run, f"{prefix}token")}

    def token(self, run, name):
        body = self.step(name, "graph", "exec", "--run-id", run, "--service", "web", "--", "/bin/cat", "/data/token")
        value = base64.b64decode(body.get("stdout_base64") or "").decode()
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
    try:
        trial.setup()
        record["admission"] = admission()
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
        record["ok"] = True
    except Failure as error:
        record["ok"] = False
        record["error"] = str(error)
    finally:
        record["samples"] = trial.samples
        record["cleanup"] = trial.cleanup()
    return record


def cohort_trial(args, size, repeat, lane):
    trial = Trial(args, f"cohort{size:02d}r{repeat}-{lane}")
    record = {"mode": "cohort", "size": size, "repeat": repeat, "lane": lane, "home": str(trial.dir)}
    try:
        trial.setup()
        record["admission"] = admission()
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
        record["ok"] = True
    except Failure as error:
        record["ok"] = False
        record["error"] = str(error)
    finally:
        record["samples"] = trial.samples
        record["cleanup"] = trial.cleanup()
    return record


def concurrent_trial(args, count):
    trials = [Trial(args, f"concurrent{i}-prepared") for i in range(count)]
    record = {"mode": "concurrent", "count": count, "homes": [str(t.dir) for t in trials]}
    try:
        for trial in trials:
            trial.setup()
        record["admission"] = admission()
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
        record["ok"] = True
    except Failure as error:
        record["ok"] = False
        record["error"] = str(error)
    finally:
        record["samples"] = [t.samples for t in trials]
        record["cleanup"] = [t.cleanup() for t in trials]
    return record


def summarize(records):
    def stats(values):
        values = [v for v in values if v is not None]
        if not values:
            return None
        return {"n": len(values), "median": round(statistics.median(values), 3), "min": round(min(values), 3), "max": round(max(values), 3)}

    summary = {}
    pairs = [r for r in records if r["mode"] == "pairs" and r.get("ok")]
    for admitted in (True, False):
        chosen = [r for r in pairs if r["admission"]["admitted"] == admitted]
        key = "pairs_admitted" if admitted else "pairs_flagged"
        summary[key] = {
            lane: {
                "up_wall_s": stats([r["samples"]["up"]["wall_s"] for r in chosen if r["lane"] == lane]),
                "up_cpu_s": stats([r["samples"]["up"]["cli_cpu_s"] + r["samples"]["up"].get("vm_cpu_s", 0) for r in chosen if r["lane"] == lane]),
                "service_ready_s": stats([r["service_ready_s"] for r in chosen if r["lane"] == lane]),
                "restart_up_wall_s": stats([r["samples"]["restart_up"]["wall_s"] for r in chosen if r["lane"] == lane]),
                "vm_peak_footprint_bytes": stats([r["samples"]["up"].get("vm_peak_footprint_bytes") for r in chosen if r["lane"] == lane]),
                "disk_private_bytes": stats([sum(d["private"] or 0 for d in r["disks_at_ready"].values()) for r in chosen if r["lane"] == lane]),
            }
            for lane in ("stock", "prepared")
        }
    ratios = []
    by_index = {}
    for r in pairs:
        by_index.setdefault(r["index"], {})[r["lane"]] = r
    for pair in by_index.values():
        if len(pair) == 2 and all(p["admission"]["admitted"] for p in pair.values()):
            ratios.append(pair["prepared"]["samples"]["up"]["wall_s"] / pair["stock"]["samples"]["up"]["wall_s"])
    summary["admitted_pair_up_wall_ratio"] = stats(ratios)
    cohorts = [r for r in records if r["mode"] == "cohort" and r.get("ok")]
    summary["cohorts"] = {
        f"{size}-{lane}": stats([r["all_ready_s"] for r in cohorts if r["size"] == size and r["lane"] == lane])
        for size in sorted({r["size"] for r in cohorts})
        for lane in ("stock", "prepared")
    }
    summary["failures"] = [{k: r.get(k) for k in ("mode", "index", "size", "lane", "error")} for r in records if not r.get("ok")]
    summary["cleanup_failures"] = [r.get("home") or r.get("homes") for r in records if any("error" in c or not c.get("removed") for c in (r["cleanup"] if isinstance(r["cleanup"], list) else [r["cleanup"]]))]
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bundle", required=True, help="absolute hack-native executable")
    parser.add_argument("--root", required=True, help="absolute private (0700) directory for trial homes")
    parser.add_argument("--store", required=True, help="absolute store holding a verified base for these pins")
    parser.add_argument("--provider-archive", required=True)
    parser.add_argument("--engine-archive", required=True)
    parser.add_argument("--network-tools", required=True, help="directory of pinned network-tool packages")
    parser.add_argument("--image", required=True, help="pinned image reference (repository@sha256:...)")
    parser.add_argument("--profile", default="development", choices=("development", "research"))
    parser.add_argument("--mode", action="append", choices=("pairs", "cohort", "concurrent"))
    parser.add_argument("--pairs", type=int, default=5)
    parser.add_argument("--cohorts", default="1,8,32")
    parser.add_argument("--cohort-repeats", type=int, default=2)
    parser.add_argument("--parallel", type=int, default=4, help="concurrent graph start requests within one pool (they serialize)")
    parser.add_argument("--concurrent", type=int, default=4)
    parser.add_argument("--output", help="JSON lines of raw samples (default <root>/samples-<time>.jsonl)")
    parser.add_argument("--run", action="store_true", help="execute; without it only the plan is printed")
    args = parser.parse_args()
    modes = args.mode or ["pairs", "cohort", "concurrent"]
    for name in ("bundle", "root", "store", "provider_archive", "engine_archive", "network_tools"):
        if not os.path.isabs(getattr(args, name)):
            parser.error(f"--{name.replace('_', '-')} must be absolute")
    sizes = [int(s) for s in args.cohorts.split(",") if s]
    plan = {"modes": modes, "pairs": args.pairs, "cohorts": sizes, "cohort_repeats": args.cohort_repeats,
            "parallel": args.parallel, "concurrent": args.concurrent, "root": args.root,
            "pools_created": (2 * args.pairs if "pairs" in modes else 0)
            + (2 * len(sizes) * args.cohort_repeats if "cohort" in modes else 0)
            + (args.concurrent if "concurrent" in modes else 0)}
    if not args.run:
        print(json.dumps({"preview": plan}, indent=2))
        return
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        parser.error("native qualification requires macOS arm64")
    root = Path(args.root).resolve()
    args.root = str(root)
    if not root.is_dir() or root.stat().st_mode & 0o077 or root.stat().st_uid != os.geteuid():
        parser.error("--root must be an existing private (0700) directory owned by this user")
    output = Path(args.output or root / f"samples-{int(time.time())}.jsonl")
    context = {
        "harness_sha256": sha256(__file__), "bundle_sha256": sha256(args.bundle),
        "host": {"model": subprocess.run(["sysctl", "-n", "hw.model"], capture_output=True, text=True).stdout.strip(),
                 "cpus": os.cpu_count(), "memory_bytes": int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout),
                 "os": platform.mac_ver()[0]},
        "image": args.image, "profile": args.profile, "plan": plan,
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
        summary = summarize(records)
        sink.write(json.dumps({"summary": summary}) + "\n")
    print(json.dumps({"output": str(output), "summary": summary}, indent=2))


if __name__ == "__main__":
    main()
