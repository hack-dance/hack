#!/usr/bin/env bun

import { resolve } from "node:path";

interface LintConfig {
  readonly cwd: string;
  readonly configFiles: readonly string[];
}

const repoRoot = resolve(import.meta.dir, "..");
const config = {
  cwd: repoRoot,
  configFiles: ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs"],
} satisfies LintConfig;

const hasConfig = await hasAnyConfig(config);
if (hasConfig) {
  const exitCode = await runEslint({ cwd: config.cwd });
  process.exitCode = exitCode;
} else {
  process.stdout.write("lint: no ESLint config found; skipping.\n");
  process.exitCode = 0;
}

async function hasAnyConfig({
  cwd,
  configFiles,
}: LintConfig): Promise<boolean> {
  for (const file of configFiles) {
    const path = resolve(cwd, file);
    const exists = await fileExists({ path });
    if (exists) {
      return true;
    }
  }
  return false;
}

async function fileExists({
  path,
}: {
  readonly path: string;
}): Promise<boolean> {
  try {
    await Bun.file(path).stat();
    return true;
  } catch {
    return false;
  }
}

async function runEslint({ cwd }: { readonly cwd: string }): Promise<number> {
  const proc = Bun.spawn(["bunx", "eslint", ".", "--max-warnings=0"], {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}
