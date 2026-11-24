import { createHash, randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { noteActivityFailedServices } from "../lib/activity-log.ts";
import type { BranchDroppedSites } from "../lib/branch-hosts.ts";
import { ClosedCliError, HackCliError } from "../lib/cli-result.ts";
import { beginUpTiming } from "../lib/command-timings.ts";
import {
  type ComposeEnvFingerprintRecord,
  withComposeServiceEnvFingerprints,
} from "../lib/compose-env-fingerprint.ts";
import { isRecord } from "../lib/guards.ts";
import { appendLifecycleLogRecord } from "../lib/lifecycle-runtime.ts";
import {
  isNativeDetachedOwnerProcess,
  nativeDetachedUpBranchDropped,
  nativeDetachedUpFailedServices,
  nativeDetachedUpHotReload,
  nativeDetachedUpProfileNotice,
  nativeDetachedUpShellVariables,
  nativeShellForwardingNotice,
  reportNativeImageDownloadWait,
  reportNativeImageNotice,
  reportNativeImageWork,
} from "../lib/native-detached-up.ts";
import {
  describeNativeProcessRefusals,
  type NativeProcessRefusal,
  requireWrappableNativeProcesses,
} from "../lib/native-process-wrappers.ts";
import { nativeRuntimeTempDirectory } from "../lib/native-runtime-temp.ts";
import { adaptNativeAwsEnvironment } from "./native-aws-environment.ts";
import { scheduleNativeAwsExpiryWarnings } from "./native-aws-expiry.ts";
import type { NativeDependencyOwnerResolver } from "./native-dependency-owners.ts";
import { emptyNativeDependencyPlanId } from "./native-dependency-plan.ts";
import {
  awaitNativeEndedBootOwner,
  NATIVE_ENDED_BOOT_OWNER_WAIT_MS,
  nativePoolBootProvenEnded,
} from "./native-ended-boot-owner.ts";
import {
  adaptNativeGcloudEnvironment,
  hasNativeGcloudCredentialMount,
  type NativeGcloudSelection,
} from "./native-gcloud-environment.ts";
import {
  NATIVE_START_FRONTEND_SLACK_MS,
  NATIVE_START_STATUS_INTERVAL_MS,
  NATIVE_START_STATUS_STALE_MS,
  nativeGraphTimeoutDetail,
  nativeReadinessGoals,
  nativeStartBudgetSeconds,
  watchNativeStartupStatus,
} from "./native-graph-start-budget.ts";
import {
  nativeHotReloadNoticeFromPool,
  renderNativeHotReloadNotice,
} from "./native-hot-reload-notice.ts";
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
  batchImageFailure,
  NATIVE_IMAGE_ENSURE_TIMEOUT_MS,
  NativeImageBatchError,
  nativeImagePolicyArgs,
  nativeImageRegistryReason,
} from "./native-image-policy.ts";
import { nativeImageBlocker, offlineTagNotice } from "./native-image-tags.ts";
import {
  type NativePreparedBase,
  preparedBaseArguments,
} from "./native-prepared-base.ts";
import { nativePrivateEnvironmentPayload } from "./native-private-environment-payload.ts";
import {
  type NativeProfileNotice,
  type NativeProfileNoticeSource,
  type NativeProfileSelection,
  nativeInactiveServices,
  nativeNoticeProfileNames,
  renderNativeProfileNotice,
} from "./native-profile-selection.ts";
import { prepareNativeProjectAdaptation } from "./native-project-adaptation.ts";
import {
  admitNativeProjectBuilds,
  buildNativeProjectImages,
  invokeNativeBuild,
  NativeBuildRegistryError,
  type NativeBuildRequest,
  type NativeBuildSettlement,
  type NativeVerifiedBuild,
  nativeBuildsEnabled,
  nativeRebuildRequested,
  nativeServiceActive,
  pinVerifiedNativeBuilds,
  reclaimNativeBuildImagesAfterRebuild,
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
import {
  inspectNativeProjectGraph,
  observeStartingNativeProjectGraph,
} from "./native-project-inspect.ts";
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
  type NativeProjectReview,
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
import {
  nativeProjectRuntimeUpArgs,
  nativeRuntimePoolStopped,
} from "./native-project-runtime-up.ts";
import { selectNativeEnvFile } from "./native-project-selection.ts";
import { preflightNativeProjectSource } from "./native-project-source-preflight.ts";
import {
  requireCapturedNativeSourceWithinLimit,
  requireNativeSourceWithinLimit,
} from "./native-project-source-size.ts";
import { requireNativeStaticStartReview } from "./native-project-start-preflight.ts";
import {
  reportNativeManagedRestartNotices,
  reportNativeRestartPolicyNotices,
} from "./native-restart-policy-notices.ts";
import {
  invokeNativeRuntime,
  NATIVE_BUILD_RETENTION_TIMEOUT_MS,
  NATIVE_IDLE_POOL_NOTE,
  NativeRuntimeRequestError,
  type NativeRuntimeSelection,
  retainNativeRuntimeFailure,
} from "./native-runtime-client.ts";
import {
  applyNativeRuntimeMetadata,
  type NativeRuntimeMetadataSelection,
  verifyNativeRuntimeMetadataRoutes,
} from "./native-runtime-metadata.ts";
import { recoverExitedNativeRuntime } from "./native-runtime-preflight.ts";
import {
  monitorNativeServiceExits,
  type NativeServiceExit,
} from "./native-service-exit-monitor.ts";
import {
  NATIVE_START_POOL_GRACE_MS,
  watchNativeStartPool,
} from "./native-start-pool-watch.ts";
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
  /** The frontend lifetime's attempt, so the lease is recorded on that lifetime. */
  readonly attempt?: string;
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
      attempt: opts.attempt ?? randomBytes(16).toString("hex"),
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
  readonly ready?: (signal: AbortSignal) => Promise<void>;
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
  /** May return the original-input identity the final review reuses. */
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
  /** How often a waiting start reads its graph status (HACK-2351). */
  startupStatusIntervalMs: number;
  /** Whether the pool record proves the run's owner's boot ended (HACK-2572). */
  poolBootEnded: (home: string) => Promise<boolean>;
  /** How long a start waits for such an owner to go (HACK-2572). */
  endedBootOwnerWaitMs: number;
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
  startupStatusIntervalMs: NATIVE_START_STATUS_INTERVAL_MS,
  poolBootEnded: nativePoolBootProvenEnded,
  endedBootOwnerWaitMs: NATIVE_ENDED_BOOT_OWNER_WAIT_MS,
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
  if (
    !nativeDetachedUpShellVariables(names, input.ignoredRootDotenv === true)
  ) {
    warn(nativeShellForwardingNotice(names));
  }
  for (const notice of input.environmentNotices ?? []) {
    if (notice.service === undefined || active.has(notice.service)) {
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
/**
 * Pin every active build service: to the image a restart preflight verified, or to
 * what the runtime returns for its build (an unchanged build key reuses its image).
 * Returns the pinned services; retained images never stand in for them (HACK-2533).
 */
async function resolveNativeBuildImages(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly branch: string | null | undefined;
  readonly profiles: readonly string[];
  readonly builds: ReadonlyMap<string, NativeBuildRequest>;
  readonly specs: Record<string, Record<string, unknown>>;
  readonly verified: ReadonlyMap<string, NativeVerifiedBuild> | undefined;
  readonly imageTagMode?: "refresh" | "offline";
  readonly signal: AbortSignal;
  readonly guestCpus?: number;
  readonly onBuildSettled?: (settlement: NativeBuildSettlement) => void;
  readonly invoke: typeof invokeNativeBuild | undefined;
  readonly onBuilt: () => void;
  readonly onImageWait: (reference: string | null) => void;
  readonly onNotice: (line: string) => void;
}): Promise<ReadonlySet<string>> {
  const remaining = pinVerifiedNativeBuilds(opts);
  const built = await buildNativeProjectImages({
    ...opts,
    builds: remaining,
    rebuild: nativeRebuildRequested(),
  });
  return new Set([
    ...built,
    ...[...opts.builds.keys()].filter((service) => !remaining.has(service)),
  ]);
}
const PINNED_IMAGE_REFERENCE = /^[^@\s]+@sha256:[a-f0-9]{64}$/;
/** Acquire one image and accept only a confirmed content ID for the requested policy. */
async function ensureNativeProjectImage(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly reference: string;
  readonly imageTagMode?: "refresh" | "offline";
  readonly affectedServices: () => readonly string[];
  readonly commandPin?: string;
  readonly waitReference: string;
  readonly signal: AbortSignal;
  readonly policy: NativeEmulationPolicy | undefined;
  readonly invoke: typeof invokeNativeRuntime;
}) {
  const ensured = await opts
    .invoke({
      runtime: opts.runtime,
      cwd: opts.projectRoot,
      args: [
        ...nativeEnsureImageArgs(opts.reference, opts.policy),
        ...nativeImagePolicyArgs(),
        ...(opts.commandPin ? ["--command-image-pin", opts.commandPin] : []),
        ...(opts.imageTagMode ? ["--image-tag-mode", opts.imageTagMode] : []),
      ],
      timeoutMs: NATIVE_IMAGE_ENSURE_TIMEOUT_MS,
      signal: opts.signal,
      onImageWait: (waiting, subject) =>
        reportNativeImageDownloadWait(
          waiting ? (subject ?? opts.waitReference) : null
        ),
    })
    .catch((error: unknown) => {
      if (
        error instanceof NativeRuntimeRequestError &&
        error.nativeCode === "registry_image_not_found"
      ) {
        const names = opts
          .affectedServices()
          .map((name) => (SERVICE_NAME.test(name) ? name : "(name omitted)"));
        const label =
          names.length === 1
            ? `service ${names[0]}`
            : `services ${names.join(", ")}`;
        throw new ClosedCliError(
          `Native image acquisition failed for ${label} field image (registry_image_not_found); the selected image ${opts.reference} was not found.`
        );
      }
      throw error;
    });
  if (
    !isRecord(ensured) ||
    typeof ensured.image_id !== "string" ||
    !IMAGE.test(ensured.image_id) ||
    !ensuredPlatformAccepted(ensured.platform, opts.policy)
  ) {
    throw unconfirmed("the runtime image selection");
  }
  return {
    imageId: ensured.image_id,
    reference: ensured.pinned_reference,
    offline: offlineTagNotice(ensured),
  };
}
/** Feed independent references to the runtime cache coordinator. */
async function pinNativeImageBatch(
  opts: Parameters<typeof pinNativeProjectImages>[0]
): Promise<void> {
  const report = (line: string) => {
    if (!reportNativeImageNotice(line)) {
      opts.warn(line);
    }
  };
  const jobs = new Map<
    string,
    {
      reference: string;
      input: string;
      names: string[];
      policy: NativeEmulationPolicy | undefined;
      specs: Record<string, unknown>[];
    }
  >();
  for (const [name, spec] of Object.entries(opts.specs)) {
    if (!nativeServiceActive(spec, opts.profiles)) {
      continue;
    }
    if (
      typeof spec.image !== "string" ||
      IMAGE.test(spec.image) ||
      spec.build !== undefined
    ) {
      continue;
    }
    const reference = opts.canonicalImages.get(spec.image) ?? spec.image;
    const policy = nativeEmulationPolicy(opts.amd64Emulation, name);
    const job = jobs.get(reference);
    if (job && job.policy !== policy) {
      // The existing path binds both platform policies to one command pin.
      return;
    }
    if (job) {
      job.specs.push(spec);
      job.names.push(name);
    } else {
      jobs.set(reference, {
        reference,
        input: spec.image,
        policy,
        specs: [spec],
        names: [name],
      });
    }
  }
  if (jobs.size < 2 || opts.imageTagMode) {
    return;
  }
  const pending = [...jobs.values()];
  for (let offset = 0; offset < pending.length; offset += 3) {
    const wave = pending.slice(offset, offset + 3);
    const waiting = new Set<string>();
    const working = new Set<string>();
    const reply = await opts
      .invoke({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        args: [
          "runtime",
          "ensure-images",
          "--json",
          ...nativeImagePolicyArgs(),
        ],
        privateInput: new TextEncoder().encode(
          JSON.stringify(wave.map((job) => [job.input, job.policy ?? "native"]))
        ),
        signal: opts.signal,
        onImageWait: (active, reference, work) => {
          if (work) {
            const image = wave[Number(reference)]?.reference;
            if (image) {
              if (active) {
                working.add(image);
              } else {
                working.delete(image);
              }
              reportNativeImageWork([...working]);
            }
            return;
          }
          if (
            !(
              reference &&
              (reference === "image-cache" ||
                reference === "image-reclaim" ||
                wave.some((job) => job.reference === reference))
            )
          ) {
            return;
          }
          if (active) {
            waiting.add(reference);
          } else {
            waiting.delete(reference);
          }
          reportNativeImageDownloadWait(waiting.values().next().value ?? null);
        },
        timeoutMs: Math.min(
          3_600_000,
          wave.length * NATIVE_IMAGE_ENSURE_TIMEOUT_MS
        ),
      })
      .catch((error: unknown) => {
        // Older bundled runtimes reject the command before doing any work.
        if (
          error instanceof NativeRuntimeRequestError &&
          error.nativeCode === "unsupported_command"
        ) {
          return null;
        }
        throw error;
      });
    if (reply === null) {
      return;
    }

    if (!Array.isArray(reply) || reply.length !== wave.length) {
      throw unconfirmed("the runtime image batch");
    }
    const failures: ReturnType<typeof batchImageFailure>[] = [];
    const seen = new Set<number>();
    for (const pair of reply) {
      if (
        !(Array.isArray(pair) && Number.isInteger(pair[0])) ||
        seen.has(pair[0])
      ) {
        throw unconfirmed("the runtime image batch");
      }
      const [index, result, elapsed] = pair;
      const job = wave[index];
      if (
        !(
          job &&
          isRecord(result) &&
          Number.isSafeInteger(elapsed) &&
          elapsed >= 0
        )
      ) {
        throw unconfirmed("the runtime image batch");
      }
      seen.add(index);
      const image = result.Ok;
      if (
        !(
          isRecord(image) &&
          typeof image.image_id === "string" &&
          IMAGE.test(image.image_id) &&
          ensuredPlatformAccepted(image.platform, job.policy)
        )
      ) {
        report(`${job.reference} · image preparation failed · ${elapsed} ms`);
        failures.push(batchImageFailure(job.reference, result.Err, job.names));
        continue;
      }
      report(`${job.reference} · image verified in guest · ${elapsed} ms`);
      const notice = offlineTagNotice(image);
      if (notice && !reportNativeImageNotice(notice)) {
        report(notice);
      }
      for (const spec of job.specs) {
        spec.image = image.image_id;
      }
    }
    if (failures.length) {
      throw new NativeImageBatchError(failures);
    }
  }
}

/** Keep image acquisition separate from graph admission and preserve cancellation between requests. */
async function pinNativeProjectImages(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly specs: Record<string, Record<string, unknown>>;
  readonly retainedImages: ReadonlyMap<string, string>;
  readonly canonicalImages: ReadonlyMap<string, string>;
  /** The selected Compose profiles: a service outside them is never pulled. */
  readonly profiles: readonly string[];
  /** Opted-in services' platform policies; every other service resolves Linux arm64. */
  readonly amd64Emulation?: Readonly<Record<string, NativeEmulationPolicy>>;
  readonly signal: AbortSignal;
  readonly imageTagMode?: "refresh" | "offline";
  readonly warn: (line: string) => void;
  readonly invoke: typeof invokeNativeRuntime;
}): Promise<void> {
  await pinNativeImageBatch(opts);
  const reportedOffline = new Set<string>();
  const confirmed = new Set<string>();
  const references = [...new Set(opts.canonicalImages.values())];
  const offlineReferences = new Set<string>();
  const pinnedImages = new Map<string, string>();
  const immutableReferences = new Map<string, string | null>();
  const canonical = (image: string) => opts.canonicalImages.get(image) ?? image;
  for (const [name, spec] of Object.entries(opts.specs)) {
    if (opts.signal.aborted) {
      throw canceled();
    }
    const retainedImage = opts.retainedImages.get(name);
    if (retainedImage && spec.build !== undefined) {
      spec.image = retainedImage;
      continue;
    }
    // As Compose does, a service outside the selected profiles is not
    // acquired; the graph requires a pinned image only for active services
    // (HACK-2338 item 4).
    if (!nativeServiceActive(spec, opts.profiles)) {
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
    // The same tag may select different images under different platform policies.
    const reference = canonical(image);
    const key = JSON.stringify([reference, policy]);
    const pinned = pinnedImages.get(key);
    if (pinned !== undefined) {
      spec.image = pinned;
      continue;
    }
    const immutableReference = immutableReferences.get(reference);
    if (immutableReference === null) {
      throw unconfirmed("the runtime image reference");
    }
    const ensured = await ensureNativeProjectImage({
      runtime: opts.runtime,
      projectRoot: opts.projectRoot,
      reference: image,
      waitReference: reference,
      signal: opts.signal,
      commandPin: reference.includes("@") ? undefined : immutableReference,
      affectedServices: () =>
        Object.entries(opts.specs)
          .filter(
            ([service, candidate]) =>
              !opts.retainedImages.has(service) &&
              nativeServiceActive(candidate, opts.profiles) &&
              typeof candidate.image === "string" &&
              canonical(candidate.image) === reference
          )
          .map(([service]) => service),
      policy,
      imageTagMode: offlineReferences.has(reference)
        ? "offline"
        : opts.imageTagMode,
      invoke: opts.invoke,
    }).catch(async (error: unknown) => {
      if (
        error instanceof NativeRuntimeRequestError &&
        (error.nativeCode === "image_tag_download_busy" ||
          error.nativeCode === "image_tag_offline_missing" ||
          error.nativeCode === "image_archive_offline_missing")
      ) {
        throw await nativeImageBlocker({
          runtime: opts.runtime,
          projectRoot: opts.projectRoot,
          missing: reference,
          downloading: error.nativeCode === "image_tag_download_busy",
          reason: error.nativeCauseCode,
          references,
          confirmed,
          invoke: opts.invoke,
        });
      }
      if (
        error instanceof NativeRuntimeRequestError &&
        error.nativeCode?.startsWith("registry_")
      ) {
        const reason =
          nativeImageRegistryReason(error.nativeCauseCode) ?? error.message;
        throw new ClosedCliError(`Image unavailable: ${reference}: ${reason}`);
      }
      throw error;
    });
    confirmed.add(reference);
    if (ensured.offline) {
      offlineReferences.add(reference);
    }
    const noticeKey = `${reference}\n${ensured.imageId}`;
    if (ensured.offline && !reportedOffline.has(noticeKey)) {
      if (!reportNativeImageNotice(ensured.offline)) {
        opts.warn(ensured.offline);
      }
      reportedOffline.add(noticeKey);
    }
    if (immutableReference === undefined) {
      immutableReferences.set(
        reference,
        typeof ensured.reference === "string" &&
          PINNED_IMAGE_REFERENCE.test(ensured.reference)
          ? ensured.reference
          : null
      );
    }
    pinnedImages.set(key, ensured.imageId);
    spec.image = ensured.imageId;
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
function nativeReadyRouteHosts(opts: {
  readonly plan: unknown;
  readonly routed: ReadonlySet<string>;
}): readonly { readonly service: string; readonly hosts: readonly string[] }[] {
  const services =
    isRecord(opts.plan) && isRecord(opts.plan.services)
      ? opts.plan.services
      : {};
  return [...opts.routed].sort().flatMap((service) => {
    const entry = services[service];
    const hosts =
      isRecord(entry) &&
      isRecord(entry.routing) &&
      Array.isArray(entry.routing.hostnames)
        ? entry.routing.hostnames.filter(
            (host): host is string =>
              typeof host === "string" && PRINTABLE_HOST.test(host)
          )
        : [];
    return PRINTABLE_NAME.test(service) && hosts.length > 0
      ? [{ service, hosts }]
      : [];
  });
}

function nativeReadyRouteUrls(
  hosts: readonly string[],
  httpsPort: number
): string[] {
  const suffix = httpsPort === 443 ? "" : `:${httpsPort}`;
  return hosts.map((host) => `https://${host}${suffix}`);
}

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
  const routes = nativeReadyRouteHosts(opts);
  const port = opts.httpsPort;
  const lines =
    port === null
      ? []
      : routes.map(
          ({ service, hosts }) =>
            `  ${service}: ${nativeReadyRouteUrls(hosts, port).join(" ")}`
        );
  if (port === null && routes.length > 0) {
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
/**
 * A `graph_timeout` failure, replaced by one whose fixed runtime detail names
 * the services that had not reached their readiness goal. Any other failure,
 * or a snapshot that names none, is returned unchanged.
 */
function withGraphTimeoutDetail(opts: {
  readonly failure: unknown;
  readonly nativeCode: string | undefined;
  /** The latest startup-phase status snapshot, if one was read. */
  readonly status:
    | { readonly snapshot: unknown; readonly takenAt: number }
    | undefined;
  /** When serve settled after the deadline, on the same monotonic clock. */
  readonly deadlineAt: number;
  readonly goals: Readonly<Record<string, string>>;
  readonly waitedMs: number;
  readonly budgetSeconds: number;
}): unknown {
  if (opts.nativeCode !== "graph_timeout" || !(opts.failure instanceof Error)) {
    return opts.failure;
  }
  // Without a recent startup view, keep the runtime's generic message rather
  // than describe services from stale or missing evidence.
  const ageMs = opts.status
    ? Math.max(0, opts.deadlineAt - opts.status.takenAt)
    : Number.POSITIVE_INFINITY;
  if (!opts.status || ageMs > NATIVE_START_STATUS_STALE_MS) {
    return opts.failure;
  }
  const detail = nativeGraphTimeoutDetail({
    snapshot: opts.status.snapshot,
    goals: opts.goals,
    waitedMs: opts.waitedMs,
    budgetSeconds: opts.budgetSeconds,
    snapshotAgeMs: ageMs,
  });
  if (!detail) {
    return opts.failure;
  }
  return new NativeRuntimeRequestError({
    message: `Native graph startup was interrupted or failed (graph_timeout); inspect owned state before retrying. Runtime: ${detail}`,
    nativeCode: "graph_timeout",
    nativeMessage: detail,
  });
}

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
        `Native graph startup failed before any runtime state was reserved; nothing was created and no cleanup is needed.${startupDiagnostic(opts.serveFailure)}${refusedProcesses(opts.processRefusals)} ${NATIVE_IDLE_POOL_NOTE}`
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
}): Extract<NativeStartupProgress, { readonly phase: "ready" | "started" }> {
  return {
    phase: "ready",
    services: opts.services,
    run: RUN.test(opts.run) ? opts.run : "unknown",
    endpoints: nativeReadySummary(opts),
  };
}

/**
 * The started envelope, from what each container is observed doing (not from its
 * configured goal): a completion job counts as completed only once it exited 0, a
 * health goal only once healthy; anything not there yet is warming.
 */
export function startedServiceSummary(
  readinessArgs: readonly string[],
  inspected: unknown
): {
  readonly started: readonly string[];
  readonly completed: readonly string[];
  readonly warming: readonly string[];
} {
  const observations =
    isRecord(inspected) && isRecord(inspected.observations)
      ? inspected.observations
      : {};
  const by = {
    started: [] as string[],
    completed: [] as string[],
    warming: [] as string[],
  };
  for (const [service, goal] of Object.entries(
    nativeReadinessGoals(readinessArgs)
  )) {
    const seen = observations[`container:${service}`];
    const state = isRecord(seen) ? seen.state : undefined;
    const done = isRecord(seen) && state === "exited" && seen.code === 0;
    if (goal === "completed") {
      (done ? by.completed : by.warming).push(service);
    } else if (goal === "healthy") {
      (isRecord(seen) && state === "running" && seen.health === "healthy"
        ? by.started
        : by.warming
      ).push(service);
    } else {
      by.started.push(service);
    }
  }
  return by;
}
/** Started summary plus routes not verified yet; `warming` until every goal is met. */
function startedEnvelope(
  summary: ReturnType<typeof startedServiceSummary>,
  routed: ReadonlySet<string>
) {
  const warming = [...new Set([...summary.warming, ...routed])].sort();
  return {
    started: summary.started.filter((service) => !warming.includes(service)),
    completed: summary.completed,
    readiness: "warming" as const,
    warming,
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
  readonly gcloudWithheld?: boolean;
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
    // (which delivers a fresh file); a different explicit selection refuses,
    // and so does an explicitly withheld one, so the file is never delivered.
    (opts.gcloud !== undefined && opts.gcloud.mode !== run.gcloud?.mode) ||
    (opts.gcloudWithheld === true && run.gcloud != null)
  ) {
    throw new ClosedCliError(
      "Native up cannot change the retained run's environment, profiles, AWS profile or gcloud selection; data was not replaced. Omit the option to keep the retained selection, or stop the instance with hack down --remove-data (this deletes its data volumes) to start it with another."
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
  readonly targets?: readonly string[];
  readonly aws?: { readonly profile: string; readonly region?: string };
  readonly gcloud?: NativeGcloudSelection;
  readonly gcloudWithheld?: boolean;
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
          gcloudWithheld: opts.gcloudWithheld,
        })
      : {
          envName: opts.envName,
          profiles: opts.requestedProfiles,
          aws: opts.aws,
          gcloud: opts.gcloud,
        };
  const extension =
    retained && opts.targets?.length
      ? await selectNativeGraphExtension({ ...opts, run: retained })
      : undefined;
  if (extension) {
    return {
      retained,
      restore: undefined,
      selection,
      retainedFlags: [],
      extension,
    };
  }
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
            startupWait: true,
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
  return { retained, restore, selection, retainedFlags, extension: undefined };
}

async function selectNativeGraphExtension(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly scope: NativeProjectRunScope;
  readonly run: NativeProjectRun;
  readonly invoke: typeof invokeNativeRuntime;
  readonly signal?: AbortSignal;
}) {
  const snapshot = await inspectNativeProjectGraph({
    runtime: opts.runtime,
    projectRoot: opts.scope.projectRoot,
    run: opts.run.run,
    invoke: opts.invoke,
    signal: opts.signal,
  });
  const { run, planId, namespace } = opts.run;
  const owned = authoritative(snapshot, run, namespace, planId);
  if (
    owned.owner !== opts.run.owner ||
    !isRecord(snapshot) ||
    !isRecord(snapshot.receipt)
  ) {
    throw unconfirmed("the targeted start owner");
  }
  if (snapshot.receipt.phase !== "ready-observed") {
    return undefined;
  }
  const owner = await opts.invoke({
    runtime: opts.runtime,
    cwd: opts.scope.projectRoot,
    args: ["graph", "owner-status", "--run-id", run, "--json"],
    timeoutMs: 15_000,
    signal: opts.signal,
  });
  if (
    isRecord(owner) &&
    owner.run === run &&
    owner.runtime_error === "graph_extend_incomplete"
  ) {
    throw new HackCliError({
      code: "E_RECOVERY_REQUIRED",
      message:
        "A previous targeted native start is incomplete. Inspect it with hack ps and run hack down before trying again.",
    });
  }
  if (
    !(
      isRecord(owner) &&
      owner.ok === true &&
      owner.run === run &&
      owner.plan === planId &&
      owner.phase === "ready-observed" &&
      owner.runtime_verified === true &&
      typeof owner.generation === "string" &&
      SHA.test(owner.generation) &&
      isRecord(owner.service_images)
    )
  ) {
    throw unconfirmed("a ready foreground owner for targeted start");
  }
  const images = new Map<string, string>();
  for (const [name, image] of Object.entries(owner.service_images)) {
    if (
      !(
        PRINTABLE_NAME.test(name) &&
        typeof image === "string" &&
        IMAGE.test(image)
      )
    ) {
      throw unconfirmed("the foreground owner's service identities");
    }
    images.set(name, image);
  }
  return { run: opts.run, generation: owner.generation, images };
}

/**
 * HACK-2456: the pool stopped (or was stopped) under a running project, so
 * the retained preflight refuses `graph_foreground_owner_exited` and nothing
 * can recover the run without a running pool. When `runtime status` shows the
 * pool stopped, `recover` (`hack down --recover` for this instance) starts it
 * and recovers the run with data retained; the selection then runs once more.
 * A running pool, an unreadable status or any other refusal keeps the original
 * error: its message already names `hack down --recover`, which works there.
 */
async function selectNativeStartupRecoveringStoppedPool(opts: {
  readonly select: () => ReturnType<typeof selectNativeStartup>;
  readonly runtime: NativeRuntimeSelection;
  readonly projectRoot: string;
  readonly invoke: typeof invokeNativeRuntime;
  readonly recover: (() => Promise<void>) | undefined;
  readonly warn: (line: string) => void;
  readonly signal?: AbortSignal;
  /** Set on the one retry after an exited provider was recovered (HACK-2579). */
  readonly exitedProviderRecovered?: true;
  readonly poolBootEnded: (home: string) => Promise<boolean>;
  readonly endedBootOwnerWaitMs: number;
}): ReturnType<typeof selectNativeStartup> {
  let failure: unknown;
  try {
    return await opts.select();
  } catch (error) {
    // HACK-2579: the pool's provider exited while its record still says running.
    // The retained preflight then sees a live owner that has not noticed yet, or a
    // running record with a dead provider. `runtime recover` records the pool
    // stopped (under the lease, identity checked), then selection runs once more.
    if (
      error instanceof NativeRuntimeRequestError &&
      EXITED_PROVIDER_REFUSALS.has(error.nativeCode ?? "") &&
      !opts.exitedProviderRecovered &&
      !opts.signal?.aborted &&
      (await recoverExitedNativeRuntime({
        runtime: opts.runtime,
        cwd: opts.projectRoot,
        invoke: opts.invoke,
        signal: opts.signal,
        notice: (line) => {
          if (!reportNativeImageNotice(line)) {
            opts.warn(line);
          }
        },
      }))
    ) {
      return await selectNativeStartupRecoveringStoppedPool({
        ...opts,
        exitedProviderRecovered: true,
      });
    }
    failure = error;
  }
  // HACK-2572: the owner of a pool boot that has ended is still exiting. Wait,
  // bounded, for its refusal to change, then decide as before. A live owner on a
  // running pool never satisfies the proof and keeps its refusal at once.
  if (
    isForegroundOwnerRunning(failure) &&
    !opts.signal?.aborted &&
    (await opts.poolBootEnded(opts.runtime.home))
  ) {
    let selected: Awaited<ReturnType<typeof selectNativeStartup>> | undefined;
    await awaitNativeEndedBootOwner({
      home: opts.runtime.home,
      notice: opts.warn,
      signal: opts.signal,
      waitMs: opts.endedBootOwnerWaitMs,
      read: async (home) =>
        (await opts.poolBootEnded(home)) ? ENDED_RECORD : undefined,
      ownerRunning: async () => {
        try {
          selected = await opts.select();
          return false;
        } catch (error) {
          failure = error;
          return isForegroundOwnerRunning(error);
        }
      },
    });
    if (selected) {
      return selected;
    }
  }
  if (
    !(
      opts.recover &&
      failure instanceof NativeRuntimeRequestError &&
      failure.nativeCode === NATIVE_FOREGROUND_OWNER_EXITED &&
      !opts.signal?.aborted &&
      (await nativeRuntimePoolStopped(opts))
    )
  ) {
    throw failure;
  }
  await opts.recover();
  requireActiveStartup(opts.signal);
  opts.warn(
    "The native runtime had stopped under this run. It was started and the run was recovered with data retained; starting it again."
  );
  return await opts.select();
}
const NATIVE_FOREGROUND_OWNER_EXITED = "graph_foreground_owner_exited";
/** Retained-preflight refusals a pool with an exited provider can give (HACK-2579). */
const EXITED_PROVIDER_REFUSALS = new Set([
  "graph_foreground_owner_running",
  "graph_foreground_owner_uncertain",
  "graph_retained_startup",
  "process_identity_unavailable",
]);
/** A pool record that proves an ended boot, for the wait's own recheck. */
const ENDED_RECORD = { token: "", phase: "stopped" };
/**
 * Refusals of an owner that may still be alive: running, or ending (its process
 * exited but not yet reaped, or its publication read mid-change; HACK-2572).
 */
function isForegroundOwnerRunning(error: unknown): boolean {
  return (
    error instanceof NativeRuntimeRequestError &&
    (error.nativeCode === "graph_foreground_owner_running" ||
      error.nativeCode === "graph_foreground_owner_uncertain")
  );
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
    // HACK-2456, seen on a real VM: what is wrong, what needs it, the command.
    throw new HackCliError({
      code: "E_RECOVERY_REQUIRED",
      message: [
        "This project's last native run has no confirmed shutdown: its owner exited before finishing it, or another start of this instance replaced it.",
        "hack up needs that cleanup to finish before it starts the project again; nothing was started.",
        "Run hack down --recover: it finishes the cleanup with your data kept, starting the native runtime if it needs to.",
      ].join("\n"),
    });
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
        /** Image work is done; review and plan work follow (detached clocks only). */
        | "plan"
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
      /** Every goal met and every route answering, after a started return. */
      readonly phase: "all-ready";
      readonly elapsedMs: number;
    }
  | {
      /** The owner reported ready, but a route check failed; the run keeps running. */
      readonly phase: "routes-not-answering";
      readonly detail: string;
    }
  | {
      /** `ready` (with `--wait`), or `started`: every container started. */
      readonly phase: "ready" | "started";
      readonly services: readonly string[];
      /** The run id, or `unknown` when it fails the run-id pattern. */
      readonly run: string;
      /** Indented route, unserved-route and published-port lines. */
      readonly endpoints: readonly string[];
    }
  | ({ readonly phase: "service-exited" } & NativeServiceExit)
  | ({ readonly phase: "build-settled" } & NativeBuildSettlement);

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
  /**
   * Build images a restart preflight verified before it stopped the old graph:
   * those services are pinned as they are and never built again (HACK-2533).
   */
  readonly verifiedBuildImages?: ReadonlyMap<string, NativeVerifiedBuild>;
  readonly runtime: NativeRuntimeSelection;
  /** Test seams for the pool watch: whether it runs, and how the start ends. */
  readonly watchPool?: boolean;
  readonly exitOnPoolEnd?: () => void;
  readonly scope: NativeProjectRunScope;
  readonly composeFile: string;
  readonly targets?: readonly string[];
  readonly envName?: string | null;
  readonly profiles?: readonly string[];
  /**
   * With `profiles` omitted, resolves Compose's own profile sources
   * (`COMPOSE_PROFILES` in the managed env of `envName`, then the shell) for
   * the effective env: the requested one for a fresh start, the retained
   * run's for a retained start (HACK-2338 item 8).
   */
  readonly resolveProfiles?: (
    envName: string | null | undefined
  ) => Promise<NativeProfileSelection>;
  readonly sharedSource: boolean;
  readonly imageTagMode?: "refresh" | "offline";
  readonly restore?: NativeProjectRun;
  readonly onReady?: (
    services: {
      readonly started: readonly string[];
      readonly completed: readonly string[];
      /**
       * `warming` after a started return (the owner has not reported every goal
       * met yet), `ready` with `--wait`. One field a script can read.
       */
      readonly readiness: "warming" | "ready";
      /** Routed services whose routes are not checked yet; empty when ready. */
      readonly warming: readonly string[];
    },
    addresses: readonly string[]
  ) => void | Promise<void>;
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
  /**
   * The gcloud consent was explicitly withheld for this command (an empty
   * `HACK_NATIVE_GCLOUD_ADC=`). A retained run that recorded a selection then
   * refuses instead of restoring it.
   */
  readonly gcloudWithheld?: boolean;
  /** Public instance identity delivered as runtime host metadata; omitted delivers none. */
  readonly runtimeMetadata?: NativeRuntimeMetadataSelection;
  readonly before: (
    input: NativeProjectInput,
    signal: AbortSignal
  ) => Promise<Hooks>;
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
  /**
   * The graph start budget in seconds (see `native-graph-start-budget.ts`);
   * 300 when omitted.
   */
  readonly startTimeoutSeconds?: number;
  /**
   * `hack up --wait` (see `native-up-wait.ts`): return once every goal is met and
   * every route answers, as before. Otherwise the start returns once every
   * service has started: the mapping, hooks, down-hook debt and the detached
   * release happen then, and route checks follow when the owner reports ready.
   */
  readonly waitForReady?: boolean;
  readonly dependencies?: Partial<Dependencies>;
  /**
   * Recovers this instance's run when the pool stopped under it (HACK-2456):
   * `hack down --recover`, which starts the pool and stops the run with data
   * retained. Called at most once, only when the retained preflight refuses
   * `graph_foreground_owner_exited` and the pool is stopped. Omitted keeps
   * that refusal.
   */
  readonly recoverStoppedPool?: () => Promise<void>;
};

/**
 * The credential adapter replaces its recognized mounts after lifecycle hooks.
 * The pre-hook static review sees the input it will produce: the same mount
 * removal, with nothing read (HACK-2324; the review refused those
 * home-relative mounts). Without a recognized mount the input is unchanged.
 */
async function staticReviewInput(opts: {
  readonly input: NativeProjectInput;
  readonly gcloud: NativeGcloudSelection | undefined;
  readonly adapt: Dependencies["adaptGcloud"];
}): Promise<NativeProjectInput> {
  if (!(opts.gcloud && hasNativeGcloudCredentialMount(opts.input))) {
    return opts.input;
  }
  return (
    await opts.adapt({
      input: opts.input,
      mode: opts.gcloud.mode,
      deliver: false,
    })
  ).input;
}

/**
 * The services the reviewed plan leaves out by profile. Selected profile
 * names are shown only when the Compose file declares them; COMPOSE_PROFILES
 * may come from decrypted managed env, so any other name is only counted.
 */
function emitNativeLeftOutNotice(opts: {
  readonly plan: unknown;
  readonly compose: string;
  readonly profiles: readonly string[];
  /** Undeclared COMPOSE_PROFILES names already dropped; counted with the rest. */
  readonly ignored: number;
  readonly source: NativeProfileNoticeSource;
  readonly warn: (line: string) => void;
}): void {
  const names = nativeNoticeProfileNames({
    profiles: opts.profiles,
    source: opts.source,
  });
  emitNativeProfileNotice(
    {
      kind: "left-out",
      services: nativeInactiveServices(opts.plan),
      profiles: names.shown,
      hiddenProfiles: names.hidden + opts.ignored,
      source: opts.source,
    },
    opts.warn
  );
}

/** Guest CPU allocation is fixed by the runtime profile (provider/profile.rs). */
function nativePoolBuildCpus(pool: unknown): number {
  if (isRecord(pool)) {
    if (pool.profile === "development") {
      return 4;
    }
    if (pool.profile === "research") {
      return 2;
    }
  }
  return 1;
}

/**
 * Once per start, when the pool runs with hot reload on shared source off, or
 * forced on over a large share: printed, or handed to a detached launcher.
 */
function emitNativeHotReloadNotice(
  pool: unknown,
  warn: (line: string) => void
): void {
  const notice = nativeHotReloadNoticeFromPool(pool);
  if (notice && !nativeDetachedUpHotReload(notice)) {
    warn(renderNativeHotReloadNotice(notice));
  }
}

/** Prints a profile notice, or hands it to the launcher of a detached owner. */
function emitNativeProfileNotice(
  notice: NativeProfileNotice,
  warn: (line: string) => void
): void {
  if (nativeDetachedUpProfileNotice(notice)) {
    return;
  }
  const line = renderNativeProfileNotice(notice);
  if (line) {
    warn(line);
  }
}

/**
 * The profiles this start uses and where they came from (HACK-2338 item 8).
 * An explicit `--profile` is used as selected. Otherwise a fresh start uses
 * the profiles Compose would (managed env, then shell), and a retained or
 * restored run keeps its recorded profiles: up and restart never replace its
 * data with another selection. When the environment now selects different
 * ones, a notice says so and how to change them, instead of refusing.
 */
async function chooseNativeStartupProfiles(opts: {
  readonly requested: readonly string[] | undefined;
  readonly selected: readonly string[];
  /** A restore (restart) or a retained run keeps its recorded profiles. */
  readonly restore: NativeProjectRun | undefined;
  readonly retained: NativeProjectRun | null | undefined;
  readonly envName: string | null | undefined;
  readonly resolve:
    | ((envName: string | null | undefined) => Promise<NativeProfileSelection>)
    | undefined;
  readonly notify: (notice: NativeProfileNotice) => void;
}): Promise<{
  readonly profiles: readonly string[];
  readonly source: NativeProfileNoticeSource;
  /** Undeclared COMPOSE_PROFILES names dropped before use; counted only. */
  readonly ignored: number;
}> {
  const kept = opts.restore !== undefined || Boolean(opts.retained);
  if (opts.requested !== undefined) {
    return {
      profiles: opts.selected,
      source: kept ? "retained" : "cli",
      ignored: 0,
    };
  }
  const fromEnv = opts.resolve ? await opts.resolve(opts.envName) : undefined;
  if (fromEnv?.secretIgnored) {
    opts.notify({ kind: "secret-selector" });
  }
  if (!kept) {
    return fromEnv && fromEnv.source !== "none"
      ? {
          profiles: normalizeNativeProfiles(fromEnv.profiles),
          source: fromEnv.source,
          ignored: fromEnv.ignoredUndeclared ?? 0,
        }
      : { profiles: opts.selected, source: "none", ignored: 0 };
  }
  if (
    fromEnv &&
    (fromEnv.source === "managed-env" || fromEnv.source === "shell")
  ) {
    const selected = normalizeNativeProfiles(fromEnv.profiles);
    if (JSON.stringify(selected) !== JSON.stringify(opts.selected)) {
      // Environment-selected and retained names are counted, never shown.
      const shownSelected = nativeNoticeProfileNames({
        profiles: selected,
        source: fromEnv.source,
      });
      const shownRetained = nativeNoticeProfileNames({
        profiles: opts.selected,
        source: "retained",
      });
      opts.notify({
        kind: "retained",
        retained: shownRetained.shown,
        hiddenRetained: shownRetained.hidden,
        selected: shownSelected.shown,
        hiddenSelected: shownSelected.hidden,
        source: fromEnv.source,
      });
    }
  }
  return { profiles: opts.selected, source: "retained", ignored: 0 };
}

/**
 * A dropped branch site: printed in full in the foreground (as Compose
 * does); a detached owner hands its launcher names and a count only.
 */
function emitNativeBranchDroppedNotice(
  notice: string,
  details: BranchDroppedSites,
  warn: (line: string) => void
): void {
  if (!nativeDetachedUpBranchDropped(details)) {
    warn(notice);
  }
}

/** Request the extension from the pinned owner and confirm its combined receipt. */
async function extendNativeProjectGraph({
  opts,
  deps,
  extension,
  input,
  review,
  cacheFlags,
  routeFlags,
  readinessArgs,
  budgetSeconds,
  progress,
  signal,
  admitted,
}: {
  readonly opts: NativeProjectStartOptions;
  readonly deps: Pick<Dependencies, "invoke">;
  readonly extension: NonNullable<
    Awaited<ReturnType<typeof selectNativeGraphExtension>>
  >;
  readonly input: NativeProjectInput;
  readonly review: NativeProjectReview;
  readonly cacheFlags: readonly string[];
  readonly routeFlags: readonly string[];
  readonly readinessArgs: readonly string[];
  readonly budgetSeconds: number;
  readonly progress: ReturnType<typeof progressReporter>;
  readonly signal: AbortSignal;
  readonly admitted: () => void;
}): Promise<number> {
  const run = extension.run.run;
  const services = [...nativeReviewedActiveServices(review.report.plan)].sort();
  const delivery = nativeEnvironmentDelivery({
    input: activeNativeDeliveryInput({
      input,
      reviewedPlan: review.report.plan,
    }),
    planId: review.planId,
    reviewedPlan: review.report.plan,
    run,
  });
  progress({ phase: "services", services });
  admitted();
  try {
    const response = await deps.invoke({
      runtime: opts.runtime,
      cwd: opts.scope.projectRoot,
      args: [
        "graph",
        "extend",
        "--run-id",
        run,
        ...review.projectArgs,
        "--expect-plan",
        review.planId,
        "--expect-generation",
        extension.generation,
        ...nativeSharedSourceFlags(review.report.plan),
        ...cacheFlags,
        ...readinessArgs,
        ...routeFlags,
        ...delivery.flags,
        "--timeout-seconds",
        String(budgetSeconds),
        "--json",
      ],
      privateInput: delivery.payload,
      timeoutMs: budgetSeconds * 1000 + 15_000,
      signal,
    });
    const selected = authoritative(
      {
        journal_incomplete: false,
        receipt: isRecord(response) ? response.receipt : undefined,
      },
      run,
      extension.run.namespace,
      extension.run.planId
    );
    if (
      !(
        selected.owner === extension.run.owner &&
        isRecord(response) &&
        response.ok === true &&
        response.phase === "ready-observed" &&
        isRecord(response.receipt) &&
        isRecord(response.receipt.readiness)
      )
    ) {
      throw unconfirmed("the targeted start result");
    }
    const readiness = response.receipt.readiness;
    if (services.some((service) => !Object.hasOwn(readiness, service))) {
      throw unconfirmed("the targeted start service set");
    }
    await opts.onReady?.(
      {
        started: services.filter(
          (service) => readiness[service] !== "completed"
        ),
        completed: services.filter(
          (service) => readiness[service] === "completed"
        ),
        readiness: "ready",
        warming: [],
      },
      []
    );
    progress({ phase: "ready", services, run, endpoints: [] });
    return 0;
  } finally {
    delivery.payload?.fill(0);
  }
}

async function startNativeProjectAttempt(
  opts: NativeProjectStartOptions,
  observeStartup: () => ReturnType<typeof beginNativeProjectStartupObservation>
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
  const overlayTiming = beginUpTiming("cli.env.overlay");
  await refusePendingFreshStart(opts.restore, opts.scope, deps.loadRestart);
  const select = () =>
    selectNativeStartup({
      runtime: opts.runtime,
      scope: opts.scope,
      restore: opts.restore,
      envName: opts.envName,
      profiles: opts.profiles,
      requestedProfiles,
      targets: opts.targets,
      aws: opts.aws,
      gcloud: opts.gcloud,
      gcloudWithheld: opts.gcloudWithheld,
      load: deps.load,
      invoke: deps.invoke,
      signal: opts.signal,
    });
  const { retained, restore, selection, retainedFlags, extension } =
    await selectNativeStartupRecoveringStoppedPool({
      select,
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      invoke: deps.invoke,
      recover: opts.recoverStoppedPool,
      warn: deps.warn,
      signal: opts.signal,
      poolBootEnded: deps.poolBootEnded,
      endedBootOwnerWaitMs: deps.endedBootOwnerWaitMs,
    });
  requireActiveStartup(opts.signal);
  const runtimeMetadata = nativeRuntimeMetadataSelected({
    selection: opts.runtimeMetadata,
    restore,
  });
  if (retained && !extension) {
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
  const profileChoice = await chooseNativeStartupProfiles({
    requested: opts.profiles,
    selected: selection.profiles,
    restore: opts.restore,
    retained,
    envName: selection.envName,
    resolve: opts.resolveProfiles,
    notify: (notice) => emitNativeProfileNotice(notice, deps.warn),
  });
  const profiles = profileChoice.profiles;
  progress({ phase: "input" });
  // Keep ps aware of this frontend while input is read. This advisory marker
  // carries no values and is retired even if admission refuses the input.
  const startupObservation = extension ? undefined : await observeStartup();
  // Read and admit private project inputs before any pool-share or storage
  // mutation. An unsafe env file or public interpolation must have no effects.
  let input = await deps.prepare({
    ...opts.scope,
    composeFile: opts.composeFile,
    envName: selection.envName,
    profiles,
    targets: opts.targets,
    existingImages: extension?.images,
    env: process.env,
  });
  // A down hook of an earlier generation with unknown completion blocks this
  // one before any hook runs; any other leftover record is superseded.
  if (!extension) {
    await deps.admitDownHooks(opts.scope);
  }
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
      onDropped: (notice, details) =>
        emitNativeBranchDroppedNotice(notice, details, deps.warn),
    })
  ).input;
  overlayTiming?.();
  const preflightTiming = beginUpTiming("cli.graph.preflight");
  // Pure build admission before hooks, VM or provider start; refuses when disabled.
  const builds = admitStartBuilds(input, opts);
  const buildServices = new Set(builds.keys());
  // Pre-hook checks (static review, source size, images, bridge capacity) use
  // the input the credential adapter will produce; delivery after the hooks
  // still adapts the original input.
  const reviewInput = await staticReviewInput({
    input,
    gcloud: selection.gcloud,
    adapt: deps.adaptGcloud,
  });
  let specs = prepareNativeProjectServices(
    reviewInput,
    selectedDependencyFile !== undefined,
    buildServices
  );
  // Reused by the final review when its request is the same (HACK-2445).
  const staticSelection = await deps.staticReview({
    runtime: opts.runtime,
    projectRoot: opts.scope.projectRoot,
    composeFile: opts.composeFile,
    input: reviewInput,
    profiles,
    branch: opts.scope.branch,
    deferredRestore: restore !== undefined,
    buildServices,
    invoke: deps.invoke,
    signal: opts.signal,
  });
  await preflightNativeProjectSource({
    runtime: opts.runtime,
    projectRoot: opts.scope.projectRoot,
    signal: opts.signal,
    invoke: deps.invoke,
    // A detached owner hands the line to the launcher, as image notices do.
    notice: (line) => {
      if (!reportNativeImageNotice(line)) {
        deps.warn(line);
      }
    },
  });
  if (!extension) {
    await deps.prepareStorage(opts.scope);
  }
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
  const canonicalImages = await admitNativeProjectImages({
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
  preflightTiming?.();
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
    const inputTiming = beginUpTiming("cli.start.inputs");
    hooks = extension ? undefined : await opts.before(input, controller.signal);
    requireActiveStartup(controller.signal);
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
    const scopedWithoutHostAliases =
      opts.targets &&
      Object.values(hostAliases).every((aliases) => aliases.length === 0);
    const hostDependencies = await readNativeHostDependencies({
      path: scopedWithoutHostAliases ? undefined : selectedDependencyFile,
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
      listenerHooks: hooks?.listenerHooks,
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
      retained: extension ? null : retained,
      scope: opts.scope,
      deps,
      signal: controller.signal,
    });
    inputTiming?.();
    progress({ phase: "runtime" });
    const pool = extension
      ? await deps.invoke({
          runtime: opts.runtime,
          cwd: opts.scope.projectRoot,
          args: ["runtime", "status", "--json"],
          signal: controller.signal,
        })
      : await deps.invoke({
          runtime: opts.runtime,
          cwd: opts.scope.projectRoot,
          args: [
            ...nativeProjectRuntimeUpArgs(opts.scope.projectRoot),
            ...retainedFlags,
            ...(hostDependencies.length > 0
              ? [
                  "--minimum-dependency-sockets",
                  String(
                    new Set(hostDependencies.map((binding) => binding.slot))
                      .size
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
    emitNativeHotReloadNotice(pool, deps.warn);
    requireActiveStartup(controller.signal);
    const resolveTiming = beginUpTiming("cli.graph.resolve");
    const resumed = await verifyNativeResumedRetainedGraph({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      run: extension ? undefined : retained,
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
      onDropped: (notice, details) =>
        emitNativeBranchDroppedNotice(notice, details, deps.warn),
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
      observed: resumed,
    });
    resolveTiming?.();
    progress({ phase: "images" });
    // A restore asks the runtime too: its image is reused only under an unchanged
    // build key, so a Dockerfile edited after `down` is built (HACK-2533).
    let rebuilt = false;
    const built = await resolveNativeBuildImages({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      branch: opts.scope.branch,
      profiles,
      builds,
      specs,
      verified: opts.verifiedBuildImages,
      imageTagMode: opts.imageTagMode,
      guestCpus: nativePoolBuildCpus(pool),
      onBuildSettled: (settled) =>
        progress({ phase: "build-settled", ...settled }),
      signal: controller.signal,
      invoke: deps.build,
      onBuilt: () => {
        rebuilt = true;
      },
      onImageWait: reportNativeImageDownloadWait,
      onNotice: (line) => {
        if (!reportNativeImageNotice(line)) {
          process.stderr.write(`${line}\n`);
        }
      },
    }).catch(async (error: unknown) => {
      if (!(error instanceof NativeBuildRegistryError)) {
        throw error;
      }
      const references = Object.entries(specs).flatMap(([name, spec]) =>
        nativeServiceActive(spec, profiles) &&
        !builds.has(name) &&
        typeof spec.image === "string"
          ? [spec.image]
          : []
      );
      throw await nativeImageBlocker({
        runtime: opts.runtime,
        projectRoot: opts.scope.projectRoot,
        missing: error.reference,
        buildBase: true,
        reason: error.nativeCauseCode,
        references: [...new Set([error.reference, ...references])],
        confirmed: new Set(),
        invoke: deps.invoke,
      });
    });
    await pinNativeProjectImages({
      runtime: opts.runtime,
      projectRoot: opts.scope.projectRoot,
      specs,
      retainedImages: new Map(
        [...retainedImages].filter(([service]) => !built.has(service))
      ),
      canonicalImages,
      profiles,
      amd64Emulation: input.amd64Emulation,
      signal: controller.signal,
      imageTagMode: opts.imageTagMode,
      warn: deps.warn,
      invoke: deps.invoke,
    }).catch((error: unknown) => {
      requireActiveStartup(controller.signal);
      throw error;
    });
    requireActiveStartup(controller.signal);
    // Image work is done: what follows counts against a detached start's
    // budget again (HACK-2351).
    const reviewTiming = beginUpTiming("cli.graph.prepare");
    progress({ phase: "plan" });
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
      selectedIdentity: staticSelection,
      input: pinned,
      invoke: deps.invoke,
      run: async (review) => {
        requireEnrollmentCompatible(review.report.plan);
        reportNativeRestartPolicyNotices(review.report.plan, deps.warn);
        reportNativeManagedRestartNotices({
          input,
          plan: review.report.plan,
          warn: deps.warn,
        });
        reportNativeIgnoredSettingNotices(review.report.plan, deps.warn);
        reportNativeEnvironmentNotices(input, review.report.plan, deps.warn);
        emitNativeLeftOutNotice({
          plan: review.report.plan,
          compose: input.normalizedComposeJson,
          profiles,
          ignored: profileChoice.ignored,
          source: profileChoice.source,
          warn: deps.warn,
        });
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
        const readinessArgs = nativeReadinessArgs({
          specs,
          plan: review.report.plan,
          initializers: cache.initializers,
          routed: routes.services,
        });
        const budgetSeconds = nativeStartBudgetSeconds(
          opts.startTimeoutSeconds
        );
        if (extension) {
          return await extendNativeProjectGraph({
            opts,
            deps,
            extension,
            input,
            review,
            cacheFlags: cache.flags,
            routeFlags: routes.flags,
            readinessArgs,
            budgetSeconds,
            progress,
            signal: controller.signal,
            admitted: () => {
              servicesRequested = true;
            },
          });
        }
        const directory =
          await nativeRuntimeTempDirectory("hack-native-start-");
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
          // With no bindings there is no host evidence to capture: the ID
          // covers only these selection bytes, and serve recomputes it.
          const plan =
            hostDependencies.length === 0
              ? {
                  dependency_plan_id: emptyNativeDependencyPlanId({
                    plan: review.planId,
                    artifact,
                    artifactSha256: artifactHash,
                  }),
                }
              : await deps.invoke({
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
              startupWait: true,
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
          let retentionTimer: ReturnType<typeof setTimeout> | undefined;
          const retention = new AbortController();
          const scheduleRetention = (attempt: number) => {
            if (retention.signal.aborted || controller.signal.aborted) {
              return;
            }
            retentionTimer = setTimeout(
              () => {
                if (!controller.signal.aborted) {
                  void retainReadyBuildBases({
                    scope: opts.scope,
                    run,
                    runtime: opts.runtime,
                    invoke: deps.invoke,
                    signal: AbortSignal.any([
                      controller.signal,
                      retention.signal,
                    ]),
                  }).then((deferred) => {
                    if (deferred && attempt < 3) {
                      scheduleRetention(attempt + 1);
                    }
                  });
                }
              },
              attempt === 0 ? 2000 : 5000
            ).unref();
          };
          let nativeExitCode: string | undefined;
          let nativeProcessRefusals:
            | readonly NativeProcessRefusal[]
            | undefined;
          // Redacted at receipt; the raw tail is never retained or persisted.
          let startupLogReport = "";
          const services = [
            ...nativeReviewedActiveServices(review.report.plan),
          ].sort();
          progress({ phase: "services", services });
          const servicesRequestedAt = performance.now();
          let stopWatching: (() => Promise<void>) | undefined;
          // `hack up` returns at started unless `--wait`; see `waitForReady`.
          const returnAtStarted = opts.waitForReady !== true;
          // The run mapping is saved once every service has started, in both
          // modes and before the HTTPS lease or anything else acts on the
          // owner's line, so `down` and recovery find a run killed in the
          // window. It is an ownership mapping, not a readiness signal.
          let mapped:
            | {
                readonly readyMapping: NativeProjectRun;
                readonly persistedMapping: NativeProjectRun;
                readonly inspected: unknown;
              }
            | undefined;
          const ensureMapping = async () => {
            if (mapped) {
              return mapped;
            }
            // The owner holds the provider lease until its ready line, so the
            // mapping is read lease-free; `graph inspect` would be refused.
            const inspected = await observeStartingNativeProjectGraph({
              runtime: opts.runtime,
              projectRoot: opts.scope.projectRoot,
              run,
              invoke: deps.invoke,
              signal: controller.signal,
            });
            const readyMapping = authoritative(
              inspected,
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
            // This frontend's lifetime is registered before the mapping becomes
            // selectable, so `down` and recovery always find both. An HTTPS lease
            // is added to the same lifetime (same attempt) when its intent lands.
            finalization ??= await deps.finalization({
              scope: opts.scope,
              run: persistedMapping,
              httpsPort: null,
            });
            mappingAttempted = true;
            await deps.save({
              ...opts.scope,
              run: persistedMapping,
              expected: expectedMapping,
            });
            mapping = persistedMapping;
            mapped = { readyMapping, persistedMapping, inspected };
            return mapped;
          };
          // Takes the HTTPS lease on the lifetime registered before the mapping.
          const acquireHttps = async (
            readyMapping: NativeProjectRun,
            persistedMapping: NativeProjectRun
          ) => {
            // Enrollment must exist before taking a shared lease: release
            // requires independent proof of this exact graph's cleanup.
            if (opts.https) {
              https = await acquireReadyHttps({
                runtime: opts.runtime,
                selection: opts.https,
                run: readyMapping,
                signal: controller.signal,
                invoke: deps.invoke,
                acquire: deps.https,
                attempt: finalization?.token.attempt,
                onIntent: async (identity) => {
                  finalization = await deps.finalization({
                    scope: opts.scope,
                    run: persistedMapping,
                    httpsPort: opts.https?.httpsPort ?? null,
                    httpsLease: identity,
                  });
                  httpsIntent = identity;
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
            // Either way the lifetime registered before the mapping carries the
            // lease from here on (same attempt).
            if (https && finalization?.token.version !== 3) {
              finalization = await deps.finalization({
                scope: opts.scope,
                run: persistedMapping,
                httpsPort: opts.https?.httpsPort,
                httpsLease: https.identity,
              });
            }
          };
          const reclaim = () => {
            // Ready build bases are retained, and superseded build images go,
            // once the new ones run; neither fails or delays the start
            // (HACK-2533). Both need the provider lease, so a started return
            // runs them at the owner's ready line.
            if (
              built.size > 0 &&
              opts.imageTagMode !== "offline" &&
              process.env.HACK_NATIVE_BUILD_RETENTION !== "0"
            ) {
              scheduleRetention(0);
            }
            void reclaimNativeBuildImagesAfterRebuild({
              rebuilt,
              runtime: opts.runtime,
              projectRoot: opts.scope.projectRoot,
              invoke: deps.invoke,
            });
          };
          // After a started return: the owner reported every goal met and
          // released the provider lease, so HTTPS is taken now, the routes are
          // checked and the run is reported ready.
          const allReady = async () => {
            if (mapped) {
              try {
                await acquireHttps(
                  mapped.readyMapping,
                  mapped.persistedMapping
                );
              } catch (error) {
                httpsFailure =
                  error instanceof Error
                    ? error
                    : new ClosedCliError(
                        "Native HTTPS lease acquisition failed."
                      );
                controller.abort();
                return;
              }
            }
            reclaim();
            try {
              await verifyHttpsRoutes(
                https,
                review.report.plan,
                routes.services
              );
              progress({
                phase: "all-ready",
                elapsedMs: performance.now() - servicesRequestedAt,
              });
            } catch (error) {
              progress({
                phase: "routes-not-answering",
                detail: error instanceof Error ? error.message : String(error),
              });
            }
          };
          // The runtime removes a failed start's containers before it returns:
          // keep the graph's status as it stands while the start waits.
          const startupStatus = watchNativeStartupStatus({
            runtime: opts.runtime,
            projectRoot: opts.scope.projectRoot,
            run,
            intervalMs: deps.startupStatusIntervalMs,
            invoke: deps.invoke,
          });
          try {
            await startupObservation?.select({
              run,
              namespace: review.namespace,
              planId: restore?.planId ?? review.planId,
            });
            servicesRequested = true;
            reviewTiming?.();
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
                String(budgetSeconds),
              ],
              privateInput: delivery.payload,
              startupTimeoutMs:
                budgetSeconds * 1000 + NATIVE_START_FRONTEND_SLACK_MS,
              returnAtStarted,
              // The owner's ready line after a started return: routes answer now.
              onAllReady: () => {
                void allReady();
              },
              signal: controller.signal,
              // Down hooks run on the first stop request of a ready graph.
              ...stop?.serve,
              onExitDiagnostic: (diagnostic) => {
                nativeExitCode = diagnostic.nativeCode;
                nativeProcessRefusals = diagnostic.processRefusals;
              },
              onStartupLogs: (logs) => {
                // Names only: a detached owner cannot show output, so the
                // waiting command names the services and points at foreground up.
                nativeDetachedUpFailedServices(logs.map((log) => log.service));
                noteActivityFailedServices(logs.map((log) => log.service));
                startupLogReport = formatNativeStartupLogReport({
                  logs,
                  managedEnvironment: input.managedEnvironment,
                  managedFiles: input.managedFiles,
                });
              },
              // Under --wait: every service started, so the mapping is saved now.
              onStarted: async () => {
                await ensureMapping();
              },
              onReady: async () => {
                const finalizeTiming = beginUpTiming("cli.readiness.finalize");
                // Ready: the startup view is no longer needed.
                void startupStatus.stop();
                const { readyMapping, persistedMapping } =
                  await ensureMapping();
                // The HTTPS owner admits a lease only under the provider lease, for a
                // ready graph: a started return takes it at the owner's ready line.
                if (!returnAtStarted) {
                  await acquireHttps(readyMapping, persistedMapping);
                }
                // The registered lifetime now describes this startup.
                await admission?.retire();
                requireActiveStartup(controller.signal);
                if (!returnAtStarted) {
                  await verifyHttpsRoutes(
                    https,
                    review.report.plan,
                    routes.services
                  );
                }
                if (httpsFailure) {
                  throw httpsFailure;
                }
                if (selectedEnvironment) {
                  await opts
                    .onEnvironmentReady?.({
                      run,
                      fingerprint: selectedEnvironment,
                    })
                    .catch(() => undefined);
                }
                await hooks?.ready?.(controller.signal);
                requireActiveStartup(controller.signal);
                await startupObservation?.();
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
                const httpsPort = servedHttpsPort(https, opts.https);
                finalizeTiming?.();
                await opts.onReady?.(
                  returnAtStarted
                    ? startedEnvelope(
                        startedServiceSummary(readinessArgs, mapped?.inspected),
                        routes.services
                      )
                    : {
                        ...readyServiceSummary(readinessArgs),
                        readiness: "ready",
                        warming: [],
                      },
                  httpsPort === null
                    ? []
                    : nativeReadyRouteHosts({
                        plan: review.report.plan,
                        routed: routes.services,
                      }).flatMap(({ hosts }) =>
                        nativeReadyRouteUrls(hosts, httpsPort)
                      )
                );
                progress({
                  ...readyProgress({
                    services,
                    run,
                    plan: review.report.plan,
                    routed: routes.services,
                    httpsPort,
                  }),
                  ...(returnAtStarted ? { phase: "started" as const } : {}),
                });
                if (!returnAtStarted) {
                  reclaim();
                }
              },
            });
            // A failure after a started return ends the foreground as a start
            // failure does: its log tails and a nonzero exit, not a quiet stop.
            if (
              returnAtStarted &&
              !controller.signal.aborted &&
              (code !== 0 || nativeExitCode !== undefined)
            ) {
              serveFailure = new NativeRuntimeRequestError({
                message: `Native graph startup failed (${nativeExitCode ?? "graph_failed_after_started"}); inspect owned state before retrying.`,
                nativeCode: nativeExitCode,
              });
            }
          } catch (error) {
            serveFailure = error;
          } finally {
            retention.abort();
            clearTimeout(retentionTimer);
            await startupStatus.stop();
            delivery.payload?.fill(0);
            await stopWatching?.();
          }
          try {
            let final: unknown;
            try {
              final = await invokeInspect();
              // The runtime's deadline names no service: say which were not
              // ready, from the last startup status read before it (HACK-2351).
              serveFailure = withGraphTimeoutDetail({
                failure: serveFailure,
                nativeCode: nativeExitCode,
                status: startupStatus.latest(),
                // Serve has settled: the runtime's deadline passed at most now.
                deadlineAt: performance.now(),
                goals: nativeReadinessGoals(readinessArgs),
                waitedMs: performance.now() - servicesRequestedAt,
                budgetSeconds,
              });
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
              if (
                graphCleanupConfirmed &&
                controller.signal.aborted &&
                !httpsFailure
              ) {
                return stopSignals.interruptedExit();
              }
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
async function retainReadyBuildBases(opts: {
  readonly scope: NativeProjectRunScope;
  readonly run: string;
  readonly signal: AbortSignal;
  readonly runtime: NativeRuntimeSelection;
  readonly invoke: typeof invokeNativeRuntime;
}): Promise<boolean> {
  try {
    const result = await opts.invoke({
      runtime: opts.runtime,
      cwd: opts.scope.projectRoot,
      args: [
        "runtime",
        "retain-build-bases",
        "--json",
        ...nativeImagePolicyArgs(),
      ],
      timeoutMs: NATIVE_BUILD_RETENTION_TIMEOUT_MS,
      signal: opts.signal,
    });
    if (
      isRecord(result) &&
      Array.isArray(result.failures) &&
      result.failures.length === 0
    ) {
      return result.deferred === true;
    }
  } catch {
    // Maintenance failures are private lifecycle notes.
  }
  if (opts.signal.aborted) {
    return false;
  }
  await appendLifecycleLogRecord({
    projectDir: opts.scope.projectDir,
    composeProject: opts.run,
    record: {
      timestamp: new Date().toISOString(),
      service: "build-base-retention",
      stream: "meta",
      message:
        "Background build base retention failed. The startup result is unaffected.",
    },
  }).catch(() => undefined);
  return false;
}

/** A failed stop hook replaces the interrupted status, never a startup error. */
function reportForegroundStopFailure(failure: unknown, failed: boolean): void {
  if (failure !== undefined && !failed) {
    throw failure;
  }
}

const START_LOCK_HOLDER =
  /^Provider lease acquisition refused; recorded holder: ([a-z ]+); no operation was admitted\.$/;

function withStartupLockBlocker(error: unknown): unknown {
  if (
    !(error instanceof NativeRuntimeRequestError) ||
    error.nativeCode !== "provider_busy"
  ) {
    return error;
  }
  const holder =
    START_LOCK_HOLDER.exec(error.nativeMessage ?? "")?.[1] ?? "unavailable";
  error.message = [
    "Native startup could not acquire a runtime lock (provider_busy).",
    `Holder: ${holder}.`,
    "Run hack up again after the holder finishes.",
  ].join("\n");
  return error;
}

/** Publish advisory startup evidence until this foreground invocation settles. */
export async function startNativeProject(
  opts: NativeProjectStartOptions
): Promise<number> {
  let finish: (() => Promise<void>) | undefined;
  // Ready and not stopping: the start has nothing left to finish on its own.
  let serving = false;
  // A detached start whose pool boot has ended releases its marker and exits,
  // as a crash would, so the next up or down --recover need not wait for it
  // (HACK-2550). A ready one exits at once, a start still in progress after the
  // grace. A foreground start stays with the user's terminal.
  const stopPoolWatch =
    (opts.watchPool ?? isNativeDetachedOwnerProcess())
      ? watchNativeStartPool({
          home: opts.runtime.home,
          graceMs: () => (serving ? 0 : NATIVE_START_POOL_GRACE_MS),
          onEnded: async () => {
            await finish?.();
            (opts.exitOnPoolEnd ?? (() => process.exit(1)))();
          },
        })
      : undefined;
  try {
    return await startNativeProjectAttempt(
      {
        ...opts,
        onProgress: (event) => {
          // A started return has released its launcher and saved its mapping:
          // like a ready one, it has nothing left to finish on its own.
          if (event.phase === "ready" || event.phase === "started") {
            serving = true;
          } else if (event.phase === "stopping" || event.phase === "stopped") {
            serving = false;
          }
          opts.onProgress?.(event);
        },
      },
      async () => {
        const observation = await beginNativeProjectStartupObservation(
          opts.scope
        );
        finish = observation;
        return observation;
      }
    );
  } catch (error) {
    throw withStartupLockBlocker(error);
  } finally {
    stopPoolWatch?.();
    await finish?.();
  }
}
