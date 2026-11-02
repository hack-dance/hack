#!/usr/bin/env python3
"""Manual WU02 fixture. Run only on a quiet Apple Silicon host; never invoked by CI.

Owns only a fresh candidate pool. Raw receipts remain below .hack-local/review.
Does not lower admission, use a default Docker context, or force-kill a VM.
The separate crash fixture sends native-identity-verified TERM without guest quiescence.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
LAUNCHER = ROOT / "hack-local"
EVIDENCE = ROOT / ".hack-local/review" / f"lifecycle-{time.time_ns()}"
TIME_LIMIT = 900


def invoke(*arguments, timeout=180):
    started = time.monotonic()
    result = subprocess.run([str(LAUNCHER), *arguments], cwd=ROOT,
                            capture_output=True, text=True, timeout=timeout)
    receipt = {"arguments": arguments, "exit_code": result.returncode,
               "elapsed_seconds": time.monotonic() - started,
               "stdout": result.stdout, "stderr": result.stderr}
    name = f"{time.time_ns()}-{'-'.join(arguments[:2])}.json"
    (EVIDENCE / name).write_text(json.dumps(receipt, indent=2) + "\n")
    if result.returncode:
        raise RuntimeError(f"{arguments}: {result.stderr.strip()}")
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resume-owned-fixture", action="store_true")
    parser.add_argument("--crash-recovery", action="store_true")
    arguments = parser.parse_args()
    os.umask(0o077)
    if EVIDENCE.exists():
        raise RuntimeError("Fixture evidence already exists; do not overwrite a previous attempt.")
    EVIDENCE.mkdir(parents=True, mode=0o700)
    initial = invoke("runtime", "status")
    allowed = ["uninitialized"]
    if arguments.resume_owned_fixture:
        allowed += ["stopped", "stopped-before-engine", "stopped-after-engine-failure", "recovered-unclean"]
    if initial["phase"] not in allowed:
        raise RuntimeError("Fixture requires an uninitialized pool; no existing runtime is adopted.")
    binary = ROOT / ".hack-local/target/release/hack-runtime-candidate"
    (EVIDENCE / "binary.json").write_text(json.dumps({
        "path": str(binary), "sha256": hashlib.sha256(binary.read_bytes()).hexdigest()
    }, indent=2) + "\n")
    finished = threading.Event()
    abort = threading.Event()
    started = time.monotonic()
    samples = []

    def watch():
        initial_swapouts = None
        try:
            while not finished.wait(2):
                vm = subprocess.run(["/usr/bin/vm_stat"], capture_output=True,
                                    text=True, timeout=3, check=True).stdout
                pressure = subprocess.run(["/usr/sbin/sysctl", "-n", "kern.memorystatus_vm_pressure_level"],
                                          capture_output=True, text=True, timeout=3, check=True).stdout.strip()
                values = dict(line.split(":", 1) for line in vm.splitlines()[1:] if ":" in line)
                page_size = int(vm.split("page size of ")[1].split()[0])
                free_bytes = int(values["Pages free"].strip().rstrip(".")) * page_size
                swapouts = int(values["Swapouts"].strip().rstrip("."))
                if initial_swapouts is None:
                    initial_swapouts = swapouts
                elapsed = time.monotonic() - started
                samples.append({"elapsed_seconds": elapsed, "free_bytes": free_bytes,
                                "pressure": pressure, "swapouts": swapouts})
                (EVIDENCE / "watchdog.json").write_text(json.dumps(samples, indent=2) + "\n")
                if free_bytes < 16 * 1024**3 or pressure != "1" or swapouts != initial_swapouts or elapsed >= TIME_LIMIT:
                    abort.set()
                    # The candidate serializes operations. If boot still owns the lock,
                    # main's bounded invocation finishes before its finally cleanup runs.
                    try:
                        invoke("runtime", "down", timeout=90)
                    except Exception as error:
                        (EVIDENCE / "watchdog-stop-error.txt").write_text(str(error) + "\n")
                    return
        except Exception as error:
            abort.set()
            (EVIDENCE / "watchdog-error.txt").write_text(str(error) + "\n")

    watcher = threading.Thread(target=watch, daemon=True)
    watcher.start()
    boots = []
    try:
        if arguments.crash_recovery:
            environment = os.environ.copy()
            environment["HACK_LOCAL_CRASH_FIXTURE_ROOT"] = str(ROOT)
            result = subprocess.run([
                "cargo", "test", "--locked", "--manifest-path", "packages/runtime-core/Cargo.toml",
                "--target-dir", ".hack-local/target", "--lib", "owned_provider_exit_recovery",
                "--", "--ignored", "--nocapture", "--test-threads=1"
            ], cwd=ROOT, env=environment, capture_output=True, text=True, timeout=300)
            (EVIDENCE / "crash-recovery.json").write_text(json.dumps({
                "exit_code": result.returncode, "stdout": result.stdout, "stderr": result.stderr
            }, indent=2) + "\n")
            if result.returncode or abort.is_set() or '"provider_exit_recovered":true' not in result.stdout:
                raise RuntimeError("Owned provider exit recovery did not pass; inspect the receipt.")
            print(json.dumps({"evidence": str(EVIDENCE), "provider_exit_recovered": True}))
            return
        for _ in range(3):
            if abort.is_set():
                raise RuntimeError("Host watchdog refused the next lifecycle.")
            running = invoke("runtime", "up")
            if abort.is_set() or running["phase"] != "running" or running["process_alive"] is not True:
                raise RuntimeError("Runtime did not reach the expected running state.")
            boots.append(running["guest_boot_id"])
            stopped = invoke("runtime", "down", timeout=90)
            if stopped["phase"] != "stopped" or stopped["process_alive"] is not False:
                raise RuntimeError("Runtime did not confirm a clean stop.")
        if len(set(boots)) != 3:
            raise RuntimeError("Expected three different guest boot identities.")
        (EVIDENCE / "result.json").write_text(json.dumps({
            "clean_boot_stop_cycles": 3, "clean_restarts": 2, "guest_boot_ids": boots,
            "owner_marker_checked_on_each_boot": True,
            "scope": "Owned pool, engine ping, data marker and clean restart only. Crash recovery is separate."
        }, indent=2) + "\n")
    finally:
        try:
            final = invoke("runtime", "status", timeout=15)
            if final["process_alive"] is not False:
                invoke("runtime", "down", timeout=90)
        finally:
            finished.set()
            watcher.join(timeout=10)
    print(json.dumps({"evidence": str(EVIDENCE), "clean_restarts": 2}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
