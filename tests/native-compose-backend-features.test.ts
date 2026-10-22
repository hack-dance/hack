import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptNativeProject } from "../src/backends/native-project-adaptation.ts";
import type { NativeProjectInput } from "../src/backends/native-project-input.ts";
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

const ADAPTATION_REFUSAL =
  "Native project adaptation is invalid or conflicts with declared configuration; values omitted.";

function adaptationInput(compose: unknown): NativeProjectInput {
  return {
    originalSha256: "0".repeat(64),
    normalizedComposeJson: JSON.stringify(compose),
    managedEnvironment: {},
    lifecycleHostEnvironment: {},
    effectiveEnvName: null,
    environmentFiles: [],
    serviceNames: ["web"],
  };
}

test("a network the native adaptation isolates is not external, as after native normalization", () => {
  const compose = {
    services: { web: { image: IMAGE, networks: ["hack-dev", "edge"] } },
    networks: { "hack-dev": { external: true }, edge: { external: true } },
  };
  const both = new Set(["hack-dev", "edge"]);
  expect(
    findComposeBackendFeatures(compose, { isolatedNetworks: both })
  ).toEqual([]);
  // Parity with the adaptation itself: the adapted normalized copy has no
  // external network left for the same selection.
  const adapted = adaptNativeProject({
    input: adaptationInput(compose),
    selection: { version: 1, isolatedNetworks: [...both] },
  });
  expect(
    findComposeBackendFeatures(JSON.parse(adapted.normalizedComposeJson))
  ).toEqual([]);
  // A network the adaptation does not list is still external.
  expect(
    findComposeBackendFeatures(compose, {
      isolatedNetworks: new Set(["hack-dev"]),
    })
  ).toEqual(["external_network"]);
  // Isolation hides only the network feature, never another one.
  expect(
    findComposeBackendFeatures(
      {
        ...compose,
        services: { web: { image: IMAGE, platform: "linux/amd64" } },
      },
      { isolatedNetworks: both }
    )
  ).toEqual(["foreign_platform"]);
});

test("the Compose file is classified after a valid HACK_NATIVE_ADAPTATION selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "compose-backend-"));
  roots.push(root);
  const composeFile = join(root, "docker-compose.yml");
  await writeFile(
    composeFile,
    "services:\n  web:\n    image: app\n    networks: [hack-dev]\nnetworks:\n  hack-dev:\n    external: true\n"
  );
  const selection = async (name: string, value: unknown) => {
    const path = join(root, name);
    await writeFile(path, JSON.stringify(value));
    return path;
  };
  const isolating = await selection("isolating.json", {
    version: 1,
    isolatedNetworks: ["hack-dev"],
  });
  expect(
    await readComposeBackendFeatures(composeFile, { adaptationFile: isolating })
  ).toEqual([]);
  await refuseNativeComposeBackendFeatures({
    composeFile,
    adaptationFile: isolating,
    restart: true,
  });
  for (const [index, other] of [
    { version: 1, isolatedNetworks: ["other-net"] },
    { version: 1, httpProbes: { web: { port: 3000, path: "/health" } } },
  ].entries()) {
    expect(
      await readComposeBackendFeatures(composeFile, {
        adaptationFile: await selection(`other-${index}.json`, other),
      })
    ).toEqual(["external_network"]);
  }
});

test("an invalid adaptation refuses as native start does, and is read only for an external network", async () => {
  const root = await mkdtemp(join(tmpdir(), "compose-backend-"));
  roots.push(root);
  const external = join(root, "external.yml");
  await writeFile(external, "networks:\n  hack-dev:\n    external: true\n");
  const owned = join(root, "owned.yml");
  await writeFile(owned, "services:\n  web:\n    image: app\n");
  const invalid: unknown[] = [
    { version: 2, isolatedNetworks: ["hack-dev"] },
    { version: 1, isolatedNetworks: "hack-dev" },
    { version: 1, isolatedNetworks: ["hack-dev", "hack-dev"] },
    { version: 1, isolatedNetworks: [7] },
    ["hack-dev"],
  ];
  for (const [index, value] of invalid.entries()) {
    const path = join(root, `invalid-${index}.json`);
    await writeFile(path, JSON.stringify(value));
    await expectCodedRefusal(
      refuseNativeComposeBackendFeatures({
        composeFile: external,
        adaptationFile: path,
        restart: false,
      }),
      "E_CONFIG_INVALID",
      ADAPTATION_REFUSAL
    );
    // The adaptation native start applies refuses the same selection.
    expect(() =>
      adaptNativeProject({
        input: adaptationInput({
          services: { web: { image: IMAGE } },
          networks: { "hack-dev": { external: true } },
        }),
        selection: value,
      })
    ).toThrow(ADAPTATION_REFUSAL);
    // Without an external network the selection is not read here; native
    // start reports it in its usual order.
    expect(
      await readComposeBackendFeatures(owned, { adaptationFile: path })
    ).toEqual([]);
  }
  for (const unreadable of [join(root, "missing.json"), "relative.json"]) {
    await expectCodedRefusal(
      readComposeBackendFeatures(external, { adaptationFile: unreadable }),
      "E_CONFIG_INVALID",
      "values omitted"
    );
  }
});
