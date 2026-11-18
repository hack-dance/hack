import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { OPENTUI_LIBC_DEFINE } from "../scripts/lib/cli-compile-define.ts";
import { runFixtureGitSync } from "./helpers/fixture-git.ts";

const REPO = resolve(import.meta.dir, "..");

/**
 * Entry points that import the CLI, so their compile bundles @opentui/core.
 * Others (the prerelease manager, the MCP socket backend, the interactive
 * frontend fixture) compile without the definition.
 */
const CLI_ENTRIES = ["index.ts", "update-recovery-cli.ts", "v4-upgrade-cli.ts"];

/**
 * Files that only describe a compile in text (this test, and the spawn-env
 * audit's reason strings); they run no `bun build`.
 */
const DESCRIPTIONS_ONLY = new Set([
  "tests/cli-compile-define.test.ts",
  "tests/cli-spawn-env-isolation.test.ts",
]);

/** Lines around a `--compile` that belong to the same command. */
const WINDOW = 14;

function trackedFiles(): string[] {
  const out = runFixtureGitSync({ cwd: REPO, args: ["ls-files", "-z"] });
  if (out.exitCode !== 0) {
    throw new Error("git ls-files failed");
  }
  return out.stdout.split("\0").filter((path) => {
    if (path.length === 0 || path.startsWith("docs/")) {
      return false;
    }
    const name = basename(path);
    return (
      /\.(ts|sh)$/.test(name) ||
      name.startsWith("Dockerfile") ||
      name === "package.json" ||
      path.startsWith(".hack/")
    );
  });
}

function isComment(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("#")
  );
}

test("every compile of the CLI defines OPENTUI_LIBC (opentui 0.8 musl branch)", async () => {
  const missing: string[] = [];
  let checked = 0;
  for (const path of trackedFiles()) {
    if (DESCRIPTIONS_ONLY.has(path)) {
      continue;
    }
    const lines = (await readFile(resolve(REPO, path), "utf8")).split("\n");
    for (const [index, line] of lines.entries()) {
      if (!line.includes("--compile") || isComment(line)) {
        continue;
      }
      const window = lines
        .slice(Math.max(0, index - WINDOW), index + WINDOW)
        .filter((candidate) => !isComment(candidate))
        .join("\n");
      if (!CLI_ENTRIES.some((entry) => window.includes(entry))) {
        continue;
      }
      checked += 1;
      if (
        !(
          window.includes("CLI_COMPILE_DEFINE_ARGS") ||
          window.includes('OPENTUI_LIBC="glibc"') ||
          window.includes('OPENTUI_LIBC=\\\\\\"glibc\\\\\\"')
        )
      ) {
        missing.push(`${path}:${index + 1}`);
      }
    }
  }
  expect(missing).toEqual([]);
  // The scan found the known build sites (scripts, Dockerfiles, toolchain, tests).
  expect(checked).toBeGreaterThanOrEqual(15);
});

test("the shared definition is the glibc libc opentui documents", () => {
  expect(OPENTUI_LIBC_DEFINE).toBe('process.env.OPENTUI_LIBC="glibc"');
});
