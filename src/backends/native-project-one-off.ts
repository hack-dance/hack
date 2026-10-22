import { ClosedCliError, HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { prepareNativeExecEnvironment } from "./native-exec-environment.ts";
import { refreshNativeProjectDependencies } from "./native-project-dependency-refresh.ts";
import {
  loadNativeProjectRun,
  type NativeProjectRun,
  type NativeProjectRunScope,
  normalizeNativeProfiles,
} from "./native-project-run.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const JOB = /^[a-f0-9]{32}$/;
function refused(): Error {
  return new ClosedCliError(
    "Native one-off identity or cleanup is unconfirmed; inspect owned job state before retrying. No command was replayed."
  );
}
function decode(value: unknown): Buffer {
  if (typeof value !== "string" || value.length > 6 * 1024 * 1024) {
    throw refused();
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw refused();
  }
  return bytes;
}
/** The closed `E_USAGE` refusal of a run whose selection differs from the running one. */
export const NATIVE_RUN_SELECTION_REFUSAL =
  "Native `hack run` uses the running project's environment and profiles, and the requested --env or --profile does not match them. Omit --env and --profile, or pass exactly the selection `hack up` started with. No command ran.";

/**
 * The selection a native one-off asks for. An omitted field inherits the
 * running selection; a given field must equal it exactly. Profiles compare as
 * a set (order and duplicates do not matter), and an explicit base env is
 * `null`. A run never restarts the project to change its selection.
 */
export type NativeRunSelection = {
  readonly envName?: string | null;
  readonly profiles?: readonly string[];
};

/**
 * Refuse, before any runtime request, a requested selection that differs from
 * the running one or that a legacy mapping without recorded selectors cannot
 * confirm.
 */
export function requireNativeRunSelection(opts: {
  readonly run: NativeProjectRun;
  readonly selection?: NativeRunSelection;
}): void {
  const { run, selection } = opts;
  const envDiffers =
    selection?.envName !== undefined &&
    (run.effectiveEnvName === undefined ||
      selection.envName !== run.effectiveEnvName);
  const profilesDiffer =
    selection?.profiles !== undefined &&
    (run.profiles === undefined ||
      JSON.stringify(normalizeNativeProfiles(selection.profiles)) !==
        JSON.stringify(run.profiles));
  if (envDiffers || profilesDiffer) {
    throw new HackCliError({
      code: "E_USAGE",
      message: NATIVE_RUN_SELECTION_REFUSAL,
    });
  }
}

/** A separate service container; completion requires confirmed job cleanup. */
export async function nativeProjectOneOff(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly service: string;
  readonly argv: readonly string[];
  readonly workdir?: string;
  readonly composeFile: string;
  /** Optional `--env`/`--profile` request; it must match the running selection. */
  readonly selection?: NativeRunSelection;
  readonly invoke?: typeof invokeNativeRuntime;
  readonly environment?: typeof prepareNativeExecEnvironment;
}) {
  if (
    !SERVICE.test(opts.service) ||
    opts.argv.length > 256 ||
    (opts.argv.length > 0 && !opts.argv[0]) ||
    opts.argv.some(
      (arg) => arg.includes("\0") || Buffer.byteLength(arg) > 16_384
    ) ||
    opts.argv.reduce((n, arg) => n + Buffer.byteLength(arg), 0) > 65_536 ||
    (opts.workdir !== undefined &&
      (!opts.workdir.startsWith("/") ||
        opts.workdir.includes("\0") ||
        Buffer.byteLength(opts.workdir) > 4096))
  ) {
    throw new ClosedCliError(
      "Native run requires a service, bounded arguments and an optional absolute workdir."
    );
  }
  const mapping = await loadNativeProjectRun(opts.scope);
  if (!mapping) {
    throw new ClosedCliError(
      "Native run currently requires a started project; run up first."
    );
  }
  requireNativeRunSelection({ run: mapping, selection: opts.selection });
  const refreshed = await refreshNativeProjectDependencies(opts);
  if (JSON.stringify(refreshed.mapping) !== JSON.stringify(mapping)) {
    throw refused();
  }
  const invoke = opts.invoke ?? invokeNativeRuntime;
  const selected = await invoke({
    runtime: opts.runtime,
    cwd: opts.scope.projectRoot,
    args: [
      "graph",
      "run-selection",
      "--run-id",
      mapping.run,
      "--service",
      opts.service,
      "--json",
    ],
    timeoutMs: 30_000,
  });
  if (
    !isRecord(selected) ||
    selected.run !== mapping.run ||
    selected.owner !== mapping.owner ||
    selected.namespace !== mapping.namespace ||
    selected.plan !== mapping.planId ||
    selected.service !== opts.service ||
    typeof selected.generation !== "string" ||
    !DIGEST.test(selected.generation) ||
    typeof selected.boot !== "string" ||
    selected.boot.length < 1 ||
    selected.boot.length > 128 ||
    selected.boot.includes("\0")
  ) {
    throw refused();
  }
  const values = await (opts.environment ?? prepareNativeExecEnvironment)({
    scope: opts.scope,
    run: mapping,
    composeFile: opts.composeFile,
    service: opts.service,
  });
  if (
    JSON.stringify(await loadNativeProjectRun(opts.scope)) !==
    JSON.stringify(mapping)
  ) {
    throw refused();
  }
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      plan: mapping.planId,
      run: mapping.run,
      lifetime_seconds: 300,
      // An empty map is explicit no-managed-values input, never an absent pipe.
      services: Object.keys(values).length ? { [opts.service]: values } : {},
    })
  );
  let value: unknown;
  try {
    value = await invoke({
      runtime: opts.runtime,
      cwd: opts.scope.projectRoot,
      timeoutMs: 330_000,
      serviceExecResponse: true,
      privateInput: payload,
      args: [
        "graph",
        "run-service",
        "--run-id",
        mapping.run,
        "--service",
        opts.service,
        "--expect-plan",
        mapping.planId,
        "--expect-generation",
        selected.generation,
        "--expect-boot",
        selected.boot,
        "--timeout-seconds",
        "300",
        "--environment-stdin",
        "--json",
        ...(opts.workdir ? ["--workdir", opts.workdir] : []),
        "--",
        ...opts.argv,
      ],
    });
  } finally {
    payload.fill(0);
  }
  if (
    !(isRecord(value) && Number.isInteger(value.exit_code)) ||
    typeof value.exit_code !== "number" ||
    value.exit_code < 0 ||
    value.exit_code > 255 ||
    typeof value.truncated !== "boolean" ||
    value.cleanup_confirmed !== true ||
    typeof value.job !== "string" ||
    !JOB.test(value.job)
  ) {
    throw refused();
  }
  const stdout = decode(value.stdout_base64),
    stderr = decode(value.stderr_base64);
  if (
    JSON.stringify(await loadNativeProjectRun(opts.scope)) !==
    JSON.stringify(mapping)
  ) {
    throw refused();
  }
  return {
    exitCode: value.exit_code,
    stdout,
    stderr,
    truncated: value.truncated,
  };
}
