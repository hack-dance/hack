import { ClosedCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { reportNativeImageNotice } from "../lib/native-detached-up.ts";
import { describeLivePoolRuns } from "./native-pool-run-names.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

/** Native code: the pool exists but does not share this exact project root yet. */
export const NATIVE_PROJECT_SHARE_EXTENSION_REQUIRED =
  "project_share_extension_required";
/** Native code: the running pool is in use, so it was not stopped (HACK-2535). */
export const NATIVE_PROJECT_SHARE_POOL_IN_USE = "project_share_pool_in_use";
/** The one line a start prints when it restarts an idle pool for its root. */
export const NATIVE_IDLE_POOL_RESTART_NOTICE =
  "Restarting the native runtime to add this project's folder.";

/**
 * Reject incompatible source pools before hooks; runtime up rechecks before effects.
 *
 * One pool hosts several project roots. When the pool does not share this root yet,
 * a stopped pool gains it through the runtime's journaled stopped-pool share update
 * (mounted at the next boot), with the same explicit unfiltered-source consent the
 * first root's `up` gives. A running pool's mounts never change. When nothing uses it
 * live, it is stopped first, then gains the root the same way, and this start boots
 * it again (HACK-2535; the runtime checks idleness twice under its provider lease).
 * A pool in use, or one still starting or stopping, refuses before hooks with the
 * steps that make the root shareable.
 */
export async function preflightNativeProjectSource(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly signal?: AbortSignal;
  readonly invoke?: typeof invokeNativeRuntime;
  /**
   * Where the idle-pool restart line goes. By default a detached start's owner hands
   * it to the launching CLI over the validated owner notice channel, which prints it
   * on standard error (so `--json` output stays clean); otherwise standard error.
   */
  readonly notice?: (line: string) => void;
  /** Names the projects of live runs in a refusal; see `describeLivePoolRuns`. */
  readonly describe?: (runs: readonly string[]) => Promise<string>;
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
    await addNativeProjectShare({
      ...opts,
      invoke,
      notice: opts.notice ?? writeNotice,
      describe: opts.describe ?? describeLivePoolRuns,
    });
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
  readonly notice: (line: string) => void;
  readonly describe: (runs: readonly string[]) => Promise<string>;
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
  // Only a running pool with a live provider is stopped from here; one still starting
  // or stopping, or a running record whose provider is gone, refuses as before.
  const running = status.phase === "running" && status.process_alive === true;
  if (
    !running &&
    (status.phase === "running" || status.process_alive === true)
  ) {
    throw runningPoolShareRefusal(
      "it is still starting or stopping, or its provider has exited"
    );
  }
  const added = await opts
    .invoke({
      runtime: opts.runtime,
      cwd: opts.runtime.home,
      args: [
        "runtime",
        "project-share",
        "add",
        "--project-share",
        opts.projectRoot,
        "--unfiltered-source",
        ...(running ? ["--stop-idle-pool"] : []),
        "--json",
      ],
      // Stopping the guest takes longer than the stopped-pool record update.
      timeoutMs: running ? 120_000 : 30_000,
      signal: opts.signal,
    })
    .catch(async (error: unknown) => {
      if (
        error instanceof NativeRuntimeRequestError &&
        (error.nativeCode === NATIVE_PROJECT_SHARE_EXTENSION_REQUIRED ||
          error.nativeCode === NATIVE_PROJECT_SHARE_POOL_IN_USE)
      ) {
        throw runningPoolShareRefusal(await inUseReason(opts));
      }
      // `runtime down` refuses while an image build runs, under the same lease.
      if (
        error instanceof NativeRuntimeRequestError &&
        error.nativeCode === "provider_busy"
      ) {
        throw runningPoolShareRefusal("a native image build is running");
      }
      throw error;
    });
  if (
    !isRecord(added) ||
    added.kind !== "project_share_added" ||
    added.project !== opts.projectRoot ||
    added.restarted !== false ||
    added.disks_preserved !== true ||
    (running && typeof added.stopped_idle_pool !== "boolean")
  ) {
    throw new ClosedCliError(
      "Native project share update returned an invalid receipt; startup hooks were not run."
    );
  }
  if (added.stopped_idle_pool === true) {
    opts.notice(NATIVE_IDLE_POOL_RESTART_NOTICE);
  }
}

function writeNotice(line: string): void {
  if (!reportNativeImageNotice(line)) {
    process.stderr.write(`${line}\n`);
  }
}

/** Why the running pool is in use, naming the projects of its live runs. */
async function inUseReason(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly signal?: AbortSignal;
  readonly invoke: typeof invokeNativeRuntime;
  readonly describe: (runs: readonly string[]) => Promise<string>;
}): Promise<string> {
  const status = await opts
    .invoke({
      runtime: opts.runtime,
      cwd: opts.runtime.home,
      args: ["runtime", "status", "--json"],
      timeoutMs: 5000,
      signal: opts.signal,
    })
    .catch(() => undefined);
  const runs =
    isRecord(status) && Array.isArray(status.live_runs)
      ? status.live_runs.filter((run): run is string => typeof run === "string")
      : undefined;
  if (runs === undefined) {
    return "it is in use, and its live runs could not be read";
  }
  if (runs.length === 0) {
    return "it is in use (an open interactive session, which `hack exec-sessions --reconcile` clears once finished, or a pending recovery)";
  }
  return `it is in use by ${await opts.describe(runs)}`;
}

function runningPoolShareRefusal(reason: string): ClosedCliError {
  return new ClosedCliError(
    `The running native pool does not share this project root, and ${reason}, so it was not restarted to add it: a running pool's mounts never change. ` +
      "Stop the native projects that use this pool (`down` in each), then run `up` here again: " +
      "the pool restarts once to add this root. Startup hooks were not run."
  );
}
