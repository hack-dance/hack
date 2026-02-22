#!/usr/bin/env bun

import { runCli } from "./packages/cli/index.ts";

const exitCode = await runCli(Bun.argv.slice(2));
process.exitCode = exitCode;
