#!/usr/bin/env bun

import { runCli } from "./packages/cli/index.ts";
import {
  runTtySupervisor,
  TTY_SUPERVISOR_ARGUMENT,
} from "./src/lib/tty-supervisor.ts";

const exitCode =
  Bun.argv[2] === TTY_SUPERVISOR_ARGUMENT && process.send
    ? await runTtySupervisor()
    : await runCli(Bun.argv.slice(2));
if (Bun.argv[2] === TTY_SUPERVISOR_ARGUMENT && process.send) {
  process.exit(exitCode);
}
process.exitCode = exitCode;
