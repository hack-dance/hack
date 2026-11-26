import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runFixtureGitSync } from "./helpers/fixture-git.ts";

/**
 * `bun build --compile` stages its executable as a transient
 * `.<hash>-00000000.bun-build` file in its working directory before renaming
 * it to `--outfile`. A test that compiles with the checkout as its working
 * directory, named or inherited, puts that file in the checkout for the
 * length of the compile. When test files run in parallel, every other file's
 * checkout write guard (HACK-1343) that reads `git status` in that window
 * sees an untracked file and fails a run whose cases all passed (HACK-2727).
 * Each compile must run in a directory the test owns.
 */

const REPO = resolve(import.meta.dir, "..");

/** How far after its `"--compile"` a spawn's own options may name `cwd`. */
const OPTIONS_WINDOW = 30;

/** A `"--compile"` argv element, not a mention in a string or a call. */
const COMPILE_ELEMENT = /(?:^|[[,])\s*"--compile"\s*[,\]]/;

/** A `cwd:` option key. */
const CWD_OPTION = /\bcwd:\s*/;

/**
 * The value expression of the `cwd:` option on `line`, up to its top-level
 * `,` or `}` or the line's end; null when the line names no `cwd`.
 */
function cwdValue(line: string): string | null {
  const match = CWD_OPTION.exec(line);
  if (!match) {
    return null;
  }
  let depth = 0;
  let value = "";
  for (const char of line.slice(match.index + match[0].length)) {
    if (depth === 0 && (char === "," || char === "}")) {
      break;
    }
    if (char === "(" || char === "[") {
      depth += 1;
    } else if (char === ")" || char === "]") {
      depth -= 1;
    }
    value += char;
  }
  return value.trim();
}

/** Working-directory expressions that name the checkout itself. */
const CHECKOUT_CWD =
  /^(?:REPO|REPO_ROOT|ROOT|repository|repoRoot|process\.cwd\(\)|import\.meta\.dir|resolve\(import\.meta\.dir, "\.\."\)|join\(import\.meta\.dir, "\.\."\))$/;

/**
 * Compile sites that may use the checkout. The release build compiles from
 * the repository root as a release step; no test runs it.
 */
const RELEASE_ONLY = new Set(["scripts/build-release.ts"]);

function isComment(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*")
  );
}

/**
 * `path:line` and reason of each compile in `text` whose spawn names no
 * working directory or names the checkout.
 */
function checkoutCompiles(opts: {
  readonly path: string;
  readonly text: string;
}): { readonly checked: number; readonly found: readonly string[] } {
  const lines = opts.text.split("\n");
  const found: string[] = [];
  let checked = 0;
  for (const [index, line] of lines.entries()) {
    if (isComment(line) || !COMPILE_ELEMENT.test(line)) {
      continue;
    }
    checked += 1;
    let cwd: string | null = null;
    for (
      let at = index;
      at < Math.min(lines.length, index + OPTIONS_WINDOW);
      at += 1
    ) {
      const candidate = lines[at] ?? "";
      if (at > index && COMPILE_ELEMENT.test(candidate)) {
        break;
      }
      if (isComment(candidate)) {
        continue;
      }
      cwd = cwdValue(candidate);
      if (cwd !== null) {
        break;
      }
    }
    if (cwd === null) {
      found.push(`${opts.path}:${index + 1} inherits the runner's directory`);
    } else if (CHECKOUT_CWD.test(cwd)) {
      found.push(`${opts.path}:${index + 1} runs in the checkout (${cwd})`);
    }
  }
  return { checked, found };
}

test("no test or script compiles with the checkout as its working directory", async () => {
  const listed = runFixtureGitSync({
    cwd: REPO,
    args: ["ls-files", "-z", "--", "tests/*.ts", "scripts/*.ts"],
  });
  expect(listed.exitCode).toBe(0);
  const found: string[] = [];
  let checked = 0;
  for (const path of listed.stdout.split("\0")) {
    if (path.length === 0 || RELEASE_ONLY.has(path)) {
      continue;
    }
    const text = await readFile(resolve(REPO, path), "utf8");
    const result = checkoutCompiles({ path, text });
    checked += result.checked;
    found.push(...result.found);
  }
  expect(
    found,
    "Run bun build --compile in a directory the test owns: its transient .bun-build lands in the working directory (HACK-2727)."
  ).toEqual([]);
  // The scan reached the known compile sites in tests and scripts.
  expect(checked).toBeGreaterThanOrEqual(9);
});

test("the scan tells an owned working directory from the checkout", () => {
  const owned = [
    "const build = Bun.spawn(",
    '  [process.execPath, "build", entry, "--compile", "--outfile", out],',
    '  { cwd: root, stdout: "pipe" }',
    ");",
  ].join("\n");
  expect(checkoutCompiles({ path: "a.ts", text: owned })).toEqual({
    checked: 1,
    found: [],
  });
  const inherited = [
    "Bun.spawn(",
    "  [",
    "    process.execPath,",
    '    "build",',
    '    "index.ts",',
    '    "--compile",',
    "  ],",
    '  { stdout: "pipe" }',
    ");",
  ].join("\n");
  expect(checkoutCompiles({ path: "b.ts", text: inherited }).found).toEqual([
    "b.ts:6 inherits the runner's directory",
  ]);
  const checkout = [
    'Bun.spawn([process.execPath, "build", "--compile", entry], {',
    '  cwd: resolve(import.meta.dir, ".."),',
    "});",
  ].join("\n");
  expect(checkoutCompiles({ path: "c.ts", text: checkout }).found).toEqual([
    'c.ts:1 runs in the checkout (resolve(import.meta.dir, ".."))',
  ]);
  // A neighbouring compile's cwd does not stand in for a missing one.
  const neighbours = [
    'run(["build", "--compile", a]);',
    'run(["build", "--compile", b], { cwd: root });',
  ].join("\n");
  expect(checkoutCompiles({ path: "d.ts", text: neighbours }).found).toEqual([
    "d.ts:1 inherits the runner's directory",
  ]);
  // Mentions in strings, calls and comments are not compiles.
  const mentions = [
    'if (line.includes("--compile")) {}',
    "const text = '  \"--compile\",';",
    '// ["build", "--compile"]',
  ].join("\n");
  expect(checkoutCompiles({ path: "e.ts", text: mentions }).checked).toBe(0);
});
