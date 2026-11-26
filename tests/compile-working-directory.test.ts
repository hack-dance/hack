import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { runFixtureGitSync } from "./helpers/fixture-git.ts";

/**
 * Every Bun compile in `tests/` and `scripts/` runs in a working directory
 * its test owns (HACK-2727).
 *
 * `bun build --compile` and `Bun.build({ compile })` stage the executable as
 * a transient `.<hash>-<n>.bun-build` file in the compiling process's working
 * directory before renaming it to the outfile. A compile that runs with the
 * checkout as that directory, named or inherited, puts the file in the
 * checkout for the length of the compile. When test files run in parallel,
 * every other file's checkout write guard (HACK-1343) that reads `git status`
 * in that window sees an untracked file and fails a run whose cases all
 * passed.
 *
 * The check parses each file and finds:
 * - an argv array with a `"--compile"` element, or a single command string
 *   such as `"bun build x --compile"` passed to a spawn: the spawn call that
 *   receives it must name `cwd` in its own options, and that `cwd` must not
 *   name the checkout;
 * - a Bun shell `` $`bun build ... --compile` ``: it must chain `.cwd(...)`
 *   to a directory that is not the checkout;
 * - `Bun.build({ compile })`: it compiles in its own process. A test file or
 *   helper runs in the test runner's process, whose working directory is the
 *   checkout, so it must spawn the compile instead; a fixture or script run
 *   as its own process must `process.chdir` to an owned directory first.
 */

const REPO = resolve(import.meta.dir, "..");
const SELF = "tests/compile-working-directory.test.ts";

/**
 * Compile sites that may use the checkout. The release build compiles from
 * the repository root as a release step; no test runs it.
 */
const RELEASE_ONLY = new Set(["scripts/build-release.ts"]);

/** Calls that run a command string as a child process. */
const SPAWNERS =
  /^(?:spawn|spawnSync|spawnSyncBounded|exec|execSync|execFile|execFileSync|run|runCommand)$/;

/** Identifiers that conventionally hold the checkout root. */
const CHECKOUT_NAMES =
  /^(?:ROOT|REPO|REPO_ROOT|REPOSITORY|repo|repository|repoRoot|checkout|CHECKOUT|checkoutRoot|CHECKOUT_ROOT)$/;

/** Expressions that resolve inside the checkout or to the runner's cwd. */
const CHECKOUT_REFERENCE =
  /import\.meta\.(?:dir|dirname|path|url)|process\.cwd\(\)|__dirname/;

/** A command string that compiles with Bun. */
const COMMAND_COMPILE = /\bbuild\b[\s\S]*--compile\b/;

function stringText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return node.getText();
  }
  return null;
}

/** Whether `expression` names the checkout or a directory inside it. */
function namesCheckout(expression: ts.Node): boolean {
  if (CHECKOUT_REFERENCE.test(expression.getText())) {
    return true;
  }
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && CHECKOUT_NAMES.test(node.text)) {
      found = true;
    }
    if (!found) {
      ts.forEachChild(node, visit);
    }
  };
  visit(expression);
  return found;
}

/** The last name of a call's callee: `spawn` for `Bun.spawn` or `cp.spawn`. */
function calleeName(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  return "";
}

/**
 * The call that receives `node` as an argument, directly, as a property of
 * an object literal argument (`{ cmd: [...] }`), or as an element of an array
 * argument (`["sh", "-c", "bun build ..."]`); null when `node` is not passed
 * straight to a call.
 */
function receivingCall(node: ts.Node): ts.CallExpression | null {
  let current = node;
  for (let depth = 0; depth < 4; depth += 1) {
    const parent = current.parent;
    if (!parent) {
      return null;
    }
    if (
      ts.isCallExpression(parent) &&
      parent.arguments.some((argument) => argument === current)
    ) {
      return parent;
    }
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isArrayLiteralExpression(parent)
    ) {
      current = parent;
      continue;
    }
    if (
      ts.isPropertyAssignment(parent) &&
      ts.isObjectLiteralExpression(parent.parent)
    ) {
      current = parent.parent;
      continue;
    }
    return null;
  }
  return null;
}

/** The `cwd` option a call names in its own object literal arguments. */
function cwdOption(call: ts.CallExpression): ts.Node | null {
  for (const argument of call.arguments) {
    if (!ts.isObjectLiteralExpression(argument)) {
      continue;
    }
    for (const property of argument.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        property.name.getText() === "cwd"
      ) {
        return property.initializer;
      }
      if (
        ts.isShorthandPropertyAssignment(property) &&
        property.name.text === "cwd"
      ) {
        return property.name;
      }
    }
  }
  return null;
}

/** The directory a Bun shell command chains with `.cwd(...)`, if any. */
function shellCwd(node: ts.TaggedTemplateExpression): ts.Node | null {
  let current: ts.Node = node;
  for (;;) {
    const parent = current.parent;
    if (
      parent &&
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === current
    ) {
      const call = parent.parent;
      if (!(call && ts.isCallExpression(call) && call.expression === parent)) {
        return null;
      }
      if (parent.name.text === "cwd") {
        return call.arguments[0] ?? null;
      }
      current = call;
      continue;
    }
    return null;
  }
}

function hasCompileProperty(call: ts.CallExpression): boolean {
  return call.arguments.some(
    (argument) =>
      ts.isObjectLiteralExpression(argument) &&
      argument.properties.some(
        (property) =>
          (ts.isPropertyAssignment(property) ||
            ts.isShorthandPropertyAssignment(property)) &&
          property.name.getText() === "compile" &&
          !(
            ts.isPropertyAssignment(property) &&
            property.initializer.kind === ts.SyntaxKind.FalseKeyword
          )
      )
  );
}

/**
 * `path:line` and reason of each compile in `text` that runs, or may run,
 * with the checkout as its working directory.
 */
function checkoutCompiles(opts: {
  readonly path: string;
  readonly text: string;
}): { readonly checked: number; readonly found: readonly string[] } {
  const source = ts.createSourceFile(
    opts.path,
    opts.text,
    ts.ScriptTarget.Latest,
    true
  );
  const ownProcess = !(
    opts.path.endsWith(".test.ts") || opts.path.startsWith("tests/helpers/")
  );
  const found: string[] = [];
  let checked = 0;
  const at = (node: ts.Node, reason: string): void => {
    const line =
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    found.push(`${opts.path}:${line} ${reason}`);
  };
  const judgeCall = (node: ts.Node, call: ts.CallExpression): void => {
    const cwd = cwdOption(call);
    if (cwd === null) {
      at(node, "names no cwd, so it inherits the runner's directory");
    } else if (namesCheckout(cwd)) {
      at(node, `runs in the checkout (${cwd.getText()})`);
    }
  };
  /** `process.chdir` targets in source order, as the walk reaches them. */
  const chdirTargets: (ts.Node | null)[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isArrayLiteralExpression(node) &&
      node.elements.some((element) => stringText(element) === "--compile")
    ) {
      checked += 1;
      const call = receivingCall(node);
      if (call === null) {
        at(
          node,
          "is not passed straight to its spawn, so its cwd cannot be checked"
        );
      } else {
        judgeCall(node, call);
      }
    } else if (ts.isTaggedTemplateExpression(node)) {
      if (COMMAND_COMPILE.test(node.template.getText())) {
        checked += 1;
        const cwd = shellCwd(node);
        if (cwd === null) {
          at(node, "is a Bun shell compile without .cwd(...)");
        } else if (namesCheckout(cwd)) {
          at(node, `runs in the checkout (${cwd.getText()})`);
        }
      }
      return;
    } else if (
      ts.isCallExpression(node) &&
      node.expression.getText() === "Bun.build" &&
      hasCompileProperty(node)
    ) {
      checked += 1;
      if (ownProcess) {
        // The latest `process.chdir` earlier in the file sets the directory.
        const target = chdirTargets.at(-1);
        if (target === undefined) {
          at(node, "compiles in its process's cwd without process.chdir first");
        } else if (target === null || namesCheckout(target)) {
          at(
            node,
            `changes into the checkout (${target?.getText() ?? "no target"}) before compiling`
          );
        }
      } else {
        at(
          node,
          "compiles in the test runner's process, whose cwd is the checkout"
        );
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.getText() === "process.chdir"
    ) {
      chdirTargets.push(node.arguments[0] ?? null);
    } else {
      const text = stringText(node);
      if (text !== null && text !== "--compile" && COMMAND_COMPILE.test(text)) {
        const call = receivingCall(node);
        if (call !== null && SPAWNERS.test(calleeName(call))) {
          checked += 1;
          judgeCall(node, call);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { checked, found };
}

// Budget (60 s, below): the scan waits on no timer. It reads and parses every
// tracked TypeScript file under tests/ and scripts/ (over a thousand), so its
// wall time is CPU and file-system work that grows with host load: about 1 s
// alone, and past Bun's 5 s default once in ten rounds beside the suite's
// compile-heavy files (HACK-2727). A hang guard, not a speed assertion.
test("no test or script compiles with the checkout as its working directory", async () => {
  const listed = runFixtureGitSync({
    cwd: REPO,
    args: ["ls-files", "-z", "--", "tests/*.ts", "scripts/*.ts"],
  });
  expect(listed.exitCode).toBe(0);
  const found: string[] = [];
  let checked = 0;
  for (const path of listed.stdout.split("\0")) {
    if (path.length === 0 || path === SELF || RELEASE_ONLY.has(path)) {
      continue;
    }
    const text = await readFile(resolve(REPO, path), "utf8");
    const result = checkoutCompiles({ path, text });
    checked += result.checked;
    found.push(...result.found);
  }
  expect(
    found,
    "Compile in a directory the test owns: Bun stages a transient .bun-build in the compiling process's working directory (HACK-2727)."
  ).toEqual([]);
  // The scan reached the known compile sites in tests, fixtures and scripts.
  expect(checked).toBeGreaterThanOrEqual(11);
}, 60_000);

test("the scan binds cwd to the spawn that runs the compile", () => {
  const scan = (text: string) =>
    checkoutCompiles({ path: "tests/a.test.ts", text }).found;
  expect(
    scan(
      'Bun.spawn([process.execPath, "build", e, "--compile"], { cwd: root });'
    )
  ).toEqual([]);
  expect(
    scan(
      'children.run({ cmd: [process.execPath, "build", e, "--compile"], cwd: opts.fixture });'
    )
  ).toEqual([]);
  expect(scan('Bun.spawn(["bun", "build", "index.ts", "--compile"]);')).toEqual(
    ["tests/a.test.ts:1 names no cwd, so it inherits the runner's directory"]
  );
  // A later spawn's cwd does not stand in for this one's.
  expect(
    scan(
      [
        'Bun.spawn(["bun", "build", a, "--compile"], { stdout: "pipe" });',
        'Bun.spawn(["true"], { cwd: root });',
      ].join("\n")
    )
  ).toEqual([
    "tests/a.test.ts:1 names no cwd, so it inherits the runner's directory",
  ]);
  // Options passed as a variable are not followed.
  expect(
    scan('Bun.spawn(["bun", "build", a, "--compile"], options);')
  ).toHaveLength(1);
  // An argv held in a variable cannot be tied to its spawn.
  expect(scan('const commands = [["bun", "build", a, "--compile"]];')).toEqual([
    "tests/a.test.ts:1 is not passed straight to its spawn, so its cwd cannot be checked",
  ]);
});

test("the scan recognizes every name of the checkout", () => {
  const scan = (cwd: string) =>
    checkoutCompiles({
      path: "tests/a.test.ts",
      text: `Bun.spawn(["bun", "build", a, "--compile"], { cwd: ${cwd} });`,
    }).found;
  for (const cwd of [
    "REPO",
    "REPO_ROOT",
    "ROOT",
    "repository",
    "repoRoot",
    "checkout",
    "process.cwd()",
    "import.meta.dir",
    "dirname(import.meta.dir)",
    'resolve(import.meta.dir, "..")',
    'resolve(import.meta.dir, "../..")',
    'join(import.meta.dir, "fixtures")',
    'join(REPO, "tests")',
    'new URL("..", import.meta.url).pathname',
  ]) {
    expect(scan(cwd)).toEqual([
      `tests/a.test.ts:1 runs in the checkout (${cwd})`,
    ]);
  }
  for (const cwd of [
    "root",
    "f.root",
    "dirname(target)",
    "buildRoot",
    "directory",
  ]) {
    expect(scan(cwd)).toEqual([]);
  }
});

test("the scan covers command strings, Bun shell and Bun.build", () => {
  const scan = (path: string, text: string) =>
    checkoutCompiles({ path, text }).found;
  expect(
    scan(
      "tests/a.test.ts",
      'execSync("bun build index.ts --compile --outfile x");'
    )
  ).toHaveLength(1);
  expect(
    scan(
      "tests/a.test.ts",
      'spawnSyncBounded(["sh", "-c", "bun build index.ts --compile"], { cwd: REPO, timeout: 1 });'
    )
  ).toEqual(["tests/a.test.ts:1 runs in the checkout (REPO)"]);
  expect(
    scan(
      "tests/a.test.ts",
      "await $`bun build index.ts --compile --outfile ${out}`;"
    )
  ).toEqual(["tests/a.test.ts:1 is a Bun shell compile without .cwd(...)"]);
  expect(
    scan(
      "tests/a.test.ts",
      "await $`bun build index.ts --compile`.quiet().cwd(root);"
    )
  ).toEqual([]);
  expect(
    scan(
      "tests/a.test.ts",
      "await $`bun build index.ts --compile`.cwd(import.meta.dir);"
    )
  ).toEqual(["tests/a.test.ts:1 runs in the checkout (import.meta.dir)"]);
  const inProcess =
    "await Bun.build({ entrypoints: [e], compile: { outfile: o } });";
  expect(scan("tests/a.test.ts", inProcess)).toEqual([
    "tests/a.test.ts:1 compiles in the test runner's process, whose cwd is the checkout",
  ]);
  expect(scan("tests/fixtures/b.ts", inProcess)).toEqual([
    "tests/fixtures/b.ts:1 compiles in its process's cwd without process.chdir first",
  ]);
  expect(
    scan("tests/fixtures/b.ts", `process.chdir(dirname(o));\n${inProcess}`)
  ).toEqual([]);
  expect(
    scan(
      "tests/fixtures/b.ts",
      `process.chdir(resolve(import.meta.dir, ".."));\n${inProcess}`
    )
  ).toEqual([
    'tests/fixtures/b.ts:2 changes into the checkout (resolve(import.meta.dir, "..")) before compiling',
  ]);
  // The latest chdir before the compile decides; a later one does not count.
  expect(
    scan(
      "tests/fixtures/b.ts",
      `process.chdir(REPO);\nprocess.chdir(dirname(o));\n${inProcess}\nprocess.chdir(REPO);`
    )
  ).toEqual([]);
  expect(
    scan(
      "tests/fixtures/b.ts",
      `process.chdir(dirname(o));\nprocess.chdir(REPO);\n${inProcess}`
    )
  ).toEqual([
    "tests/fixtures/b.ts:3 changes into the checkout (REPO) before compiling",
  ]);
  // A bundle without compile writes no .bun-build.
  expect(
    scan("tests/a.test.ts", "await Bun.build({ entrypoints: [e] });")
  ).toEqual([]);
  // Mentions in prose, assertions and comments are not compiles.
  expect(
    checkoutCompiles({
      path: "tests/a.test.ts",
      text: [
        'const reason = "bun build --compile of index.ts";',
        'expect(text).toContain("bun build index.ts --compile");',
        'if (line.includes("--compile")) {}',
        '// Bun.spawn(["bun", "build", "--compile"])',
      ].join("\n"),
    }).checked
  ).toBe(0);
});
