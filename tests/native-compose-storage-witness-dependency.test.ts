import { expect, test } from "bun:test";
import { assertNativeComposeStorageDockerImage } from "../src/lib/native-compose-storage-witness-docker.ts";
import {
  NATIVE_STORAGE_DOCKER_ARTIFACT,
  NATIVE_STORAGE_DOCKER_DEPENDENCIES,
  selectNativeComposeStorageDockerDependency,
} from "../src/lib/native-compose-storage-witness-docker-artifact.ts";

const engineId = "fixture-engine";
const daemon = { id: engineId, os: "linux", arch: "arm64" };

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
      "sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61",
    platform: "linux/amd64",
    bunVersion: "1.4.2",
    bunHash: "a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c",
    libcHash:
      "fa430b8f298f817a266046af84a77533185ad6fc4406c7d3787b5a0a0c207826",
    helperHash:
      "9d9c322ee35f43e047a41fd4901926789673a072c1e0bbf9030a106e7050ba5f",
    kernelAbi: 1,
  });
  expect(selected.imageIds).toEqual([
    selected.artifact.imageId,
    "sha256:debbe76858f2e398d2937c1eceeb82c571ac1fcd78aadf00e9634578ac2b5ef7",
    "sha256:808ae5d87c721a0c738c37d17ae4837367baa0c9c4353f5ea1762802b0fb6392",
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
      expect(argv.at(-1)).toBe(dependency.artifact.imageId);
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
      expect(args.at(-1)).toBe(dependency.artifact.imageId);
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
