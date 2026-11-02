import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  describeFindings,
  scanSource,
  scanSources,
} from "./helpers/cli-spawn-env-scan.ts";
import { restoreEnv } from "./helpers/env.ts";
import {
  PRIVATE_CLI_DAEMON_AUTOSTART_ENV,
  PRIVATE_CLI_INHERITED_ENV,
  privateCliEnv,
} from "./helpers/private-cli-env.ts";

/**
 * Guard: no test hands the source CLI the test runner's environment or HOME.
 * Build the child env with `privateCliEnv` (tests/helpers/private-cli-env.ts).
 * The scope, rules and limits of the scan are documented in
 * tests/helpers/cli-spawn-env-scan.ts. Each exception below names its reason
 * and its exact finding count.
 */
const ALLOWED: Readonly<
  Record<string, { readonly reason: string; readonly count: number }>
> = {
  // `runCommand` runs git and docker for the real-engine E2E suite, not the
  // CLI. CLI invocations in this harness use `buildCliEnv`.
  "tests/e2e/harness.ts": {
    reason: "runCommand spawns git/docker clients for real-engine E2E",
    count: 1,
  },
  // Two env objects for scripts/prerelease-plan.ts, which reads only GITHUB_*
  // and release inputs; one `tar` control env (rest destructuring); and one
  // `bun build index.ts --compile`, which compiles and does not run the CLI.
  // The compiled and source CLI spawns in this file use `privateCliEnv`.
  "tests/prerelease-plan.test.ts": {
    reason: "release-plan script envs, a tar env and a compile, not the CLI",
    count: 4,
  },
  // The fixture TLS probe runs the real-engine `docker` client, which needs
  // the runner's Docker selection. It does not run the CLI.
  "tests/e2e/scenarios/native-routing-fixture-ingress.ts": {
    reason: "real-engine docker TLS probe env, not the CLI",
    count: 1,
  },
  // `bun build index.ts --compile` compiles and does not run the CLI.
  "tests/host-exec-tty.test.ts": {
    reason: "bun build --compile of index.ts, which does not run the CLI",
    count: 1,
  },
};

async function testSources(): Promise<Map<string, string>> {
  const root = resolve(import.meta.dir);
  const sources = new Map<string, string>();
  for await (const path of new Bun.Glob("**/*.{ts,tsx,mts}").scan({
    cwd: root,
    absolute: true,
  })) {
    // This file names the patterns it scans for in its own examples.
    if (!(path.includes("/node_modules/") || path === import.meta.path)) {
      sources.set(path, await readFile(path, "utf8"));
    }
  }
  return sources;
}

test("no test spawns the source CLI with the runner's environment or HOME", async () => {
  const repo = resolve(import.meta.dir, "..");
  const violations: string[] = [];
  const allowedSeen = new Map<string, number>();
  const results = scanSources(await testSources(), resolve(import.meta.dir));
  for (const [path, findings] of results) {
    const name = relative(repo, path);
    const allowed = ALLOWED[name];
    if (allowed) {
      allowedSeen.set(name, findings.length);
      if (findings.length <= allowed.count) {
        continue;
      }
    }
    violations.push(`${name}: ${describeFindings(findings)}`);
  }
  expect(violations).toEqual([]);
  // Each exception still exists; remove stale entries rather than keep them.
  for (const [name, allowed] of Object.entries(ALLOWED)) {
    expect({ name, count: allowedSeen.get(name) ?? 0 }).toEqual({
      name,
      count: allowed.count,
    });
  }
});

/** Findings for one synthetic in-scope file, as `line rule` strings. */
function scanExample(...lines: string[]): string[] {
  return scanSource("/virtual/example.test.ts", lines.join("\n")).map(
    ({ line, rule }) => `${line} ${rule}`
  );
}

const spawnWith = (options: string) =>
  `Bun.spawn([process.execPath, "../index.ts"], ${options});`;

test("the scan flags every way to hand the CLI the runner's environment", () => {
  // Whole-environment copies, in any form.
  expect(scanExample(spawnWith("{ env: process.env }"))).toEqual([
    "1 runner-env",
  ]);
  expect(
    scanExample(spawnWith("{ env: { ...process.env, HOME: h } }"))
  ).toEqual(["1 runner-env"]);
  expect(scanExample(spawnWith("{ env: { ...Bun.env, HOME: h } }"))).toEqual([
    "1 runner-env",
  ]);
  expect(
    scanExample(
      spawnWith("{ env: Object.assign({}, process.env, { HOME: h }) }")
    )
  ).toEqual(["1 runner-env"]);
  expect(
    scanExample(
      'import { env as e } from "node:process";',
      spawnWith("{ env: { ...e, HOME: h } }")
    )
  ).toEqual(["2 runner-env"]);
  expect(
    scanExample(
      "const { A: _a, ...rest } = process.env;",
      spawnWith("{ env: { ...rest } }")
    )
  ).toEqual(["1 runner-env"]);
  expect(scanExample("const all = Object.values(process.env);")).toEqual([
    "1 runner-env",
  ]);
  expect(
    scanExample(
      "const saved = process.env;",
      spawnWith("{ env: { ...saved } }")
    )
  ).toEqual(["1 runner-env"]);
  // The spread is flagged whatever HOME is set to.
  expect(
    scanExample(spawnWith("{ env: { ...process.env, HOME: someVar } }"))
  ).toEqual(["1 runner-env"]);
  // The runner's HOME, directly or through a same-file binding.
  expect(
    scanExample(spawnWith("{ env: { ...process.env, HOME: os.homedir() } }"))
  ).toEqual(["1 runner-env", "1 runner-home"]);
  expect(
    scanExample(spawnWith("{ env: { PATH: p, HOME: homedir() } }"))
  ).toEqual(["1 runner-home"]);
  expect(
    scanExample(spawnWith("{ env: { PATH: p, HOME: process.env.HOME } }"))
  ).toEqual(["1 runner-home"]);
  expect(
    scanExample(spawnWith('{ env: { PATH: p, HOME: Bun.env["HOME"] } }'))
  ).toEqual(["1 runner-home"]);
  expect(
    scanExample(
      "const someVar = join(homedir(), 'x');",
      spawnWith("{ env: { PATH: p, HOME: someVar } }")
    )
  ).toEqual(["2 runner-home"]);
  expect(
    scanExample(
      "const HOME = userInfo().homedir;",
      spawnWith("{ env: { PATH: p, HOME } }")
    )
  ).toEqual(["2 runner-home"]);
  // A CLI spawn without env inherits everything; one without HOME falls back
  // to the account's real home.
  expect(scanExample(spawnWith("{ stdout: 'pipe' }"))).toEqual([
    "1 cli-without-env",
  ]);
  expect(scanExample('Bun.spawn(["bun", "index.ts", "log-pipe"]);')).toEqual([
    "1 cli-without-env",
  ]);
  expect(
    scanExample(
      'import { spawnSync as run } from "node:child_process";',
      'const cli = resolve(dir, "../index.ts");',
      "const argv = [process.execPath, cli];",
      "run(argv[0], argv.slice(1), { cwd });"
    )
  ).toEqual(["4 cli-without-env"]);
  expect(
    scanExample(
      'import * as cp from "child_process";',
      'cp.execFile(process.execPath, ["index.ts"], { cwd });'
    )
  ).toEqual(["2 cli-without-env"]);
  expect(
    scanExample(
      'Bun.spawn(["python3", "probe.py", process.execPath, "../index.ts"], { stdin: "ignore" });'
    )
  ).toEqual(["1 cli-without-env"]);
  expect(scanExample(spawnWith("{ env: { PATH: p } }"))).toEqual([
    "1 env-without-home",
  ]);
  expect(
    scanExample(
      "const env = { PATH: p };",
      spawnWith("{ env, stdout: 'pipe' }")
    )
  ).toEqual(["2 env-without-home"]);
});

test("the scan accepts a private env and one-key uses of process.env", () => {
  expect(scanExample(spawnWith("{ env: privateCliEnv({ root }) }"))).toEqual(
    []
  );
  expect(
    scanExample(spawnWith('{ env: { PATH: p, HOME: join(root, "home") } }'))
  ).toEqual([]);
  // A fixture field named homedir is not the runner's home.
  expect(
    scanExample(spawnWith("{ env: { PATH: p, HOME: fixture.homedir } }"))
  ).toEqual([]);
  expect(
    scanExample(
      "const env = privateCliEnv({ root });",
      spawnWith("{ env, cwd }")
    )
  ).toEqual([]);
  // Another module's env object is trusted here and checked where it is built.
  expect(scanExample(spawnWith("{ env: { ...fixture.env, X: '1' } }"))).toEqual(
    []
  );
  // An opaque options value is trusted; its builder is checked separately.
  expect(scanExample(spawnWith("options"))).toEqual([]);
  expect(
    scanExample(
      "const home = process.env.HOME;",
      'Reflect.deleteProperty(process.env, "HACK_HOME");',
      'if ("CI" in process.env && Object.hasOwn(process.env, "X")) {}',
      "process.env = { PATH: p };",
      "const { PATH } = process.env;",
      "restoreEnv('HOME', home);",
      "const p = `${process.env.PATH}`;",
      "const keys = Object.keys(process.env);"
    )
  ).toEqual([]);
  // A spawn that does not reach the CLI may inherit, including one that uses
  // the result of a CLI spawn.
  expect(scanExample('Bun.spawn(["git", "status"], { cwd });')).toEqual([]);
  expect(
    scanExample(
      'const proc = Bun.spawn([process.execPath, "index.ts"], { env: privateCliEnv({ root }) });',
      'Bun.spawnSync(["ps", "-p", `${proc.pid}`]);',
      'const run = (args) => { const argv = [process.execPath, "index.ts", ...args]; return Bun.spawn(argv, { env }); };',
      'const result = await run(["up"]);',
      'Bun.spawnSync(["git", "-C", result.root]);'
    )
  ).toEqual([]);
  // A local function named like a spawn export is not one.
  expect(
    scanExample(
      "const exec = (a) => a;",
      'exec([process.execPath, "index.ts"], { cwd });'
    )
  ).toEqual([]);
});

test("the scan follows same-file functions for env and argv", () => {
  // An env returned by a same-file function, directly or through a binding.
  expect(
    scanExample(
      "function fixtureEnv(root) { return { PATH: p, HACK_HOME: root }; }",
      spawnWith("{ env: fixtureEnv(root) }")
    )
  ).toEqual(["2 env-without-home"]);
  expect(
    scanExample(
      "const envFor = (root) => ({ PATH: p });",
      "const env = envFor(root);",
      spawnWith("{ env }")
    )
  ).toEqual(["3 env-without-home"]);
  expect(
    scanExample(
      "function fixtureEnv() { const e = { PATH: p }; return e; }",
      spawnWith("{ env: fixtureEnv() }")
    )
  ).toEqual(["2 env-without-home"]);
  expect(
    scanExample(
      "function fixtureEnv(root) { return privateCliEnv({ root, env: { X: '1' } }); }",
      spawnWith("{ env: fixtureEnv(root) }")
    )
  ).toEqual([]);
  // An argv that a same-file function returns reaches the CLI.
  expect(
    scanExample(
      'const entry = resolve(dir, "../index.ts");',
      "function command() { return [process.execPath, entry]; }",
      'Bun.spawn(command(), { stdout: "pipe" });',
      "Bun.spawn(command(), { env: fixtureEnv(root) });",
      "function fixtureEnv(root) { return { HACK_HOME: root }; }"
    )
  ).toEqual(["3 cli-without-env", "4 env-without-home"]);
});

test("the scan treats src/lib/shell.ts runners and their wrappers as spawns", () => {
  const cli = '[process.execPath, "../index.ts"]';
  const shell = 'import { run } from "../src/lib/shell.ts";';
  // `run` lays env over the runner's whole environment.
  expect(scanExample(shell, `await run(${cli}, { stdin: "ignore" });`)).toEqual(
    ["2 cli-without-env"]
  );
  expect(
    scanExample(shell, `await run(${cli}, { env: { LEAKED: "x" } });`)
  ).toEqual(["2 env-without-home"]);
  expect(
    scanExample(shell, `await run(${cli}, { env: privateCliEnv({ root }) });`)
  ).toEqual(["2 shell-runner-env"]);
  expect(
    scanExample(
      shell,
      `await run(${cli}, { ...privateCliRunEnv({ root }), stdin: "ignore" });`,
      "const { env, unsetEnvKeys } = privateCliRunEnv({ root });",
      `await run(${cli}, { env, unsetEnvKeys });`,
      'await run(["git", "status"], { cwd });'
    )
  ).toEqual([]);
  // Namespace, alias and renamed imports; shell `exec` cannot unset keys.
  expect(
    scanExample(
      'import * as sh from "@lib/shell";',
      `sh.exec(${cli}, { env: privateCliEnv({ root }) });`
    )
  ).toEqual(["2 shell-runner-env"]);
  expect(
    scanExample(
      'import { exec as realExec } from "../../src/lib/shell.ts";',
      'realExec(["bun", "index.ts"]);'
    )
  ).toEqual(["2 cli-without-env"]);
  // A wrapper that forwards its parameters is checked at the call site.
  expect(
    scanExample(
      shell,
      "function runIt(cmd, opts) { return run(cmd, opts); }",
      `runIt(${cli}, { stdin: "ignore" });`,
      `runIt(${cli}, { ...privateCliRunEnv({ root }) });`
    )
  ).toEqual(["3 cli-without-env"]);
  // A wrapper with its own options is checked by them.
  expect(
    scanExample(
      shell,
      "const runPrivate = (cmd) => run(cmd, { ...privateCliRunEnv({ root }) });",
      'const runLeaky = async (cmd) => { await run(cmd, { stdin: "ignore" }); };',
      "const runTwice = (cmd) => runLeaky(cmd);",
      "const runPrivateTwice = (cmd) => runPrivate(cmd);",
      `runPrivate(${cli});`,
      `runLeaky(${cli});`,
      `runTwice(${cli});`,
      `runPrivateTwice(${cli});`
    )
  ).toEqual(["7 cli-without-env", "8 cli-without-env"]);
});

test("the scan follows a CLI file's local imports and skips other files", () => {
  const root = "/virtual/tests";
  const sources = new Map([
    [
      `${root}/name.test.ts`,
      [
        'import { fixture } from "./helpers/fixture.ts";',
        'Bun.spawn([process.execPath, "../index.ts"], { env: fixture.env });',
      ].join("\n"),
    ],
    [
      `${root}/helpers/fixture.ts`,
      [
        'import { other } from "@tests/helpers/other";',
        "export const fixture = { env: { ...process.env, HOME: root } };",
      ].join("\n"),
    ],
    [
      `${root}/helpers/other.ts`,
      "export const other = Object.assign({}, process.env);",
    ],
    [`${root}/git.test.ts`, 'Bun.spawn(["git"], { env: { ...process.env } });'],
  ]);
  const results = scanSources(sources, root);
  expect(
    Object.fromEntries(
      [...results].map(([path, findings]) => [
        relative(root, path),
        describeFindings(findings),
      ])
    )
  ).toEqual({
    "helpers/fixture.ts": "2 runner-env",
    "helpers/other.ts": "1 runner-env",
  });
});

test("privateCliEnv keeps only the allow-list, test values and a private HOME", async () => {
  const root = await mkdtemp(join(tmpdir(), "private-cli-env-"));
  const saved = {
    HOME: process.env.HOME,
    HACK_HOME: process.env.HACK_HOME,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  try {
    process.env.HACK_HOME = "/runner/hack-home";
    process.env.DOCKER_HOST = "unix:///runner/docker.sock";
    process.env.DOCKER_CONTEXT = "runner-context";
    process.env.XDG_CONFIG_HOME = "/runner/xdg";
    const env = privateCliEnv({
      root,
      env: {
        HACK_HOME: join(root, "home"),
        PATH: "/fixture/bin",
        TMPDIR: undefined,
      },
    });
    expect(env.HOME).toBe(join(root, "user-home"));
    expect(env.HOME).not.toBe(saved.HOME);
    expect((await stat(join(root, "user-home"))).mode & 0o777).toBe(0o700);
    expect(env.HACK_HOME).toBe(join(root, "home"));
    expect(env.PATH).toBe("/fixture/bin");
    expect(env.DOCKER_CONFIG).toBe(join(root, "docker-client"));
    expect(Object.keys(env).sort()).toEqual(
      [
        "DOCKER_CONFIG",
        "HACK_HOME",
        "HOME",
        "PATH",
        PRIVATE_CLI_DAEMON_AUTOSTART_ENV,
      ].sort()
    );
    const inherited = privateCliEnv({ root, isolateDockerClient: false });
    for (const key of Object.keys(inherited)) {
      expect([
        ...PRIVATE_CLI_INHERITED_ENV,
        "HOME",
        PRIVATE_CLI_DAEMON_AUTOSTART_ENV,
      ]).toContain(key);
    }
    // A HOME the test created first is still made private to the owner.
    const existing = join(root, "existing-home");
    await mkdir(existing);
    await chmod(existing, 0o755);
    expect(privateCliEnv({ root, home: existing }).HOME).toBe(existing);
    expect((await stat(existing)).mode & 0o777).toBe(0o700);
    expect(() => privateCliEnv({ root, home: tmpdir() })).toThrow("inside");
    expect(() => privateCliEnv({ root, env: { HOME: root } })).toThrow(
      "home option"
    );
    expect(privateCliEnv({ root, home: root }).HOME).toBe(resolve(root));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      restoreEnv(key, value);
    }
    await rm(root, { recursive: true, force: true });
  }
});
