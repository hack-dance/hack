import { describe, expect, test } from "bun:test";

import {
  type BinaryFacts,
  type BinaryFs,
  createTrustedDockerExec,
  resolveTrustedDocker,
} from "../src/lib/trusted-docker.ts";

const DOCKER: BinaryFacts = {
  uid: 0,
  mode: 0o10_0755,
  isFile: true,
  isDirectory: false,
};
const DIR: BinaryFacts = {
  uid: 0,
  mode: 0o4_0755,
  isFile: false,
  isDirectory: true,
};

function fakeFs(facts: Record<string, BinaryFacts>): BinaryFs {
  return {
    realpath: async (path) => {
      if (!facts[path]) {
        throw new Error("ENOENT");
      }
      return path;
    },
    stat: async (path) => {
      const value = facts[path];
      if (!value) {
        throw new Error("ENOENT");
      }
      return value;
    },
  };
}

const tree = {
  "/": DIR,
  "/usr": DIR,
  "/usr/bin": DIR,
  "/usr/bin/docker": DOCKER,
};

describe("resolveTrustedDocker", () => {
  test("accepts a root-owned executable in root-owned directories", async () => {
    expect(await resolveTrustedDocker(fakeFs(tree))).toBe("/usr/bin/docker");
  });

  test.each([
    ["owned by a user", { "/usr/bin/docker": { ...DOCKER, uid: 1000 } }],
    ["group-writable", { "/usr/bin/docker": { ...DOCKER, mode: 0o10_0775 } }],
    ["not executable", { "/usr/bin/docker": { ...DOCKER, mode: 0o10_0644 } }],
    ["in a user-owned directory", { "/usr/bin": { ...DIR, uid: 1000 } }],
  ])("refuses a docker %s", async (_label, override) => {
    expect(
      await resolveTrustedDocker(fakeFs({ ...tree, ...override }))
    ).toBeNull();
  });
});

describe("createTrustedDockerExec", () => {
  test("runs docker by the vetted absolute path, never by PATH", async () => {
    const calls: (readonly string[])[] = [];
    const run = createTrustedDockerExec({
      fs: fakeFs(tree),
      execute: (async (cmd: readonly string[]) => {
        calls.push(cmd);
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }) as never,
    });
    expect((await run(["docker", "ps", "-q"])).stdout).toBe("ok");
    expect(calls).toEqual([["/usr/bin/docker", "ps", "-q"]]);
  });

  test("no vetted docker or a non-docker command: unavailable, nothing runs", async () => {
    let ran = false;
    const execute = (async () => {
      ran = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as never;
    const none = createTrustedDockerExec({ fs: fakeFs({}), execute });
    expect((await none(["docker", "ps"])).exitCode).toBe(127);
    const other = createTrustedDockerExec({ fs: fakeFs(tree), execute });
    expect((await other(["sh", "-c", "true"])).exitCode).toBe(127);
    expect(ran).toBe(false);
  });
});
