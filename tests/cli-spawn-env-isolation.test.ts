import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { restoreEnv } from "./helpers/env.ts";
import {
  PRIVATE_CLI_INHERITED_ENV,
  privateCliEnv,
} from "./helpers/private-cli-env.ts";

/**
 * Guard: a test that spawns the source CLI must not hand it the test runner's
 * environment with the contributor's HOME. Build the child env with
 * `privateCliEnv` (tests/helpers/private-cli-env.ts), or at least override
 * HOME with a path inside the fixture.
 *
 * This is a text scan, not a type check. A file "spawns the source CLI" when
 * it names `index.ts` in a string literal or uses the E2E harness CLI
 * entrypoint. In such a file, every object literal that spreads `process.env`
 * must set its own `HOME`, and that `HOME` must not be the runner's home.
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
  // Release planning scripts (`scripts/prerelease-plan.ts`) read only
  // GITHUB_* and release inputs; the source CLI spawn in this file is private.
  "tests/prerelease-plan.test.ts": {
    reason: "env objects for scripts/prerelease-plan.ts, not the CLI",
    count: 2,
  },
};

const SOURCE_CLI =
  /["'`](?:\.{1,2}\/)*index\.ts["'`]|\bCLI_ENTRYPOINT\b|\bresolveCliSpawnArgs\b/;
const SPREAD = /\.\.\.\s*process\.env(?![\w.[])/g;
const RUNNER_HOME =
  /\bHOME\s*:\s*(?:process\.env\.HOME|process\.env\[["']HOME["']\]|homedir\(\))/;
const HOME_KEY = /(?:^|[\s,{])HOME\s*(?::|,|\})/;

/** The text of the object literal that encloses `index`, or null. */
function enclosingObject(source: string, index: number): string | null {
  let depth = 0;
  let start = -1;
  for (let at = index - 1; at >= 0; at -= 1) {
    const char = source[at];
    if (char === "}") {
      depth += 1;
    } else if (char === "{") {
      if (depth === 0) {
        start = at;
        break;
      }
      depth -= 1;
    }
  }
  if (start < 0) {
    return null;
  }
  depth = 0;
  for (let at = start; at < source.length; at += 1) {
    const char = source[at];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, at + 1);
      }
    }
  }
  return null;
}

/** Line numbers of `...process.env` spreads that reach the source CLI with the runner's HOME. */
function leakingCliEnvSpreads(source: string): number[] {
  if (!SOURCE_CLI.test(source)) {
    return [];
  }
  const lines: number[] = [];
  for (const match of source.matchAll(SPREAD)) {
    const object = enclosingObject(source, match.index);
    const safe =
      object !== null && HOME_KEY.test(object) && !RUNNER_HOME.test(object);
    if (!safe) {
      lines.push(source.slice(0, match.index).split("\n").length);
    }
  }
  return lines;
}

async function testSources(): Promise<string[]> {
  const root = resolve(import.meta.dir);
  const files: string[] = [];
  for await (const path of new Bun.Glob("**/*.{ts,tsx,mts}").scan({
    cwd: root,
    absolute: true,
  })) {
    // This file names the patterns it scans for in its own examples.
    if (!(path.includes("/node_modules/") || path === import.meta.path)) {
      files.push(path);
    }
  }
  return files.sort();
}

test("no test spawns the source CLI with the runner's environment and HOME", async () => {
  const repo = resolve(import.meta.dir, "..");
  const violations: string[] = [];
  const allowedSeen = new Map<string, number>();
  for (const path of await testSources()) {
    const name = relative(repo, path);
    const lines = leakingCliEnvSpreads(await readFile(path, "utf8"));
    if (lines.length === 0) {
      continue;
    }
    const allowed = ALLOWED[name];
    if (allowed) {
      allowedSeen.set(name, lines.length);
      if (lines.length <= allowed.count) {
        continue;
      }
    }
    violations.push(`${name}:${lines.join(",")}`);
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

test("the scan flags runner HOME and accepts a private HOME", () => {
  const spawn = (env: string) =>
    `Bun.spawn([process.execPath, "../index.ts"], {\n  env: ${env},\n});`;
  expect(
    leakingCliEnvSpreads(spawn("{ ...process.env, HACK_HOME: h }"))
  ).toEqual([2]);
  expect(
    leakingCliEnvSpreads(spawn("{ ...process.env, HOME: process.env.HOME }"))
  ).toEqual([2]);
  expect(
    leakingCliEnvSpreads(spawn("{ ...process.env, HOME: homedir() }"))
  ).toEqual([2]);
  // A nested object's HOME does not cover the outer spread.
  expect(
    leakingCliEnvSpreads(spawn("{ ...process.env, X: { HOME: h } }"))
  ).toEqual([]);
  expect(
    leakingCliEnvSpreads(spawn('{ ...process.env, HOME: join(root, "home") }'))
  ).toEqual([]);
  expect(leakingCliEnvSpreads(spawn("{ ...process.env, HOME }"))).toEqual([]);
  expect(leakingCliEnvSpreads(spawn("privateCliEnv({ root })"))).toEqual([]);
  // Reading one variable is not a spread of the environment.
  expect(
    leakingCliEnvSpreads(spawn("{ PATH: `${process.env.PATH}` }"))
  ).toEqual([]);
  // Files that never spawn the source CLI are out of scope.
  expect(
    leakingCliEnvSpreads('Bun.spawn(["git"], { env: { ...process.env } });')
  ).toEqual([]);
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
      ["DOCKER_CONFIG", "HACK_HOME", "HOME", "PATH"].sort()
    );
    const inherited = privateCliEnv({ root, isolateDockerClient: false });
    for (const key of Object.keys(inherited)) {
      expect([...PRIVATE_CLI_INHERITED_ENV, "HOME"]).toContain(key);
    }
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
