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
 * Files that only describe a CLI compile in text (this test, the spawn-env
 * audit's reason strings, the compile-flags text checks); they compile no CLI.
 */
const DESCRIPTIONS_ONLY = new Set([
  "tests/cli-compile-define.test.ts",
  "tests/cli-spawn-env-isolation.test.ts",
  // Matches compile lines as text; its own compile builds a probe, not the CLI.
  "tests/cli-compile-flags.test.ts",
  // Its compile samples are scanner inputs (HACK-2727); it compiles nothing.
  "tests/compile-working-directory.test.ts",
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

/** The line at `index` joined with its `\`-continued neighbours, both ways. */
function continuedLines(lines: readonly string[], index: number): string {
  const continues = (at: number) => (lines[at] ?? "").trimEnd().endsWith("\\");
  let start = index;
  while (start > 0 && continues(start - 1)) {
    start -= 1;
  }
  let end = index;
  while (end < lines.length - 1 && continues(end)) {
    end += 1;
  }
  return lines.slice(start, end + 1).join("\n");
}

/**
 * The lines of the one command a `--compile` belongs to, so a neighbouring
 * compile's definition cannot stand in for a missing one. A TypeScript argv
 * array runs from its `"build"` element to its closing `]`; a shell,
 * Dockerfile or package.json command is its line plus `\`-continued lines, before and after.
 */
function commandAt(opts: {
  readonly lines: readonly string[];
  readonly index: number;
  readonly typescript: boolean;
}): string {
  const { lines, index } = opts;
  const line = lines[index] ?? "";
  // A shell, Dockerfile or package.json command, or a TypeScript command
  // string: the line plus its `\`-continuations in both directions.
  if (!opts.typescript || line.includes("bun build")) {
    return continuedLines(lines, index);
  }
  let start = index;
  while (
    start > Math.max(0, index - ARGV_LIMIT) &&
    !(lines[start] ?? "").includes('"build"')
  ) {
    start -= 1;
  }
  if (!(lines[start] ?? "").includes('"build"')) {
    // No argv array found: judge the line alone, never a neighbour's argv.
    return line;
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
    .filter((candidate) => !isComment(candidate))
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

  // The entry on the line before `--compile`, joined by a continuation.
  const split = [
    "  bun build index.ts \\",
    "    --compile --outfile out/hack",
  ].join("\n");
  expect(missingDefinitions({ path: "build.sh", text: split })).toEqual({
    checked: 1,
    missing: ["build.sh:2"],
  });

  // A TypeScript command string is judged by its own line.
  const template = [
    "await $`bun build index.ts --compile --define 'process.env.OPENTUI_LIBC=\"glibc\"' --outfile a`;",
    "await $`bun build index.ts --compile --outfile b`;",
  ].join("\n");
  expect(missingDefinitions({ path: "build.ts", text: template })).toEqual({
    checked: 2,
    missing: ["build.ts:2"],
  });
});

test("the shared definition is the glibc libc opentui documents", () => {
  expect(OPENTUI_LIBC_DEFINE).toBe('process.env.OPENTUI_LIBC="glibc"');
});
