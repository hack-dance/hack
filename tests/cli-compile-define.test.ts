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

/** How far a TypeScript argv may extend before or after its `--compile`. */
const ARGV_LIMIT = 20;

function isComment(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("#")
  );
}

/**
 * The lines of the one command a `--compile` belongs to, so a neighbouring
 * compile's definition cannot stand in for a missing one. A TypeScript argv
 * array runs from its `"build"` element to its closing `]`; a shell,
 * Dockerfile or package.json command is its line plus `\`-continued lines.
 */
function commandAt(opts: {
  readonly lines: readonly string[];
  readonly index: number;
  readonly typescript: boolean;
}): string {
  const { lines, index } = opts;
  if (!opts.typescript) {
    let end = index;
    while (
      end < lines.length - 1 &&
      (lines[end] ?? "").trimEnd().endsWith("\\")
    ) {
      end += 1;
    }
    return lines.slice(index, end + 1).join("\n");
  }
  let start = index;
  while (
    start > Math.max(0, index - ARGV_LIMIT) &&
    !(lines[start] ?? "").includes('"build"')
  ) {
    start -= 1;
  }
  let end = index;
  while (
    end < Math.min(lines.length - 1, index + ARGV_LIMIT) &&
    !(lines[end] ?? "").includes("]")
  ) {
    end += 1;
  }
  return lines
    .slice(start, end + 1)
    .filter((line) => !isComment(line))
    .join("\n");
}

function hasDefinition(command: string): boolean {
  return (
    command.includes("CLI_COMPILE_DEFINE_ARGS") ||
    command.includes('OPENTUI_LIBC="glibc"') ||
    command.includes('OPENTUI_LIBC=\\\\\\"glibc\\\\\\"')
  );
}

/** `path:line` of each CLI compile in `text` without the definition. */
function missingDefinitions(opts: {
  readonly path: string;
  readonly text: string;
}): { readonly checked: number; readonly missing: readonly string[] } {
  const lines = opts.text.split("\n");
  const typescript = opts.path.endsWith(".ts");
  const missing: string[] = [];
  let checked = 0;
  for (const [index, line] of lines.entries()) {
    if (!line.includes("--compile") || isComment(line)) {
      continue;
    }
    const command = commandAt({ lines, index, typescript });
    if (!CLI_ENTRIES.some((entry) => command.includes(entry))) {
      continue;
    }
    checked += 1;
    if (!hasDefinition(command)) {
      missing.push(`${opts.path}:${index + 1}`);
    }
  }
  return { checked, missing };
}

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

test("every compile of the CLI defines OPENTUI_LIBC (opentui 0.8 musl branch)", async () => {
  const missing: string[] = [];
  let checked = 0;
  for (const path of trackedFiles()) {
    if (DESCRIPTIONS_ONLY.has(path)) {
      continue;
    }
    const text = await readFile(resolve(REPO, path), "utf8");
    const result = missingDefinitions({ path, text });
    checked += result.checked;
    missing.push(...result.missing);
  }
  expect(missing).toEqual([]);
  // The scan found the known build sites (scripts, Dockerfiles, toolchain, tests).
  expect(checked).toBeGreaterThanOrEqual(15);
});

test("one compile's definition does not cover its neighbour", () => {
  const shell = [
    'if [ -n "$version" ]; then',
    "  bun build index.ts --compile --define 'process.env.OPENTUI_LIBC=\"glibc\"' --outfile a",
    "else",
    "  bun build index.ts --compile --outfile b",
    "fi",
  ].join("\n");
  expect(missingDefinitions({ path: "build.sh", text: shell })).toEqual({
    checked: 2,
    missing: ["build.sh:4"],
  });

  const typescript = [
    "const a = [",
    '  "build",',
    '  "index.ts",',
    '  "--compile",',
    "  ...CLI_COMPILE_DEFINE_ARGS,",
    "];",
    "const b = [",
    '  "build",',
    '  "index.ts",',
    '  "--compile",',
    '  "--outfile",',
    "];",
  ].join("\n");
  expect(missingDefinitions({ path: "build.ts", text: typescript })).toEqual({
    checked: 2,
    missing: ["build.ts:10"],
  });

  const continued = [
    "RUN bun build index.ts --compile \\",
    "  --define 'process.env.OPENTUI_LIBC=\"glibc\"' \\",
    "  --outfile /out/hack",
  ].join("\n");
  expect(missingDefinitions({ path: "Dockerfile", text: continued })).toEqual({
    checked: 1,
    missing: [],
  });
});

test("the shared definition is the glibc libc opentui documents", () => {
  expect(OPENTUI_LIBC_DEFINE).toBe('process.env.OPENTUI_LIBC="glibc"');
});
