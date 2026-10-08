"""Check direct launch, original nested FD, and nested descriptor indexes 0..255."""

import json
import os
import subprocess
import sys


def main():
    bun, script, report = sys.argv[1:]
    descriptor = os.open(report, os.O_RDWR | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        if not 3 <= descriptor <= 255:
            raise RuntimeError("Diagnostic descriptor index is unsupported.")
        child = subprocess.Popen(
            [bun, script],
            env={"PATH": "/usr/bin:/bin", "HACK_NATIVE_CPU_REPORT_FD": str(descriptor)},
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            pass_fds=(descriptor,),
        )
        try:
            stdout, stderr = child.communicate(timeout=5)
        except BaseException:
            child.kill()
            child.communicate()
            raise
        if child.returncode != 0 or stdout or stderr:
            raise RuntimeError("Diagnostic descriptor control failed.")
        size = os.fstat(descriptor).st_size
        if not 0 < size <= 1024:
            raise RuntimeError("Diagnostic descriptor control failed.")
        value = json.loads(os.pread(descriptor, size, 0))
        print(json.dumps(value, sort_keys=True))
    finally:
        os.close(descriptor)


if __name__ == "__main__":
    main()
