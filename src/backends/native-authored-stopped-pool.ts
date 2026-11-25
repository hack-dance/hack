/**
 * A native-authored run whose pool stopped under it (HACK-2715).
 *
 * After `runtime down --force`, a crash or a host reboot, the run's receipt
 * still belongs to the pool boot that ended, and its foreground owner exited
 * with that boot. Its recovery is the explicit dead-owner cleanup
 * (`hack down --recover`, or plain `hack down` once the owner is gone), which
 * needs a running pool: the runtime removes the run's stopped containers in
 * the new boot. So recovery first starts a stopped pool with the arguments
 * every project start sends, as the Compose recovery does (HACK-2456), and
 * says so once. A pool that is running, or whose status cannot be read, is
 * left as it is; the recovery then reports its own result.
 *
 * Starting the pool grants nothing: the recovery still proves the owner dead,
 * the receipt unchanged and the run's boot an earlier boot of this pool owner
 * before any cleanup, and refuses by name a run whose state is bound to the
 * ended boot (`native_graph_ended_boot_unsupported`).
 */

import {
  nativeProjectRuntimeUpArgs,
  nativeRuntimePoolStopped,
} from "./native-project-runtime-up.ts";
import type { NativeRuntimeSelection } from "./native-runtime-client.ts";
import { invokeNativeRuntime } from "./native-runtime-client.ts";

/** The one line recovery prints when it starts a stopped pool. */
export const NATIVE_AUTHORED_STOPPED_POOL_NOTICE =
  "The native runtime is stopped; starting it to recover this project's run, with its data kept.";

/** The refusal code of a run of an ended boot that recovery does not support. */
export const NATIVE_GRAPH_ENDED_BOOT_UNSUPPORTED =
  "native_graph_ended_boot_unsupported";

/**
 * Start the pool when `runtime status` proves it stopped. Returns whether it
 * started it. A failed `runtime up` throws its own error.
 */
export async function startStoppedPoolForAuthoredRecovery(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly notice?: (line: string) => void;
}): Promise<boolean> {
  const invoke = opts.invoke ?? invokeNativeRuntime;
  if (
    !(await nativeRuntimePoolStopped({
      runtime: opts.runtime,
      projectRoot: opts.projectRoot,
      invoke,
    }))
  ) {
    return false;
  }
  (opts.notice ?? ((line: string) => process.stderr.write(`${line}\n`)))(
    NATIVE_AUTHORED_STOPPED_POOL_NOTICE
  );
  await invoke({
    runtime: opts.runtime,
    cwd: opts.projectRoot,
    args: [...nativeProjectRuntimeUpArgs(opts.projectRoot), "--json"],
  });
  return true;
}
