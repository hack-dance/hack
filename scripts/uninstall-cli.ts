#!/usr/bin/env bun

import { lstat, rm } from "node:fs/promises";
import { resolve } from "node:path";

const CLI_NAME = "hack" as const;
const home = (process.env.HOME ?? "").trim();
if (home.length === 0) {
  process.stderr.write(
    "HOME is not set; cannot determine install directory.\n"
  );
  process.exitCode = 1;
} else {
  const installDir = resolve(home, ".hack/bin");
  const targetPath = resolve(installDir, CLI_NAME);

  const exists = await pathExists(targetPath);
  if (exists) {
    await rm(targetPath, { force: true });
    process.stdout.write(`Removed '${CLI_NAME}' from ${targetPath}\n`);
    process.exitCode = 0;
  } else {
    process.stdout.write(`No '${CLI_NAME}' found at ${targetPath}\n`);
    process.exitCode = 0;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
