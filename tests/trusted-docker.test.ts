import { describe, expect, test } from "bun:test";
import type { ExecOptions } from "../src/lib/shell.ts";
import {
  type BinaryFacts,
  type BinaryFs,
  createTrustedDockerExec,
  FROZEN_DOCKER_CONFIG,
  resolveSystemDockerSocket,
  resolveTrustedDocker,
  resolveTrustedSystemTool,
} from "../src/lib/trusted-docker.ts";
import { vettedHelperEnv } from "../src/lib/vetted-env.ts";

const DOCKER: BinaryFacts = {
  uid: 0,
  mode: 0o10_0755,
  isFile: true,
  isDirectory: false,
  isSocket: false,
};
const DIR: BinaryFacts = {
  uid: 0,
  mode: 0o4_0755,
  isFile: false,
  isDirectory: true,
  isSocket: false,
};
const SOCKET: BinaryFacts = {
  uid: 0,
  mode: 0o14_0660,
  isFile: false,
  isDirectory: false,
  isSocket: true,
};

function fakeFs(
  facts: Record<string, BinaryFacts>,
  links: Record<string, string> = {}
): BinaryFs {
  return {
    realpath: async (path) => {
      const target = links[path] ?? path;
      if (!facts[target]) {
        throw new Error("ENOENT");
      }
      return target;
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
  "/run": DIR,
  "/run/docker.sock": SOCKET,
};
// /var/run is usually a symlink to /run.
const links = { "/var/run/docker.sock": "/run/docker.sock" };

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

describe("resolveSystemDockerSocket", () => {
  test("accepts the root-owned system socket (docker group may write)", async () => {
    expect(await resolveSystemDockerSocket(fakeFs(tree, links))).toBe(
      "/run/docker.sock"
    );
  });

  test.each([
    ["owned by a user (rootless engine)", { ...SOCKET, uid: 1000 }],
    ["world-writable", { ...SOCKET, mode: 0o14_0666 }],
    ["not a socket", { ...SOCKET, isSocket: false, isFile: true }],
  ])("refuses a socket %s", async (_label, socket) => {
    expect(
      await resolveSystemDockerSocket(
        fakeFs({ ...tree, "/run/docker.sock": socket }, links)
      )
    ).toBeNull();
  });

  test("no system socket (Docker Desktop / rootless): null", async () => {
    const { "/run/docker.sock": _socket, ...noSocket } = tree;
    expect(await resolveSystemDockerSocket(fakeFs(noSocket))).toBeNull();
  });
});

describe("resolveTrustedSystemTool", () => {
  test("certutil is selected only from fixed vetted system directories", async () => {
    expect(
      await resolveTrustedSystemTool({
        name: "certutil",
        fs: fakeFs({
          ...tree,
          "/usr/bin/certutil": DOCKER,
          "/user/bin/certutil": { ...DOCKER, uid: 1000 },
        }),
      })
    ).toBe("/usr/bin/certutil");
    expect(
      await resolveTrustedSystemTool({
        name: "certutil",
        fs: fakeFs({ ...tree, "/user/bin/certutil": { ...DOCKER, uid: 1000 } }),
      })
    ).toBeNull();
  });

  test.each([
    [
      "user-owned executable",
      { "/usr/bin/certutil": { ...DOCKER, uid: 1000 } },
    ],
    [
      "writable executable",
      { "/usr/bin/certutil": { ...DOCKER, mode: 0o10_0777 } },
    ],
    ["not executable", { "/usr/bin/certutil": { ...DOCKER, mode: 0o10_0644 } }],
    ["writable ancestor", { "/usr/bin": { ...DIR, mode: 0o4_0777 } }],
  ])("refuses %s", async (_label, override) => {
    expect(
      await resolveTrustedSystemTool({
        name: "certutil",
        fs: fakeFs({ ...tree, "/usr/bin/certutil": DOCKER, ...override }),
      })
    ).toBeNull();
  });

  test("a tool name cannot escape the fixed directories", async () => {
    expect(
      await resolveTrustedSystemTool({
        name: "../user/certutil",
        fs: fakeFs(tree),
      })
    ).toBeNull();
  });
});

describe("createTrustedDockerExec", () => {
  test("runs the vetted client against the system engine with user selection removed", async () => {
    const calls: { cmd: readonly string[]; opts?: ExecOptions }[] = [];
    const run = createTrustedDockerExec({
      fs: fakeFs(tree, links),
      execute: (async (cmd: readonly string[], opts?: ExecOptions) => {
        calls.push({ cmd, opts });
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }) as never,
    });
    expect(
      (
        await run(["docker", "ps", "-q"], {
          timeoutMs: 5000,
          env: {
            LD_PRELOAD: "/untrusted.so",
            PATH: "/untrusted",
            DOCKER_HOST: "tcp://untrusted",
          },
        })
      ).stdout
    ).toBe("ok");
    expect(calls[0]?.cmd).toEqual(["/usr/bin/docker", "ps", "-q"]);
    expect(calls[0]?.opts?.timeoutMs).toBe(5000);
    expect(calls[0]?.opts?.env).toEqual({
      ...vettedHelperEnv().env,
      DOCKER_HOST: "unix:///run/docker.sock",
      DOCKER_CONFIG: FROZEN_DOCKER_CONFIG,
    });
    expect(calls[0]?.opts?.unsetEnvKeys).toEqual(
      expect.arrayContaining([
        "DOCKER_CONTEXT",
        "DOCKER_TLS_VERIFY",
        "DOCKER_CERT_PATH",
      ])
    );
  });

  test("no vetted client, no system engine, or a non-docker command: nothing runs", async () => {
    let ran = false;
    const execute = (async () => {
      ran = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }) as never;
    const { "/run/docker.sock": _socket, ...noSocket } = tree;
    for (const run of [
      createTrustedDockerExec({ fs: fakeFs({}), execute }),
      createTrustedDockerExec({ fs: fakeFs(noSocket), execute }),
    ]) {
      expect((await run(["docker", "ps"])).exitCode).toBe(127);
    }
    const other = createTrustedDockerExec({ fs: fakeFs(tree, links), execute });
    expect((await other(["sh", "-c", "true"])).exitCode).toBe(127);
    expect(ran).toBe(false);
  });
});
