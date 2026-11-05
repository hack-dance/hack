import { createHash } from "node:crypto";
import { isRecord } from "./guards.ts";
import { NATIVE_STORAGE_WITNESS_HELPER } from "./native-compose-storage-witness-helper-bundle.ts";
import {
  captureNativeComposeStorageXattrArtifact,
  NATIVE_STORAGE_HELPER_BUN_VERSION,
  type NativeComposeStorageXattrArtifact,
  nativeComposeStorageXattrArtifactValid,
} from "./native-compose-storage-witness-xattr-carrier.ts";
import { refuseNativeComposeStorageXattr as refuse } from "./native-compose-storage-witness-xattr-codec.ts";

/** Explicit cached dependency; the owner never pulls or builds this image. Other
 * platforms require their own artifact/ABI/volume qualification before admission.
 * Pins for `oven/bun:1.4.4-slim` were derived from registry bytes: the OCI index,
 * each platform manifest and config, and every layer blob verified against its
 * digest, then `/usr/local/bin/bun` and the architecture's `libc.so.6` hashed from
 * the extracted layers. A tag alone is not a pin. */
export const NATIVE_STORAGE_DOCKER_ARTIFACT: NativeComposeStorageXattrArtifact =
  Object.freeze({
    version: 1,
    imageId:
      "sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4",
    platform: "linux/arm64",
    bunVersion: NATIVE_STORAGE_HELPER_BUN_VERSION,
    bunHash: "354c2b049c716aca07b2e5cddb887928ac58950675d1258bb6312083917793b6",
    libcHash:
      "70fa4c4cf57eabeb96097cce47582d02379c4cd1de3db3e98ade4dd7089a1b13",
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
      "sha256:b0d169a695f779087d0fe8c08b5b17f0d3a927dceac2a087c87a1351340c6565",
      "sha256:f545ab0408208347c62fad5822a4621a4b7fc3a7da43a1dea66dc17335535b7e",
    ]),
  }),
  "linux/amd64": Object.freeze({
    artifact: Object.freeze({
      version: 1,
      imageId:
        "sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4",
      platform: "linux/amd64",
      bunVersion: NATIVE_STORAGE_HELPER_BUN_VERSION,
      bunHash:
        "10702245766b225e70bbf6235fd6b47214fd94b4760d00ffaed8ab0df57ac235",
      libcHash:
        "9792e3cbb541c8f44c7acf5f14f4022ea62998ecc787d326bed4d8b6547dfd92",
      helperHash:
        "9d9c322ee35f43e047a41fd4901926789673a072c1e0bbf9030a106e7050ba5f",
      kernelAbi: 1,
    }),
    imageIds: Object.freeze([
      "sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4",
      "sha256:13b43f8bb2c63f5d89c56205c4279b85620363296a00ada33ff7ad568f3688e7",
      "sha256:bca1fb36a1a809a0aec806c0a239364f4873ead989e7f069e0a47f17e0a83cfa",
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
    dependency.artifact.bunVersion !== NATIVE_STORAGE_HELPER_BUN_VERSION ||
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
