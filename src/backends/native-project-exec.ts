import { isRecord } from "../lib/guards.ts";
import { prepareNativeExecEnvironment } from "./native-exec-environment.ts";
import { nativeProjectPs } from "./native-project-observe.ts";
import type { NativeProjectRunScope } from "./native-project-run.ts";
import { loadNativeProjectRun } from "./native-project-run.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const SERVICE = /^[A-Za-z0-9_.-]{1,128}$/;
function refused(): Error {
  return new Error(
    "Native exec identity or response is unconfirmed; command effects may have occurred. No request was replayed."
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
const GENERATION = /^[a-f0-9]{64}$/;
async function freshDelivery(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly service: string;
  readonly run: string;
  readonly container: string;
  readonly composeFile: string;
  readonly invoke?: typeof invokeNativeRuntime;
}) {
  const invoke = opts.invoke ?? invokeNativeRuntime;
  const extra: string[] = [];
  const mapping = await loadNativeProjectRun(opts.scope);
  if (!mapping || mapping.run !== opts.run) {
    throw refused();
  }
  const selected = await invoke({
    runtime: opts.runtime,
    cwd: opts.scope.projectRoot,
    args: [
      "graph",
      "exec-selection",
      "--run-id",
      opts.run,
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
    selected.container !== opts.container ||
    typeof selected.generation !== "string" ||
    !GENERATION.test(selected.generation)
  ) {
    throw refused();
  }
  const values = await prepareNativeExecEnvironment({
    ...opts,
    run: mapping,
    composeFile: opts.composeFile,
  });
  if (
    JSON.stringify(await loadNativeProjectRun(opts.scope)) !==
    JSON.stringify(mapping)
  ) {
    throw refused();
  }
  if (Object.keys(values).length === 0) {
    return { payload: undefined, extra };
  }
  const payload = Buffer.from(
    JSON.stringify({
      version: 1,
      plan: mapping.planId,
      run: mapping.run,
      lifetime_seconds: 30,
      services: { [opts.service]: values },
    })
  );
  extra.push(
    "--expect-plan",
    mapping.planId,
    "--expect-container",
    opts.container,
    "--expect-generation",
    selected.generation,
    "--environment-stdin"
  );
  return { payload, extra };
}
/** One bounded noninteractive command; fresh values use private stdin when a Compose source is supplied. */
export async function nativeProjectExec(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly service: string;
  readonly argv: readonly string[];
  readonly workdir?: string;
  readonly composeFile?: string;
  readonly invoke?: typeof invokeNativeRuntime;
}) {
  if (
    !SERVICE.test(opts.service) ||
    opts.argv.length < 1 ||
    opts.argv.length > 256 ||
    !opts.argv[0] ||
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
      "Native exec requires one service and bounded command arguments with an optional absolute workdir."
    );
  }
  const before = await nativeProjectPs(opts);
  if (!before.run) {
    throw new Error(
      "Native project has not been started; no owned graph mapping exists."
    );
  }
  const service = before.items.find((item) => item.service === opts.service);
  if (
    before.phase !== "ready-observed" ||
    service?.state !== "running" ||
    !service.container
  ) {
    throw refused();
  }
  const invoke = opts.invoke ?? invokeNativeRuntime;
  const { payload, extra } = opts.composeFile
    ? await freshDelivery({
        ...opts,
        run: before.run,
        container: service.container,
        composeFile: opts.composeFile,
      })
    : { payload: undefined, extra: [] };
  let value: unknown;
  try {
    value = await invoke({
      runtime: opts.runtime,
      cwd: opts.scope.projectRoot,
      timeoutMs: 35_000,
      serviceExecResponse: true,
      privateInput: payload,
      args: [
        "graph",
        "exec",
        "--run-id",
        before.run,
        "--service",
        opts.service,
        "--timeout-seconds",
        "30",
        "--json",
        ...extra,
        ...(opts.workdir ? ["--workdir", opts.workdir] : []),
        "--",
        ...opts.argv,
      ],
    });
  } finally {
    payload?.fill(0);
  }
  if (
    !(isRecord(value) && Number.isInteger(value.exit_code)) ||
    typeof value.exit_code !== "number" ||
    value.exit_code < 0 ||
    value.exit_code > 255 ||
    typeof value.truncated !== "boolean"
  ) {
    throw refused();
  }
  const stdout = decode(value.stdout_base64),
    stderr = decode(value.stderr_base64);
  const after = await nativeProjectPs(opts);
  if (
    after.run !== before.run ||
    after.items.find((item) => item.service === opts.service)?.container !==
      service.container
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
