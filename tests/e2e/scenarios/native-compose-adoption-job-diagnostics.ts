import { isRecord } from "../../../src/lib/guards.ts";
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
  "E_LIFECYCLE_FAILED",
  "E_STATE",
  "E_NATIVE_COMPOSE_ADOPTION",
  "E_NATIVE_COMPOSE_OWNERSHIP",
  "E_NATIVE_COMPOSE_PROBE",
  "E_NATIVE_COMPOSE_PROBE_TIMEOUT",
] as const;
const MAX_REPLY_BYTES = 64 * 1024;

function isStage(value: unknown): value is Stage {
  return STAGES.some((stage) => stage === value);
}

function cliCode(stdout: string): string {
  if (Buffer.byteLength(stdout) > MAX_REPLY_BYTES) {
    return "unavailable";
  }
  try {
    const value: unknown = JSON.parse(stdout);
    if (!isRecord(value)) {
      return "unavailable";
    }
    if (value.ok === true) {
      return "none";
    }
    if (value.ok === false && isRecord(value.error)) {
      const error = value.error;
      return CODES.find((code) => code === error.code) ?? "unavailable";
    }
  } catch {
    // A diagnostic cannot replace the original command outcome.
  }
  return "unavailable";
}

/**
 * Record only closed start/restart substages and allowlisted CLI codes. No reply
 * values, paths, argv, identifiers, arbitrary errors or elapsed-budget claims are
 * emitted. Logging failure never replaces the original result or thrown error.
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
        emit(
          `stage=cli-result exit=${exit} timed-out=${timeout} code=${cliCode(result.stdout)}`
        );
      } catch {
        emit(
          "stage=cli-result exit=unavailable timed-out=unavailable code=unavailable"
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
