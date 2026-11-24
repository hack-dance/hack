import type { Writable } from "node:stream";
import { ClosedCliError, HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  followNativeLogs,
  nativeLogFollowOptions,
} from "./native-log-follow.ts";
import { resumeNativeLogs } from "./native-log-restart.ts";
import { selectNativeLogContainer } from "./native-log-selection.ts";
import {
  inspectNativeProjectGraph,
  isNativeProviderBusy,
  OBSERVER_BUSY_WAIT_MS,
} from "./native-project-inspect.ts";
import {
  type NativePublishedPort,
  nativeDeclaredPorts,
  nativeObservedPorts,
  nativePendingPublisherPorts,
} from "./native-project-publications.ts";
import {
  loadNativeProjectRun,
  loadNativeRestartIntent,
  loadNativeStartupRun,
  type NativeProjectRun,
  type NativeProjectRunScope,
  type NativeStartupRun,
  nativeProjectStartupPending,
} from "./native-project-run.ts";
import {
  invokeNativeRuntime,
  isNativeRuntimeNotRunning,
  NativeRuntimeRequestError,
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
  /** Included only for callers that need the receipt's retained readiness goal. */
  readiness?: "started" | "healthy" | "completed";
};
type Options = {
  readonly signal?: AbortSignal;
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly invoke?: typeof invokeNativeRuntime;
  /** Internal admission callers need completion roles; ordinary ps output is unchanged. */
  readonly includeReadiness?: boolean;
};
function refused(): Error {
  return new ClosedCliError(
    "Native graph observation refused: owned mapping or current graph identity is unavailable or changed."
  );
}
/** Closed refusal for logs, which have nothing to read from a stopped runtime. */
function runtimeNotRunning(): HackCliError {
  return new HackCliError({
    code: "E_DOCKER_UNAVAILABLE",
    message:
      "Native runtime is not running; no service logs are available. Start the native runtime and retry.",
  });
}
/**
 * Native ps result. `pending` reports frontend startup intent before a run mapping
 * exists; it grants no readiness or live-process authority. `runtime_not_running` means the project has an owned run
 * mapping but the candidate runtime is stopped: nothing was observed, so
 * `phase` is null and `items` is empty. `runtime_busy` means the journal changed
 * during presentation, so no consistent snapshot is returned. Presentation
 * takes no provider lease; legacy lease-busy responses remain transitional.
 */
export type NativeProjectPsStatus =
  | "not_started"
  | "pending"
  | "runtime_not_running"
  | "runtime_busy"
  | "provider_pin_changed"
  | "observed"
  | "owner_unconfirmed"
  | "runtime_degraded";
export type NativeProjectPsResult = {
  readonly backend: "native";
  readonly status: NativeProjectPsStatus;
  readonly run: string | null;
  readonly phase: string | null;
  /**
   * A live run in one field: `warming` (every container started, the owner has
   * not reported every goal met yet) or `ready`. Absent when there is no live run.
   */
  readonly readiness?: "warming" | "ready";
  readonly items: Item[];
  readonly ports?: NativePublishedPort[];
  /** The last start failed after `up` returned; see {@link NativeFailureAfterStarted}. */
  readonly failure?: NativeFailureAfterStarted;
  /** The services that failed after `up` returned, so a script checks one field. */
  readonly failed?: readonly string[];
};
function inspected(
  value: unknown,
  expected: NativeStartupRun & { readonly owner?: string },
  includeReadiness = false
): {
  items: Item[];
  phase: string;
  foreground: boolean;
  ports: NativePublishedPort[];
  failure?: NativeFailureAfterStarted;
} {
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
    (expected.owner !== undefined && receipt.owner !== expected.owner) ||
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
    const item = containerItem(resource, value.observations);
    const readiness = isRecord(receipt.readiness)
      ? receipt.readiness[item.service]
      : undefined;
    if (
      includeReadiness &&
      (readiness === "started" ||
        readiness === "healthy" ||
        readiness === "completed")
    ) {
      item.readiness = readiness;
    }
    items.push(item);
  }
  if (items.length > 32) {
    throw refused();
  }
  const observedPorts = Array.isArray(value.startup_observed_ports)
    ? new Set(value.startup_observed_ports)
    : new Set();
  return {
    items,
    ports: nativeDeclaredPorts(receipt.resources).map((port) =>
      observedPorts.has(port.port) &&
      items.some(
        (item) => item.service === port.service && item.state === "running"
      )
        ? { ...port, state: "observed" }
        : port
    ),
    phase: receipt.phase,
    foreground:
      receipt.relay_startup !== null && receipt.relay_startup !== undefined,
    // Its own file next to the receipt, reported beside it by `graph status`.
    ...failureAfterStarted(value.failed_after_started),
  };
}

/**
 * A run that failed after `up` returned at started (value-free: a closed code,
 * the service when known, and when). Kept in its own file next to the receipt,
 * outside the strict receipt, until `hack down` or the next start.
 */
export type NativeFailureAfterStarted = {
  readonly code: string;
  /** The first failed service (the first of `services`). */
  readonly service?: string;
  /** Every service still below its goal at a deadline, in order; else the failed one. */
  readonly services?: readonly string[];
  /** Unix seconds. */
  readonly at: number;
  /** Closed; absent when the failure names no observation. */
  readonly reason?: "not_ready" | "unhealthy" | "exited" | "dead";
  /** With `reason: "exited"` only. */
  readonly exitCode?: number;
};
const FAILURE_REASONS = new Set(["not_ready", "unhealthy", "exited", "dead"]);
/** The failed services: `services`, else the one `service`, else none. */
export function nativeFailedServices(
  failure: NativeFailureAfterStarted
): readonly string[] {
  if (failure.services?.length) {
    return failure.services;
  }
  return failure.service ? [failure.service] : [];
}
/** `api`, or `api (and 2 more)`, or `a service`. */
export function nativeFailedServicesLabel(
  failure: NativeFailureAfterStarted
): string {
  const [first, ...rest] = nativeFailedServices(failure);
  if (!first) {
    return "a service";
  }
  return rest.length ? `${first} (and ${rest.length} more)` : first;
}
/** The one line a start prints when it takes over a run that failed after `up` returned. */
export function nativeFailureRetryNotice(
  failure: NativeFailureAfterStarted
): string {
  return `The last start failed after up returned: ${nativeFailedServicesLabel(failure)} ${describeNativeFailureAfterStarted(failure)} at ${new Date(failure.at * 1000).toISOString()}. Starting again.`;
}
/** `exited (1)`, `unhealthy`, `dead`, `not ready`, else the code. */
export function describeNativeFailureAfterStarted(
  failure: NativeFailureAfterStarted
): string {
  switch (failure.reason) {
    case "exited":
      return `exited (${failure.exitCode})`;
    case "not_ready":
      return "not ready";
    case "unhealthy":
    case "dead":
      return failure.reason;
    default:
      return failure.code;
  }
}
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** The failure after started a graph snapshot carries (`failed_after_started`), if valid. */
export function nativeFailureAfterStarted(
  snapshot: unknown
): NativeFailureAfterStarted | undefined {
  return isRecord(snapshot)
    ? failureAfterStarted(snapshot.failed_after_started).failure
    : undefined;
}
function failureAfterStarted(
  value: unknown
): { failure: NativeFailureAfterStarted } | Record<string, never> {
  if (
    !(
      isRecord(value) &&
      typeof value.code === "string" &&
      FAILURE_CODE.test(value.code) &&
      Number.isSafeInteger(value.at) &&
      (value.service === undefined ||
        value.service === null ||
        (typeof value.service === "string" && SERVICE.test(value.service)))
    )
  ) {
    return {};
  }
  const reason =
    typeof value.reason === "string" && FAILURE_REASONS.has(value.reason)
      ? (value.reason as NonNullable<NativeFailureAfterStarted["reason"]>)
      : undefined;
  const exitCode = Number.isSafeInteger(value.exit_code)
    ? (value.exit_code as number)
    : undefined;
  const services = Array.isArray(value.services)
    ? value.services.filter(
        (service): service is string =>
          typeof service === "string" && SERVICE.test(service)
      )
    : [];
  return {
    failure: {
      code: value.code,
      ...(typeof value.service === "string" ? { service: value.service } : {}),
      // Only a complete, bounded list of valid names is kept.
      ...(Array.isArray(value.services) &&
      value.services.length <= 64 &&
      services.length === value.services.length &&
      services.length > 0
        ? { services }
        : {}),
      at: value.at as number,
      // An exit code belongs to `exited` only; anything else is dropped.
      ...(reason && (reason === "exited") === (exitCode !== undefined)
        ? { reason, ...(exitCode === undefined ? {} : { exitCode }) }
        : {}),
    },
  };
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
/** Presentation is lease-free; finite log inspection keeps its bounded lease retry. */
async function inspect(
  opts: Options,
  run: NativeStartupRun & { readonly owner?: string },
  statusOnly = false
) {
  return inspected(
    statusOnly
      ? await (opts.invoke ?? invokeNativeRuntime)({
          runtime: opts.runtime,
          cwd: opts.scope.projectRoot,
          args: ["graph", "status", "--run-id", run.run, "--json"],
          timeoutMs: 30_000,
          signal: opts.signal,
        })
      : await inspectNativeProjectGraph({
          runtime: opts.runtime,
          projectRoot: opts.scope.projectRoot,
          run: run.run,
          invoke: opts.invoke,
          busyWaitMs: OBSERVER_BUSY_WAIT_MS,
        }),
    run,
    opts.includeReadiness
  );
}
/** Ordinary states in which nothing was observed; every other refusal rethrows. */
function unobservedStatus(
  error: unknown
): "runtime_not_running" | "runtime_busy" | "provider_pin_changed" {
  if (
    error instanceof NativeRuntimeRequestError &&
    error.nativeCode === "provider_pin_changed"
  ) {
    return "provider_pin_changed";
  }
  if (isNativeRuntimeNotRunning(error)) {
    return "runtime_not_running";
  }
  if (
    isNativeProviderBusy(error) ||
    (error instanceof NativeRuntimeRequestError &&
      error.nativeCode === "graph_status_changed")
  ) {
    return "runtime_busy";
  }
  throw error;
}

/** A pinned owner can report pending host exits while an unrelated guest lease is busy. */
async function pendingPublisherObservation(
  opts: Options,
  run: NativeProjectRun
): Promise<NativeProjectPsResult | null> {
  try {
    const owner = await (opts.invoke ?? invokeNativeRuntime)({
      runtime: opts.runtime,
      cwd: opts.scope.projectRoot,
      args: ["graph", "owner-status", "--run-id", run.run, "--json"],
      timeoutMs: 2000,
    });
    if (
      !isRecord(owner) ||
      owner.ok !== true ||
      owner.run !== run.run ||
      owner.plan !== run.planId ||
      owner.phase !== "ready-observed" ||
      owner.foreground_alive !== true ||
      owner.runtime_verified !== false ||
      owner.runtime_error !== "publisher_exit_pending"
    ) {
      return null;
    }
    const ports = nativePendingPublisherPorts(owner.publisher_ports);
    return ports
      ? {
          backend: "native",
          status: "runtime_degraded",
          run: run.run,
          phase: owner.phase,
          items: [],
          ports,
        }
      : null;
  } catch {
    return null;
  }
}

async function unobservedProject(
  opts: Options,
  run: NativeProjectRun,
  error: unknown
): Promise<NativeProjectPsResult> {
  const status = unobservedStatus(error);
  if (status === "runtime_busy") {
    const pending = await pendingPublisherObservation(opts, run);
    if (pending) {
      return pending;
    }
  }
  return { backend: "native", status, run: run.run, phase: null, items: [] };
}
/**
 * Historical receipt phase is separated from current per-service observations.
 * A stopped candidate runtime is an ordinary state for this read: it reports
 * `runtime_not_running` instead of failing. Every other refusal still throws.
 */
function ownerJournalChanged(owner: unknown): boolean {
  return (
    isRecord(owner) &&
    owner.ok === false &&
    owner.code === "graph_status_changed"
  );
}

export async function nativeProjectPs(
  opts: Options
): Promise<NativeProjectPsResult> {
  const early = await nativeStartupProjectPs(opts);
  if (early) {
    return early;
  }
  const run = await loadNativeProjectRun(opts.scope);
  if (!run) {
    return {
      backend: "native",
      status: (await nativeProjectStartupPending(opts.scope))
        ? "pending"
        : "not_started",
      run: null,
      phase: null,
      items: [],
    };
  }
  let snapshot: Awaited<ReturnType<typeof inspect>>;
  try {
    snapshot = await inspect(opts, run, true);
  } catch (error: unknown) {
    return await unobservedProject(opts, run, error);
  }
  let status: "observed" | "owner_unconfirmed" | "runtime_degraded" =
    "observed";
  let ports = snapshot.ports;
  // Only a ready run is cross-checked with its owner. A warming run
  // (`started-observed`) is never asked: its owner is still in its start loop.
  if (snapshot.foreground && snapshot.phase === "ready-observed") {
    try {
      const owner = await (opts.invoke ?? invokeNativeRuntime)({
        runtime: opts.runtime,
        cwd: opts.scope.projectRoot,
        args: ["graph", "owner-status", "--run-id", run.run, "--json"],
        timeoutMs: 15_000,
        signal: opts.signal,
      });
      if (ownerJournalChanged(owner)) {
        return {
          backend: "native",
          status: "runtime_busy",
          run: run.run,
          phase: null,
          items: [],
        };
      }
      if (
        !isRecord(owner) ||
        owner.ok !== true ||
        owner.run !== run.run ||
        owner.plan !== run.planId ||
        owner.phase !== snapshot.phase ||
        owner.foreground_alive !== true ||
        typeof owner.runtime_verified !== "boolean"
      ) {
        status = "owner_unconfirmed";
      } else if (!owner.runtime_verified) {
        status = "runtime_degraded";
      }
      if (status !== "owner_unconfirmed" && isRecord(owner)) {
        ports = nativeObservedPorts(ports, owner.publisher_ports);
      }
    } catch {
      // Keep current container observations, but never call a stale ready receipt healthy.
      status = "owner_unconfirmed";
    }
  }
  const readiness = liveReadiness(snapshot.phase);
  return {
    backend: "native",
    status,
    run: run.run,
    items: snapshot.items,
    phase: snapshot.phase,
    ...(readiness ? { readiness } : {}),
    ...(snapshot.failure
      ? {
          failure: snapshot.failure,
          failed: nativeFailedServices(snapshot.failure),
        }
      : {}),
    ...(ports.length ? { ports } : {}),
  };
}

function liveReadiness(phase: string): "warming" | "ready" | undefined {
  if (phase === "started-observed") {
    return "warming";
  }
  return phase === "ready-observed" ? "ready" : undefined;
}

export async function nativeStartupProjectPs(
  opts: Options
): Promise<NativeProjectPsResult | null> {
  const startup = await loadNativeStartupRun(opts.scope);
  if (!startup) {
    return null;
  }
  try {
    const snapshot = await inspect(opts, startup, true);
    if (
      !(
        snapshot.foreground &&
        ["preparing", "restoring", "started-observed"].includes(snapshot.phase)
      )
    ) {
      return null;
    }
    return {
      backend: "native",
      status: "observed",
      run: startup.run,
      phase: snapshot.phase,
      items: snapshot.items,
      ports: snapshot.ports.filter((port) => port.state === "observed"),
    };
  } catch {
    // An advisory marker can predate native enrollment or race with teardown.
    return null;
  }
}
/** Read only the saved mapping, then let the lease-free runtime select its exact container. */
export async function followNativeProjectLogs(
  opts: Options & {
    readonly service?: string;
    readonly tail?: number;
    readonly since?: string;
    readonly timestamps?: boolean;
    readonly json?: boolean;
    readonly project?: string;
    /** Injected per service when several services share one output. */
    readonly stdout?: Writable;
    readonly stderr?: Writable;
  }
): Promise<number> {
  const selected = nativeLogFollowOptions(opts);
  const select = async () => {
    const run = await loadNativeProjectRun(opts.scope);
    if (!run) {
      throw new ClosedCliError(
        "Native project has not been started; no owned graph mapping exists."
      );
    }
    return {
      run: run.run,
      owner: run.owner,
      namespace: run.namespace,
      plan: run.planId,
      native: false,
    };
  };
  return await followNativeLogs({
    ...opts,
    service: selected.service,
    cwd: opts.scope.projectRoot,
    branch: opts.scope.branch ?? undefined,
    selection: select,
    resume: (previous, signal) =>
      resumeNativeLogs({
        previous,
        signal,
        select: async (admissionSignal) =>
          selectNativeLogContainer({
            runtime: opts.runtime,
            cwd: opts.scope.projectRoot,
            service: selected.service,
            selection: await select(),
            signal: admissionSignal,
            invoke: opts.invoke,
          }),
        restarting: async () =>
          (await loadNativeRestartIntent(opts.scope)) !== null,
      }),
  });
}
/** Native finite logs: a bounded snapshot of one service. */
export async function nativeProjectLogs(
  opts: Options & {
    readonly service?: string;
    readonly tail: number;
    readonly follow: boolean;
  }
) {
  assertFiniteLogBounds(opts);
  if (!(opts.service && SERVICE.test(opts.service))) {
    throw new ClosedCliError(
      "Native logs require one service, --no-follow and --tail 1..1000."
    );
  }
  const run = await requireLogRun(opts);
  const before = await inspectForLogs(opts, run);
  const service = before.items.find((item) => item.service === opts.service);
  if (!service?.container) {
    throw refused();
  }
  const logs = await readServiceLogs(
    opts,
    run,
    opts.service,
    service.container
  );
  const after = await inspect(opts, run, true);
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
    ...logs,
  };
}

/**
 * Native finite logs for every service that has a container, in service-name
 * order, as Compose prints all services without a name. Each service is a
 * bounded snapshot (`tail` lines); a service whose container changed while it
 * was read is refused as for one service. Services without a container (not
 * started, or a completed one-shot that was removed) are listed in `skipped`.
 */
export async function nativeProjectAllLogs(
  opts: Options & { readonly tail: number }
) {
  assertFiniteLogBounds({ ...opts, follow: false });
  const run = await requireLogRun(opts);
  const before = await inspectForLogs(opts, run);
  const items = [...before.items].sort((a, b) =>
    a.service.localeCompare(b.service)
  );
  const services: Array<
    { readonly service: string } & Awaited<ReturnType<typeof readServiceLogs>>
  > = [];
  const skipped: string[] = [];
  for (const item of items) {
    if (!item.container) {
      skipped.push(item.service);
      continue;
    }
    services.push({
      service: item.service,
      ...(await readServiceLogs(opts, run, item.service, item.container)),
    });
  }
  const after = await inspect(opts, run, true);
  for (const entry of services) {
    if (
      after.items.find((item) => item.service === entry.service)?.container !==
      entry.container
    ) {
      throw refused();
    }
  }
  return {
    backend: "native" as const,
    run: run.run,
    services,
    skipped,
  };
}

/**
 * Services of the started native run that have a container, in service-name
 * order: what `hack logs --follow` without a service follows.
 */
export async function nativeProjectLogServices(
  opts: Options
): Promise<readonly string[]> {
  const run = await requireLogRun(opts);
  const observed = await inspectForLogs(opts, run);
  return observed.items
    .filter((item) => item.container !== null)
    .map((item) => item.service)
    .sort((a, b) => a.localeCompare(b));
}

function assertFiniteLogBounds(opts: {
  readonly tail: number;
  readonly follow: boolean;
}): void {
  if (
    opts.follow ||
    !Number.isSafeInteger(opts.tail) ||
    opts.tail < 1 ||
    opts.tail > 1000
  ) {
    throw new ClosedCliError(
      "Native logs require --no-follow and --tail 1..1000 for a snapshot."
    );
  }
}

async function requireLogRun(opts: Options): Promise<NativeProjectRun> {
  const run = await loadNativeProjectRun(opts.scope);
  if (!run) {
    throw new ClosedCliError(
      "Native project has not been started; no owned graph mapping exists."
    );
  }
  return run;
}

async function inspectForLogs(opts: Options, run: NativeProjectRun) {
  try {
    // Lease-free: a warming run's owner holds the lease until ready.
    return await inspect(opts, run, true);
  } catch (error: unknown) {
    throw isNativeRuntimeNotRunning(error) ? runtimeNotRunning() : error;
  }
}

async function readServiceLogs(
  opts: Options & { readonly tail: number },
  run: NativeProjectRun,
  service: string,
  container: string
) {
  const result = await (opts.invoke ?? invokeNativeRuntime)({
    runtime: opts.runtime,
    cwd: opts.scope.projectRoot,
    args: [
      "graph",
      "logs",
      "--run-id",
      run.run,
      "--service",
      service,
      "--tail",
      String(opts.tail),
      "--json",
    ],
    timeoutMs: 30_000,
  });
  if (
    !isRecord(result) ||
    result.container !== container ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string" ||
    typeof result.truncated !== "boolean"
  ) {
    throw refused();
  }
  return {
    container,
    stdout: result.stdout,
    stderr: result.stderr,
    lines: logLines(result.lines, result.stdout, result.stderr),
    truncated: result.truncated,
  };
}

/** One retained log line in engine (time) order. */
export type NativeLogLine = {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
};

/**
 * The runtime's whole lines in engine order. A runtime without `lines` returns
 * the streams apart, so their order is unknown: keep stdout before stderr.
 */
function logLines(
  value: unknown,
  stdout: string,
  stderr: string
): NativeLogLine[] {
  if (value === undefined) {
    return [
      ...(stdout ? [{ stream: "stdout" as const, text: stdout }] : []),
      ...(stderr ? [{ stream: "stderr" as const, text: stderr }] : []),
    ];
  }
  if (!Array.isArray(value) || value.length > 16_384) {
    throw refused();
  }
  return value.map((line: unknown) => {
    if (
      !(
        isRecord(line) &&
        (line.stream === "stdout" || line.stream === "stderr") &&
        typeof line.text === "string"
      )
    ) {
      throw refused();
    }
    return { stream: line.stream, text: line.text };
  });
}

/** Refuse before any legacy lifecycle effects until the native operation is wired. */
export function requireComposeOperationAvailable(
  operation: "down" | "restart" | "run" | "exec",
  env: Readonly<Record<string, string | undefined>> = process.env
): void {
  if (env.HACK_RUNTIME_BACKEND === "native") {
    throw new ClosedCliError(
      `Native runtime operation '${operation}' is unavailable through this command; refusing Compose fallback.`
    );
  }
}
