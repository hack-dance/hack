#!/usr/bin/env bun

import {
  finishNativeCpuDiagnostics,
  initializeNativeCpuDiagnostics,
} from "./src/lib/native-cpu-diagnostics.ts";
import {
  runTtySupervisor,
  TTY_SUPERVISOR_ARGUMENT,
} from "./src/lib/tty-supervisor.ts";

if (Bun.argv[2] === TTY_SUPERVISOR_ARGUMENT && process.send) {
  process.exit(await runTtySupervisor());
}
if (Bun.argv[2] === "--internal-lifecycle-process-client") {
  if (Bun.argv.length !== 4 || !Bun.argv[3]) {
    process.exit(2);
  }
  const { runLifecycleProcessClient } = await import(
    "./src/lib/lifecycle-process-delivery.ts"
  );
  try {
    process.exit(await runLifecycleProcessClient(Bun.argv[3]));
  } catch {
    process.stderr.write(
      "Lifecycle process delivery refused; values omitted.\n"
    );
    process.exit(1);
  }
}
if (Bun.argv[2] === "--internal-native-https-owner") {
  if (Bun.argv.length !== 4 || !Bun.argv[3]) {
    process.exit(2);
  }
  const { runNativeHttpsOwner } = await import(
    "./src/backends/native-https-owner.ts"
  );
  process.exit(await runNativeHttpsOwner({ configurationPath: Bun.argv[3] }));
}
initializeNativeCpuDiagnostics();
try {
  const { runCli } = await import("./packages/cli/index.ts");
  process.exitCode = await runCli(Bun.argv.slice(2));
} finally {
  finishNativeCpuDiagnostics(
    typeof process.exitCode === "number" ? process.exitCode : undefined
  );
}
