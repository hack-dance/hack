import { expect, test } from "bun:test";
import { assertNativeComposeStorageDockerImage } from "../src/lib/native-compose-storage-witness-docker.ts";
import {
  NATIVE_STORAGE_DOCKER_ARTIFACT,
  NATIVE_STORAGE_DOCKER_DEPENDENCIES,
  nativeComposeStorageDockerImageReference,
  selectNativeComposeStorageDockerDependency,
} from "../src/lib/native-compose-storage-witness-docker-artifact.ts";
import {
  captureNativeComposeStorageXattrArtifact,
  NATIVE_STORAGE_HELPER_BUN_VERSION,
  nativeComposeStorageXattrArtifactValid,
} from "../src/lib/native-compose-storage-witness-xattr-carrier.ts";
import {
  NATIVE_COMPOSE_VM_FILE_IMAGE,
  NATIVE_COMPOSE_VM_FILE_SAVED_IMAGES,
} from "../src/lib/native-compose-vm-file-protocol.ts";

const engineId = "fixture-engine";
const daemon = { id: engineId, os: "linux", arch: "arm64" };

test("classic image store resolves the pinned repository digest without a bare index lookup", async () => {
  const dependency = NATIVE_STORAGE_DOCKER_DEPENDENCIES["linux/amd64"];
  if (!dependency) {
    throw new Error("Missing qualified AMD record");
  }
  const reference = `oven/bun@${dependency.artifact.imageId}`;
  const configId = dependency.imageIds[2];
  const observed: string[][] = [];
  await assertNativeComposeStorageDockerImage(async (args) => {
    observed.push([...args]);
    // Classic GetImage looks up a bare digest in the config store. The pulled
    // repository digest instead resolves to this already-qualified config ID.
    if (args.at(-1) !== reference || typeof configId !== "string") {
      throw new Error("No such cached image");
    }
    return JSON.stringify({
      id: configId,
      os: "linux",
      arch: "amd64",
      volumes: null,
    });
  }, dependency);
  expect(observed).toHaveLength(1);
  expect(observed[0]?.at(-1)).toBe(reference);
});

test.each([
  "arm64",
  "aarch64",
])("dependency selects the observed %s daemon and snapshots its pins", (arch) => {
  const expected = NATIVE_STORAGE_DOCKER_DEPENDENCIES["linux/arm64"];
  if (!expected) {
    throw new Error("Missing qualified byte record");
  }
  const selected = selectNativeComposeStorageDockerDependency({
    daemon: { ...daemon, arch },
    engineId,
  });
  expect(selected).toEqual(expected);
  expect(Object.isFrozen(selected.artifact)).toBe(true);
  expect(Object.isFrozen(selected.imageIds)).toBe(true);
});

test.each([
  { ...daemon, id: "foreign-engine" },
  { ...daemon, os: "windows" },
  { ...daemon, arch: "riscv64" },
  { ...daemon, arch: "s390x" },
  { ...daemon, arch: "arm" },
  { ...daemon, arch: "__proto__" },
])("unqualified or changed daemon dependency refuses without a fallback", (value) => {
  expect(() =>
    selectNativeComposeStorageDockerDependency({ daemon: value, engineId })
  ).toThrow("values omitted");
});

test.each([
  "amd64",
  "x86_64",
])("qualified %s daemon selects exact AMD byte and image records", (arch) => {
  const selected = selectNativeComposeStorageDockerDependency({
    daemon: { ...daemon, arch },
    engineId,
  });
  expect(selected.artifact).toEqual({
    version: 1,
    imageId:
      "sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4",
    platform: "linux/amd64",
    bunVersion: "1.4.4",
    bunHash: "10702245766b225e70bbf6235fd6b47214fd94b4760d00ffaed8ab0df57ac235",
    libcHash:
      "9792e3cbb541c8f44c7acf5f14f4022ea62998ecc787d326bed4d8b6547dfd92",
    helperHash:
      "9d9c322ee35f43e047a41fd4901926789673a072c1e0bbf9030a106e7050ba5f",
    kernelAbi: 1,
  });
  expect(selected.imageIds).toEqual([
    selected.artifact.imageId,
    "sha256:13b43f8bb2c63f5d89c56205c4279b85620363296a00ada33ff7ad568f3688e7",
    "sha256:bca1fb36a1a809a0aec806c0a239364f4873ead989e7f069e0a47f17e0a83cfa",
  ]);
  expect(Object.isFrozen(selected.artifact)).toBe(true);
  expect(Object.isFrozen(selected.imageIds)).toBe(true);
});

test("missing or mixed AMD catalog cannot borrow ARM dependency pins", () => {
  const amdDaemon = { ...daemon, arch: "amd64" };
  for (const dependencies of [
    {},
    { "linux/arm64": NATIVE_STORAGE_DOCKER_DEPENDENCIES["linux/arm64"] },
    { "linux/amd64": NATIVE_STORAGE_DOCKER_DEPENDENCIES["linux/arm64"] },
  ]) {
    expect(() =>
      selectNativeComposeStorageDockerDependency({
        daemon: amdDaemon,
        engineId,
        dependencies,
      })
    ).toThrow("values omitted");
  }
});

test("synthetic amd64 catalog is selected by daemon and captured without an artifact substitution", () => {
  // Synthetic protocol control only; these pins never enter the shipped catalog.
  const candidate = {
    artifact: {
      ...NATIVE_STORAGE_DOCKER_ARTIFACT,
      platform: "linux/amd64" as const,
      bunHash: "b".repeat(64),
      libcHash: "c".repeat(64),
    },
    imageIds: [
      NATIVE_STORAGE_DOCKER_ARTIFACT.imageId,
      `sha256:${"d".repeat(64)}`,
      `sha256:${"e".repeat(64)}`,
    ],
  };
  const selected = selectNativeComposeStorageDockerDependency({
    daemon: { ...daemon, arch: "x86_64" },
    engineId,
    dependencies: { "linux/amd64": candidate },
  });
  candidate.artifact.bunHash = "f".repeat(64);
  candidate.imageIds[1] = `sha256:${"f".repeat(64)}`;
  expect(selected.artifact.platform).toBe("linux/amd64");
  expect(selected.artifact.bunHash).toBe("b".repeat(64));
  expect(selected.imageIds[1]).toBe(`sha256:${"d".repeat(64)}`);
});

test("matching index, manifest and config image identities retain exact platform and no-volume policy", async () => {
  const dependency = NATIVE_STORAGE_DOCKER_DEPENDENCIES["linux/arm64"];
  if (!dependency) {
    throw new Error("Missing qualified byte record");
  }
  for (const id of dependency.imageIds) {
    let calls = 0;
    await assertNativeComposeStorageDockerImage(async (argv) => {
      calls++;
      expect(argv.at(-1)).toBe(
        nativeComposeStorageDockerImageReference(dependency.artifact)
      );
      return JSON.stringify({ id, os: "linux", arch: "arm64", volumes: null });
    });
    expect(calls).toBe(1);
  }
  for (const value of [
    {
      id: `sha256:${"f".repeat(64)}`,
      os: "linux",
      arch: "arm64",
      volumes: null,
    },
    {
      id: dependency.artifact.imageId,
      os: "linux",
      arch: "amd64",
      volumes: null,
    },
    {
      id: dependency.artifact.imageId,
      os: "linux",
      arch: "arm64",
      volumes: {},
    },
  ]) {
    await expect(
      assertNativeComposeStorageDockerImage(async () => JSON.stringify(value))
    ).rejects.toThrow("values omitted");
  }
});

test("AMD cached image admits only its three identities and exact architecture", async () => {
  const dependency = NATIVE_STORAGE_DOCKER_DEPENDENCIES["linux/amd64"];
  if (!dependency) {
    throw new Error("Missing qualified AMD record");
  }
  for (const id of dependency.imageIds) {
    await assertNativeComposeStorageDockerImage(async (args) => {
      expect(args.at(-1)).toBe(
        nativeComposeStorageDockerImageReference(dependency.artifact)
      );
      return JSON.stringify({ id, os: "linux", arch: "amd64", volumes: null });
    }, dependency);
  }
  for (const value of [
    {
      id: NATIVE_STORAGE_DOCKER_DEPENDENCIES["linux/arm64"]?.imageIds[1],
      os: "linux",
      arch: "amd64",
      volumes: null,
    },
    {
      id: dependency.artifact.imageId,
      os: "linux",
      arch: "arm64",
      volumes: null,
    },
    {
      id: dependency.artifact.imageId,
      os: "linux",
      arch: "amd64",
      volumes: {},
    },
  ]) {
    await expect(
      assertNativeComposeStorageDockerImage(
        async () => JSON.stringify(value),
        dependency
      )
    ).rejects.toThrow("values omitted");
  }
});

test("ARM catalog pins the registry-derived Bun 1.4.4 slim byte records", () => {
  expect(NATIVE_STORAGE_HELPER_BUN_VERSION).toBe("1.4.4");
  expect(NATIVE_STORAGE_DOCKER_ARTIFACT).toEqual({
    version: 1,
    imageId:
      "sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4",
    platform: "linux/arm64",
    bunVersion: "1.4.4",
    bunHash: "354c2b049c716aca07b2e5cddb887928ac58950675d1258bb6312083917793b6",
    libcHash:
      "70fa4c4cf57eabeb96097cce47582d02379c4cd1de3db3e98ade4dd7089a1b13",
    helperHash:
      "9d9c322ee35f43e047a41fd4901926789673a072c1e0bbf9030a106e7050ba5f",
    kernelAbi: 1,
  });
  expect(NATIVE_STORAGE_DOCKER_DEPENDENCIES["linux/arm64"]?.imageIds).toEqual([
    NATIVE_STORAGE_DOCKER_ARTIFACT.imageId,
    "sha256:b0d169a695f779087d0fe8c08b5b17f0d3a927dceac2a087c87a1351340c6565",
    "sha256:f545ab0408208347c62fad5822a4621a4b7fc3a7da43a1dea66dc17335535b7e",
  ]);
  // The VM file path runs from the same cached helper image by its tag.
  expect(NATIVE_COMPOSE_VM_FILE_IMAGE).toBe("oven/bun:1.4.4-slim");
});

// The Bun 1.4.2 slim record an earlier CLI may have written into saved storage state.
const earlier = Object.freeze({
  version: 1,
  imageId:
    "sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61",
  platform: "linux/arm64",
  bunVersion: "1.4.2",
  bunHash: "616f267a34278ff5ac282df37ffdfba1d7141f4f6926bca99af2cd6ef3ad32b1",
  libcHash: "9a325944115b36e74077786b29531963d96cd55cd6c82f11750a352cdb58fab0",
  helperHash: NATIVE_STORAGE_DOCKER_ARTIFACT.helperHash,
  kernelAbi: 1,
} as const);

test("an earlier saved helper pin stays parseable without relabeling, but is never selected or run", () => {
  expect(nativeComposeStorageXattrArtifactValid(earlier)).toBe(true);
  expect(captureNativeComposeStorageXattrArtifact(earlier)).toEqual(earlier);
  expect(() => nativeComposeStorageDockerImageReference(earlier)).toThrow(
    "values omitted"
  );
  for (const artifact of [
    earlier,
    // Current image identity with the earlier Bun label still refuses.
    { ...NATIVE_STORAGE_DOCKER_ARTIFACT, bunVersion: "1.4.2" as const },
  ]) {
    expect(() =>
      selectNativeComposeStorageDockerDependency({
        daemon,
        engineId,
        dependencies: {
          "linux/arm64": {
            artifact,
            imageIds: [
              artifact.imageId,
              `sha256:${"d".repeat(64)}`,
              `sha256:${"e".repeat(64)}`,
            ],
          },
        },
      })
    ).toThrow("values omitted");
  }
  for (const bunVersion of ["1.4.3", "1.4.4 ", "1.4", 1.4]) {
    expect(
      nativeComposeStorageXattrArtifactValid({
        ...NATIVE_STORAGE_DOCKER_ARTIFACT,
        bunVersion,
      })
    ).toBe(false);
  }
});

test("saved VM file manifests accept only the cataloged current and earlier helper tags", () => {
  expect(NATIVE_COMPOSE_VM_FILE_SAVED_IMAGES).toEqual([
    "oven/bun:1.4.2-slim",
    NATIVE_COMPOSE_VM_FILE_IMAGE,
  ]);
  expect(Object.isFrozen(NATIVE_COMPOSE_VM_FILE_SAVED_IMAGES)).toBe(true);
});
