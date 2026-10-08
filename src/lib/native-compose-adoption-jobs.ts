import { isRecord } from "./guards.ts";
import type { LegacyComposeVerifiedBinding } from "./native-compose-adoption-binding.ts";
import type { LegacyComposeReadinessState } from "./native-compose-adoption-readiness.ts";

const ID = /^[a-f0-9]{64}$/;
const TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;
export const LEGACY_COMPOSE_NEVER_STARTED = "0001-01-01T00:00:00Z";

/** Exact daemon facts only; no environment, health output or caller readiness attestations. */
export type LegacyComposeJobState = LegacyComposeReadinessState & {
  readonly exitCode: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly restartPolicy: "no" | "always" | "unless-stopped" | "on-failure";
  readonly maximumRetryCount: number;
};
export type LegacyComposeJobAttempt = {
  readonly id: string;
  readonly priorStartedAt: string;
};
function refuse(): never {
  throw new Error(
    "Legacy adoption job observation refused; pending ownership retained. Values omitted."
  );
}

/** UTC equality at nanosecond precision; this makes no clock-monotonicity claim. */
export function legacyComposeTimestampInstant(
  value: string
): bigint | undefined {
  const match = TIME.exec(value),
    base = match?.[1];
  if (!base) {
    return undefined;
  }
  const milliseconds = Date.parse(`${base}Z`);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 19) !== base
  ) {
    return undefined;
  }
  return (
    BigInt(milliseconds) * 1_000_000n +
    BigInt((match?.[2] ?? "").padEnd(9, "0"))
  );
}
const NEVER = legacyComposeTimestampInstant(LEGACY_COMPOSE_NEVER_STARTED);
function closed(
  value: unknown,
  names: string
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Reflect.ownKeys(value).length === names.split(",").length &&
    Object.getOwnPropertyNames(value).sort().join() === names &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((item) =>
      Object.hasOwn(item, "value")
    )
  );
}
function state(value: unknown): value is LegacyComposeJobState {
  return (
    closed(
      value,
      "exitCode,finishedAt,health,id,maximumRetryCount,paused,restartPolicy,running,startedAt,status"
    ) &&
    typeof value.id === "string" &&
    ID.test(value.id) &&
    typeof value.running === "boolean" &&
    typeof value.paused === "boolean" &&
    typeof value.status === "string" &&
    [
      "created",
      "running",
      "paused",
      "restarting",
      "removing",
      "exited",
      "dead",
    ].includes(value.status) &&
    typeof value.health === "string" &&
    ["", "starting", "healthy", "unhealthy"].includes(value.health) &&
    typeof value.exitCode === "number" &&
    Number.isInteger(value.exitCode) &&
    value.exitCode >= 0 &&
    value.exitCode <= 255 &&
    typeof value.startedAt === "string" &&
    legacyComposeTimestampInstant(value.startedAt) !== undefined &&
    typeof value.finishedAt === "string" &&
    legacyComposeTimestampInstant(value.finishedAt) !== undefined &&
    typeof value.restartPolicy === "string" &&
    ["no", "always", "unless-stopped", "on-failure"].includes(
      value.restartPolicy
    ) &&
    typeof value.maximumRetryCount === "number" &&
    Number.isInteger(value.maximumRetryCount) &&
    value.maximumRetryCount >= 0 &&
    value.maximumRetryCount <= 4_294_967_295
  );
}

/** Closed full-membership observation. Missing/duplicate/foreign rows never mean absence or completion. */
export function legacyComposeJobStates(opts: {
  readonly binding: LegacyComposeVerifiedBinding;
  readonly observed: unknown;
}): readonly LegacyComposeJobState[] {
  const observed = opts.observed;
  if (
    !Array.isArray(observed) ||
    Object.keys(observed).length !== observed.length ||
    !Object.keys(observed).every((key, index) => key === String(index)) ||
    Reflect.ownKeys(observed).length !== observed.length + 1 ||
    !Object.values(Object.getOwnPropertyDescriptors(observed)).every((item) =>
      Object.hasOwn(item, "value")
    ) ||
    observed.length !== opts.binding.containers.length ||
    !observed.every(state)
  ) {
    refuse();
  }
  const ids = new Set(opts.binding.containers.map((item) => item.id));
  if (
    ids.size !== observed.length ||
    new Set(observed.map((item) => item.id)).size !== ids.size ||
    observed.some((item) => !ids.has(item.id))
  ) {
    refuse();
  }
  return Object.freeze(observed.map((item) => Object.freeze({ ...item })));
}

/** An invocation must first successfully start this exact original ID; old exit zero is insufficient. */
export function legacyComposeFreshJobResult(opts: {
  readonly attempt: LegacyComposeJobAttempt;
  readonly observed: LegacyComposeJobState;
}): "ready" | "waiting" | "failed" | "refused" {
  const { attempt, observed } = opts;
  const prior = legacyComposeTimestampInstant(attempt.priorStartedAt);
  if (
    !state(observed) ||
    observed.id !== attempt.id ||
    prior === undefined ||
    observed.paused ||
    observed.status === "dead" ||
    observed.health !== "" ||
    observed.restartPolicy !== "no" ||
    observed.maximumRetryCount !== 0
  ) {
    return "refused";
  }
  const start = legacyComposeTimestampInstant(observed.startedAt),
    finish = legacyComposeTimestampInstant(observed.finishedAt);
  if (
    !observed.running &&
    observed.status === "exited" &&
    observed.exitCode !== 0
  ) {
    return "failed";
  }
  if (start === NEVER || start === prior) {
    return "waiting";
  }
  if (!observed.running && observed.status === "exited" && finish !== NEVER) {
    return observed.exitCode === 0 ? "ready" : "failed";
  }
  return observed.running && observed.status === "running"
    ? "waiting"
    : "refused";
}
