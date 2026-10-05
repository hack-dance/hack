import { join } from "node:path";
import { isRecord } from "../lib/guards.ts";
import {
  type NativeHttpsOwnerConfiguration,
  nativeHttpsOwnerRefused,
} from "./native-https-owner-protocol.ts";
import {
  type NativeHttpsFileIdentity,
  nativeHttpsOwnerRoot,
  nativeHttpsPrivateDirectory,
  nativeHttpsReadFile,
  nativeHttpsWriteNew,
} from "./native-https-owner-storage.ts";
import { NativeRuntimeRequestError } from "./native-runtime-client.ts";

const STAGES = [
  "frontend-start",
  "owner-challenge",
  "authority-observation",
  "authority-start",
  "authority-ready",
  "caddy-start",
  "caddy-ready",
  "listener-verification",
  "owner-publication",
  "owner-verification",
  "control-publication",
  "control-verification",
  "endpoint-publication",
] as const;
type Stage = (typeof STAGES)[number];
const NATIVE_CODES = new Set([
  "provider_busy",
  "provider_state",
  "foreign_state",
  "invalid_receipt",
  "recovery_required",
  "host_endpoint_identity",
  "engine_protocol",
]);
interface Diagnostic {
  readonly stage: Stage;
  readonly nativeCode: string | null;
  readonly cleanupUnconfirmed: boolean;
}
function isDiagnostic(value: unknown): value is Diagnostic {
  return (
    isRecord(value) &&
    Object.keys(value).sort().join() ===
      "cleanupUnconfirmed,nativeCode,stage" &&
    STAGES.some((stage) => stage === value.stage) &&
    (value.nativeCode === null ||
      (typeof value.nativeCode === "string" &&
        NATIVE_CODES.has(value.nativeCode))) &&
    typeof value.cleanupUnconfirmed === "boolean"
  );
}
/** Only reviewed classifications cross the detached owner boundary; never raw errors. */
export class NativeHttpsStartupError extends Error {
  readonly diagnostic: Diagnostic;
  constructor(stage: Stage, error?: unknown, cleanupUnconfirmed = false) {
    const inherited =
      error instanceof NativeHttpsStartupError && isDiagnostic(error.diagnostic)
        ? error.diagnostic
        : undefined;
    const nativeCode =
      error instanceof NativeRuntimeRequestError &&
      error.nativeCode &&
      NATIVE_CODES.has(error.nativeCode)
        ? error.nativeCode
        : null;
    const diagnostic = {
      stage,
      nativeCode,
      ...inherited,
      cleanupUnconfirmed:
        cleanupUnconfirmed || inherited?.cleanupUnconfirmed === true,
    };
    super(
      `Native HTTPS startup failed (${diagnostic.stage}${diagnostic.nativeCode ? `: ${diagnostic.nativeCode}` : ""})${diagnostic.cleanupUnconfirmed ? "; child cleanup unconfirmed" : ""}; values omitted.`
    );
    this.diagnostic = diagnostic;
  }
}
/** Diagnostic evidence only: this record never acknowledges cleanup or permits adoption. */
export async function recordNativeHttpsStartupFailure(opts: {
  readonly configuration: NativeHttpsOwnerConfiguration;
  readonly configurationIdentity: NativeHttpsFileIdentity;
  readonly error: NativeHttpsStartupError;
}): Promise<void> {
  const root = nativeHttpsOwnerRoot(opts.configuration.binding.runtime.home);
  await nativeHttpsPrivateDirectory(root);
  const current = await nativeHttpsReadFile(join(root, "configuration.json"));
  const expected = opts.configurationIdentity;
  if (
    current.identity.dev !== expected.dev ||
    current.identity.ino !== expected.ino ||
    current.identity.sha256 !== expected.sha256 ||
    !isDiagnostic(opts.error.diagnostic)
  ) {
    throw nativeHttpsOwnerRefused();
  }
  await nativeHttpsWriteNew(join(root, "startup-failure.json"), {
    version: 1,
    ownerGeneration: opts.configuration.ownerGeneration,
    configurationSha256: expected.sha256,
    diagnostic: opts.error.diagnostic,
  });
}
export async function readNativeHttpsStartupFailure(
  configuration: NativeHttpsOwnerConfiguration
): Promise<NativeHttpsStartupError | undefined> {
  const root = nativeHttpsOwnerRoot(configuration.binding.runtime.home);
  await nativeHttpsPrivateDirectory(root);
  let bytes: Buffer;
  try {
    ({ bytes } = await nativeHttpsReadFile(join(root, "startup-failure.json")));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return;
    }
    throw nativeHttpsOwnerRefused();
  }
  const current = await nativeHttpsReadFile(join(root, "configuration.json"));
  let value: unknown;
  let currentConfiguration: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
    currentConfiguration = JSON.parse(current.bytes.toString("utf8"));
  } catch {
    throw nativeHttpsOwnerRefused();
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join() !==
      "configurationSha256,diagnostic,ownerGeneration,version" ||
    value.version !== 1 ||
    JSON.stringify(currentConfiguration) !== JSON.stringify(configuration) ||
    value.ownerGeneration !== configuration.ownerGeneration ||
    value.configurationSha256 !== current.identity.sha256 ||
    !isDiagnostic(value.diagnostic)
  ) {
    throw nativeHttpsOwnerRefused();
  }
  const diagnostic = value.diagnostic;
  return new NativeHttpsStartupError(
    diagnostic.stage,
    diagnostic.nativeCode
      ? new NativeRuntimeRequestError({
          message: "",
          nativeCode: diagnostic.nativeCode,
        })
      : undefined,
    diagnostic.cleanupUnconfirmed
  );
}
