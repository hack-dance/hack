import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../../src/lib/guards.ts";
import type { CliResult } from "../harness.ts";

const CODES = [
  "E_CONFIG_INVALID",
  "E_LIFECYCLE_FAILED",
  "E_STATE",
  "E_NATIVE_COMPOSE_ADOPTION",
  "E_NATIVE_COMPOSE_OWNERSHIP",
  "E_NATIVE_COMPOSE_PROBE",
  "E_NATIVE_COMPOSE_PROBE_TIMEOUT",
] as const;
type Context = {
  readonly tempRoot: string;
  readonly log?: (message: string) => void;
};
type Outcome = Pick<CliResult, "exitCode" | "timedOut" | "stdout" | "stderr">;
const owners = new WeakMap<Context, ReturnType<typeof recorder>>();

function operation(args: readonly string[], drift: boolean) {
  const joined = JSON.stringify(args);
  const operations = [
    [["config", "adopt", "--dry-run", "--stop", "--json"], "preview"],
    [["config", "adopt", "--stop", "--json"], "adopt-stop"],
    [
      ["config", "adopt", "--recover", "--stop", "--json"],
      "adopt-recover-stop",
    ],
    [["config", "adopt", "--rollback", "--json"], "rollback"],
    [["up", "db", "--detach", "--json"], "partial-selection"],
    [
      ["up", "--detach", "--json"],
      drift ? "start-with-context-drift" : "start",
    ],
    [["down", "--recover", "--json"], "recover-stop"],
    [["down", "--json"], "stop"],
    [["run", "db", "--", "true"], "run-refusal"],
  ] as const;
  return (
    operations.find(([expected]) => JSON.stringify(expected) === joined)?.[1] ??
    "unavailable"
  );
}

function code(stdout: string) {
  if (Buffer.byteLength(stdout) > 65_536) {
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
      return CODES.find((known) => known === error.code) ?? "unavailable";
    }
    return "unavailable";
  } catch {
    return "unavailable";
  }
}
function outcome(result: Outcome) {
  try {
    const exitCode =
      Number.isSafeInteger(result.exitCode) &&
      result.exitCode >= 0 &&
      result.exitCode <= 255
        ? result.exitCode
        : "unavailable";
    return {
      exitCode,
      timedOut: result.timedOut === true,
      code: code(result.stdout),
      readGuardRefused: result.stderr.includes(
        "retained-build-refused stage=read-admission code=93"
      ),
      mutationGuardRefused: result.stderr.includes(
        "retained-build-refused stage=mutation-admission code=94"
      ),
    };
  } catch {
    return {
      exitCode: "unavailable",
      timedOut: "unavailable",
      code: "unavailable",
      readGuardRefused: "unavailable",
      mutationGuardRefused: "unavailable",
    };
  }
}
function recorder(context: Context) {
  const root = join(context.tempRoot, "retained-build-cli");
  const started = performance.now();
  let count = 0;
  let invocation = 0;
  return async <T extends Outcome>(opts: {
    readonly mode: unknown;
    readonly args: readonly string[];
    readonly driftAfterStart: boolean;
    readonly run: () => Promise<T>;
  }): Promise<T> => {
    const ordinal = ++invocation;
    const mode =
      opts.mode === "root-specific" || opts.mode === "hack-default"
        ? opts.mode
        : "unavailable";
    const selected = operation(opts.args, opts.driftAfterStart);
    const emit = async (
      stage: "begin" | "result" | "settled" | "thrown",
      detail?: ReturnType<typeof outcome>
    ) => {
      const row = {
        evidence_version: 1,
        invocation: ordinal,
        mode,
        operation: selected,
        stage,
        elapsedMs: Math.round(performance.now() - started),
        ...detail,
      };
      try {
        const index = ++count;
        if (index > 512) {
          return;
        }
        await mkdir(root, { mode: 0o700, recursive: true });
        await writeFile(
          join(root, `${String(index).padStart(4, "0")}.json`),
          `${JSON.stringify(row)}\n`,
          { mode: 0o600, flag: "wx" }
        );
      } catch {
        // Evidence failure cannot replace the original result or error.
      }
      try {
        context.log?.(`retained-build-cli ${JSON.stringify(row)}`);
      } catch {
        // Logging cannot skip cleanup or change admission.
      }
    };
    await emit("begin");
    try {
      const result = await opts.run();
      await emit("result", outcome(result));
      await emit("settled");
      return result;
    } catch (error) {
      await emit("thrown");
      throw error;
    }
  };
}

/**
 * Fixture-only fixed CLI substages and bounded exit/error classifications. No
 * argv, paths, response values or arbitrary errors are retained. Diagnostic
 * failure preserves the original result/error and never changes an effect gate.
 */
export async function observeRetainedBuildFixtureCli<T extends Outcome>(opts: {
  readonly context: Context;
  readonly mode: unknown;
  readonly args: readonly string[];
  readonly driftAfterStart: boolean;
  readonly run: () => Promise<T>;
}): Promise<T> {
  let owner = owners.get(opts.context);
  if (!owner) {
    owner = recorder(opts.context);
    owners.set(opts.context, owner);
  }
  return await owner(opts);
}
