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
  { ...daemon, arch: "amd64" },
  { ...daemon, arch: "x86_64" },
  { ...daemon, arch: "arm" },
  { ...daemon, arch: "__proto__" },
])("unqualified or changed daemon dependency refuses without a fallback", (value) => {
  expect(() =>
    selectNativeComposeStorageDockerDependency({ daemon: value, engineId })
  ).toThrow("values omitted");
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
