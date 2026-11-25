/**
 * The graph start budget of a native image-project start (HACK-2351).
 *
 * After images are ready, native start asks the runtime to start the graph
 * and wait until every service reaches its readiness goal (`started`,
 * `healthy` or `completed`). The runtime owns that deadline and reports
 * nothing before "ready", so the frontend cannot tell progressing services
 * from stuck ones while it waits. The budget is therefore configurable rather
 * than progress-aware: a project whose services legitimately need longer (a
 * large graph, a loaded host) sets it, and a real hang still ends.
 *
 * Precedence: `HACK_NATIVE_START_TIMEOUT_SECONDS`, then
 * `native.startTimeoutSeconds` in `.hack/hack.config.json`, then 300 s. Values
 * are whole seconds from 60 to 600 (the runtime's own bound for a graph start);
 * anything else refuses, never falls back.
 *
 * The runtime cleans up a failed start before it returns, so the graph as it
 * stood at the deadline is read while the start waits: a lease-free
 * `graph status` every few seconds ({@link watchNativeStartupStatus}).
 */
import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

export const NATIVE_START_TIMEOUT_ENV = "HACK_NATIVE_START_TIMEOUT_SECONDS";
export const NATIVE_START_TIMEOUT_CONFIG = "native.startTimeoutSeconds";
export const DEFAULT_NATIVE_START_TIMEOUT_SECONDS = 300;
export const MIN_NATIVE_START_TIMEOUT_SECONDS = 60;
/** The runtime refuses a graph start budget above 600 s (`graph_budget`). */
export const MAX_NATIVE_START_TIMEOUT_SECONDS = 600;
/** How often a waiting start reads the graph's lease-free status. */
export const NATIVE_START_STATUS_INTERVAL_MS = 5000;
/** An older status snapshot is not used to describe a timeout. */
export const NATIVE_START_STATUS_STALE_MS = 30_000;
/**
 * Receipt phases of a start still reaching readiness, including
 * `started-observed` (every container started, some goal still unmet: the
 * usual shape of a timeout). A snapshot in any other phase (cleanup, removed,
 * ready, retained) does not describe the graph at its deadline and is never kept.
 */
const STARTUP_PHASES = new Set(["preparing", "restoring", "started-observed"]);
/**
 * The frontend's own wait outlasts the runtime's deadline by this much, so
 * the runtime reports `graph_timeout` (and the graph can be inspected) first.
 */
export const NATIVE_START_FRONTEND_SLACK_MS = 15_000;
const WHOLE_SECONDS = /^\d+$/;

function inRange(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_NATIVE_START_TIMEOUT_SECONDS &&
    value <= MAX_NATIVE_START_TIMEOUT_SECONDS
  );
}

function refuse(source: string): HackCliError {
  return new HackCliError({
    code: "E_CONFIG_INVALID",
    message: `${source} must be a whole number of seconds from ${MIN_NATIVE_START_TIMEOUT_SECONDS} to ${MAX_NATIVE_START_TIMEOUT_SECONDS}.`,
  });
}

/** The graph start budget in seconds; see the module notes for precedence. */
export function resolveNativeStartTimeoutSeconds(opts: {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `native.startTimeoutSeconds` as parsed (NaN when it was not an integer). */
  readonly project: number | undefined;
}): number {
  const raw = opts.env[NATIVE_START_TIMEOUT_ENV];
  if (raw !== undefined && raw !== "") {
    const value = WHOLE_SECONDS.test(raw) ? Number(raw) : Number.NaN;
    if (!inRange(value)) {
      throw refuse(NATIVE_START_TIMEOUT_ENV);
    }
    return value;
  }
  if (opts.project !== undefined) {
    if (!inRange(opts.project)) {
      throw refuse(`${NATIVE_START_TIMEOUT_CONFIG} in .hack/hack.config.json`);
    }
    return opts.project;
  }
  return DEFAULT_NATIVE_START_TIMEOUT_SECONDS;
}

/** A start's budget: its own setting, else the default. */
export function nativeStartBudgetSeconds(
  configured: number | undefined
): number {
  return configured ?? DEFAULT_NATIVE_START_TIMEOUT_SECONDS;
}

/** The readiness goal per service, from the `--ready name=goal` arguments. */
export function nativeReadinessGoals(
  args: readonly string[]
): Readonly<Record<string, string>> {
  const goals: Record<string, string> = {};
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] !== "--ready") {
      continue;
    }
    const [name, goal] = (args[index + 1] ?? "").split("=", 2);
    if (name && goal) {
      goals[name] = goal;
    }
  }
  return goals;
}

const SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;
/** The closed vocabularies shown; anything else is "unknown" or left out. */
const STATES = new Set([
  "absent",
  "created",
  "dead",
  "exited",
  "paused",
  "removing",
  "restarting",
  "running",
]);
const HEALTH = new Set(["healthy", "none", "starting", "unhealthy"]);
const GOALS = new Set(["completed", "healthy", "started"]);
/** The runtime-failure envelope keeps at most 400 printable characters. */
const DETAIL_LIMIT = 400;

/** One service's observed state, in the fixed vocabulary only. */
function observed(observation: unknown): string {
  if (!(isRecord(observation) && typeof observation.state === "string")) {
    // A startup-phase snapshot without it: not created yet.
    return "not created";
  }
  const state = STATES.has(observation.state) ? observation.state : "unknown";
  if (state === "exited") {
    return Number.isSafeInteger(observation.code)
      ? `exited ${observation.code}`
      : "exited";
  }
  const health =
    typeof observation.health === "string" && HEALTH.has(observation.health)
      ? observation.health
      : undefined;
  return health ? `${state}, ${health}` : state;
}

function reachedGoal(goal: string, observation: unknown): boolean {
  if (!isRecord(observation)) {
    return false;
  }
  if (goal === "completed") {
    return observation.state === "exited" && observation.code === 0;
  }
  if (goal === "healthy") {
    return observation.state === "running" && observation.health === "healthy";
  }
  // As the runtime: running, or exited successfully.
  return (
    observation.state === "running" ||
    (observation.state === "exited" && observation.code === 0)
  );
}

/**
 * The closed sentence for a graph that ran out of its start budget: which
 * services had not reached their readiness goal, what each was doing, and
 * for how long they were waited on. Names only pass the service grammar, and
 * states only the fixed vocabulary; the sentence is bounded so it can cross
 * to a detached launcher. Undefined when the snapshot names no such service.
 */
export function nativeGraphTimeoutDetail(opts: {
  readonly snapshot: unknown;
  readonly goals: Readonly<Record<string, string>>;
  readonly waitedMs: number;
  readonly budgetSeconds: number;
  /** How old the snapshot was when the deadline passed. */
  readonly snapshotAgeMs?: number;
}): string | undefined {
  const observations =
    isRecord(opts.snapshot) && isRecord(opts.snapshot.observations)
      ? opts.snapshot.observations
      : {};
  const waiting = Object.entries(opts.goals)
    .filter(([name, goal]) => SERVICE.test(name) && GOALS.has(goal))
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(
      ([name, goal]) => !reachedGoal(goal, observations[`container:${name}`])
    )
    .map(
      ([name, goal]) =>
        `${name} (wanted ${goal}; ${observed(observations[`container:${name}`])})`
    );
  if (waiting.length === 0) {
    return;
  }
  const seconds = Math.round(opts.waitedMs / 1000);
  const age =
    opts.snapshotAgeMs === undefined
      ? ""
      : ` (graph status ${Math.round(opts.snapshotAgeMs / 1000)} s before the deadline)`;
  const head = `Not ready after ${seconds} s of the ${opts.budgetSeconds} s graph start budget${age}: `;
  const tail = `. Raise ${NATIVE_START_TIMEOUT_CONFIG} or ${NATIVE_START_TIMEOUT_ENV} if they were still starting.`;
  const shown: string[] = [];
  for (const [index, entry] of waiting.entries()) {
    const more = waiting.length - index - 1;
    const candidate = [...shown, entry].join(", ");
    const suffix = more > 0 ? `, and ${more} more` : "";
    if ((head + candidate + suffix + tail).length > DETAIL_LIMIT) {
      const rest = waiting.length - shown.length;
      return `${head}${shown.join(", ")}${shown.length > 0 ? ", and " : ""}${rest} more service(s)${tail}`.slice(
        0,
        DETAIL_LIMIT
      );
    }
    shown.push(entry);
  }
  return `${head}${shown.join(", ")}${tail}`;
}

function startupPhase(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.receipt) &&
    typeof value.receipt.phase === "string" &&
    STARTUP_PHASES.has(value.receipt.phase)
  );
}

/**
 * While a start waits for readiness, keep its latest lease-free `graph status`
 * snapshot: the runtime removes a failed start's containers before it
 * returns, so this is the only view of the graph as it stood at the deadline.
 * A failed or slow read keeps the previous snapshot; reads never overlap.
 */
export function watchNativeStartupStatus(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: string;
  readonly intervalMs?: number;
  readonly invoke?: typeof invokeNativeRuntime;
}): {
  /** The latest startup-phase snapshot and when it was taken, if any. */
  readonly latest: () =>
    | { readonly snapshot: unknown; readonly takenAt: number }
    | undefined;
  readonly stop: () => Promise<void>;
} {
  const controller = new AbortController();
  let latest: { snapshot: unknown; takenAt: number } | undefined;
  let reading: Promise<void> | undefined;
  const read = () => {
    if (reading || controller.signal.aborted) {
      return;
    }
    reading = (opts.invoke ?? invokeNativeRuntime)({
      runtime: opts.runtime,
      cwd: opts.projectRoot,
      args: ["graph", "status", "--run-id", opts.run, "--json"],
      timeoutMs: 10_000,
      signal: controller.signal,
    })
      .then((value) => {
        // Only a start still reaching readiness describes the deadline; a
        // cleanup or terminal snapshot never replaces it.
        if (!controller.signal.aborted && startupPhase(value)) {
          latest = { snapshot: value, takenAt: performance.now() };
        }
      })
      .catch(() => undefined)
      .finally(() => {
        reading = undefined;
      });
  };
  const timer = setInterval(
    read,
    opts.intervalMs ?? NATIVE_START_STATUS_INTERVAL_MS
  );
  return {
    latest: () => latest,
    stop: async () => {
      clearInterval(timer);
      controller.abort();
      await reading;
    },
  };
}
