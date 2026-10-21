import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPOSE_BACKEND_CHECK,
  composeBackendCheckResult,
} from "../src/lib/doctor-compose-backend.ts";
import {
  composeBackendRefusal,
  findComposeBackendFeatures,
  RESERVED_OWNERSHIP_LABEL_PREFIXES,
  readComposeBackendFeatures,
  refuseNativeComposeBackendFeatures,
} from "../src/lib/native-compose-backend-features.ts";
import { expectCodedRefusal } from "./helpers/closed-refusal.ts";

const IMAGE = "registry.example/app:1";
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

function services(service: Record<string, unknown>) {
  return { services: { web: service } };
}

test("an image-only project has no Compose-backend features", () => {
  expect(findComposeBackendFeatures(services({ image: IMAGE }))).toEqual([]);
  expect(findComposeBackendFeatures(null)).toEqual([]);
  expect(findComposeBackendFeatures({ services: [] })).toEqual([]);
});

test("external networks are blocking; owned and isolated replacements are not", () => {
  const network = (definition: unknown) => ({
    ...services({ image: IMAGE }),
    networks: { edge: definition },
  });
  expect(findComposeBackendFeatures(network({ external: true }))).toEqual([
    "external_network",
  ]);
  expect(
    findComposeBackendFeatures(network({ external: { name: "edge" } }))
  ).toEqual(["external_network"]);
  for (const owned of [
    null,
    {},
    { external: false },
    { driver: "bridge", internal: true },
    { external: true, "x-hack-isolated": true },
  ]) {
    expect(findComposeBackendFeatures(network(owned))).toEqual([]);
  }
});

test("each reserved ownership namespace is blocking in map and list labels", () => {
  expect(RESERVED_OWNERSHIP_LABEL_PREFIXES).toEqual([
    "com.docker.compose.",
    "io.hack-local.",
    "io.hack.native-config.",
  ]);
  for (const key of [
    "com.docker.compose.project",
    "io.hack-local.owner",
    "io.hack.native-config.instance",
  ]) {
    expect(
      findComposeBackendFeatures(
        services({ image: IMAGE, labels: { [key]: "x" } })
      )
    ).toEqual(["reserved_label"]);
    expect(
      findComposeBackendFeatures(
        services({ image: IMAGE, labels: [`${key}=x`] })
      )
    ).toEqual(["reserved_label"]);
    expect(
      findComposeBackendFeatures({
        ...services({ image: IMAGE }),
        volumes: { data: { labels: { [key]: "x" } } },
      })
    ).toEqual(["reserved_label"]);
  }
});

test("ordinary, routing, cache and one-shot labels are not reserved", () => {
  for (const labels of [
    { "com.example.team": "web" },
    ["com.docker.composer=x", "io.hack-localx=1", "io.hack.other=1"],
    { caddy: "web.hack", "caddy.reverse_proxy": "{{upstreams 3000}}" },
    { "hack.dependencies.bootstrap": "install" },
    { "hack.service.one-shot": "true" },
  ]) {
    expect(
      findComposeBackendFeatures(services({ image: IMAGE, labels }))
    ).toEqual([]);
  }
});

test("builds follow the import preview's basic build path", () => {
  for (const build of [
    "..",
    ".",
    { context: "../app" },
    { context: "..", dockerfile: "docker/Dockerfile", target: "dev" },
    {},
  ]) {
    expect(findComposeBackendFeatures(services({ build }))).toEqual([]);
  }
  for (const service of [
    { build: { context: "..", args: { A: "1" } } },
    { build: { context: "..", platforms: ["linux/amd64"] } },
    { build: "/absolute/context" },
    { build: "../../outside" },
    { build: { context: "..", dockerfile: "../../Dockerfile" } },
    { build: "..", image: IMAGE },
  ]) {
    expect(findComposeBackendFeatures(services(service))).toEqual([
      "unsupported_build",
    ]);
  }
});

test("only the native linux/arm64 platform passes", () => {
  for (const platform of ["linux/arm64", "linux/arm64/v8"]) {
    expect(
      findComposeBackendFeatures(services({ image: IMAGE, platform }))
    ).toEqual([]);
  }
  for (const platform of [
    "linux/amd64",
    "linux/arm/v7",
    "${PLATFORM}",
    42,
    null,
  ]) {
    expect(
      findComposeBackendFeatures(services({ image: IMAGE, platform }))
    ).toEqual(["foreign_platform"]);
  }
});

test("features come back once each in closed order across services", () => {
  expect(
    findComposeBackendFeatures({
      services: {
        a: { image: IMAGE, platform: "linux/amd64" },
        b: { build: { context: "..", ssh: ["default"] } },
        c: { image: IMAGE, labels: ["io.hack-local.kind=x"] },
        d: { image: IMAGE, platform: "linux/amd64", profiles: ["off"] },
      },
      networks: { a: { external: true }, b: { external: true } },
    })
  ).toEqual([
    "external_network",
    "reserved_label",
    "unsupported_build",
    "foreign_platform",
  ]);
});

test("the refusal is one coded line with closed detail and no values", async () => {
  const root = await mkdtemp(join(tmpdir(), "compose-backend-"));
  roots.push(root);
  const file = join(root, "docker-compose.yml");
  await writeFile(
    file,
    [
      "services:",
      "  web:",
      "    image: private.registry/app:secret-tag",
      "    platform: linux/amd64",
      "    networks: [private-net]",
      "networks:",
      "  private-net:",
      "    external: true",
      "",
    ].join("\n")
  );
  const error = await expectCodedRefusal(
    refuseNativeComposeBackendFeatures({ composeFile: file, restart: false }),
    "E_NATIVE_PROJECT_UNSUPPORTED",
    "Native `hack up` does not support an external Compose network and a service platform other than linux/arm64; this project runs on the Compose backend. Set HACK_RUNTIME_BACKEND=compose"
  );
  expect(error.message).not.toContain("\n");
  for (const value of ["private-net", "secret-tag", "linux/amd64", root]) {
    expect(error.message).not.toContain(value);
  }
  expect(error.detail).toEqual({
    backend: "compose",
    features: ["external_network", "foreign_platform"],
  });
  expect(
    composeBackendRefusal({ features: ["reserved_label"], restart: true })
      .message
  ).toStartWith("Native `hack restart` does not support a label");
});

test("unreadable, oversized, symlinked or invalid Compose input is left to native review", async () => {
  const root = await mkdtemp(join(tmpdir(), "compose-backend-"));
  roots.push(root);
  const blocking = "networks:\n  edge:\n    external: true\n";
  const real = join(root, "real.yml");
  await writeFile(real, blocking);
  expect(await readComposeBackendFeatures(real)).toEqual(["external_network"]);
  const link = join(root, "link.yml");
  await symlink(real, link);
  const big = join(root, "big.yml");
  await writeFile(big, `${blocking}#${"x".repeat(256 * 1024)}\n`);
  const invalid = join(root, "invalid.yml");
  await writeFile(invalid, "services: [unclosed\n");
  for (const path of [join(root, "missing.yml"), link, big, invalid]) {
    expect(await readComposeBackendFeatures(path)).toEqual([]);
    await refuseNativeComposeBackendFeatures({
      composeFile: path,
      restart: false,
    });
  }
});

test("doctor reports the same features value-free for each backend", () => {
  const features = ["external_network"] as const;
  const native = composeBackendCheckResult({ backend: "native", features });
  expect(native).toMatchObject({
    name: COMPOSE_BACKEND_CHECK,
    status: "warn",
    composeBackend: { features: ["external_network"] },
  });
  expect(native.message).toContain("an external Compose network");
  expect(native.message).toContain("HACK_RUNTIME_BACKEND=compose");
  expect(
    composeBackendCheckResult({ backend: "compose", features })
  ).toMatchObject({ status: "ok", composeBackend: { features } });
  for (const backend of ["native", "compose"] as const) {
    expect(composeBackendCheckResult({ backend, features: [] })).toMatchObject({
      status: "ok",
      composeBackend: { features: [] },
    });
  }
});
