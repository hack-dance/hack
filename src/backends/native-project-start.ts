import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { ClosedCliError, HackCliError } from "../lib/cli-result.ts";
import {
  type ComposeEnvFingerprintRecord,
  withComposeServiceEnvFingerprints,
} from "../lib/compose-env-fingerprint.ts";
import { isRecord } from "../lib/guards.ts";
import {
  nativeDetachedUpShellVariables,
  nativeShellForwardingNotice,
} from "../lib/native-detached-up.ts";
import {
  describeNativeProcessRefusals,
  type NativeProcessRefusal,
  requireWrappableNativeProcesses,
} from "../lib/native-process-wrappers.ts";
import { adaptNativeAwsEnvironment } from "./native-aws-environment.ts";
import { scheduleNativeAwsExpiryWarnings } from "./native-aws-expiry.ts";
import type { NativeDependencyOwnerResolver } from "./native-dependency-owners.ts";
import {
  adaptNativeGcloudEnvironment,
  type NativeGcloudSelection,
} from "./native-gcloud-environment.ts";
import {
  admitNativeHttpProbe,
  isInferredNativeRouteProbe,
} from "./native-http-probe-admission.ts";
import {
  acquireNativeHttpsLease,
  NativeHttpsLeaseAcquisitionError,
  type NativeHttpsLeaseIdentity,
  recoverNativeHttpsLease,
} from "./native-https-owner.ts";
import { reportNativeIgnoredSettingNotices } from "./native-ignored-setting-notices.ts";
import {
  NATIVE_IMAGE_ENSURE_TIMEOUT_MS,
  nativeImagePolicyArgs,
} from "./native-image-policy.ts";
import {
  type NativePreparedBase,
  preparedBaseArguments,
} from "./native-prepared-base.ts";
import { nativePrivateEnvironmentPayload } from "./native-private-environment-payload.ts";
import { prepareNativeProjectAdaptation } from "./native-project-adaptation.ts";
import {
  admitNativeProjectBuilds,
  buildNativeProjectImages,
  invokeNativeBuild,
  type NativeBuildRequest,
  nativeBuildsEnabled,
  nativeRebuildRequested,
  refuseEmulatedBuilds,
  refuseManagedSecretBuildArguments,
} from "./native-project-builds.ts";
import {
  nativeSharedSourceFlags,
  nativeStartCacheSource,
} from "./native-project-cache.ts";
import {
  discoverNativeHostDependency,
  discoverNativeOwnedHostDependency,
  type NativeDependencyWaitProgress,
  nativeDependencyStartupWait,
  prepareNativeDependencyServices,
  readNativeHostDependencies,
} from "./native-project-dependencies.ts";
import {
  admitNativeDownHookGeneration,
  createNativeForegroundDownHooks,
} from "./native-project-down-hooks.ts";
import { discardUnpublishedNativeStart } from "./native-project-failed-start.ts";
import {
  admitNativeProjectFinalization,
  beginNativeProjectFinalization,
  captureNativeProjectFinalization,
  waitNativeProjectFinalization,
} from "./native-project-finalization.ts";
import {
  createNativeForegroundStop,
  type NativeForegroundStop,
  type NativeForegroundStopCommands,
  nativeForegroundStopSignals,
} from "./native-project-foreground-stop.ts";
import { isNativeHttpsProbePath } from "./native-project-https.ts";
import { admitNativeProjectImages } from "./native-project-image-admission.ts";
import {
  mergeNativeShellEnvironment,
  type NativeProjectInput,
  nativeReviewedActiveServices,
  prepareNativeProjectInput,
  requireNativeShellDeliveryFits,
  selectActiveNativeProjectInput,
} from "./native-project-input.ts";
import { inspectNativeProjectGraph } from "./native-project-inspect.ts";
import {
  applyNativeInternalHostAliases,
  type NativeHostAliasSource,
  nativeServiceHostAliases,
  requireNativeHostAliasBindings,
} from "./native-project-internal-hosts.ts";
import {
  NativePartialShutdownError,
  recoverNativeInterruptedStartupCleanup,
} from "./native-project-interrupted-cleanup.ts";
import { validateNativeAllowedHosts } from "./native-project-network.ts";
import {
  ensuredPlatformAccepted,
  type NativeEmulationPolicy,
  nativeAmd64EmulationUpArgs,
  nativeEmulationPolicy,
  nativeEnsureImageArgs,
} from "./native-project-platform.ts";
import {
  checkNativeLoopbackPorts,
  nativeBridgeSocketCount,
  nativePortPublicationCount,
  reviewedNativeLoopbackPorts,
} from "./native-project-ports.ts";
import { serveNativeProjectGraph } from "./native-project-process.ts";
import { selectNativeProjectRestore } from "./native-project-restore.ts";
import { confirmedNativeRetainedGraph } from "./native-project-retained.ts";
import { selectNativeRetainedImages } from "./native-project-retained-images.ts";
import {
  preflightNativeRetainedStartup,
  verifyNativeResumedRetainedGraph,
  verifyNativeRetainedMapping,
} from "./native-project-retained-startup.ts";
import {
  prepareNativeReviewBranch,
  selectNativeProjectReviewIdentity,
  withNativeProjectReview,
} from "./native-project-review.ts";
import {
  hasOnlyNativeSupportedLabels,
  hasOnlyNativeSupportedLogging,
  nativeBridgeCapacity,
  reviewedNativeRoutes,
  unsupportedNativeLabelKeys,
} from "./native-project-routing.ts";
import {
  beginNativeProjectStartupObservation,
  describeNativeRunEnvironmentChange,
  loadNativeProjectRun,
  loadNativeRestartIntent,
  type NativeProjectRun,
  type NativeProjectRunScope,
  type NativeRunEnvironmentMarkers,
  nativeRunEnvironmentAvailable,
  nativeRunEnvironmentChange,
  nativeRunEnvironmentMarkers,
  nativeRunEnvironmentRemedy,
  normalizeNativeProfiles,
  prepareNativeProjectRunStorage,
  removeNativeProjectRun,
  saveNativeProjectRun,
} from "./native-project-run.ts";
import { selectNativeEnvFile } from "./native-project-selection.ts";
import { preflightNativeProjectSource } from "./native-project-source-preflight.ts";
import {
  requireCapturedNativeSourceWithinLimit,
  requireNativeSourceWithinLimit,
} from "./native-project-source-size.ts";
import { requireNativeStaticStartReview } from "./native-project-start-preflight.ts";
import { reportNativeRestartPolicyNotices } from "./native-restart-policy-notices.ts";
import {
  invokeNativeRuntime,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
  retainNativeRuntimeFailure,
} from "./native-runtime-client.ts";
import {
  applyNativeRuntimeMetadata,
  type NativeRuntimeMetadataSelection,
  verifyNativeRuntimeMetadataRoutes,
} from "./native-runtime-metadata.ts";
import {
  monitorNativeServiceExits,
  type NativeServiceExit,
} from "./native-service-exit-monitor.ts";
import { formatNativeStartupLogReport } from "./native-startup-logs.ts";

const SHA = /^[a-f0-9]{64}$/;
const OWNER = /^[a-f0-9]{32}$/;
const RUN = OWNER;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const BOOT_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export type NativeHttpsSelection = {
  readonly caddyBinary: string;
  readonly caddySha256: string;
  readonly httpsPort: number;
};
export function validateHttpsSelection(
  selection: NativeHttpsSelection | undefined
): void {
  if (
    selection &&
    (!(
      isAbsolute(selection.caddyBinary) &&
      SHA.test(selection.caddySha256) &&
      Number.isInteger(selection.httpsPort)
    ) ||
      selection.httpsPort < 1 ||
      selection.httpsPort > 65_535)
  ) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        "Native HTTPS requires an absolute HACK_NATIVE_CADDY_BINARY, SHA256 pin and explicit HTTPS port; values omitted.",
    });
  }
}
export function parseNativeHttpsSelection(
  env: Readonly<Record<string, string | undefined>>
): NativeHttpsSelection | undefined {
  const binary = env.HACK_NATIVE_CADDY_BINARY,
    hash = env.HACK_NATIVE_CADDY_SHA256,
    port = env.HACK_NATIVE_HTTPS_PORT;
  if (binary === undefined && hash === undefined && port === undefined) {
    return undefined;
  }
  if (
    binary === undefined ||
    hash === undefined ||
    port === undefined ||
    String(Number(port)) !== port
  ) {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message:
        "Native HTTPS selection requires binary, SHA256 and port together; values omitted.",
    });
  }
  const selection = {
    caddyBinary: binary,
    caddySha256: hash,
    httpsPort: Number(port),
  };
  validateHttpsSelection(selection);
  return selection;
}
/** Bind shared ingress only after the native graph has an authoritative owner. */
async function acquireReadyHttps(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly selection: NativeHttpsSelection;
  readonly run: NativeProjectRun;
  readonly signal: AbortSignal;
  readonly invoke: typeof invokeNativeRuntime;
  readonly acquire: typeof acquireNativeHttpsLease;
  readonly onIntent: (identity: NativeHttpsLeaseIdentity) => Promise<void>;
}): Promise<Awaited<ReturnType<typeof acquireNativeHttpsLease>>> {
  const pool = await opts.invoke({
    runtime: opts.runtime,
    cwd: opts.runtime.home,
    args: ["runtime", "status", "--json"],
    timeoutMs: 5000,
    signal: opts.signal,
  });
  if (
    !(
      isRecord(pool) &&
      pool.phase === "running" &&
      pool.process_alive === true &&
      typeof pool.guest_boot_id === "string" &&
      BOOT_ID.test(pool.guest_boot_id)
    )
  ) {
    throw new ClosedCliError(
      "Native HTTPS requires a verified running pool incarnation."
    );
  }
  requireActiveStartup(opts.signal);
  return await opts.acquire({
    runtime: opts.runtime,
    ...opts.selection,
    pool: { owner: opts.run.owner, bootId: pool.guest_boot_id },
    lease: {
      run: opts.run.run,
      attempt: randomBytes(16).toString("hex"),
      namespace: opts.run.namespace,
      planId: opts.run.planId,
    },
    onIntent: opts.onIntent,
  });
}
/**
 * Routes from the reviewed runtime plan. A plan that lacks the routed service
 * or its hostname list is malformed runtime output, refused as unconfirmed; a
 * routed service without an enabled reviewed HTTP probe, or one hostname with
 * conflicting probes, is the configuration refusal.
 */
function reviewedHttpsProbe(
  healthcheck: unknown,
  port: unknown
): { path: string; inferred?: true } {
  if (
    !(
      isRecord(healthcheck) &&
      healthcheck.disabled !== true &&
      isRecord(healthcheck.native_http) &&
      isNativeHttpsProbePath(healthcheck.native_http.path)
    )
  ) {
    throw refused();
  }
  const probe = healthcheck.native_http;
  const path = healthcheck.native_http.path;
  const inferred = isInferredNativeRouteProbe(probe, port);
  if (probe.policy !== undefined && !inferred) {
    throw refused();
  }
  return { path, ...(inferred ? { inferred: true as const } : {}) };
}
export function reviewedNativeHttpsRoutes(
  plan: unknown,
  services: ReadonlySet<string>
): readonly {
  hostname: string;
  path: string;
  service: string;
  inferred?: true;
}[] {
  if (!(isRecord(plan) && isRecord(plan.services))) {
    throw unconfirmed("the reviewed runtime plan");
  }
  const names = new Map<
    string,
    { path: string; service: string; inferred?: true }
  >();
  for (const name of services) {
    const service = plan.services[name];
    if (
      !(
        isRecord(service) &&
        isRecord(service.routing) &&
        Array.isArray(service.routing.hostnames)
      )
    ) {
      throw unconfirmed("the reviewed runtime plan");
    }
    const probe = reviewedHttpsProbe(service.healthcheck, service.routing.port);
    for (const hostname of service.routing.hostnames) {
      if (typeof hostname !== "string") {
        throw unconfirmed("the reviewed runtime plan");
      }
      const path = probe.path;
      if (
        names.has(hostname) &&
        (names.get(hostname)?.path !== path ||
          names.get(hostname)?.service !== name)
      ) {
        throw refused();
      }
      names.set(hostname, {
        path,
        service: name,
        ...(probe.inferred ? { inferred: true as const } : {}),
      });
    }
  }
  return [...names]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hostname, route]) => ({ hostname, ...route }));
}
type Hooks = {
  readonly cleanup: () => Promise<void>;
  readonly ready?: () => Promise<void>;
  /**
   * The project's `down.before`/`down.after` commands, present only when it
   * declares them. Each resolves to the exit status after its child exited;
   * the signal cancels a running phase (a second interrupt).
   */
  readonly stop?: NativeForegroundStopCommands;
  /**
   * Names of the persistent `up.before` hooks and lifecycle processes that
   * may start host dependency listeners; a discovery-deadline refusal lists them.
   */
  readonly listenerHooks?: readonly string[];
};
type Dependencies = {
  prepare: typeof prepareNativeProjectInput;
  prepareStorage: typeof prepareNativeProjectRunStorage;
  adaptAws: typeof adaptNativeAwsEnvironment;
  adaptGcloud: typeof adaptNativeGcloudEnvironment;
  /** Value-free operator notices (for example credential expiry); stderr by default. */
  warn: (line: string) => void;
  review: typeof withNativeProjectReview;
  staticReview: typeof requireNativeStaticStartReview;
  selectReview: typeof selectNativeProjectReviewIdentity;
  retainedImages: typeof selectNativeRetainedImages;
  serve: typeof serveNativeProjectGraph;
  https: typeof acquireNativeHttpsLease;
  recoverHttps: typeof recoverNativeHttpsLease;
  cleanupTemporary: (directory: string) => Promise<void>;
  invoke: typeof invokeNativeRuntime;
  /** Refuses captured source over the native source limit before any runtime work. */
  sourceSize: typeof requireNativeSourceWithinLimit;
  build: typeof invokeNativeBuild;
  load: typeof loadNativeProjectRun;
  loadRestart: typeof loadNativeRestartIntent;
  save: typeof saveNativeProjectRun;
  remove: typeof removeNativeProjectRun;
  finalization: typeof beginNativeProjectFinalization;
  admitFinalization: typeof admitNativeProjectFinalization;
  captureFinalization: typeof captureNativeProjectFinalization;
  waitFinalization: typeof waitNativeProjectFinalization;
  discardFailedStart: typeof discardUnpublishedNativeStart;
  admitDownHooks: typeof admitNativeDownHookGeneration;
  downHooks: typeof createNativeForegroundDownHooks;
  /** Poll interval of the ready graph's service exit monitor. */
  exitMonitorIntervalMs: number;
};
const DEFAULTS: Dependencies = {
  prepare: prepareNativeProjectInput,
  prepareStorage: prepareNativeProjectRunStorage,
  adaptAws: adaptNativeAwsEnvironment,
  adaptGcloud: adaptNativeGcloudEnvironment,
  warn: (line) => {
    process.stderr.write(`${line}\n`);
  },
  review: withNativeProjectReview,
  staticReview: requireNativeStaticStartReview,
  selectReview: selectNativeProjectReviewIdentity,
  retainedImages: selectNativeRetainedImages,
  serve: serveNativeProjectGraph,
  https: acquireNativeHttpsLease,
  recoverHttps: recoverNativeHttpsLease,
  cleanupTemporary: (directory) =>
    rm(directory, { recursive: true, force: true }),
  invoke: invokeNativeRuntime,
  sourceSize: requireNativeSourceWithinLimit,
  build: invokeNativeBuild,
  load: loadNativeProjectRun,
  loadRestart: loadNativeRestartIntent,
  save: saveNativeProjectRun,
  remove: removeNativeProjectRun,
  finalization: beginNativeProjectFinalization,
  admitFinalization: admitNativeProjectFinalization,
  captureFinalization: captureNativeProjectFinalization,
  waitFinalization: waitNativeProjectFinalization,
  discardFailedStart: discardUnpublishedNativeStart,
  admitDownHooks: admitNativeDownHookGeneration,
  downHooks: createNativeForegroundDownHooks,
  exitMonitorIntervalMs: 2000,
};
/**
 * Reports forwarded source names and unset-reference notices for active services.
 * Detached launchers receive only validated names over IPC; values stay private.
 */
function reportNativeEnvironmentNotices(
  input: NativeProjectInput,
  reviewedPlan: unknown,
  warn: (line: string) => void
): void {
  const active = nativeReviewedActiveServices(reviewedPlan);
  const names = [
    ...new Set(
      Object.entries(input.forwardedShellVariables ?? {})
        .filter(([service]) => active.has(service))
        .flatMap(([, names]) => names)
    ),
  ].sort();
  if (!nativeDetachedUpShellVariables(names)) {
    warn(nativeShellForwardingNotice(names));
  }
  for (const notice of input.environmentNotices ?? []) {
    if (active.has(notice.service)) {
      warn(notice.line);
    }
  }
}

/**
 * The input about to be delivered: the services the reviewed plan marks
 * active, checked against the runtime's delivery limits. The check comes
 * last, after the credential adapters added theirs and after the profile
 * filter, because the runtime receives nothing for an inactive service.
 */
function activeNativeDeliveryInput(opts: {
  readonly input: NativeProjectInput;
  readonly reviewedPlan: unknown;
}): NativeProjectInput {
  const active = selectActiveNativeProjectInput(opts);
  requireNativeShellDeliveryFits(active);
  return active;
}

/** Fixed text of the native foreground configuration refusal. */
export const NATIVE_CONFIGURATION_REFUSAL =
  "Native foreground up cannot admit this configuration: routing, host dependencies, builds or unsupported runtime settings require explicit native support; configuration was not dropped. Run `hack doctor --native-preflight` to list every blocker with its fix.";
/** Known configuration refusal: a stable code and a closed message, no stack. */
function refused(): Error {
  return new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message: NATIVE_CONFIGURATION_REFUSAL,
  });
}

/**
 * A runtime reply or saved ownership record that does not match this start.
 * This is an integrity or ownership refusal, not a configuration refusal: it
 * is closed (no stack) and carries no configuration code.
 */
function unconfirmed(subject: string): Error {
  return new ClosedCliError(
    `Native foreground up could not confirm ${subject}; inspect owned state before retrying.`
  );
}

/** Fixed classifications from reviewed-route verification; peer values are never echoed. */
function httpsVerificationFailed(code: string): Error {
  return new ClosedCliError(
    `Native HTTPS verification failed (${code}); peer values omitted.`
  );
}

/** Cancellation is not a configuration refusal: it carries no refusal code. */
/**
 * A foreground start ended by a stop request. `beforeServices` is set only when
 * the request arrived after the start's own stop handling was installed and
 * before any service of the run was requested, and the start's cleanup (hooks,
 * finalization) then completed: nothing of the new run was admitted.
 */
export class NativeStartupCanceledError extends ClosedCliError {
  readonly interruptedExit: number;
  readonly beforeServices: boolean;
  constructor(interruptedExit = 130, beforeServices = false) {
    super("Native foreground up was canceled; values omitted.");
    this.interruptedExit = interruptedExit;
    this.beforeServices = beforeServices;
  }
}
/**
 * The error a failed foreground start reports. A stop request before any service
 * was requested is a confirmed cancellation: the run was never admitted. The
 * caller's cleanup must still complete, or its own failure replaces this outcome.
 */
function foregroundStartFailure(opts: {
  readonly error: unknown;
  readonly stopRequested: boolean;
  readonly servicesRequested: boolean;
  readonly httpsAcquisitionFailure: unknown;
  readonly interruptedExit: number;
}): unknown {
  if (
    opts.stopRequested &&
    !opts.servicesRequested &&
    opts.httpsAcquisitionFailure === undefined
  ) {
    return new NativeStartupCanceledError(opts.interruptedExit, true);
  }
  return httpsCleanupFailure(opts.httpsAcquisitionFailure, opts.error);
}
function canceled(): Error {
  return new NativeStartupCanceledError();
}

function requireActiveStartup(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw canceled();
  }
}
function admitStartBuilds(
  input: NativeProjectInput,
  opts: {
    readonly scope: { readonly projectRoot: string };
    readonly composeFile: string;
  }
): ReadonlyMap<string, NativeBuildRequest> {
  const builds = admitNativeProjectBuilds({
    services: composeServices(input),
    projectRoot: opts.scope.projectRoot,
    composeFile: opts.composeFile,
    enabled: nativeBuildsEnabled(),
  });
  refuseManagedSecretBuildArguments({
    builds,
    managedSecretValues: input.managedSecretValues ?? [],
  });
  // Native builds produce linux/arm64 images; amd64 emulation cannot apply to them.
  refuseEmulatedBuilds({ builds, amd64Emulation: input.amd64Emulation });
  return builds;
}

/** A service names an image, or is an admitted build that names none yet. */
function imageOrAdmittedBuild(
  name: string,
  value: Readonly<Record<string, unknown>>,
  builds: ReadonlySet<string>
): boolean {
  if (value.build === undefined) {
    return typeof value.image === "string";
  }
  return builds.has(name) && value.image === undefined;
}

/** The normalized Compose services, or the closed configuration refusal. */
function composeServices(
  input: NativeProjectInput
): Record<string, Record<string, unknown>> {
  const compose: unknown = JSON.parse(input.normalizedComposeJson);
  if (!(isRecord(compose) && isRecord(compose.services))) {
    throw refused();
  }
  const services: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(compose.services)) {
    if (!isRecord(value)) {
      throw refused();
    }
    services[name] = value;
  }
  return services;
}

/** Why native service preparation refuses one service; closed names, no values. */
export const NATIVE_SERVICE_PREPARATION_PROBLEMS = [
  "invalid_service",
  "missing_image",
  "extra_hosts_without_dependencies",
  "unsupported_logging",
  "invalid_restart",
  "unsupported_label",
] as const;
export type NativeServicePreparationProblem =
  (typeof NATIVE_SERVICE_PREPARATION_PROBLEMS)[number];

/**
 * Every reason {@link prepareNativeProjectServices} refuses one service. The
 * start path refuses on the first non-empty answer; the native preflight
 * report lists them all, so both read this one rule.
 */
export function nativeServicePreparationProblems(opts: {
  readonly name: string;
  readonly service: unknown;
  readonly hasHostDependencies: boolean;
  /** Services whose Compose `build` was admitted. */
  readonly builds: ReadonlySet<string>;
}): NativeServicePreparationProblem[] {
  const value = opts.service;
  if (!isRecord(value)) {
    return ["invalid_service"];
  }
  const problems: NativeServicePreparationProblem[] = [];
  if (!imageOrAdmittedBuild(opts.name, value, opts.builds)) {
    problems.push("missing_image");
  }
  if (value.extra_hosts !== undefined && !opts.hasHostDependencies) {
    problems.push("extra_hosts_without_dependencies");
  }
  if (!hasOnlyNativeSupportedLogging(value.logging)) {
    problems.push("unsupported_logging");
  }
  // Restart policies are admitted (or refused with a fixed reason) by the
  // runtime graph, which owns stop/restart interaction; only the type is checked here.
  if (value.restart !== undefined && typeof value.restart !== "string") {
    problems.push("invalid_restart");
  }
  if (!hasOnlyNativeSupportedLabels(value.labels)) {
    problems.push("unsupported_label");
  }
  return problems;
}

/**
 * `builds` names the services whose Compose `build` was admitted
 * (`admitNativeProjectBuilds`); only those may omit `image` until they are built.
 */
export function prepareNativeProjectServices(
  input: NativeProjectInput,
  hasHostDependencies = false,
  builds: ReadonlySet<string> = new Set()
): Record<string, Record<string, unknown>> {
  const compose: unknown = JSON.parse(input.normalizedComposeJson);
  if (!(isRecord(compose) && isRecord(compose.services))) {
    throw refused();
  }
  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(compose.services)) {
    if (isRecord(value)) {
      const unsupported = unsupportedNativeLabelKeys(value.labels).filter(
        (key) => key.startsWith("caddy") || key.startsWith("traefik")
      );
      if (unsupported.length) {
        throw new HackCliError({
          code: "E_NATIVE_PROJECT_UNSUPPORTED",
          message: `Native service labels are unsupported: ${unsupported.join(", ")}. Remove the unsupported router directive; run hack doctor --native-preflight for every blocker. Label values were omitted; nothing was started.`,
        });
      }
    }
    if (
      !isRecord(value) ||
      nativeServicePreparationProblems({
        name,
        service: value,
        hasHostDependencies,
        builds,
      }).length > 0
    ) {
      throw refused();
    }
    admitNativeHttpProbe(name, value);
    result[name] = value;
  }
  return result;
}
/** Fixed text of the refusal when the project share was not granted. */
export const NATIVE_SHARED_SOURCE_REFUSAL =
  "Native foreground up requires HACK_NATIVE_SHARED_SOURCE=1 or sharedSource in the native machine settings to share this exact project, including ignored files. Grant that share and run the command again.";
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** Keep image acquisition separate from graph admission and preserve cancellation between requests. */
async function pinNativeProjectImages(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly specs: Record<string, Record<string, unknown>>;
  readonly retainedImages: ReadonlyMap<string, string>;
  /** Opted-in services' platform policies; every other service resolves Linux arm64. */
  readonly amd64Emulation?: Readonly<Record<string, NativeEmulationPolicy>>;
  readonly signal: AbortSignal;
  readonly invoke: typeof invokeNativeRuntime;
}): Promise<void> {
  for (const [name, spec] of Object.entries(opts.specs)) {
    if (opts.signal.aborted) {
      throw canceled();
    }
    const retainedImage = opts.retainedImages.get(name);
    if (retainedImage) {
      spec.image = retainedImage;
      continue;
    }
    // A build service left unbuilt here is outside the selected profiles.
    if (spec.image === undefined && spec.build !== undefined) {
      continue;
    }
    const image = String(spec.image);
    if (IMAGE.test(image)) {
      continue;
    }
    const policy = nativeEmulationPolicy(opts.amd64Emulation, name);
    const ensured = await opts
      .invoke({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        args: [
          ...nativeEnsureImageArgs(image, policy),
          ...nativeImagePolicyArgs(),
        ],
        timeoutMs: NATIVE_IMAGE_ENSURE_TIMEOUT_MS,
      })
      .catch((error: unknown) => {
        if (
          error instanceof NativeRuntimeRequestError &&
          error.nativeCode === "registry_image_not_found"
        ) {
          const label = SERVICE_NAME.test(name)
            ? `service ${name}`
            : "a service";
          throw new ClosedCliError(
            `Native image acquisition failed for ${label} field image (registry_image_not_found); the selected registry image or tag was not found. Values omitted.`
          );
        }
        throw error;
      });
    if (
      !isRecord(ensured) ||
      typeof ensured.image_id !== "string" ||
      !IMAGE.test(ensured.image_id) ||
      !ensuredPlatformAccepted(ensured.platform, policy)
    ) {
      throw unconfirmed("the runtime image selection");
    }
    spec.image = ensured.image_id;
  }
}
/** Services whose review carries Hack's exact one-shot marker as `one_shot: true`. */
function reviewedOneShots(
  reviewed: Readonly<Record<string, unknown>>
): string[] {
  return Object.entries(reviewed)
    .filter(([, service]) => isRecord(service) && service.one_shot === true)
    .map(([name]) => name);
}

/**
 * Build `--ready` goals for exactly the services the reviewed plan marks active.
 *
 * Compose services outside the selected profiles stay in the normalized specs (they are
 * still reviewed and pinned), but the runtime does not schedule them and refuses readiness
 * goals for inactive or unknown services. Dependency edges declared by inactive services
 * are ignored so they cannot raise an active service's readiness goal. A service the
 * review marks `one_shot` (Hack's exact `hack.service.one-shot: "true"` label) must
 * finish successfully, so its goal is completion, as for dependency cache initializers.
 */
export function nativeReadinessArgs(opts: {
  readonly specs: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly plan: unknown;
  readonly initializers: ReadonlySet<string>;
  readonly routed: ReadonlySet<string>;
}): string[] {
  const reviewed =
    isRecord(opts.plan) && isRecord(opts.plan.services)
      ? opts.plan.services
      : {};
  const active = (name: string): boolean => {
    const service = reviewed[name];
    return isRecord(service) && service.active === true;
  };
  const specs = Object.entries(opts.specs).filter(([name]) => active(name));
  const ready: Record<string, string> = Object.fromEntries(
    specs.map(([name, spec]) => [
      name,
      spec.healthcheck ? "healthy" : "started",
    ])
  );
  for (const [, spec] of specs) {
    if (!isRecord(spec.depends_on)) {
      continue;
    }
    for (const [name, edge] of Object.entries(spec.depends_on)) {
      if (
        isRecord(edge) &&
        edge.condition === "service_completed_successfully"
      ) {
        ready[name] = "completed";
      }
      if (isRecord(edge) && edge.condition === "service_healthy") {
        ready[name] = "healthy";
      }
    }
  }
  for (const name of [...reviewedOneShots(reviewed), ...opts.initializers]) {
    ready[name] = "completed";
  }
  for (const name of opts.routed) {
    ready[name] = "healthy";
  }
  return Object.entries(ready)
    .filter(([name]) => active(name))
    .flatMap(([name, condition]) => ["--ready", `${name}=${condition}`]);
}
function authoritative(
  value: unknown,
  run: string,
  namespace: string,
  planId: string
): NativeProjectRun {
  if (
    !isRecord(value) ||
    value.journal_incomplete !== false ||
    !isRecord(value.receipt)
  ) {
    throw unconfirmed("the startup receipt");
  }
  const receipt = value.receipt;
  if (
    receipt.run !== run ||
    receipt.namespace !== namespace ||
    receipt.plan_id !== planId ||
    typeof receipt.owner !== "string" ||
    !OWNER.test(receipt.owner)
  ) {
    throw unconfirmed("the startup receipt");
  }
  return { run, owner: receipt.owner, namespace, planId };
}
function requireEnrollmentCompatible(plan: unknown): void {
  if (!isRecord(plan) || plan.enrollment_compatible !== true) {
    throw refused();
  }
}
const HTTPS_REDIRECTS = new Set([301, 302, 303, 307, 308]);
type HttpsRoute = ReturnType<typeof reviewedNativeHttpsRoutes>[number];
function httpsResponseReady(
  route: HttpsRoute,
  response: { statusCode: number; upstreamVerified?: true }
): boolean {
  if (route.inferred && response.upstreamVerified !== true) {
    throw httpsVerificationFailed("UPSTREAM_RESPONSE_UNCONFIRMED");
  }
  return (
    response.statusCode >= 200 &&
    response.statusCode < (route.inferred ? 500 : 300)
  );
}
function redirectHostname(
  location: string,
  hostname: string,
  port: number,
  route: HttpsRoute,
  routes: readonly HttpsRoute[]
): string {
  let target: URL;
  try {
    target = new URL(location, `https://${hostname}:${port}${route.path}`);
  } catch {
    throw httpsVerificationFailed("REDIRECT_TARGET_REFUSED");
  }
  const reviewed = routes.find((entry) => entry.hostname === target.hostname);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    (target.port && target.port !== "443" && target.port !== String(port)) ||
    !reviewed ||
    reviewed.service !== route.service ||
    reviewed.path !== route.path ||
    target.pathname !== route.path
  ) {
    throw httpsVerificationFailed("REDIRECT_TARGET_REFUSED");
  }
  return target.hostname;
}
export async function verifyHttpsRoutes(
  frontend:
    | Pick<
        Awaited<ReturnType<typeof acquireNativeHttpsLease>>,
        "httpsPort" | "verifyHostname"
      >
    | undefined,
  plan: unknown,
  services: ReadonlySet<string>
): Promise<void> {
  if (!frontend) {
    return;
  }
  const routes = reviewedNativeHttpsRoutes(plan, services);
  const results = new Map<
    string,
    Awaited<ReturnType<typeof frontend.verifyHostname>>
  >();
  for (const route of routes) {
    results.set(
      route.hostname,
      await frontend.verifyHostname(route.hostname, route.path)
    );
  }
  for (const route of routes) {
    const visited = new Set<string>();
    let hostname = route.hostname;
    while (true) {
      if (visited.has(hostname)) {
        throw httpsVerificationFailed("REDIRECT_CYCLE");
      }
      visited.add(hostname);
      const response = results.get(hostname);
      if (!(response && Number.isInteger(response.statusCode))) {
        throw httpsVerificationFailed("NO_RESPONSE");
      }
      if (httpsResponseReady(route, response)) {
        break;
      }
      if (!(HTTPS_REDIRECTS.has(response.statusCode) && response.location)) {
        throw httpsVerificationFailed(`HTTP_STATUS_${response.statusCode}`);
      }
      hostname = redirectHostname(
        response.location,
        hostname,
        frontend.httpsPort,
        route,
        routes
      );
    }
  }
}

const PRINTABLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PRINTABLE_HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
/**
 * What a ready foreground graph serves on this host, from the reviewed plan
 * only: each routed service's reviewed hostnames as HTTPS URLs when the
 * native HTTPS frontend runs (with its port unless 443), and the published
 * loopback ports. Names that fail their closed patterns are skipped.
 */
export function nativeReadySummary(opts: {
  readonly plan: unknown;
  readonly routed: ReadonlySet<string>;
  readonly httpsPort: number | null;
}): string[] {
  const lines: string[] = [];
  const services =
    isRecord(opts.plan) && isRecord(opts.plan.services)
      ? opts.plan.services
      : {};
  const suffix =
    opts.httpsPort === null || opts.httpsPort === 443
      ? ""
      : `:${opts.httpsPort}`;
  let unserved = false;
  for (const name of [...opts.routed].sort()) {
    const service = services[name];
    const hostnames =
      isRecord(service) &&
      isRecord(service.routing) &&
      Array.isArray(service.routing.hostnames)
        ? service.routing.hostnames.filter(
            (host): host is string =>
              typeof host === "string" && PRINTABLE_HOST.test(host)
          )
        : [];
    if (!PRINTABLE_NAME.test(name) || hostnames.length === 0) {
      continue;
    }
    if (opts.httpsPort === null) {
      unserved = true;
      continue;
    }
    lines.push(
      `  ${name}: ${hostnames.map((host) => `https://${host}${suffix}`).join(" ")}`
    );
  }
  if (unserved) {
    lines.push(
      "  Routes are not served on this host: the native HTTPS frontend is not selected (HACK_NATIVE_CADDY_BINARY, HACK_NATIVE_CADDY_SHA256 and HACK_NATIVE_HTTPS_PORT)."
    );
  }
  const ports = reviewedNativeLoopbackPorts(opts.plan);
  if (ports.length > 0) {
    lines.push(
      `  Published ports: ${ports.map((port) => `127.0.0.1:${port}`).join(" ")}`
    );
  }
  return lines;
}
/** One confirmed-stop line for an interrupted ready graph, from its final receipt. */
export function nativeStoppedNotice(final: unknown): string {
  const removed =
    isRecord(final) &&
    isRecord(final.receipt) &&
    final.receipt.phase === "removed";
  return removed
    ? "Native project stopped; owned cleanup confirmed and no runtime data was retained."
    : "Native project stopped; owned cleanup confirmed. Named volumes and the stopped run mapping are kept for the next hack up.";
}
function foregroundExitCode(opts: {
  aborted: boolean;
  interruptedExit: number;
  failure: unknown;
  infrastructureFailure?: Error;
  code: number;
}): number {
  if (opts.infrastructureFailure) {
    throw opts.infrastructureFailure;
  }
  if (opts.aborted) {
    return opts.interruptedExit;
  }
  if (opts.failure) {
    throw opts.failure;
  }
  return opts.code;
}
/**
 * Credential adapters run after lifecycle hooks so a login hook can refresh
 * host credentials first. Returns the same input object when none is selected.
 * AWS values are a startup snapshot, so expiry warnings are scheduled; the
 * caller cancels them when the foreground exits.
 */
async function adaptNativeCredentials(opts: {
  readonly input: NativeProjectInput;
  readonly selection: {
    readonly aws?: { readonly profile: string; readonly region?: string };
    readonly gcloud?: NativeGcloudSelection;
  };
  readonly deps: Pick<Dependencies, "adaptAws" | "adaptGcloud" | "warn">;
}): Promise<{
  readonly input: NativeProjectInput;
  readonly cancelExpiry?: () => void;
}> {
  let { input } = opts;
  let cancelExpiry: (() => void) | undefined;
  if (opts.selection.aws) {
    const adapted = await opts.deps.adaptAws({
      input,
      ...opts.selection.aws,
    });
    input = adapted.input;
    cancelExpiry = scheduleNativeAwsExpiryWarnings({
      expiry: adapted.receipt.expiry,
      services: adapted.receipt.services.length,
      write: opts.deps.warn,
    });
  }
  if (opts.selection.gcloud) {
    try {
      input = (
        await opts.deps.adaptGcloud({
          input,
          mode: opts.selection.gcloud.mode,
        })
      ).input;
    } catch (error) {
      cancelExpiry?.();
      throw error;
    }
  }
  return { input, ...(cancelExpiry ? { cancelExpiry } : {}) };
}

/**
 * Private envelope for `graph serve --environment-stdin`. Version 1 carries values
 * only; version 2 adds service-scoped file members and is sent only when files
 * exist, so a runtime without file support refuses instead of dropping them.
 *
 * Adapters normalize every authored service, including those outside the selected
 * profiles, so public Compose stays identical across profile selections. File
 * members are delivered only for services the reviewed plan marks active: the
 * runtime refuses file ownership for inactive services, so an optional disabled
 * service must not block the selected graph.
 */
export function nativeEnvironmentDelivery(opts: {
  readonly input: NativeProjectInput;
  readonly planId: string;
  readonly reviewedPlan: unknown;
  readonly run: string;
}): { flags: string[]; payload?: Buffer } {
  const { input, planId: plan, run } = opts;
  const reviewed =
    isRecord(opts.reviewedPlan) && isRecord(opts.reviewedPlan.services)
      ? opts.reviewedPlan.services
      : {};
  const files = Object.entries(input.managedFiles ?? {}).filter(
    ([service, members]) => {
      const reviewedService = reviewed[service];
      return (
        members.length > 0 &&
        isRecord(reviewedService) &&
        reviewedService.active === true
      );
    }
  );
  if (
    Object.keys(input.managedEnvironment).length === 0 &&
    files.length === 0
  ) {
    return { flags: [] };
  }
  return {
    flags: ["--environment-stdin"],
    payload: nativePrivateEnvironmentPayload({
      services: input.managedEnvironment,
      files: Object.fromEntries(files),
      planId: plan,
      run,
    }),
  };
}
/**
 * Append the redacted output of failed services to the final startup failure
 * report. Applied after diagnostics that parse the original closed message; the
 * error keeps its class so recovery handling is unchanged.
 */
function withStartupLogReport(error: unknown, report: string): unknown {
  if (report !== "" && error instanceof Error) {
    error.message = `${error.message}\n${report}`;
  }
  return error;
}
const SAFE_STARTUP_DIAGNOSTIC =
  /^(Native (?:graph startup (?:failed|was interrupted or failed)|HTTPS verification failed)) \(([A-Za-z0-9_]{1,80})\); (?:inspect owned state before retrying\.|peer values omitted\.)( Service [A-Za-z0-9_.-]{1,128}: [\x20-\x7e]{1,400}| Runtime: [\x20-\x7e]{1,400}| Service: [A-Za-z0-9_.-]{1,128}\.)?$/;
/**
 * Preserve only the fixed diagnostic envelope emitted by the native clients,
 * including the value-free runtime note they append (see `nativeFailureNote`).
 */
function startupDiagnostic(startupFailure: unknown): string {
  if (startupFailure === undefined) {
    return "";
  }
  const message = startupFailure instanceof Error ? startupFailure.message : "";
  const diagnostic = SAFE_STARTUP_DIAGNOSTIC.exec(message);
  if (!diagnostic) {
    return " Startup diagnostic: STARTUP_FAILURE (details omitted).";
  }
  return ` Startup diagnostic: ${diagnostic[1]} (${diagnostic[2]}).${diagnostic[3] ?? ""}`;
}
function cleanupUnconfirmed(
  startupFailure?: unknown,
  nativeCode?: string,
  recordedRun?: string
): Error {
  const recorded =
    recordedRun !== undefined && RUN.test(recordedRun)
      ? ` The failed run ${recordedRun} is recorded as this project's run mapping.`
      : "";
  return retainNativeRuntimeFailure({
    error: new ClosedCliError(
      `Native foreground exit cleanup is unconfirmed; runtime and bridge state may be retained. Run hack down --recover to resume this run's confirmed cleanup with data retained.${startupDiagnostic(startupFailure)}${nativeCode ? ` Native exit diagnostic: ${nativeCode}.` : ""}${recorded}`
    ),
    original: startupFailure,
  });
}
/** Runtime process-wrapper refusals: service names and closed fields only. */
function refusedProcesses(
  refusals: readonly NativeProcessRefusal[] | undefined
): string {
  return refusals && refusals.length > 0
    ? ` Native cannot wrap these services' processes: ${describeNativeProcessRefusals(refusals)}.`
    : "";
}
/**
 * A fresh startup whose graph owner exited before reserving any runtime state.
 * `graph inspect` refuses `graph_unreserved` only when the run's journals are
 * exactly absent and no foreground owner is published; deps.serve settles only
 * after the owned child exited, so nothing can still reserve state.
 */
const GRAPH_UNRESERVED = "graph_unreserved";
/**
 * The report when final inspection of a settled startup fails. For a fresh run
 * that failed, never attempted a mapping and whose inspection reports
 * {@link GRAPH_UNRESERVED}, nothing was created: report the startup failure
 * itself (with its runtime reason) and mark graph cleanup confirmed. Every
 * other case keeps the unconfirmed-cleanup report.
 */
function finalInspectionFailure(opts: {
  readonly serveFailure: unknown;
  readonly inspectionFailure: unknown;
  readonly restored: boolean;
  readonly mappingAttempted: boolean;
  readonly nativeCode: string | undefined;
  readonly processRefusals?: readonly NativeProcessRefusal[];
}): { readonly error: Error; readonly nothingReserved: boolean } {
  if (
    opts.serveFailure === undefined ||
    opts.restored ||
    opts.mappingAttempted ||
    !(opts.inspectionFailure instanceof NativeRuntimeRequestError) ||
    opts.inspectionFailure.nativeCode !== GRAPH_UNRESERVED
  ) {
    return {
      error: cleanupUnconfirmed(
        opts.serveFailure ?? opts.inspectionFailure,
        opts.nativeCode
      ),
      nothingReserved: false,
    };
  }
  return {
    error: retainNativeRuntimeFailure({
      error: new ClosedCliError(
        `Native graph startup failed before any runtime state was reserved; nothing was created and no cleanup is needed.${startupDiagnostic(opts.serveFailure)}${refusedProcesses(opts.processRefusals)}`
      ),
      original: opts.serveFailure,
    }),
    nothingReserved: true,
  };
}
/** The ready line's event: run id and what the ready graph serves on this host. */
function readyProgress(opts: {
  readonly services: readonly string[];
  readonly run: string;
  readonly plan: unknown;
  readonly routed: ReadonlySet<string>;
  readonly httpsPort: number | null;
}): NativeStartupProgress {
  return {
    phase: "ready",
    services: opts.services,
    run: RUN.test(opts.run) ? opts.run : "unknown",
    endpoints: nativeReadySummary(opts),
  };
}

/** Ready completion goals have succeeded; keep jobs separate in lifecycle JSON. */
function readyServiceSummary(readinessArgs: readonly string[]): {
  readonly started: readonly string[];
  readonly completed: readonly string[];
} {
  const goals = readinessArgs.filter((arg) => arg !== "--ready");
  const name = (goal: string) => goal.slice(0, goal.lastIndexOf("="));
  return {
    started: goals.filter((goal) => !goal.endsWith("=completed")).map(name),
    completed: goals.filter((goal) => goal.endsWith("=completed")).map(name),
  };
}
/** The HTTPS port routes are served on: only while the frontend lease runs. */
function servedHttpsPort(
  lease: unknown,
  selection: NativeHttpsSelection | undefined
): number | null {
  return lease === undefined ? null : (selection?.httpsPort ?? null);
}
function requireConfirmedCleanup(
  final: unknown,
  startupFailure?: unknown,
  nativeCode?: string
): void {
  if (
    !(
      isRecord(final) &&
      isRecord(final.receipt) &&
      ["stopped-data-retained", "removed"].includes(
        String(final.receipt.phase)
      ) &&
      isRecord(final.observations)
    ) ||
    Object.entries(final.observations).some(
      ([key, value]) =>
        key.startsWith("container:") &&
        (!isRecord(value) || value.state !== "absent")
    )
  ) {
    throw cleanupUnconfirmed(startupFailure, nativeCode);
  }
}

async function confirmForegroundCleanup(opts: {
  readonly final: unknown;
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: string;
  readonly namespace: string;
  readonly planId: string;
  readonly invoke: typeof invokeNativeRuntime;
  readonly startupFailure: unknown;
  readonly nativeCode: string | undefined;
}): Promise<{ final: unknown; owned: NativeProjectRun }> {
  let final = opts.final;
  let owned = authoritative(final, opts.run, opts.namespace, opts.planId);
  try {
    const recovered = await recoverNativeInterruptedStartupCleanup({
      runtime: opts.runtime,
      projectRoot: opts.projectRoot,
      run: owned,
      snapshot: final,
      invoke: opts.invoke,
    });
    if (recovered !== null) {
      final = recovered;
      owned = authoritative(final, opts.run, opts.namespace, opts.planId);
    }
  } catch (error) {
    if (error instanceof NativePartialShutdownError) {
      throw error;
    }
    throw cleanupUnconfirmed(opts.startupFailure, opts.nativeCode);
  }
  requireConfirmedCleanup(final, opts.startupFailure, opts.nativeCode);
  return { final, owned };
}

/**
 * HACK-1917: a fresh startup that failed after the graph started resources, and
 * whose cleanup this frontend cannot confirm, must not leave them without a
 * project owner. Publish the authenticated receipt identity as the project's
 * run mapping, with a frontend finalization lifetime exactly as readiness
 * publishes one, so ps, down and `doctor --native-cleanup inspect` select the
 * retained run instead of reporting the project as not started. Nothing is
 * stopped or replayed here. A receipt that cannot be authenticated, an existing
 * or retained mapping, or any refusal records nothing and keeps the original
 * failure; the runtime journal still holds the graph for explicit recovery.
 */
async function recordFailedStartupOwner(opts: {
  readonly final: unknown;
  readonly run: string;
  readonly namespace: string;
  readonly planId: string;
  readonly scope: NativeProjectRunScope;
  readonly selection: Omit<Parameters<typeof selectedMapping>[0], "ready">;
  readonly finalization:
    | Awaited<ReturnType<typeof beginNativeProjectFinalization>>
    | undefined;
  readonly deps: Pick<Dependencies, "finalization" | "save">;
}): Promise<
  | {
      readonly mapping: NativeProjectRun;
      readonly finalization: Awaited<
        ReturnType<typeof beginNativeProjectFinalization>
      >;
    }
  | undefined
> {
  let owned: NativeProjectRun;
  try {
    owned = authoritative(opts.final, opts.run, opts.namespace, opts.planId);
  } catch {
    return undefined;
  }
  const mapping = selectedMapping({ ...opts.selection, ready: owned });
  try {
    const finalization =
      opts.finalization ??
      (await opts.deps.finalization({
        scope: opts.scope,
        run: mapping,
        httpsPort: null,
      }));
    await opts.deps.save({ ...opts.scope, run: mapping });
    return { mapping, finalization };
  } catch {
    return undefined;
  }
}

type FailedStartupOwner = NonNullable<
  Awaited<ReturnType<typeof recordFailedStartupOwner>>
>;
/** Confirm foreground cleanup; when it is unconfirmed, record an unowned fresh run. */
async function confirmCleanupOrRecordOwner(opts: {
  readonly confirm: Parameters<typeof confirmForegroundCleanup>[0];
  /** A published or retained mapping already owns the run; nothing is recorded. */
  readonly existing: NativeProjectRun | undefined;
  readonly scope: NativeProjectRunScope;
  readonly selection: Parameters<
    typeof recordFailedStartupOwner
  >[0]["selection"];
  readonly finalization: Parameters<
    typeof recordFailedStartupOwner
  >[0]["finalization"];
  readonly deps: Pick<Dependencies, "finalization" | "save">;
  readonly onRecorded: (recorded: FailedStartupOwner) => void;
}): Promise<Awaited<ReturnType<typeof confirmForegroundCleanup>>> {
  try {
    return await confirmForegroundCleanup(opts.confirm);
  } catch (cleanupFailure) {
    const recorded = opts.existing
      ? undefined
      : await recordFailedStartupOwner({
          final: opts.confirm.final,
          run: opts.confirm.run,
          namespace: opts.confirm.namespace,
          planId: opts.confirm.planId,
          scope: opts.scope,
          selection: opts.selection,
          finalization: opts.finalization,
          deps: opts.deps,
        });
    if (!recorded) {
      throw cleanupFailure;
    }
    opts.onRecorded(recorded);
    throw cleanupFailure instanceof NativePartialShutdownError
      ? cleanupFailure
      : cleanupUnconfirmed(
          opts.confirm.startupFailure,
          opts.confirm.nativeCode,
          opts.confirm.run
        );
  }
}

/**
 * HACK-1952: admit a retained startup in its native home before its last mapping
 * check, so another home's release of the mapping either finished first (the check
 * refuses) or sees this admission and refuses. The caller retires it once it
 * registers its own frontend lifetime; it is retired here if startup ends before any
 * runtime effect.
 */
async function admitRetainedStartup(opts: {
  readonly retained: NativeProjectRun | null;
  readonly scope: NativeProjectRunScope;
  readonly deps: Pick<Dependencies, "admitFinalization" | "load">;
  readonly signal: AbortSignal;
}): Promise<{ readonly retire: () => Promise<void> } | undefined> {
  const admission = opts.retained
    ? await opts.deps.admitFinalization({
        scope: opts.scope,
        run: opts.retained,
      })
    : undefined;
  try {
    await verifyNativeRetainedMapping({
      run: opts.retained,
      scope: opts.scope,
      load: opts.deps.load,
    });
    requireActiveStartup(opts.signal);
  } catch (error) {
    await admission?.retire();
    throw error;
  }
  return admission;
}
async function refusePendingFreshStart(
  restore: NativeProjectRun | undefined,
  scope: NativeProjectRunScope,
  load: typeof loadNativeRestartIntent
): Promise<void> {
  if (!restore && (await load(scope))) {
    throw new ClosedCliError(
      "Native project has a pending restart; use hack restart to resume retained data."
    );
  }
}
function retainedStartupSelection(opts: {
  readonly run: NativeProjectRun;
  readonly envName?: string | null;
  readonly profiles?: readonly string[];
  readonly aws?: { readonly profile: string; readonly region?: string };
  readonly gcloud?: NativeGcloudSelection;
}) {
  const { run } = opts;
  if (
    run.effectiveEnvName === undefined ||
    run.profiles === undefined ||
    run.aws === undefined ||
    (opts.envName !== undefined && opts.envName !== run.effectiveEnvName) ||
    (opts.profiles !== undefined &&
      JSON.stringify(normalizeNativeProfiles(opts.profiles)) !==
        JSON.stringify(run.profiles)) ||
    (opts.aws !== undefined &&
      (opts.aws.profile !== run.aws?.profile ||
        opts.aws.region !== run.aws?.region)) ||
    // Like the AWS selector, an omitted gcloud selection keeps the retained one
    // (which delivers a fresh file); a different explicit selection refuses.
    (opts.gcloud !== undefined && opts.gcloud.mode !== run.gcloud?.mode)
  ) {
    throw new ClosedCliError(
      "Native up cannot change the retained run's environment, profiles, AWS profile or gcloud selection; data was not replaced."
    );
  }
  return {
    envName: run.effectiveEnvName,
    profiles: run.profiles,
    aws: run.aws ?? undefined,
    gcloud: run.gcloud ?? undefined,
  };
}
async function selectNativeStartup(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly restore?: NativeProjectRun;
  readonly envName?: string | null;
  readonly profiles?: readonly string[];
  readonly requestedProfiles: readonly string[];
  readonly aws?: { readonly profile: string; readonly region?: string };
  readonly gcloud?: NativeGcloudSelection;
  readonly load: typeof loadNativeProjectRun;
  readonly invoke: typeof invokeNativeRuntime;
  readonly signal?: AbortSignal;
}) {
  const retained = await opts.load(opts.scope);
  const selection =
    retained && !opts.restore
      ? retainedStartupSelection({
          run: retained,
          envName: opts.envName,
          profiles: opts.profiles,
          aws: opts.aws,
          gcloud: opts.gcloud,
        })
      : {
          envName: opts.envName,
          profiles: opts.requestedProfiles,
          aws: opts.aws,
          gcloud: opts.gcloud,
        };
  let retainedFlags: string[] = [];
  if (retained) {
    if (
      opts.restore &&
      JSON.stringify(opts.restore) !== JSON.stringify(retained)
    ) {
      throw new ClosedCliError(
        "Native retained run mapping changed before restore."
      );
    }
    const preflight = await preflightNativeRetainedStartup({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      run: retained,
      invoke: opts.invoke,
      signal: opts.signal,
    });
    retainedFlags = preflight.flags;
    const observed =
      preflight.runtimePhase === "running"
        ? await inspectNativeProjectGraph({
            runtime: opts.runtime,
            projectRoot: opts.scope.projectRoot,
            run: retained.run,
            invoke: opts.invoke,
          })
        : undefined;
    if (
      preflight.runtimePhase === "running" &&
      !confirmedNativeRetainedGraph(observed, retained)
    ) {
      throw new ClosedCliError(
        "Native project already has an owned run mapping that is not safely stopped; inspect it before starting another run."
      );
    }
  }
  const restore = opts.restore ?? retained ?? undefined;
  return { retained, restore, selection, retainedFlags };
}
/**
 * Before any hook, refuse a retained run whose recorded env selection changed: its
 * env must resolve the same, and it keeps the managed env files it started with. Only
 * a run recorded as started without them may still find none, and a retained run never
 * becomes unmanaged or base-only after the fact. A legacy restore without a recorded
 * selection keeps its earlier behavior. Returns the environment markers the new mapping
 * records: a fresh run's from its files, a retained run's unchanged.
 */
function requireRetainedEnvironment(opts: {
  /** The retained env a resumed (not restored) run must still resolve to. */
  readonly retainedSelection: string | null | undefined;
  readonly restore: NativeProjectRun | undefined;
  readonly input: NativeProjectInput;
  readonly scope: NativeProjectRunScope;
}): NativeRunEnvironmentMarkers {
  const { restore, input } = opts;
  const change =
    restore &&
    nativeRunEnvironmentChange({
      run: restore,
      environmentFiles: input.environmentFiles,
      projectRoot: opts.scope.projectRoot,
      projectDir: opts.scope.projectDir,
    });
  if (change) {
    throw new ClosedCliError(
      `Native up refused: ${describeNativeRunEnvironmentChange(change)}. ${nativeRunEnvironmentRemedy({ change, retry: "hack up" })}; retained data was not replaced.`
    );
  }
  if (
    (opts.retainedSelection !== undefined &&
      input.effectiveEnvName !== opts.retainedSelection) ||
    (restore?.effectiveEnvName !== undefined &&
      !nativeRunEnvironmentAvailable({
        run: restore,
        environmentFiles: input.environmentFiles,
      }))
  ) {
    throw new ClosedCliError(
      "Native retained environment selection changed; data was not replaced."
    );
  }
  if (restore === undefined) {
    return nativeRunEnvironmentMarkers({
      effectiveEnvName: input.effectiveEnvName,
      environmentFiles: input.environmentFiles,
    });
  }
  return {
    ...(restore.unmanagedEnvironment === true
      ? { unmanagedEnvironment: true as const }
      : {}),
    ...(restore.baseOnlyEnvironment === true
      ? { baseOnlyEnvironment: true as const }
      : {}),
  };
}
function selectedMapping(opts: {
  readonly ready: NativeProjectRun;
  readonly effectiveEnvName: string | null;
  readonly profiles: readonly string[];
  readonly aws?: { readonly profile: string; readonly region?: string };
  readonly gcloud?: NativeGcloudSelection;
  readonly runtimeMetadata: boolean;
  /** Which managed env files startup found; see {@link nativeRunEnvironmentMarkers}. */
  readonly environmentMarkers: NativeRunEnvironmentMarkers;
}): NativeProjectRun {
  return {
    ...opts.ready,
    effectiveEnvName: opts.effectiveEnvName,
    profiles: opts.profiles,
    aws: opts.aws
      ? {
          profile: opts.aws.profile,
          ...(opts.aws.region ? { region: opts.aws.region } : {}),
        }
      : null,
    // Written only when selected, so mappings without it stay readable by
    // earlier candidates; a mapping that carries it refuses there.
    ...(opts.gcloud ? { gcloud: { mode: opts.gcloud.mode } } : {}),
    ...(opts.runtimeMetadata ? { runtimeMetadata: true as const } : {}),
    // Only a named env needs the distinction; a base selection delivers base values.
    ...(opts.effectiveEnvName === null ? {} : opts.environmentMarkers),
  };
}
/**
 * Fresh graphs receive runtime host metadata when the caller selects it. A
 * retained graph is restored exactly as admitted: only graphs that recorded
 * metadata get it again, so legacy retained data stays restorable.
 */
export function nativeRuntimeMetadataSelected(opts: {
  readonly selection?: NativeRuntimeMetadataSelection;
  readonly restore?: NativeProjectRun;
}): NativeRuntimeMetadataSelection | undefined {
  if (opts.restore && opts.restore.runtimeMetadata !== true) {
    return undefined;
  }
  if (opts.restore && !opts.selection) {
    throw new ClosedCliError(
      "Native retained graph requires its runtime metadata selection; no hooks, runtime start or HTTPS owner were requested."
    );
  }
  return opts.selection;
}
async function retireRemovedMapping(opts: {
  readonly final: unknown;
  readonly mapping: NativeProjectRun | undefined;
  readonly owned: NativeProjectRun;
  readonly scope: NativeProjectRunScope;
  readonly remove: typeof removeNativeProjectRun;
}): Promise<void> {
  if (!opts.mapping) {
    return;
  }
  if (opts.mapping.owner !== opts.owned.owner) {
    throw new ClosedCliError(
      "Native run mapping is owned by another run; it was not removed. Inspect owned state before retrying."
    );
  }
  if (
    isRecord(opts.final) &&
    isRecord(opts.final.receipt) &&
    opts.final.receipt.phase === "removed"
  ) {
    await opts.remove({ ...opts.scope, expected: opts.mapping });
  }
}
function httpsCleanupFailure(acquisition: unknown, cleanup: unknown): unknown {
  if (
    acquisition instanceof NativeHttpsLeaseAcquisitionError &&
    acquisition !== cleanup
  ) {
    return new NativeHttpsLeaseAcquisitionError(acquisition.identity, {
      startupFailure: acquisition.startupFailure,
      cleanupUnconfirmed: true,
    });
  }
  return cleanup;
}
async function acknowledgeFinalization(
  finalization:
    | Awaited<ReturnType<typeof beginNativeProjectFinalization>>
    | undefined,
  graph: boolean,
  https: boolean
): Promise<void> {
  if (graph && https) {
    await finalization?.complete();
  }
}
async function requireAcknowledgedRetainedFinalization(opts: {
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
  readonly capture: typeof captureNativeProjectFinalization;
  readonly wait: typeof waitNativeProjectFinalization;
}): Promise<void> {
  try {
    const token = await opts.capture({ scope: opts.scope, run: opts.run });
    await opts.wait({
      scope: opts.scope,
      run: opts.run,
      token,
      timeoutMs: 1,
    });
  } catch {
    throw new ClosedCliError(
      "Native retained frontend finalization is unconfirmed or its ownership changed; no hooks, runtime start or HTTPS owner were requested."
    );
  }
}
/** Explicit unfiltered project sharing; foreground only. Native refusal never falls back to Compose. */
/**
 * Value-free foreground progress for the terminal. `services` are the reviewed
 * service names. Observation only: a throwing observer never changes startup.
 */
export type NativeStartupProgress =
  | {
      readonly phase:
        | "input"
        | "runtime"
        | "images"
        | "all-stopped"
        | "stopping";
    }
  | {
      readonly phase: "stopped";
      /** The confirmed-stop retention line when a run mapping was published. */
      readonly summary?: string;
    }
  | {
      readonly phase: "services";
      readonly services: readonly string[];
    }
  | ({ readonly phase: "dependency-wait" } & NativeDependencyWaitProgress)
  | {
      readonly phase: "ready";
      readonly services: readonly string[];
      /** The run id, or `unknown` when it fails the run-id pattern. */
      readonly run: string;
      /** Indented route, unserved-route and published-port lines. */
      readonly endpoints: readonly string[];
    }
  | ({ readonly phase: "service-exited" } & NativeServiceExit);

function progressReporter(
  observe: ((event: NativeStartupProgress) => void) | undefined
): (event: NativeStartupProgress) => void {
  return (event) => {
    try {
      observe?.(event);
    } catch {
      // Progress is advisory terminal output.
    }
  };
}

/**
 * Watch a ready foreground graph for stopped services, as attached Compose `up`
 * does. When every service has stopped, `up` ends like Compose: request the
 * ordinary owned stop and exit 0. Returns the monitor's stop function.
 */
function watchServiceExits(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly run: string;
  readonly intervalMs: number;
  readonly invoke: typeof invokeNativeRuntime;
  readonly progress: (event: NativeStartupProgress) => void;
  readonly onAllStopped: () => void;
}): () => Promise<void> {
  const controller = new AbortController();
  const monitoring = monitorNativeServiceExits({
    ...opts,
    signal: controller.signal,
    onExit: (exit) => opts.progress({ phase: "service-exited", ...exit }),
    onAllStopped: () => {
      opts.progress({ phase: "all-stopped" });
      opts.onAllStopped();
    },
  }).catch(() => undefined);
  return async () => {
    controller.abort();
    await monitoring;
  };
}

/** After confirmed cleanup, an interrupted foreground graph has stopped. */
function reportStopped(opts: {
  readonly progress: (event: NativeStartupProgress) => void;
  readonly signal: AbortSignal;
  readonly infrastructureFailure: Error | undefined;
  /** Whether this run's mapping was published; only then is retention reported. */
  readonly published: boolean;
  readonly final: unknown;
}): void {
  if ((opts.signal.aborted || opts.published) && !opts.infrastructureFailure) {
    opts.progress(
      opts.published
        ? { phase: "stopped", summary: nativeStoppedNotice(opts.final) }
        : { phase: "stopped" }
    );
  }
}

type NativeProjectStartOptions = {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly composeFile: string;
  readonly envName?: string | null;
  readonly profiles?: readonly string[];
  readonly sharedSource: boolean;
  readonly restore?: NativeProjectRun;
  readonly onReady?: (services: {
    readonly started: readonly string[];
    readonly completed: readonly string[];
  }) => void | Promise<void>;
  readonly dependencyFile?: string;
  /** Per-env dependency files; the entry for the run's effective env replaces `dependencyFile`. */
  readonly dependencyFileByEnv?: Readonly<Record<string, string>>;
  /**
   * Resolves `host_lifecycle` / `host_shared_helper` owners after lifecycle
   * hooks; without it such selections refuse.
   */
  readonly dependencyOwners?: NativeDependencyOwnerResolver;
  readonly adaptationFile?: string;
  /** Per-env adaptations; the entry for the run's effective env replaces `adaptationFile`. */
  readonly adaptationFileByEnv?: Readonly<Record<string, string>>;
  /**
   * Effective project-wide host aliases (`internal.extra_hosts` and
   * checkout-local entries). Declared on every service like the Compose
   * override; each active pair then requires a reviewed dependency binding.
   */
  readonly internalExtraHosts?: Readonly<Record<string, string>>;
  /** Where each project-wide alias comes from, for refusal text only. */
  readonly internalExtraHostSources?: Readonly<
    Record<string, NativeHostAliasSource>
  >;
  readonly allowedHosts?: readonly string[];
  readonly preparedBase?: NativePreparedBase;
  readonly https?: NativeHttpsSelection;
  readonly aws?: { readonly profile: string; readonly region?: string };
  /** Explicit gcloud Application Default Credentials adapter selection. */
  readonly gcloud?: NativeGcloudSelection;
  /** Public instance identity delivered as runtime host metadata; omitted delivers none. */
  readonly runtimeMetadata?: NativeRuntimeMetadataSelection;
  readonly before: (input: NativeProjectInput) => Promise<Hooks>;
  /**
   * Advisory stale-env bookkeeping (HACK-1140): after the run mapping is
   * published, receives the run id and value-free digests of the env
   * selection resolved for delivery, before adaptation, AWS or runtime
   * metadata. `hack exec` resolves the same selection again to compare. A
   * failure here never fails startup.
   */
  readonly onEnvironmentReady?: (selection: {
    readonly run: string;
    readonly fingerprint: ComposeEnvFingerprintRecord;
  }) => Promise<void>;
  readonly signal?: AbortSignal;
  /** A second stop request: cancels a running down hook and forces cleanup. */
  readonly forceSignal?: AbortSignal;
  /**
   * Called once this start's own SIGINT/SIGTERM handling is installed, before any
   * hook, runtime start or service. A caller that handled stop requests until
   * now (such as `hack restart`) removes its handlers here; `signal` still
   * carries a request that arrived earlier.
   */
  readonly onStopSignals?: () => void;
  /** Foreground progress and the ready line; see {@link NativeStartupProgress}. */
  readonly onProgress?: (event: NativeStartupProgress) => void;
  readonly dependencies?: Partial<Dependencies>;
};

async function startNativeProjectAttempt(
  opts: NativeProjectStartOptions,
  observeStartup: () => Promise<void>
): Promise<number> {
  const progress = progressReporter(opts.onProgress);
  const requestedProfiles = normalizeNativeProfiles(opts.profiles);
  requireActiveStartup(opts.signal);
  const allowedHosts = validateNativeAllowedHosts(opts.allowedHosts);
  validateHttpsSelection(opts.https);
  if (!opts.sharedSource) {
    throw new HackCliError({
      code: "E_PERMISSION",
      message: NATIVE_SHARED_SOURCE_REFUSAL,
    });
  }
  const deps = { ...DEFAULTS, ...opts.dependencies };
  await refusePendingFreshStart(opts.restore, opts.scope, deps.loadRestart);
  const { retained, restore, selection, retainedFlags } =
    await selectNativeStartup({
      runtime: opts.runtime,
      scope: opts.scope,
      restore: opts.restore,
      envName: opts.envName,
      profiles: opts.profiles,
      requestedProfiles,
      aws: opts.aws,
      gcloud: opts.gcloud,
      load: deps.load,
      invoke: deps.invoke,
      signal: opts.signal,
    });
  requireActiveStartup(opts.signal);
  const runtimeMetadata = nativeRuntimeMetadataSelected({
    selection: opts.runtimeMetadata,
    restore,
  });
  if (retained) {
    await requireAcknowledgedRetainedFinalization({
      scope: opts.scope,
      run: retained,
      capture: deps.captureFinalization,
      wait: deps.waitFinalization,
    });
    await verifyNativeRetainedMapping({
      scope: opts.scope,
      run: retained,
      load: deps.load,
    });
    requireActiveStartup(opts.signal);
  }
  // A down hook of an earlier generation with unknown completion blocks this
  // one before any hook runs; any other leftover record is superseded.
  await deps.admitDownHooks(opts.scope);
  const profiles = selection.profiles;
  progress({ phase: "input" });
  await preflightNativeProjectSource({
    runtime: opts.runtime,
    projectRoot: opts.scope.projectRoot,
    signal: opts.signal,
    invoke: deps.invoke,
  });
  await deps.prepareStorage(opts.scope);
  await observeStartup();
  let input = await deps.prepare({
    ...opts.scope,
    composeFile: opts.composeFile,
    envName: selection.envName,
    // Service `environment` references are resolved from the caller's shell.
    env: process.env,
  });
  // Digest the selection now: later steps adapt the delivered values.
  const selectedEnvironment = opts.onEnvironmentReady
    ? withComposeServiceEnvFingerprints({
        existing: undefined,
        services: input.serviceNames,
        envByService: input.managedEnvironment,
      })
    : undefined;
  // After the fingerprints: shell values are delivered, never digested to disk.
  input = mergeNativeShellEnvironment(input);
  const environmentMarkers = requireRetainedEnvironment({
    retainedSelection:
      retained && !opts.restore ? selection.envName : undefined,
    restore,
    input,
    scope: opts.scope,
  });
  // The effective env (requested, retained or project default) picks the per-env
  // files, so a fresh start, a retained start and a restart select the same ones.
  const selectedAdaptationFile = selectNativeEnvFile({
    selection: {
      file: opts.adaptationFile,
      fileByEnv: opts.adaptationFileByEnv,
    },
    envName: input.effectiveEnvName,
  });
  const selectedDependencyFile = selectNativeEnvFile({
    selection: {
      file: opts.dependencyFile,
      fileByEnv: opts.dependencyFileByEnv,
    },
    envName: input.effectiveEnvName,
  });
  input = await prepareNativeProjectAdaptation({
    input,
    path: selectedAdaptationFile,
  });
  input = applyNativeInternalHostAliases({
    input,
    hosts: opts.internalExtraHosts,
    sources: opts.internalExtraHostSources,
    hasDependencySelection: opts.dependencyFile !== undefined,
  });
  input = (
    await prepareNativeReviewBranch({
      runtime: opts.runtime,
      scope: opts.scope,
      composeFile: opts.composeFile,
      input,
      retained: restore,
      phase: "before-runtime",
    })
  ).input;
  // Pure build admission before hooks, VM or provider start; refuses when disabled.
  const builds = admitStartBuilds(input, opts);
  const buildServices = new Set(builds.keys());
  let specs = prepareNativeProjectServices(
    input,
    selectedDependencyFile !== undefined,
    buildServices
  );
  await deps.staticReview({
    runtime: opts.runtime,
    projectRoot: opts.scope.projectRoot,
    composeFile: opts.composeFile,
    input,
    profiles,
    branch: opts.scope.branch,
    deferredRestore: restore !== undefined,
    buildServices,
    invoke: deps.invoke,
    signal: opts.signal,
  });
  // A graph that captures source (bind mounts or a dependency cache) measures it
  // before hooks, image work or runtime start, so an oversized project refuses with
  // its size and largest paths. An image-only graph never reads source content.
  await requireCapturedNativeSourceWithinLimit({
    runtime: opts.runtime,
    projectRoot: opts.scope.projectRoot,
    services: specs,
    profiles,
    signal: opts.signal,
    invoke: deps.invoke,
    check: deps.sourceSize,
  });
  // Refuse malformed or unacquirable references before hooks, VM or provider start.
  await admitNativeProjectImages({
    runtime: opts.runtime,
    projectRoot: opts.scope.projectRoot,
    specs,
    signal: opts.signal,
    invoke: deps.invoke,
  });
  requireActiveStartup(opts.signal);
  const bridgeCapacity = nativeBridgeSocketCount({
    routes: nativeBridgeCapacity(specs),
    ports: nativePortPublicationCount(specs),
  });
  const artifact = join(dirname(opts.runtime.binary), "hack-relay-guest");
  const artifactFile = Bun.file(artifact);
  if (
    !(await artifactFile.exists()) ||
    artifactFile.size > 16 * 1024 * 1024 ||
    artifactFile.size === 0
  ) {
    throw new ClosedCliError(
      "Native foreground up requires the bundled hack-relay-guest artifact."
    );
  }
  const artifactHash = createHash("sha256")
    .update(new Uint8Array(await artifactFile.arrayBuffer()))
    .digest("hex");
  const stopSignals = nativeForegroundStopSignals(opts);
  opts.onStopSignals?.();
  const controller = stopSignals.controller;
  controller.signal.addEventListener(
    "abort",
    () => progress({ phase: "stopping" }),
    { once: true }
  );
  let hooks: Hooks | undefined;
  let foregroundStop: NativeForegroundStop | undefined;
  let failed = false;
  // Set before the first service of this run is requested from the runtime.
  let servicesRequested = false;
  let finalization:
    | Awaited<ReturnType<typeof beginNativeProjectFinalization>>
    | undefined;
  let graphCleanupConfirmed = false;
  let httpsCleanupConfirmed = false;
  let httpsAcquisitionFailure: unknown;
  let cancelAwsExpiry: (() => void) | undefined;
  try {
    stopSignals.admitPending();
    requireActiveStartup(controller.signal);
    hooks = await opts.before(input);
    const credentials = await adaptNativeCredentials({
      input,
      selection,
      deps,
    });
    cancelAwsExpiry = credentials.cancelExpiry;
    if (credentials.input !== input) {
      input = credentials.input;
      specs = prepareNativeProjectServices(
        input,
        selectedDependencyFile !== undefined,
        buildServices
      );
    }
    // Every binding's wait (`host_wait_seconds`, default 60 s) is measured
    // from here, the end of the up.before hooks.
    const dependencyDiscoveryStart = performance.now();
    // A discovery stops on cancellation or once another binding's refusal
    // already ends this startup.
    const dependencyWait = (
      target: Parameters<typeof nativeDependencyStartupWait>[0]["target"],
      stopped: AbortSignal
    ) =>
      nativeDependencyStartupWait({
        target,
        startedAtMs: dependencyDiscoveryStart,
        signal: AbortSignal.any([controller.signal, stopped]),
        report: (waiting) => progress({ phase: "dependency-wait", ...waiting }),
      });
    const hostAliases = nativeServiceHostAliases({
      services: specs,
      profiles,
      managedEnvironment: input.managedEnvironment,
    });
    const hostDependencies = await readNativeHostDependencies({
      path: selectedDependencyFile,
      services: Object.keys(specs),
      hostAliases,
      checkPinned: async ({ hostPid, hostPort }) => {
        const result = await deps.invoke({
          runtime: opts.runtime,
          cwd: opts.scope.projectRoot,
          args: [
            "graph",
            "dependency-check",
            "--host-pid",
            String(hostPid),
            "--host-port",
            String(hostPort),
            "--json",
          ],
          timeoutMs: 10_000,
        });
        if (!isRecord(result) || result.listener_confirmed !== true) {
          throw new ClosedCliError(
            "Native listener check was not confirmed; values omitted."
          );
        }
      },
      discover: (selection) =>
        discoverNativeHostDependency({
          runtime: opts.runtime,
          projectRoot: opts.scope.projectRoot,
          hostPort: selection.hostPort,
          executable: selection.executable,
          invoke: deps.invoke,
          wait: dependencyWait(selection, selection.signal),
        }),
      owners: opts.dependencyOwners,
      discoverOwned: (selection) =>
        discoverNativeOwnedHostDependency({
          runtime: opts.runtime,
          projectRoot: opts.scope.projectRoot,
          hostPort: selection.hostPort,
          ancestorPid: selection.ancestorPid,
          invoke: deps.invoke,
          wait: dependencyWait(selection, selection.signal),
        }),
      listenerHooks: hooks.listenerHooks,
    });
    requireActiveStartup(controller.signal);
    requireNativeHostAliasBindings({
      dependencies: hostDependencies,
      hostAliases,
      sources: opts.internalExtraHostSources,
    });
    prepareNativeDependencyServices({
      dependencies: hostDependencies,
      services: specs,
    });
    // Refuse Compose settings no process wrapper can run before the VM starts.
    requireWrappableNativeProcesses({
      services: specs,
      profiles,
      managedEnvironment: input.managedEnvironment,
      managedFiles: input.managedFiles,
      dependencyServices: hostDependencies.map((binding) => binding.service),
    });
    const admission = await admitRetainedStartup({
      retained,
      scope: opts.scope,
      deps,
      signal: controller.signal,
    });
    progress({ phase: "runtime" });
    await deps.invoke({
      runtime: opts.runtime,
      cwd: opts.scope.projectRoot,
      args: [
        "runtime",
        "up",
        "--profile",
        "development",
        "--project-share",
        opts.scope.projectRoot,
        "--unfiltered-source",
        ...retainedFlags,
        ...(hostDependencies.length > 0
          ? [
              "--minimum-dependency-sockets",
              String(
                new Set(hostDependencies.map((binding) => binding.slot)).size
              ),
            ]
          : []),
        ...(bridgeCapacity > 0
          ? ["--minimum-bridge-sockets", String(bridgeCapacity)]
          : []),
        ...(allowedHosts.length > 0
          ? allowedHosts.flatMap((host) => ["--allow-host", host])
          : ["--internet"]),
        ...preparedBaseArguments(opts.preparedBase),
        ...nativeAmd64EmulationUpArgs(input.amd64Emulation),
        "--json",
      ],
      signal: controller.signal,
    });
    requireActiveStartup(controller.signal);
    await verifyNativeResumedRetainedGraph({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      run: retained,
      invoke: deps.invoke,
    });
    const reviewedBranch = await prepareNativeReviewBranch({
      runtime: opts.runtime,
      scope: opts.scope,
      composeFile: opts.composeFile,
      profiles,
      input,
      retained: restore,
      invoke: deps.invoke,
      select: deps.selectReview,
      phase: "after-runtime",
    });
    input = reviewedBranch.input;
    const reviewIdentity = reviewedBranch.identity;
    const metadata = runtimeMetadata
      ? applyNativeRuntimeMetadata({
          input,
          selection: runtimeMetadata,
          branch: reviewIdentity ? reviewIdentity.branch : opts.scope.branch,
          httpsPort: opts.https?.httpsPort ?? null,
        })
      : undefined;
    input = metadata?.input ?? input;
    requireActiveStartup(controller.signal);
    specs = prepareNativeProjectServices(
      input,
      selectedDependencyFile !== undefined,
      buildServices
    );
    prepareNativeDependencyServices({
      dependencies: hostDependencies,
      services: specs,
    });
    const retainedImages = await deps.retainedImages({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      originalSha256: input.originalSha256,
      amd64Emulation: input.amd64Emulation,
      restore,
      invoke: deps.invoke,
    });
    progress({ phase: "images" });
    await buildNativeProjectImages({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      branch: opts.scope.branch,
      profiles,
      builds,
      specs,
      retainedImages,
      restore: Boolean(restore),
      rebuild: nativeRebuildRequested(),
      signal: controller.signal,
      invoke: deps.build,
    });
    await pinNativeProjectImages({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      specs,
      retainedImages,
      amd64Emulation: input.amd64Emulation,
      signal: controller.signal,
      invoke: deps.invoke,
    });
    const compose = JSON.parse(input.normalizedComposeJson);
    compose.services = specs;
    const pinned = { ...input, normalizedComposeJson: JSON.stringify(compose) };
    const expectedMapping = retained ?? undefined;
    return await deps.review({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      composeFile: opts.composeFile,
      profiles,
      branch: opts.scope.branch,
      retained: restore,
      reviewIdentity,
      input: pinned,
      run: async (review) => {
        requireEnrollmentCompatible(review.report.plan);
        reportNativeRestartPolicyNotices(review.report.plan, deps.warn);
        reportNativeIgnoredSettingNotices(review.report.plan, deps.warn);
        reportNativeEnvironmentNotices(input, review.report.plan, deps.warn);
        if (metadata) {
          verifyNativeRuntimeMetadataRoutes({
            plan: review.report.plan,
            routes: metadata.routes,
          });
        }
        const routes = reviewedNativeRoutes({
          plan: review.report.plan,
          specs,
          capacity: bridgeCapacity,
        });
        // Refuse an occupied published host port before graph admission.
        await checkNativeLoopbackPorts(
          reviewedNativeLoopbackPorts(review.report.plan)
        );
        requireActiveStartup(controller.signal);
        const runSelection = await selectNativeProjectRestore({
          runtime: opts.runtime,
          projectRoot: opts.scope.projectRoot,
          restore,
          review,
          invoke: deps.invoke,
        });
        const cache = await nativeStartCacheSource({
          runtime: opts.runtime,
          projectRoot: opts.scope.projectRoot,
          review,
          restoreRevision: runSelection.sourceRevision,
          invoke: deps.invoke,
        });
        const directory = await mkdtemp(join(tmpdir(), "hack-native-start-"));
        const run = runSelection.run;
        const stop = hooks?.stop
          ? createNativeForegroundStop({
              scope: opts.scope,
              run,
              commands: hooks.stop,
              force: stopSignals.force,
              journal: deps.downHooks,
            })
          : undefined;
        foregroundStop = stop;
        let mapping: NativeProjectRun | undefined;
        // Set before any mapping write: a lost reply may still have published it.
        let mappingAttempted = false;
        let https:
          | Awaited<ReturnType<typeof acquireNativeHttpsLease>>
          | undefined;
        let httpsClosing = false;
        let httpsIntent: NativeHttpsLeaseIdentity | undefined;
        let httpsFailure: Error | undefined;
        try {
          const dependencyFile = join(directory, "dependencies.json");
          await writeFile(
            dependencyFile,
            JSON.stringify({
              version: 1,
              plan: review.planId,
              artifact,
              artifact_sha256: artifactHash,
              dependencies: hostDependencies,
            }),
            { mode: 0o600, flag: "wx" }
          );
          const plan = await deps.invoke({
            runtime: opts.runtime,
            cwd: opts.scope.projectRoot,
            args: [
              "graph",
              "dependency-plan",
              "--dependencies",
              dependencyFile,
              "--json",
            ],
          });
          if (
            !isRecord(plan) ||
            typeof plan.dependency_plan_id !== "string" ||
            !SHA.test(plan.dependency_plan_id)
          ) {
            throw unconfirmed("the host dependency plan");
          }
          const invokeInspect = () =>
            inspectNativeProjectGraph({
              runtime: opts.runtime,
              projectRoot: opts.scope.projectRoot,
              run,
              invoke: deps.invoke,
            });
          const delivery = nativeEnvironmentDelivery({
            input: activeNativeDeliveryInput({
              input,
              reviewedPlan: review.report.plan,
            }),
            planId: review.planId,
            reviewedPlan: review.report.plan,
            run,
          });
          let code = 1;
          let serveFailure: unknown;
          let nativeExitCode: string | undefined;
          let nativeProcessRefusals:
            | readonly NativeProcessRefusal[]
            | undefined;
          // Redacted at receipt; the raw tail is never retained or persisted.
          let startupLogReport = "";
          const services = [
            ...nativeReviewedActiveServices(review.report.plan),
          ].sort();
          const readinessArgs = nativeReadinessArgs({
            specs,
            plan: review.report.plan,
            initializers: cache.initializers,
            routed: routes.services,
          });
          progress({ phase: "services", services });
          let stopWatching: (() => Promise<void>) | undefined;
          try {
            servicesRequested = true;
            code = await deps.serve({
              runtime: opts.runtime,
              projectRoot: opts.scope.projectRoot,
              run,
              restore: runSelection.restoring,
              args: [
                ...review.projectArgs,
                ...runSelection.flags,
                "--expect-plan",
                review.planId,
                ...nativeSharedSourceFlags(review.report.plan),
                ...cache.flags,
                ...readinessArgs,
                ...routes.flags,
                "--dependencies",
                dependencyFile,
                "--expect-dependencies",
                plan.dependency_plan_id,
                "--auto-dependency-slots",
                ...delivery.flags,
                "--timeout-seconds",
                "300",
              ],
              privateInput: delivery.payload,
              startupTimeoutMs: 300_000,
              signal: controller.signal,
              // Down hooks run on the first stop request of a ready graph.
              ...stop?.serve,
              onExitDiagnostic: (diagnostic) => {
                nativeExitCode = diagnostic.nativeCode;
                nativeProcessRefusals = diagnostic.processRefusals;
              },
              onStartupLogs: (logs) => {
                startupLogReport = formatNativeStartupLogReport({
                  logs,
                  managedEnvironment: input.managedEnvironment,
                  managedFiles: input.managedFiles,
                });
              },
              onReady: async () => {
                const readyMapping = authoritative(
                  await invokeInspect(),
                  run,
                  review.namespace,
                  restore?.planId ?? review.planId
                );
                if (controller.signal.aborted) {
                  throw new ClosedCliError(
                    "Native startup canceled before mapping publication."
                  );
                }
                const persistedMapping = selectedMapping({
                  ready: readyMapping,
                  effectiveEnvName: input.effectiveEnvName,
                  profiles,
                  aws: selection.aws,
                  gcloud: selection.gcloud,
                  runtimeMetadata: metadata !== undefined,
                  environmentMarkers,
                });
                // Enrollment must exist before taking a shared lease: release
                // requires independent proof of this exact graph's cleanup.
                if (opts.https && routes.services.size > 0) {
                  https = await acquireReadyHttps({
                    runtime: opts.runtime,
                    selection: opts.https,
                    run: readyMapping,
                    signal: controller.signal,
                    invoke: deps.invoke,
                    acquire: deps.https,
                    onIntent: async (identity) => {
                      finalization = await deps.finalization({
                        scope: opts.scope,
                        run: persistedMapping,
                        httpsPort: opts.https?.httpsPort ?? null,
                        httpsLease: identity,
                      });
                      httpsIntent = identity;
                      // This is an ownership mapping, not a readiness signal.
                      // Recovery must be able to select the run after a lost reply.
                      mappingAttempted = true;
                      await deps.save({
                        ...opts.scope,
                        run: persistedMapping,
                        expected: expectedMapping,
                      });
                      mapping = persistedMapping;
                    },
                  }).catch((error: unknown) => {
                    httpsAcquisitionFailure = error;
                    throw error;
                  });
                  void https.exited.then(() => {
                    if (!httpsClosing) {
                      httpsFailure = new ClosedCliError(
                        "Native HTTPS owner exited unexpectedly; graph shutdown requested."
                      );
                      controller.abort();
                    }
                  });
                }
                // Injectable frontends may return a lease without publishing intent;
                // production publishes this marker before sending its acquire frame.
                finalization ??= await deps.finalization({
                  scope: opts.scope,
                  run: persistedMapping,
                  httpsPort: https ? opts.https?.httpsPort : null,
                  httpsLease: https?.identity,
                });
                // The registered lifetime now describes this startup.
                await admission?.retire();
                requireActiveStartup(controller.signal);
                await verifyHttpsRoutes(
                  https,
                  review.report.plan,
                  routes.services
                );
                if (httpsFailure) {
                  throw httpsFailure;
                }
                if (!mapping) {
                  mappingAttempted = true;
                  await deps.save({
                    ...opts.scope,
                    run: persistedMapping,
                    expected: expectedMapping,
                  });
                  mapping = persistedMapping;
                }
                if (selectedEnvironment) {
                  await opts
                    .onEnvironmentReady?.({
                      run,
                      fingerprint: selectedEnvironment,
                    })
                    .catch(() => undefined);
                }
                await hooks?.ready?.();
                stopWatching = watchServiceExits({
                  runtime: opts.runtime,
                  projectRoot: opts.scope.projectRoot,
                  run,
                  intervalMs: deps.exitMonitorIntervalMs,
                  invoke: deps.invoke,
                  progress,
                  onAllStopped: () => {
                    stopSignals.servicesStopped();
                    controller.abort();
                  },
                });
                // Commit owed down hooks before any observer can release a
                // detached launcher. A journal failure is still startup failure.
                await stop?.owe(() => controller.signal.aborted);
                requireActiveStartup(controller.signal);
                await opts.onReady?.(readyServiceSummary(readinessArgs));
                progress(
                  readyProgress({
                    services,
                    run,
                    plan: review.report.plan,
                    routed: routes.services,
                    httpsPort: servedHttpsPort(https, opts.https),
                  })
                );
              },
            });
          } catch (error) {
            serveFailure = error;
          } finally {
            delivery.payload?.fill(0);
            await stopWatching?.();
          }
          try {
            let final: unknown;
            try {
              final = await invokeInspect();
            } catch (inspectionFailure) {
              const settled = finalInspectionFailure({
                serveFailure,
                inspectionFailure,
                restored: restore !== undefined,
                mappingAttempted,
                nativeCode: nativeExitCode,
                processRefusals: nativeProcessRefusals,
              });
              graphCleanupConfirmed = settled.nothingReserved;
              throw settled.error;
            }
            const confirmed = await confirmCleanupOrRecordOwner({
              confirm: {
                final,
                runtime: opts.runtime,
                projectRoot: opts.scope.projectRoot,
                run,
                namespace: review.namespace,
                planId: restore?.planId ?? review.planId,
                invoke: deps.invoke,
                startupFailure: serveFailure,
                nativeCode: nativeExitCode,
              },
              existing: mapping ?? expectedMapping,
              scope: opts.scope,
              selection: {
                effectiveEnvName: input.effectiveEnvName,
                profiles,
                aws: selection.aws,
                gcloud: selection.gcloud,
                runtimeMetadata: metadata !== undefined,
                environmentMarkers,
              },
              finalization,
              deps,
              onRecorded: (recorded) => {
                mapping = recorded.mapping;
                finalization = recorded.finalization;
              },
            });
            final = confirmed.final;
            graphCleanupConfirmed = true;
            await retireRemovedMapping({
              final,
              mapping,
              owned: confirmed.owned,
              scope: opts.scope,
              remove: deps.remove,
            });
            await deps.discardFailedStart({
              runtime: opts.runtime,
              projectRoot: opts.scope.projectRoot,
              run,
              owner: confirmed.owned.owner,
              final,
              restored: restore !== undefined,
              mappingAttempted,
              invoke: deps.invoke,
            });
            reportStopped({
              progress,
              signal: controller.signal,
              infrastructureFailure: httpsFailure,
              published: mapping !== undefined,
              final,
            });
            return foregroundExitCode({
              aborted: controller.signal.aborted,
              interruptedExit: stopSignals.interruptedExit(),
              failure: serveFailure,
              infrastructureFailure: httpsFailure,
              code,
            });
          } catch (error) {
            throw withStartupLogReport(error, startupLogReport);
          }
        } finally {
          httpsClosing = true;
          try {
            if (https) {
              await https.releaseAfterCleanup();
            } else if (httpsIntent) {
              await deps.recoverHttps({
                runtime: opts.runtime,
                identity: httpsIntent,
              });
            }
            httpsCleanupConfirmed = true;
          } finally {
            await deps.cleanupTemporary(directory);
          }
        }
      },
    });
  } catch (error) {
    failed = true;
    throw foregroundStartFailure({
      error,
      stopRequested: controller.signal.aborted,
      servicesRequested,
      httpsAcquisitionFailure,
      interruptedExit: stopSignals.interruptedExit(),
    });
  } finally {
    cancelAwsExpiry?.();
    // The stop listeners stay installed until down.after and the finalization
    // acknowledgement settle: a further interrupt then cancels the running
    // hook through the force signal instead of terminating this frontend
    // with the hook's journal record or the acknowledgement unsettled.
    try {
      await hooks?.cleanup().catch((error: unknown) => {
        throw httpsCleanupFailure(httpsAcquisitionFailure, error);
      });
      // down.after follows confirmed cleanup and lifecycle-process retirement,
      // and precedes the finalization acknowledgement `down` waits for.
      const stopFailure = await foregroundStop?.finish(graphCleanupConfirmed);
      await acknowledgeFinalization(
        finalization,
        graphCleanupConfirmed,
        httpsCleanupConfirmed
      ).catch((error: unknown) => {
        throw httpsCleanupFailure(httpsAcquisitionFailure, error);
      });
      reportForegroundStopFailure(stopFailure, failed);
    } finally {
      stopSignals.dispose();
    }
  }
}
/** A failed stop hook replaces the interrupted status, never a startup error. */
function reportForegroundStopFailure(failure: unknown, failed: boolean): void {
  if (failure !== undefined && !failed) {
    throw failure;
  }
}

/** Publish advisory startup evidence until this foreground invocation settles. */
export async function startNativeProject(
  opts: NativeProjectStartOptions
): Promise<number> {
  let finish: (() => Promise<void>) | undefined;
  try {
    return await startNativeProjectAttempt(opts, async () => {
      finish = await beginNativeProjectStartupObservation(opts.scope);
    });
  } finally {
    await finish?.();
  }
}
