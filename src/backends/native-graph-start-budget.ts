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
 * are whole seconds from 60 to 1800; anything else refuses, never falls back.
 */
import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";

export const NATIVE_START_TIMEOUT_ENV = "HACK_NATIVE_START_TIMEOUT_SECONDS";
export const NATIVE_START_TIMEOUT_CONFIG = "native.startTimeoutSeconds";
export const DEFAULT_NATIVE_START_TIMEOUT_SECONDS = 300;
export const MIN_NATIVE_START_TIMEOUT_SECONDS = 60;
export const MAX_NATIVE_START_TIMEOUT_SECONDS = 1800;
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
const STATE = /^[a-z_-]{1,32}$/;
/** The runtime-failure envelope keeps at most 400 printable characters. */
const DETAIL_LIMIT = 400;

/** One service's observed state, in the fixed vocabulary only. */
function observed(observation: unknown): string {
  if (!(isRecord(observation) && typeof observation.state === "string")) {
    return "no container";
  }
  const state = STATE.test(observation.state) ? observation.state : "unknown";
  if (state === "exited") {
    return Number.isSafeInteger(observation.code)
      ? `exited ${observation.code}`
      : "exited";
  }
  const health =
    typeof observation.health === "string" && STATE.test(observation.health)
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
  return observation.state === "running" || observation.state === "exited";
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
}): string | undefined {
  const observations =
    isRecord(opts.snapshot) && isRecord(opts.snapshot.observations)
      ? opts.snapshot.observations
      : {};
  const waiting = Object.entries(opts.goals)
    .filter(([name]) => SERVICE.test(name))
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
  const head = `Not ready after ${seconds} s of the ${opts.budgetSeconds} s graph start budget: `;
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
