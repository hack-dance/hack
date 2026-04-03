#!/usr/bin/env bun

import { resolve } from "node:path";

import { detectHackInstall } from "../src/lib/self-update.ts";

const CLI_NAME = "hack";
const DEFAULT_INSTALL_DIR_RELATIVE = ".hack/bin";

const home = (process.env.HOME ?? "").trim();
if (home.length === 0) {
  process.stderr.write("HOME is not set; cannot determine install status.\n");
  process.exit(1);
}

const defaultTargetPath = resolve(home, DEFAULT_INSTALL_DIR_RELATIVE, CLI_NAME);
const candidates = resolveCandidatePaths({ defaultTargetPath });

for (const candidate of candidates) {
  const install = await detectHackInstall({ path: candidate });
  if (install.status === "missing") {
    continue;
  }

  if (install.kind === "homebrew") {
    process.stdout.write("Install mode: homebrew\n");
    process.stdout.write(`Path: ${install.path}\n`);
    if (install.linkTarget) {
      process.stdout.write(`Target: ${install.linkTarget}\n`);
    }
    process.exit(0);
  }

  if (install.kind === "symlink") {
    process.stdout.write("Install mode: bin (symlink)\n");
    process.stdout.write(`Path: ${install.path}\n`);
    process.stdout.write(`Target: ${install.linkTarget}\n`);
    process.exit(0);
  }

  if (install.kind === "dev-wrapper") {
    process.stdout.write("Install mode: dev (wrapper)\n");
    process.stdout.write(`Path: ${install.path}\n`);
    process.exit(0);
  }

  process.stdout.write("Install mode: release (standalone)\n");
  process.stdout.write(`Path: ${install.path}\n`);
  process.exit(0);
}

process.stdout.write("No install found at:\n");
for (const candidate of candidates) {
  process.stdout.write(`  ${candidate}\n`);
}
process.exit(0);

function resolveCandidatePaths({
  defaultTargetPath,
}: {
  readonly defaultTargetPath: string;
}): string[] {
  const out: string[] = [];
  const which = Bun.which(CLI_NAME);
  if (typeof which === "string" && which.trim().length > 0) {
    out.push(resolve(which));
  }

  out.push(defaultTargetPath);
  return [...new Set(out)];
}
