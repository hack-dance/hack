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
import { isDarwinAdminDirectory } from "../src/lib/path-trust.ts";

/**
 * Checks here do not read the runner environment, the system plugin
 * directories or `/var/run/docker.sock`. The default engine socket is a path
 * directly below `/` that is assumed not to exist on the test host, so only
 * `/` itself is inspected. A socket below the fixture home would not do: on
 * Linux the home is under sticky `/tmp`, which the socket-parent rule refuses.
 * A test passes a field to override these.
 */
const MISSING_DEFAULT_HOST = "unix:///hack-test-missing-engine/docker.sock";

function trustDocker(
  opts: Partial<Parameters<typeof assertAutostartDockerConfigTrusted>[0]> = {}
): void {
  assertAutostartDockerConfigTrusted({
    home,
    env: {},
    systemPluginDirectories: [],
    defaultHost: MISSING_DEFAULT_HOST,
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
