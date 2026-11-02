import { createHash } from "node:crypto";
import { isRecord } from "./guards.ts";
import { NATIVE_STORAGE_WITNESS_HELPER } from "./native-compose-storage-witness-helper-bundle.ts";
import {
  captureNativeComposeStorageXattrArtifact,
  type NativeComposeStorageXattrArtifact,
  nativeComposeStorageXattrArtifactValid,
} from "./native-compose-storage-witness-xattr-carrier.ts";
import { refuseNativeComposeStorageXattr as refuse } from "./native-compose-storage-witness-xattr-codec.ts";

/** Explicit cached dependency; the owner never pulls or builds this image. Other
 * platforms require their own artifact/ABI/volume qualification before admission. */
export const NATIVE_STORAGE_DOCKER_ARTIFACT: NativeComposeStorageXattrArtifact =
  Object.freeze({
    version: 1,
    imageId:
      "sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61",
    platform: "linux/arm64",
    bunVersion: "1.4.2",
    bunHash: "616f267a34278ff5ac282df37ffdfba1d7141f4f6926bca99af2cd6ef3ad32b1",
    libcHash:
      "9a325944115b36e74077786b29531963d96cd55cd6c82f11750a352cdb58fab0",
    helperHash:
      "9d9c322ee35f43e047a41fd4901926789673a072c1e0bbf9030a106e7050ba5f",
    kernelAbi: 1,
  });

/** A bare index digest is not an image ID in the classic Engine config store.
 * The immutable repository digest resolves locally in both Engine image stores. */
export function nativeComposeStorageDockerImageReference(
  artifact: Pick<NativeComposeStorageXattrArtifact, "imageId">
): string {
  if (artifact.imageId !== NATIVE_STORAGE_DOCKER_ARTIFACT.imageId) {
    return refuse();
  }
  return `oven/bun@${NATIVE_STORAGE_DOCKER_ARTIFACT.imageId}`;
}

export type NativeComposeStorageDockerDependency = {
  readonly artifact: NativeComposeStorageXattrArtifact;
  /** Exact index, platform manifest and config identities from the byte receipt. */
  readonly imageIds: readonly string[];
};
type Platform = NativeComposeStorageXattrArtifact["platform"];
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
type Dependencies = Readonly<
  Partial<Record<Platform, NativeComposeStorageDockerDependency>>
>;
/** Only qualified byte, ABI and persistent-root records enter this catalog.
 * A missing platform remains a deterministic refusal, never an emulation fallback. */
export const NATIVE_STORAGE_DOCKER_DEPENDENCIES: Dependencies = Object.freeze({
  "linux/arm64": Object.freeze({
    artifact: NATIVE_STORAGE_DOCKER_ARTIFACT,
    imageIds: Object.freeze([
      NATIVE_STORAGE_DOCKER_ARTIFACT.imageId,
      "sha256:5c51cee225076d3c7db2150683141476298062489de4660f2d1729e522641f91",
      "sha256:1cb8f81099813a0ec61f99b69348f6594e188cf1689c20a0a53a5ddd23b37708",
    ]),
  }),
  "linux/amd64": Object.freeze({
    artifact: Object.freeze({
      version: 1,
      imageId:
        "sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61",
      platform: "linux/amd64",
      bunVersion: "1.4.2",
      bunHash:
        "a83d263767d839e4d2649ca8e35d07159c7afc99afdc96d731ced29e056dda0c",
      libcHash:
        "fa430b8f298f817a266046af84a77533185ad6fc4406c7d3787b5a0a0c207826",
      helperHash:
        "9d9c322ee35f43e047a41fd4901926789673a072c1e0bbf9030a106e7050ba5f",
      kernelAbi: 1,
    }),
    imageIds: Object.freeze([
      "sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61",
      "sha256:debbe76858f2e398d2937c1eceeb82c571ac1fcd78aadf00e9634578ac2b5ef7",
      "sha256:808ae5d87c721a0c738c37d17ae4837367baa0c9c4353f5ea1762802b0fb6392",
    ]),
  }),
});

/** Daemon architecture selects a pinned dependency, never the host architecture,
 * a mutable image tag or an emulation fallback. Caller catalogs are test seams. */
export function selectNativeComposeStorageDockerDependency(opts: {
  readonly daemon: unknown;
  readonly engineId: string;
  readonly dependencies?: Dependencies;
}): NativeComposeStorageDockerDependency {
  const daemon = opts.daemon;
  if (
    !(isRecord(daemon) && daemon.id === opts.engineId && daemon.os === "linux")
  ) {
    return refuse();
  }
  let platform: Platform | null = null;
  if (daemon.arch === "arm64" || daemon.arch === "aarch64") {
    platform = "linux/arm64";
  } else if (daemon.arch === "amd64" || daemon.arch === "x86_64") {
    platform = "linux/amd64";
  }
  const dependency = platform
    ? (opts.dependencies ?? NATIVE_STORAGE_DOCKER_DEPENDENCIES)[platform]
    : undefined;
  if (
    !(
      dependency &&
      nativeComposeStorageXattrArtifactValid(dependency.artifact) &&
      Array.isArray(dependency.imageIds)
    ) ||
    dependency.artifact.platform !== platform ||
    dependency.artifact.helperHash !==
      NATIVE_STORAGE_DOCKER_ARTIFACT.helperHash ||
    dependency.imageIds.length !== 3 ||
    new Set(dependency.imageIds).size !== 3 ||
    !dependency.imageIds.includes(dependency.artifact.imageId) ||
    !dependency.imageIds.every((value) => IMAGE_ID.test(value))
  ) {
    return refuse();
  }
  return Object.freeze({
    artifact: captureNativeComposeStorageXattrArtifact(dependency.artifact),
    imageIds: Object.freeze([...dependency.imageIds]),
  });
}
export function nativeComposeStorageDockerHelper(): string {
  if (
    createHash("sha256").update(NATIVE_STORAGE_WITNESS_HELPER).digest("hex") !==
    NATIVE_STORAGE_DOCKER_ARTIFACT.helperHash
  ) {
    return refuse();
  }
  return NATIVE_STORAGE_WITNESS_HELPER;
}
