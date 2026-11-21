import { basename, join } from "node:path";
import {
  type CandidateLauncher,
  currentCandidateLauncher,
  freshNativeHomeSetupCommand,
  launcherCommand,
} from "../lib/candidate-launcher.ts";
import { childEnvironment } from "../lib/child-environment.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { canPrompt, confirmSafe } from "../lib/interactivity.ts";
import { isNativeDetachedOwnerProcess } from "../lib/native-detached-up.ts";
import {
  NATIVE_BUILDER_CHANGED,
  type NativeBuilderCommandOptions,
  type NativeBuilderPaths,
  nativeBuilderChangedRemedy,
  nativeBuilderRemedy,
} from "../lib/native-image-builder.ts";
import { subprocessSignalExitStatus } from "../lib/subprocess-signal.ts";
import {
  invokeNativeRuntime,
  type NativeRuntimeSelection,
} from "./native-runtime-client.ts";

const STATES = [
  "not_set_up",
  "partial_resumable",
  "ready",
  "invalid_preserved",
  "pin_mismatch",
  "unsafe_home",
  "unavailable",
  "unsupported_host",
] as const;
export type NativeSetupState = (typeof STATES)[number];
export type NativeSetupPin = {
  readonly url: string;
  readonly size_bytes: number;
  readonly archive_sha256: string;
};
const BUILDER_STATES = ["prepared", "not_prepared", "changed"] as const;
export type NativeSetupBuilderState = (typeof BUILDER_STATES)[number];
/**
 * The image builder, reported apart from `state`: a home is ready without it
 * and only image builds need it. A record-level observation, like `state`.
 */
export type NativeSetupBuilder = {
  readonly state: NativeSetupBuilderState;
  /** The builder's own entry in `pins`. */
  readonly pin: NativeSetupPin;
  /**
   * The builder's directory and record under the native home, when the
   * runtime names both. A runtime that reports the state without them is
   * still read; messages then name where the two are without their names.
   */
  readonly paths?: NativeBuilderPaths;
};
/** What a setup run did about the image builder (the result's `builder`). */
const BUILDER_OUTCOMES = [
  "installed",
  "reused",
  "not_prepared",
  "changed",
] as const;
export type NativeSetupBuilderOutcome = (typeof BUILDER_OUTCOMES)[number];
/** One name directly under the runtime's providers directory; nothing else. */
const BUILDER_PATH =
  /^\.hack-local\/providers\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The setup result is one small JSON line; anything larger is not read. */
const MAX_SETUP_RESULT = 64 * 1024;
export type NativeSetupInspection = {
  readonly protocol_version: 1;
  readonly state: NativeSetupState;
  readonly code: string;
  readonly installation_state: NativeSetupState;
  readonly supported_host: boolean;
  readonly setup_only: boolean;
  readonly pins: readonly NativeSetupPin[];
  /** Absent when the runtime could not observe it or does not report it. */
  readonly builder?: NativeSetupBuilder;
};

const HASH = /^[a-f0-9]{64}$/;
const CODES: Readonly<Record<NativeSetupState, string>> = {
  not_set_up: "E_NATIVE_SETUP_REQUIRED",
  partial_resumable: "E_NATIVE_SETUP_REQUIRED",
  ready: "native_setup_ready",
  invalid_preserved: "native_setup_invalid",
  pin_mismatch: "native_setup_pin_mismatch",
  unsafe_home: "native_setup_unsafe_home",
  unavailable: "native_setup_unavailable",
  unsupported_host: "unsupported_host",
};
/**
 * What to do next, naming the command for this install kind: `hack`,
 * `~/.hack-next/bin/hack-next`, or the bundle's `hack-v5` by path (HACK-2251).
 */
function guidance(
  state: NativeSetupState,
  launcher: CandidateLauncher
): string {
  const setup = launcherCommand(launcher, ["native", "setup"]);
  const fresh = freshNativeHomeSetupCommand(launcher);
  switch (state) {
    case "not_set_up":
      return `Native runtime is not set up; run ${setup}.`;
    case "partial_resumable":
      return `Native runtime setup is incomplete; run ${setup} to resume.`;
    case "ready":
      return "Native runtime is set up.";
    case "invalid_preserved":
      return `Native runtime files are incomplete or invalid; preserve this home and set up a fresh private one with the bundle's launcher: ${fresh}.`;
    case "pin_mismatch":
      return `Native runtime pins differ from this release; preserve this home for its matching release and set up a fresh private one with the bundle's launcher: ${fresh}.`;
    case "unsafe_home":
      return "Native runtime home is unsafe; select an owned mode-0700 home without symlink components using HACK_NATIVE_HOME.";
    case "unavailable":
      return "Native runtime installation could not be inspected; check the selected home's access and retry.";
    case "unsupported_host":
      return "Native runtime requires Apple Silicon macOS.";
    default:
      return state satisfies never;
  }
}

function state(value: unknown): NativeSetupState | undefined {
  return STATES.find((candidate) => candidate === value);
}

/** A builder path the runtime supplied; an omitted one is not an error. */
function builderPath(value: unknown): string | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || !BUILDER_PATH.test(value)) {
    throw new Error("Invalid native setup builder.");
  }
  return value;
}

/**
 * The builder names its pin by file name; anything else is not this protocol.
 * Its `directory` and `record` are optional: a supplied one must be one name
 * under the runtime's providers directory, and only both together are kept.
 */
function parseBuilder(
  value: unknown,
  pins: readonly NativeSetupPin[]
): NativeSetupBuilder | undefined {
  if (value === undefined) {
    return;
  }
  const builderState = isRecord(value)
    ? BUILDER_STATES.find((candidate) => candidate === value.state)
    : undefined;
  const pin = isRecord(value)
    ? pins.find(
        (candidate) => basename(new URL(candidate.url).pathname) === value.file
      )
    : undefined;
  if (!(isRecord(value) && builderState && pin)) {
    throw new Error("Invalid native setup builder.");
  }
  const directory = builderPath(value.directory);
  const record = builderPath(value.record);
  return {
    state: builderState,
    pin,
    ...(directory !== undefined && record !== undefined
      ? { paths: { directory, record } }
      : {}),
  };
}

/** Reject incompatible runtimes without exposing unvalidated subprocess text. */
export function parseNativeSetupInspection(
  value: unknown
): NativeSetupInspection {
  if (
    !isRecord(value) ||
    value.protocol_version !== 1 ||
    !state(value.state) ||
    !state(value.installation_state) ||
    typeof value.supported_host !== "boolean" ||
    typeof value.setup_only !== "boolean" ||
    !Array.isArray(value.pins) ||
    value.pins.length === 0 ||
    value.pins.length > 16
  ) {
    throw new Error("Unsupported native setup inspection protocol.");
  }
  const pins: NativeSetupPin[] = [];
  for (const pin of value.pins) {
    if (
      !isRecord(pin) ||
      typeof pin.url !== "string" ||
      !Number.isSafeInteger(pin.size_bytes) ||
      typeof pin.size_bytes !== "number" ||
      pin.size_bytes <= 0 ||
      typeof pin.archive_sha256 !== "string" ||
      !HASH.test(pin.archive_sha256)
    ) {
      throw new Error("Invalid native setup pin.");
    }
    const url = new URL(pin.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Invalid native setup source.");
    }
    pins.push({
      url: pin.url,
      size_bytes: pin.size_bytes,
      archive_sha256: pin.archive_sha256,
    });
  }
  const builder = parseBuilder(value.builder, pins);
  const effectiveState = state(value.state);
  const installationState = state(value.installation_state);
  if (
    !(effectiveState && installationState) ||
    installationState === "unsupported_host" ||
    value.code !== CODES[effectiveState] ||
    !(
      value.supported_host ||
      ["unsupported_host", "unsafe_home", "unavailable"].includes(
        effectiveState
      )
    ) ||
    (effectiveState === "ready" &&
      (!value.supported_host || installationState !== "ready"))
  ) {
    throw new Error("Inconsistent native setup inspection.");
  }
  return {
    protocol_version: 1,
    state: effectiveState,
    code: CODES[effectiveState],
    installation_state: installationState,
    supported_host: value.supported_host,
    setup_only: value.setup_only,
    pins,
    ...(builder ? { builder } : {}),
  };
}

/** Shared read-only source of truth for up, doctor and upgrade diagnostics. */
export async function inspectNativeSetup(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly cwd: string;
  readonly invoke?: typeof invokeNativeRuntime;
}): Promise<NativeSetupInspection> {
  return parseNativeSetupInspection(
    await (opts.invoke ?? invokeNativeRuntime)({
      runtime: opts.runtime,
      cwd: opts.cwd,
      args: ["runtime", "setup", "inspect", "--json"],
      timeoutMs: 30_000,
    })
  );
}

export function nativeSetupGuidance(
  inspection: Pick<NativeSetupInspection, "state">,
  launcher: CandidateLauncher = currentCandidateLauncher()
): string {
  return guidance(inspection.state, launcher);
}

export function nativeSetupCanResume(
  inspection: Pick<NativeSetupInspection, "state">
): boolean {
  return (
    inspection.state === "not_set_up" ||
    inspection.state === "partial_resumable"
  );
}

function refuse(inspection: Pick<NativeSetupInspection, "state">): never {
  throw new HackCliError({
    code: nativeSetupCanResume(inspection)
      ? "E_NATIVE_SETUP_REQUIRED"
      : "E_STARTUP_INCOMPLETE",
    message: nativeSetupGuidance(inspection),
    detail: {
      runtime_setup: inspection.state,
      native_code: CODES[inspection.state],
    },
  });
}

/**
 * Pin previews contain compiled public metadata only; no project env is read.
 * `pins` narrows the list to what this run can download: the image builder
 * alone for a home that is already set up.
 */
export function previewNativeSetup(opts: {
  readonly inspection: NativeSetupInspection;
  readonly runtime: NativeRuntimeSelection;
  readonly pins?: readonly NativeSetupPin[];
}): void {
  process.stderr.write(
    `Native runtime home: ${opts.runtime.home}\nPinned downloads (verified before preparation):\n`
  );
  for (const pin of opts.pins ?? opts.inspection.pins) {
    const url = new URL(pin.url);
    process.stderr.write(
      `  ${basename(url.pathname)}: ${pin.size_bytes} bytes; source ${url.hostname}; SHA-256 ${pin.archive_sha256}\n`
    );
  }
  process.stderr.write(
    `Private download cache: ${join(opts.runtime.home, ".hack-local/setup/downloads")}\nInstall destination: ${join(opts.runtime.home, ".hack-local/providers")}\n`
  );
}

/**
 * A set-up home that has no image builder, as a home set up before setup
 * installed one. Setup adds it only with download consent or the offline file.
 */
export function nativeSetupLacksBuilder(
  inspection: Pick<NativeSetupInspection, "state" | "builder">
): boolean {
  return (
    inspection.state === "ready" && inspection.builder?.state === "not_prepared"
  );
}

/**
 * What the runtime's setup result says about the image builder. The result is
 * one JSON line on stdout; anything else, or a runtime that does not report
 * the builder, yields nothing rather than a guess.
 */
export function nativeSetupBuilderOutcome(
  stdout: string
): NativeSetupBuilderOutcome | undefined {
  if (stdout.length > MAX_SETUP_RESULT) {
    return;
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return;
  }
  return isRecord(value)
    ? BUILDER_OUTCOMES.find((outcome) => outcome === value.builder)
    : undefined;
}

/**
 * The lines text-mode setup adds to its summary for the image builder: one
 * line when the home was left without it, one warning when what is there does
 * not match the pinned release. Setup succeeded in both cases.
 */
export function nativeSetupBuilderNotice(
  opts: NativeBuilderCommandOptions & {
    readonly outcome: NativeSetupBuilderOutcome | undefined;
    readonly paths?: NativeBuilderPaths;
  }
): { readonly stream: "stdout" | "stderr"; readonly text: string } | null {
  if (opts.outcome === "not_prepared") {
    return {
      stream: "stdout",
      text: `The image builder is not installed, so native up cannot build images yet. ${nativeBuilderRemedy(opts)}\n`,
    };
  }
  if (opts.outcome === "changed") {
    return {
      stream: "stderr",
      text: `WARN: Setup found that ${NATIVE_BUILDER_CHANGED}, so image builds are refused until it is replaced. Setup left it as it is. ${nativeBuilderChangedRemedy(opts)}\n`,
    };
  }
  return null;
}

/** No request timeout: acquisition is resumable and may take longer than startup.
 * The owned child shares the foreground group and receives forwarded signals;
 * JSON stdout and stderr are inherited. Text mode reads the JSON body only for
 * what the run did about the image builder, and renders a fixed summary only
 * after successful completion: the set-up line, then the builder notice if the
 * home was left without the builder or with one that does not match the pin.
 * `builder` names the builder's paths for that notice.
 */
export async function runNativeSetupChild(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly cwd: string;
  readonly json: boolean;
  readonly acceptDownloads: boolean;
  readonly offline?: readonly string[];
  readonly builder?: NativeBuilderPaths;
}): Promise<number> {
  const env: Record<string, string | undefined> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME"]) {
    env[key] = process.env[key];
  }
  env.HACK_NO_INTERACTIVE = "1";
  env.HACK_NATIVE_HOME = opts.runtime.home;
  const child = Bun.spawn(
    [
      opts.runtime.binary,
      "--candidate-root",
      opts.runtime.home,
      "runtime",
      "setup",
      "--no-interactive",
      ...(opts.json ? ["--json"] : []),
      ...(opts.offline ?? (opts.acceptDownloads ? ["--accept-downloads"] : [])),
    ],
    {
      cwd: opts.cwd,
      env: childEnvironment(env),
      stdin: "ignore",
      stdout: opts.json ? "inherit" : "pipe",
      stderr: "inherit",
    }
  );
  let canceledExit: number | undefined;
  const interrupt = () => {
    canceledExit = 130;
    child.kill("SIGINT");
  };
  const terminate = () => {
    canceledExit = 143;
    child.kill("SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    // Drained while the child runs, so a full pipe can never stall it.
    const [body, exit] = await Promise.all([
      child.stdout instanceof ReadableStream
        ? new Response(child.stdout).text().catch(() => "")
        : Promise.resolve(""),
      child.exited,
    ]);
    const result =
      canceledExit ??
      (child.signalCode
        ? subprocessSignalExitStatus(child.signalCode, 1)
        : exit);
    if (result === 0 && !opts.json) {
      process.stdout.write("Native runtime is set up.\n");
      const notice = nativeSetupBuilderNotice({
        outcome: nativeSetupBuilderOutcome(body),
        paths: opts.builder,
      });
      if (notice) {
        process[notice.stream].write(notice.text);
      }
    }
    return result;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

/**
 * Before any startup effect, offer one consent and re-inspect after setup.
 *
 * The detached owner skips the inspection: its launcher ran this check for
 * the same native home just before starting it, and it cannot prompt. A setup
 * that changes in between still fails closed at the owner's first runtime
 * request.
 */
export async function requireNativeSetup(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly cwd: string;
  readonly json: boolean;
  /** Test seam; defaults to whether this process is the detached owner. */
  readonly detachedOwner?: boolean;
  /** Test seam for the inspection request. */
  readonly inspect?: typeof inspectNativeSetup;
}): Promise<number> {
  if (opts.detachedOwner ?? isNativeDetachedOwnerProcess()) {
    return 0;
  }
  const inspect = opts.inspect ?? inspectNativeSetup;
  let inspection: NativeSetupInspection;
  try {
    inspection = await inspect(opts);
  } catch {
    refuse({ state: "unavailable" });
  }
  if (inspection.state === "ready") {
    return 0;
  }
  if (!nativeSetupCanResume(inspection) || opts.json || !canPrompt()) {
    refuse(inspection);
  }
  previewNativeSetup({ ...opts, inspection });
  const accepted = await confirmSafe({
    message: "Download and prepare these pinned files, then continue hack up?",
    initialValue: false,
    nonInteractive: "decline",
  });
  if (!accepted) {
    refuse(inspection);
  }
  const exit = await runNativeSetupChild({
    ...opts,
    json: false,
    acceptDownloads: true,
  });
  if (exit !== 0) {
    process.stderr.write(
      `Native runtime setup did not complete; run ${launcherCommand(currentCandidateLauncher(), ["native", "setup"])} to resume.\n`
    );
    return exit;
  }
  const installed = await inspect(opts);
  if (installed.state !== "ready") {
    refuse(installed);
  }
  return 0;
}
