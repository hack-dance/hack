#!/usr/bin/env bun

import { runCli } from "./src/cli/run.ts";

const exitCode = await runCli(Bun.argv.slice(2));
process.exitCode = exitCode;
