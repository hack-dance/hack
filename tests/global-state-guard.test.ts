import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { restoreEnv } from "./helpers/env.ts";
import {
  captureGlobalState,
  diffGlobalState,
  restoreGlobalState,
} from "./helpers/global-state-guard.ts";

const PRELOAD = resolve(
  import.meta.dir,
  "helpers/global-state-guard-preload.ts"
);
const KEY = "HACK_GLOBAL_STATE_GUARD_TEST";
const owned: string[] = [];

afterEach(async () => {
  await Promise.all(
    owned.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function tempDir(): Promise<string> {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "hack-global-state-guard-"))
  );
  owned.push(dir);
  return dir;
}

test("diff names added, changed and removed env keys and a cwd change, without values", async () => {
  const dir = await tempDir();
  const before = captureGlobalState();
  const savedPath = process.env.PATH;
  const savedKey = process.env[KEY];
  const cwd = process.cwd();
  try {
    process.env[KEY] = "secret-shaped-value";
    process.env.PATH = "/nonexistent";
    process.chdir(dir);
    const changes = diffGlobalState(before);
    expect(changes).toContain("cwd changed");
    expect(changes).toContain(
      `env ${KEY} ${savedKey === undefined ? "added" : "changed"}`
    );
    expect(changes).toContain("env PATH changed");
    expect(changes.join("\n")).not.toContain("secret-shaped-value");
    expect(changes.join("\n")).not.toContain("/nonexistent");
    expect(
      diffGlobalState(before, captureGlobalState(), {
        allowedEnvChanges: new Map([[KEY, "test allowlist"]]),
      })
    ).not.toContain(`env ${KEY} added`);
  } finally {
    process.chdir(cwd);
    restoreEnv("PATH", savedPath);
    restoreEnv(KEY, savedKey);
  }
  expect(diffGlobalState(before)).toEqual([]);
});

test("restore puts back env keys, the env object, cwd and exitCode in place", async () => {
  const dir = await tempDir();
  const before = captureGlobalState();
  const envObject = process.env;
  const savedPath = process.env.PATH;
  const savedHome = process.env.HOME;
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  try {
    process.env.PATH = "/nonexistent";
    Reflect.deleteProperty(process.env, "HOME");
    process.env[KEY] = "1";
    process.chdir(dir);
    process.exitCode = 3;
    process.env = { PATH: "/replaced" };
    expect(diffGlobalState(before)).toContain("process.env object replaced");

    restoreGlobalState(before);

    expect(process.env).toBe(envObject);
    expect(process.env.PATH).toBe(savedPath);
    expect(process.env.HOME).toBe(savedHome);
    expect(process.env[KEY]).toBeUndefined();
    expect(process.cwd()).toBe(cwd);
    expect<number | string>(process.exitCode ?? 0).toBe(exitCode ?? 0);
    expect(diffGlobalState(before)).toEqual([]);
  } finally {
    process.env = envObject;
    process.chdir(cwd);
    process.exitCode = exitCode ?? 0;
    restoreEnv("PATH", savedPath);
    restoreEnv("HOME", savedHome);
    restoreEnv(KEY, undefined);
  }
});

test("a replaced function or listener is reported but left for its owner", () => {
  const before = captureGlobalState();
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const listener = () => undefined;
  const fake = (() =>
    Promise.reject(new Error("refused"))) as unknown as typeof fetch;
  try {
    globalThis.fetch = fake;
    process.on("SIGUSR2", listener);
    const changes = diffGlobalState(before);
    expect(changes).toContain("globalThis.fetch replaced");
    expect(changes).toContain("process 'SIGUSR2' listeners changed");
    restoreGlobalState(before);
    expect(globalThis.fetch).toBe(fake);
    expect(process.listeners("SIGUSR2")).toContain(listener);
  } finally {
    process.removeListener("SIGUSR2", listener);
    if (fetchDescriptor) {
      Object.defineProperty(globalThis, "fetch", fetchDescriptor);
    }
  }
  expect(diffGlobalState(before)).toEqual([]);
});

const LEAK_IN_TEST = `import { test } from "bun:test";
test("sets PATH and fails before restoring", () => {
  const saved = process.env.PATH;
  process.env.PATH = "/nonexistent";
  if (saved !== "never") throw new Error("early failure before restore");
  process.env.PATH = saved;
});
`;

const LEAK_IN_HOOKS = `import { beforeAll, test } from "bun:test";
beforeAll(() => {
  process.env.HACK_HOME = "/nonexistent/hack-home";
  process.chdir("/");
});
test("passes but never restores", () => {});
`;

const LATER = `import { expect, test } from "bun:test";
test("a later file still finds executables on PATH", () => {
  const child = Bun.spawnSync(["hack-guard-probe"], { env: { ...process.env } });
  expect(child.exitCode).toBe(0);
  expect(process.env.HACK_HOME).toBeUndefined();
  console.log("LATER-FILE-PASSED");
});
`;

async function runNestedSuite(opts: {
  readonly preload: boolean;
}): Promise<{ readonly code: number; readonly output: string }> {
  const dir = await tempDir();
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  const suite = join(dir, "suite");
  await mkdir(bin);
  await mkdir(home);
  await mkdir(suite);
  await writeFile(join(bin, "hack-guard-probe"), "#!/bin/sh\nexit 0\n");
  await chmod(join(bin, "hack-guard-probe"), 0o755);
  await writeFile(
    join(suite, "bunfig.toml"),
    opts.preload ? `[test]\npreload = [${JSON.stringify(PRELOAD)}]\n` : ""
  );
  await writeFile(join(suite, "a-leak-in-test.test.ts"), LEAK_IN_TEST);
  await writeFile(join(suite, "b-leak-in-hooks.test.ts"), LEAK_IN_HOOKS);
  await writeFile(join(suite, "c-later.test.ts"), LATER);
  const child = Bun.spawn(
    [
      process.execPath,
      "test",
      "./a-leak-in-test.test.ts",
      "./b-leak-in-hooks.test.ts",
      "./c-later.test.ts",
    ],
    {
      cwd: suite,
      env: { PATH: bin, HOME: home, TMPDIR: dir, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, output: `${stdout}\n${stderr}` };
}

test("without the guard, an early leak cascades into a later file", async () => {
  const run = await runNestedSuite({ preload: false });
  expect(run.code).not.toBe(0);
  expect(run.output).toContain("Executable not found in $PATH");
  expect(run.output).toContain(
    "(fail) a later file still finds executables on PATH"
  );
}, 60_000);

test("the guard names each leaking file, restores state, and later files pass", async () => {
  const run = await runNestedSuite({ preload: true });
  expect(run.code).not.toBe(0);
  expect(run.output).toContain(
    "[global-state-guard] a test in a-leak-in-test.test.ts left process state changed: env PATH changed."
  );
  expect(run.output).toContain(
    "b-leak-in-hooks.test.ts left process state changed after the file finished: cwd changed; env HACK_HOME added"
  );
  expect(run.output).toContain("1 test file(s) leaked process state");
  expect(run.output).not.toContain("Executable not found");
  expect(run.output).toContain("LATER-FILE-PASSED");
}, 60_000);
