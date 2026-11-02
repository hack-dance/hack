import { fstatSync, writeSync } from "node:fs";

if (process.argv[2] === "nested") {
  const originalFd = Number(process.argv[3]);
  const expectedDev = Number(process.argv[4]);
  const expectedInode = Number(process.argv[5]);
  if (!(Number.isInteger(originalFd) && originalFd >= 3 && originalFd <= 255)) {
    throw new Error("Unsupported diagnostic descriptor.");
  }
  const matchesReport = (fd: number): boolean => {
    try {
      const info = fstatSync(fd);
      return info.dev === expectedDev && info.ino === expectedInode;
    } catch (error: unknown) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EBADF"
      ) {
        throw error;
      }
      return false;
    }
  };
  let inherited = matchesReport(originalFd);
  // This is a bounded remap check, not a claim about every possible descriptor.
  for (let fd = 0; fd < 256; fd += 1) {
    inherited ||= matchesReport(fd);
  }
  const descriptorEnvironmentAbsent =
    process.env.HACK_NATIVE_CPU_REPORT_FD === undefined;
  process.exitCode = inherited || !descriptorEnvironmentAbsent ? 1 : 0;
} else {
  const fd = Number(process.env.HACK_NATIVE_CPU_REPORT_FD);
  if (!(Number.isInteger(fd) && fd >= 3 && fd <= 255)) {
    throw new Error("Unsupported diagnostic descriptor.");
  }
  const info = fstatSync(fd);
  const direct =
    info.isFile() &&
    info.uid === process.getuid?.() &&
    (info.mode & 0o777) === 0o600 &&
    info.nlink === 1 &&
    info.size === 0;
  const child = Bun.spawn(
    [
      process.execPath,
      import.meta.path,
      "nested",
      String(fd),
      String(info.dev),
      String(info.ino),
    ],
    {
      env: { PATH: "/usr/bin:/bin" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const nestedAbsent = exitCode === 0 && stdout === "" && stderr === "";
  const report = JSON.stringify({
    directPrivateDescriptor: direct,
    nestedOriginalDescriptorAndScan0to255Absent: nestedAbsent,
    nestedReapedExitCode: exitCode,
  });
  writeSync(fd, report, 0, "utf8");
  process.exitCode = direct && nestedAbsent ? 0 : 1;
}
