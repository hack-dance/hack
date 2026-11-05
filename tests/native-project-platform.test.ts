import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptNativeProject } from "../src/backends/native-project-adaptation.ts";
import type { NativeProjectInput } from "../src/backends/native-project-input.ts";
import {
  AMD64_EMULATION_FIELD,
  applyNativeAmd64Emulation,
  ensuredPlatformAccepted,
  hostRosettaAvailable,
  nativeAmd64EmulationUpArgs,
  nativeEnsureImageArgs,
  selectNativePlatformModes,
} from "../src/backends/native-project-platform.ts";
import {
  AMD64_EMULATION_CHECK,
  amd64EmulationCheckResult,
} from "../src/lib/doctor-native-emulation.ts";
import {
  findComposeBackendFeatures,
  readAdaptedEmulatedServices,
  readComposeBackendFeatures,
  readNativePlatformModes,
} from "../src/lib/native-compose-backend-features.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "hack-native-platform-"));
  roots.push(root);
  return root;
}

function input(services: Record<string, unknown>): NativeProjectInput {
  return {
    originalSha256: "a".repeat(64),
    normalizedComposeJson: JSON.stringify({ services }),
    managedEnvironment: {},
    lifecycleHostEnvironment: {},
    effectiveEnvName: null,
    environmentFiles: [],
    serviceNames: Object.keys(services),
  };
}

function expectInvalid(run: () => unknown): void {
  let failure: unknown;
  try {
    run();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: "E_CONFIG_INVALID" });
  expect(String(failure)).not.toContain("private-canary");
}

test("platform modes default to native and honor an explicit project default and per-service modes", () => {
  const services = ["web", "worker", "cache"];
  expect([
    ...selectNativePlatformModes({ selection: undefined, services }),
  ]).toEqual([
    ["web", "native"],
    ["worker", "native"],
    ["cache", "native"],
  ]);
  expect([
    ...selectNativePlatformModes({
      selection: {
        default: "prefer-native",
        services: { worker: "amd64", cache: "native" },
      },
      services,
    }),
  ]).toEqual([
    ["web", "prefer-native"],
    ["worker", "amd64"],
    ["cache", "native"],
  ]);
  expect([
    ...selectNativePlatformModes({
      selection: { services: { worker: "amd64" } },
      services,
    }),
  ]).toEqual([
    ["web", "native"],
    ["worker", "amd64"],
    ["cache", "native"],
  ]);
});

test("invalid emulation selections refuse closed without echoing values", () => {
  const services = ["web"];
  for (const selection of [
    null,
    [],
    "amd64",
    { default: "linux/amd64" },
    { default: "x86_64" },
    { services: { "private-canary": "amd64" } },
    { services: { web: "emulate" } },
    { services: [] },
    { services: { web: "amd64" }, mode: "amd64" },
  ]) {
    expectInvalid(() => selectNativePlatformModes({ selection, services }));
  }
});

test("only opted-in services get the reviewed runtime field, and declared arm64 cannot opt in", () => {
  const services: Record<string, unknown> = {
    legacy: { image: "example/legacy:1", platform: "linux/amd64" },
    tool: { image: "example/tool:1" },
    native: { image: "example/native:1" },
  };
  const policies = applyNativeAmd64Emulation({
    services,
    selection: {
      default: "prefer-native",
      services: { legacy: "amd64", native: "native" },
    },
  });
  expect(policies).toEqual({ legacy: "amd64", tool: "prefer-native" });
  expect(services.legacy).toMatchObject({
    platform: "linux/amd64",
    [AMD64_EMULATION_FIELD]: true,
  });
  expect(services.tool).toMatchObject({ [AMD64_EMULATION_FIELD]: true });
  expect(services.native).toEqual({ image: "example/native:1" });
  for (const platform of ["linux/arm64", "linux/arm64/v8"]) {
    expectInvalid(() =>
      applyNativeAmd64Emulation({
        services: { web: { image: "example/web:1", platform } },
        selection: { default: "prefer-native" },
      })
    );
  }
  expect(
    applyNativeAmd64Emulation({
      services: { web: { image: "example/web:1", platform: "linux/arm64" } },
      selection: { default: "native" },
    })
  ).toEqual({});
});

test("native adaptation carries emulation policies only when a service opts in", () => {
  const original = input({
    legacy: { image: "example/legacy:1", platform: "linux/amd64" },
    web: { image: "example/web:1" },
  });
  const plain = adaptNativeProject({
    input: original,
    selection: { version: 1 },
  });
  expect(plain.amd64Emulation).toBeUndefined();
  expect(JSON.parse(plain.normalizedComposeJson).services.legacy).toEqual({
    image: "example/legacy:1",
    platform: "linux/amd64",
  });
  const adapted = adaptNativeProject({
    input: original,
    selection: {
      version: 1,
      amd64Emulation: { services: { legacy: "prefer-native" } },
    },
  });
  expect(adapted.amd64Emulation).toEqual({ legacy: "prefer-native" });
  const compose = JSON.parse(adapted.normalizedComposeJson);
  expect(compose.services.legacy[AMD64_EMULATION_FIELD]).toBe(true);
  expect(compose.services.web[AMD64_EMULATION_FIELD]).toBeUndefined();
  // The original input is not modified.
  expect(JSON.parse(original.normalizedComposeJson).services.legacy).toEqual({
    image: "example/legacy:1",
    platform: "linux/amd64",
  });
  expectInvalid(() =>
    adaptNativeProject({
      input: original,
      selection: {
        version: 1,
        amd64Emulation: { services: { missing: "amd64" } },
      },
    })
  );
});

test("runtime arguments request emulation only for opted-in services", () => {
  expect(nativeEnsureImageArgs("redis", undefined)).toEqual([
    "runtime",
    "ensure-image",
    "--reference",
    "redis",
    "--json",
  ]);
  expect(nativeEnsureImageArgs("example/a:1", "prefer-native")).toEqual([
    "runtime",
    "ensure-image",
    "--reference",
    "example/a:1",
    "--emulation",
    "prefer-native",
    "--json",
  ]);
  expect(nativeAmd64EmulationUpArgs(undefined)).toEqual([]);
  expect(nativeAmd64EmulationUpArgs({})).toEqual([]);
  expect(nativeAmd64EmulationUpArgs({ web: "amd64" })).toEqual([
    "--amd64-emulation",
  ]);
  // Replies are confirmed against the request: amd64 only for an opted-in service.
  expect(ensuredPlatformAccepted(undefined, undefined)).toBe(true);
  expect(ensuredPlatformAccepted("linux/arm64", undefined)).toBe(true);
  expect(ensuredPlatformAccepted("linux/arm64", "amd64")).toBe(false);
  expect(ensuredPlatformAccepted("linux/amd64", "amd64")).toBe(true);
  expect(ensuredPlatformAccepted("linux/arm64", "prefer-native")).toBe(true);
  expect(ensuredPlatformAccepted("linux/amd64", undefined)).toBe(false);
  expect(ensuredPlatformAccepted("linux/amd64", "prefer-native")).toBe(true);
  expect(ensuredPlatformAccepted("linux/386", "amd64")).toBe(false);
  expect(ensuredPlatformAccepted(1, "amd64")).toBe(false);
});

test("host Rosetta detection requires Apple silicon macOS and an executable regular runtime", async () => {
  const root = await scratch();
  const runtime = join(root, "rosetta");
  await writeFile(runtime, "#!/bin/sh\n");
  await chmod(runtime, 0o755);
  const link = join(root, "link");
  await symlink(runtime, link);
  const plain = join(root, "plain");
  await writeFile(plain, "data");
  await chmod(plain, 0o644);
  const apple = { platform: "darwin" as const, arch: "arm64" };
  expect(await hostRosettaAvailable({ ...apple, path: runtime })).toBe(true);
  expect(await hostRosettaAvailable({ ...apple, path: link })).toBe(false);
  expect(await hostRosettaAvailable({ ...apple, path: plain })).toBe(false);
  expect(
    await hostRosettaAvailable({ ...apple, path: join(root, "missing") })
  ).toBe(false);
  expect(
    await hostRosettaAvailable({
      platform: "darwin",
      arch: "x64",
      path: runtime,
    })
  ).toBe(false);
  expect(
    await hostRosettaAvailable({
      platform: "linux",
      arch: "arm64",
      path: runtime,
    })
  ).toBe(false);
});

test("the feature gate accepts linux/amd64 only for opted-in services", () => {
  const compose = {
    services: {
      legacy: { image: "example/legacy:1", platform: "linux/amd64" },
      web: { image: "example/web:1", platform: "linux/arm64" },
    },
  };
  expect(findComposeBackendFeatures(compose)).toEqual(["foreign_platform"]);
  expect(
    findComposeBackendFeatures(compose, {
      emulatedServices: new Set(["web"]),
    })
  ).toEqual(["foreign_platform"]);
  expect(
    findComposeBackendFeatures(compose, {
      emulatedServices: new Set(["legacy"]),
    })
  ).toEqual([]);
  // Other foreign platforms stay foreign even when opted in.
  expect(
    findComposeBackendFeatures(
      { services: { legacy: { image: "x", platform: "linux/386" } } },
      { emulatedServices: new Set(["legacy"]) }
    )
  ).toEqual(["foreign_platform"]);
});

test("the gate and doctor read the same adaptation file as native start", async () => {
  const root = await scratch();
  const composeFile = join(root, "docker-compose.yml");
  await writeFile(
    composeFile,
    "services:\n  legacy:\n    image: example/legacy:1\n    platform: linux/amd64\n  web:\n    image: example/web:1\n"
  );
  const adaptationFile = join(root, "adaptation.json");
  expect(await readComposeBackendFeatures(composeFile)).toEqual([
    "foreign_platform",
  ]);
  await writeFile(
    adaptationFile,
    JSON.stringify({
      version: 1,
      amd64Emulation: { services: { legacy: "prefer-native" } },
    })
  );
  expect(
    await readComposeBackendFeatures(composeFile, { adaptationFile })
  ).toEqual([]);
  expect([
    ...(await readAdaptedEmulatedServices(adaptationFile, ["legacy", "web"])),
  ]).toEqual(["legacy"]);
  expect([
    ...(await readNativePlatformModes({ composeFile, adaptationFile })),
  ]).toEqual([
    ["legacy", "prefer-native"],
    ["web", "native"],
  ]);
  expect([...(await readNativePlatformModes({ composeFile }))]).toEqual([
    ["legacy", "native"],
    ["web", "native"],
  ]);
  await writeFile(
    adaptationFile,
    JSON.stringify({
      version: 1,
      amd64Emulation: { services: { "private-canary": "amd64" } },
    })
  );
  await expect(
    readComposeBackendFeatures(composeFile, { adaptationFile })
  ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
  await expect(
    readNativePlatformModes({ composeFile, adaptationFile })
  ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
});

test("doctor warns for emulated services with counts only and names the Rosetta fix", () => {
  const none = amd64EmulationCheckResult({
    modes: new Map([["web", "native"]]),
    hostRosetta: false,
  });
  expect(none).toMatchObject({
    name: AMD64_EMULATION_CHECK,
    status: "ok",
    amd64Emulation: { amd64: 0, preferNative: 0, hostRosetta: false },
  });
  const modes = new Map([
    ["private-canary-a", "amd64"],
    ["private-canary-b", "prefer-native"],
    ["web", "native"],
  ] as const);
  const ready = amd64EmulationCheckResult({ modes, hostRosetta: true });
  expect(ready.status).toBe("warn");
  expect(ready.message).toContain(
    "2 services opt in to amd64 (x86_64) emulation"
  );
  expect(ready.message).toContain("Rosetta 2");
  expect(ready.amd64Emulation).toEqual({
    amd64: 1,
    preferNative: 1,
    hostRosetta: true,
  });
  const missing = amd64EmulationCheckResult({ modes, hostRosetta: false });
  expect(missing.status).toBe("warn");
  expect(missing.message).toContain("softwareupdate --install-rosetta");
  for (const result of [none, ready, missing]) {
    expect(JSON.stringify(result)).not.toContain("private-canary");
    expect(result.message).not.toContain("linux/amd64");
  }
});
