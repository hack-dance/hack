import { createHash } from "node:crypto";
import { NATIVE_STORAGE_WITNESS_HELPER } from "./native-compose-storage-witness-helper-bundle.ts";
import type { NativeComposeStorageXattrArtifact } from "./native-compose-storage-witness-xattr-carrier.ts";
import { refuseNativeComposeStorageXattr as refuse } from "./native-compose-storage-witness-xattr-codec.ts";

/** Explicit cached dependency; the owner never pulls or builds this image. Other
 * platforms require their own artifact/ABI/volume qualification before admission. */
export const NATIVE_STORAGE_DOCKER_ARTIFACT: NativeComposeStorageXattrArtifact = Object.freeze({
  version: 1,
  imageId: "sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61",
  platform: "linux/arm64",
  bunVersion: "1.4.2",
  bunHash: "616f267a34278ff5ac282df37ffdfba1d7141f4f6926bca99af2cd6ef3ad32b1",
  libcHash: "9a325944115b36e74077786b29531963d96cd55cd6c82f11750a352cdb58fab0",
  helperHash: "9d9c322ee35f43e047a41fd4901926789673a072c1e0bbf9030a106e7050ba5f",
  kernelAbi: 1,
});
export function nativeComposeStorageDockerHelper(): string {
  if (createHash("sha256").update(NATIVE_STORAGE_WITNESS_HELPER).digest("hex") !== NATIVE_STORAGE_DOCKER_ARTIFACT.helperHash) return refuse();
  return NATIVE_STORAGE_WITNESS_HELPER;
}
