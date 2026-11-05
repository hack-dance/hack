import { ClosedCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

/** Native code: the pool exists but does not share this exact project root yet. */
export const NATIVE_PROJECT_SHARE_EXTENSION_REQUIRED =
  "project_share_extension_required";

/**
 * Reject incompatible source pools before hooks; runtime up rechecks before effects.
 *
 * One pool hosts several project roots. When the pool does not share this root yet,
 * a stopped pool gains it through the runtime's journaled stopped-pool share update
 * (mounted at the next boot), with the same explicit unfiltered-source consent the
 * first root's `up` gives. A running pool's mounts never change: that case refuses
 * before hooks with the steps that make the root shareable.
 */
export async function preflightNativeProjectSource(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<void> {
  const invoke = opts.invoke ?? invokeNativeRuntime;
  const check = () =>
    invoke({
      runtime: opts.runtime,
      cwd: opts.runtime.home,
      args: [
        "runtime",
        "check-project-share",
        "--project-share",
        opts.projectRoot,
        "--unfiltered-source",
        "--json",
      ],
      timeoutMs: 5000,
      signal: opts.signal,
    });
  let result: unknown;
  try {
    result = await check();
  } catch (error) {
    if (
      !(error instanceof NativeRuntimeRequestError) ||
      error.nativeCode !== NATIVE_PROJECT_SHARE_EXTENSION_REQUIRED
    ) {
      throw error;
    }
    await addNativeProjectShare({ ...opts, invoke });
    result = await check();
  }
  if (
    !isRecord(result) ||
    result.source_admitted !== true ||
    typeof result.pool_initialized !== "boolean"
  ) {
    throw new ClosedCliError(
      "Native source admission returned an invalid receipt; startup hooks were not run."
    );
  }
}

async function addNativeProjectShare(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  readonly invoke: typeof invokeNativeRuntime;
}): Promise<void> {
  const status = await opts.invoke({
    runtime: opts.runtime,
    cwd: opts.runtime.home,
    args: ["runtime", "status", "--json"],
    timeoutMs: 5000,
    signal: opts.signal,
  });
  if (!isRecord(status) || typeof status.phase !== "string") {
    throw new ClosedCliError(
      "Native runtime status returned an invalid receipt; the project share was not changed and startup hooks were not run."
    );
  }
  if (status.phase === "running" || status.process_alive === true) {
    throw new ClosedCliError(
      "The running native pool does not share this project root, and a running pool's mounts never change. " +
        "Stop the native projects that use this pool (`down` in each), stop the pool (`runtime down --json` on this native home), then run `up` here again: " +
        "the stopped pool adds this root and shares it from the next boot. Startup hooks were not run."
    );
  }
  const added = await opts.invoke({
    runtime: opts.runtime,
    cwd: opts.runtime.home,
    args: [
      "runtime",
      "project-share",
      "add",
      "--project-share",
      opts.projectRoot,
      "--unfiltered-source",
      "--json",
    ],
    timeoutMs: 30_000,
    signal: opts.signal,
  });
  if (
    !isRecord(added) ||
    added.kind !== "project_share_added" ||
    added.project !== opts.projectRoot ||
    added.restarted !== false ||
    added.disks_preserved !== true
  ) {
    throw new ClosedCliError(
      "Native project share update returned an invalid receipt; startup hooks were not run."
    );
  }
}
