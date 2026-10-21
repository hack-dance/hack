import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * The bundled `hack-v5` entrypoint runs against a stub `hack-cli` that only
 * prints the selection it received, so no candidate software, Docker engine or
 * real HOME is reached.
 */
const PRINTED = [
  "HACK_RUNTIME_BACKEND",
  "HACK_NATIVE_BINARY",
  "HACK_NATIVE_HOME",
  "HACK_HOME",
  "HACK_CANDIDATE_ENTRYPOINT",
] as const;
const STUB_CLI = `#!/bin/sh\n${PRINTED.map(
  (name) => `printf "%s\\n" "\${${name}-<unset>}"`
).join("\n")}\nprintf "%s\\n" "$@"\nexit 7\n`;

let root: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "hack candidate ")));
  await copyFile("scripts/hack-v5.sh", join(root, "hack-v5"));
  await Bun.write(join(root, "hack-native"), "#!/bin/sh\nexit 0\n");
  await chmod(join(root, "hack-native"), 0o755);
  await Bun.write(join(root, "hack-cli"), STUB_CLI);
  await chmod(join(root, "hack-cli"), 0o755);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function launcherEnv(env: Readonly<Record<string, string | undefined>>) {
  return privateCliEnv({
    root,
    env: {
      HACK_NATIVE_HOME: join(root, "private home"),
      HACK_NATIVE_BINARY: "/wrong/executor",
      HACK_HOME: join(root, "caller hack home"),
      ...env,
    },
  });
}

async function launch(
  env: Readonly<Record<string, string | undefined>>,
  args: readonly string[] = ["exec", "a b", "--", "$literal"]
) {
  const child = Bun.spawn(["sh", join(root, "hack-v5"), ...args], {
    env: launcherEnv(env),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
    exitCode: await child.exited,
  };
}

test.each([
  ["unset", undefined],
  ["empty", ""],
  ["native", "native"],
])("candidate launcher selects native and its adjacent executor when the backend is %s", async (_label, backend) => {
  const result = await launch({ HACK_RUNTIME_BACKEND: backend });
  expect(result.stdout).toBe(
    [
      "native",
      `${root}/hack-native`,
      `${root}/private home`,
      `${root}/caller hack home`,
      "hack-v5",
      "exec",
      "a b",
      "--",
      "$literal",
      "",
    ].join("\n")
  );
  expect(result.exitCode).toBe(7);
});

test("explicit Compose selection is respected with the caller's Hack home and no native selectors", async () => {
  const result = await launch({ HACK_RUNTIME_BACKEND: "compose" });
  expect(result.stdout).toBe(
    [
      "compose",
      "<unset>",
      "<unset>",
      `${root}/caller hack home`,
      "hack-v5",
      "exec",
      "a b",
      "--",
      "$literal",
      "",
    ].join("\n")
  );
  expect(result.exitCode).toBe(7);
  // Compose needs no native home, so an absent or relative one does not refuse.
  for (const home of [undefined, "relative"]) {
    const noHome = await launch(
      { HACK_RUNTIME_BACKEND: "compose", HACK_NATIVE_HOME: home },
      ["ps"]
    );
    expect(noHome.exitCode).toBe(7);
    expect(noHome.stdout.split("\n").slice(0, 3)).toEqual([
      "compose",
      "<unset>",
      "<unset>",
    ]);
  }
});

test.each([
  "docker",
  "Native",
  "native ",
])("unknown backend %p refuses before running the CLI", async (backend) => {
  const result = await launch({ HACK_RUNTIME_BACKEND: backend }, ["up"]);
  expect(result.exitCode).toBe(64);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(
    "HACK_RUNTIME_BACKEND must be native or compose"
  );
});

test("native selection refuses without an absolute private home", async () => {
  for (const home of [undefined, "", "relative"]) {
    const refused = await launch({ HACK_NATIVE_HOME: home }, ["up"]);
    expect(refused.exitCode).toBe(64);
    expect(refused.stdout).toBe("");
  }
});

test.each([
  undefined,
  "compose",
])("incomplete bundle refuses on backend %p", async (backend) => {
  await rm(join(root, "hack-native"));
  const incomplete = await launch({ HACK_RUNTIME_BACKEND: backend }, ["up"]);
  expect(incomplete.exitCode).toBe(69);
  expect(incomplete.stdout).toBe("");
});
