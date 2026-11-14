import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertAutostartDockerConfigTrusted } from "../src/lib/autostart-docker-trust.ts";

let home = "";
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hack-docker-trust-"));
  await mkdir(join(home, ".docker"), { mode: 0o700 });
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test("missing or owner-controlled Docker engine selection is accepted without exposing values", async () => {
  expect(() => assertAutostartDockerConfigTrusted({ home })).not.toThrow();
  await writeFile(join(home, ".docker/config.json"), "{}", {
    mode: 0o600,
  });
  expect(() => assertAutostartDockerConfigTrusted({ home })).not.toThrow();
});

test("writable Compose plugins and custom plugin search paths refuse automatic startup", async () => {
  const plugins = join(home, ".docker/cli-plugins");
  await mkdir(plugins, { mode: 0o700 });
  const plugin = join(plugins, "docker-compose");
  await writeFile(plugin, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await chmod(plugin, 0o777);
  expect(() =>
    assertAutostartDockerConfigTrusted({ home, systemPluginDirectories: [] })
  ).toThrow();
  await chmod(plugin, 0o700);
  await writeFile(
    join(home, ".docker/config.json"),
    JSON.stringify({ cliPluginsExtraDirs: [plugins] }),
    { mode: 0o600 }
  );
  expect(() =>
    assertAutostartDockerConfigTrusted({ home, systemPluginDirectories: [] })
  ).toThrow();
});

test("writable Docker config or context inputs refuse before contacting an engine", async () => {
  const context = join(home, ".docker/contexts/meta/example");
  await mkdir(context, { recursive: true, mode: 0o700 });
  const meta = join(context, "meta.json");
  await writeFile(meta, "{}", { mode: 0o600 });
  for (const path of [join(home, ".docker"), meta]) {
    await chmod(path, 0o777);
    expect(() => assertAutostartDockerConfigTrusted({ home })).toThrow();
    await chmod(path, path === meta ? 0o600 : 0o700);
  }
  const target = join(home, "untrusted-config");
  await writeFile(target, "{}", { mode: 0o600 });
  await chmod(target, 0o666);
  await symlink(target, join(home, ".docker/config.json"));
  expect(() => assertAutostartDockerConfigTrusted({ home })).toThrow();
});

test("selected SSH contexts and direct SSH hosts refuse before contacting an engine", async () => {
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
    assertAutostartDockerConfigTrusted({
      home,
      env: {},
      systemPluginDirectories: [],
    })
  ).toThrow();
  await writeFile(metadata, "{}", { mode: 0o600 });
  expect(() =>
    assertAutostartDockerConfigTrusted({
      home,
      env: {},
      systemPluginDirectories: [],
    })
  ).toThrow();
  for (const host of [
    "ssh://fixture",
    "unknown://fixture",
    "unix:///fixture/docker.sock",
    "tcp://127.0.0.1:2376",
  ]) {
    await writeFile(
      metadata,
      JSON.stringify({ Name: name, Endpoints: { docker: { Host: host } } }),
      { mode: 0o600 }
    );
    const check = () =>
      assertAutostartDockerConfigTrusted({
        home,
        env: {},
        systemPluginDirectories: [],
      });
    if (host.startsWith("ssh:") || host.startsWith("unknown:")) {
      expect(check).toThrow();
    } else {
      expect(check).not.toThrow();
    }
  }
  expect(() =>
    assertAutostartDockerConfigTrusted({
      home,
      env: { DOCKER_CONTEXT: "default", DOCKER_HOST: "ssh://fixture" },
      systemPluginDirectories: [],
    })
  ).toThrow();
  await writeFile(
    metadata,
    JSON.stringify({ Endpoints: { docker: { Host: "ssh://fixture" } } }),
    { mode: 0o600 }
  );
  expect(() =>
    assertAutostartDockerConfigTrusted({
      home,
      env: { DOCKER_CONTEXT: name },
      systemPluginDirectories: [],
    })
  ).toThrow();
});
