import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { sameFile } from "../lib/native-compose-private-state.ts";
import { parseNativeAuthoredControl } from "./native-authored-graph-protocol.ts";
import {
  type NativeAuthoredProjectRunScope,
  nativeAuthoredProjectNamespace,
  withNativeAuthoredProjectStatus,
} from "./native-authored-project-run.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

function refused(): never {
  throw new Error(
    "Native authored status is unconfirmed or its selection changed; values omitted."
  );
}
function active(signal?: AbortSignal) {
  if (signal?.aborted) {
    return refused();
  }
}
type Item = {
  readonly service: string;
  readonly container: string;
  readonly state: string;
  readonly health: string | null;
  readonly exitCode: number | null;
};
export type NativeAuthoredProjectStatus = {
  readonly backend: "native";
  readonly status: "not_started" | "pending" | "observed";
  readonly run: string | null;
  readonly phase: string | null;
  readonly items: readonly Item[];
};

/** One authenticated current status request, with no input acquisition or mutation.
 * Receipt phase is historical; only fresh member observations supply state/health. */
export async function nativeAuthoredProjectPs(input: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeAuthoredProjectRunScope;
  readonly signal?: AbortSignal;
  readonly invoke?: typeof invokeNativeRuntime;
  /** Control seam; production always uses the held saved-status owner. */
  readonly withStatus?: typeof withNativeAuthoredProjectStatus;
}): Promise<NativeAuthoredProjectStatus> {
  const runtime = { ...input.runtime },
    scope = { ...input.scope },
    signal = input.signal;
  const invoke = input.invoke ?? invokeNativeRuntime;
  const withStatus = input.withStatus ?? withNativeAuthoredProjectStatus;
  active(signal);
  if (runtime.home !== scope.nativeHome) {
    return refused();
  }
  const result = await withStatus<NativeAuthoredProjectStatus>(
    scope,
    async (saved) => {
      active(signal);
      if (!saved.ready) {
        return {
          backend: "native",
          status: saved.pending ? "pending" : "not_started",
          run: null,
          phase: null,
          items: [],
        };
      }
      const receipt = saved.ready.record.receipt;
      if (
        receipt.review.provenance.namespace !==
        nativeAuthoredProjectNamespace(scope)
      ) {
        return refused();
      }
      if ((await realpath(runtime.binary)) !== runtime.binary) {
        return refused();
      }
      const file = await open(
        runtime.binary,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      try {
        const original = await file.stat();
        const check = async () => {
          active(signal);
          const named = await lstat(runtime.binary),
            held = await file.stat();
          if (
            !original.isFile() ||
            original.nlink !== 1 ||
            (original.mode & 0o022) !== 0 ||
            (original.mode & 0o111) === 0 ||
            !named.isFile() ||
            !sameFile(original, named) ||
            !sameFile(original, held) ||
            [named, held].some(
              (info) =>
                info.size !== original.size ||
                info.mtimeMs !== original.mtimeMs ||
                info.ctimeMs !== original.ctimeMs ||
                info.mode !== original.mode ||
                info.uid !== original.uid ||
                info.nlink !== 1
            ) ||
            (await realpath(runtime.binary)) !== runtime.binary
          ) {
            return refused();
          }
          await saved.assertFresh();
          active(signal);
        };
        await check();
        const value = await invoke({
          runtime,
          cwd: scope.projectRoot,
          args: [
            "graph",
            "native",
            "control",
            "--run-id",
            receipt.review.provenance.run,
            "--action",
            "status",
            "--json",
          ],
          timeoutMs: 15_000,
          signal,
          boundNativeStatusDrain: true,
        });
        await check();
        const current = parseNativeAuthoredControl(value, receipt, "status");
        const items: Item[] = Object.entries(current.receipt.readiness).map(
          ([service]) => {
            const observation = current.observations?.[service];
            const resource = current.receipt.resources[`container:${service}`];
            if (!resource?.id) {
              return refused();
            }
            return {
              service,
              container: resource.id,
              state: observation?.state ?? "absent",
              health:
                observation?.state === "running" ? observation.health : null,
              exitCode:
                observation?.state === "exited" ? observation.code : null,
            };
          }
        );
        await check();
        return {
          backend: "native",
          status: "observed",
          run: receipt.review.provenance.run,
          phase: current.receipt.phase,
          items,
        };
      } finally {
        await file.close();
      }
    }
  );
  active(signal);
  return result;
}
