import { constants as osConstants } from "node:os";
import { basename, join } from "node:path";
import { childEnvironment } from "../lib/child-environment.ts";
import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { canPrompt, confirmSafe } from "../lib/interactivity.ts";
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
export type NativeSetupInspection = {
  readonly protocol_version: 1;
  readonly state: NativeSetupState;
  readonly code: string;
  readonly installation_state: NativeSetupState;
  readonly supported_host: boolean;
  readonly setup_only: boolean;
  readonly pins: readonly NativeSetupPin[];
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
const GUIDANCE: Readonly<Record<NativeSetupState, string>> = {
  not_set_up: "Native runtime is not set up; run hack native setup.",
  partial_resumable:
    "Native runtime setup is incomplete; run hack native setup to resume.",
  ready: "Native runtime is set up.",
  invalid_preserved:
    "Native runtime files are incomplete or invalid; preserve this home and select a fresh private HACK_NATIVE_HOME with the bundle's hack-v5 launcher before running hack native setup.",
  pin_mismatch:
    "Native runtime pins differ from this release; preserve this home for its matching release and select a fresh private HACK_NATIVE_HOME with the bundle's hack-v5 launcher.",
  unsafe_home:
    "Native runtime home is unsafe; select an owned mode-0700 home without symlink components using HACK_NATIVE_HOME.",
  unavailable:
    "Native runtime installation could not be inspected; check the selected home's access and retry.",
  unsupported_host: "Native runtime requires Apple Silicon macOS.",
};

function state(value: unknown): NativeSetupState | undefined {
  return STATES.find((candidate) => candidate === value);
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
  inspection: Pick<NativeSetupInspection, "state">
): string {
  return GUIDANCE[inspection.state];
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

/** Pin previews contain compiled public metadata only; no project env is read. */
export function previewNativeSetup(opts: {
  readonly inspection: NativeSetupInspection;
  readonly runtime: NativeRuntimeSelection;
}): void {
  process.stderr.write(
    `Native runtime home: ${opts.runtime.home}\nPinned downloads (verified before preparation):\n`
  );
  for (const pin of opts.inspection.pins) {
    const url = new URL(pin.url);
    process.stderr.write(
      `  ${basename(url.pathname)}: ${pin.size_bytes} bytes; source ${url.hostname}; SHA-256 ${pin.archive_sha256}\n`
    );
  }
  process.stderr.write(
    `Private download cache: ${join(opts.runtime.home, ".hack-local/setup/downloads")}\nInstall destination: ${join(opts.runtime.home, ".hack-local/providers")}\n`
  );
}

/** No request timeout: acquisition is resumable and may take longer than startup.
 * The owned child shares the foreground group and receives forwarded signals;
 * JSON stdout and stderr are inherited; text mode ignores the JSON body and
 * renders a fixed summary only after successful completion.
 */
export async function runNativeSetupChild(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly cwd: string;
  readonly json: boolean;
  readonly acceptDownloads: boolean;
  readonly offline?: readonly string[];
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
      stdout: opts.json ? "inherit" : "ignore",
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
    const exit = await child.exited;
    const result =
      canceledExit ??
      (child.signalCode
        ? 128 + (osConstants.signals[child.signalCode] ?? 1)
        : exit);
    if (result === 0 && !opts.json) {
      process.stdout.write("Native runtime is set up.\n");
    }
    return result;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

/** Before any startup effect, offer one consent and re-inspect after setup. */
export async function requireNativeSetup(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly cwd: string;
  readonly json: boolean;
}): Promise<number> {
  let inspection: NativeSetupInspection;
  try {
    inspection = await inspectNativeSetup(opts);
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
      "Native runtime setup did not complete; run hack native setup to resume.\n"
    );
    return exit;
  }
  const installed = await inspectNativeSetup(opts);
  if (installed.state !== "ready") {
    refuse(installed);
  }
  return 0;
}
