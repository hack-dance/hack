#!/usr/bin/env python3
"""Manual, isolated build-output qualification; never run by ordinary tests or CI.

Uses an already prepared, stopped candidate pool and explicitly supplied image archive.
Keeps failure evidence; never starts or changes the supported global Hack runtime.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
LAUNCHER = ROOT / "hack-local"
FIXTURE = ROOT / "tests/fixtures/source-build"
ARCHIVE_SHA = "74bb8d8c567eb02d5019ac0117efff81571c67d66899e6ad9b6c6cdf74d5dbfe"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-live", action="store_true", required=True)
    parser.add_argument("--image-archive", type=Path, required=True)
    parser.add_argument("--protected-project", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    evidence = ROOT / ".hack-local/review/wu07" / f"build-output-{time.time_ns()}"
    evidence.mkdir(parents=True, mode=0o700)
    shutil.copyfile(__file__, evidence / "protocol.py")
    shutil.copytree(FIXTURE, evidence / "fixture")
    image = json.loads((FIXTURE / "contract.json").read_text())["image"]
    metadata = {"binary_sha256": hashlib.sha256((ROOT / ".hack-local/target/release/hack-runtime-candidate").read_bytes()).hexdigest(),
                "protocol_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "scope": "isolated fixture; no Dockerfile/dependency install or general artifact cache", "image": image}
    (evidence / "metadata.json").write_text(json.dumps(metadata, indent=2))
    print(json.dumps({"evidence": str(evidence)}), flush=True)
    finished, abort = threading.Event(), threading.Event()
    started = time.monotonic()
    samples, results = [], []
    active = None
    socket = None

    def call(label, arguments, success=True, timeout=120):
        result = subprocess.run([str(LAUNCHER), *map(str, arguments)], cwd=ROOT,
                                capture_output=True, text=True, timeout=timeout)
        (evidence / f"{label}.json").write_text(json.dumps({"exit_code": result.returncode, "stdout": result.stdout, "stderr": result.stderr}, indent=2))
        print(json.dumps({"step": label, "exit_code": result.returncode}), flush=True)
        if success != (result.returncode == 0):
            raise RuntimeError(f"Unexpected result at {label}; evidence retained")
        return json.loads(result.stdout) if success else result

    def engine(*arguments):
        result = subprocess.run(["docker", "--host", socket, *map(str, arguments)],
                                capture_output=True, text=True, timeout=30)
        if result.returncode:
            raise RuntimeError("Read-only private engine inspection failed")
        return result.stdout

    def protected():
        paths = [Path.home() / ".hack/hack.config.json", Path("/opt/homebrew/bin/hack")]
        if args.protected_project:
            paths += [args.protected_project / "package.json", args.protected_project / ".hack/docker-compose.yml"]
        return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths if p.exists()}

    def watch(swapouts):
        try:
            while not finished.wait(2):
                raw = subprocess.check_output(["/usr/bin/vm_stat"], text=True, timeout=5)
                page = int(re.search(r"page size of (\d+)", raw).group(1))
                values = {line.split(":")[0]: line.split(":")[1].strip().rstrip(".") for line in raw.splitlines() if ":" in line}
                sample = {"seconds": time.monotonic() - started, "swapouts": int(values["Swapouts"]),
                          "headroom": (max(0, int(values["Pages free"]) - int(values["Pages speculative"])) + int(values["File-backed pages"])) * page,
                          "normal": subprocess.check_output(["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"], text=True, timeout=5).strip() == "1"}
                samples.append(sample)
                (evidence / "watchdog.json").write_text(json.dumps(samples))
                if sample["swapouts"] != swapouts or not sample["normal"] or sample["headroom"] < 2 * 1024**3 or sample["seconds"] > 900:
                    abort.set()
                    return
        except Exception:
            abort.set()

    def gate():
        if abort.is_set():
            raise RuntimeError("Host watchdog refused continuation")

    def probe(label, run, source_path):
        snapshot = call(label, ["graph", "inspect", "--run-id", run, "--json"])
        containers = {r["key"]: r["id"] for r in snapshot["receipt"]["resources"].values() if r["kind"] == "container"}
        build_logs = engine("logs", containers["build"])
        check_logs = engine("logs", containers["check"])
        (evidence / f"{label}-build.log").write_text(build_logs)
        (evidence / f"{label}-check.log").write_text(check_logs)
        build = json.loads(build_logs.strip())
        check = json.loads(check_logs.strip())
        assert check["marker"] == "compiled-source" and len(check["token"]) == 36 and check["requests"] == 200
        web = json.loads(engine("inspect", containers["web"]))[0]
        assert next(m for m in web["Mounts"] if m["Destination"] == "/artifacts")["RW"] is False
        assert next(m for m in web["Mounts"] if m["Destination"] == "/source")["Source"] == source_path
        assert snapshot["observations"]["container:build"] == {"state": "exited", "code": 0}
        return {"ids": containers, "check": check, "build": build}

    before = protected()
    status = call("before", ["runtime", "status", "--json"])
    if status["phase"] != "stopped" or status["process_alive"]:
        raise RuntimeError("A stopped, prepared candidate is required; no existing live pool adopted")
    admission = call("admission", ["runtime", "probe", "--profile", "development", "--json"])
    assert admission["admitted"]
    watcher = threading.Thread(target=watch, args=(admission["swapouts"],), daemon=True)
    watcher.start()
    try:
        running = call("up", ["runtime", "up", "--profile", "development", "--json"], timeout=240)
        socket = running["engine_socket"]
        if not socket.startswith("unix://"):
            socket = "unix://" + socket
        call("image", ["runtime", "load-image", "--archive", args.image_archive, "--sha256", ARCHIVE_SHA, "--image-id", image])
        for case in ["success", "compile-failure", "interrupt", "tamper-on-reuse"]:
            gate()
            source = Path(tempfile.mkdtemp(prefix="hkg-build-")).resolve()
            shutil.copytree(evidence / "fixture", source, dirs_exist_ok=True)
            contract = {"fault": case if case in ["interrupt", "tamper-on-reuse"] else "none", "image": image}
            (source / "contract.json").write_text(json.dumps(contract))
            if case == "compile-failure":
                (source / "server.ts").write_text("export const broken = ;")
            run = uuid.uuid4().hex
            base = ["--project", source, "--file", "compose.yaml"]
            review = call(case + "-plan", ["project", "plan", *base, "--json"])
            assert review["plan"]["enrollment_compatible"]
            assert all(service["image"] == image for service in review["plan"]["services"].values())
            expected = ["--expect-plan", review["plan_id"]]
            call(case + "-sync", ["project", "sync-source", *base, *expected, "--json"])
            publication = call(case + "-publish", ["project", "publish-source", *base, *expected, "--json"])
            graph = ["graph", "run", *base, *expected, "--run-id", run, "--source-revision", publication["revision"],
                     "--ready", "build=completed", "--ready", "init=completed", "--ready", "web=healthy", "--ready", "check=completed", "--timeout-seconds", "30", "--json"]
            active = run
            failed = case in ["compile-failure", "interrupt"]
            call(case + "-run", graph, success=not failed)
            row = {"case": case, "run": run, "project": str(source), "revision": publication["revision"]}
            if not failed:
                first = probe(case + "-first", run, publication["guest_path"])
                assert first["build"]["reused"] is False
                call(case + "-retain", ["graph", "cleanup", "--run-id", run, "--json"])
                gate()
                restore = graph.copy()
                restore[1] = "restore"
                failed = case == "tamper-on-reuse"
                call(case + "-restore", restore, success=not failed)
                row["first"] = first
                if not failed:
                    restored = probe(case + "-restored", run, publication["guest_path"])
                    assert restored["build"]["reused"] is True
                    assert restored["build"]["manifest"] == first["build"]["manifest"] and restored["check"] == first["check"]
                    assert all(restored["ids"][k] != v for k, v in first["ids"].items())
                    row["restored"] = restored
            if failed:
                snap = call(case + "-failed-inspect", ["graph", "inspect", "--run-id", run, "--json"])
                assert snap["receipt"]["phase"] == "failed-retained"
                for name in ["init", "web", "check"]:
                    assert snap["observations"]["container:" + name] == {"state": "absent"}
                    assert snap["receipt"]["resources"]["container:" + name]["id"] is None
                build_id = snap["receipt"]["resources"]["container:build"]["id"]
                # Bun errors use stderr, so capture both streams from this owned container.
                diagnostic = subprocess.run(["docker", "--host", socket, "logs", build_id], capture_output=True, text=True, timeout=30)
                assert diagnostic.returncode == 0
                logs = diagnostic.stdout + diagnostic.stderr
                (evidence / f"{case}-failure.log").write_text(logs)
                assert {"compile-failure": "Unexpected ;", "interrupt": "Injected interruption", "tamper-on-reuse": "Artifact content refused"}[case] in logs
                row["dependents_absent"] = True
            call(case + "-remove", ["graph", "cleanup", "--run-id", run, "--remove-data", "--json"])
            for kind in ["container", "network", "volume"]:
                assert not engine(kind, "ls", "-q", "--filter", "label=io.hack-local.graph=" + run).strip()
            call(case + "-archive", ["graph", "archive", "--run-id", run, "--json"])
            active = None
            row["cleanup_confirmed"] = True
            results.append(row)
            (evidence / "results.json").write_text(json.dumps(results, indent=2))
        gate()
    finally:
        if active:
            try:
                call("failure-cleanup", ["graph", "cleanup", "--run-id", active, "--remove-data", "--json"])
            except Exception:
                pass
        try:
            call("down", ["runtime", "down", "--json"])
            stopped = call("final-status", ["runtime", "status", "--json"])
            assert stopped["phase"] == "stopped" and not stopped["process_alive"]
        finally:
            finished.set()
            watcher.join(timeout=10)
            after = protected()
            (evidence / "protection.json").write_text(json.dumps({"before": before, "after": after, "unchanged": before == after}, indent=2))
            assert before == after
    assert len(results) == 4
    (evidence / "complete.json").write_text(json.dumps({"passed": True, "cases": 4}))
    print(json.dumps({"complete": str(evidence)}), flush=True)


if __name__ == "__main__":
    main()
