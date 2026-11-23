/**
 * Doctor project check: a project that builds images on a native home that has
 * no image builder.
 *
 * Native `up` builds a Compose `build:` service with the pinned image builder
 * that `hack native setup` installs. A home set up before setup installed it
 * is ready for everything else, so nothing says the builder is missing until a
 * build refuses. This check says it first, with the same remedy as that
 * refusal.
 *
 * It reads the Compose file and, only when a service builds, asks the runtime
 * for its read-only setup inspection. It never installs or downloads anything,
 * and `--fix` does not either: adding the builder needs the download consent
 * that `hack native setup --accept-downloads` gives.
 *
 * The check's message is also doctor's JSON `detail`, which is stored and
 * passed on. It names the setup command as every builder message does: `hack`
 * for a stable install, `~/<path>` for a candidate launcher under the user's
 * home. That command runs as pasted and shows no home directory. The
 * builder's own paths in it are relative to the native home.
 *
 * The inspection is record-level: it does not hash the builder. A builder
 * whose bytes changed under an intact record reads as installed here; the
 * build and `hack native setup` verify the bytes and say so.
 */

import type {
  invokeNativeRuntime,
  NativeRuntimeSelection,
} from "../backends/native-runtime-client.ts";
import {
  inspectNativeSetup,
  type NativeSetupBuilderState,
} from "../backends/native-runtime-setup.ts";
import type { CandidateLauncher } from "./candidate-launcher.ts";
import { isRecord } from "./guards.ts";
import {
  NATIVE_BUILDER_CHANGED,
  NATIVE_BUILDER_MISSING,
  type NativeBuilderPaths,
  nativeBuilderChangedRemedy,
  nativeBuilderRemedy,
} from "./native-image-builder.ts";

/** Doctor check id for the native image builder. */
export const NATIVE_BUILDER_CHECK = "native image builder";

/** The `nativeBuilder` JSON field: a count and a closed state, no names or paths. */
export type NativeBuilderReport = {
  /** Services with a Compose `build`, whatever their profiles. */
  readonly buildServices: number;
  /**
   * What the runtime reported. `not_checked` when no service builds, so the
   * runtime was not asked; `unknown` when it was asked and did not say.
   */
  readonly builder: NativeSetupBuilderState | "unknown" | "not_checked";
};

/** How many services of a parsed Compose document have a `build`. */
export function countNativeBuildServices(compose: unknown): number {
  if (!(isRecord(compose) && isRecord(compose.services))) {
    return 0;
  }
  return Object.values(compose.services).filter(
    (service) =>
      isRecord(service) && service.build !== undefined && service.build !== null
  ).length;
}

/** The doctor result for a known service count and builder state. */
export function nativeBuilderCheckResult(opts: {
  readonly buildServices: number;
  readonly builder: NativeBuilderReport["builder"];
  /** The builder's paths under the native home, for the changed remedy. */
  readonly paths?: NativeBuilderPaths;
  /** Names the setup command for this install kind (default: this process). */
  readonly launcher?: CandidateLauncher;
  /** The user's home directory (default: `os.homedir()`). */
  readonly homeDir?: string;
}): {
  readonly name: typeof NATIVE_BUILDER_CHECK;
  readonly status: "ok" | "warn";
  readonly message: string;
  readonly nativeBuilder: NativeBuilderReport;
} {
  const name = NATIVE_BUILDER_CHECK;
  if (opts.buildServices === 0) {
    return {
      name,
      status: "ok",
      message:
        "No service builds an image, so this project does not need the native image builder.",
      nativeBuilder: { buildServices: 0, builder: "not_checked" },
    };
  }
  const nativeBuilder = {
    buildServices: opts.buildServices,
    builder: opts.builder,
  };
  const one = opts.buildServices === 1;
  const scope = one
    ? "1 service builds an image"
    : `${opts.buildServices} services build an image`;
  switch (opts.builder) {
    case "prepared":
      return {
        name,
        status: "ok",
        message: `${scope}; the image builder is installed in this native home.`,
        nativeBuilder,
      };
    case "not_prepared":
      return {
        name,
        status: "warn",
        message: `${scope}, but ${NATIVE_BUILDER_MISSING}, so native up cannot build ${one ? "it" : "them"}. ${nativeBuilderRemedy(opts)}`,
        nativeBuilder,
      };
    case "changed":
      return {
        name,
        status: "warn",
        message: `${scope}, but ${NATIVE_BUILDER_CHANGED}, so native up refuses to build with it. ${nativeBuilderChangedRemedy(opts)}`,
        nativeBuilder,
      };
    default:
      return {
        name,
        status: "warn",
        message: `${scope}, but the native runtime did not report its image builder, so it could not be checked.`,
        nativeBuilder,
      };
  }
}

/**
 * Check the image builder for a project's parsed Compose document. A project
 * without build services is answered without a runtime request. Otherwise the
 * one request is the read-only `runtime setup inspect --json`; a runtime that
 * fails or does not report the builder is a warning, never a doctor failure.
 */
export async function checkNativeImageBuilder(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly cwd: string;
  /** The parsed Compose document; anything unreadable counts as no builds. */
  readonly compose: unknown;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly launcher?: CandidateLauncher;
  readonly homeDir?: string;
}): Promise<ReturnType<typeof nativeBuilderCheckResult>> {
  const buildServices = countNativeBuildServices(opts.compose);
  if (buildServices === 0) {
    return nativeBuilderCheckResult({ buildServices, builder: "not_checked" });
  }
  const reported = await inspectNativeSetup({
    runtime: opts.runtime,
    cwd: opts.cwd,
    invoke: opts.invoke,
  }).then(
    (inspection) => inspection.builder,
    () => undefined
  );
  return nativeBuilderCheckResult({
    buildServices,
    builder: reported?.state ?? "unknown",
    paths: reported?.paths,
    launcher: opts.launcher,
    homeDir: opts.homeDir,
  });
}
