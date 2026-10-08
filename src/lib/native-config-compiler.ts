import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isRecord } from "./guards.ts";
import {
  authoredAcquisitionPlanningRequired,
  nativeAcquisitionPlanIsValid,
  nativeAcquisitionPlanningRequired,
  nativeAcquisitionSourceMatches,
} from "./native-acquisition-plan-protocol.ts";
import { beginNativeCpuChild } from "./native-cpu-diagnostics.ts";
import {
  type NativeHostBindingResolution,
  nativeEndpointEnvironmentMatches,
  nativeEndpointPlanIsValid,
  nativeEndpointPlanningRequired,
  nativeHostBindingResolutionMatches,
  parseNativeHostBindingResolution,
} from "./native-endpoint-plan-protocol.ts";
import {
  type NativeDeclaredWorkloads,
  type NativeEnvironmentPlan,
  type NativeEnvMetadata,
  parseDeclaredWorkloads,
  parseNativeEnvironmentPlan,
  parseNativeEnvMetadata,
} from "./native-env-plan-protocol.ts";
import {
  authoredFilePlanningRequired,
  type NativeFilePlan,
  nativeFilePlanIsValid,
  nativeFilePlanningRequired,
  nativeFileSourceMatches,
  parseNativeFilePlan,
} from "./native-file-plan-protocol.ts";
import {
  type NativeHostEnvTargets,
  nativeHostSelectionMatches,
  parseNativeHostTargets,
} from "./native-host-plan-protocol.ts";
import {
  authoredNetworkPlanningRequired,
  nativeNetworkPlanIsValid,
  nativeNetworkPlanningRequired,
  nativeNetworkSourceMatches,
} from "./native-network-plan-protocol.ts";
import {
  authoredProcessPlanningRequired,
  nativeProcessPlanIsValid,
  nativeProcessPlanningRequired,
  nativeProcessSourceMatches,
} from "./native-process-plan-protocol.ts";
import {
  type NativeRoutingResolution,
  nativeRoutingPlanIsValid,
  nativeRoutingSelectionMatches,
  parseNativeRoutingResolution,
} from "./native-routing-plan-protocol.ts";

export const NATIVE_CONFIG_INPUT_LIMIT = 1024 * 1024;
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const STDERR_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const OVERLAY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESOLVE_REQUEST_LIMIT = 20 * 1024 * 1024;

export type NativeConfigDiagnostic = {
  readonly code: string;
  readonly pointer: string;
  readonly message: string;
  readonly line: number;
  readonly column: number;
  readonly document?: NativeConfigDocumentRole;
};

export type NativeConfigDocumentRole =
  | "project"
  | "primary_local"
  | "checkout_local"
  | "request";

export type NativeLocalResolution = {
  readonly overlay: string | null;
  readonly origin: "project" | "primary_local" | "checkout_local" | "explicit";
  readonly auto_branch: boolean;
  readonly inherit_local: boolean;
  readonly resolution_hash: string;
};

export type NativeConfigResolveResult =
  | (Extract<NativeConfigCompileResult, { readonly ok: true }> & {
      readonly local_resolution: NativeLocalResolution;
      readonly routing_resolution?: NativeRoutingResolution;
      readonly routing_inputs_required?: true;
      readonly host_binding_resolution?: NativeHostBindingResolution;
    })
  | Extract<NativeConfigCompileResult, { readonly ok: false }>;

export type NativeConfigPlanResult =
  | (Extract<NativeConfigResolveResult, { readonly ok: true }> & {
      readonly declared_workloads: NativeDeclaredWorkloads;
      readonly environment_plan: NativeEnvironmentPlan;
      readonly file_plan?: NativeFilePlan;
    })
  | Extract<NativeConfigCompileResult, { readonly ok: false }>;

export type NativeConfigCompileResult =
  | {
      readonly transport_version: 1;
      readonly ok: true;
      readonly plan: Readonly<Record<string, unknown>>;
      readonly semantic_hash: string;
      readonly declared_workloads?: NativeDeclaredWorkloads;
      readonly host_env_targets?: NativeHostEnvTargets;
    }
  | {
      readonly transport_version: 1;
      readonly ok: false;
      readonly diagnostics: readonly NativeConfigDiagnostic[];
    };

/** Fixed transport failures never include compiler output or authored values. */
export class NativeConfigCompilerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "NativeConfigCompilerError";
    this.code = code;
  }
}

/** Select a reviewed executable, never download or search PATH for a compiler. */
export function resolveNativeConfigCompilerBinary(
  opts: { readonly override?: string; readonly executablePath?: string } = {}
): string {
  const override = opts.override ?? process.env.HACK_CONFIG_COMPILER_BINARY;
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw failure(
        "E_COMPILER_PATH",
        "Compiler override must be an absolute path."
      );
    }
    return override;
  }
  return join(
    dirname(opts.executablePath ?? process.execPath),
    "hack-config-compiler"
  );
}

/** Read only an explicitly selected regular input, with bounded allocation. */
export async function readNativeConfigInput(opts: {
  readonly path: string;
}): Promise<Uint8Array> {
  try {
    const info = await stat(opts.path);
    if (!info.isFile() || info.size > NATIVE_CONFIG_INPUT_LIMIT) {
      throw failure(
        "E_CONFIG_INPUT",
        "Native configuration must be a bounded regular file."
      );
    }
    return await readBounded(
      Bun.file(opts.path).stream(),
      NATIVE_CONFIG_INPUT_LIMIT
    );
  } catch (error: unknown) {
    if (error instanceof NativeConfigCompilerError) {
      throw error;
    }
    throw failure(
      "E_CONFIG_INPUT",
      "Cannot read the selected native configuration."
    );
  }
}

/**
 * Ask the owning Rust compiler to validate and normalize authored JSON. Check the
 * transport handshake before sending input. This boundary forwards no credentials,
 * performs no runtime discovery, and never substitutes another compiler/backend.
 */
export async function compileNativeConfig(opts: {
  readonly input: Uint8Array;
  readonly binary?: string;
  readonly profiles?: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly requireLocalResolution?: boolean;
  readonly requireEnvPlanning?: boolean;
  readonly requireHostPlanning?: boolean;
  readonly requireRoutingPlanning?: boolean;
  readonly requireEndpointPlanning?: boolean;
  readonly requireProcessPlanning?: boolean;
  readonly requireAcquisitionPlanning?: boolean;
  readonly requireNetworkPlanning?: boolean;
  readonly requireFilePlanning?: boolean;
}): Promise<NativeConfigCompileResult> {
  const authoredInput = captureCompilerInput(opts.input);
  const request = compilerRequest(opts);
  await checkProtocol({
    ...request,
    requireLocalResolution: opts.requireLocalResolution,
    requireEnvPlanning: opts.requireEnvPlanning,
    requireHostPlanning: opts.requireHostPlanning,
    requireRoutingPlanning: opts.requireRoutingPlanning,
    requireEndpointPlanning: opts.requireEndpointPlanning,
    requireProcessPlanning:
      opts.requireProcessPlanning ||
      authoredProcessPlanningRequired(authoredInput),
    requireAcquisitionPlanning:
      opts.requireAcquisitionPlanning ||
      authoredAcquisitionPlanningRequired(authoredInput),
    requireFilePlanning:
      opts.requireFilePlanning || authoredFilePlanningRequired(authoredInput),
    requireNetworkPlanning:
      opts.requireNetworkPlanning ||
      authoredNetworkPlanningRequired(authoredInput),
  });
  const response = await invokeCompiler({
    ...request,
    args: compileArguments("compile", opts.profiles),
    input: authoredInput,
  });
  const result = parseCompileResponse(response);
  if (result.ok) {
    if (nativeNetworkPlanningRequired(result.plan)) {
      await checkProtocol({ ...request, requireNetworkPlanning: true });
    }
    assertNetworkSource({
      input: authoredInput,
      result,
      profiles: opts.profiles,
    });
    assertFileSource({ input: authoredInput, result, profiles: opts.profiles });
    assertProcessSource({
      input: authoredInput,
      result,
      profiles: opts.profiles,
    });
    assertAcquisitionSource({
      input: authoredInput,
      result,
      profiles: opts.profiles,
    });
    if (nativeFilePlanningRequired(result.plan)) {
      await checkProtocol({ ...request, requireFilePlanning: true });
    }
    if (nativeProcessPlanningRequired(result.plan)) {
      await checkProtocol({ ...request, requireProcessPlanning: true });
    }
    if (nativeAcquisitionPlanningRequired(result.plan)) {
      await checkProtocol({ ...request, requireAcquisitionPlanning: true });
    }
  }
  if (result.ok && hasRouting(result.plan) && !opts.requireRoutingPlanning) {
    await checkProtocol({ ...request, requireRoutingPlanning: true });
  }
  if (
    result.ok &&
    nativeEndpointPlanningRequired(result.plan) &&
    !opts.requireEndpointPlanning
  ) {
    await checkProtocol({ ...request, requireEndpointPlanning: true });
  }
  if (opts.requireEnvPlanning && result.ok && !result.declared_workloads) {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native compiler omitted the declared workload namespace."
    );
  }
  return result;
}

/** Resolve original document text in Rust; this transport never parses local policy. */
export async function resolveNativeConfig(opts: {
  readonly input: Uint8Array;
  readonly primaryLocal?: Uint8Array;
  readonly checkoutLocal?: Uint8Array;
  readonly explicitOverlay?: string | null;
  readonly explicitDomain?: string;
  readonly globalDomain?: string;
  readonly branch?: string;
  readonly binary?: string;
  readonly profiles?: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly requireEnvPlanning?: boolean;
  readonly requireHostPlanning?: boolean;
  readonly requireRoutingPlanning?: boolean;
  readonly requireEndpointPlanning?: boolean;
  readonly requireProcessPlanning?: boolean;
  readonly requireAcquisitionPlanning?: boolean;
  readonly requireNetworkPlanning?: boolean;
  readonly requireFilePlanning?: boolean;
  readonly probeRoutingInputs?: boolean;
}): Promise<NativeConfigResolveResult> {
  const authoredInput = captureCompilerInput(opts.input);
  const plainInput = encodeResolveRequest({ ...opts, input: authoredInput });
  const request = compilerRequest(opts);
  const capabilities = await checkProtocol({
    ...request,
    requireLocalResolution: true,
    requireEnvPlanning: opts.requireEnvPlanning,
    requireHostPlanning: opts.requireHostPlanning,
    requireRoutingPlanning:
      opts.requireRoutingPlanning || hasRoutingInputs(opts),
    requireEndpointPlanning: opts.requireEndpointPlanning,
    requireProcessPlanning:
      opts.requireProcessPlanning ||
      authoredProcessPlanningRequired(authoredInput),
    requireAcquisitionPlanning:
      opts.requireAcquisitionPlanning ||
      authoredAcquisitionPlanningRequired(authoredInput),
    requireFilePlanning:
      opts.requireFilePlanning || authoredFilePlanningRequired(authoredInput),
    requireNetworkPlanning:
      opts.requireNetworkPlanning ||
      authoredNetworkPlanningRequired(authoredInput),
  });
  const routingProbe =
    opts.probeRoutingInputs === true && capabilities.routingPlanning;
  const input = routingProbe
    ? encodeResolveRequest({ ...opts, input: authoredInput, routingProbe })
    : plainInput;
  const response = await invokeCompiler({
    ...request,
    args: compileArguments("resolve", opts.profiles),
    input,
  });
  const parsed = parseResolveResponse({
    ...response,
    requireRouting: opts.requireRoutingPlanning || hasRoutingInputs(opts),
    branch: opts.branch,
    explicitDomain: opts.explicitDomain,
    globalDomain: opts.globalDomain,
    routingProbe,
    primaryLocal: opts.primaryLocal,
    checkoutLocal: opts.checkoutLocal,
  });
  if (!parsed.ok) {
    return parsed;
  }
  if (nativeNetworkPlanningRequired(parsed.plan)) {
    await checkProtocol({ ...request, requireNetworkPlanning: true });
  }
  assertNetworkSource({
    input: authoredInput,
    result: parsed,
    profiles: opts.profiles,
  });
  assertFileSource({
    input: authoredInput,
    result: parsed,
    profiles: opts.profiles,
  });
  assertProcessSource({
    input: authoredInput,
    result: parsed,
    profiles: opts.profiles,
  });
  assertAcquisitionSource({
    input: authoredInput,
    result: parsed,
    profiles: opts.profiles,
  });
  if (nativeFilePlanningRequired(parsed.plan)) {
    await checkProtocol({ ...request, requireFilePlanning: true });
  }
  if (nativeProcessPlanningRequired(parsed.plan)) {
    await checkProtocol({ ...request, requireProcessPlanning: true });
  }
  if (nativeAcquisitionPlanningRequired(parsed.plan)) {
    await checkProtocol({ ...request, requireAcquisitionPlanning: true });
  }
  if (parsed.routing_resolution || parsed.routing_inputs_required) {
    await checkProtocol({ ...request, requireRoutingPlanning: true });
  }
  if (
    nativeEndpointPlanningRequired(parsed.plan) ||
    parsed.host_binding_resolution
  ) {
    await checkProtocol({ ...request, requireEndpointPlanning: true });
  }
  if (opts.requireEnvPlanning && !parsed.declared_workloads) {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native compiler omitted the declared workload namespace."
    );
  }
  const { envelope, ...result } = parsed;
  void envelope;
  return result;
}

type NativeResolveInputs = {
  readonly input: Uint8Array;
  readonly primaryLocal?: Uint8Array;
  readonly checkoutLocal?: Uint8Array;
  readonly explicitOverlay?: string | null;
  readonly explicitDomain?: string;
  readonly globalDomain?: string;
  readonly branch?: string;
};

function encodeResolveRequest(
  opts: NativeResolveInputs & {
    readonly envMetadata?: NativeEnvMetadata;
    readonly routingProbe?: boolean;
  }
): Uint8Array {
  for (const value of [opts.explicitDomain, opts.globalDomain, opts.branch]) {
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        Buffer.byteLength(value, "utf8") > NATIVE_CONFIG_INPUT_LIMIT)
    ) {
      throw failure(
        "E_CONFIG_INPUT",
        "Native routing selection is invalid or exceeds its budget."
      );
    }
  }
  if (
    typeof opts.explicitOverlay === "string" &&
    Buffer.byteLength(opts.explicitOverlay, "utf8") > NATIVE_CONFIG_INPUT_LIMIT
  ) {
    throw failure(
      "E_CONFIG_INPUT",
      "Native explicit overlay selection exceeds the input budget."
    );
  }
  const input = new TextEncoder().encode(
    JSON.stringify({
      request_version: 1,
      project: documentText(opts.input, "project"),
      primary_local:
        opts.primaryLocal === undefined
          ? undefined
          : documentText(opts.primaryLocal, "primary_local"),
      checkout_local:
        opts.checkoutLocal === undefined
          ? undefined
          : documentText(opts.checkoutLocal, "checkout_local"),
      explicit_overlay: opts.explicitOverlay,
      explicit_domain: opts.explicitDomain,
      global_domain: opts.globalDomain,
      branch: opts.branch,
      env_metadata: opts.envMetadata,
      routing_probe: opts.routingProbe ? true : undefined,
    })
  );
  if (input.byteLength > RESOLVE_REQUEST_LIMIT) {
    throw failure(
      "E_CONFIG_INPUT",
      "Native local resolution request exceeds the input budget."
    );
  }
  return input;
}

/** Inspect only metadata supplied by the managed-env owner; no decryption or runtime effects. */
export async function planNativeConfig(
  opts: NativeResolveInputs & {
    readonly envMetadata: NativeEnvMetadata;
    readonly binary?: string;
    readonly profiles?: readonly string[];
    readonly timeoutMs?: number;
    readonly signal?: AbortSignal;
    readonly requireRoutingPlanning?: boolean;
    readonly requireEndpointPlanning?: boolean;
    readonly requireProcessPlanning?: boolean;
    readonly requireAcquisitionPlanning?: boolean;
    readonly requireNetworkPlanning?: boolean;
    readonly requireFilePlanning?: boolean;
  }
): Promise<NativeConfigPlanResult> {
  const authoredInput = captureCompilerInput(opts.input);
  const metadata = parseNativeEnvMetadata(opts.envMetadata);
  if (
    !metadata ||
    Buffer.byteLength(JSON.stringify(metadata), "utf8") >
      NATIVE_CONFIG_INPUT_LIMIT
  ) {
    throw failure(
      "E_CONFIG_METADATA",
      "Native environment metadata is invalid or exceeds its budget; values omitted."
    );
  }
  const input = encodeResolveRequest({
    ...opts,
    input: authoredInput,
    envMetadata: metadata,
  });
  const request = compilerRequest(opts);
  await checkProtocol({
    ...request,
    requireLocalResolution: true,
    requireEnvPlanning: true,
    requireHostPlanning: metadata.host !== undefined,
    requireRoutingPlanning:
      opts.requireRoutingPlanning || hasRoutingInputs(opts),
    requireEndpointPlanning: opts.requireEndpointPlanning,
    requireProcessPlanning:
      opts.requireProcessPlanning ||
      authoredProcessPlanningRequired(authoredInput),
    requireAcquisitionPlanning:
      opts.requireAcquisitionPlanning ||
      authoredAcquisitionPlanningRequired(authoredInput),
    requireFilePlanning:
      opts.requireFilePlanning || authoredFilePlanningRequired(authoredInput),
    requireNetworkPlanning:
      opts.requireNetworkPlanning ||
      authoredNetworkPlanningRequired(authoredInput),
  });
  const response = await invokeCompiler({
    ...request,
    args: compileArguments("plan", opts.profiles),
    input,
  });
  const parsed = parseResolveResponse({
    ...response,
    allowIncompletePlan: true,
    requireRouting: opts.requireRoutingPlanning || hasRoutingInputs(opts),
    branch: opts.branch,
    explicitDomain: opts.explicitDomain,
    globalDomain: opts.globalDomain,
    primaryLocal: opts.primaryLocal,
    checkoutLocal: opts.checkoutLocal,
  });
  if (!parsed.ok) {
    return parsed;
  }
  if (nativeNetworkPlanningRequired(parsed.plan)) {
    await checkProtocol({ ...request, requireNetworkPlanning: true });
  }
  assertNetworkSource({
    input: authoredInput,
    result: parsed,
    profiles: opts.profiles,
  });
  assertFileSource({
    input: authoredInput,
    result: parsed,
    profiles: opts.profiles,
  });
  assertProcessSource({
    input: authoredInput,
    result: parsed,
    profiles: opts.profiles,
  });
  assertAcquisitionSource({
    input: authoredInput,
    result: parsed,
    profiles: opts.profiles,
  });
  if (nativeFilePlanningRequired(parsed.plan)) {
    await checkProtocol({ ...request, requireFilePlanning: true });
  }
  if (nativeProcessPlanningRequired(parsed.plan)) {
    await checkProtocol({ ...request, requireProcessPlanning: true });
  }
  if (nativeAcquisitionPlanningRequired(parsed.plan)) {
    await checkProtocol({ ...request, requireAcquisitionPlanning: true });
  }
  if (parsed.routing_resolution) {
    await checkProtocol({ ...request, requireRoutingPlanning: true });
  }
  if (
    nativeEndpointPlanningRequired(parsed.plan) ||
    parsed.host_binding_resolution
  ) {
    await checkProtocol({ ...request, requireEndpointPlanning: true });
  }
  const environmentPlan = parseNativeEnvironmentPlan({
    value: parsed.envelope.environment_plan,
    parseDiagnostic,
  });
  const filePlan = parseNativeFilePlan({
    value: parsed.envelope.file_plan,
    plan: parsed.plan,
    metadata,
    parseDiagnostic,
  });
  if (
    filePlan === null ||
    !(parsed.declared_workloads && environmentPlan) ||
    environmentPlan.overlay !== parsed.local_resolution.overlay ||
    environmentPlan.overlay !== metadata.overlay ||
    environmentPlan.overlay_exists !== metadata.overlay_exists ||
    !environmentPlanMatchesSelection({
      plan: parsed.plan,
      declared: parsed.declared_workloads,
      environmentPlan,
    }) ||
    !nativeHostSelectionMatches({
      plan: parsed.plan,
      declared: parsed.declared_workloads,
      targets: parsed.host_env_targets,
      report: environmentPlan.host,
      requireReport: true,
    }) ||
    !nativeEndpointEnvironmentMatches({
      plan: parsed.plan,
      declared: parsed.declared_workloads,
      environmentPlan,
      routing: parsed.routing_resolution,
      resolution: parsed.host_binding_resolution,
      metadata,
    }) ||
    response.exitCode !== planExitCode(environmentPlan, filePlan)
  ) {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native environment planning returned an invalid result."
    );
  }
  const { envelope, ...result } = parsed;
  void envelope;
  return {
    ...result,
    declared_workloads: parsed.declared_workloads,
    environment_plan: environmentPlan,
    ...(filePlan === undefined ? {} : { file_plan: filePlan }),
  };
}

function captureCompilerInput(input: Uint8Array): Uint8Array {
  if (input.byteLength > NATIVE_CONFIG_INPUT_LIMIT) {
    throw failure(
      "E_CONFIG_INPUT",
      "Native configuration exceeds the input budget."
    );
  }
  return new Uint8Array(input);
}

function planExitCode(
  environment: NativeEnvironmentPlan,
  files: NativeFilePlan | undefined
): 0 | 1 {
  return environment.complete && files?.complete !== false ? 0 : 1;
}

/** Reject inconsistent compiler envelopes without interpreting authored selection policy. */
function environmentPlanMatchesSelection(opts: {
  readonly plan: Readonly<Record<string, unknown>>;
  readonly declared: NativeDeclaredWorkloads;
  readonly environmentPlan: NativeEnvironmentPlan;
}): boolean {
  const selected = new Set<string>();
  for (const [field, kind] of [
    ["services", "service"],
    ["jobs", "job"],
  ] as const) {
    const workloads = opts.plan[field];
    if (!isRecord(workloads)) {
      return false;
    }
    for (const name of Object.keys(workloads)) {
      if (selected.has(name) || opts.declared[name] !== kind) {
        return false;
      }
      selected.add(name);
    }
  }
  const reportNames = Object.keys(opts.environmentPlan.workloads);
  return (
    selected.size === reportNames.length &&
    reportNames.every((name) => selected.has(name))
  );
}

function parseResolveResponse(opts: {
  readonly output: Uint8Array;
  readonly exitCode: number;
  readonly allowIncompletePlan?: boolean;
  readonly requireRouting?: boolean;
  readonly branch?: string;
  readonly explicitDomain?: string;
  readonly globalDomain?: string;
  readonly routingProbe?: boolean;
  readonly primaryLocal?: Uint8Array;
  readonly checkoutLocal?: Uint8Array;
}):
  | (Extract<NativeConfigResolveResult, { readonly ok: true }> & {
      readonly envelope: Readonly<Record<string, unknown>>;
    })
  | Extract<NativeConfigResolveResult, { readonly ok: false }> {
  const envelope = parseControlJson(opts.output);
  const result = parseCompileValue({
    value: envelope,
    exitCode: opts.exitCode,
    allowIncompletePlan: opts.allowIncompletePlan,
  });
  if (!result.ok) {
    if (
      result.diagnostics.some((diagnostic) => diagnostic.document === undefined)
    ) {
      throw failure(
        "E_COMPILER_RESPONSE",
        "Native local resolution returned an invalid diagnostic."
      );
    }
    return result;
  }
  if (!isRecord(envelope)) {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native local resolution returned an invalid envelope."
    );
  }
  const routing =
    envelope.routing_resolution === undefined
      ? undefined
      : parseNativeRoutingResolution(envelope.routing_resolution);
  const routingInputsRequired = envelope.routing_inputs_required;
  const local = parseLocalResolution(envelope.local_resolution);
  const hostBindings = parseEndpointResolution({
    envelope,
    result,
    local,
    primaryLocal: opts.primaryLocal,
    checkoutLocal: opts.checkoutLocal,
  });
  if (
    (routingInputsRequired !== undefined &&
      !(opts.routingProbe && routingInputsRequired === true)) ||
    (opts.routingProbe && routing !== undefined) ||
    (opts.routingProbe &&
      (opts.requireRouting ||
        Object.hasOwn(result.plan, "routes") ||
        Object.hasOwn(result.plan, "open")) &&
      routingInputsRequired !== true)
  ) {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native routing input probe returned an invalid result."
    );
  }
  if (
    routing === null ||
    !(
      opts.routingProbe ||
      nativeRoutingSelectionMatches({
        plan: result.plan,
        declared: result.declared_workloads,
        resolution: routing,
        required: opts.requireRouting,
        branch: opts.branch,
        explicitDomain: opts.explicitDomain,
        globalDomain: opts.globalDomain,
      })
    )
  ) {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native routing resolution returned an invalid result."
    );
  }
  return {
    ...result,
    local_resolution: local,
    ...(hostBindings === undefined
      ? {}
      : { host_binding_resolution: hostBindings }),
    ...(routing === undefined ? {} : { routing_resolution: routing }),
    ...(routingInputsRequired === true
      ? { routing_inputs_required: true as const }
      : {}),
    envelope,
  };
}

function parseEndpointResolution(opts: {
  readonly envelope: Record<string, unknown>;
  readonly result: Extract<NativeConfigCompileResult, { readonly ok: true }>;
  readonly local: NativeLocalResolution;
  readonly primaryLocal?: Uint8Array;
  readonly checkoutLocal?: Uint8Array;
}): NativeHostBindingResolution | undefined {
  const resolution = Object.hasOwn(opts.envelope, "host_binding_resolution")
    ? parseNativeHostBindingResolution(opts.envelope.host_binding_resolution)
    : undefined;
  if (
    resolution === null ||
    !nativeHostBindingResolutionMatches({
      plan: opts.result.plan,
      resolution,
      primaryLocal: opts.primaryLocal,
      checkoutLocal: opts.checkoutLocal,
      inheritLocal: opts.local.inherit_local,
    }) ||
    !nativeEndpointPlanIsValid({
      plan: opts.result.plan,
      declared: opts.result.declared_workloads,
      resolution,
      resolved: true,
    })
  ) {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native endpoint resolution returned an invalid result."
    );
  }
  return resolution;
}

function documentText(
  input: Uint8Array,
  role: NativeConfigDocumentRole
): string {
  if (input.byteLength > NATIVE_CONFIG_INPUT_LIMIT) {
    throw failure(
      "E_CONFIG_INPUT",
      "Native configuration exceeds the input budget."
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      input
    );
  } catch {
    throw failure(
      "E_CONFIG_INPUT",
      `Native ${role} input must be valid UTF-8.`
    );
  }
}

function compilerRequest(opts: {
  readonly binary?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}) {
  const binary = opts.binary ?? resolveNativeConfigCompilerBinary();
  if (!isAbsolute(binary)) {
    throw failure("E_COMPILER_PATH", "Compiler path must be absolute.");
  }
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw failure(
      "E_COMPILER_BUDGET",
      "Compiler timeout is outside the supported budget."
    );
  }
  return { binary, timeoutMs, signal: opts.signal };
}

async function checkProtocol(opts: {
  readonly binary: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly requireLocalResolution?: boolean;
  readonly requireEnvPlanning?: boolean;
  readonly requireHostPlanning?: boolean;
  readonly requireRoutingPlanning?: boolean;
  readonly requireEndpointPlanning?: boolean;
  readonly requireProcessPlanning?: boolean;
  readonly requireAcquisitionPlanning?: boolean;
  readonly requireNetworkPlanning?: boolean;
  readonly requireFilePlanning?: boolean;
}): Promise<{ readonly routingPlanning: boolean }> {
  const handshake = await invokeCompiler({ ...opts, args: ["--protocol"] });
  const protocol = parseControlJson(handshake.output);
  if (
    handshake.exitCode !== 0 ||
    !isRecord(protocol) ||
    protocol.transport_version !== 1 ||
    protocol.authored_version !== 1 ||
    protocol.plan_version !== 1 ||
    (opts.requireEnvPlanning && protocol.env_plan_version !== 1) ||
    (opts.requireHostPlanning && protocol.host_env_plan_version !== 1) ||
    (opts.requireRoutingPlanning && protocol.routing_plan_version !== 1) ||
    (opts.requireEndpointPlanning && protocol.endpoint_plan_version !== 1) ||
    (opts.requireProcessPlanning && protocol.process_plan_version !== 1) ||
    (opts.requireFilePlanning && protocol.file_plan_version !== 1) ||
    (opts.requireAcquisitionPlanning &&
      protocol.acquisition_plan_version !== 1) ||
    (opts.requireNetworkPlanning && protocol.network_plan_version !== 1) ||
    (opts.requireLocalResolution &&
      (protocol.resolve_version !== 1 || protocol.local_version !== 1))
  ) {
    throw failure(
      "E_COMPILER_VERSION",
      "Native configuration compiler version mismatch."
    );
  }
  return { routingPlanning: protocol.routing_plan_version === 1 };
}

function compileArguments(
  command: "compile" | "resolve" | "plan",
  profiles?: readonly string[]
): string[] {
  const args: string[] = [command];
  for (const profile of profiles ?? []) {
    args.push("--profile", profile);
  }
  return args;
}

function isResolutionOrigin(
  value: unknown
): value is NativeLocalResolution["origin"] {
  return (
    value === "project" ||
    value === "primary_local" ||
    value === "checkout_local" ||
    value === "explicit"
  );
}

function parseLocalResolution(value: unknown): NativeLocalResolution {
  if (
    !(
      isRecord(value) &&
      (value.overlay === null ||
        (typeof value.overlay === "string" &&
          OVERLAY_PATTERN.test(value.overlay))) &&
      isResolutionOrigin(value.origin)
    ) ||
    typeof value.auto_branch !== "boolean" ||
    typeof value.inherit_local !== "boolean" ||
    typeof value.resolution_hash !== "string" ||
    !HASH_PATTERN.test(value.resolution_hash)
  ) {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native local resolution returned an invalid result."
    );
  }
  return {
    overlay: value.overlay,
    origin: value.origin,
    auto_branch: value.auto_branch,
    inherit_local: value.inherit_local,
    resolution_hash: value.resolution_hash,
  };
}

async function invokeCompiler(opts: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly input?: Uint8Array;
  readonly signal?: AbortSignal;
}): Promise<{ readonly output: Uint8Array; readonly exitCode: number }> {
  if (opts.signal?.aborted) {
    throw failure(
      "E_COMPILER_CANCELLED",
      "Native configuration validation was cancelled."
    );
  }
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  const ownsProcessGroup = process.platform !== "win32";
  try {
    child = Bun.spawn([opts.binary, ...opts.args], {
      env: { PATH: "/usr/bin:/bin" },
      stdin: opts.input === undefined ? "ignore" : opts.input,
      stdout: "pipe",
      stderr: "pipe",
      detached: ownsProcessGroup,
    });
  } catch {
    throw failure(
      "E_COMPILER_MISSING",
      "Native configuration compiler is unavailable. Install its matching bundle."
    );
  }
  let timedOut = false;
  let cancelled = false;
  let settled = false;
  let stopped = false;
  const observeCpu = beginNativeCpuChild(child, "compiler");
  const io = new AbortController();
  const kill = () => {
    if (!(settled || stopped)) {
      stopped = true;
      killOwnedCompiler({ child, ownsProcessGroup });
    }
    io.abort();
  };
  const cancel = () => {
    cancelled = true;
    kill();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, opts.timeoutMs);
  opts.signal?.addEventListener("abort", cancel, { once: true });
  if (opts.signal?.aborted) {
    cancel();
  }
  const outputRead = readBounded(child.stdout, OUTPUT_LIMIT, io.signal);
  const errorRead = readBounded(child.stderr, STDERR_LIMIT, io.signal);
  try {
    const [output, , exitCode] = await Promise.all([
      outputRead,
      errorRead,
      child.exited,
    ]);
    // Reaped leader plus closed streams releases the group. Leader exit alone
    // cannot disarm cleanup while an owned descendant holds inherited pipes.
    settled = true;
    throwIfCompilerInterrupted({ cancelled, timedOut });
    return { output, exitCode };
  } catch (error: unknown) {
    throwIfCompilerInterrupted({ cancelled, timedOut });
    if (error instanceof NativeConfigCompilerError) {
      throw error;
    }
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native configuration compiler request failed."
    );
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", cancel);
    kill();
    const completion = await Promise.allSettled([
      outputRead,
      errorRead,
      child.exited,
    ]);
    observeCpu(
      completion[2].status === "fulfilled" ? completion[2].value : undefined
    );
  }
}

function throwIfCompilerInterrupted(opts: {
  readonly cancelled: boolean;
  readonly timedOut: boolean;
}): void {
  if (opts.cancelled || opts.timedOut) {
    throw failure(
      opts.cancelled ? "E_COMPILER_CANCELLED" : "E_COMPILER_TIMEOUT",
      opts.cancelled
        ? "Native configuration validation was cancelled."
        : "Native configuration compiler timed out."
    );
  }
}

function killOwnedCompiler(opts: {
  readonly child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  readonly ownsProcessGroup: boolean;
}): void {
  if (opts.ownsProcessGroup) {
    try {
      process.kill(-opts.child.pid, "SIGKILL");
    } catch {
      // An exited group is already clean; still reap a live direct child below.
    }
  }
  if (opts.child.exitCode === null) {
    try {
      opts.child.kill("SIGKILL");
    } catch {
      // Child exit may race the group signal.
    }
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    reader.cancel().catch(() => {
      // A concurrently closed stream already satisfies cancellation.
    });
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) {
    cancel();
  }
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > limit) {
        cancel();
        throw failure(
          "E_COMPILER_BUDGET",
          "Native configuration I/O exceeds its budget."
        );
      }
      chunks.push(next.value);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseControlJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native configuration compiler returned invalid JSON."
    );
  }
}

function parseCompileResponse(opts: {
  readonly output: Uint8Array;
  readonly exitCode: number;
}): NativeConfigCompileResult {
  const value = parseControlJson(opts.output);
  if (
    isRecord(value) &&
    (Object.hasOwn(value, "routing_resolution") ||
      Object.hasOwn(value, "routing_inputs_required") ||
      Object.hasOwn(value, "host_binding_resolution"))
  ) {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native compilation returned a context-dependent routing report."
    );
  }
  return parseCompileValue({
    value,
    exitCode: opts.exitCode,
  });
}

function parseCompileValue(opts: {
  readonly value: unknown;
  readonly exitCode: number;
  readonly allowIncompletePlan?: boolean;
}): NativeConfigCompileResult {
  const value = opts.value;
  if (!isRecord(value) || value.transport_version !== 1) {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native configuration compiler returned an invalid envelope."
    );
  }
  if (
    (opts.exitCode === 0 ||
      (opts.allowIncompletePlan && opts.exitCode === 1)) &&
    value.ok === true &&
    isRecord(value.plan) &&
    value.plan.plan_version === 1 &&
    typeof value.semantic_hash === "string" &&
    HASH_PATTERN.test(value.semantic_hash)
  ) {
    const declared =
      value.declared_workloads === undefined
        ? undefined
        : parseDeclaredWorkloads(value.declared_workloads);
    if (declared === null) {
      throw failure(
        "E_COMPILER_RESPONSE",
        "Native compiler returned an invalid workload namespace."
      );
    }
    const hostTargets = parseHostNamespace({
      value,
      plan: value.plan,
      declared,
    });
    assertPlanDeclarations({ plan: value.plan, declared });
    return {
      transport_version: 1,
      ok: true,
      plan: value.plan,
      semantic_hash: value.semantic_hash,
      ...(declared === undefined ? {} : { declared_workloads: declared }),
      ...(hostTargets === undefined ? {} : { host_env_targets: hostTargets }),
    };
  }
  if (
    opts.exitCode === 1 &&
    value.ok === false &&
    Array.isArray(value.diagnostics) &&
    value.diagnostics.length > 0
  ) {
    const diagnostics = value.diagnostics.map(parseDiagnostic);
    return { transport_version: 1, ok: false, diagnostics };
  }
  throw failure(
    "E_COMPILER_RESPONSE",
    "Native configuration compiler returned an invalid result."
  );
}

function assertPlanDeclarations(opts: {
  readonly plan: Readonly<Record<string, unknown>>;
  readonly declared?: NativeDeclaredWorkloads;
}): void {
  for (const [kind, valid] of [
    ["routing", nativeRoutingPlanIsValid(opts)],
    ["endpoint", nativeEndpointPlanIsValid(opts)],
    ["process", nativeProcessPlanIsValid(opts)],
    ["acquisition", nativeAcquisitionPlanIsValid(opts)],
    ["network", nativeNetworkPlanIsValid(opts)],
    ["file", nativeFilePlanIsValid(opts)],
  ] as const) {
    if (!valid) {
      throw failure(
        "E_COMPILER_RESPONSE",
        `Native compiler returned invalid ${kind} declarations.`
      );
    }
  }
}

function assertFileSource(opts: {
  readonly input: Uint8Array;
  readonly result: Extract<NativeConfigCompileResult, { readonly ok: true }>;
  readonly profiles?: readonly string[];
}): void {
  if (
    !nativeFileSourceMatches({
      input: opts.input,
      plan: opts.result.plan,
      declared: opts.result.declared_workloads,
      profiles: opts.profiles,
    })
  ) {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native compiler changed the authored file requirements."
    );
  }
}

function assertProcessSource(opts: {
  readonly input: Uint8Array;
  readonly result: Extract<NativeConfigCompileResult, { readonly ok: true }>;
  readonly profiles?: readonly string[];
}): void {
  if (
    !nativeProcessSourceMatches({
      input: opts.input,
      plan: opts.result.plan,
      declared: opts.result.declared_workloads,
      profiles: opts.profiles,
    })
  ) {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native compiler changed the authored process requirements."
    );
  }
}

function assertAcquisitionSource(opts: {
  readonly input: Uint8Array;
  readonly result: Extract<NativeConfigCompileResult, { readonly ok: true }>;
  readonly profiles?: readonly string[];
}): void {
  if (
    !nativeAcquisitionSourceMatches({
      input: opts.input,
      plan: opts.result.plan,
      declared: opts.result.declared_workloads,
      profiles: opts.profiles,
    })
  ) {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native compiler changed the authored acquisition requirements."
    );
  }
}

function assertNetworkSource(opts: {
  readonly input: Uint8Array;
  readonly result: Extract<NativeConfigCompileResult, { readonly ok: true }>;
  readonly profiles?: readonly string[];
}): void {
  if (
    !nativeNetworkSourceMatches({
      input: opts.input,
      plan: opts.result.plan,
      declared: opts.result.declared_workloads,
      profiles: opts.profiles,
    })
  ) {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native compiler changed the authored network requirements."
    );
  }
}

function hasRouting(plan: Readonly<Record<string, unknown>>): boolean {
  return plan.routes !== undefined || plan.open !== undefined;
}

function hasRoutingInputs(opts: NativeResolveInputs): boolean {
  return (
    opts.explicitDomain !== undefined ||
    opts.globalDomain !== undefined ||
    opts.branch !== undefined
  );
}

function parseHostNamespace(opts: {
  readonly value: Record<string, unknown>;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly declared: NativeDeclaredWorkloads | undefined;
}): NativeHostEnvTargets | undefined {
  const targets =
    opts.value.host_env_targets === undefined
      ? undefined
      : parseNativeHostTargets(opts.value.host_env_targets);
  if (
    targets === null ||
    !nativeHostSelectionMatches({
      plan: opts.plan,
      declared: opts.declared,
      targets,
    })
  ) {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native compiler returned an invalid host target namespace."
    );
  }
  return targets;
}

function parseDiagnostic(value: unknown): NativeConfigDiagnostic {
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    typeof value.pointer !== "string" ||
    typeof value.message !== "string" ||
    typeof value.line !== "number" ||
    !Number.isSafeInteger(value.line) ||
    value.line < 1 ||
    typeof value.column !== "number" ||
    !Number.isSafeInteger(value.column) ||
    value.column < 1 ||
    (value.document !== undefined && !isDocumentRole(value.document))
  ) {
    throw failure(
      "E_COMPILER_RESPONSE",
      "Native configuration compiler returned an invalid diagnostic."
    );
  }
  return {
    code: value.code,
    pointer: value.pointer,
    message: value.message,
    line: value.line,
    column: value.column,
    ...(isDocumentRole(value.document) ? { document: value.document } : {}),
  };
}

function isDocumentRole(value: unknown): value is NativeConfigDocumentRole {
  return (
    value === "project" ||
    value === "primary_local" ||
    value === "checkout_local" ||
    value === "request"
  );
}

function failure(code: string, message: string): NativeConfigCompilerError {
  return new NativeConfigCompilerError(code, message);
}
