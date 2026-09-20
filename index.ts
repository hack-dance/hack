#!/usr/bin/env bun

import {
  runTtySupervisor,
  TTY_SUPERVISOR_ARGUMENT,
} from "./src/lib/tty-supervisor.ts";

if (Bun.argv[2] === TTY_SUPERVISOR_ARGUMENT && process.send) {
  process.exit(await runTtySupervisor());
}
const { runCli } = await import("./packages/cli/index.ts");
process.exitCode = await runCli(Bun.argv.slice(2));
