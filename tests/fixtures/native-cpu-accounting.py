"""Independent real wait4 accounting; no per-child wrapper or engine activity."""

import json
import os
import subprocess
import sys
import time


def main():
    bun, script, report, scenario = sys.argv[1:]
    descriptor = os.open(report, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
    child = None
    try:
        if not 3 <= descriptor <= 255:
            raise RuntimeError("Diagnostic descriptor index is unsupported.")
        child = subprocess.Popen(
            [bun, script, scenario, report],
            env={"PATH": "/usr/bin:/bin", "HACK_NATIVE_CPU_REPORT_FD": str(descriptor)},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE if scenario == "shell" else subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            pass_fds=(descriptor,),
        )
        deadline = time.monotonic() + 5
        while True:
            try:
                pid, status, usage = os.wait4(child.pid, os.WNOHANG)
            except InterruptedError:
                continue
            if pid:
                child.returncode = os.waitstatus_to_exitcode(status)
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("Diagnostic accounting control exceeded its deadline.")
            time.sleep(0.005)
        if time.monotonic() >= deadline:
            raise RuntimeError("Diagnostic accounting control exceeded its deadline.")
        if child.returncode != 0:
            raise RuntimeError("Diagnostic accounting control failed.")
        size = os.fstat(descriptor).st_size
        if not 0 < size <= 512 * 1024:
            raise RuntimeError("Diagnostic accounting report is incomplete.")
        value = json.loads(os.pread(descriptor, size, 0))
        shell = None
        if scenario == "shell":
            shell = json.loads(child.stdout.read(1024))
        if time.monotonic() >= deadline:
            raise RuntimeError("Diagnostic accounting control exceeded its deadline.")
        print(json.dumps({
            "outerCpuTimeMs": (usage.ru_utime + usage.ru_stime) * 1000,
            "reapedExitCode": child.returncode,
            "report": value,
            "shell": shell,
        }, allow_nan=False))
    finally:
        if child is not None and child.returncode is None:
            # Only the unreaped owned child can be signalled here. Outer test owns
            # the group deadline and independent pipe cancellation.
            child.kill()
            child.wait(timeout=1)
        os.close(descriptor)


if __name__ == "__main__":
    main()
