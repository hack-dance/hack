import { afterEach, beforeEach, expect, test } from "bun:test";
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

test("missing or owner-controlled Docker engine selection is accepted without parsing values", async () => {
  expect(() => assertAutostartDockerConfigTrusted({ home })).not.toThrow();
  await writeFile(join(home, ".docker/config.json"), "not JSON", {
    mode: 0o600,
  });
  expect(() => assertAutostartDockerConfigTrusted({ home })).not.toThrow();
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
