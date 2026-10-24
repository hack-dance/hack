import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClosedCliError } from "../src/lib/cli-result.ts";
import {
  assertNoCheckoutWrites,
  checkoutStatusEntries,
  newStatusEntries,
} from "./helpers/checkout-write-guard.ts";
import { expectClosedThrow } from "./helpers/closed-refusal.ts";
import { fixtureChildren } from "./helpers/fixture-children.ts";
import { fixtureGitEnv } from "./helpers/fixture-git.ts";
import { requireFixtureRoot } from "./helpers/fixture-root.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1343: a CLI call that outlived its timed-out test resolved an emptied
 * fixture root against the checkout and wrote `docker-client/config.json`
 * there, and a child spawned with a `null` cwd ran `prepare-release` in the
 * checkout. These cases cover the defences: path and spawn helpers refuse an
 * empty or relative root, closed, and the bun-test preload fails a run that
 * creates or changes a file in the checkout. Every child runs in a private
 * temp directory, so even a regressed helper cannot write into the repository.
 */

const HELPERS = resolve(import.meta.dir, "helpers");
const CLI_RESULT = resolve(import.meta.dir, "..", "src/lib/cli-result.ts");
/** Each case starts a fresh `bun` child; a cold start under suite load is slow. */
const CHILD_TEST_TIMEOUT_MS = 60_000;

let root = "";

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack-write-guard-")));
});

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = "";
  }
});

const fixture = (): string =>
  requireFixtureRoot(root, "checkout-write-guard fixture");

async function run(opts: {
  readonly argv: readonly string[];
  readonly cwd: string;
  /** The complete child environment; defaults to the private CLI env. */
  readonly env?: Record<string, string>;
}): Promise<{ readonly exitCode: number; readonly output: string }> {
  const child = Bun.spawn([...opts.argv], {
    cwd: opts.cwd,
    env: opts.env ?? privateCliEnv({ root: fixture(), env: { NO_COLOR: "1" } }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}

/**
 * A git work tree. Files named in `committed` are written and committed;
 * every other file in it is untracked.
 */
async function gitCheckout(
  name: string,
  committed: Readonly<Record<string, string>> = {}
): Promise<string> {
  const checkout = join(fixture(), name);
  await mkdir(checkout);
  const init = await run({
    env: fixtureGitEnv(),
    argv: ["git", "init", "-q"],
    cwd: checkout,
  });
  expect(init.exitCode).toBe(0);
  const files = Object.keys(committed);
  if (files.length === 0) {
    return checkout;
  }
  for (const file of files) {
    await writeFile(join(checkout, file), committed[file] ?? "");
  }
  const add = await run({
    env: fixtureGitEnv(),
    argv: ["git", "add", "--", ...files],
    cwd: checkout,
  });
  expect(add.exitCode).toBe(0);
  const commit = await run({
    env: fixtureGitEnv(),
    argv: [
      "git",
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "fixture",
    ],
    cwd: checkout,
  });
  expect(commit.output).toBe("");
  expect(commit.exitCode).toBe(0);
  return checkout;
}

const gitRunner = (): {
  readonly git: string;
  readonly env: Record<string, string>;
} => {
  const env = privateCliEnv({ root: fixture() });
  const git = Bun.which("git", { PATH: env.PATH ?? "" });
  if (!git) {
    throw new Error("git is required for the checkout write guard tests.");
  }
  return { git, env: { ...env, GIT_OPTIONAL_LOCKS: "0" } };
};

test("requireFixtureRoot refuses an empty, relative or missing root, closed", () => {
  for (const value of ["", "relative/root", ".", null, undefined]) {
    expectClosedThrow(
      () => requireFixtureRoot(value, "owner"),
      "owner: the fixture root is not an absolute path"
    );
  }
  expect(requireFixtureRoot("/absolute/root", "owner")).toBe("/absolute/root");
});

test(
  "env helpers refuse an emptied root before writing anything to the current directory",
  async () => {
    // The late-call shape from HACK-1343, in a child whose current directory
    // is an empty temp directory standing in for the checkout.
    const cwd = join(fixture(), "cwd");
    await mkdir(cwd);
    const script = `
      import { ClosedCliError } from ${JSON.stringify(CLI_RESULT)};
      import { isolatedDockerClientEnv } from ${JSON.stringify(join(HELPERS, "docker-client.ts"))};
      import { privateCliEnv } from ${JSON.stringify(join(HELPERS, "private-cli-env.ts"))};
      const calls = [
        () => privateCliEnv({ root: "" }),
        () => privateCliEnv({ root: "fixture" }),
        () => privateCliEnv({ root: process.cwd(), home: "user-home" }),
        () => isolatedDockerClientEnv(""),
      ];
      const outcomes = calls.map((call) => {
        try {
          call();
          return "returned";
        } catch (error) {
          return error instanceof ClosedCliError ? "closed" : "other";
        }
      });
      console.log(JSON.stringify(outcomes));
    `;
    const result = await run({
      argv: [process.execPath, "-e", script],
      cwd,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output.trim())).toEqual([
      "closed",
      "closed",
      "closed",
      "closed",
    ]);
    expect(await readdir(cwd)).toEqual([]);
  },
  CHILD_TEST_TIMEOUT_MS
);

test(
  "the guard names untracked files that appeared after its baseline",
  async () => {
    const checkout = await gitCheckout("checkout");
    const runner = gitRunner();
    await writeFile(join(checkout, "present.txt"), "before\n");
    const baseline = new Set(checkoutStatusEntries(runner, checkout));
    expect([...baseline]).toEqual(["?? present.txt"]);
    assertNoCheckoutWrites({
      checkout,
      appeared: newStatusEntries(
        baseline,
        checkoutStatusEntries(runner, checkout)
      ),
    });

    await mkdir(join(checkout, "docker-client"));
    await writeFile(join(checkout, "docker-client", "config.json"), "{}\n");
    const appeared = newStatusEntries(
      baseline,
      checkoutStatusEntries(runner, checkout)
    );
    expect(appeared).toEqual(["?? docker-client/config.json"]);
    const refusal = expectClosedThrow(
      () => assertNoCheckoutWrites({ checkout, appeared }),
      "1 file(s) were created or changed"
    );
    expect(refusal.message).toContain("  ?? docker-client/config.json");
  },
  CHILD_TEST_TIMEOUT_MS
);

test(
  "the guard names tracked files that were changed or deleted after its baseline",
  async () => {
    // The prepare-release shape: a child in the checkout rewrites tracked
    // release-version files instead of creating new ones.
    const checkout = await gitCheckout("tracked", {
      "package.json": '{ "version": "0.0.1" }\n',
      "plugin.json": '{ "version": "0.0.1" }\n',
      "edited-before.txt": "committed\n",
    });
    const runner = gitRunner();
    await writeFile(join(checkout, "edited-before.txt"), "local edit\n");
    const baseline = new Set(checkoutStatusEntries(runner, checkout));
    expect([...baseline]).toEqual([" M edited-before.txt"]);

    await writeFile(join(checkout, "package.json"), '{ "version": "9.8.7" }\n');
    await rm(join(checkout, "plugin.json"));
    const appeared = newStatusEntries(
      baseline,
      checkoutStatusEntries(runner, checkout)
    );
    expect(appeared).toEqual([" M package.json", " D plugin.json"]);
    const refusal = expectClosedThrow(
      () => assertNoCheckoutWrites({ checkout, appeared }),
      "2 file(s) were created or changed"
    );
    expect(refusal.message).toContain("   M package.json");
    expect(refusal.message).toContain("   D plugin.json");
    expect(refusal.message).not.toContain("edited-before.txt");
  },
  CHILD_TEST_TIMEOUT_MS
);

test(
  "the guard refuses a checkout git cannot read instead of treating it as clean",
  async () => {
    const runner = gitRunner();
    const plain = join(fixture(), "not-a-checkout");
    await mkdir(plain);
    // A parent .git would make git walk up; the private fixture has none, and
    // GIT_CEILING_DIRECTORIES stops the walk at the fixture either way.
    const error = (() => {
      try {
        checkoutStatusEntries(
          {
            git: runner.git,
            env: { ...runner.env, GIT_CEILING_DIRECTORIES: fixture() },
          },
          plain
        );
      } catch (caught: unknown) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ClosedCliError);
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining("git status failed")
    );
  },
  CHILD_TEST_TIMEOUT_MS
);

/**
 * A bun-test project in a fresh git checkout, preloading the guard exactly as
 * the repository's bunfig.toml does.
 */
async function guardedProject(opts: {
  readonly name: string;
  readonly testSource: string;
  readonly committed?: Readonly<Record<string, string>>;
}): Promise<string> {
  const checkout = await gitCheckout(opts.name, opts.committed);
  await writeFile(
    join(checkout, "guard-preload.ts"),
    [
      'import { afterAll } from "bun:test";',
      `import { installCheckoutWriteGuard } from ${JSON.stringify(join(HELPERS, "checkout-write-guard.ts"))};`,
      "installCheckoutWriteGuard({ start: import.meta.dir, afterAll });",
      "",
    ].join("\n")
  );
  await writeFile(
    join(checkout, "bunfig.toml"),
    '[test]\nroot = "./cases"\npreload = ["./guard-preload.ts"]\n'
  );
  await mkdir(join(checkout, "cases"));
  await writeFile(join(checkout, "cases", "case.test.ts"), opts.testSource);
  return checkout;
}

test(
  "a late write from a timed-out test into the checkout fails the run, named",
  async () => {
    // The HACK-1343 sequence: the fixture's last test times out, afterEach
    // empties the root, and the abandoned call then resolves its path against
    // the checkout while later tests keep the run going.
    const checkout = await guardedProject({
      name: "leaky",
      testSource: `
        import { afterEach, beforeEach, describe, test } from "bun:test";
        import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
        import { tmpdir } from "node:os";
        import { join } from "node:path";
        let root = "";
        describe("fixture", () => {
          beforeEach(() => { root = mkdtempSync(join(tmpdir(), "late-call-")); });
          afterEach(() => { rmSync(root, { recursive: true, force: true }); root = ""; });
          test("times out and leaves its call running", async () => {
            await Bun.sleep(300);
            writeFileSync(join(root, "late-call.json"), "{}\\n");
          }, 50);
        });
        test("keeps the run alive past the late call", async () => {
          await Bun.sleep(1000);
        });
      `,
    });
    const result = await run({
      argv: [process.execPath, "test"],
      cwd: checkout,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(
      "checkout write guard: 1 file(s) were created or changed"
    );
    expect(result.output).toContain("  ?? late-call.json");
  },
  CHILD_TEST_TIMEOUT_MS
);

test(
  "a run that writes only to temp directories passes the guard",
  async () => {
    const checkout = await guardedProject({
      name: "clean",
      testSource: `
        import { expect, test } from "bun:test";
        import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
        import { tmpdir } from "node:os";
        import { join } from "node:path";
        test("writes inside its own temp directory", () => {
          const dir = mkdtempSync(join(tmpdir(), "clean-"));
          writeFileSync(join(dir, "file.txt"), "ok\\n");
          rmSync(dir, { recursive: true, force: true });
          expect(true).toBe(true);
        });
      `,
    });
    const result = await run({
      argv: [process.execPath, "test"],
      cwd: checkout,
    });
    expect(result.output).not.toContain("checkout write guard");
    expect(result.exitCode).toBe(0);
  },
  CHILD_TEST_TIMEOUT_MS
);

test(
  "a late spawn with a reset cwd that rewrites a tracked file fails the run, named",
  async () => {
    // The prepare-release sequence: afterEach resets the fixture root to null,
    // and the timed-out test then spawns its child with that cwd. Bun.spawn
    // runs it in the current directory, the checkout, where it rewrites a
    // tracked file instead of creating an untracked one.
    const checkout = await guardedProject({
      name: "late-spawn",
      committed: { "release-version.json": '{ "version": "0.0.1" }\n' },
      testSource: `
        import { afterEach, beforeEach, describe, test } from "bun:test";
        import { mkdtempSync, rmSync } from "node:fs";
        import { tmpdir } from "node:os";
        import { join } from "node:path";
        let root: string | null = null;
        describe("fixture", () => {
          beforeEach(() => { root = mkdtempSync(join(tmpdir(), "late-spawn-")); });
          afterEach(() => { rmSync(root ?? "", { recursive: true, force: true }); root = null; });
          test("times out before it spawns its child", async () => {
            await Bun.sleep(300);
            Bun.spawnSync(
              [process.execPath, "-e", "require('node:fs').writeFileSync('release-version.json', 'rewritten')"],
              { cwd: root }
            );
          }, 50);
        });
        test("keeps the run alive past the late spawn", async () => {
          await Bun.sleep(1000);
        });
      `,
    });
    const result = await run({
      argv: [process.execPath, "test"],
      cwd: checkout,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain(
      "checkout write guard: 1 file(s) were created or changed"
    );
    expect(result.output).toContain("   M release-version.json");
  },
  CHILD_TEST_TIMEOUT_MS
);

test(
  "fixtureChildren refuses a reset cwd before it starts anything",
  async () => {
    // Bun.spawn treats a null, undefined or empty cwd as the current
    // directory. The probe runs in a child whose current directory is an
    // empty temp directory standing in for the checkout.
    const cwd = join(fixture(), "cwd");
    await mkdir(cwd);
    const script = `
      import { ClosedCliError } from ${JSON.stringify(CLI_RESULT)};
      import { fixtureChildren } from ${JSON.stringify(join(HELPERS, "fixture-children.ts"))};
      const children = fixtureChildren("probe fixture");
      const outcomes = [];
      for (const value of [null, undefined, "", "relative"]) {
        try {
          await children.run({
            cmd: [process.execPath, "-e", "require('node:fs').writeFileSync('late-child.txt', 'x')"],
            cwd: value,
          });
          outcomes.push("ran");
        } catch (error) {
          outcomes.push(
            error instanceof ClosedCliError &&
              error.message.startsWith("probe fixture: the fixture root is not an absolute path")
              ? "closed"
              : "other"
          );
        }
      }
      console.log(JSON.stringify(outcomes));
    `;
    const result = await run({
      argv: [process.execPath, "-e", script],
      cwd,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output.trim())).toEqual([
      "closed",
      "closed",
      "closed",
      "closed",
    ]);
    expect(await readdir(cwd)).toEqual([]);
  },
  CHILD_TEST_TIMEOUT_MS
);

test(
  "fixtureChildren.stopAll kills and awaits a child that is still running",
  async () => {
    const children = fixtureChildren("stop fixture");
    const started = performance.now();
    const pending = children.run({
      cmd: [process.execPath, "-e", "await Bun.sleep(30_000)"],
      cwd: fixture(),
    });
    await children.stopAll();
    const result = await pending;
    expect(result.exitCode).not.toBe(0);
    expect(performance.now() - started).toBeLessThan(20_000);
  },
  CHILD_TEST_TIMEOUT_MS
);

test(
  "outside a git checkout the guard refuses under CI and says it is inactive otherwise",
  async () => {
    const plain = join(fixture(), "not-a-checkout");
    await mkdir(plain);
    const script = `
      import { ClosedCliError } from ${JSON.stringify(CLI_RESULT)};
      import { installCheckoutWriteGuard } from ${JSON.stringify(join(HELPERS, "checkout-write-guard.ts"))};
      const base = {
        PATH: process.env.PATH ?? "",
        GIT_CEILING_DIRECTORIES: ${JSON.stringify(fixture())},
      };
      const hooks = [];
      const outcomes = [];
      for (const ci of ["true", "1", undefined]) {
        try {
          installCheckoutWriteGuard({
            start: ${JSON.stringify(plain)},
            afterAll: (hook) => hooks.push(hook),
            env: ci === undefined ? base : { ...base, CI: ci },
          });
          outcomes.push("inactive");
        } catch (error) {
          outcomes.push(error instanceof ClosedCliError ? "closed" : "other");
        }
      }
      console.log(JSON.stringify({ outcomes, hooks: hooks.length }));
    `;
    const result = await run({
      argv: [process.execPath, "-e", script],
      cwd: plain,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(
      "checkout write guard: inactive, the test run is not in a readable git checkout."
    );
    const report = result.output
      .split("\n")
      .find((line) => line.startsWith("{"));
    expect(JSON.parse(report ?? "null")).toEqual({
      outcomes: ["closed", "closed", "inactive"],
      hooks: 0,
    });
  },
  CHILD_TEST_TIMEOUT_MS
);

test("bunfig.toml preloads the checkout write guard for every bun test run", async () => {
  const repository = resolve(import.meta.dir, "..");
  const preload = "./tests/helpers/checkout-write-guard-preload.ts";
  const config: unknown = Bun.TOML.parse(
    await Bun.file(join(repository, "bunfig.toml")).text()
  );
  expect(config).toMatchObject({
    test: { preload: expect.arrayContaining([preload]) },
  });
  expect(await Bun.file(join(repository, preload)).text()).toContain(
    "installCheckoutWriteGuard({ start: import.meta.dir, afterAll });"
  );
});
