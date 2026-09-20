import { isRecord } from "../lib/guards.ts";
import {
  loadNativeProjectRun,
  type NativeProjectRun,
  type NativeProjectRunScope,
} from "./native-project-run.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;
const CONTAINER = /^[a-f0-9]{64}$/;
type Item = {
  service: string;
  container: string | null;
  phase: string;
  state: string;
  health: string | null;
  exitCode: number | null;
};
type Options = {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly invoke?: typeof invokeNativeRuntime;
};
function refused(): Error {
  return new Error(
    "Native graph observation refused: owned mapping or current graph identity is unavailable or changed."
  );
}
function inspected(
  value: unknown,
  expected: NativeProjectRun
): { items: Item[]; phase: string } {
  if (
    !(
      isRecord(value) &&
      isRecord(value.receipt) &&
      isRecord(value.observations)
    ) ||
    value.journal_incomplete !== false
  ) {
    throw refused();
  }
  const receipt = value.receipt;
  if (
    receipt.run !== expected.run ||
    receipt.owner !== expected.owner ||
    receipt.namespace !== expected.namespace ||
    receipt.plan_id !== expected.planId ||
    typeof receipt.phase !== "string" ||
    !isRecord(receipt.resources)
  ) {
    throw refused();
  }
  const items: Item[] = [];
  for (const resource of Object.values(receipt.resources)) {
    if (!isRecord(resource)) {
      throw refused();
    }
    if (resource.kind !== "container") {
      continue;
    }
    items.push(containerItem(resource, value.observations));
  }
  if (items.length > 32) {
    throw refused();
  }
  return { items, phase: receipt.phase };
}
function containerItem(
  resource: Record<string, unknown>,
  observations: Record<string, unknown>
): Item {
  if (
    typeof resource.key !== "string" ||
    !SERVICE.test(resource.key) ||
    typeof resource.phase !== "string" ||
    (resource.id !== null &&
      (typeof resource.id !== "string" || !CONTAINER.test(resource.id)))
  ) {
    throw refused();
  }
  const observation = observations[`container:${resource.key}`];
  if (!isRecord(observation) || typeof observation.state !== "string") {
    throw refused();
  }
  return {
    service: resource.key,
    container: resource.id,
    phase: resource.phase,
    state: observation.state,
    health: typeof observation.health === "string" ? observation.health : null,
    exitCode: typeof observation.code === "number" ? observation.code : null,
  };
}
async function inspect(opts: Options, run: NativeProjectRun) {
  return inspected(
    await (opts.invoke ?? invokeNativeRuntime)({
      runtime: opts.runtime,
      cwd: opts.scope.projectRoot,
      args: ["graph", "inspect", "--run-id", run.run, "--json"],
      timeoutMs: 30_000,
    }),
    run
  );
}
/** Historical receipt phase is separated from current per-service observations. */
export async function nativeProjectPs(opts: Options) {
  const run = await loadNativeProjectRun(opts.scope);
  if (!run) {
    return {
      backend: "native" as const,
      status: "not_started" as const,
      run: null,
      phase: null,
      items: [] as Item[],
    };
  }
  const snapshot = await inspect(opts, run);
  return {
    backend: "native" as const,
    status: "observed" as const,
    run: run.run,
    ...snapshot,
  };
}
/** Native logs are a bounded, single-service snapshot; no polling or Compose fallback. */
export async function nativeProjectLogs(
  opts: Options & {
    readonly service?: string;
    readonly tail: number;
    readonly follow: boolean;
  }
) {
  if (
    opts.follow ||
    !opts.service ||
    !SERVICE.test(opts.service) ||
    !Number.isSafeInteger(opts.tail) ||
    opts.tail < 1 ||
    opts.tail > 1000
  ) {
    throw new Error(
      "Native logs require one service, --no-follow and --tail 1..1000."
    );
  }
  const run = await loadNativeProjectRun(opts.scope);
  if (!run) {
    throw new Error(
      "Native project has not been started; no owned graph mapping exists."
    );
  }
  const before = await inspect(opts, run);
  const service = before.items.find((item) => item.service === opts.service);
  if (!service?.container) {
    throw refused();
  }
  const result = await (opts.invoke ?? invokeNativeRuntime)({
    runtime: opts.runtime,
    cwd: opts.scope.projectRoot,
    args: [
      "graph",
      "logs",
      "--run-id",
      run.run,
      "--service",
      opts.service,
      "--tail",
      String(opts.tail),
      "--json",
    ],
    timeoutMs: 30_000,
  });
  if (
    !isRecord(result) ||
    result.container !== service.container ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    typeof result.truncated !== "boolean"
  ) {
    throw refused();
  }
  const after = await inspect(opts, run);
  if (
    after.items.find((item) => item.service === opts.service)?.container !==
    service.container
  ) {
    throw refused();
  }
  return {
    backend: "native" as const,
    run: run.run,
    service: opts.service,
    container: service.container,
    stdout: result.stdout,
    stderr: result.stderr,
    truncated: result.truncated,
  };
}

/** Refuse before any legacy lifecycle effects until the native operation is wired. */
export function requireComposeOperationAvailable(
  operation: "down" | "restart" | "run" | "exec",
  env: Readonly<Record<string, string | undefined>> = process.env
): void {
  if (env.HACK_RUNTIME_BACKEND === "native") {
    throw new Error(
      `Native runtime operation '${operation}' is unavailable through this command; refusing Compose fallback.`
    );
  }
}
