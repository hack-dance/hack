import { isRecord } from "./guards.ts";
import { refuseNativeComposeFile } from "./native-compose-file-bytes.ts";
import { NativeConfigCompilerError } from "./native-config-compiler.ts";
import { authoredFilePlanningRequired } from "./native-file-plan-protocol.ts";

function unsupported(): never {
  throw new NativeConfigCompilerError(
    "E_NATIVE_PROJECT_UNSUPPORTED",
    "Native file delivery requires qualified read-only permission intent and no builds. Values omitted."
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
    if (
      mount.access !== "read-only" ||
      (mount.mode !== undefined &&
        mount.mode !== "0444" &&
        mount.mode !== "0400" &&
        mount.mode !== "0600") ||
      (Object.hasOwn(mount, "uid") &&
        !(
          typeof mount.uid === "number" &&
          Number.isSafeInteger(mount.uid) &&
          mount.uid >= 0 &&
          mount.uid < 0xff_ff_ff_ff
        )) ||
      (Object.hasOwn(mount, "gid") &&
        !(
          typeof mount.gid === "number" &&
          Number.isSafeInteger(mount.gid) &&
          mount.gid >= 0 &&
          mount.gid < 0xff_ff_ff_ff
        ))
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
