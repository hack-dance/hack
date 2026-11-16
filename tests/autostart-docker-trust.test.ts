import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { assertAutostartDockerConfigTrusted } from "../src/lib/autostart-docker-trust.ts";
import {
  isDarwinAdminDirectory,
  isDarwinDaemonDirectory,
} from "../src/lib/path-trust.ts";

/**
 * Checks here do not read the runner environment, the system plugin
 * directories, Darwin ACLs or `/var/run/docker.sock`. The default engine socket is a path
 * directly below `/` that is assumed not to exist on the test host, so only
 * `/` itself is inspected. A socket below the fixture home would not do: on
 * Linux the home is under sticky `/tmp`, which the socket-parent rule refuses.
 * A test passes a field to override these.
 */
const MISSING_DEFAULT_HOST = "unix:///hack-test-missing-engine/docker.sock";
const NO_ACL_INSPECTION = { exitCode: 0, stdout: "" };
const NO_ACL = {
  inspect: () => Promise.resolve(NO_ACL_INSPECTION),
  inspectSync: () => NO_ACL_INSPECTION,
};

function trustDocker(
  opts: Partial<Parameters<typeof assertAutostartDockerConfigTrusted>[0]> = {}
): void {
  assertAutostartDockerConfigTrusted({
    home,
    env: {},
    systemPluginDirectories: [],
    defaultHost: MISSING_DEFAULT_HOST,
    // Darwin ACLs on the host's temp chain are not under test here; the ACL
    // rules have their own tests (autostart-path-acl.test.ts).
    acl: NO_ACL,
    ...opts,
  });
}

let home = "";
beforeEach(async () => {
  // macOS links /var to /private/var; the product compares resolved paths.
  home = await realpath(await mkdtemp(join(tmpdir(), "hack-docker-trust-")));
  await mkdir(join(home, ".docker"), { mode: 0o700 });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test("missing or owner-controlled Docker engine selection is accepted without exposing values", async () => {
  expect(() => trustDocker({ home })).not.toThrow();
  await writeFile(join(home, ".docker/config.json"), "{}", {
    mode: 0o600,
  });
  expect(() => trustDocker({ home })).not.toThrow();
});

test("writable Compose plugins and custom plugin search paths refuse automatic startup", async () => {
  const plugins = join(home, ".docker/cli-plugins");
  await mkdir(plugins, { mode: 0o700 });
  const plugin = join(plugins, "docker-compose");
  await writeFile(plugin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(plugin, 0o777);
  expect(() => trustDocker({ home, systemPluginDirectories: [] })).toThrow();
  await chmod(plugin, 0o700);
  await writeFile(
    join(home, ".docker/config.json"),
    JSON.stringify({ cliPluginsExtraDirs: [plugins] }),
    { mode: 0o600 }
  );
  expect(() => trustDocker({ home, systemPluginDirectories: [] })).toThrow();
});

test("writable Docker config or context inputs refuse before contacting an engine", async () => {
  const context = join(home, ".docker/contexts/meta/example");
  await mkdir(context, { recursive: true, mode: 0o700 });
  const meta = join(context, "meta.json");
  await writeFile(meta, "{}", { mode: 0o600 });
  for (const path of [join(home, ".docker"), meta]) {
    await chmod(path, 0o777);
    expect(() => trustDocker({ home })).toThrow();
    await chmod(path, path === meta ? 0o600 : 0o700);
  }
  const target = join(home, "untrusted-config");
  await writeFile(target, "{}", { mode: 0o600 });
  await chmod(target, 0o666);
  await symlink(target, join(home, ".docker/config.json"));
  expect(() => trustDocker({ home })).toThrow();
});

test("network contexts and direct hosts refuse before contacting an engine", async () => {
  const name = "remote-fixture";
  const context = join(
    home,
    ".docker/contexts/meta",
    createHash("sha256").update(name).digest("hex")
  );
  await mkdir(context, { recursive: true, mode: 0o700 });
  const metadata = join(context, "meta.json");
  await writeFile(
    join(home, ".docker/config.json"),
    JSON.stringify({ currentContext: name }),
    { mode: 0o600 }
  );
  expect(() =>
    trustDocker({
      home,
      env: {},
      systemPluginDirectories: [],
    })
  ).toThrow();
  await writeFile(metadata, "{}", { mode: 0o600 });
  expect(() =>
    trustDocker({
      home,
      env: {},
      systemPluginDirectories: [],
    })
  ).toThrow();
  for (const host of [
    "ssh://fixture",
    "unknown://fixture",
    "unix:///fixture/docker.sock",
    "npipe:////./pipe/docker_engine",
    "tcp://127.0.0.1:2376",
  ]) {
    await writeFile(
      metadata,
      JSON.stringify({ Name: name, Endpoints: { docker: { Host: host } } }),
      { mode: 0o600 }
    );
    const check = () =>
      trustDocker({
        home,
        env: {},
        systemPluginDirectories: [],
      });
    if (
      host.startsWith("ssh:") ||
      host.startsWith("unknown:") ||
      host.startsWith("tcp:") ||
      host.startsWith("npipe:")
    ) {
      expect(check).toThrow();
    } else {
      expect(check).not.toThrow();
    }
  }
  for (const host of ["ssh://fixture", "tcp://127.0.0.1:2376"]) {
    expect(() =>
      trustDocker({
        home,
        env: { DOCKER_CONTEXT: "default", DOCKER_HOST: host },
        systemPluginDirectories: [],
      })
    ).toThrow();
  }
  await writeFile(
    metadata,
    JSON.stringify({ Endpoints: { docker: { Host: "ssh://fixture" } } }),
    { mode: 0o600 }
  );
  expect(() =>
    trustDocker({
      home,
      env: { DOCKER_CONTEXT: name },
      systemPluginDirectories: [],
    })
  ).toThrow();
});

test("the default engine socket is checked when nothing selects another", async () => {
  // Stands in for /var/run/docker.sock in a directory others can write.
  const shared = join(home, "shared-run");
  await mkdir(shared, { mode: 0o700 });
  await chmod(shared, 0o777);
  const unsafe = `unix://${join(shared, "docker.sock")}`;
  expect(() => trustDocker({ defaultHost: unsafe })).toThrow(
    "Automatic startup refused unsafe Docker engine-selection files"
  );
  // An explicit default context still uses the default socket.
  expect(() =>
    trustDocker({ defaultHost: unsafe, env: { DOCKER_CONTEXT: "default" } })
  ).toThrow();
  // DOCKER_HOST replaces it.
  expect(() =>
    trustDocker({
      defaultHost: unsafe,
      env: { DOCKER_HOST: MISSING_DEFAULT_HOST },
    })
  ).not.toThrow();
  expect(() =>
    trustDocker({ defaultHost: MISSING_DEFAULT_HOST })
  ).not.toThrow();
});

test("socket endpoints refuse shared sticky parents and regular files", () => {
  for (const host of [
    "unix:///tmp/hack-unowned-socket-fixture/docker.sock",
    "unix:///etc/passwd",
    "npipe:////./pipe/docker_engine",
  ]) {
    expect(() =>
      trustDocker({
        home,
        env: { DOCKER_HOST: host },
        systemPluginDirectories: [],
      })
    ).toThrow();
  }
});

/**
 * A real socket needs a parent chain nobody else can write: on Linux the temp
 * directory is sticky `/tmp`, so fall back to HOME there. On macOS the
 * per-user temp directory qualifies and the real home is never used.
 */
function socketFixtureBase(): string | null {
  for (const candidate of [tmpdir(), homedir()]) {
    let path: string;
    try {
      path = realpathSync(candidate);
    } catch {
      continue;
    }
    const parts = path.split("/").filter(Boolean);
    const ancestors = [
      "/",
      ...parts.map((_, i) => `/${parts.slice(0, i + 1).join("/")}`),
    ];
    if (
      ancestors.every((entry) => {
        const info = statSync(entry);
        return (info.mode & 0o022) === 0 || isDarwinAdminDirectory(info);
      })
    ) {
      return path;
    }
  }
  return null;
}
const SOCKET_FIXTURE_BASE = socketFixtureBase();

test.skipIf(SOCKET_FIXTURE_BASE === null)(
  "owned socket and symlink pass; writable or sticky parents refuse",
  async () => {
    const socketRoot = await mkdtemp(
      join(SOCKET_FIXTURE_BASE ?? "/nonexistent", ".hack-socket-trust-test-")
    );
    const socket = join(socketRoot, "docker.sock");
    const alias = join(socketRoot, "engine.sock");
    const server = createServer();
    try {
      await chmod(socketRoot, 0o700);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, resolve);
      });
      await chmod(socket, 0o660);
      await symlink(socket, alias);
      for (const path of [socket, alias]) {
        expect(() =>
          trustDocker({
            home,
            env: { DOCKER_HOST: `unix://${path}` },
            systemPluginDirectories: [],
          })
        ).not.toThrow();
      }
      for (const mode of [0o777, 0o1777]) {
        await chmod(socketRoot, mode);
        expect(() =>
          trustDocker({
            home,
            env: { DOCKER_HOST: `unix://${alias}` },
            systemPluginDirectories: [],
          })
        ).toThrow();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketRoot, { recursive: true, force: true });
    }
  }
);

test("sticky user and system plugin directories cannot admit late plugin creation", async () => {
  const root = join(home, ".docker");
  const plugins = join(root, "cli-plugins");
  const check = (systemPluginDirectories: readonly string[] = []) =>
    trustDocker({
      home,
      env: {},
      systemPluginDirectories,
    });
  await mkdir(plugins, { mode: 0o700 });
  expect(() => check()).not.toThrow();
  for (const mode of [0o777, 0o1777]) {
    await chmod(plugins, mode);
    expect(() => check()).toThrow();
  }
  await chmod(plugins, 0o700);
  await rm(plugins, { recursive: true });
  await chmod(root, 0o1777);
  expect(() => check()).toThrow();
  await chmod(root, 0o700);
  const target = join(home, "system-plugins");
  await mkdir(target, { mode: 0o700 });
  await chmod(target, 0o1777);
  expect(() => check([target])).toThrow();
  expect(() => check([join(target, "missing-plugins")])).toThrow();
  await symlink(target, plugins);
  expect(() => check()).toThrow();
  await chmod(target, 0o700);
  expect(() => check()).not.toThrow();
});

/**
 * The stock macOS default-socket layout (Docker Desktop and OrbStack), element
 * by element, against the rules the socket walk applies. Root-owned entries
 * cannot be created by a test, so this checks each element's rule:
 * - `/var` -> `/private/var`: a root-owned link (followed, like any link);
 * - `/private/var`: root:wheel 0755 (nobody else can write);
 * - `/private/var/run`: root:daemon 0775, accepted only on the socket path;
 * - `/var/run/docker.sock`: a root-owned link into the user's home;
 * - the engine's directories in the home and the socket: owned by the user.
 */
test("the stock macOS default-socket layout passes each rule of the socket walk", () => {
  const entry = (fields: {
    uid: number;
    gid: number;
    mode: number;
    dir?: boolean;
  }) => ({ ...fields, isDirectory: () => fields.dir !== false });
  const user = 501;
  // /private/var/run: the only group-writable element.
  const varRun = entry({ uid: 0, gid: 1, mode: 0o4_0775 });
  expect(isDarwinDaemonDirectory(varRun, "darwin")).toBe(true);
  // Lookup paths never accept it: only the socket walk opts in.
  expect(isDarwinAdminDirectory(varRun, "darwin")).toBe(false);
  // root:wheel 0755 and the user's own 0700/0755 directories need no
  // exception: nobody else can write them.
  for (const own of [
    entry({ uid: 0, gid: 0, mode: 0o4_0755 }),
    entry({ uid: user, gid: 20, mode: 0o4_0700 }),
    entry({ uid: user, gid: 20, mode: 0o4_0755 }),
  ]) {
    expect(own.mode & 0o022).toBe(0);
  }
  // The variants that must still refuse on the socket path.
  for (const unsafe of [
    entry({ uid: 0, gid: 1, mode: 0o4_0777 }), // world-writable
    entry({ uid: user, gid: 1, mode: 0o4_0775 }), // not root's
    entry({ uid: 0, gid: 20, mode: 0o4_0775 }), // group staff
    entry({ uid: 0, gid: 12, mode: 0o4_0775 }), // group everyone
  ]) {
    expect(isDarwinDaemonDirectory(unsafe, "darwin")).toBe(false);
    expect(isDarwinAdminDirectory(unsafe, "darwin")).toBe(false);
  }
});

// The socket chain gets its own ACL inspection, separate from the selection
// inputs: a mutation ACL on a directory only the socket path crosses refuses,
// while the same inspection passing everywhere else accepts.
test.skipIf(SOCKET_FIXTURE_BASE === null)(
  "a mutation ACL on the socket path refuses even when the selection inputs pass",
  async () => {
    const socketRoot = await mkdtemp(
      join(SOCKET_FIXTURE_BASE ?? "/nonexistent", ".hack-socket-acl-test-")
    );
    try {
      await chmod(socketRoot, 0o700);
      const inspected: string[][] = [];
      const acl = (flagged: string | null) => ({
        platform: "darwin" as const,
        inspect: () => Promise.resolve({ exitCode: 0, stdout: "" }),
        inspectSync: (paths: readonly string[]) => {
          inspected.push([...paths]);
          return {
            exitCode: 0,
            stdout:
              flagged !== null && paths.includes(flagged)
                ? `drwx------  2 user  staff  64 Jan  1 00:00 ${flagged}\n 0: user:intruder allow add_file\n`
                : "",
          };
        },
      });
      const check = (flagged: string | null) =>
        trustDocker({
          env: { DOCKER_HOST: `unix://${join(socketRoot, "docker.sock")}` },
          acl: acl(flagged),
        });
      expect(() => check(null)).not.toThrow();
      // Selection inputs were inspected before the socket chain, and neither
      // inventory is empty.
      expect(inspected.length).toBeGreaterThanOrEqual(2);
      expect(inspected[0]?.includes(socketRoot)).toBe(false);
      expect(inspected.at(-1)?.includes(socketRoot)).toBe(true);
      expect(() => check(socketRoot)).toThrow(
        "Automatic startup refused unsafe Docker engine-selection files"
      );
    } finally {
      await rm(socketRoot, { recursive: true, force: true });
    }
  }
);
