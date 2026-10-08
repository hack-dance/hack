import { isRecord } from "./guards.ts";
import { refuseNativeComposeFile } from "./native-compose-file-bytes.ts";
import { nativeComposeFileMode } from "./native-compose-file-permissions.ts";
import { NativeConfigCompilerError } from "./native-config-compiler.ts";
import { authoredFilePlanningRequired } from "./native-file-plan-protocol.ts";

function unsupported(): never {
  throw new NativeConfigCompilerError(
    "E_NATIVE_PROJECT_UNSUPPORTED",
    "Native file delivery requires read-only mode 0444, 0400 or 0600, no UID/GID override and no builds. Values omitted."
  );
}
function assertWorkloadSubset(workload: unknown): void {
  if (!isRecord(workload)) {
    refuseNativeComposeFile();
  }
  if (Object.hasOwn(workload, "build")) {
    unsupported();
  }
  if (!Array.isArray(workload.mounts)) {
    return;
  }
  for (const mount of workload.mounts) {
    if (
      !(
        isRecord(mount) &&
        (Object.hasOwn(mount, "config") || Object.hasOwn(mount, "secret"))
      )
    ) {
      continue;
    }
    const mode = Object.hasOwn(mount, "mode") ? mount.mode : undefined;
    if (
      mount.access !== "read-only" ||
      (mode !== undefined && nativeComposeFileMode(mode) === undefined) ||
      Object.hasOwn(mount, "uid") ||
      Object.hasOwn(mount, "gid")
    ) {
      unsupported();
    }
  }
}
/** All authored workloads, including inactive builds and grants, precede private acquisition. */
export function assertNativeComposeFileSubset(input: Uint8Array): void {
  const raw: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(input)
  );
  if (!(isRecord(raw) && authoredFilePlanningRequired(input))) {
    refuseNativeComposeFile();
  }
  for (const namespace of [raw.services, raw.jobs]) {
    if (isRecord(namespace)) {
      for (const workload of Object.values(namespace)) {
        assertWorkloadSubset(workload);
      }
    }
  }
}
