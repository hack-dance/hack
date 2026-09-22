import { isRecord } from "../lib/guards.ts";
import { prepareNativeExecEnvironment } from "./native-exec-environment.ts";
import {
  loadNativeProjectRun,
  type NativeProjectRunScope,
} from "./native-project-run.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const JOB = /^[a-f0-9]{32}$/;
function refused(): Error {
  return new Error(
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
/** A separate service container; completion requires confirmed job cleanup. */
export async function nativeProjectOneOff(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly service: string;
  readonly argv: readonly string[];
  readonly workdir?: string;
  readonly composeFile: string;
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
    throw new Error(
      "Native run requires a service, bounded arguments and an optional absolute workdir."
    );
  }
  const mapping = await loadNativeProjectRun(opts.scope);
  if (!mapping) {
    throw new Error(
      "Native run currently requires a started project; run up first."
    );
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
