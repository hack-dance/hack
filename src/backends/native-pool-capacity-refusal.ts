import { ClosedCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { describeLivePoolRuns } from "./native-pool-run-names.ts";
import {
  type invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
  nativeRuntimeFailure,
} from "./native-runtime-client.ts";

const DOCS =
  "https://github.com/hack-dance/hack/blob/next/docs/reference/native-compose-commands.md#native-pool-socket-capacity";

export type PoolCapacityDetail =
  | { readonly kind: "too-small" }
  | { readonly kind: "occupied"; readonly holders?: string };

// Only bounded project labels and reservation counts may cross startup IPC.
const HOLDERS = /^[a-zA-Z0-9 _.,()+-]{1,200}$/;

export function isPoolCapacityDetail(
  value: unknown
): value is PoolCapacityDetail {
  return (
    isRecord(value) &&
    ((value.kind === "too-small" && Object.keys(value).length === 1) ||
      (value.kind === "occupied" &&
        Object.keys(value).every(
          (key) => key === "kind" || key === "holders"
        ) &&
        (value.holders === undefined ||
          (typeof value.holders === "string" && HOLDERS.test(value.holders)))))
  );
}

export function poolCapacityMessage(detail: PoolCapacityDetail): string {
  if (detail.kind === "too-small") {
    return `This native pool was created with too few sockets for this project. Your existing project data stays in the current native home. Starting this project today requires a new native home. See ${DOCS}`;
  }
  const holders = detail.holders
    ? ` Projects holding slots: ${detail.holders}.`
    : " The projects holding slots could not be identified.";
  return `The native pool has too few free sockets for this start.${holders} Run hack down in a project holding slots, then retry.`;
}

export class PoolCapacityRefusal extends ClosedCliError {
  readonly capacity: PoolCapacityDetail;

  constructor(capacity: PoolCapacityDetail) {
    super(poolCapacityMessage(capacity));
    this.capacity = capacity;
  }
}

export async function nativePoolCapacityRefusal(
  error: unknown,
  opts: {
    readonly runtime: NativeRuntimeSelection;
    readonly invoke: typeof invokeNativeRuntime;
    readonly signal?: AbortSignal;
  }
): Promise<PoolCapacityRefusal | undefined> {
  const codes = [
    nativeRuntimeFailure(error)?.code,
    ...(error instanceof NativeRuntimeRequestError
      ? [error.nativeCode, error.nativeCauseCode]
      : []),
  ];
  if (
    codes.includes("bridge_conflict") ||
    codes.includes("dependency_socket_conflict")
  ) {
    return new PoolCapacityRefusal({ kind: "too-small" });
  }
  if (
    !(
      codes.includes("bridge_capacity_exhausted") ||
      codes.includes("dependency_capacity_exhausted")
    )
  ) {
    return;
  }
  const usage = await opts
    .invoke({
      runtime: opts.runtime,
      cwd: opts.runtime.home,
      args: ["runtime", "socket-usage", "--json"],
      timeoutMs: 5000,
      signal: opts.signal,
    })
    .catch(() => undefined);
  const sockets = new Map<string, { bridges: number; dependencies: number }>();
  if (isRecord(usage) && Array.isArray(usage.reservations)) {
    for (const row of usage.reservations) {
      if (
        isRecord(row) &&
        typeof row.run === "string" &&
        typeof row.bridges === "number" &&
        typeof row.dependencies === "number"
      ) {
        sockets.set(row.run, {
          bridges: row.bridges,
          dependencies: row.dependencies,
        });
      }
    }
  }
  const holders = sockets.size
    ? await describeLivePoolRuns([...sockets.keys()], { sockets })
    : "";
  return new PoolCapacityRefusal(
    HOLDERS.test(holders) ? { kind: "occupied", holders } : { kind: "occupied" }
  );
}
