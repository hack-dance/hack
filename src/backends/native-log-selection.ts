import { ClosedCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { withPinnedRuntimeBinary } from "./native-authored-runtime-binary.ts";
import type { NativeLogFollowSelection } from "./native-log-follow.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const CONTAINER = /^[a-f0-9]{64}$/;
function refused(): never {
  throw new ClosedCliError(
    "Native log container selection is unavailable or changed."
  );
}

/** Finite, lease-free re-admission; following rechecks this exact container. */
export async function selectNativeLogContainer(input: {
  readonly runtime: NativeRuntimeSelection;
  readonly cwd: string;
  readonly service: string;
  readonly selection: NativeLogFollowSelection;
  readonly signal: AbortSignal;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<NativeLogFollowSelection> {
  return await withPinnedRuntimeBinary(
    { binary: input.runtime.binary, signal: input.signal, refused },
    async (pin) => {
      await pin.check();
      input.signal.throwIfAborted();
      pin.checkSync();
      const value = await (input.invoke ?? invokeNativeRuntime)({
        runtime: input.runtime,
        cwd: input.cwd,
        signal: input.signal,
        timeoutMs: 5000,
        processGroup: "own",
        args: [
          "graph",
          "logs-follow",
          "--selection-only",
          "--run-id",
          input.selection.run,
          "--service",
          input.service,
          "--expect-owner",
          input.selection.owner,
          "--expect-plan",
          input.selection.plan,
          "--expect-namespace",
          input.selection.namespace,
          ...(input.selection.native ? ["--native"] : []),
        ],
      });
      await pin.check();
      input.signal.throwIfAborted();
      if (
        !isRecord(value) ||
        Object.keys(value).sort().join(",") !==
          "container,kind,service,version" ||
        value.version !== 1 ||
        value.kind !== "native-log-selection" ||
        value.service !== input.service ||
        typeof value.container !== "string" ||
        !CONTAINER.test(value.container)
      ) {
        return refused();
      }
      return { ...input.selection, container: value.container };
    }
  );
}
