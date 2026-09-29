import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import { resolveDependencyCacheOverride } from "../src/lib/dependency-cache.ts";
import { validateDependencyCacheLayout } from "../src/lib/dependency-cache-layout.ts";
import { isRecord } from "../src/lib/guards.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "hack-cache-protocol-"));
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir);
  const composeFile = join(projectDir, "docker-compose.yml");
  await Bun.write(join(projectRoot, "bun.lock"), "fixed-lock");
  const labels = {
    "hack.dependencies.cache-volume": "deps",
    "hack.dependencies.cache-protocol": "locked-v1",
    "hack.dependencies.cache-generation": "0",
    "hack.dependencies.cache-verify": '["test","-s","/deps/artifact"]',
  };
  const compose = {
    services: {
      installer: {
        image: "alpine:3.20",
        platform: "linux/arm64",
        entrypoint: [],
        command: ["sh", "-c", "echo ready > /deps/artifact"],
        labels,
        volumes: ["deps:/deps"],
      },
      app: {
        image: "alpine:3.20",
        volumes: ["deps:/deps:ro"],
        depends_on: {
          installer: { condition: "service_completed_successfully" },
        },
      },
    },
    volumes: { deps: {} },
  };
  const run = async () => {
    await Bun.write(composeFile, JSON.stringify(compose));
    return await resolveDependencyCacheOverride({
      projectRoot,
      projectDir,
      composeFile,
      projectName: "protocol",
    });
  };
  return { compose, labels, run };
}

test("explicit protocol generates wrapper mount and identity changes for generation or verifier", async () => {
  const f = await fixture();
  const first = await f.run();
  expect(first.progressServices).toEqual(["installer"]);
  const override = YAML.parse(await Bun.file(first.overridePath ?? "").text());
  if (
    !(
      isRecord(override) &&
      isRecord(override.services) &&
      isRecord(override.services.installer) &&
      Array.isArray(override.services.installer.volumes)
    )
  ) {
    throw new Error("invalid override");
  }
  expect(override.services.installer.entrypoint).toEqual([
    "/bin/sh",
    "/hack-dependency-cache-install.sh",
  ]);
  const mount = override.services.installer.volumes[0];
  if (!(isRecord(mount) && typeof mount.source === "string")) {
    throw new Error("invalid mount");
  }
  expect(mount.read_only).toBe(true);
  expect(await Bun.file(mount.source).text()).toContain(
    first.fingerprint ?? "missing"
  );
  f.labels["hack.dependencies.cache-generation"] = "1";
  const second = await f.run();
  expect(second.fingerprint).not.toBe(first.fingerprint);
  f.labels["hack.dependencies.cache-verify"] = '["test","-f","/deps/other"]';
  expect((await f.run()).fingerprint).not.toBe(second.fingerprint);
});

test("protocol rejects writable consumers and missing completion gates", async () => {
  const f = await fixture();
  f.compose.services.app.volumes = ["deps:/deps"];
  await expect(f.run()).rejects.toThrow("read-only");
  f.compose.services.app.volumes = ["deps:/deps:ro"];
  f.compose.services.app.depends_on.installer.condition = "service_started";
  await expect(f.run()).rejects.toThrow("successful completion");
});

test("protocol refuses unresolved platform rather than silently losing protection", async () => {
  const f = await fixture();
  f.compose.services.installer.platform = "${UNKNOWN_PLATFORM}";
  await expect(f.run()).rejects.toThrow("resolved installer identity");
});

test("protocol rejects uninspected inherited Compose readers and writers", () => {
  for (const compose of [
    { include: "other.yml", services: {}, volumes: { deps: {} } },
    { services: { app: { extends: "base" } }, volumes: { deps: {} } },
    { services: { app: { volumes_from: ["other"] } }, volumes: { deps: {} } },
  ]) {
    expect(() =>
      validateDependencyCacheLayout({
        compose,
        producer: "installer",
        volume: "deps",
      })
    ).toThrow("does not support");
  }
});
