#!/usr/bin/env bun

import { runCli } from "./cli/run.ts"

// Prefer Bun.argv for Bun-native CLIs
const exitCode = await runCli(Bun.argv.slice(2))
process.exitCode = exitCode
