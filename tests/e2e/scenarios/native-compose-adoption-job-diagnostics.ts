import { isRecord } from "../../../src/lib/guards.ts";
import { LEGACY_COMPOSE_ADOPTED_COMMAND_MESSAGES } from "../../../src/lib/native-compose-adoption-command.ts";
import type { LegacyComposeOrderedRefusal } from "../../../src/lib/native-compose-adoption-diagnostics.ts";
import { LegacyComposeAdoptedGenerationError } from "../../../src/lib/native-compose-adoption-generation.ts";
import { LEGACY_ADOPTION_SELECTION_MESSAGES } from "../../../src/lib/native-compose-adoption-marker.ts";
import { ProjectInputAccessError } from "../../../src/lib/project-input-selection.ts";
import type { CliResult } from "../harness.ts";

const STAGES = [
  "prior-state",
  "cli-result",
  "fresh-state",
  "fresh-exit",
  "pending-clear",
  "sql-ready",
  "sql-counts",
  "sibling-isolation",
] as const;
type Stage = (typeof STAGES)[number];
const CODES = [
  "E_CONFIG_INVALID",
  "E_PERMISSION",
  "E_LIFECYCLE_FAILED",
  "E_STATE",
  "E_NATIVE_COMPOSE_ADOPTION",
  "E_NATIVE_COMPOSE_OWNERSHIP",
  "E_NATIVE_COMPOSE_PROBE",
  "E_NATIVE_COMPOSE_PROBE_TIMEOUT",
] as const;
type ObservationReason = Extract<
  LegacyComposeOrderedRefusal,
  { stage: "ordered-observation" }
>["reason"];
type SchedulerReason = Extract<
  LegacyComposeOrderedRefusal,
  { stage: "ordered-scheduler" }
>["reason"];
const OBSERVATION_REASONS: readonly ObservationReason[] = [
  "shape",
  "timestamp",
  "restart-policy",
  "membership",
  "probe",
  "probe-operation",
  "probe-child",
  "probe-timeout",
  "probe-cancel",
  "probe-budget",
  "probe-capture",
  "probe-decode",
  "probe-json",
  "probe-row",
  "probe-unknown",
];
const SCHEDULER_REASONS: readonly SchedulerReason[] = [
  "selection",
  "deadline",
  "prior-attempt",
  "missing-attempt",
  "job-failed",
  "job-refused",
  "readiness",
  "completion-authority",
];
const MAX_REPLY_BYTES = 64 * 1024;
/**
 * Closed refusal tokens for the fixed, value-free messages an adopted start can
 * end with (HACK-1421). Only exact matches map to a token; the message itself
 * is never emitted, and any other text is `other`.
 */
const REFUSALS: readonly (readonly [string, string])[] = [
  ...(
    [
      ["legacy-state", "E_LEGACY_ADOPTION_STATE"],
      ["legacy-busy", "E_LEGACY_ADOPTION_BUSY"],
      ["legacy-changed", "E_LEGACY_ADOPTION_CHANGED"],
      ["legacy-unsupported", "E_LEGACY_ADOPTION_UNSUPPORTED"],
      ["legacy-cancelled", "E_LEGACY_ADOPTION_CANCELLED"],
      ["legacy-deadline", "E_LEGACY_ADOPTION_DEADLINE"],
      ["legacy-literal-env", "E_LEGACY_ADOPTION_LITERAL_ENV"],
    ] as const
  ).map(
    ([token, code]) =>
      [token, new LegacyComposeAdoptedGenerationError(code).message] as const
  ),
  ["adopted-refused", LEGACY_COMPOSE_ADOPTED_COMMAND_MESSAGES.refused],
  ["adopted-cancelled", LEGACY_COMPOSE_ADOPTED_COMMAND_MESSAGES.cancelled],
  ["marker-adoption", LEGACY_ADOPTION_SELECTION_MESSAGES.adoption],
  ["marker-permission", LEGACY_ADOPTION_SELECTION_MESSAGES.permission],
  // The marker's input-access message is the shared project-input guard's.
  ["input-access", new ProjectInputAccessError("unreadable").message],
];

function refusalToken(message: unknown): string {
  if (typeof message !== "string") {
    return "unavailable";
  }
  return REFUSALS.find(([, text]) => text === message)?.[0] ?? "other";
}

function isStage(value: unknown): value is Stage {
  return STAGES.some((stage) => stage === value);
}

function closedOrderedRefusal(
  value: unknown
): LegacyComposeOrderedRefusal | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "legacy_adoption_refusal")
  ) {
    return null;
  }
  const row = value.legacy_adoption_refusal;
  if (
    !isRecord(row) ||
    Object.keys(row).length !== 2 ||
    !Object.hasOwn(row, "stage") ||
    !Object.hasOwn(row, "reason")
  ) {
    return null;
  }
  if (row.stage === "ordered-observation") {
    const reason = OBSERVATION_REASONS.find((item) => item === row.reason);
    return reason ? { stage: row.stage, reason } : null;
  }
  if (row.stage === "ordered-scheduler") {
    const reason = SCHEDULER_REASONS.find((item) => item === row.reason);
    return reason ? { stage: row.stage, reason } : null;
  }
  return null;
}

function cliFacts(stdout: string) {
  const unavailable = {
    code: "unavailable",
    orderedStage: "unavailable",
    orderedReason: "unavailable",
    refusal: "unavailable",
  } as const;
  if (Buffer.byteLength(stdout) > MAX_REPLY_BYTES) {
    return unavailable;
  }
  try {
    const value: unknown = JSON.parse(stdout);
    if (!isRecord(value)) {
      return unavailable;
    }
    if (value.ok === true) {
      return { ...unavailable, code: "none", refusal: "none" };
    }
    if (value.ok === false && isRecord(value.error)) {
      const error = value.error;
      const code = CODES.find((item) => item === error.code) ?? "unavailable";
      const ordered =
        code === "E_CONFIG_INVALID" ? closedOrderedRefusal(error.detail) : null;
      return {
        code,
        orderedStage: ordered?.stage ?? "unavailable",
        orderedReason: ordered?.reason ?? "unavailable",
        refusal: refusalToken(error.message),
      };
    }
  } catch {
    // A diagnostic cannot replace the original command outcome.
  }
  return unavailable;
}

/**
 * Record only closed start/restart substages, CLI codes, exact ordered-refusal
 * detail and a closed token for a fixed refusal message. No reply values, paths, argv, identifiers, arbitrary errors or
 * elapsed-budget claims are emitted. Logging failure never replaces the result.
 */
export function createCompletedJobFixtureStartDiagnostics(opts: {
  readonly log: (message: string) => void;
  readonly operation: unknown;
  readonly scope: unknown;
}) {
  const log = opts.log;
  const operation =
    opts.operation === "up" || opts.operation === "restart"
      ? opts.operation
      : "unavailable";
  const scope =
    opts.scope === "alpha" || opts.scope === "beta"
      ? opts.scope
      : "unavailable";
  const prefix = `start-operation=${operation} worktree=${scope}`;
  const emit = (message: string) => {
    try {
      log(`${prefix} ${message}`);
    } catch {
      // Diagnostics cannot skip cleanup or replace its original refusal.
    }
  };
  return Object.freeze({
    step: async <T>(
      stage: unknown,
      action: () => T | Promise<T>
    ): Promise<T> => {
      if (!isStage(stage)) {
        return await action();
      }
      emit(`stage=${stage} status=begin`);
      try {
        const value = await action();
        emit(`stage=${stage} status=end`);
        return value;
      } catch (error) {
        emit(`stage=${stage} status=failed`);
        throw error;
      }
    },
    cliOutcome: (
      result: Pick<CliResult, "exitCode" | "timedOut" | "stdout">
    ) => {
      try {
        const exit = exitClass(result.exitCode);
        const timeout = result.timedOut ? "yes" : "no";
        const facts = cliFacts(result.stdout);
        emit(
          `stage=cli-result exit=${exit} timed-out=${timeout} code=${facts.code} ordered-stage=${facts.orderedStage} ordered-reason=${facts.orderedReason} refusal=${facts.refusal}`
        );
      } catch {
        emit(
          "stage=cli-result exit=unavailable timed-out=unavailable code=unavailable ordered-stage=unavailable ordered-reason=unavailable refusal=unavailable"
        );
      }
    },
  });
}

function exitClass(value: unknown): "zero" | "nonzero" | "unavailable" {
  if (value === 0) {
    return "zero";
  }
  return typeof value === "number" && Number.isSafeInteger(value)
    ? "nonzero"
    : "unavailable";
}
