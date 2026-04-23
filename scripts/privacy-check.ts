#!/usr/bin/env bun

import { resolve } from "node:path";
import {
  collectPrivacyFindings,
  type PrivacyFinding,
  shouldSkipPrivacyCheckFile,
} from "../src/lib/privacy-check.ts";

type CommandResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
};

const repoRoot = resolve(import.meta.dir, "..");

const files = await listTrackedFiles({ cwd: repoRoot });
const findings: PrivacyFinding[] = [];

for (const filePath of files) {
  if (shouldSkipPrivacyCheckFile({ filePath })) {
    continue;
  }
  const absolutePath = resolve(repoRoot, filePath);
  const file = Bun.file(absolutePath);
  const stats = await file.stat().catch(() => null);
  if (stats === null) {
    continue;
  }
  if (typeof stats.isFile === "function" && !stats.isFile()) {
    continue;
  }
  if (stats.size > 2_000_000) {
    continue;
  }
  const content = await file.text();
  if (content.includes("\u0000")) {
    continue;
  }
  findings.push(...collectPrivacyFindings({ filePath, content }));
}

if (findings.length > 0) {
  process.stderr.write(
    `privacy-check: found ${findings.length} potential personal identifiers.\n`
  );
  for (const finding of findings) {
    process.stderr.write(
      `- ${finding.filePath}:${finding.lineNumber} [${finding.kind}] ${finding.snippet}\n`
    );
  }
  process.stderr.write(
    "\nUse neutral placeholders (for example `<repo>`, `<mission-dir>`, `<tmp>`, or remote-user@198.51.100.42) before commit.\n"
  );
  process.exitCode = 1;
} else {
  process.stdout.write("privacy-check: ok\n");
}

/**
 * Returns tracked repository files so privacy checks only evaluate committed sources.
 */
async function listTrackedFiles({
  cwd,
}: {
  readonly cwd: string;
}): Promise<readonly string[]> {
  const result = await runCommand({
    cwd,
    command: ["git", "ls-files", "-z"],
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Unable to enumerate tracked files: ${result.stderr.trim()}`
    );
  }
  return result.stdout
    .split("\u0000")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Runs a shell command with inherited environment and captured output.
 */
async function runCommand({
  cwd,
  command,
}: {
  readonly cwd: string;
  readonly command: readonly string[];
}): Promise<CommandResult> {
  const proc = Bun.spawn({
    cmd: [...command],
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return {
    stdout,
    stderr,
    exitCode,
  };
}
