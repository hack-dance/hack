import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
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
  walkReplaceableChain,
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

/** What the socket walk sees for `path`: names, owners and modes only. */
function describeSocketCheck(path: string): string {
  const lines: string[] = [`socket check for ${path}`];
  try {
    const physical = realpathSync(path);
    const info = lstatSync(physical);
    lines.push(
      `resolves to ${physical}: isSocket=${info.isSocket()} uid=${info.uid} (process ${process.getuid?.()}) mode=${(info.mode & 0o7777).toString(8)}`
    );
  } catch (error: unknown) {
    lines.push(`realpath/lstat failed: ${String(error)}`);
  }
  const checked = new Set<string>();
  const walk = walkReplaceableChain({
    path,
    uid: process.getuid?.() ?? -1,
    hackHome: null,
    checked,
    allowMissing: true,
    acceptDarwinAdminDirectories: true,
  });
  lines.push(`walk: ${JSON.stringify(walk)}`);
  for (const entry of checked) {
    try {
      const info = lstatSync(entry);
      lines.push(
        `  ${entry} uid=${info.uid} gid=${info.gid} mode=${(info.mode & 0o7777).toString(8)} dir=${info.isDirectory()} link=${info.isSymbolicLink()}`
      );
    } catch (error: unknown) {
      lines.push(`  ${entry} lstat failed: ${String(error)}`);
    }
  }
  return lines.join("\n");
}

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
        let refused: unknown = null;
        try {
          trustDocker({
            home,
            env: { DOCKER_HOST: `unix://${path}` },
            systemPluginDirectories: [],
          });
        } catch (error: unknown) {
          refused = error;
        }
        // The product omits values; on a failure, name what the socket check
        // saw so a host-specific refusal can be diagnosed from CI output.
        expect(refused, describeSocketCheck(path)).toBeNull();
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
 * The stock macOS default socket, `/var/run/docker.sock`, is a root-owned link
 * in `/var/run`, which is root:daemon 0775. The `daemon` account could replace
 * that link after the check and before Docker reopens it, so automatic startup
 * refuses the default socket there (a root:daemon directory is never accepted).
 * Docker Desktop and OrbStack select their own context, whose socket is in the
 * user's home: that chain is owned by the user and passes.
 */
test("the stock macOS /var/run is not trusted for the default socket; a selected engine context avoids it", async () => {
  const varRun = {
    uid: 0,
    gid: 1,
    mode: 0o4_0775,
    isDirectory: () => true,
  };
  expect(isDarwinAdminDirectory(varRun, "darwin")).toBe(false);
  // A directory others can write, standing in for /var/run, refuses...
  const shared = join(home, "var-run");
  await mkdir(shared, { mode: 0o700 });
  await chmod(shared, 0o775);
  expect(() =>
    trustDocker({ defaultHost: `unix://${join(shared, "docker.sock")}` })
  ).toThrow("Automatic startup refused unsafe Docker engine-selection files");
  // ...while a selected engine context means the default socket is never
  // consulted. (Its endpoint here is the missing stand-in below `/`: on Linux
  // a socket under the fixture home would sit below sticky /tmp.)
  const name = "orbstack";
  const context = join(
    home,
    ".docker/contexts/meta",
    createHash("sha256").update(name).digest("hex")
  );
  await mkdir(context, { recursive: true, mode: 0o700 });
  await writeFile(
    join(context, "meta.json"),
    JSON.stringify({
      Name: name,
      Endpoints: { docker: { Host: MISSING_DEFAULT_HOST } },
    }),
    { mode: 0o600 }
  );
  await writeFile(
    join(home, ".docker/config.json"),
    JSON.stringify({ currentContext: name }),
    { mode: 0o600 }
  );
  expect(() =>
    trustDocker({ defaultHost: `unix://${join(shared, "docker.sock")}` })
  ).not.toThrow();
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
