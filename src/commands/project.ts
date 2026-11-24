import type { Writable } from "node:stream";
import { resolveNativeStartTimeoutSeconds } from "../backends/native-graph-start-budget.ts";
import { assertAutostartHostCommandsAllowed } from "../lib/autostart-refusal.ts";
import { resolveAutostartTrustedTlsBinds } from "../lib/autostart-trust-mounts.ts";
import { currentCandidateLauncher } from "../lib/candidate-launcher.ts";
import { withCommandTimings } from "../lib/command-timings.ts";
import { reportLooseEnvLayerModes } from "../lib/env-layer-modes.ts";
import {
  assertEnvMigrationFinished,
  migrateLegacyEnvForCommand as migrateLegacyProjectEnv,
  recordEnvMigrationProjectRun,
} from "../lib/env-migration.ts";
import { resolveLifecycleRunner } from "../lib/lifecycle-runner.ts";
import { preflightLifecycleSupervisor } from "../lib/lifecycle-supervisor.ts";
import { childStdoutTarget } from "../lib/machine-stdout.ts";
import {
  canPrintStartSelection,
  printedShellCommand,
  scopedHackCommand,
} from "../lib/printed-shell-command.ts";
import { withProcessDeadline } from "../lib/process-deadline.ts";
import {
  createLifecycleProcessController,
  installLifecycleSignalCleanup,
  LIFECYCLE_SESSION_RETAINED,
  type LifecycleOperationCleanup,
  LifecycleSessionRetainedError,
  resolveLifecycleCommandServiceName,
  resolveLifecycleCwd,
  resolveLifecycleSessionName,
  resolvePersistentLifecycleNames,
  resolveProjectLifecycleDefinitionHash,
  SHARED_HELPER_MUX_UNSUPPORTED_MESSAGE,
  stopLifecycleProcessController,
  wrapLifecyclePersistentCommand as wrapSharedLifecyclePersistentCommand,
} from "../lib/project-lifecycle-controller.ts";
import { enforceProjectPrerequisites } from "../lib/project-prerequisites.ts";
import {
  extendRemoteEnv,
  observedRemoteChoices,
  prepareRemoteDown,
  prepareRemoteStartup,
  recordStartedRemotes,
  remotePrerequisites,
} from "../lib/project-remote-compose.ts";
import {
  prepareRemoteChoices,
  refuseRemoteStart,
} from "../lib/project-remote-selection.ts";
import { projectRemoteStatuses } from "../lib/project-remote-status.ts";
import { printUpTimings } from "../lib/up-timings-output.ts";
import {
  selectLifecycleAddress,
  writeLifecycleStopped,
} from "../ui/lifecycle-closing.ts";
import {
  writeStartBlocker,
  writeUpHookBlocker,
} from "../ui/start-refusal-output.ts";
import { createTextOutput, formatDuration } from "../ui/text-output.ts";
import { writeComposeStarted } from "./compose-lifecycle-closing.ts";
import {
  createComposeUpProgress,
  type HookCompletion,
  type HookStart,
} from "./compose-up-progress.ts";
import { runProjectCopies } from "./project-copies.ts";

export function wrapLifecyclePersistentCommand(
  opts: Parameters<typeof wrapSharedLifecyclePersistentCommand>[0]
): string {
  return wrapSharedLifecyclePersistentCommand(opts);
}

import { realpath, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  autocompleteMultiselect,
  confirm,
  isCancel,
  note,
  password,
  select,
  text,
} from "@clack/prompts";
import { YAML } from "bun";
import {
  type InitAgentIntegrationPrompts,
  runInitAgentIntegrations,
} from "../agents/init-agent-integrations.ts";
import {
  type OnboardingWith,
  parseOnboardingWith,
  runOnboardingHandoff,
} from "../agents/onboarding-handoff.ts";
import { buildOnboardingPrompt } from "../agents/onboarding-prompt.ts";
import { composeLogBackend, lokiLogBackend } from "../backends/log-backend.ts";
import { nativeAdmissionReuseEnvironment } from "../backends/native-admission-reuse.ts";
import { createNativeDependencyOwnerResolver } from "../backends/native-dependency-owners.ts";
import { nativeHotReloadEnvironment } from "../backends/native-hot-reload-notice.ts";
import {
  nativeImageTagStatuses,
  pullNativeProjectImages,
} from "../backends/native-image-tags.ts";
import {
  followAllNativeServices,
  nativeLogPrefix,
} from "../backends/native-log-all.ts";
import { assertNativeLogFlags } from "../backends/native-log-follow.ts";
import {
  declaredComposeProfiles,
  NATIVE_SECRET_PROFILE_SELECTOR_NOTICE,
  nativeNoticeProfileNames,
  nativeRetainedProfilesNotice,
  resolveNativeProfileSelectionForProject,
  selectNativeProfiles,
} from "../backends/native-profile-selection.ts";
import { nativeBuildsEnabled } from "../backends/native-project-builds.ts";
import {
  NATIVE_RECOVERY_RUNTIME_STARTED_NOTE,
  nativeDownEnvironment,
  nativeProjectDown,
} from "../backends/native-project-down.ts";
import {
  requireNativeProjectInternalExtraHostsUnchanged,
  resolveNativeInternalExtraHostSelection,
} from "../backends/native-project-internal-hosts.ts";
import { adoptNativeLifecycleCleanup } from "../backends/native-project-lifecycle.ts";
import {
  followNativeProjectLogs,
  nativeProjectAllLogs,
  nativeProjectLogServices,
  nativeProjectLogs,
  nativeProjectPs,
  nativeStartupProjectPs,
  requireComposeOperationAvailable,
} from "../backends/native-project-observe.ts";
import {
  NATIVE_EXEC_SELECTION_REFUSAL,
  type NativeRunSelection,
  nativeProjectOneOff,
  requireNonEmptyNativeRunOptions,
} from "../backends/native-project-one-off.ts";
import {
  retireNativeRecoveredPublisher,
  verifyNativeFrontendRecovery,
} from "../backends/native-project-recovery.ts";
import { restartNativeProject } from "../backends/native-project-restart.ts";
import {
  nativeRestartSelection,
  preflightNativeRestart,
} from "../backends/native-project-restart-preflight.ts";
import {
  type NativeProjectRunScope,
  nativeForeignHomeRefusal,
  nativeProjectStartupPending,
} from "../backends/native-project-run.ts";
import {
  nativeAdaptationCandidates,
  resolveNativeAdaptationSelection,
  resolveNativeHostSettings,
  resolveNativeStatusHttpsPort,
} from "../backends/native-project-settings.ts";
import { preflightNativeProjectSource } from "../backends/native-project-source-preflight.ts";
import {
  NativeStartupCanceledError,
  type NativeStartupProgress,
  startNativeProject,
} from "../backends/native-project-start.ts";
import {
  invokeNativeRuntime,
  resolveNativeRuntimeSelection,
} from "../backends/native-runtime-client.ts";
import { requireNativeSetup } from "../backends/native-runtime-setup.ts";
import type { NativeServiceExit } from "../backends/native-service-exit-monitor.ts";
import {
  buildComposeArgs,
  composeRuntimeBackend,
} from "../backends/runtime-backend.ts";
import type { CliContext, CommandArgs } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { resolveRequestedEnvName } from "../cli/env-selection.ts";
import {
  optBranch,
  optDetach,
  optEnv,
  optFollow,
  optJson,
  optNoFollow,
  optOpenPreference,
  optPath,
  optPretty,
  optProfile,
  optProject,
  optSince,
  optTail,
  optUntil,
  optUse,
} from "../cli/options.ts";
import {
  parseProjectSelectorOption,
  resolveRegisteredProjectOption,
} from "../cli/project-selector.ts";
import { globalUp } from "../commands/global.ts";
import {
  DEFAULT_GRAFANA_HOST,
  DEFAULT_INGRESS_NETWORK,
  DEFAULT_NEW_PROJECT_TLD,
  DEFAULT_OAUTH_ALIAS_TLD,
  DEFAULT_PROJECT_TLD,
  GLOBAL_CADDY_DIR_NAME,
  HACK_PROJECT_DIR_PRIMARY,
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_LEGACY_FILENAME,
  PROJECT_ENV_CONFIG_DEFAULT_FILENAME,
  PROJECT_ENV_CONTRACT_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../constants.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import {
  type InitComposeBackend,
  renderCompose,
  TODO_IMAGE_SENTINEL,
} from "../init/compose.ts";
import type { ServiceCandidate } from "../init/discovery.ts";
import { discoverRepo } from "../init/discovery.ts";
import {
  buildSuggestedCommand,
  guessDefaultPort,
  guessRole,
  guessServiceName,
  inferPortFromScript,
} from "../init/heuristics.ts";
import type {
  InitDiscoveryFinding,
  PortCollisionDraft,
} from "../init/validation.ts";
import {
  buildDiscoveryHeaderComments,
  buildExistingComposeFindings,
  dedupeCandidates,
  describeUnknownRuntimeComment,
  detectBackingServices,
  detectPackageRuntime,
  findExistingComposeFiles,
  reassignCollidingPorts,
  reportInitDiscoveryFindings,
} from "../init/validation.ts";
import {
  noteActivityBranch,
  noteActivityFailedServices,
} from "../lib/activity-log.ts";
import {
  answerExistingRequest,
  parseBackgroundRequest,
} from "../lib/background-command/launch.ts";
import {
  applyBranchToHost,
  applyBranchToHosts,
  BranchCaddyHostsError,
  branchServiceCaddyLabels,
} from "../lib/branch-hosts.ts";
import { recordBranchUsage } from "../lib/branch-usage.ts";
import { resolveEffectiveBranch } from "../lib/branches.ts";
import { warnSharedCaddyHosts } from "../lib/caddy-host-claims.ts";
import {
  type CliResult,
  emitCliResult,
  errorResult,
  errorResultFromUnknown,
  HackCliError,
  okResult,
} from "../lib/cli-result.ts";
import { runningComposeDirectAccess } from "../lib/compose-direct-access.ts";
import {
  buildComposeDownFailure,
  countDistinctRunningServices,
  parseComposeDownTimeoutFlag,
  resolveComposeDownCapMs,
  resolveComposeDownTimeoutSeconds,
} from "../lib/compose-down-budget.ts";
import {
  confirmComposeDownStopped,
  describeUnconfirmedComposeDown,
  listComposeProjectContainers,
} from "../lib/compose-down-confirmation.ts";
import {
  type ComposeEnginePreflightDeps,
  preflightComposeEngine,
  preflightSharedNetworks,
} from "../lib/compose-engine-preflight.ts";
import {
  composeEnvOverridePath,
  inspectComposeEnvOverrideAtRest,
  removePlaintextComposeEnvOverride,
  writeComposeEnvOverride,
} from "../lib/compose-env-at-rest.ts";
import { withComposeServiceEnvFingerprints } from "../lib/compose-env-fingerprint.ts";
import {
  buildComposeDownRetryFailure,
  type ComposeDownRetryFailure,
  classifyDownObservation,
  type DownObservation,
  downIncompleteMessage,
  type InstanceContainerListing,
  type InstanceNetworkListing,
  parseComposePsInstanceContainers,
  resolveInstanceStopProfiles,
  selectOwnedInstanceContainers,
  unionProfiles,
} from "../lib/compose-instance-stop.ts";
import {
  existingInternalOverride,
  internalOverrideStorePath,
  legacyInternalOverridePath,
} from "../lib/compose-internal-override-store.ts";
import { renderComposeEnvReferenceOverride } from "../lib/compose-managed-env.ts";
import {
  effectiveComposeProfiles,
  readComposeInterpolationEnv,
  readComposeOneShotGraph,
  runningOneShots,
  waitingDependents,
} from "../lib/compose-oneshot-progress.ts";
import { resolveComposeProjectName } from "../lib/compose-project-name.ts";
import {
  composeEnvValuesToRedact,
  composePsTextFallbackAllowed,
  parseComposePsJson,
  readComposePs,
  readComposePsResult,
} from "../lib/compose-ps-result.ts";
import {
  type ComposeStartupBudgets,
  type ComposeStartupFailure,
  type ComposeStartupPhase,
  composeStartupFailure,
  DEFAULT_COMPOSE_IMAGE_TIMEOUT_MS,
  DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS,
  describeComposeStartupBudgets,
  resolveComposeImageTimeoutMs,
  resolveComposeStartupCeilingMs,
  resolveComposeStartupTimeoutMs,
} from "../lib/compose-startup-budget.ts";
import {
  buildStartupIncompleteMessage,
  type ComposeServiceState,
  classifyComposeStartupState,
  waitForComposeStartupState,
} from "../lib/compose-startup-state.ts";
import { resolveGlobalHackDir } from "../lib/config-paths.ts";
import { annotateEmulatedPsItems } from "../lib/container-architecture.ts";
import { resolveDefaultDomain } from "../lib/default-domain.ts";
import {
  resolveDependencyCacheBootstrapServices,
  resolveDependencyCacheOverride,
  resolveDependencyCacheProgress,
} from "../lib/dependency-cache.ts";
import {
  bootstrapDependencyCaches,
  dependencyCacheBootstrapFailure,
} from "../lib/dependency-cache-bootstrap.ts";
import {
  type CacheVolumeKept,
  removeDisposableCacheVolumes,
} from "../lib/disposable-cache-volumes.ts";
import { dockerHelperRunEnvironment } from "../lib/docker-helper-environment.ts";
import { parseDurationMs } from "../lib/duration.ts";
import {
  isSlimExecutionMode,
  renderSlimModeUnavailableMessage,
} from "../lib/execution-mode.ts";
import { installForegroundTerminationGuard } from "../lib/foreground-termination-guard.ts";
import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFileAtomicIfChanged,
  writeTextFileIfChanged,
} from "../lib/fs.ts";
import { ensureHackGitInfoExclude } from "../lib/git-info-exclude.ts";
import {
  LOGGING_OFF_CODE,
  lokiBaseUrl,
  renderLoggingOffMessage,
  resolveGlobalLoggingForHome,
} from "../lib/global-logging.ts";
import { resolveInstalledGrafanaHost } from "../lib/global-service-host.ts";
import { getString, isRecord } from "../lib/guards.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import {
  resolveHackEnv,
  selectHackEnvValues,
  upsertDotEnvValue,
} from "../lib/hack-env.ts";
import { initProjectExistsError } from "../lib/init-existing-project.ts";
import { canPrompt, requireInteractive } from "../lib/interactivity.ts";
import { resolveInternalExtraHosts } from "../lib/internal-extra-hosts.ts";
import { parseJsonLines } from "../lib/json-lines.ts";
import { runLifecycleCommandChild } from "../lib/lifecycle-command-child.ts";
import {
  beginLifecycleProgress,
  closeLifecycleProgress,
  isLifecycleProgressRequested,
  prepareLifecycleProgress,
  reportLifecycleProgress,
} from "../lib/lifecycle-progress.ts";
import {
  createLifecycleLogSink,
  drainLifecycleOutput,
  type LifecycleLogSink,
  readLifecycleState,
  resolveLifecycleComposeProjectName,
  resolveLifecycleLogPath,
} from "../lib/lifecycle-runtime.ts";
import {
  appendHackHostTrustEnvironment,
  findHackHostTrustBundlePath,
} from "../lib/local-ca.ts";
import {
  reportNativeLocalDirectories,
  trackNativeLocalDirectories,
  withProjectLocalDirectories,
} from "../lib/local-directories-project.ts";
import { noteBrowserTargetsForLocalNetworkHint } from "../lib/local-network-hint.ts";
import {
  buildLogSelector,
  LOKI_FOLLOW_EMPTY_NOTICE_DELAY_MS,
  type LogsCommandSelectors,
  type LogsCommandTarget,
  quoteShellWord,
  renderEmptyLokiFollowNotice,
  resolveShouldTryLoki,
  resolveUseLoki,
  runLokiSnapshotWithFallback,
} from "../lib/logs.ts";
import { MissingProjectContextError } from "../lib/missing-project-error.ts";
import {
  readNativeComposeDocument,
  refuseNativeComposeBackendFeatures,
} from "../lib/native-compose-backend-features.ts";
import { tryNativeComposeCommand } from "../lib/native-compose-command.ts";
import { tryNativeComposeOpen } from "../lib/native-compose-open.ts";
import {
  isNativeDetachedOwnerProcess,
  nativeDetachedOwnerArgs,
  nativeDetachedUpHookFailed,
  nativeDetachedUpKeepsHookOutput,
  nativeDetachedUpPrestart,
  nativeDetachedUpProgress,
  nativeDetachedUpReady,
  startNativeDetachedUp,
} from "../lib/native-detached-up.ts";
import {
  createNativeEnvFingerprintEntry,
  createNativeEnvFingerprintSession,
} from "../lib/native-env-fingerprint-state.ts";
import { refuseUnsupportedNativeUpOptions } from "../lib/native-up-refusals.ts";
import { readNodesRegistry } from "../lib/nodes-registry.ts";
import {
  parseOpenHostPreference,
  resolvePreferredOpenHost,
} from "../lib/open-host.ts";
import { openUrl, urlOpenerAvailable } from "../lib/os.ts";
import {
  defaultProjectSlugFromPath,
  findProjectContext,
  findRepoRootForInit,
  type ProjectLifecycleCommand,
  readProjectConfig,
  readProjectDevHost,
  resolveProjectOauthAliasHost,
  resolveProjectRouteBaseHosts,
  resolveWorktreeAutoBranch,
  sanitizeBranchSlug,
  sanitizeProjectSlug,
} from "../lib/project.ts";
import {
  describeUnmigratedLegacyDotenv,
  discoverComposeServiceNames,
  ensureHackDirGitignore,
  findUnmigratedLegacyDotenv,
  finishImplicitLegacyEnvMigration,
  HACK_DIR_GITIGNORE_READ_ONLY_WARNING,
  hasUnmigratedLegacyDotenv,
  ProjectEnvKeyMissingError,
  projectEnvConfigExists,
  resolveProjectEnvConfig,
  selectProjectEnvValuesForExecutionTarget,
} from "../lib/project-env-config.ts";
import { assertProjectEnvLayerPath } from "../lib/project-env-layer-path.ts";
import {
  parseRequestedTarget,
  resolveProjectExecutionTarget,
} from "../lib/project-execution.ts";
import {
  assertLegacyProjectDiscovery,
  assertLegacyProjectInputFamily,
} from "../lib/project-input-selection.ts";
import {
  readProjectRuntimeStateEntry,
  removeProjectRuntimeStateEntry,
  resolveComposeExecStaleEnvWarning,
  updateProjectRuntimeServiceEnvFingerprints,
  upsertProjectRuntimeStateEntry,
} from "../lib/project-runtime-state.ts";
import {
  captureSharedHelperShutdownGeneration,
  createSharedHelperSessionOwnership,
  describeSharedHelperRelease,
  describeSharedHelperStart,
  isSharedHelperReleaseProblem,
  listSharedHelpersHeld,
  markSharedHelperInstanceStopping,
  type ProcessCleanupOutcome,
  releaseProjectSharedHelpers,
  type SharedHelperRelease,
  type SharedHelperSessionOwnership,
  type SharedHelperShutdownGeneration,
  SharedHelperSupersededError,
  startProjectSharedHelpers,
  withTerminationAbort,
} from "../lib/project-shared-helpers.ts";
import {
  readProjectsRegistry,
  setProjectAutostartPaused,
  upsertProjectRegistration,
} from "../lib/projects-registry.ts";
import {
  defaultIngressAddressDeps,
  type IngressAddressResult,
  resolveIngressAddresses,
} from "../lib/proxy-ingress-addresses.ts";
import {
  openProxyLoopbackWarning,
  openUnresolvedHostWarning,
} from "../lib/proxy-loopback.ts";
import {
  discoverDependencyBootstrapServices,
  discoverSuccessfulCompletionServices,
  preflightRegistryCredentials,
  RegistryCredentialPreflightError,
} from "../lib/registry-credential-preflight.ts";
import { canReuseRunningDependencyCache } from "../lib/run-dependency-cache.ts";
import {
  buildRunningEnvMismatchMessage,
  selectEnvForRunningInstance,
} from "../lib/running-env-selection.ts";
import {
  buildRuntimeHostMetadataOverride,
  composeServiceAddresses,
  runtimeHostUrl,
} from "../lib/runtime-host-metadata.ts";
import {
  type RuntimeProject,
  readRuntimeProjects,
} from "../lib/runtime-projects.ts";
import {
  formatSecretStoreDescriptor,
  resolveSecretStore,
  SecretStoreKeyUnavailableError,
} from "../lib/secret-store.ts";
import { exec, findExecutableInPath, run as runShell } from "../lib/shell.ts";
import { assertComposeSpawnEnvFits } from "../lib/spawn-env-limit.ts";
import { parseTimeInput } from "../lib/time.ts";
import {
  buildWorktreeRetargetWarning,
  findSameCheckoutRetargetConflicts,
} from "../lib/worktree-runtime-target.ts";
import {
  type ResolvedMux,
  resolveDefaultBackendName,
  resolveMux,
} from "../mux/mux-resolver.ts";
import {
  renderProjectConfigJson,
  renderProjectEnvConfigYaml,
} from "../templates.ts";
import { display } from "../ui/display.ts";
import type { LogStreamContext } from "../ui/log-stream.ts";
import { logger, setLoggerBackendOverride } from "../ui/logger.ts";
import { canReachLoki, requestLokiDelete } from "../ui/loki-logs.ts";
import {
  backgroundCommandOptions,
  callerIdentity,
  refuseDetachedCacheBootstrap,
  refuseDetachForAuthoredProject,
  runOrStartComposeCommand,
  startNativeBackgroundCommand,
  withBackgroundSweep,
} from "./background-command-start.ts";
import {
  displayComposePs,
  parseComposeExitCode,
} from "./compose-ps-display.ts";
import { withActivity } from "./lifecycle-activity.ts";
import { noteNativeBackendBeta } from "./native-beta-notice.ts";
import { displayNativePs } from "./native-ps-display.ts";
import {
  answerNativeAlreadyRunning,
  explainUnconfirmedNativeDetachedStart,
} from "./native-up-already-running.ts";
import {
  assertAutostartEnvironment,
  assertLoginAutostartCurrent,
  findAutostartRegistration,
  resolveFinalAutostartDownTarget,
  updateNativeAutostartIntent,
  withAutostartCommandLock,
} from "./project-autostart-intent.ts";
import { enableAutostartForUp } from "./project-autostart-opt-in.ts";
import {
  prepareDisposableCachePrune,
  reconcileImplicitDownBranch,
} from "./project-down-safety.ts";
import { runNativeProjectExec } from "./project-exec-native.ts";
import { runNativeDownRemoveData } from "./project-native-remove-data.ts";

/** Regex for valid TLD/service/subdomain labels (lowercase alphanumeric with hyphens). */
const SLUG_LABEL_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Regex to match YAML labels block header. */
const LABELS_LINE_PATTERN = /^(\s*)labels:\s*$/;

/** Regex to extract leading whitespace (indentation). */
const INDENT_PATTERN = /^(\s*)/;

/** Regex to match caddy label line in YAML. */
const CADDY_LABEL_PATTERN = /^(\s*)caddy:\s*(.*)$/;

/** Regex to check if a string starts with a URL scheme (e.g., "http://", "https://"). */
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;
const FINALIZATION_ATTEMPT = /^[a-f0-9]{32}$/;

const optManual = defineOption({
  name: "manual",
  type: "boolean",
  long: "--manual",
  description:
    "Skip discovery and define services manually (or generate a minimal compose in --auto)",
} as const);

const optAuto = defineOption({
  name: "auto",
  type: "boolean",
  long: "--auto",
  description: "Run non-interactive init with sensible defaults",
} as const);

const optName = defineOption({
  name: "name",
  type: "string",
  long: "--name",
  valueHint: "<slug>",
  description: "Project slug (default: repo name)",
} as const);

const optDevHost = defineOption({
  name: "devHost",
  type: "string",
  long: "--dev-host",
  valueHint: "<host>",
  description:
    "DEV_HOST override (new projects use global default_domain, or hack.local)",
} as const);

const optOauth = defineOption({
  name: "oauth",
  type: "boolean",
  long: "--oauth",
  description: "Enable OAuth-safe alias host",
} as const);

const optOauthTld = defineOption({
  name: "oauthTld",
  type: "string",
  long: "--oauth-tld",
  valueHint: "<tld>",
  description: "OAuth alias TLD override (default: gy)",
} as const);

const optNoDiscovery = defineOption({
  name: "noDiscovery",
  type: "boolean",
  long: "--no-discovery",
  description: "Skip discovery and generate a minimal compose",
} as const);

const optWith = defineOption({
  name: "with",
  type: "string",
  long: "--with",
  valueHint: "<claude|codex>",
  description:
    "After init, hand the onboarding prompt to an agent CLI (prints the prompt when the CLI is missing or the run is non-interactive)",
} as const);

const optTarget = defineOption({
  name: "target",
  type: "string",
  long: "--target",
  valueHint: "<auto|local|remote>",
  description:
    "Execution target routing (auto routes to remote when project execution mode requires it)",
} as const);

const optPruneCaches = defineOption({
  name: "pruneCaches",
  type: "boolean",
  long: "--prune-caches",
  description:
    "After down, remove confirmed Compose-owned disposable cache volumes",
} as const);

const optYes = defineOption({
  name: "yes",
  type: "boolean",
  long: "--yes",
  description: "Confirm --prune-caches or --remove-data without prompting",
} as const);
const optRecoverFrontend = defineOption({
  name: "recoverFrontend",
  type: "boolean",
  long: "--recover-frontend",
  description:
    "Recover an interrupted native frontend after proving its owner and effects are gone",
} as const);
const optExpectFinalizationAttempt = defineOption({
  name: "expectFinalizationAttempt",
  type: "string",
  long: "--expect-finalization-attempt",
  valueHint: "<32-hex>",
  description: "Require this exact interrupted native frontend attempt",
} as const);
const optExpectFrontendPid = defineOption({
  name: "expectFrontendPid",
  type: "number",
  long: "--expect-frontend-pid",
  valueHint: "<pid>",
  description:
    "Previously observed frontend PID (required only for legacy v1 state)",
} as const);

const initOptions = [
  optPath,
  optManual,
  optAuto,
  optName,
  optDevHost,
  optOauth,
  optOauthTld,
  optNoDiscovery,
  optWith,
] as const;
const optProgress = defineOption({
  name: "progress",
  type: "boolean",
  long: "--progress",
  description:
    "With --json: stream ndjson progress lines before the result envelope (Compose backend)",
} as const);
const optRefreshImages = defineOption({
  name: "refreshImages",
  type: "boolean",
  long: "--refresh-images",
  description:
    "Native backend: refresh the project's mutable image tags from the registry.",
} as const);
const optImageOffline = defineOption({
  name: "offline",
  type: "boolean",
  long: "--offline",
  description:
    "Native backend: use recorded image resolutions and local archives without contacting a registry.",
} as const);
const pullOptions = [optPath, optProject, optEnv, optProfile, optJson] as const;
const upOptions = [
  optPath,
  optProject,
  optEnv,
  optUse,
  optBranch,
  optDetach,
  optProfile,
  optTarget,
  optJson,
  optProgress,
  optRefreshImages,
  optImageOffline,
  defineOption({
    name: "timings",
    type: "boolean",
    long: "--timings",
    description: "Native backend: print the startup timeline to stderr",
  } as const),
  defineOption({
    name: "timingsFile",
    type: "string",
    long: "--timings-file",
    valueHint: "<file>",
    description:
      "Native backend: write startup timing records to a new JSONL file",
  } as const),
  defineOption({
    name: "always",
    type: "boolean",
    long: "--always",
    description: "Mark this project for machine-local autostart and start it",
  } as const),
] as const;
const downOptions = [
  optPath,
  optProject,
  optEnv,
  optBranch,
  optProfile,
  optTarget,
  defineOption({
    name: "timeout",
    type: "string",
    long: "--timeout",
    valueHint: "<seconds>",
    description:
      "Compose backend: container stop timeout in seconds (0-600) passed to docker compose down --timeout",
  } as const),
  optPruneCaches,
  defineOption({
    name: "removeData",
    type: "boolean",
    long: "--remove-data",
    description:
      "Native backend: delete a stopped project's owned data volumes so the next up starts fresh (asks first)",
  } as const),
  optYes,
  optJson,
  optProgress,
  defineOption({
    name: "recoverNativeCompose",
    type: "boolean",
    long: "--recover",
    description:
      "Explicitly reconcile an interrupted native stop, or stop the services of a native run whose foreground owner exited, while retaining data",
  } as const),
] as const;
const restartOptions = [
  optPath,
  optProject,
  optEnv,
  optBranch,
  optProfile,
  optTarget,
  optJson,
  optProgress,
  optRecoverFrontend,
  optExpectFinalizationAttempt,
  optExpectFrontendPid,
] as const;
const psOptions = [
  defineOption({
    name: "copies",
    type: "boolean",
    long: "--copies",
    description: "Show all checkouts and branch instances of the project",
  }),
  defineOption({
    name: "wide",
    type: "boolean",
    long: "--wide",
    description:
      "Include container, exit code, port and native image pin details",
  }),
  optPath,
  optProject,
  optBranch,
  optProfile,
  optJson,
] as const;
const optWorkdir = defineOption({
  name: "workdir",
  type: "string",
  long: "--workdir",
  valueHint: "<path>",
  description: "Working directory inside the container (docker compose run -w)",
} as const);
const runOptions = [
  optPath,
  optProject,
  optEnv,
  optBranch,
  optWorkdir,
  optProfile,
  ...backgroundCommandOptions,
] as const;
const runPositionals = [
  { name: "service", required: true },
  { name: "cmd", required: false, multiple: true, passthrough: true },
] as const;
const optLoki = defineOption({
  name: "loki",
  type: "boolean",
  long: "--loki",
  description: "Force Loki backend (do not fall back to docker compose logs)",
} as const);

const optCompose = defineOption({
  name: "compose",
  type: "boolean",
  long: "--compose",
  description: "Read logs directly from docker compose (bypass Loki)",
} as const);

const optServices = defineOption({
  name: "services",
  type: "string",
  long: "--services",
  valueHint: "<csv>",
  description:
    "Only these services, comma-separated (e.g. api,www); merged with the service argument",
} as const);

/** Upper bound for `--max-line-bytes`; the reader's own record cap is larger. */
const MAX_LINE_BYTES_LIMIT = 1024 * 1024;

const optMaxLineBytes = defineOption({
  name: "maxLineBytes",
  type: "number",
  long: "--max-line-bytes",
  valueHint: "<n>",
  description:
    "With --json, keep at most n UTF-8 bytes of each line and mark it truncated",
} as const);

const optQuery = defineOption({
  name: "query",
  type: "string",
  long: "--query",
  valueHint: "<logql>",
  description:
    "Raw LogQL selector/query (overrides auto selector built from project + services)",
} as const);

const optLogTimestamps = defineOption({
  name: "timestamps",
  type: "boolean",
  long: "--timestamps",
  description: "Include Engine timestamps in native followed logs",
} as const);

const logsOptions = [
  optLogTimestamps,
  optPath,
  optProject,
  optBranch,
  optFollow,
  optNoFollow,
  optTail,
  optPretty,
  optJson,
  optProfile,
  optCompose,
  optLoki,
  optServices,
  optMaxLineBytes,
  optQuery,
  optSince,
  optUntil,
] as const;
const logsPositionals = [{ name: "service", required: false }] as const;
const openOptions = [
  optPath,
  optProject,
  optBranch,
  optOpenPreference,
  optJson,
] as const;
const openPositionals = [{ name: "target", required: false }] as const;
const serviceLifecyclePositionals = [
  { name: "services", required: false, multiple: true },
] as const;

type InitArgs = CommandArgs<typeof initOptions, readonly []>;
type UpArgs = CommandArgs<typeof upOptions, typeof serviceLifecyclePositionals>;
type DownArgs = CommandArgs<typeof downOptions, readonly []> & {
  /** Pin the reconciled instance through pause, admission and teardown. */
  readonly resolvedAutostartBranch?: { readonly branch: string | null };
};
type RestartArgs = CommandArgs<
  typeof restartOptions,
  typeof serviceLifecyclePositionals
>;
type PsArgs = CommandArgs<typeof psOptions, readonly []>;
type RunArgs = CommandArgs<typeof runOptions, typeof runPositionals>;
type ExecArgs = CommandArgs<typeof runOptions, typeof runPositionals>;
type LogsArgs = CommandArgs<typeof logsOptions, typeof logsPositionals>;
type OpenArgs = CommandArgs<typeof openOptions, typeof openPositionals>;

const initSpec = defineCommand({
  name: "init",
  summary: "Initialize a repo (generate .hack/ with compose + config)",
  group: "Project",
  options: initOptions,
  positionals: [],
  subcommands: [],
} as const);

export const initCommand = withHandler(initSpec, handleInit);

const upSpec = defineCommand({
  name: "up",
  summary: "Start project services (docker compose up)",
  group: "Project",
  options: upOptions,
  positionals: serviceLifecyclePositionals,
  subcommands: [],
} as const);

export const upCommand = withHandler(
  upSpec,
  withBackgroundSweep(withActivity("up", handleUp))
);

const pullSpec = defineCommand({
  name: "pull",
  summary: "Refresh and download project images without starting services",
  group: "Project",
  options: pullOptions,
  positionals: [],
  subcommands: [],
} as const);

export const pullCommand = withHandler(pullSpec, async (input) => {
  try {
    return await handlePull(input);
  } catch (error) {
    if (!input.args.options.json) {
      throw error;
    }
    emitCliResult({ result: buildLifecycleJsonErrorResult({ error }) });
    return 1;
  }
});

const downSpec = defineCommand({
  name: "down",
  summary: "Stop project services (docker compose down)",
  group: "Project",
  options: downOptions,
  positionals: [],
  subcommands: [],
} as const);

export const downCommand = withHandler(
  downSpec,
  withBackgroundSweep(withActivity("down", handleDown))
);

const restartSpec = defineCommand({
  name: "restart",
  summary: "Restart the project or selected services",
  group: "Project",
  options: restartOptions,
  positionals: serviceLifecyclePositionals,
  subcommands: [],
} as const);

export const restartCommand = withHandler(
  restartSpec,
  withActivity("restart", handleRestart)
);

const psSpec = defineCommand({
  name: "ps",
  summary: "Show project services",
  group: "Project",
  options: psOptions,
  positionals: [],
  subcommands: [],
} as const);

export const psCommand = withHandler(psSpec, handlePs);

const runSpec = defineCommand({
  name: "run",
  summary:
    "Run a one-off command in a service container (docker compose run --rm)",
  group: "Project",
  options: runOptions,
  positionals: runPositionals,
  subcommands: [],
} as const);

export const runCommand = withHandler(runSpec, handleRun);

const execSpec = defineCommand({
  name: "exec",
  summary:
    "Run a command in an already-running service container (docker compose exec)",
  group: "Project",
  options: runOptions,
  positionals: runPositionals,
  subcommands: [],
} as const);

export const execCommand = withHandler(execSpec, handleExec);

const logsSpec = defineCommand({
  name: "logs",
  summary:
    "Tail logs (compose by default; Loki for queries/history via --loki/--query)",
  group: "Project",
  options: logsOptions,
  positionals: logsPositionals,
  subcommands: [],
} as const);

export const logsCommand = withHandler(logsSpec, handleLogs);

const openSpec = defineCommand({
  name: "open",
  summary:
    "Open a project URL (OAuth alias by default when enabled; otherwise dev host)",
  group: "Project",
  options: openOptions,
  positionals: openPositionals,
  subcommands: [],
} as const);

export const openCommand = withHandler(openSpec, handleOpen);

function resolveStartDir(ctx: CliContext, pathOpt: string | undefined): string {
  return pathOpt ? resolve(ctx.cwd, pathOpt) : ctx.cwd;
}

export function resolveRequestedComposeServices(opts: {
  readonly requested: readonly string[] | undefined;
  readonly available: readonly string[];
}): readonly string[] {
  const requested = [
    ...new Set(
      (opts.requested ?? []).map((service) => service.trim()).filter(Boolean)
    ),
  ];
  if (requested.length === 0) {
    return [];
  }

  const available = new Set(opts.available);
  const unknown = requested.filter((service) => !available.has(service));
  if (unknown.length > 0) {
    throw new CliUsageError(
      `Unknown compose service${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`
    );
  }
  return requested;
}

export async function resolveProjectForArgs(opts: {
  readonly ctx: CliContext;
  readonly pathOpt: string | undefined;
  readonly projectOpt: string | undefined;
  readonly touchRegistration?: boolean;
}) {
  if (opts.pathOpt && opts.projectOpt !== undefined) {
    throw new CliUsageError("Use either --path or --project (not both).");
  }

  if (opts.projectOpt !== undefined) {
    const fromRegistry = await resolveRegisteredProjectOption({
      projectOpt: opts.projectOpt,
    });
    if (opts.touchRegistration !== false) {
      await touchProjectRegistration(fromRegistry);
    }
    return fromRegistry;
  }

  const startDir = resolveStartDir(opts.ctx, opts.pathOpt);
  const project = await requireProjectContext(startDir);
  if (opts.touchRegistration !== false) {
    await touchProjectRegistration(project);
  }
  return project;
}

function resolveBranchSlug(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) {
    return null;
  }
  const slug = sanitizeBranchSlug(trimmed);
  return slug.length > 0 ? slug : "branch";
}

/**
 * Resolves the branch instance for up/down/restart/ps/run/exec/logs/open so
 * every command in the same checkout targets the same instance: explicit
 * `--branch` wins; otherwise linked git worktrees default to the sanitized
 * current git branch unless `worktree.auto_branch` is false. Primary
 * checkouts are unchanged. Emits a one-line notice when the worktree default
 * kicks in (to stderr when stdout must stay machine-readable: `--json`
 * output or run/exec command passthrough).
 */
export async function resolveEffectiveBranchForCommand(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly branchOption: string | undefined;
  readonly noticeToStderr?: boolean;
  readonly warnOnRetarget?: boolean;
}): Promise<string | null> {
  return (await resolveEffectiveBranchIdentityForCommand(opts)).branch;
}

/**
 * {@link resolveEffectiveBranchForCommand} plus the name the slug came from:
 * the trimmed `--branch` argument, or the linked worktree's git branch.
 * `hack up` and `hack restart` record it so `/v1/projects` can report it
 * (HACK-2281, R20).
 */
export async function resolveEffectiveBranchIdentityForCommand(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly branchOption: string | undefined;
  readonly noticeToStderr?: boolean;
  readonly warnOnRetarget?: boolean;
}): Promise<{ readonly branch: string | null; readonly name: string | null }> {
  const explicit = resolveBranchSlug(opts.branchOption);
  if (explicit) {
    // Login autostart replays the saved slug as --branch; it is not a name
    // the user gave, so the recorded name is kept.
    const name =
      process.env.HACK_AUTOSTART_LOGIN === "1"
        ? null
        : (opts.branchOption ?? "").trim();
    return { branch: explicit, name };
  }
  // A saved null instance means base, even when its checkout is a worktree.
  if (process.env.HACK_AUTOSTART_LOGIN === "1") {
    return { branch: null, name: null };
  }

  const cfg = await readProjectConfig(opts.project);
  const resolved = await resolveEffectiveBranch({
    explicitBranch: null,
    projectRoot: opts.project.projectRoot,
    autoBranchEnabled: resolveWorktreeAutoBranch(cfg),
  });
  if (resolved.source === "detached-worktree") {
    throw new CliUsageError(
      "Detached linked worktree cannot auto-select an isolated instance. Pass --branch <name>, or set worktree.auto_branch=false to target the base instance explicitly."
    );
  }
  if (resolved.source === "worktree" && resolved.branch) {
    const message = `Linked worktree detected → using branch instance "${resolved.branch}" (override with --branch <name>, disable with worktree.auto_branch=false)`;
    if (opts.noticeToStderr === true) {
      process.stderr.write(`${message}\n`);
    } else {
      logger.info({ message });
    }
    if (opts.warnOnRetarget === true) {
      const baseProjectName = await resolveComposeProjectName({
        project: opts.project,
        cfg,
      });
      const targetComposeProject = `${baseProjectName}--${resolved.branch}`;
      const runtime = await readRuntimeProjects({ includeGlobal: false });
      const warning = runtime.ok
        ? buildWorktreeRetargetWarning({
            targetComposeProject,
            conflicts: findSameCheckoutRetargetConflicts({
              currentProjectDir: opts.project.projectDir,
              targetComposeProject,
              runtime: runtime.runtime,
            }),
          })
        : null;
      if (warning) {
        if (opts.noticeToStderr === true) {
          process.stderr.write(`WARNING: ${warning}\n`);
        } else {
          logger.warn({ message: warning });
        }
      }
    }
  }
  // Recorded only when the command runs inside an activity record.
  noteActivityBranch(resolved.branch);
  return {
    branch: resolved.branch,
    name: resolved.source === "worktree" ? resolved.gitBranch : null,
  };
}

export type LifecycleJsonAction = "up" | "down" | "restart";

export type LifecycleJsonData = {
  readonly action: LifecycleJsonAction;
  readonly project: string;
  readonly branch: string | null;
  readonly composeProject: string;
  readonly services: {
    readonly started: readonly string[];
    readonly completed: readonly string[];
    readonly stopped: readonly string[];
    readonly failed: readonly string[];
  };
  readonly cacheVolumesRemoved?: readonly string[];
  readonly cacheVolumesKept?: readonly CacheVolumeKept[];
  /** One-shot dependencies this command stopped mid-run (HACK-2310). */
  readonly interrupted?: readonly string[];
  readonly warnings?: readonly string[];
  readonly durationMs: number;
};

/** One-shot dependencies a down or restart is about to stop mid-run. */
export type OneShotInterruption = {
  readonly services: readonly string[];
  readonly warning: string;
};

/**
 * Before `down` or `restart` stops containers (HACK-2310): one-shot
 * dependencies (migrations, seed jobs) still running would be stopped
 * mid-run, which can leave their work half done. Interactive runs ask first
 * (`proceed: false` when declined); `--json` and non-interactive runs go on
 * and report the warning, which also goes to stderr. A failed read finds
 * nothing to interrupt.
 */
async function checkOneShotInterruption(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly composeProjectName: string | null;
  readonly profiles: readonly string[];
  readonly action: "down" | "restart";
  readonly json: boolean;
  /** A targeted restart interrupts only these services. */
  readonly services?: readonly string[];
  /**
   * The Compose environment the command's other `ps` reads use (delivered
   * values, `COMPOSE_PROFILES`), so a profile-gated one-shot is seen too.
   */
  readonly env?: Readonly<Record<string, string>>;
}): Promise<{
  readonly proceed: boolean;
  readonly interruption?: OneShotInterruption;
}> {
  // Without a completion dependency in any profile there is nothing to
  // interrupt, and no engine read.
  const anyProfile = await readComposeOneShotGraph([opts.project.composeFile]);
  if (anyProfile.oneShots.size === 0) {
    return { proceed: true };
  }
  const ps = await composeRuntimeBackend.psJson({
    composeFiles: [opts.project.composeFile],
    composeProject: opts.composeProjectName,
    profiles: opts.profiles,
    cwd: dirname(opts.project.composeFile),
    ...(opts.env ? { env: { ...opts.env } } : {}),
    all: true,
  });
  // A failed read finds nothing to interrupt: the command goes on unchanged,
  // and its own reads report the engine error as before.
  const entries = ps.exitCode === 0 ? parseComposePsJson(ps.stdout) : null;
  const interpolationEnv = await readComposeInterpolationEnv({
    composeFiles: [opts.project.composeFile],
    env: { ...process.env, ...opts.env },
  });
  const graph = await readComposeOneShotGraph([opts.project.composeFile], {
    activeProfiles: effectiveComposeProfiles({
      cliProfiles: opts.profiles,
      env: interpolationEnv,
    }),
    interpolationEnv,
    // Services with containers run whatever this command's profiles are.
    presentServices: new Set(
      (entries ?? []).flatMap((entry) =>
        typeof entry.Service === "string" ? [entry.Service] : []
      )
    ),
  });
  if (graph.oneShots.size === 0) {
    return { proceed: true };
  }
  const services = (entries ? runningOneShots({ graph, entries }) : []).filter(
    (service) => !opts.services || opts.services.includes(service)
  );
  if (services.length === 0) {
    return { proceed: true };
  }
  const names = services.join(", ");
  const warning = `hack ${opts.action} interrupted the one-shot service ${names} while it was still running; its work (for example migrations) may be incomplete. Check its logs before relying on it.`;
  if (!opts.json && canPrompt()) {
    const ok = await confirm({
      message: `The one-shot service ${names} is still running (for example migrations). hack ${opts.action} stops it mid-run. Continue?`,
      initialValue: false,
    });
    if (isCancel(ok) || !ok) {
      logger.info({
        message: `Not stopped: ${names} keeps running. Run hack ${opts.action} again once hack ps shows it exited.`,
      });
      return { proceed: false };
    }
  }
  logger.warn({ message: warning });
  return { proceed: true, interruption: { services, warning } };
}

/**
 * Shape the `--json` payload for up/down/restart.
 */
export function buildLifecycleJsonData(opts: {
  readonly action: LifecycleJsonAction;
  readonly project: string;
  readonly branch: string | null;
  readonly composeProject: string;
  readonly started?: readonly string[];
  readonly completed?: readonly string[];
  readonly stopped?: readonly string[];
  readonly failed?: readonly string[];
  readonly cacheVolumesRemoved?: readonly string[];
  readonly cacheVolumesKept?: readonly CacheVolumeKept[];
  readonly interruption?: OneShotInterruption;
  readonly durationMs: number;
}): LifecycleJsonData {
  return {
    action: opts.action,
    project: opts.project,
    branch: opts.branch,
    composeProject: opts.composeProject,
    services: {
      started: [...(opts.started ?? [])].sort(),
      completed: [...(opts.completed ?? [])].sort(),
      stopped: [...(opts.stopped ?? [])].sort(),
      failed: [...(opts.failed ?? [])].sort(),
    },
    ...(opts.cacheVolumesRemoved
      ? { cacheVolumesRemoved: [...opts.cacheVolumesRemoved].sort() }
      : {}),
    ...(opts.cacheVolumesKept
      ? { cacheVolumesKept: opts.cacheVolumesKept }
      : {}),
    ...(opts.interruption && opts.interruption.services.length > 0
      ? {
          interrupted: [...opts.interruption.services],
          warnings: [opts.interruption.warning],
        }
      : {}),
    durationMs: opts.durationMs,
  };
}

/**
 * Snapshot compose service states (best-effort) for `--json` payloads.
 */
async function readComposeServiceStates(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly composeProjectName: string | null;
  readonly profiles: readonly string[];
  readonly services?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly strict?: boolean;
}): Promise<readonly ComposeServiceState[]> {
  const res = await composeRuntimeBackend.psJson({
    composeFiles: [opts.project.composeFile],
    composeProject: opts.composeProjectName,
    profiles: opts.profiles,
    cwd: dirname(opts.project.composeFile),
    all: true,
    env: opts.env,
  });
  let entries: Record<string, unknown>[];
  if (opts.strict) {
    const read = readComposePsResult({
      result: res,
      redactValues: Object.values(opts.env ?? {}),
    });
    if (!read.ok) {
      throw read.error;
    }
    entries = read.entries;
  } else {
    if (res.exitCode !== 0) {
      return [];
    }
    entries = parseBestEffortComposePsJson(res.stdout);
  }
  const serviceFilter = opts.services ? new Set(opts.services) : null;
  return entries
    .map((entry) => ({
      containerId: getString(entry, "ID") ?? "",
      service: getString(entry, "Service") ?? "",
      state: (getString(entry, "State") ?? "").toLowerCase(),
      exitCode: parseComposeExitCode(entry.ExitCode),
    }))
    .filter(
      (entry) =>
        entry.service.length > 0 &&
        (serviceFilter === null || serviceFilter.has(entry.service))
    );
}

function parseBestEffortComposePsJson(
  stdout: string
): Record<string, unknown>[] {
  const parsed = parseComposePsJson(stdout);
  if (parsed !== null) {
    return parsed;
  }
  const trimmed = stdout.trim();
  if (trimmed.startsWith("[")) {
    try {
      const value: unknown = JSON.parse(trimmed);
      if (Array.isArray(value)) {
        return value.filter(isRecord);
      }
    } catch {
      // Fall through to best-effort JSON lines parsing.
    }
  }
  return parseJsonLines(stdout);
}

function startupSnapshotIsIncomplete(opts: {
  readonly states: readonly ComposeServiceState[];
  readonly failed: readonly string[];
}): boolean {
  return opts.states.length === 0 || opts.failed.length > 0;
}

function reportComposeStartupBudget(opts: {
  readonly budgets: ComposeStartupBudgets;
  readonly detach: boolean;
  readonly repair?: boolean;
}): void {
  if (opts.detach) {
    logger.step({
      message: `Compose ${opts.repair ? "repair" : "startup"}: ${describeComposeStartupBudgets(opts.budgets)}`,
    });
  }
}

/** Resolve both detached Compose budgets before any project side effect. */
function resolveDetachedComposeBudgets(detach: boolean): ComposeStartupBudgets {
  if (!detach) {
    return {
      imageTimeoutMs: DEFAULT_COMPOSE_IMAGE_TIMEOUT_MS,
      startupTimeoutMs: DEFAULT_COMPOSE_STARTUP_TIMEOUT_MS,
    };
  }
  const startupTimeoutMs = resolveComposeStartupTimeoutMs();
  return {
    imageTimeoutMs: resolveComposeImageTimeoutMs(),
    startupTimeoutMs,
    startupCeilingMs: resolveComposeStartupCeilingMs({ startupTimeoutMs }),
  };
}

/**
 * Apply the project's `compose.startupTimeoutMs` and `compose.startupCeilingMs`
 * (HACK-2310) once the project is known. The host variables still win; an
 * invalid project value is refused like an invalid variable.
 */
async function withProjectComposeBudgets(opts: {
  readonly budgets: ComposeStartupBudgets;
  readonly detach: boolean;
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
}): Promise<ComposeStartupBudgets> {
  if (!opts.detach) {
    return opts.budgets;
  }
  const compose = (await readProjectConfig(opts.project)).compose;
  if (!compose) {
    return opts.budgets;
  }
  const startupTimeoutMs = resolveComposeStartupTimeoutMs({
    projectValue: compose.startupTimeoutMs,
  });
  return {
    ...opts.budgets,
    startupTimeoutMs,
    startupCeilingMs: resolveComposeStartupCeilingMs({
      startupTimeoutMs,
      projectValue: compose.startupCeilingMs,
    }),
  };
}

/**
 * Record the last detached Compose phase the backend entered, so a failure is
 * attributed to it. A backend that never reports a phase is treated as `start`.
 */
function trackComposeStartupPhase(): {
  readonly onStartupPhase: (phase: ComposeStartupPhase) => void;
  /** The backend saw a one-shot dependency running (HACK-2310). */
  readonly onStartupProgress: () => void;
  /** The start was cut short with these one-shots still running. */
  readonly onStartupStalled: (inProgress: readonly string[]) => void;
  readonly phase: () => ComposeStartupPhase;
  readonly startedAt: () => number;
  /**
   * When the start phase last made progress: its start, or the last time a
   * one-shot dependency was seen running. Budgets that follow the Compose
   * start measure from here, so a long migration does not consume them.
   */
  readonly progressAt: () => number;
  readonly inProgress: () => readonly string[];
} {
  let current: ComposeStartupPhase = "start";
  let startedAt = performance.now();
  let progressAt = startedAt;
  let inProgress: readonly string[] = [];
  return {
    onStartupPhase: (phase) => {
      current = phase;
      reportLifecycleProgress({
        service: null,
        phase: phase === "images" ? "images" : "starting",
      });
      if (phase === "start") {
        startedAt = performance.now();
        progressAt = startedAt;
      }
    },
    onStartupProgress: () => {
      progressAt = performance.now();
    },
    onStartupStalled: (services) => {
      inProgress = services;
    },
    phase: () => current,
    startedAt: () => startedAt,
    progressAt: () => progressAt,
    inProgress: () => inProgress,
  };
}

function composeStartupFailureDetail(opts: {
  readonly failure: ComposeStartupFailure;
  readonly exitCode: number;
}): Record<string, unknown> {
  return {
    exitCode: opts.exitCode,
    composePhase: opts.failure.phase,
    budgetMs: opts.failure.budgetMs,
    ...(opts.failure.inProgress.length > 0
      ? { inProgress: [...opts.failure.inProgress] }
      : {}),
    budgetEnv: opts.failure.budgetEnv,
  };
}

/**
 * The Compose "startup incomplete" message; also notes the services that
 * did not start in the running action's activity record (names only).
 */
function composeStartupIncompleteMessage(
  opts: Parameters<typeof buildStartupIncompleteMessage>[0]
): string {
  noteActivityFailedServices(opts.failed);
  return buildStartupIncompleteMessage(opts);
}

/**
 * Emit the `--json` envelope for a lifecycle command and map it to the
 * standard 0/1 exit semantics. A started `--progress` stream closes with it
 * as one compact line; otherwise it is the ordinary pretty envelope.
 */
function emitLifecycleResult(opts: {
  readonly result: CliResult<LifecycleJsonData>;
  readonly exitCode: number;
}): number {
  if (closeLifecycleProgress({ result: opts.result })) {
    return opts.exitCode;
  }
  emitCliResult({ result: opts.result });
  return opts.exitCode;
}

export function buildLifecycleJsonErrorResult(opts: {
  readonly error: unknown;
}) {
  if (
    process.env.HACK_AUTOSTART_LOGIN === "1" &&
    (opts.error instanceof SecretStoreKeyUnavailableError ||
      opts.error instanceof ProjectEnvKeyMissingError)
  ) {
    return errorResult({
      code: "E_ENV_KEY_MISSING",
      message:
        "Autostart skipped: a required secret key is unavailable. Run hack up manually.",
    });
  }
  if (opts.error instanceof CliUsageError) {
    return errorResult({ code: "E_USAGE", message: opts.error.message });
  }
  if (opts.error instanceof RegistryCredentialPreflightError) {
    return errorResult({
      code: "E_ENV_KEY_MISSING",
      message: opts.error.message,
      detail: {
        keys: [...new Set(opts.error.missing.map((entry) => entry.key))],
      },
    });
  }
  return errorResultFromUnknown({ error: opts.error });
}

/**
 * Envelope for lifecycle actions that were routed to a remote node — the
 * remote runner owns per-service detail, so the payload reports the routing
 * outcome only.
 */
function emitRemoteLifecycleJson(opts: {
  readonly action: LifecycleJsonAction;
  readonly exitCode: number;
  readonly project: string;
  readonly branch: string | null;
  readonly startedAtMs?: number;
}): number {
  const composeProject = opts.branch
    ? `${opts.project}--${opts.branch}`
    : opts.project;
  beginLifecycleProgress({ project: composeProject });
  if (opts.exitCode !== 0) {
    return emitLifecycleResult({
      result: errorResult({
        code: "E_LIFECYCLE_FAILED",
        message: `Remote ${opts.action} failed (exit ${opts.exitCode})`,
        detail: { remote: true, exitCode: opts.exitCode },
      }),
      exitCode: opts.exitCode,
    });
  }
  return emitLifecycleResult({
    result: okResult({
      data: buildLifecycleJsonData({
        action: opts.action,
        project: opts.project,
        branch: opts.branch,
        composeProject,
        durationMs: Date.now() - (opts.startedAtMs ?? Date.now()),
      }),
    }),
    exitCode: 0,
  });
}

async function buildBranchComposeOverride(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly branch: string;
  readonly devHost: string;
  readonly aliasHost: string | null;
  /** Told about sites a branch instance drops (outside the project's namespaces). */
  readonly onDropped?: (notice: string) => void;
}): Promise<string | null> {
  const yamlText = await readTextFile(opts.project.composeFile);
  if (!yamlText) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlText);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  const servicesRaw = parsed.services;
  if (!isRecord(servicesRaw)) {
    return null;
  }

  const baseHosts = resolveProjectRouteBaseHosts(opts);

  const overrideServices: Record<string, { labels: Record<string, string> }> =
    {};
  let changed = false;

  for (const [serviceName, serviceRaw] of Object.entries(servicesRaw)) {
    if (!isRecord(serviceRaw)) {
      continue;
    }

    const labels = normalizeLabels(serviceRaw.labels);
    if (!labels) {
      continue;
    }

    let branched: Record<string, string> | undefined;
    try {
      branched = branchServiceCaddyLabels({
        service: serviceName,
        labels,
        branch: opts.branch,
        baseHosts,
        onDropped: opts.onDropped,
      });
    } catch (error) {
      if (error instanceof BranchCaddyHostsError) {
        throw new CliUsageError(error.message);
      }
      throw error;
    }
    if (!branched) {
      continue;
    }

    overrideServices[serviceName] = { labels: branched };
    changed = true;
  }

  if (!changed) {
    return null;
  }

  const override = { services: overrideServices };
  const yaml = YAML.stringify(override, null, 2);
  return ensureTrailingNewline(cleanupYaml(yaml));
}

function normalizeLabels(raw: unknown): Record<string, string> | null {
  if (isRecord(raw)) {
    return normalizeLabelRecord(raw);
  }

  if (Array.isArray(raw)) {
    return normalizeLabelList(raw);
  }

  return null;
}

function normalizeLabelRecord(
  raw: Record<string, unknown>
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[k] = String(v);
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeLabelList(
  raw: readonly unknown[]
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const item of raw) {
    const parsed = parseLabelEntry({ item });
    if (!parsed) {
      continue;
    }
    out[parsed.key] = parsed.value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function parseLabelEntry(opts: {
  readonly item: unknown;
}): { readonly key: string; readonly value: string } | null {
  if (typeof opts.item !== "string") {
    return null;
  }
  const idx = opts.item.indexOf("=");
  if (idx <= 0) {
    return null;
  }
  const key = opts.item.slice(0, idx).trim();
  if (key.length === 0) {
    return null;
  }
  const value = opts.item.slice(idx + 1).trim();
  return { key, value };
}

function cleanupYaml(yaml: string): string {
  return yaml.replaceAll(/: \n/g, ":\n");
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function buildComposeEnvInterpolation(key: string): string {
  return `\${${key}}`;
}

function isEnvVarRelevantToServices(opts: {
  readonly services: readonly string[];
  readonly varServices: readonly string[] | null;
}): boolean {
  if (!opts.varServices) {
    return true;
  }
  if (opts.services.length === 0) {
    return true;
  }
  const serviceSet = new Set(opts.services);
  return opts.varServices.some((svc) => serviceSet.has(svc));
}

/**
 * Removes an env override that still holds literal values (written by an
 * earlier Hack version). Best effort: a failure is reported without values and
 * never fails the command; `hack doctor` reports what remains. A file that a
 * saved adoption pins is kept (removing it would break the adoption).
 */
async function scrubPlaintextComposeEnvOverride(opts: {
  readonly projectDir: string;
}): Promise<void> {
  try {
    const result = await removePlaintextComposeEnvOverride({
      projectDir: opts.projectDir,
    });
    if (result.adoptionBound) {
      logger.warn({
        message:
          "Kept .hack/.internal/compose.env.override.yml, which holds env values from an earlier Hack version, because a saved 'hack config adopt' generation pins it (values omitted). Run 'hack doctor' for the supported way to drop them.",
      });
    }
  } catch {
    logger.warn({
      message:
        "Could not remove .hack/.internal/compose.env.override.yml, which holds env values from an earlier Hack version (values omitted). Run 'hack doctor --fix'.",
    });
  }
}

/**
 * For a render with no managed env for any service: removes an override that
 * still holds literal values (see {@link scrubPlaintextComposeEnvOverride}),
 * then replaces a value-free one that remains with an empty override
 * (HACK-2325). Its entries belong to an earlier graph or selection, and a
 * Compose command that loads it from a container's `config_files` label would
 * otherwise merge an environment-only entry for a service that no longer
 * exists. The file is emptied rather than removed because those labels name
 * its path. A literal file that a saved adoption pins is left as the scrub
 * left it.
 */
/**
 * Writes the env override and returns its path, or with `persist: false`
 * returns the path `up` left (nothing when absent) without writing.
 */
async function settleComposeEnvOverride(opts: {
  readonly projectDir: string;
  readonly text: string;
  readonly persist: boolean | undefined;
  /** The Compose file's services; a stored file naming others is left out. */
  readonly serviceNames: readonly string[];
}): Promise<readonly string[]> {
  if (opts.persist === false) {
    // The stored file `up` left. One that still declares a service the
    // Compose file dropped would make Compose reject the model; exec does not
    // need it then, since a running container already has its environment.
    const path = composeEnvOverridePath({ projectDir: opts.projectDir });
    const usable =
      (await pathExists(path)) &&
      (await generatedFilesMatchServices({
        files: [path],
        serviceNames: opts.serviceNames,
      }));
    return usable ? [path] : [];
  }
  await ensureHackGitInfoExclude({ projectDir: opts.projectDir });
  return [
    await writeComposeEnvOverride({
      projectDir: opts.projectDir,
      text: opts.text,
    }),
  ];
}

async function clearComposeEnvOverride(opts: {
  readonly projectDir: string;
}): Promise<void> {
  await scrubPlaintextComposeEnvOverride(opts);
  const atRest = await inspectComposeEnvOverrideAtRest(opts).catch(() => null);
  if (atRest?.kind !== "references") {
    return;
  }
  try {
    await writeComposeEnvOverride({
      projectDir: opts.projectDir,
      text: EMPTY_COMPOSE_ENV_OVERRIDE,
    });
  } catch {
    logger.warn({
      message:
        "Could not empty .hack/.internal/compose.env.override.yml after the last managed env entry was removed; it holds no values. Run 'hack doctor'.",
    });
  }
}

const EMPTY_COMPOSE_ENV_OVERRIDE = "services: {}\n";

async function maybePromptLegacyProjectEnvMigration(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly projectName: string;
  readonly serviceNames: readonly string[];
}): Promise<boolean> {
  await assertEnvMigrationFinished(opts.project);
  if (
    await projectEnvConfigExists({
      projectDir: opts.project.projectDir,
    })
  ) {
    return false;
  }

  const contractPath = resolve(
    opts.project.projectDir,
    PROJECT_ENV_CONTRACT_FILENAME
  );
  if (!(await pathExists(contractPath))) {
    return false;
  }

  if (!canPrompt()) {
    logger.warn({
      message:
        "Legacy env format detected. Run `hack doctor --migrate-env-config` to upgrade to the new env config files.",
    });
    return false;
  }

  const shouldMigrate = await confirm({
    message:
      "Legacy env format detected. Migrate to the new Hack env config files now?",
    initialValue: true,
  });
  if (isCancel(shouldMigrate)) {
    throw new Error("Canceled");
  }
  if (!shouldMigrate) {
    return false;
  }

  const migrated = await migrateLegacyProjectEnv({
    projectRoot: opts.project.projectRoot,
    projectDir: opts.project.projectDir,
    projectName: opts.projectName,
    serviceNames: opts.serviceNames,
    materialize: false,
  });
  const report = await finishImplicitLegacyEnvMigration({
    projectRoot: opts.project.projectRoot,
    projectDir: opts.project.projectDir,
    migrated,
  });
  for (const line of report.lines) {
    logger.info({ message: line });
  }
  return migrated.legacyDetected;
}

/**
 * Services the generated env override declares: every service in the Compose
 * graph, plus any target outside it, in graph order (HACK-2325).
 *
 * The override sits at a stable path that Compose records in each container's
 * `config_files` label, and every Compose command for the instance loads it.
 * Rendering only a command's targets used to drop the other services' entries,
 * so a later Compose command that recreated them (a dependency of a targeted
 * `up`, or a Compose invocation from those labels) did so without their
 * managed env. Rendering the whole graph each time keeps the file a pure
 * function of the graph and the env selection: no merge with earlier state,
 * and a service removed from the graph loses its entry. The file holds only
 * `${NAME}` references; values travel in the Compose process env alone, which
 * then carries the same set a full `up` passes.
 */
function composeEnvOverrideServices(opts: {
  readonly targetServices: readonly string[];
  readonly allServiceNames: readonly string[];
}): readonly string[] {
  return [...new Set([...opts.allServiceNames, ...opts.targetServices])];
}

export async function resolveModernComposeEnvOverrides(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly targetServices: readonly string[];
  readonly allServiceNames: readonly string[];
  readonly envName?: string | null;
  /** See resolveComposeEnvOverrides. */
  readonly persist?: boolean;
}): Promise<{
  readonly composeFiles: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly lifecycleEnv: Readonly<Record<string, string>>;
  readonly preflightEnvByService: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  readonly effectiveEnvName: string | null;
} | null> {
  const modern = await resolveProjectEnvConfig({
    projectRoot: opts.project.projectRoot,
    projectDir: opts.project.projectDir,
    envName: opts.envName,
    serviceNames: opts.allServiceNames,
  });
  // After a successful read, so a refusal stays one line.
  await reportLooseEnvLayerModes({ projectDir: opts.project.projectDir });
  if (!modern) {
    return null;
  }
  const unmigrated = await findUnmigratedLegacyDotenv({
    projectRoot: opts.project.projectRoot,
    projectDir: opts.project.projectDir,
    serviceNames: opts.allServiceNames,
  });
  if (hasUnmigratedLegacyDotenv(unmigrated)) {
    logger.warn({
      message: `This checkout ${describeUnmigratedLegacyDotenv(unmigrated)} in its legacy .hack/.env files, and the env layers don't deliver those values, so services that rely on them may not get them. Run \`hack doctor --migrate-env-config\`, which moves them to this checkout's local layers or says what to change first.`,
    });
  }
  const lifecycleEnv = selectProjectEnvValuesForExecutionTarget({
    resolved: modern,
    scopeName: "global",
    target: "host",
  });
  const preflightEnvByService = Object.fromEntries(
    opts.targetServices.map((service) => [
      service,
      modern.serviceEnv[service] ?? modern.globalEnv,
    ])
  );

  for (const scope of modern.unknownScopes) {
    logger.warn({
      message: `Env config scope "${scope}" does not match a known service in ${opts.project.composeFile}.`,
    });
  }

  // Values travel only through the Compose process env; the file on disk holds
  // `${NAME}` references (see src/lib/compose-env-at-rest.ts).
  // Global values share one reference across services (HACK-1317), so the
  // Compose environment grows with distinct values, not services times keys.
  // The file always covers the whole graph (HACK-2325), whatever the command
  // targets: see composeEnvOverrideServices.
  const override = renderComposeEnvReferenceOverride({
    targetServices: composeEnvOverrideServices(opts),
    globalEnv: modern.globalEnv,
    serviceEnv: modern.serviceEnv,
    effectiveScopes: modern.effectiveMetadata,
  });
  const composeEnv = override
    ? { ...modern.globalEnv, ...override.env }
    : modern.globalEnv;
  // Fail closed before any write or spawn when Compose could not start.
  assertComposeSpawnEnvFits({ env: composeEnv });
  if (override === null) {
    if (opts.persist !== false) {
      await clearComposeEnvOverride({
        projectDir: opts.project.projectDir,
      });
    }
    return {
      composeFiles: [],
      env: modern.globalEnv,
      lifecycleEnv,
      preflightEnvByService,
      effectiveEnvName: modern.selection.effectiveEnv,
    };
  }

  return {
    composeFiles: await settleComposeEnvOverride({
      projectDir: opts.project.projectDir,
      text: override.text,
      persist: opts.persist,
      serviceNames: opts.allServiceNames,
    }),
    env: composeEnv,
    lifecycleEnv,
    preflightEnvByService,
    effectiveEnvName: modern.selection.effectiveEnv,
  };
}

export async function resolveLifecycleEnvForProject(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly projectName: string;
  readonly envName?: string | null;
}): Promise<Readonly<Record<string, string>>> {
  const serviceNames = await discoverComposeServiceNames({
    composeFile: opts.project.composeFile,
  });
  await maybePromptLegacyProjectEnvMigration({
    project: opts.project,
    projectName: opts.projectName,
    serviceNames,
  });
  const modern = await resolveProjectEnvConfig({
    projectRoot: opts.project.projectRoot,
    projectDir: opts.project.projectDir,
    envName: opts.envName,
    serviceNames,
  });
  // After a successful read, so a refusal stays one line.
  await reportLooseEnvLayerModes({ projectDir: opts.project.projectDir });
  if (modern) {
    return selectProjectEnvValuesForExecutionTarget({
      resolved: modern,
      scopeName: "global",
      target: "host",
    });
  }

  const envResolved = await resolveHackEnv({
    projectDir: opts.project.projectDir,
    projectName: opts.projectName,
    envName: opts.envName,
  });
  if (envResolved.contractParseError) {
    logger.warn({
      message: `Failed to parse ${envResolved.contractPath}: ${envResolved.contractParseError}`,
    });
  }
  return selectHackEnvValues({ resolved: envResolved });
}

async function resolveComposeEnvOverrides(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly projectName: string;
  readonly targetServices: readonly string[];
  readonly allServiceNames: readonly string[];
  readonly envName?: string | null;
  /**
   * False for `exec`: resolve the values but neither write nor clear the
   * generated env override; pass the file `up` left, if any. The container
   * already exists, so its environment came from that file.
   */
  readonly persist?: boolean;
}): Promise<{
  readonly composeFiles: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly lifecycleEnv: Readonly<Record<string, string>>;
  readonly preflightEnvByService: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  readonly effectiveEnvName: string | null;
}> {
  await maybePromptLegacyProjectEnvMigration({
    project: opts.project,
    projectName: opts.projectName,
    serviceNames: opts.allServiceNames,
  });
  const modern = await resolveModernComposeEnvOverrides(opts);
  if (modern) {
    return modern;
  }

  const resolved = await resolveHackEnv({
    projectDir: opts.project.projectDir,
    projectName: opts.projectName,
    envName: opts.envName,
  });
  logRelevantLegacyEnvWarnings({
    resolved,
    targetServices: opts.targetServices,
  });
  const preflightEnvByService = Object.fromEntries(
    opts.targetServices.map((service) => {
      const env: Record<string, string> = {};
      for (const value of resolved.values) {
        if (
          value.value !== null &&
          isEnvVarRelevantToServices({
            services: [service],
            varServices: value.services,
          })
        ) {
          env[value.key] = value.value;
        }
      }
      return [service, env];
    })
  );

  if (resolved.contract.vars.length === 0) {
    if (opts.persist !== false) {
      await clearComposeEnvOverride({
        projectDir: opts.project.projectDir,
      });
    }
    return {
      composeFiles: [],
      env: {},
      lifecycleEnv: {},
      preflightEnvByService,
      effectiveEnvName: resolved.envSelection.effectiveEnv,
    };
  }

  const shouldRetry = await maybeResolveMissingLegacyEnv({
    resolved,
    targetServices: opts.targetServices,
    projectName: opts.projectName,
    projectDir: opts.project.projectDir,
  });
  if (shouldRetry) {
    return await resolveComposeEnvOverrides(opts);
  }

  const overrideServices: Record<string, Record<string, unknown>> = {};
  for (const service of composeEnvOverrideServices(opts)) {
    const env: Record<string, string> = {};
    for (const v of resolved.values) {
      if (v.value === null) {
        continue;
      }
      if (
        !isEnvVarRelevantToServices({
          services: [service],
          varServices: v.services,
        })
      ) {
        continue;
      }
      env[v.key] = buildComposeEnvInterpolation(v.key);
    }
    if (Object.keys(env).length > 0) {
      overrideServices[service] = { environment: env };
    }
  }

  assertComposeSpawnEnvFits({ env: resolved.envForCompose });
  if (Object.keys(overrideServices).length === 0) {
    if (opts.persist !== false) {
      await clearComposeEnvOverride({
        projectDir: opts.project.projectDir,
      });
    }
    return {
      composeFiles: [],
      env: resolved.envForCompose,
      lifecycleEnv: selectHackEnvValues({ resolved }),
      preflightEnvByService,
      effectiveEnvName: resolved.envSelection.effectiveEnv,
    };
  }

  const override = { services: overrideServices };
  const yaml = YAML.stringify(override, null, 2);
  const text = ensureTrailingNewline(cleanupYaml(yaml));
  return {
    composeFiles: await settleComposeEnvOverride({
      projectDir: opts.project.projectDir,
      text,
      persist: opts.persist,
      serviceNames: opts.allServiceNames,
    }),
    env: resolved.envForCompose,
    lifecycleEnv: selectHackEnvValues({ resolved }),
    preflightEnvByService,
    effectiveEnvName: resolved.envSelection.effectiveEnv,
  };
}

async function assertRegistryCredentialsAvailable(opts: {
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly targetServices: readonly string[];
  readonly envByService: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
}): Promise<void> {
  const bootstrapServices = await discoverDependencyBootstrapServices({
    composeFile: opts.composeFile,
  });
  for (const service of bootstrapServices) {
    if (!opts.targetServices.includes(service)) {
      continue;
    }
    const result = await preflightRegistryCredentials({
      projectRoot: opts.projectRoot,
      env: opts.envByService[service] ?? {},
    });
    if (result.missing.length > 0) {
      throw new RegistryCredentialPreflightError({
        missing: result.missing,
        service,
      });
    }
  }
}

function logRelevantLegacyEnvWarnings(opts: {
  readonly resolved: Awaited<ReturnType<typeof resolveHackEnv>>;
  readonly targetServices: readonly string[];
}): void {
  if (opts.resolved.contractParseError) {
    logger.warn({
      message: `Failed to parse ${opts.resolved.contractPath}: ${opts.resolved.contractParseError}`,
    });
  }

  for (const warning of opts.resolved.warnings) {
    if (
      !isEnvVarRelevantToServices({
        services: opts.targetServices,
        varServices: warning.services,
      })
    ) {
      continue;
    }
    logger.warn({ message: warning.message });
  }
}

async function maybeResolveMissingLegacyEnv(opts: {
  readonly resolved: Awaited<ReturnType<typeof resolveHackEnv>>;
  readonly targetServices: readonly string[];
  readonly projectName: string;
  readonly projectDir: string;
}): Promise<boolean> {
  const missingRelevant = opts.resolved.missingRequired.filter((value) =>
    isEnvVarRelevantToServices({
      services: opts.targetServices,
      varServices: value.services,
    })
  );
  if (missingRelevant.length === 0) {
    return false;
  }

  const fixed = await maybePromptToFixMissingEnv({
    missing: missingRelevant,
    envFile: resolve(opts.projectDir, PROJECT_ENV_FILENAME),
    projectName: opts.projectName,
    projectDir: opts.projectDir,
  });
  if (fixed) {
    return true;
  }

  const keys = missingRelevant.map((value) => value.key).join(", ");
  logger.error({
    message: `Missing required env: ${keys}`,
  });
  logger.info({
    message:
      "Run: hack env set KEY=VALUE (or: hack env set --secret KEY=VALUE)",
  });
  throw new Error("Missing required env");
}

async function maybePromptToFixMissingEnv(opts: {
  readonly missing: readonly {
    readonly key: string;
    readonly source: "plain_env" | "keychain";
  }[];
  readonly envFile: string;
  readonly projectName: string;
  readonly projectDir: string;
}): Promise<boolean> {
  if (!canPrompt()) {
    return false;
  }

  await display.panel({
    title: "Missing required env",
    tone: "warn",
    lines: [
      ...opts.missing.map((v) => `- ${v.key} (${v.source})`),
      "",
      "Fill them in now?",
    ],
  });

  const ok = await confirm({
    message: "Set missing env now?",
    initialValue: true,
  });
  if (isCancel(ok)) {
    throw new Error("Canceled");
  }
  if (!ok) {
    return false;
  }

  const secretStore = await resolveSecretStore({
    projectName: opts.projectName,
    projectDir: opts.projectDir,
  });
  const secretLabel = formatSecretStoreDescriptor({
    descriptor: secretStore.descriptor,
  });

  for (const v of opts.missing) {
    const value =
      v.source === "keychain"
        ? await password({
            message: `Value for secret "${v.key}" (${secretLabel}):`,
            validate: (input) =>
              !input || input.length === 0 ? "Required" : undefined,
          })
        : await text({
            message: `Value for "${v.key}" (${opts.envFile}):`,
            validate: (input) =>
              !input || input.length === 0 ? "Required" : undefined,
          });

    if (isCancel(value)) {
      throw new Error("Canceled");
    }

    if (v.source === "keychain") {
      await secretStore.set({ key: v.key, value });
    } else {
      await upsertDotEnvValue({ envFile: opts.envFile, key: v.key, value });
    }
  }

  return true;
}

/**
 * One finite lifecycle command with its output logged. The signal cancels the
 * command's whole owned process group (see {@link runLifecycleCommandChild}).
 */
function runLifecycleChild(opts: {
  readonly command: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly output: "stdout" | "stderr";
  readonly projectDir: string;
  readonly composeProject: string;
  readonly service: string;
  readonly signal?: AbortSignal;
  /** The hook's log sink, shared with its end record. */
  readonly sink: LifecycleLogSink;
  readonly beforeOutput?: () => void;
  /** Each output line, for a bounded tail of a failed hook's output. */
  readonly onLine?: (line: string) => void;
}): Promise<number> {
  const { sink } = opts;
  return runLifecycleCommandChild({
    command: opts.command,
    cwd: opts.cwd,
    env: opts.env,
    signal: opts.signal,
    drain: (stream, source) =>
      drainLifecycleOutput({
        stream,
        output: source === "stdout" ? opts.output : "stderr",
        service: opts.service,
        sink,
        onLine: opts.onLine,
        beforeWrite: opts.beforeOutput,
      }),
  });
}

/**
 * Run a lifecycle phase's commands in order. Exported for tests. A log that
 * cannot be written (a refused path, an I/O error) changes only
 * persistence: nothing is written through it, the problem is reported once
 * per hook, and the hook's output and result, and the commands after it,
 * are unaffected.
 */
export async function runLifecycleCommands(opts: {
  readonly title: string;
  readonly commands: readonly ProjectLifecycleCommand[] | undefined;
  readonly projectRoot: string;
  readonly env: Readonly<Record<string, string>>;
  readonly projectDir: string;
  readonly composeProject: string;
  readonly routeStdoutToStderr?: boolean;
  readonly onHookStart?: HookStart;
  readonly onHookComplete?: HookCompletion;
  readonly summarizeFailure?: (name: string, reason?: string) => void;
  readonly onPersistentCommand?: (opts: {
    readonly command: ProjectLifecycleCommand;
    readonly index: number;
    readonly serviceName: string;
  }) => Promise<void>;
  /**
   * Cancels the running command's owned process group and the rest; the
   * result is then 130.
   */
  readonly signal?: AbortSignal;
  /** Report a stop during native startup after the attached hook settles. */
  readonly startupSignal?: AbortSignal;
}): Promise<number> {
  const commands = opts.commands ?? [];
  assertAutostartHostCommandsAllowed({ hasCommands: commands.length > 0 });
  for (const [index, cmd] of commands.entries()) {
    const label = cmd.name ? `${cmd.name}: ${cmd.command}` : cmd.command;
    const startedAt = opts.onHookComplete ? performance.now() : 0;
    if (!opts.onHookComplete) {
      logger.step({ message: `${opts.title}: ${label}` });
    }
    const serviceName = resolveLifecycleCommandServiceName({
      command: cmd,
      index,
    });
    if (cmd.persistent === true && opts.onPersistentCommand) {
      const clear = opts.onHookStart?.(serviceName);
      try {
        await opts
          .onPersistentCommand({
            command: cmd,
            index,
            serviceName,
          })
          .finally(clear);
      } catch (error: unknown) {
        if (opts.startupSignal?.aborted) {
          return 130;
        }
        const message =
          error instanceof Error
            ? error.message
            : `Failed to start persistent lifecycle command: ${serviceName}`;
        if (opts.summarizeFailure) {
          opts.summarizeFailure(serviceName, message);
        } else {
          logger.error({ message });
        }
        // The lines the foreground just printed, for a detached owner (HACK-2339).
        nativeDetachedUpHookFailed({
          step: `${opts.title}: ${label}`,
          output: [],
          failure: message,
        });
        return 1;
      }
      opts.onHookComplete?.(
        serviceName,
        "running",
        performance.now() - startedAt
      );
      continue;
    }
    if (cmd.persistent === true) {
      logger.warn({
        message:
          `Ignoring persistent mode for "${serviceName}" in ${opts.title};` +
          " persistent lifecycle commands are only non-blocking in up.before.",
      });
    }

    const cwd = resolveLifecycleCwd({
      projectRoot: opts.projectRoot,
      cwd: cmd.cwd,
    });

    const sink = createLifecycleLogSink({
      projectDir: opts.projectDir,
      composeProject: opts.composeProject,
      warn: (message) => logger.warn({ message }),
    });
    await sink.append({
      timestamp: new Date().toISOString(),
      service: serviceName,
      stream: "meta",
      message: `[start] ${opts.title}: ${label}`,
    });
    const tail = failedHookTail();
    const env = await mergeLifecycleCommandEnv(opts.env);
    const clear = opts.onHookStart?.(serviceName);
    const exitCode = await runLifecycleChild({
      sink,
      onLine: tail.onLine,
      beforeOutput: clear,
      command: cmd.command,
      cwd,
      env,
      // Under Hack's own `--json`, stdout holds only the envelope
      // (HACK-2311), whatever this call site passed.
      output:
        childStdoutTarget(opts.routeStdoutToStderr) === "stderr"
          ? "stderr"
          : "stdout",
      projectDir: opts.projectDir,
      composeProject: opts.composeProject,
      service: serviceName,
      signal: opts.signal,
    }).finally(clear);

    await sink.append({
      timestamp: new Date().toISOString(),
      service: serviceName,
      stream: "meta",
      message: `[end] ${opts.title}: exit ${exitCode}`,
    });

    if (opts.startupSignal?.aborted) {
      return 130;
    }
    if (exitCode !== 0) {
      const failure = `${opts.title} failed (exit ${exitCode}): ${label}`;
      if (opts.summarizeFailure) {
        opts.summarizeFailure(serviceName);
      } else {
        logger.error({ message: failure });
      }
      nativeDetachedUpHookFailed({
        step: `${opts.title}: ${label}`,
        output: tail.lines,
        failure,
      });
      return exitCode;
    }
    opts.onHookComplete?.(serviceName, "done", performance.now() - startedAt);
  }
  return 0;
}

/** Output lines of a failed hook a detached native owner keeps for its launcher. */
const LIFECYCLE_FAILURE_TAIL_LINES = 40;
/** Characters kept of each such line; the launcher shows no more. */
const LIFECYCLE_FAILURE_LINE_CHARS = 500;

/**
 * A detached native owner has no terminal: it keeps the last lines of each
 * hook's output so a failure before VM work can show them (HACK-2339). Any
 * other process keeps nothing.
 */
function failedHookTail(): {
  readonly lines: readonly string[];
  readonly onLine: ((line: string) => void) | undefined;
} {
  const lines: string[] = [];
  return {
    lines,
    // Only while a detached owner is before VM work, and each line bounded
    // as it is kept: a later hook, or a long record, retains nothing more.
    onLine: nativeDetachedUpKeepsHookOutput()
      ? (line) => {
          lines.push(line.slice(0, LIFECYCLE_FAILURE_LINE_CHARS));
          if (lines.length > LIFECYCLE_FAILURE_TAIL_LINES) {
            lines.shift();
          }
        }
      : undefined,
  };
}

type LifecycleUpResult = {
  readonly code: number;
  readonly sessionName: string | null;
  readonly cleanup: LifecycleOperationCleanup | null;
  readonly signalCleanup: { readonly dispose: () => void } | null;
  /**
   * Throws {@link SharedHelperSupersededError} once a concurrent `hack down`
   * released this instance's shared helpers. Call it right before launching
   * services and again after they start. Absent without shared helpers.
   */
  readonly assertSharedHelpersCurrent?: (opts?: {
    readonly servicesStarted?: boolean;
  }) => Promise<void>;
  /**
   * Call once the instance's containers run (a detached Compose up
   * succeeded): later cleanup then stops only the lifecycle processes and
   * keeps the shared helper holders for hack down, so a failure after start
   * (an up.after hook, a startup check) never stops a helper underneath the
   * running containers. Absent without shared helpers.
   */
  readonly keepSharedHelpers?: () => void;
};

/** The optional shared helper controls of a lifecycle start, when present. */
function sharedHelperControls(
  start: LifecycleProcessStart
): Pick<LifecycleUpResult, "assertSharedHelpersCurrent" | "keepSharedHelpers"> {
  return {
    ...(start.assertSharedHelpersCurrent
      ? { assertSharedHelpersCurrent: start.assertSharedHelpersCurrent }
      : {}),
    ...(start.keepSharedHelpers
      ? { keepSharedHelpers: start.keepSharedHelpers }
      : {}),
  };
}

/**
 * Lifecycle sessions of projects with shared helpers need tmux. zellij
 * creates the session first and records its ownership token with a separate
 * `rename-tab`, so a start interrupted between the two leaves a live session
 * without a token: neither a later up nor hack down can prove ownership, and
 * the helper holders kept for it could never be released. tmux sets the
 * token as part of `new-session`. Refuses before any hook, helper or process
 * runs. Exported for tests.
 */
export async function assertSharedHelperSessionMuxSupported(opts: {
  readonly runner?: "mux" | "supervisor";
  readonly sharedHelpersConfigured: boolean;
  readonly needsSession: boolean;
  readonly mux: () => Promise<ResolvedMux>;
}): Promise<void> {
  if (
    opts.runner === "supervisor" ||
    !(opts.sharedHelpersConfigured && opts.needsSession)
  ) {
    return;
  }
  const mux = await opts.mux();
  const selected = resolveDefaultBackendName(mux);
  const backend = selected ? mux.backends.get(selected) : undefined;
  // No backend: the controller reports that itself. The controller also
  // enforces this at the backend it actually selects, which may differ if
  // the mux configuration changes while hooks run.
  if (backend && backend.createsWithOwnerToken !== true) {
    throw new Error(SHARED_HELPER_MUX_UNSUPPORTED_MESSAGE);
  }
}

function hasPersistentLifecycleCommands(
  commands: readonly ProjectLifecycleCommand[] | undefined
): boolean {
  return (commands ?? []).some((command) => command.persistent === true);
}

async function runLifecycleUpBeforeAndProcesses(opts: {
  readonly title: string;
  readonly startupSignal?: AbortSignal;
  readonly onHookStart?: HookStart;
  readonly onHookComplete?: HookCompletion;
  readonly summarizeFailure?: (name: string, reason?: string) => void;
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly projectName: string;
  readonly branch: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly effectiveEnvName: string | null;
  readonly composeProject: string;
}): Promise<LifecycleUpResult> {
  if (opts.cfg.lifecycleRunnerError) {
    throw new Error(opts.cfg.lifecycleRunnerError);
  }
  if (opts.cfg.sharedHelpersError) {
    // Fail closed before any hook runs: starting without the configured
    // helpers would launch services that depend on them.
    throw new Error(
      `Invalid lifecycle.sharedHelpers; nothing was started: ${opts.cfg.sharedHelpersError}`
    );
  }
  // Captured before any preparation hook runs: a down that completes while
  // the hooks run supersedes this operation (see startProjectSharedHelpers).
  const sharedHelperConfigs = opts.cfg.lifecycle?.sharedHelpers ?? [];
  assertAutostartHostCommandsAllowed({
    hasCommands:
      sharedHelperConfigs.length > 0 ||
      (opts.cfg.lifecycle?.up?.before?.length ?? 0) > 0 ||
      (opts.cfg.lifecycle?.up?.after?.length ?? 0) > 0 ||
      (opts.cfg.lifecycle?.processes?.length ?? 0) > 0,
  });
  await assertSharedHelperSessionMuxSupported({
    runner: resolveLifecycleRunner({ runner: opts.cfg.lifecycle?.runner }),
    sharedHelpersConfigured: sharedHelperConfigs.length > 0,
    needsSession:
      (opts.cfg.lifecycle?.processes ?? []).length > 0 ||
      hasPersistentLifecycleCommands(opts.cfg.lifecycle?.up?.before),
    mux: () => resolveMux({ project: opts.project }),
  });
  const shutdownGeneration =
    sharedHelperConfigs.length > 0
      ? await captureSharedHelperShutdownGeneration({
          composeProject: opts.composeProject,
        })
      : undefined;
  // Records lifecycle-session adoption and creation, so a creator's cleanup
  // never kills a session another start adopted (see the ownership type).
  const sessionOwnership =
    sharedHelperConfigs.length > 0
      ? createSharedHelperSessionOwnership({
          composeProject: opts.composeProject,
          // Another start may hold the instance lock while it ensures helpers.
          decisionTimeoutMs:
            sharedHelperConfigs.reduce(
              (sum, helper) => sum + helper.readyTimeoutMs,
              0
            ) + 10_000,
        })
      : undefined;
  const beforeCommands = opts.cfg.lifecycle?.up?.before;
  const definitionHash = resolveProjectLifecycleDefinitionHash({
    beforeCommands,
    processes: opts.cfg.lifecycle?.processes,
    env: opts.env,
    effectiveEnvName: opts.effectiveEnvName,
  });
  if (!hasPersistentLifecycleCommands(beforeCommands)) {
    const beforeCode = await runLifecycleCommands({
      title: opts.title,
      summarizeFailure: opts.summarizeFailure,
      onHookStart: opts.onHookStart,
      onHookComplete: opts.onHookComplete,
      commands: beforeCommands,
      startupSignal: opts.startupSignal,
      projectRoot: opts.project.projectRoot,
      env: opts.env,
      projectDir: opts.project.projectDir,
      composeProject: opts.composeProject,
    });
    if (beforeCode !== 0) {
      return {
        code: beforeCode,
        sessionName: null,
        cleanup: null,
        signalCleanup: null,
      };
    }
    const lifecycleStart = await startWithSharedHelpers({
      ...opts,
      shutdownGeneration,
      sessionOwnership,
      startProcesses: () =>
        startLifecycleProcesses({
          project: opts.project,
          cfg: opts.cfg,
          projectName: opts.projectName,
          branch: opts.branch,
          env: opts.env,
          composeProject: opts.composeProject,
          definitionHash,
          ...(sessionOwnership ? { sessionOwnership } : {}),
        }),
      abortProcesses: () => Promise.resolve(),
    });
    const hasProcesses = (opts.cfg.lifecycle?.processes ?? []).length > 0;
    return {
      code: 0,
      sessionName: hasProcesses
        ? resolveLifecycleSessionName({
            projectName: opts.projectName,
            branch: opts.branch,
          })
        : null,
      cleanup: lifecycleStart.cleanup,
      signalCleanup: lifecycleStart.signalCleanup,
      ...sharedHelperControls(lifecycleStart),
    };
  }

  const starter = createLifecycleProcessController({
    runner: resolveLifecycleRunner({ runner: opts.cfg.lifecycle?.runner }),
    mux: () => resolveMux({ project: opts.project }),
    project: opts.project,
    projectName: opts.projectName,
    branch: opts.branch,
    env: opts.env,
    composeProject: opts.composeProject,
    definitionHash,
    ...(sessionOwnership ? { sessionOwnership } : {}),
  });
  const beforeCode = await runLifecycleCommands({
    title: opts.title,
    summarizeFailure: opts.summarizeFailure,
    onHookStart: opts.onHookStart,
    onHookComplete: opts.onHookComplete,
    commands: beforeCommands,
    startupSignal: opts.startupSignal,
    projectRoot: opts.project.projectRoot,
    env: opts.env,
    projectDir: opts.project.projectDir,
    composeProject: opts.composeProject,
    onPersistentCommand: async ({ command, serviceName }) => {
      await starter.startFromCommand({
        command,
        serviceName,
      });
    },
  });
  if (beforeCode !== 0) {
    await starter.abort();
    return {
      code: beforeCode,
      sessionName: null,
      cleanup: null,
      signalCleanup: null,
    };
  }

  const started = await startWithSharedHelpers({
    ...opts,
    shutdownGeneration,
    sessionOwnership,
    startProcesses: async () => {
      await starter.startMany({
        processes: opts.cfg.lifecycle?.processes ?? [],
      });
      await starter.finalize();
      return {
        cleanup: starter.getOperationCleanup(),
        signalCleanup: starter.getSignalCleanup(),
      };
    },
    abortProcesses: () => starter.abort(),
  });

  return {
    code: 0,
    sessionName: starter.hasStarted() ? starter.sessionName : null,
    cleanup: started.cleanup,
    signalCleanup: started.signalCleanup,
    ...sharedHelperControls(started),
  };
}

/**
 * After lifecycle processes failed to start: abort them, then release the
 * shared helper holders this start added, unless the abort kept the session
 * (its stop could not be confirmed). Releasing then could stop a helper
 * underneath the retained processes, so the holders stay for hack down.
 */
export async function releaseAfterFailedProcessStart(opts: {
  readonly error: unknown;
  readonly abortProcesses: () => Promise<unknown>;
  readonly rollbackHelpers: (() => Promise<void>) | null;
}): Promise<void> {
  const aborted = await opts.abortProcesses();
  const retained =
    aborted === LIFECYCLE_SESSION_RETAINED ||
    opts.error instanceof LifecycleSessionRetainedError;
  if (retained) {
    logger.warn({
      message:
        "Kept this instance's shared helpers with its lifecycle session, which could not be confirmed stopped. Run hack down to stop both.",
    });
    return;
  }
  await opts.rollbackHelpers?.();
}

/**
 * What happened to the instance's containers before its helpers would be
 * released: "stopped" (Compose or graph shutdown succeeded), "unconfirmed"
 * (shutdown failed, timed out or was interrupted) or "kept" (deliberately
 * left running, as by hack restart, which preserves the Compose runtime).
 */
export type ContainerShutdown = "stopped" | "unconfirmed" | "kept";

/**
 * The SIGINT/SIGTERM cleanup of an up or restart: once a container start has
 * begun, keep the shared helpers before cleaning up (only the lifecycle
 * processes stop), because the start may already have started services and
 * may still start more. Exported for tests.
 */
export function signalCleanupKeepingStartedHelpers(opts: {
  readonly cleanup: LifecycleOperationCleanup | null;
  readonly containerStartBegun: () => boolean;
  readonly keepSharedHelpers: () => (() => void) | undefined;
}): LifecycleOperationCleanup | null {
  const cleanup = opts.cleanup;
  if (!cleanup) {
    return null;
  }
  return async (cleanupOpts) => {
    if (opts.containerStartBegun()) {
      opts.keepSharedHelpers()?.();
    }
    return await cleanup(cleanupOpts);
  };
}

/**
 * After a container start that did not succeed (Compose failed, timed out or
 * was interrupted, possibly after starting some services): keep the shared
 * helper holders unless Compose confirms that no container of the project
 * exists in a state that may run. Unknown counts as running. Exported for
 * tests.
 */
export async function retainHelpersUnlessContainersAbsent(opts: {
  readonly probe: () => Promise<"absent" | "present" | "unknown">;
  readonly keepSharedHelpers: (() => void) | undefined;
}): Promise<void> {
  if (!opts.keepSharedHelpers) {
    return;
  }
  const containers = await opts.probe().catch(() => "unknown" as const);
  if (containers !== "absent") {
    opts.keepSharedHelpers();
  }
}

/** Whether any container of the Compose project exists in a state that may run. */
async function probeComposeContainers(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly composeProjectName: string | null;
  readonly profiles: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}): Promise<"absent" | "present" | "unknown"> {
  const res = await composeRuntimeBackend.psJson({
    composeFiles: [opts.project.composeFile],
    composeProject: opts.composeProjectName,
    profiles: opts.profiles,
    cwd: dirname(opts.project.composeFile),
    all: true,
    env: opts.env,
  });
  if (res.exitCode !== 0) {
    return "unknown";
  }
  const stopped = new Set(["exited", "dead"]);
  return parseJsonLines(res.stdout).some(
    (entry) => !stopped.has((getString(entry, "State") ?? "").toLowerCase())
  )
    ? "present"
    : "absent";
}

/**
 * The container outcome of a `docker compose down` for the shared helper
 * holders: "stopped" only when the down succeeded and no container labelled
 * with the Compose project (orphans of services the current file no longer
 * declares included) may still run. Warns with the remaining containers or
 * the failed check. See compose-down-confirmation.ts. Never throws.
 */
async function confirmComposeDownForHelpers(opts: {
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  /** The holder instance (`<project>` or `<project>--<branch>`). */
  readonly lifecycleComposeProject: string;
  /** The Compose project label value of the instance's containers. */
  readonly composeProject: string;
  readonly downCode: number;
}): Promise<ContainerShutdown> {
  const confirmation = await confirmComposeDownStopped({
    downCode: opts.downCode,
    heldHelperNames: () =>
      heldSharedHelperNames({
        cfg: opts.cfg,
        composeProject: opts.lifecycleComposeProject,
      }),
    listContainers: () =>
      listComposeProjectContainers({ composeProject: opts.composeProject }),
  });
  const message = describeUnconfirmedComposeDown({
    composeProject: opts.composeProject,
    confirmation,
  });
  if (message !== null) {
    logger.warn({ message });
  }
  return confirmation.containers;
}

/**
 * Stop the lifecycle session, then release this instance's shared helper
 * holders only once both the session and the containers are confirmed
 * stopped. When the session stop failed or its outcome is unknown, or the
 * containers were not confirmed stopped, something may still use the
 * helpers: every holder is kept (a later hack down releases them) and
 * reported as not released, so down, restart and native retirement fail
 * visibly. Containers kept on purpose keep their holders too, but that is
 * not a failure: nothing is reported. Never throws.
 */
export async function stopSessionBeforeReleasingHelpers(opts: {
  readonly stopSession: () => Promise<void>;
  /** Only "stopped" lets the holders be released. */
  readonly containers: ContainerShutdown;
  /** Returns the helpers whose release failed; must not throw. */
  readonly releaseHelpers: () => Promise<readonly string[]>;
  /** Helpers the instance may still hold, configured or recorded; must not throw. */
  readonly heldHelperNames: () => Promise<readonly string[]>;
}): Promise<{
  readonly sessionStopFailed: { readonly error: unknown } | null;
  readonly notReleased: readonly string[];
}> {
  try {
    await opts.stopSession();
  } catch (error: unknown) {
    return {
      sessionStopFailed: { error },
      notReleased: await opts.heldHelperNames(),
    };
  }
  if (opts.containers === "kept") {
    return { sessionStopFailed: null, notReleased: [] };
  }
  if (opts.containers === "unconfirmed") {
    return {
      sessionStopFailed: null,
      notReleased: await opts.heldHelperNames(),
    };
  }
  return { sessionStopFailed: null, notReleased: await opts.releaseHelpers() };
}

/**
 * Run Compose up guarded by this instance's shared helper check: right
 * before containers start (via the backend's `beforeStart`) and again after a
 * successful start. A concurrent `hack down` that released the helpers is
 * reported as `superseded` instead of a successful start.
 */
async function composeUpGuardedBySharedHelpers(opts: {
  readonly assertCurrent: LifecycleUpResult["assertSharedHelpersCurrent"];
  readonly up: (beforeStart?: () => Promise<void>) => Promise<number>;
}): Promise<
  | { readonly code: number }
  | { readonly superseded: SharedHelperSupersededError }
> {
  const assertCurrent = opts.assertCurrent;
  if (!assertCurrent) {
    return { code: await opts.up() };
  }
  try {
    const code = await opts.up(() => assertCurrent());
    if (code === 0) {
      await assertCurrent({ servicesStarted: true });
    }
    return { code };
  } catch (error: unknown) {
    if (error instanceof SharedHelperSupersededError) {
      return { superseded: error };
    }
    throw error;
  }
}

export type LifecycleProcessStart = {
  readonly cleanup: LifecycleOperationCleanup | null;
  readonly signalCleanup: { readonly dispose: () => void } | null;
  readonly assertSharedHelpersCurrent?: (opts?: {
    readonly servicesStarted?: boolean;
  }) => Promise<void>;
  /** See {@link LifecycleUpResult.keepSharedHelpers}. */
  readonly keepSharedHelpers?: () => void;
};

/**
 * Start shared helpers, then lifecycle processes, as one guarded step.
 *
 * Without shared helpers this is `startProcesses` with `abortProcesses` on
 * failure, unchanged. With them, SIGINT/SIGTERM handlers stay installed from
 * the first helper start until the combined cleanup is handed back: a signal
 * cancels an in-flight helper start, and once this step settles it runs the
 * cleanup for whatever was started (process session and helper holders) and
 * is re-raised. No window exists in which a started helper is unguarded.
 */
async function startWithSharedHelpers(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly env: Readonly<Record<string, string>>;
  readonly composeProject: string;
  readonly startProcesses: () => Promise<LifecycleProcessStart>;
  readonly abortProcesses: () => Promise<unknown>;
  readonly shutdownGeneration: SharedHelperShutdownGeneration | undefined;
  readonly sessionOwnership: SharedHelperSessionOwnership | undefined;
}): Promise<LifecycleProcessStart> {
  const failed = (error: unknown): Error =>
    error instanceof Error
      ? error
      : new Error("Failed to start lifecycle processes");
  if ((opts.cfg.lifecycle?.sharedHelpers ?? []).length === 0) {
    try {
      return await opts.startProcesses();
    } catch (error: unknown) {
      await opts.abortProcesses();
      throw failed(error);
    }
  }
  let onSignalled: () => Promise<void> = () => Promise.resolve();
  return await withTerminationAbort(
    (signal) =>
      runGuardedSharedHelperStart({
        startHelpers: () => startLifecycleSharedHelpers({ ...opts, signal }),
        startProcesses: opts.startProcesses,
        abortProcesses: opts.abortProcesses,
        sessionOwnership: opts.sessionOwnership,
        setSignalCleanup: (cleanup) => {
          onSignalled = cleanup;
        },
      }),
    { onSignalled: () => onSignalled() }
  );
}

/**
 * The body of {@link startWithSharedHelpers}, run inside its termination
 * guard. `setSignalCleanup` names what a caught signal must undo once this
 * settles: the helper rollback while processes start, then the combined
 * cleanup. A failed process start does its own cleanup here (keeping the
 * helpers when the session was retained), so it leaves no signal cleanup
 * behind that could release them a second time. Exported for tests.
 */
export async function runGuardedSharedHelperStart(opts: {
  readonly startHelpers: () => Promise<LifecycleSharedHelpers>;
  readonly startProcesses: () => Promise<LifecycleProcessStart>;
  readonly abortProcesses: () => Promise<unknown>;
  readonly sessionOwnership: SharedHelperSessionOwnership | undefined;
  readonly setSignalCleanup: (cleanup: () => Promise<void>) => void;
}): Promise<LifecycleProcessStart> {
  let sharedHelpers: LifecycleSharedHelpers | null = null;
  let started: LifecycleProcessStart;
  try {
    sharedHelpers = await opts.startHelpers();
    opts.setSignalCleanup(sharedHelpers.rollback);
    started = await opts.startProcesses();
  } catch (error: unknown) {
    // This catch owns the cleanup from here on, whatever it decides.
    opts.setSignalCleanup(() => Promise.resolve());
    await releaseAfterFailedProcessStart({
      error,
      abortProcesses: opts.abortProcesses,
      rollbackHelpers: sharedHelpers ? sharedHelpers.rollback : null,
    });
    throw error instanceof Error
      ? error
      : new Error("Failed to start lifecycle processes");
  }
  const combined = withSharedHelperCleanup({
    ...started,
    sharedHelpers,
    sessionOwnership: opts.sessionOwnership,
  });
  opts.setSignalCleanup(async () => {
    await combined.cleanup?.();
  });
  return {
    ...combined,
    assertSharedHelpersCurrent: sharedHelpers.assertCurrent,
  };
}

export type LifecycleSharedHelpers = {
  readonly configured: boolean;
  readonly rollback: () => Promise<void>;
  readonly assertCurrent: (opts?: {
    readonly servicesStarted?: boolean;
  }) => Promise<void>;
};

/**
 * Ensure `lifecycle.sharedHelpers` for this instance. A failure, including a
 * start cancelled through `signal`, throws after releasing what this run added.
 */
async function startLifecycleSharedHelpers(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly env: Readonly<Record<string, string>>;
  readonly composeProject: string;
  readonly signal: AbortSignal;
  readonly shutdownGeneration: SharedHelperShutdownGeneration | undefined;
}): Promise<LifecycleSharedHelpers> {
  const started = await startProjectSharedHelpers({
    helpers: opts.cfg.lifecycle?.sharedHelpers,
    projectRoot: opts.project.projectRoot,
    composeProject: opts.composeProject,
    env: opts.env,
    signal: opts.signal,
    ...(opts.shutdownGeneration
      ? { shutdownGeneration: opts.shutdownGeneration }
      : {}),
    report: (record) => {
      if (record.result.state !== "failed") {
        logger.info({ message: describeSharedHelperStart(record) });
      }
    },
  });
  return {
    configured: true,
    rollback: async () => {
      reportSharedHelperReleases(await started.rollback());
    },
    assertCurrent: started.assertCurrent,
  };
}

/**
 * Fold the shared helper rollback into the operation cleanup. The process
 * controller's own signal handler only knows its cleanup, so it is replaced:
 * returning no signal cleanup makes the caller install one for the combined
 * cleanup.
 *
 * When process cleanup is undecidable (the instance lock was busy), the
 * helper rollback is skipped too: keeping the session while releasing its
 * helpers would leave a running session whose helpers were stopped. Both are
 * kept for `hack down`. Likewise, once `keepSharedHelpers` was called (the
 * containers run), the cleanup stops the processes but keeps the helpers.
 */
export function withSharedHelperCleanup(opts: {
  readonly cleanup: LifecycleOperationCleanup | null;
  readonly signalCleanup: { readonly dispose: () => void } | null;
  readonly sharedHelpers: LifecycleSharedHelpers | null;
  readonly sessionOwnership:
    | Pick<SharedHelperSessionOwnership, "runIfOwned">
    | undefined;
}): {
  readonly cleanup: LifecycleOperationCleanup | null;
  readonly signalCleanup: { readonly dispose: () => void } | null;
  readonly keepSharedHelpers?: () => void;
} {
  const sharedHelpers = opts.sharedHelpers;
  let containersRunning = false;
  const runProcessCleanup =
    opts.sessionOwnership?.runIfOwned ??
    (async (cleanup: () => Promise<void>): Promise<ProcessCleanupOutcome> => {
      await cleanup();
      return "ran";
    });
  if (!sharedHelpers?.configured) {
    return { cleanup: opts.cleanup, signalCleanup: opts.signalCleanup };
  }
  opts.signalCleanup?.dispose();
  return {
    keepSharedHelpers: () => {
      containersRunning = true;
    },
    cleanup: async (cleanupOpts) => {
      const processCleanup = opts.cleanup;
      let outcome: ProcessCleanupOutcome | null = null;
      // The session could not be confirmed stopped and was kept: its shared
      // helpers must stay too, or they would stop underneath it.
      let sessionRetained = false;
      try {
        // Another start of this instance may have adopted the lifecycle
        // session this start created; adoption keeps the creator's token, so
        // only clean up while the session is still this start's own.
        if (processCleanup) {
          outcome = await runProcessCleanup(async () => {
            if (
              (await processCleanup(cleanupOpts)) === LIFECYCLE_SESSION_RETAINED
            ) {
              sessionRetained = true;
            }
          });
          if (outcome === "undecidable") {
            logger.warn({
              message:
                "Kept this instance's lifecycle session and its shared helpers: the shared helper instance lock was busy, so whether another hack up adopted them could not be checked. Run hack down to stop them if nothing uses them.",
            });
          }
        }
      } finally {
        if (sessionRetained) {
          logger.warn({
            message:
              "Kept this instance's shared helpers with its lifecycle session, which could not be confirmed stopped. Run hack down to stop both.",
          });
        } else if (containersRunning) {
          logger.warn({
            message:
              "Kept this instance's shared helpers: its containers are running. Run hack down to stop both.",
          });
        } else if (outcome !== "undecidable") {
          await sharedHelpers.rollback();
        }
      }
    },
    signalCleanup: null,
  };
}

function reportSharedHelperReleases(
  releases: readonly SharedHelperRelease[]
): readonly SharedHelperRelease[] {
  for (const release of releases) {
    const message = describeSharedHelperRelease(release);
    if (isSharedHelperReleaseProblem(release)) {
      logger.warn({ message });
    } else {
      logger.info({ message });
    }
  }
  return releases.filter(isSharedHelperReleaseProblem);
}

/**
 * Start the configured lifecycle processes. On failure the started session
 * is aborted; when that abort cannot confirm the session stopped, the
 * failure is raised as LifecycleSessionRetainedError so the caller keeps the
 * shared helpers the session uses. Exported for regression tests.
 */
export async function startLifecycleProcesses(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly projectName: string;
  readonly branch: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly composeProject: string;
  readonly definitionHash: string;
  readonly sessionOwnership?: SharedHelperSessionOwnership;
  /** Mux backends; defaults to the project's configured backends. */
  readonly mux?: () => Promise<ResolvedMux>;
}): Promise<{
  readonly cleanup: LifecycleOperationCleanup | null;
  readonly signalCleanup: { readonly dispose: () => void } | null;
}> {
  const processes = opts.cfg.lifecycle?.processes ?? [];
  if (processes.length === 0) {
    const existingEntries = await readLifecycleState({
      projectDir: opts.project.projectDir,
    });
    if (
      !existingEntries.some(
        (entry) => entry.composeProject === opts.composeProject
      )
    ) {
      return { cleanup: null, signalCleanup: null };
    }
  }

  const starter = createLifecycleProcessController({
    runner: resolveLifecycleRunner({ runner: opts.cfg.lifecycle?.runner }),
    mux: opts.mux ?? (() => resolveMux({ project: opts.project })),
    project: opts.project,
    projectName: opts.projectName,
    branch: opts.branch,
    env: opts.env,
    composeProject: opts.composeProject,
    definitionHash: opts.definitionHash,
    ...(opts.sessionOwnership
      ? { sessionOwnership: opts.sessionOwnership }
      : {}),
  });
  try {
    await starter.startMany({ processes });
    await starter.finalize();
    return {
      cleanup: starter.getOperationCleanup(),
      signalCleanup: starter.getSignalCleanup(),
    };
  } catch (error: unknown) {
    if ((await starter.abort()) === LIFECYCLE_SESSION_RETAINED) {
      throw new LifecycleSessionRetainedError(error);
    }
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("Failed to start lifecycle processes");
  }
}

async function stopLifecycleProcesses(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly projectName: string;
  readonly branch: string | null;
  readonly composeProject: string;
}): Promise<void> {
  const outcome = await stopSessionBeforeReleasingHelpers({
    stopSession: () => stopLifecycleSession(opts),
    // Native retirement runs after the graph's own shutdown succeeded.
    containers: "stopped",
    releaseHelpers: () => releaseLifecycleSharedHelpersReporting(opts),
    heldHelperNames: () => heldSharedHelperNames(opts),
  });
  if (outcome.sessionStopFailed) {
    warnSharedHelpersKeptForSession(outcome.notReleased);
    throw outcome.sessionStopFailed.error;
  }
  if (outcome.notReleased.length > 0) {
    throw new Error(sharedHelperReleaseFailureMessage(outcome.notReleased));
  }
}

function stopLifecycleSession(
  opts: Parameters<typeof stopLifecycleProcesses>[0]
): Promise<void> {
  return stopLifecycleProcessController({
    ...opts,
    definitionHash: resolveProjectLifecycleDefinitionHash({
      beforeCommands: opts.cfg.lifecycle?.up?.before,
      processes: opts.cfg.lifecycle?.processes,
    }),
  });
}

function heldSharedHelperNames(opts: {
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly composeProject: string;
}): Promise<readonly string[]> {
  return listSharedHelpersHeld({
    helpers: opts.cfg.lifecycle?.sharedHelpers,
    composeProject: opts.composeProject,
  });
}

function warnSharedHelpersKeptForSession(kept: readonly string[]): void {
  if (kept.length > 0) {
    logger.warn({
      message: `Kept shared helpers ${kept.join(", ")}: this instance's lifecycle session could not be confirmed stopped. Run hack down again once it can be stopped.`,
    });
  }
}

/**
 * Release this instance's shared helper holders and report each outcome.
 * Returns the names of helpers whose release failed or whose stop was not
 * confirmed; their claims are kept for the next down. Never throws.
 */
async function releaseLifecycleSharedHelpersReporting(opts: {
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly composeProject: string;
}): Promise<readonly string[]> {
  try {
    return reportSharedHelperReleases(
      await releaseProjectSharedHelpers({
        helpers: opts.cfg.lifecycle?.sharedHelpers,
        composeProject: opts.composeProject,
      })
    ).map((release) => release.name);
  } catch (error: unknown) {
    logger.warn({
      message:
        error instanceof Error ? error.message : "Shared helper release failed",
    });
    return (opts.cfg.lifecycle?.sharedHelpers ?? []).map(
      (helper) => helper.name
    );
  }
}

function sharedHelperReleaseFailureMessage(names: readonly string[]): string {
  return `Shared helper release incomplete: ${names.join(", ")}. The claim was kept; inspect it and run hack down again.`;
}

/**
 * Mark the instance as stopping before `hack down` stops anything, so a
 * concurrent `hack up` of the same instance refuses to launch services.
 */
async function markLifecycleSharedHelpersStopping(opts: {
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly composeProject: string;
}): Promise<void> {
  const marked = await markSharedHelperInstanceStopping({
    helpers: opts.cfg.lifecycle?.sharedHelpers,
    composeProject: opts.composeProject,
  });
  if (!marked) {
    logger.warn({
      message:
        "Could not mark shared helpers as stopping; a concurrent hack up of this instance is not refused.",
    });
  }
}

/**
 * Stop lifecycle processes best-effort (failures are warnings) and release
 * shared helpers. Returns the helpers that were not released: unlike process
 * cleanup, an unreleased helper keeps running, so callers on the main down
 * path must fail the command. When the session stop failed or is unknown,
 * every helper is kept with the session and returned. Never throws (safe for
 * signal cleanup).
 */
async function stopLifecycleProcessesBestEffort(
  opts: Parameters<typeof stopLifecycleProcesses>[0] & {
    /** Only "stopped" lets the helper holders be released. */
    readonly containers: ContainerShutdown;
  }
): Promise<readonly string[]> {
  const outcome = await stopSessionBeforeReleasingHelpers({
    stopSession: () => stopLifecycleSession(opts),
    containers: opts.containers,
    releaseHelpers: () => releaseLifecycleSharedHelpersReporting(opts),
    heldHelperNames: () => heldSharedHelperNames(opts),
  });
  if (
    !outcome.sessionStopFailed &&
    opts.containers === "unconfirmed" &&
    outcome.notReleased.length > 0
  ) {
    logger.warn({
      message: `Kept shared helpers ${outcome.notReleased.join(", ")}: this instance's containers were not confirmed stopped. Run hack down again once they are.`,
    });
  }
  if (outcome.sessionStopFailed) {
    const { error } = outcome.sessionStopFailed;
    logger.warn({
      message:
        error instanceof Error
          ? error.message
          : "Failed to stop lifecycle processes",
    });
    warnSharedHelpersKeptForSession(outcome.notReleased);
  }
  return outcome.notReleased;
}

export async function mergeLifecycleCommandEnv(
  override: Readonly<Record<string, string>>
): Promise<Record<string, string>> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string" && key !== "HACK_AUTOSTART_LOGIN") {
      base[key] = value;
    }
  }
  return await appendHackHostTrustEnvironment({ ...base, ...override });
}

async function resolveBranchComposeFiles(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly branch: string;
  readonly devHost: string;
  readonly aliasHost: string | null;
  readonly onDropped?: (notice: string) => void;
}): Promise<readonly string[]> {
  const override = await buildBranchComposeOverride(opts);
  if (!override) {
    return [opts.project.composeFile];
  }

  await ensureHackGitInfoExclude({ projectDir: opts.project.projectDir });
  const overrideDir = resolve(opts.project.projectDir, ".branch");
  await ensureDir(overrideDir, 0o700);
  const overridePath = resolve(
    overrideDir,
    `compose.${opts.branch}.override.yml`
  );
  await writeTextFileIfChanged(overridePath, override, 0o600);
  return [opts.project.composeFile, overridePath];
}

export async function resolveRuntimeHostMetadataOverride(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly composeFiles: readonly string[];
  readonly branch: string | null;
  readonly devHost: string;
  readonly aliasHost: string | null;
  readonly composeProject: string;
}): Promise<string | null> {
  const composeYamls = (
    await Promise.all(
      opts.composeFiles.map(async (path) => await readTextFile(path))
    )
  ).filter((text): text is string => typeof text === "string");
  if (composeYamls.length === 0) {
    return null;
  }
  const override = buildRuntimeHostMetadataOverride({
    composeYamls,
    branch: opts.branch,
    devHost: opts.devHost,
    aliasHost: opts.aliasHost,
    composeProject: opts.composeProject,
  });
  if (!override) {
    return null;
  }

  await ensureHackGitInfoExclude({ projectDir: opts.project.projectDir });
  const overrideDir = resolve(
    opts.project.projectDir,
    opts.branch ? ".branch" : ".internal"
  );
  await ensureDir(overrideDir, 0o700);
  const overridePath = resolve(
    overrideDir,
    opts.branch
      ? `compose.${opts.branch}.runtime.override.yml`
      : "compose.runtime.override.yml"
  );
  await writeTextFileIfChanged(overridePath, override, 0o600);
  return overridePath;
}

async function resolveRuntimeDevHost(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly branch: string | null;
}): Promise<string> {
  if (opts.branch) {
    return await resolveBranchDevHost({ project: opts.project });
  }
  return (
    (await readProjectDevHost(opts.project)) ??
    `${defaultProjectSlugFromPath(opts.project.projectRoot)}.${DEFAULT_PROJECT_TLD}`
  );
}

const INTERNAL_CA_CONTAINER_DIR = "/etc/hack/ca";
const INTERNAL_CA_CONTAINER_PATH = `${INTERNAL_CA_CONTAINER_DIR}/caddy-local-authority.crt`;
const INTERNAL_TRUST_BUNDLE_CONTAINER_PATH = `${INTERNAL_CA_CONTAINER_DIR}/trust-bundle.pem`;

type InternalOverrideOptions = Parameters<
  typeof renderInternalComposeOverrideText
>[0];

/**
 * Renders the instance's internal override and stores it in Hack's home,
 * returning its path; when the instance needs none, removes a stored one, so
 * neither `exec` nor a later `run` passes stale addresses.
 */
async function resolveInternalComposeOverride(
  opts: InternalOverrideOptions
): Promise<string | null> {
  const path = internalOverrideStorePath({
    hackHome: resolveGlobalHackDir(),
    projectDir: opts.project.projectDir,
    branch: opts.branch ?? null,
  });
  const text = await renderInternalComposeOverrideText(opts);
  // The store now decides for this project: an in-project file an older Hack
  // wrote would otherwise come back for `exec` once the stored one is gone.
  await rm(legacyInternalOverridePath(opts.project.projectDir), {
    force: true,
  });
  if (text === null) {
    await rm(path, { force: true });
    return null;
  }
  return await writeInternalComposeOverride({ path, text });
}

async function renderInternalComposeOverrideText(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly branch?: string | null;
  readonly devHost?: string | null;
  readonly aliasHost?: string | null;
  /**
   * `fresh` (up, restart) reads Docker once; `recorded` (run) uses Hack's
   * record of the global stack with no Docker call when there is one.
   */
  readonly addresses: "recorded" | "fresh";
}): Promise<string | null> {
  const internal = resolveInternalSettings(opts.cfg);

  const { hosts: managedExtraHosts } = await resolveInternalExtraHosts({
    ...opts.project,
    staticHosts: internal.extraHosts ?? undefined,
  });
  if (!shouldBuildInternalOverride({ internal, managedExtraHosts })) {
    return null;
  }

  const services = await readComposeServicesForInternalOverride(
    opts.project.composeFile
  );
  if (services.length === 0) {
    return null;
  }
  const dns = await resolveInternalDnsSettings({
    project: opts.project,
    composeFile: opts.project.composeFile,
    enabled: internal.dns,
    cfg: opts.cfg,
    branch: opts.branch ?? null,
    devHost: opts.devHost ?? null,
    aliasHost: opts.aliasHost ?? null,
    addresses: opts.addresses,
  });
  const tls = await resolveInternalTlsPaths({ enabled: internal.tls });
  const extraHosts = buildInternalExtraHosts({
    caddyIp: dns.caddyIp,
    caddyHosts: dns.caddyHosts,
    managedExtraHosts,
  });
  if (!(dns.dnsServer || tls.caPath || Object.keys(extraHosts).length > 0)) {
    return null;
  }
  const text = renderInternalOverride({
    services,
    dnsServer: dns.dnsServer,
    extraHosts,
    caPath: tls.caPath,
    trustBundlePath: tls.bundlePath,
  });

  return text;
}

function shouldBuildInternalOverride(opts: {
  readonly internal: ReturnType<typeof resolveInternalSettings>;
  readonly managedExtraHosts: Record<string, string>;
}): boolean {
  const internalExtraHosts = opts.internal.extraHosts;
  const hasInternalExtraHosts =
    internalExtraHosts && Object.keys(internalExtraHosts).length > 0;
  const hasManagedExtraHosts = Object.keys(opts.managedExtraHosts).length > 0;
  const hasExtraHosts = hasInternalExtraHosts || hasManagedExtraHosts;
  return opts.internal.dns || opts.internal.tls || hasExtraHosts;
}

type InternalDnsSettings = {
  readonly dnsServer: string | null;
  readonly caddyIp: string | null;
  readonly caddyHosts: readonly string[];
};

async function resolveInternalDnsSettings(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly composeFile: string;
  readonly enabled: boolean;
  readonly branch: string | null;
  readonly devHost: string | null;
  readonly aliasHost: string | null;
  readonly addresses: "recorded" | "fresh";
}): Promise<InternalDnsSettings> {
  if (!opts.enabled) {
    return { dnsServer: null, caddyIp: null, caddyHosts: [] };
  }

  const addresses = await resolveGlobalIngressAddresses(opts.addresses);
  if (!(addresses.coreDns && addresses.caddy)) {
    const fallback = await describeDirectIngressAccess(opts);
    warnUnreachableIngress(addresses, fallback);
  }
  const dnsServer = addresses.coreDns;
  const caddyIp = addresses.caddy;
  const caddyHosts = await resolveCaddyHostsForBranch({
    project: opts.project,
    composeFile: opts.composeFile,
    branch: opts.branch,
    devHost: opts.devHost,
    aliasHost: opts.aliasHost,
  });

  return { dnsServer, caddyIp, caddyHosts };
}

async function describeDirectIngressAccess(
  opts: Parameters<typeof resolveInternalDnsSettings>[0]
): Promise<string> {
  const fallback =
    "Publish a service port with Compose `ports:`, for example `127.0.0.1:8080:80`, then run `hack up`.";
  // `recorded` (one-off `run`) makes no Docker call for the override; reading the
  // running containers here would inspect every one of them on each run.
  if (opts.addresses === "recorded") {
    return fallback;
  }
  const base = await resolveComposeProjectName(opts);
  const name = opts.branch ? `${base}--${opts.branch}` : base;
  const runtime = await readRuntimeProjects({ includeGlobal: false });
  const project = runtime.runtime.find((item) => item.project === name);
  return (
    runningComposeDirectAccess(
      project
        ? [...project.services.values()].flatMap(
            (service) => service.containers
          )
        : [],
      {
        project: name,
        checkout: opts.project.projectDir,
        linux: process.platform === "linux",
      }
    ) ?? fallback
  );
}

function warnUnreachableIngress(
  addresses: IngressAddressResult,
  fallback: string
): void {
  if (!addresses.coreDns) {
    logger.warn({
      message: `CoreDNS is not reachable; internal DNS for *.hack is disabled. ${fallback} For managed routing, run \`hack global install\` (or \`hack global up\`).`,
    });
  }
  if (!addresses.caddy) {
    logger.warn({
      message: `Caddy is not reachable; internal *.hack host mappings are disabled. ${addresses.coreDns ? `${fallback} ` : ""}Run \`hack global install\` (or \`hack global up\`).`,
    });
  }
}

async function resolveCaddyHostsForBranch(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly composeFile: string;
  readonly branch: string | null;
  readonly devHost: string | null;
  readonly aliasHost: string | null;
}): Promise<readonly string[]> {
  const caddyHosts = await readComposeCaddyHosts(opts.composeFile);
  if (!(caddyHosts.length > 0 && opts.branch)) {
    return caddyHosts;
  }

  const devHost =
    opts.devHost ?? (await resolveBranchDevHost({ project: opts.project }));
  const baseHosts = resolveProjectRouteBaseHosts({
    devHost,
    aliasHost: opts.aliasHost,
  });
  if (baseHosts.length === 0) {
    return caddyHosts;
  }

  return applyBranchToHosts({
    hosts: caddyHosts,
    branch: opts.branch,
    baseHosts,
  });
}

async function resolveInternalTlsPaths(opts: {
  readonly enabled: boolean;
}): Promise<{
  readonly caPath: string | null;
  readonly bundlePath: string | null;
}> {
  if (!opts.enabled) {
    return { caPath: null, bundlePath: null };
  }

  const caPath = await resolveCaddyLocalCaPath();
  if (!caPath) {
    logger.warn({
      message:
        "Caddy Local CA cert not found; internal TLS trust is disabled. Run `hack global trust` (or `hack global ca`).",
    });
    return { caPath: null, bundlePath: null };
  }

  const bundlePath = await findHackHostTrustBundlePath();
  if (!bundlePath) {
    logger.warn({
      message:
        "Combined trust bundle not found; containers get Node-only trust for *.hack hosts (OpenSSL-based tools keep public roots but won't trust internal TLS). Run `hack global trust` to generate it.",
    });
  }
  return { caPath, bundlePath };
}

function buildInternalExtraHosts(opts: {
  readonly caddyIp: string | null;
  readonly caddyHosts: readonly string[];
  readonly managedExtraHosts: Record<string, string>;
}): Record<string, string> {
  return {
    ...(opts.caddyIp && opts.caddyHosts.length > 0
      ? buildExtraHostsMap({ hosts: opts.caddyHosts, ip: opts.caddyIp })
      : {}),
    ...opts.managedExtraHosts,
  };
}

export function renderInternalOverride(opts: {
  readonly services: readonly InternalOverrideService[];
  readonly dnsServer: string | null;
  readonly extraHosts: Record<string, string>;
  readonly caPath: string | null;
  readonly trustBundlePath: string | null;
}): string {
  const overrideServices = buildInternalOverrideServices({
    services: opts.services,
    dnsServer: opts.dnsServer,
    extraHosts: opts.extraHosts,
    caPath: opts.caPath,
    trustBundlePath: opts.trustBundlePath,
  });
  const override = { services: overrideServices };
  const yaml = YAML.stringify(override, null, 2);
  return ensureTrailingNewline(cleanupYaml(yaml));
}

export interface InternalOverrideService {
  readonly name: string;
  readonly enableInternalDns: boolean;
}

function buildInternalOverrideServices(opts: {
  readonly services: readonly InternalOverrideService[];
  readonly dnsServer: string | null;
  readonly extraHosts: Record<string, string>;
  readonly caPath: string | null;
  readonly trustBundlePath: string | null;
}): Record<string, Record<string, unknown>> {
  const overrideServices: Record<string, Record<string, unknown>> = {};

  for (const service of opts.services) {
    const entry: Record<string, unknown> = {};
    if (opts.dnsServer && service.enableInternalDns) {
      entry.dns = [opts.dnsServer];
    }
    if (Object.keys(opts.extraHosts).length > 0) {
      entry.extra_hosts = opts.extraHosts;
    }
    if (opts.caPath) {
      entry.volumes = [
        `${opts.caPath}:${INTERNAL_CA_CONTAINER_PATH}:ro`,
        ...(opts.trustBundlePath
          ? [
              `${opts.trustBundlePath}:${INTERNAL_TRUST_BUNDLE_CONTAINER_PATH}:ro`,
            ]
          : []),
      ];
      entry.environment = buildInternalTlsEnvironment({
        bundleMounted: opts.trustBundlePath !== null,
      });
    }
    overrideServices[service.name] = entry;
  }

  return overrideServices;
}

/**
 * Env vars granting containers trust for hack's internal TLS hosts.
 *
 * Replace-semantics vars (SSL_CERT_FILE, CURL_CA_BUNDLE, REQUESTS_CA_BUNDLE,
 * GIT_SSL_CAINFO) may ONLY point at the combined public+local bundle — never
 * at the bare local CA, which would strip public roots from every
 * OpenSSL-based tool in the container (.NET/NuGet, git, python-requests).
 * Without the bundle, only append-semantics trust is set. SSL_CERT_DIR is
 * never set: overriding it discards the image's default hashed cert dir.
 */
export function buildInternalTlsEnvironment(opts: {
  readonly bundleMounted: boolean;
}): Record<string, string> {
  const base: Record<string, string> = {
    NODE_EXTRA_CA_CERTS: INTERNAL_CA_CONTAINER_PATH,
    HACK_LOCAL_CA_CERT: INTERNAL_CA_CONTAINER_PATH,
  };
  if (!opts.bundleMounted) {
    return base;
  }
  return {
    ...base,
    SSL_CERT_FILE: INTERNAL_TRUST_BUNDLE_CONTAINER_PATH,
    CURL_CA_BUNDLE: INTERNAL_TRUST_BUNDLE_CONTAINER_PATH,
    REQUESTS_CA_BUNDLE: INTERNAL_TRUST_BUNDLE_CONTAINER_PATH,
    GIT_SSL_CAINFO: INTERNAL_TRUST_BUNDLE_CONTAINER_PATH,
    HACK_HOST_TRUST_BUNDLE: INTERNAL_TRUST_BUNDLE_CONTAINER_PATH,
  };
}

/** Writes the override into Hack's home (atomically: a concurrent run reads a whole file). */
async function writeInternalComposeOverride(opts: {
  readonly path: string;
  readonly text: string;
}): Promise<string> {
  await ensureDir(dirname(opts.path), 0o700);
  await writeTextFileAtomicIfChanged(opts.path, opts.text, {
    createMode: 0o600,
  });
  return opts.path;
}

function resolveInternalSettings(
  cfg: Awaited<ReturnType<typeof readProjectConfig>>
): {
  readonly dns: boolean;
  readonly tls: boolean;
  readonly extraHosts: Record<string, string> | null;
} {
  return {
    dns: cfg.internal?.dns ?? true,
    tls: cfg.internal?.tls ?? true,
    extraHosts: cfg.internal?.extraHosts ?? null,
  };
}

async function readComposeServiceNames(
  composeFile: string
): Promise<readonly string[]> {
  const text = await readTextFile(composeFile);
  if (!text) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) {
    return [];
  }
  const servicesRaw = parsed.services;
  if (!isRecord(servicesRaw)) {
    return [];
  }
  return Object.keys(servicesRaw).sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve service metadata used to build `.hack/.internal/compose.override.yml`.
 *
 * DNS override should only be applied to ingress-network services; applying a
 * CoreDNS override to non-ingress services can break external DNS resolution
 * on remote nodes when cross-bridge CoreDNS routing is unavailable.
 */
async function readComposeServicesForInternalOverride(
  composeFile: string
): Promise<readonly InternalOverrideService[]> {
  const text = await readTextFile(composeFile);
  if (!text) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) {
    return [];
  }
  const servicesRaw = parsed.services;
  if (!isRecord(servicesRaw)) {
    return [];
  }

  const out: InternalOverrideService[] = [];
  const names = Object.keys(servicesRaw).sort((a, b) => a.localeCompare(b));
  for (const name of names) {
    const definition = servicesRaw[name];
    const networks = parseComposeServiceNetworkNames(definition);
    out.push({
      name,
      enableInternalDns: networks.includes(DEFAULT_INGRESS_NETWORK),
    });
  }
  return out;
}

function parseComposeServiceNetworkNames(value: unknown): readonly string[] {
  if (!isRecord(value)) {
    return [];
  }

  const networks = value.networks;
  if (Array.isArray(networks)) {
    const out: string[] = [];
    for (const entry of networks) {
      const names = parseComposeNetworkEntry(entry);
      for (const name of names) {
        out.push(name);
      }
    }
    return out;
  }

  if (!isRecord(networks)) {
    return [];
  }

  return Object.keys(networks)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseComposeNetworkEntry(value: unknown): readonly string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.keys(value)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function readComposeCaddyHosts(
  composeFile: string
): Promise<readonly string[]> {
  const text = await readTextFile(composeFile);
  if (!text) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return [];
  }

  if (!isRecord(parsed)) {
    return [];
  }
  const servicesRaw = parsed.services;
  if (!isRecord(servicesRaw)) {
    return [];
  }

  const hosts = new Set<string>();
  for (const serviceRaw of Object.values(servicesRaw)) {
    if (!isRecord(serviceRaw)) {
      continue;
    }
    const labels = normalizeLabels(serviceRaw.labels);
    if (!labels) {
      continue;
    }
    const caddyRaw = labels.caddy;
    if (typeof caddyRaw !== "string") {
      continue;
    }
    for (const host of extractCaddyHosts(caddyRaw)) {
      hosts.add(host);
    }
  }

  return Array.from(hosts).sort((a, b) => a.localeCompare(b));
}

function extractCaddyHosts(value: string): readonly string[] {
  const out: string[] = [];
  for (const part of value.split(",")) {
    let host = part.trim();
    if (!host) {
      continue;
    }

    if (host.startsWith("http://")) {
      host = host.slice("http://".length);
    }
    if (host.startsWith("https://")) {
      host = host.slice("https://".length);
    }
    const slashIdx = host.indexOf("/");
    if (slashIdx !== -1) {
      host = host.slice(0, slashIdx);
    }
    if (host.length === 0) {
      continue;
    }
    if (
      host.includes("*") ||
      host.includes("{") ||
      host.includes("}") ||
      host.includes("$")
    ) {
      continue;
    }
    if (host.includes(":")) {
      continue;
    }

    out.push(host);
  }
  return out;
}

function buildExtraHostsMap(opts: {
  readonly hosts: readonly string[];
  readonly ip: string;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const host of opts.hosts) {
    out[host] = opts.ip;
  }
  return out;
}

const globalIngressReads = new Map<
  "recorded" | "fresh",
  Promise<IngressAddressResult>
>();

/**
 * The global CoreDNS and Caddy addresses, once per process and mode (see
 * resolveIngressAddresses): `recorded` costs no Docker call when Hack has a
 * record, `fresh` one `docker inspect`. A fresh read this process also
 * answers `recorded`. No docker CLI means no answer, not a spawn failure:
 * `up` reports the missing engine itself (HACK-2356).
 */
async function resolveGlobalIngressAddresses(
  mode: "recorded" | "fresh"
): Promise<IngressAddressResult> {
  const cached =
    globalIngressReads.get("fresh") ?? globalIngressReads.get(mode);
  if (cached) {
    return await cached;
  }
  const read = resolveIngressAddresses(
    defaultIngressAddressDeps(resolveGlobalHackDir()),
    mode
  );
  globalIngressReads.set(mode, read);
  return await read;
}

async function resolveCoreDnsServer(): Promise<string | null> {
  return (await resolveGlobalIngressAddresses("fresh")).coreDns;
}

async function resolveCaddyLocalCaPath(): Promise<string | null> {
  const certPath = resolve(
    resolveGlobalHackDir(),
    GLOBAL_CADDY_DIR_NAME,
    "pki",
    "caddy-local-authority.crt"
  );
  return (await pathExists(certPath)) ? certPath : null;
}

async function resolveBranchDevHost(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
}): Promise<string> {
  const devHost = await readProjectDevHost(opts.project);
  if (devHost) {
    return devHost;
  }
  throw new Error(
    `Missing dev_host in ${opts.project.configFile} (or ${PROJECT_CONFIG_LEGACY_FILENAME}). Run: hack init`
  );
}

function resolveBranchAliasHost(opts: {
  readonly devHost: string;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
}): string | null {
  return resolveProjectOauthAliasHost({
    devHost: opts.devHost,
    oauth: opts.cfg.oauth,
  });
}

async function recordBranchUsageIfNeeded(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly branch: string | null;
  /** The name the slug came from; only up/restart pass it (HACK-2281). */
  readonly name?: string | null;
}): Promise<void> {
  if (!opts.branch) {
    return;
  }
  // Usage is machine-local state; never write the tracked hack.branches.json.
  const res = await recordBranchUsage({
    projectDir: opts.project.projectDir,
    branch: opts.branch,
    name: opts.name,
  });
  if (res.error) {
    logger.warn({
      message: `Failed to update ${res.path}: ${res.error}`,
    });
  }
}

async function touchProjectRegistration(
  project: Awaited<ReturnType<typeof requireProjectContext>>
): Promise<void> {
  const outcome = await upsertProjectRegistration({ project });
  if (outcome.status === "conflict") {
    logger.warn({
      message: [
        `Project name conflict: "${outcome.conflictName}" is already registered at ${outcome.existing.repoRoot}`,
        `Incoming project dir: ${outcome.incoming.projectDir}`,
        "Tip: rename one project (hack.config.json name) to keep names unique.",
      ].join("\n"),
    });
  }
}

function validateInitProjectSlug(
  value: string | undefined
): string | undefined {
  const v = value?.trim();
  if (!v) {
    return "Required";
  }
  const s = sanitizeProjectSlug(v);
  if (s.length === 0) {
    return "Invalid";
  }
  return undefined;
}

/**
 * Terminal seams for interactive `hack init`: the TTY check and every prompt
 * the interactive path asks. Production uses {@link CLACK_INIT_IO}; tests
 * inject scripted answers so the path, including the `--with` handoff, runs
 * without a terminal.
 */
export type InitInteractiveIo = {
  readonly canPrompt: () => boolean;
  readonly text: (opts: {
    readonly message: string;
    readonly initialValue: string;
    readonly validate: (value: string | undefined) => string | undefined;
  }) => Promise<string | symbol>;
  readonly confirm: (opts: {
    readonly message: string;
    readonly initialValue: boolean;
  }) => Promise<boolean | symbol>;
  /**
   * Service wizard that renders `.hack/docker-compose.yml`: the discovered
   * wizard when `useDiscovery`, otherwise the manual one.
   */
  readonly composeWizard: (opts: {
    readonly useDiscovery: boolean;
    readonly input: ComposeWizardInput;
  }) => Promise<string>;
  /** Coding-agent step prompts; omitted means the clack prompts. */
  readonly agentPrompts?: InitAgentIntegrationPrompts;
};

const CLACK_INIT_IO: InitInteractiveIo = {
  canPrompt,
  text: (opts) => text({ ...opts }),
  confirm: (opts) => confirm({ ...opts }),
  composeWizard: ({ useDiscovery, input }) =>
    useDiscovery ? buildDiscoveredCompose(input) : buildManualCompose(input),
};

async function promptInitProjectSlug(opts: {
  readonly io: InitInteractiveIo;
  readonly repoRoot: string;
  readonly nameOption: string | undefined;
}): Promise<string | null> {
  const defaultSlug = defaultProjectSlugFromPath(opts.repoRoot);
  const initialSlug = sanitizeProjectSlug(opts.nameOption ?? defaultSlug);
  const name = await opts.io.text({
    message: "Project name (slug):",
    initialValue: initialSlug,
    validate: validateInitProjectSlug,
  });
  if (isCancel(name)) {
    return null;
  }
  return sanitizeProjectSlug(name);
}

async function ensureInitProjectSlugUnique(opts: {
  readonly repoRoot: string;
  readonly slug: string;
}): Promise<void> {
  const registry = await readProjectsRegistry();
  const existing = registry.projects.find((p) => p.name === opts.slug) ?? null;
  if (!existing) {
    return;
  }

  const expectedProjectDir = resolve(opts.repoRoot, HACK_PROJECT_DIR_PRIMARY);
  const isSame = existing.projectDir === expectedProjectDir;
  if (isSame) {
    return;
  }

  const stillExists = await pathExists(existing.projectDir);
  if (!stillExists) {
    return;
  }

  throw new Error(
    [
      `Project name "${opts.slug}" is already registered.`,
      `Existing: ${existing.repoRoot}`,
      `This repo: ${opts.repoRoot}`,
      "Tip: choose a different name (or rename the other project).",
    ].join("\n")
  );
}

function validateInitDevHost(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) {
    return "Required";
  }
  if (v.includes(" ")) {
    return "No spaces";
  }
  if (v.includes("://")) {
    return "Host only (no scheme)";
  }
  if (v.includes("/")) {
    return "Host only (no path)";
  }
  if (v.includes(":")) {
    return "Host only (no port)";
  }
  return undefined;
}

async function promptInitDevHost(opts: {
  readonly io: InitInteractiveIo;
  readonly slug: string;
  readonly devHostOption: string | undefined;
  readonly defaultDomain: string;
}): Promise<string | null> {
  const defaultHost = `${opts.slug}.${opts.defaultDomain}`;
  const initialHost = (opts.devHostOption ?? defaultHost).trim();
  const devHost = await opts.io.text({
    message: "DEV_HOST:",
    initialValue: initialHost,
    validate: validateInitDevHost,
  });
  if (isCancel(devHost)) {
    return null;
  }
  return devHost.trim();
}

function validateInitOauthTld(value: string | undefined): string | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) {
    return "Required";
  }
  if (!SLUG_LABEL_PATTERN.test(v)) {
    return "Invalid TLD label";
  }
  return undefined;
}

async function promptInitOauthSettings(opts: {
  readonly io: InitInteractiveIo;
  readonly oauthEnabledDefault: boolean;
  readonly oauthTldOption: string | undefined;
}): Promise<{ readonly enabled: boolean; readonly tld: string } | null> {
  const enableOauthHost = await opts.io.confirm({
    message: `Enable OAuth-safe alias host (https://<project>.${DEFAULT_PROJECT_TLD}.${DEFAULT_OAUTH_ALIAS_TLD})?`,
    initialValue: opts.oauthEnabledDefault,
  });
  if (isCancel(enableOauthHost)) {
    return null;
  }

  if (!enableOauthHost) {
    return { enabled: false, tld: DEFAULT_OAUTH_ALIAS_TLD };
  }

  const oauthTld = await opts.io.text({
    message: "OAuth alias TLD (optional):",
    initialValue: opts.oauthTldOption ?? DEFAULT_OAUTH_ALIAS_TLD,
    validate: validateInitOauthTld,
  });
  if (isCancel(oauthTld)) {
    return null;
  }

  return { enabled: true, tld: String(oauthTld) };
}

function renderInitDiscoveryNote(opts: {
  readonly discovery: Awaited<ReturnType<typeof discoverRepo>>;
}): string {
  const monorepoLine = opts.discovery.isMonorepo
    ? "Monorepo detected."
    : "Single-package repo detected.";
  const signalsLine =
    opts.discovery.signals.length > 0
      ? `Signals: ${opts.discovery.signals.join(", ")}`
      : "Signals: none";

  return [
    `Detected ${opts.discovery.packages.length} package(s) and ${opts.discovery.candidates.length} dev-like script(s).`,
    monorepoLine,
    signalsLine,
  ].join("\n");
}

async function promptInitUseDiscovery(opts: {
  readonly io: InitInteractiveIo;
  readonly canDiscover: boolean;
  readonly forceManual: boolean;
}): Promise<boolean | null> {
  if (opts.forceManual || !opts.canDiscover) {
    return false;
  }

  const useDiscovery = await opts.io.confirm({
    message: "Auto-discover dev scripts and generate services?",
    initialValue: true,
  });
  if (isCancel(useDiscovery)) {
    return null;
  }
  return useDiscovery;
}

/**
 * `hack init` step for the committed `.hack/.gitignore`. Interactive init
 * reaches an existing file when the user confirms overwriting the scaffold;
 * a read-only one that lacks the managed block is left unchanged (see
 * `ensureHackDirGitignore`) and reported with the same fixed warning that
 * `hack doctor` and the machine-local env writes print, instead of silently.
 * Init still succeeds: the scaffold does not depend on the file.
 */
async function ensureInitHackDirGitignore(opts: {
  readonly hackDir: string;
}): Promise<void> {
  const result = await ensureHackDirGitignore({ projectDir: opts.hackDir });
  if (result.readOnly) {
    logger.warn({ message: HACK_DIR_GITIGNORE_READ_ONLY_WARNING });
  }
}

async function ensureInitHackDir(opts: {
  readonly io: InitInteractiveIo;
  readonly hackDir: string;
}): Promise<"proceed" | "skip" | null> {
  await assertLegacyProjectInputFamily({ projectRoot: dirname(opts.hackDir) });
  if (await pathExists(opts.hackDir)) {
    const ok = await opts.io.confirm({
      message: `${HACK_PROJECT_DIR_PRIMARY}/ already exists. Overwrite scaffold files?`,
      initialValue: false,
    });
    if (isCancel(ok)) {
      return null;
    }
    await assertLegacyProjectInputFamily({
      projectRoot: dirname(opts.hackDir),
    });
    if (!ok) {
      return "skip";
    }
    return "proceed";
  }

  return "proceed";
}

/**
 * `hack init`. `io` is the interactive path's terminal seam; the command
 * handler omits it and gets the real TTY check and clack prompts.
 */
export async function handleInit({
  ctx,
  args,
  io = CLACK_INIT_IO,
}: {
  readonly ctx: CliContext;
  readonly args: InitArgs;
  readonly io?: InitInteractiveIo;
}): Promise<number> {
  const withValue = resolveInitWithOption({ withRaw: args.options.with });
  const startDir = resolveStartDir(ctx, args.options.path);
  await assertLegacyProjectDiscovery({ startDir });

  if (args.options.auto) {
    return await handleInitAuto({ ctx, args, withValue });
  }

  const repoRoot = await findRepoRootForInit(startDir);
  await assertLegacyProjectInputFamily({ projectRoot: repoRoot });
  const backend = resolveInitComposeBackend();

  if (!io.canPrompt()) {
    requireInteractive({
      what: "hack init asks for project name, dev host, and discovery choices",
      hint: "Use `hack init --auto` (optionally with --name, --dev-host, --oauth, --oauth-tld, --manual) for scripted setup.",
    });
  }

  const slug = await promptInitProjectSlug({
    io,
    repoRoot,
    nameOption: args.options.name,
  });
  if (!slug) {
    return 1;
  }

  await ensureInitProjectSlugUnique({ repoRoot, slug });

  const devHost = await promptInitDevHost({
    io,
    slug,
    devHostOption: args.options.devHost,
    defaultDomain: args.options.devHost
      ? DEFAULT_NEW_PROJECT_TLD
      : await resolveDefaultDomain(),
  });
  if (!devHost) {
    return 1;
  }

  const oauth = await promptInitOauthSettings({
    io,
    oauthEnabledDefault:
      args.options.oauth === true || Boolean(args.options.oauthTld),
    oauthTldOption: args.options.oauthTld,
  });
  if (!oauth) {
    return 1;
  }

  const discovery = await discoverRepo(repoRoot);
  const canDiscover = discovery.candidates.length > 0;

  const forceManual = args.options.manual || args.options.noDiscovery;

  if (canDiscover && !forceManual) {
    note(renderInitDiscoveryNote({ discovery }), "Discovery");
  }

  const useDiscovery = await promptInitUseDiscovery({
    io,
    canDiscover,
    forceManual,
  });
  if (useDiscovery === null) {
    return 1;
  }

  const hackDir = resolve(repoRoot, HACK_PROJECT_DIR_PRIMARY);
  const composeFile = resolve(hackDir, PROJECT_COMPOSE_FILENAME);
  const configFile = resolve(hackDir, PROJECT_CONFIG_FILENAME);

  const hackDirAction = await ensureInitHackDir({ io, hackDir });
  if (!hackDirAction) {
    return 1;
  }
  if (hackDirAction === "skip") {
    if (withValue) {
      logger.info({
        message:
          ".hack/ already exists — handing off the onboarding prompt for the existing setup.",
      });
      await runInitOnboardingHandoff({
        repoRoot,
        withValue,
        scaffold: "existing",
        interactive: io.canPrompt(),
      });
    }
    return 0;
  }

  await assertLegacyProjectInputFamily({ projectRoot: repoRoot });
  const compose = await io.composeWizard({
    useDiscovery,
    input: {
      repoRoot,
      devHost,
      projectSlug: slug,
      candidates: discovery.candidates,
      oauth: { enabled: oauth.enabled, tld: oauth.tld },
      backend,
    },
  });
  await assertLegacyProjectInputFamily({ projectRoot: repoRoot });
  await ensureDir(hackDir, 0o755);

  // Committed, hack-owned ignore file for machine-local generated files
  // (.internal/, .branch/, .env, env state, env-local overrides).
  await assertLegacyProjectInputFamily({ projectRoot: repoRoot });
  await ensureInitHackDirGitignore({ hackDir });

  await writeInitScaffoldFile({
    repoRoot,
    file: configFile,
    content: renderProjectConfigJson({
      name: slug,
      devHost,
      oauth: { enabled: oauth.enabled, tld: oauth.tld },
    }),
  });
  await writeInitScaffoldFile({
    repoRoot,
    file: composeFile,
    content: compose,
  });

  await writeInitScaffoldFile({
    repoRoot,
    file: resolve(hackDir, "README.md"),
    content: renderHackFolderReadme({
      devHost,
      oauth: { enabled: oauth.enabled, tld: oauth.tld },
    }),
  });

  await writeInitScaffoldFile({
    repoRoot,
    file: resolve(hackDir, PROJECT_ENV_CONFIG_DEFAULT_FILENAME),
    content: renderProjectEnvConfigYaml(),
  });

  await assertLegacyProjectInputFamily({ projectRoot: repoRoot });
  const registration = await upsertProjectRegistration({
    project: {
      projectRoot: repoRoot,
      projectDirName: HACK_PROJECT_DIR_PRIMARY,
      projectDir: hackDir,
      composeFile,
      envFile: resolve(hackDir, PROJECT_ENV_FILENAME),
      configFile,
    },
  });
  if (registration.status === "conflict") {
    throw new Error(
      [
        `Project name conflict: "${registration.conflictName}" is already registered at ${registration.existing.repoRoot}`,
        `Incoming project dir: ${registration.incoming.projectDir}`,
        "Tip: choose a different name in 'hack init'.",
      ].join("\n")
    );
  }

  await runInitAgentIntegrations({
    repoRoot,
    interactive: io.canPrompt(),
    guard: assertLegacyProjectInputFamily,
    ...(io.agentPrompts ? { prompts: io.agentPrompts } : {}),
  });

  const next = initNextSteps({ backend, devHost });
  note(
    [
      `Wrote: ${HACK_PROJECT_DIR_PRIMARY}/${PROJECT_COMPOSE_FILENAME}`,
      `Wrote: ${HACK_PROJECT_DIR_PRIMARY}/${PROJECT_CONFIG_FILENAME}`,
      `Wrote: ${HACK_PROJECT_DIR_PRIMARY}/README.md`,
      `Wrote: ${HACK_PROJECT_DIR_PRIMARY}/${PROJECT_ENV_CONFIG_DEFAULT_FILENAME}`,
      "",
      "Next:",
      ...next.commands.map((command) => `  ${command}`),
      "",
      next.routing,
    ].join("\n"),
    "Initialized"
  );

  if (withValue) {
    await runInitOnboardingHandoff({
      repoRoot,
      withValue,
      scaffold: "created",
      interactive: io.canPrompt(),
    });
  }

  return 0;
}

async function handleInitAuto({
  ctx,
  args,
  withValue,
}: {
  readonly ctx: CliContext;
  readonly args: InitArgs;
  readonly withValue: OnboardingWith | null;
}): Promise<number> {
  const startDir = resolveStartDir(ctx, args.options.path);
  const repoRoot = await findRepoRootForInit(startDir);
  await assertLegacyProjectInputFamily({ projectRoot: repoRoot });
  const backend = resolveInitComposeBackend();

  const slug = resolveInitSlug({
    repoRoot,
    nameOpt: args.options.name,
  });

  await ensureUniqueProjectSlug({
    repoRoot,
    slug,
  });

  const devHost = resolveInitDevHost({
    slug,
    devHostOpt: args.options.devHost,
    defaultDomain: args.options.devHost
      ? DEFAULT_NEW_PROJECT_TLD
      : await resolveDefaultDomain(),
  });

  const oauthEnabled =
    args.options.oauth === true || Boolean(args.options.oauthTld);
  const oauth = resolveInitOauth({
    enabled: oauthEnabled,
    tldOpt: args.options.oauthTld,
  });

  const discovery = await discoverRepo(repoRoot);
  const canDiscover = discovery.candidates.length > 0;
  const skipDiscovery = args.options.manual || args.options.noDiscovery;
  const useDiscovery = canDiscover && !skipDiscovery;

  const hackDir = resolve(repoRoot, HACK_PROJECT_DIR_PRIMARY);
  const composeFile = resolve(hackDir, PROJECT_COMPOSE_FILENAME);
  const configFile = resolve(hackDir, PROJECT_CONFIG_FILENAME);

  await assertLegacyProjectInputFamily({ projectRoot: repoRoot });
  if (await pathExists(hackDir)) {
    if (withValue) {
      logger.info({
        message: `${HACK_PROJECT_DIR_PRIMARY}/ already exists — skipping init and handing off the onboarding prompt for the existing setup.`,
      });
      await runInitOnboardingHandoff({
        repoRoot,
        withValue,
        scaffold: "existing",
      });
      return 0;
    }
    throw initProjectExistsError({
      projectDirName: HACK_PROJECT_DIR_PRIMARY,
      nextCommand: initNextSteps({ backend, devHost }).autoCommand,
    });
  }

  const compose = useDiscovery
    ? await buildDiscoveredComposeAuto({
        repoRoot,
        devHost,
        projectSlug: slug,
        candidates: discovery.candidates,
        oauth,
        backend,
      })
    : await buildManualComposeAuto({
        repoRoot,
        devHost,
        projectSlug: slug,
        oauth,
        backend,
      });
  await assertLegacyProjectInputFamily({ projectRoot: repoRoot });
  await ensureDir(hackDir, 0o755);

  // Committed, hack-owned ignore file for machine-local generated files
  // (.internal/, .branch/, .env, env state, env-local overrides).
  await assertLegacyProjectInputFamily({ projectRoot: repoRoot });
  await ensureInitHackDirGitignore({ hackDir });

  await writeInitScaffoldFile({
    repoRoot,
    file: configFile,
    content: renderProjectConfigJson({
      name: slug,
      devHost,
      oauth: { enabled: oauth.enabled, tld: oauth.tld },
    }),
  });
  await writeInitScaffoldFile({
    repoRoot,
    file: composeFile,
    content: compose,
  });

  await writeInitScaffoldFile({
    repoRoot,
    file: resolve(hackDir, "README.md"),
    content: renderHackFolderReadme({
      devHost,
      oauth: { enabled: oauth.enabled, tld: oauth.tld },
    }),
  });

  await writeInitScaffoldFile({
    repoRoot,
    file: resolve(hackDir, PROJECT_ENV_CONFIG_DEFAULT_FILENAME),
    content: renderProjectEnvConfigYaml(),
  });

  await assertLegacyProjectInputFamily({ projectRoot: repoRoot });
  const registration = await upsertProjectRegistration({
    project: {
      projectRoot: repoRoot,
      projectDirName: HACK_PROJECT_DIR_PRIMARY,
      projectDir: hackDir,
      composeFile,
      envFile: resolve(hackDir, PROJECT_ENV_FILENAME),
      configFile,
    },
  });
  if (registration.status === "conflict") {
    throw new Error(
      [
        `Project name conflict: "${registration.conflictName}" is already registered at ${registration.existing.repoRoot}`,
        `Incoming project dir: ${registration.incoming.projectDir}`,
        "Tip: choose a different name in 'hack init'.",
      ].join("\n")
    );
  }

  logger.success({
    message: `Initialized ${HACK_PROJECT_DIR_PRIMARY}/ for ${slug}`,
  });
  const next = initNextSteps({ backend, devHost });
  // Discovery ran and found nothing: the scaffold is a placeholder that only
  // starts if the project happens to have a Bun "dev" script. Say so instead
  // of sending the user straight to `up`. An explicit --manual or
  // --no-discovery asked for the minimal scaffold and keeps its output.
  const placeholder = !(useDiscovery || skipDiscovery);
  if (placeholder) {
    logger.warn({ message: initPlaceholderNotice() });
  }
  logger.info({
    message: placeholder
      ? `Next: edit ${HACK_PROJECT_DIR_PRIMARY}/${PROJECT_COMPOSE_FILENAME}, then ${next.autoCommand}`
      : `Next: ${next.autoCommand}`,
  });
  logger.info({
    message: next.routing,
  });

  if (withValue) {
    await runInitOnboardingHandoff({
      repoRoot,
      withValue,
      scaffold: "created",
    });
  }

  return 0;
}

/** What a placeholder scaffold is and what to change, in one sentence. */
export function initPlaceholderNotice(): string {
  return `No runnable service was found in this repository, so ${HACK_PROJECT_DIR_PRIMARY}/${PROJECT_COMPOSE_FILENAME} has a placeholder service "app" (a Bun image running "bun run dev"). Set its image and command to how this project starts before hack up; hack init --with claude or --with codex hands that to an agent.`;
}

async function writeInitScaffoldFile(opts: {
  readonly repoRoot: string;
  readonly file: string;
  readonly content: string;
}): Promise<void> {
  await assertLegacyProjectInputFamily({ projectRoot: opts.repoRoot });
  if (basename(opts.file) === PROJECT_ENV_CONFIG_DEFAULT_FILENAME) {
    await writeTextFileAtomicIfChanged(opts.file, opts.content, {
      createMode: 0o644,
      validatePath: async (path) =>
        await assertProjectEnvLayerPath({ projectRoot: opts.repoRoot, path }),
    });
    return;
  }
  await writeTextFileIfChanged(opts.file, opts.content, 0o644);
}

/**
 * Validate the raw `--with` init option.
 *
 * @throws CliUsageError when the value is not `claude`, `codex`, or `both`.
 */
function resolveInitWithOption(opts: {
  readonly withRaw: string | undefined;
}): OnboardingWith | null {
  if (opts.withRaw === undefined) {
    return null;
  }
  const parsed = parseOnboardingWith({ value: opts.withRaw });
  if (!parsed) {
    throw new CliUsageError(
      `Invalid --with "${opts.withRaw}". Choose one agent: claude or codex.`
    );
  }
  return parsed;
}

/**
 * Hand the onboarding prompt to the requested agent CLI(s) after init.
 *
 * The prompt comes from the shared onboarding builder, which inventories the
 * repo and reads mode, project name and dev host from the `.hack/` config, so
 * the core matches `hack agent onboard`, `hack agent init` and the `hack-init`
 * MCP prompt for the same repo. `scaffold` only selects the handoff framing.
 *
 * Never spawns on non-interactive runs (`--no-interactive`,
 * `HACK_NO_INTERACTIVE`, or no TTY) — the prompt is printed for copy-paste
 * instead. Init success is never rolled back by handoff problems.
 *
 * @param opts.interactive - Defaults to the real TTY check; interactive init
 *   passes its injected {@link InitInteractiveIo.canPrompt} result.
 */
async function runInitOnboardingHandoff(opts: {
  readonly repoRoot: string;
  readonly withValue: OnboardingWith;
  readonly scaffold: "created" | "existing";
  readonly interactive?: boolean;
}): Promise<void> {
  await assertLegacyProjectInputFamily({ projectRoot: opts.repoRoot });
  const prompt = await buildOnboardingPrompt({
    startDir: opts.repoRoot,
    entryPoint: { kind: "init-with", scaffold: opts.scaffold },
  });

  await runOnboardingHandoff({
    prompt,
    withValue: opts.withValue,
    interactive: opts.interactive ?? canPrompt(),
  });
}

function resolveInitSlug(opts: {
  readonly repoRoot: string;
  readonly nameOpt?: string;
}): string {
  const fallback = defaultProjectSlugFromPath(opts.repoRoot);
  const raw = (opts.nameOpt ?? fallback).trim();
  if (!raw) {
    return fallback;
  }
  return sanitizeProjectSlug(raw);
}

async function ensureUniqueProjectSlug(opts: {
  readonly repoRoot: string;
  readonly slug: string;
}): Promise<void> {
  const registry = await readProjectsRegistry();
  const existing = registry.projects.find((p) => p.name === opts.slug) ?? null;
  if (!existing) {
    return;
  }

  const expectedProjectDir = resolve(opts.repoRoot, HACK_PROJECT_DIR_PRIMARY);
  const isSame = existing.projectDir === expectedProjectDir;
  const stillExists = await pathExists(existing.projectDir);
  if (!isSame && stillExists) {
    throw new Error(
      [
        `Project name "${opts.slug}" is already registered.`,
        `Existing: ${existing.repoRoot}`,
        `This repo: ${opts.repoRoot}`,
        "Tip: choose a different name (or rename the other project).",
      ].join("\n")
    );
  }
}

function resolveInitDevHost(opts: {
  readonly slug: string;
  readonly devHostOpt?: string;
  readonly defaultDomain: string;
}): string {
  const fallback = `${opts.slug}.${opts.defaultDomain}`;
  const raw = (opts.devHostOpt ?? fallback).trim();
  const error = validateDevHost({ value: raw });
  if (error) {
    throw new Error(`Invalid --dev-host: ${error}`);
  }
  return raw;
}

function resolveInitOauth(opts: {
  readonly enabled: boolean;
  readonly tldOpt?: string;
}): { readonly enabled: boolean; readonly tld: string } {
  const raw = (opts.tldOpt ?? DEFAULT_OAUTH_ALIAS_TLD).trim().toLowerCase();
  const error = validateOauthTld({ value: raw });
  if (error) {
    throw new Error(`Invalid --oauth-tld: ${error}`);
  }
  return { enabled: opts.enabled, tld: raw };
}

function validateDevHost(opts: { readonly value: string }): string | null {
  if (!opts.value) {
    return "Required";
  }
  if (opts.value.includes(" ")) {
    return "No spaces";
  }
  if (opts.value.includes("://")) {
    return "Host only (no scheme)";
  }
  if (opts.value.includes("/")) {
    return "Host only (no path)";
  }
  if (opts.value.includes(":")) {
    return "Host only (no port)";
  }
  return null;
}

function validateOauthTld(opts: { readonly value: string }): string | null {
  if (!opts.value) {
    return "Required";
  }
  if (!SLUG_LABEL_PATTERN.test(opts.value)) {
    return "Invalid TLD label";
  }
  return null;
}

// Exported for direct unit-testing of the auto (non-interactive) discovery
// + validation pipeline without going through the CLI prompt flow.
export interface ComposeWizardInput {
  readonly repoRoot: string;
  readonly devHost: string;
  readonly projectSlug: string;
  readonly candidates: readonly ServiceCandidate[];
  readonly oauth: {
    readonly enabled: boolean;
    readonly tld: string;
  };
  /** Backend the scaffold targets; omitted means `compose`. */
  readonly backend?: InitComposeBackend;
}

/**
 * The backend `hack init` scaffolds for. Native is chosen only by the same
 * explicit `HACK_RUNTIME_BACKEND=native` selection `hack up` reads (the
 * `hack-next` launcher sets it); anything else keeps the Compose scaffold.
 */
export function resolveInitComposeBackend(
  env: Readonly<Record<string, string | undefined>> = process.env
): InitComposeBackend {
  return env.HACK_RUNTIME_BACKEND === "native" ? "native" : "compose";
}

/**
 * Follow-up commands `hack init` prints, limited to ones the selected backend
 * accepts. Native `up` needs the explicit project-share grant; this follow-up
 * keeps its foreground form. `hack global install` refuses
 * on native, where routes use the optional native HTTPS frontend instead.
 */
export function initNextSteps(opts: {
  readonly backend: InitComposeBackend;
  readonly devHost: string;
}): {
  readonly commands: readonly string[];
  readonly autoCommand: string;
  readonly routing: string;
} {
  if (opts.backend === "native") {
    const up = "HACK_NATIVE_SHARED_SOURCE=1 hack up";
    return {
      commands: [
        `${up}   (foreground; keep it running)`,
        "hack open   (from another terminal)",
      ],
      autoCommand: `${up} (foreground; keep it running), then hack open from another terminal`,
      routing: `Routes for ${opts.devHost} need the optional native HTTPS frontend (HACK_NATIVE_CADDY_BINARY, HACK_NATIVE_CADDY_SHA256, HACK_NATIVE_HTTPS_PORT); check one with hack doctor --browser-url https://${opts.devHost}.`,
    };
  }
  return {
    commands: ["hack up", "hack open"],
    autoCommand: "hack up --detach && hack open",
    routing: `Check DNS/TLS for ${opts.devHost}; hack global install configures managed global domains (needs sudo).`,
  };
}

function normalizeOauthTld(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (t.length === 0) {
    return DEFAULT_OAUTH_ALIAS_TLD;
  }
  if (!SLUG_LABEL_PATTERN.test(t)) {
    return DEFAULT_OAUTH_ALIAS_TLD;
  }
  return t;
}

function buildCaddyHostLabelValue(opts: {
  readonly primaryHost: string;
  readonly oauth: { readonly enabled: boolean; readonly tld: string };
}): string {
  if (!opts.oauth.enabled) {
    return opts.primaryHost;
  }
  const tld = normalizeOauthTld(opts.oauth.tld);
  const aliasHost = resolveProjectOauthAliasHost({
    devHost: opts.primaryHost,
    oauth: { enabled: true, tld },
  });
  if (!aliasHost) {
    return opts.primaryHost;
  }

  const uniq = new Set<string>();
  const out: string[] = [];
  for (const host of [opts.primaryHost, aliasHost]) {
    if (uniq.has(host)) {
      continue;
    }
    uniq.add(host);
    out.push(host);
  }
  return out.join(", ");
}

function splitYamlInlineComment(rawAfter: string): {
  readonly valueRaw: string;
  readonly commentSuffix: string;
} {
  const commentIdx = rawAfter.indexOf(" #");
  if (commentIdx < 0) {
    return { valueRaw: rawAfter.trimEnd(), commentSuffix: "" };
  }

  return {
    valueRaw: rawAfter.slice(0, commentIdx).trimEnd(),
    commentSuffix: rawAfter.slice(commentIdx),
  };
}

function splitCaddyHosts(value: string): string[] {
  return value
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
}

function expandCaddyHostsWithOauthAliases(opts: {
  readonly hosts: readonly string[];
  readonly tld: string;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const host of opts.hosts) {
    if (seen.has(host)) {
      continue;
    }
    seen.add(host);
    out.push(host);
  }

  for (const host of opts.hosts) {
    const alias = resolveProjectOauthAliasHost({
      devHost: host,
      oauth: { enabled: true, tld: opts.tld },
    });
    if (!alias) {
      continue;
    }
    if (seen.has(alias)) {
      continue;
    }
    seen.add(alias);
    out.push(alias);
  }

  return out;
}

function maybePatchCaddyLabelLine(opts: {
  readonly line: string;
  readonly tld: string;
}): { readonly line: string; readonly changed: boolean } | null {
  const caddyMatch = CADDY_LABEL_PATTERN.exec(opts.line);
  if (!caddyMatch) {
    return null;
  }

  const indentStr = caddyMatch[1] ?? "";
  const rawAfter = caddyMatch[2] ?? "";

  const { valueRaw, commentSuffix } = splitYamlInlineComment(rawAfter);
  const valueTrimmed = valueRaw.trim();
  const quoted = parseQuotedValue(valueTrimmed);
  const parts = splitCaddyHosts(quoted.value);
  if (parts.length === 0) {
    return null;
  }

  const nextValue = expandCaddyHostsWithOauthAliases({
    hosts: parts,
    tld: opts.tld,
  }).join(", ");
  if (nextValue === quoted.value) {
    return null;
  }

  const formatted = quoted.quote
    ? `${quoted.quote}${nextValue}${quoted.quote}`
    : nextValue;
  return {
    line: `${indentStr}caddy: ${formatted}${commentSuffix}`,
    changed: true,
  };
}

function patchComposeOauthAliasesInCaddyLabels(opts: {
  readonly yamlText: string;
  readonly tld: string;
}): { readonly text: string; readonly changed: boolean } {
  const lines = opts.yamlText.split("\n");
  let inLabels = false;
  let labelsIndent = 0;
  let changed = false;

  const tld = normalizeOauthTld(opts.tld);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // Don't let blank/comment lines end a block.
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const labelsMatch = LABELS_LINE_PATTERN.exec(line);
    if (labelsMatch) {
      inLabels = true;
      labelsIndent = labelsMatch[1]?.length ?? 0;
      continue;
    }

    if (!inLabels) {
      continue;
    }

    const indent = INDENT_PATTERN.exec(line)?.[1]?.length ?? 0;
    if (indent <= labelsIndent) {
      inLabels = false;
      continue;
    }

    const patched = maybePatchCaddyLabelLine({ line, tld });
    if (patched) {
      changed = true;
      lines[i] = patched.line;
    }
  }

  return { text: lines.join("\n"), changed };
}

async function maybeSyncOauthAliasesInCompose(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
}): Promise<void> {
  const cfg = await readProjectConfig(opts.project);
  if (cfg.parseError) {
    return;
  }
  if (!cfg.oauth?.enabled) {
    return;
  }

  const tld = normalizeOauthTld(cfg.oauth.tld ?? DEFAULT_OAUTH_ALIAS_TLD);

  const yamlText = await readTextFile(opts.project.composeFile);
  if (!yamlText) {
    return;
  }

  const patched = patchComposeOauthAliasesInCaddyLabels({ yamlText, tld });
  if (!patched.changed) {
    return;
  }

  await writeTextFileIfChanged(opts.project.composeFile, patched.text);
}

function unwrapPromptValue<T>(value: T | symbol): T {
  if (isCancel(value)) {
    throw new Error("Canceled");
  }
  return value;
}

const RESERVED_COMPOSE_SERVICE_NAMES = new Set(["db", "redis"]);

function validateComposeServiceName(opts: {
  readonly value: string | undefined;
  readonly defaultName: string;
  readonly usedServiceNames: ReadonlySet<string>;
  readonly reserved?: ReadonlySet<string>;
}): string | undefined {
  const v = opts.value?.trim();
  if (!v) {
    return "Required";
  }
  if (!SLUG_LABEL_PATTERN.test(v)) {
    return "Use lowercase letters, numbers, and '-' only";
  }
  if (opts.reserved?.has(v) === true) {
    return "Reserved name";
  }
  if (opts.usedServiceNames.has(v) && v !== opts.defaultName) {
    return "Duplicate";
  }
  return undefined;
}

function validatePort(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) {
    return "Required";
  }
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0 || n >= 65_536) {
    return "Invalid port";
  }
  return undefined;
}

function validateRequiredText(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) {
    return "Required";
  }
  return undefined;
}

function validateSubdomain(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v) {
    return "Required";
  }
  if (v.includes(".")) {
    return "Subdomain only (no dots)";
  }
  if (!SLUG_LABEL_PATTERN.test(v)) {
    return "Invalid subdomain";
  }
  return undefined;
}

async function selectCandidatesForDiscoveredCompose(opts: {
  readonly candidates: readonly ServiceCandidate[];
}): Promise<{
  readonly selectedCandidates: ServiceCandidate[];
  readonly dedupeFindings: readonly InitDiscoveryFinding[];
}> {
  const byId = new Map(opts.candidates.map((c) => [c.id, c] as const));

  // Default-select the deduped set (best script per package, aggregator
  // scripts dropped in favor of the package's own script) so the common
  // case is a single confirm — the user can still add dropped candidates
  // back via the multiselect.
  const dedupe = dedupeCandidates({ candidates: opts.candidates });
  const defaultIds = dedupe.selected.map((c) => c.id);
  const droppedIds = new Set(
    opts.candidates.filter((c) => !defaultIds.includes(c.id)).map((c) => c.id)
  );

  const selectedIds = unwrapPromptValue(
    await autocompleteMultiselect<string>({
      message: "Select dev scripts to include as services:",
      required: true,
      initialValues: defaultIds,
      options: opts.candidates.map((c) => ({
        value: c.id,
        label: formatCandidateLabel(c),
        hint: formatCandidateHint(c),
      })),
    })
  );

  const selectedCandidates: ServiceCandidate[] = [];
  for (const id of selectedIds) {
    const c = byId.get(id);
    if (c) {
      selectedCandidates.push(c);
    }
  }

  if (selectedCandidates.length === 0) {
    throw new Error("No services selected");
  }

  // Only report dedupe findings when the user kept the pruned selection —
  // if they manually re-added every dropped candidate, there's nothing left
  // to warn about.
  const stillDropped = [...droppedIds].some((id) => !selectedIds.includes(id));
  const dedupeFindings = stillDropped ? dedupe.findings : [];

  return { selectedCandidates, dedupeFindings };
}

async function promptDraftForDiscoveredCandidate(opts: {
  readonly candidate: ServiceCandidate;
  readonly usedServiceNames: Set<string>;
}): Promise<AutoComposeDraft> {
  note(
    opts.candidate.scriptCommand,
    `${opts.candidate.packageRelativeDir} (${opts.candidate.scriptName})`
  );

  const defaultName = uniqueName(
    guessServiceName(opts.candidate),
    opts.usedServiceNames
  );
  const defaultRole = guessRole(opts.candidate);

  const role = unwrapPromptValue(
    await select<"http" | "internal">({
      message: `Service role for "${defaultName}":`,
      initialValue: defaultRole,
      options: [
        { value: "http", label: "HTTP (routed via Caddy)" },
        { value: "internal", label: "Internal (not routed via Caddy)" },
      ],
    })
  );

  const name = unwrapPromptValue(
    await text({
      message: "docker compose service name:",
      initialValue: defaultName,
      validate: (value) =>
        validateComposeServiceName({
          value,
          defaultName,
          usedServiceNames: opts.usedServiceNames,
          reserved: RESERVED_COMPOSE_SERVICE_NAMES,
        }),
    })
  );
  opts.usedServiceNames.add(name);

  const inferredPort = inferPortFromScript(opts.candidate.scriptCommand);
  const defaultPort = inferredPort ?? guessDefaultPort(name);

  const portNum =
    role === "http"
      ? Number.parseInt(
          unwrapPromptValue(
            await text({
              message: "Internal HTTP port:",
              initialValue: String(defaultPort),
              validate: validatePort,
            })
          ),
          10
        )
      : undefined;

  const workingDir =
    opts.candidate.packageRelativeDir === "."
      ? "/app"
      : `/app/${opts.candidate.packageRelativeDir}`;

  const suggestedCommand = buildSuggestedCommand({
    candidate: opts.candidate,
    role,
    port: portNum,
  });

  const command = unwrapPromptValue(
    await text({
      message: "Container command:",
      initialValue: suggestedCommand,
      validate: validateRequiredText,
    })
  );

  return {
    name,
    role,
    port: portNum,
    workingDir,
    command,
    candidate: opts.candidate,
  };
}

async function promptHttpSubdomainsForDrafts(opts: {
  readonly drafts: AutoComposeDraft[];
  readonly devHost: string;
  readonly primaryDefaultStrategy?: "prefer-www" | "first";
}): Promise<void> {
  const httpDrafts = opts.drafts.filter((d) => d.role === "http");
  if (httpDrafts.length === 0) {
    return;
  }

  const primaryDefault =
    opts.primaryDefaultStrategy === "first"
      ? httpDrafts[0]?.name
      : (httpDrafts.find((d) => d.name === "www")?.name ?? httpDrafts[0]?.name);
  const primary = unwrapPromptValue(
    await select<string>({
      message: `Which service should be routed at https://${opts.devHost}?`,
      initialValue: primaryDefault,
      options: httpDrafts.map((d) => ({
        value: d.name,
        label: d.name,
      })),
    })
  );

  for (const d of httpDrafts) {
    if (d.name === primary) {
      continue;
    }

    const defaultSub = guessSubdomain(d.name);
    const sub = unwrapPromptValue(
      await text({
        message: `Subdomain for "${d.name}" (https://<sub>.${opts.devHost}):`,
        initialValue: defaultSub,
        validate: validateSubdomain,
      })
    );
    d.subdomain = sub;
  }

  const primaryDraft = httpDrafts.find((d) => d.name === primary);
  if (primaryDraft) {
    primaryDraft.subdomain = "";
  }
}

async function buildDiscoveredCompose(
  input: ComposeWizardInput
): Promise<string> {
  const { selectedCandidates, dedupeFindings } =
    await selectCandidatesForDiscoveredCompose({
      candidates: input.candidates,
    });
  const usedServiceNames = new Set<string>();
  const drafts: AutoComposeDraft[] = [];

  for (const candidate of selectedCandidates) {
    drafts.push(
      await promptDraftForDiscoveredCandidate({
        candidate,
        usedServiceNames,
      })
    );
  }

  await promptHttpSubdomainsForDrafts({
    drafts,
    devHost: input.devHost,
  });

  const findings = [...dedupeFindings];
  await applyRuntimeDetectionToDrafts({
    drafts,
    repoRoot: input.repoRoot,
    findings,
  });
  applyPortCollisionReassignment({ drafts, findings });

  const discoveryForServices = await discoverRepo(input.repoRoot);
  const backingServices = await detectBackingServices({
    repoRoot: input.repoRoot,
    packages: discoveryForServices.packages,
  });
  const existingComposeFiles = await findExistingComposeFiles({
    repoRoot: input.repoRoot,
  });
  findings.push(...buildExistingComposeFindings({ existingComposeFiles }));

  reportInitDiscoveryFindings({ findings });

  const services = buildServicesFromDrafts({
    drafts,
    devHost: input.devHost,
    oauth: input.oauth,
  });

  return renderCompose({
    name: input.projectSlug,
    services,
    headerComments: buildDiscoveryHeaderComments({
      detections: backingServices,
      existingComposeFiles,
    }),
    backend: input.backend ?? "compose",
  });
}

type AutoComposeDraft = {
  name: string;
  role: "http" | "internal";
  port?: number;
  subdomain?: string;
  workingDir: string;
  command: string;
  image?: string;
  candidate?: ServiceCandidate;
  comments?: string[];
};

/**
 * Runs `detectPackageRuntime` for each draft that carries its source
 * candidate and, for non-JS runtimes, sets the compose TODO-image sentinel
 * plus an explanatory comment instead of silently defaulting to the
 * bun-node image. Mutates `drafts` in place and appends one
 * `unknown-runtime` finding per detected draft.
 */
async function applyRuntimeDetectionToDrafts(opts: {
  readonly drafts: AutoComposeDraft[];
  readonly repoRoot: string;
  readonly findings: InitDiscoveryFinding[];
}): Promise<void> {
  for (const draft of opts.drafts) {
    const candidate = draft.candidate;
    if (!candidate) {
      continue;
    }

    const runtime = await detectPackageRuntime({
      dir:
        candidate.packageRelativeDir === "."
          ? opts.repoRoot
          : resolve(opts.repoRoot, candidate.packageRelativeDir),
      scriptCommand: candidate.scriptCommand,
      repoRoot: opts.repoRoot,
    });
    if (!runtime) {
      continue;
    }

    draft.image = TODO_IMAGE_SENTINEL;
    draft.comments = [
      ...(draft.comments ?? []),
      describeUnknownRuntimeComment({ serviceName: draft.name, runtime }),
    ];
    opts.findings.push({
      kind: "unknown-runtime",
      serviceName: draft.name,
      runtime,
    });
  }
}

/**
 * Detects HTTP drafts sharing a port, reassigns duplicates to the next
 * free port (ascending), and rewrites their command via
 * `buildSuggestedCommand`. Mutates `drafts` in place and appends one
 * `port-reassigned` finding per reassignment.
 */
function applyPortCollisionReassignment(opts: {
  readonly drafts: AutoComposeDraft[];
  readonly findings: InitDiscoveryFinding[];
}): void {
  const collisionDrafts: PortCollisionDraft[] = [];
  for (const draft of opts.drafts) {
    if (!draft.candidate) {
      continue;
    }
    collisionDrafts.push({
      name: draft.name,
      role: draft.role,
      port: draft.port,
      candidate: draft.candidate,
    });
  }

  const { reassignments, findings } = reassignCollidingPorts({
    drafts: collisionDrafts,
  });
  opts.findings.push(...findings);

  for (const draft of opts.drafts) {
    const reassignment = reassignments.get(draft.name);
    if (!reassignment) {
      continue;
    }
    draft.port = reassignment.port;
    draft.command = reassignment.command;
  }
}

// Exported for direct unit-testing (see tests/init-discovery-validation.test.ts).
export async function buildDiscoveredComposeAuto(
  input: ComposeWizardInput
): Promise<string> {
  const dedupe = dedupeCandidates({ candidates: input.candidates });
  const selectedCandidates = selectAutoCandidates({
    candidates: dedupe.selected,
  });
  if (selectedCandidates.length === 0) {
    throw new Error("No dev scripts discovered for auto init.");
  }

  const findings: InitDiscoveryFinding[] = [...dedupe.findings];

  const usedServiceNames = new Set<string>();
  const drafts: AutoComposeDraft[] = [];

  for (const candidate of selectedCandidates) {
    const name = resolveAutoServiceName({ candidate, usedServiceNames });
    usedServiceNames.add(name);

    const role = guessRole(candidate);
    const port =
      role === "http"
        ? (inferPortFromScript(candidate.scriptCommand) ??
          guessDefaultPort(name))
        : undefined;
    const workingDir =
      candidate.packageRelativeDir === "."
        ? "/app"
        : `/app/${candidate.packageRelativeDir}`;
    const command = buildSuggestedCommand({ candidate, role, port });

    drafts.push({
      name,
      role,
      port,
      workingDir,
      command,
      candidate,
    });
  }

  assignAutoSubdomains({ drafts });

  await applyRuntimeDetectionToDrafts({
    drafts,
    repoRoot: input.repoRoot,
    findings,
  });
  applyPortCollisionReassignment({ drafts, findings });

  const discovery = await discoverRepo(input.repoRoot);
  const backingServices = await detectBackingServices({
    repoRoot: input.repoRoot,
    packages: discovery.packages,
  });
  const existingComposeFiles = await findExistingComposeFiles({
    repoRoot: input.repoRoot,
  });
  findings.push(...buildExistingComposeFindings({ existingComposeFiles }));

  reportInitDiscoveryFindings({ findings });

  const services = buildServicesFromDrafts({
    drafts,
    devHost: input.devHost,
    oauth: input.oauth,
  });

  return renderCompose({
    name: input.projectSlug,
    services,
    headerComments: buildDiscoveryHeaderComments({
      detections: backingServices,
      existingComposeFiles,
    }),
    backend: input.backend ?? "compose",
  });
}

interface ManualComposeWizardInput {
  readonly repoRoot: string;
  readonly devHost: string;
  readonly projectSlug: string;
  readonly oauth: {
    readonly enabled: boolean;
    readonly tld: string;
  };
  readonly backend?: InitComposeBackend;
}

function validateRepoRelativeWorkingDir(
  value: string | undefined
): string | undefined {
  const v = value?.trim();
  if (!v) {
    return "Required";
  }
  if (v.startsWith("/")) {
    return "Use a repo-relative path (e.g. ., apps/api)";
  }
  return undefined;
}

function buildManualSuggestedCommand(opts: {
  readonly role: "http" | "internal";
  readonly port: number | undefined;
}): string {
  if (opts.role !== "http") {
    return "bun run dev";
  }
  const port = opts.port ?? 3000;
  return `bun run dev -- --port ${port} --host 0.0.0.0`;
}

async function promptManualServiceDraft(opts: {
  readonly defaultName: string;
  readonly usedServiceNames: Set<string>;
}): Promise<AutoComposeDraft> {
  const role = unwrapPromptValue(
    await select<"http" | "internal">({
      message: `Service role for "${opts.defaultName}":`,
      initialValue: "http",
      options: [
        { value: "http", label: "HTTP (routed via Caddy)" },
        { value: "internal", label: "Internal (not routed via Caddy)" },
      ],
    })
  );

  const name = unwrapPromptValue(
    await text({
      message: "docker compose service name:",
      initialValue: opts.defaultName,
      validate: (value) =>
        validateComposeServiceName({
          value,
          defaultName: opts.defaultName,
          usedServiceNames: opts.usedServiceNames,
        }),
    })
  );
  opts.usedServiceNames.add(name);

  const image = unwrapPromptValue(
    await text({
      message: `Image for "${name}":`,
      initialValue: "imbios/bun-node:latest",
      validate: validateRequiredText,
    })
  );

  const workingDirRel = unwrapPromptValue(
    await text({
      message: `Working dir (relative to repo root) for "${name}":`,
      initialValue: ".",
      validate: validateRepoRelativeWorkingDir,
    })
  );

  const portNum =
    role === "http"
      ? Number.parseInt(
          unwrapPromptValue(
            await text({
              message: `Internal HTTP port for "${name}":`,
              initialValue: String(guessDefaultPort(name)),
              validate: validatePort,
            })
          ),
          10
        )
      : undefined;

  const command = unwrapPromptValue(
    await text({
      message: `Container command for "${name}":`,
      initialValue: buildManualSuggestedCommand({ role, port: portNum }),
      validate: validateRequiredText,
    })
  );

  const relRaw = workingDirRel.trim();
  const rel = normalizeRelativePath(relRaw);
  const workingDir = rel === "." ? "/app" : `/app/${rel}`;

  return {
    name,
    role,
    image: image.trim(),
    port: portNum,
    workingDir,
    command,
  };
}

async function buildManualCompose(
  input: ManualComposeWizardInput
): Promise<string> {
  note(
    [
      "No dev scripts were auto-discovered (or you opted out).",
      "Let’s define your services manually. You can always edit the generated compose after.",
    ].join("\n"),
    "Manual services"
  );

  const usedServiceNames = new Set<string>();
  const drafts: AutoComposeDraft[] = [];

  while (true) {
    const defaultName = uniqueName("app", usedServiceNames);

    drafts.push(
      await promptManualServiceDraft({
        defaultName,
        usedServiceNames,
      })
    );

    const more = unwrapPromptValue(
      await confirm({
        message: "Add another service?",
        initialValue: false,
      })
    );
    if (!more) {
      break;
    }
  }

  await promptHttpSubdomainsForDrafts({
    drafts,
    devHost: input.devHost,
    primaryDefaultStrategy: "first",
  });

  const services = buildServicesFromDrafts({
    drafts,
    devHost: input.devHost,
    oauth: input.oauth,
  });

  return renderCompose({
    name: input.projectSlug,
    services,
    backend: input.backend ?? "compose",
  });
}

function buildManualComposeAuto(input: ManualComposeWizardInput): string {
  const port = guessDefaultPort("app");
  const drafts: AutoComposeDraft[] = [
    {
      name: "app",
      role: "http",
      port,
      subdomain: "",
      workingDir: "/app",
      command: `bun run dev -- --port ${port} --host 0.0.0.0`,
    },
  ];

  const services = buildServicesFromDrafts({
    drafts,
    devHost: input.devHost,
    oauth: input.oauth,
  });

  return renderCompose({
    name: input.projectSlug,
    services,
    backend: input.backend ?? "compose",
  });
}

function formatCandidateLabel(c: ServiceCandidate): string {
  const base = c.packageName ?? c.packageRelativeDir;
  return `${base} → ${c.scriptName}`;
}

function formatCandidateHint(c: ServiceCandidate): string {
  const dir = c.packageRelativeDir;
  const cmd =
    c.scriptCommand.length > 60
      ? `${c.scriptCommand.slice(0, 57)}…`
      : c.scriptCommand;
  return `${dir} · ${cmd}`;
}

function uniqueName(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) {
    return base;
  }
  for (let i = 2; i < 1000; i += 1) {
    const next = `${base}-${i}`;
    if (!used.has(next)) {
      return next;
    }
  }
  return `${base}-${Date.now()}`;
}

function guessSubdomain(serviceName: string): string {
  const n = serviceName.toLowerCase();
  if (n.includes("api")) {
    return "api";
  }
  if (n === "www" || n === "web") {
    return "www";
  }
  return serviceName;
}

function selectAutoCandidates(opts: {
  readonly candidates: readonly ServiceCandidate[];
}): readonly ServiceCandidate[] {
  const devCandidates = opts.candidates.filter(
    (c) => c.scriptName === "dev" || c.scriptName.startsWith("dev:")
  );
  return devCandidates.length > 0 ? devCandidates : opts.candidates;
}

function resolveAutoServiceName(opts: {
  readonly candidate: ServiceCandidate;
  readonly usedServiceNames: ReadonlySet<string>;
}): string {
  const base = guessServiceName(opts.candidate);
  const normalized = base.length > 0 ? base : "app";
  const safe =
    normalized === "db" || normalized === "redis" ? "app" : normalized;
  return uniqueName(safe, opts.usedServiceNames);
}

function assignAutoSubdomains(opts: {
  readonly drafts: AutoComposeDraft[];
}): void {
  const httpDrafts = opts.drafts.filter((d) => d.role === "http");
  if (httpDrafts.length === 0) {
    return;
  }

  const primary = httpDrafts.find((d) => d.name === "www") ?? httpDrafts[0];
  if (primary) {
    primary.subdomain = "";
  }

  const used = new Set<string>();
  for (const draft of httpDrafts) {
    if (draft === primary) {
      continue;
    }
    const base = guessSubdomain(draft.name);
    const subdomain = uniqueSubdomain({ base, used });
    used.add(subdomain);
    draft.subdomain = subdomain;
  }
}

function uniqueSubdomain(opts: {
  readonly base: string;
  readonly used: ReadonlySet<string>;
}): string {
  const seed = sanitizeProjectSlug(opts.base);
  const normalized = seed.length > 0 ? seed : "app";
  if (!opts.used.has(normalized)) {
    return normalized;
  }
  for (let i = 2; i < 1000; i += 1) {
    const next = `${normalized}-${i}`;
    if (!opts.used.has(next)) {
      return next;
    }
  }
  return `${normalized}-${Date.now()}`;
}

function buildServicesFromDrafts(opts: {
  readonly drafts: readonly AutoComposeDraft[];
  readonly devHost: string;
  readonly oauth: { readonly enabled: boolean; readonly tld: string };
}) {
  return opts.drafts.map((d) => {
    const env = new Map<string, string>();

    const labels = new Map<string, string>();
    const networks = d.role === "http" ? ["hack-dev", "default"] : [];
    const httpPort = d.role === "http" ? (d.port ?? 3000) : undefined;

    if (httpPort !== undefined) {
      const port = httpPort;
      const host =
        d.subdomain && d.subdomain.length > 0
          ? `${d.subdomain}.${opts.devHost}`
          : `${opts.devHost}`;
      labels.set(
        "caddy",
        buildCaddyHostLabelValue({ primaryHost: host, oauth: opts.oauth })
      );
      labels.set("caddy.reverse_proxy", `{{upstreams ${port}}}`);
      labels.set("caddy.tls", "internal");
    }

    return {
      name: d.name,
      role: d.role,
      image: d.image ?? "imbios/bun-node:latest",
      workingDir: d.workingDir,
      command: d.command,
      env,
      labels,
      networks,
      ...(httpPort === undefined ? {} : { httpPort }),
      ...(d.comments && d.comments.length > 0 ? { comments: d.comments } : {}),
    };
  });
}

function renderHackFolderReadme(opts: {
  readonly devHost: string;
  readonly oauth?: { readonly enabled: boolean; readonly tld: string };
}): string {
  const oauthEnabled = opts.oauth?.enabled === true;
  const oauthTld = oauthEnabled
    ? normalizeOauthTld(opts.oauth?.tld ?? DEFAULT_OAUTH_ALIAS_TLD)
    : null;
  const oauthHost = resolveProjectOauthAliasHost({
    devHost: opts.devHost,
    oauth: { enabled: oauthEnabled, tld: oauthTld ?? undefined },
  });

  return [
    "# hack local dev",
    "",
    "This repo is configured for the `hack` local-dev platform.",
    "",
    "## Networks",
    "",
    "- `hack-dev`: shared ingress network (Caddy routes only services attached to this network).",
    "- `default`: per-project network created by Docker Compose.",
    "",
    "Rules:",
    "- Only attach **HTTP services** you want routable to `hack-dev`.",
    "- Do **not** attach Postgres/Redis to `hack-dev`.",
    "- Avoid `container_name` (breaks multi-repo).",
    "",
    "## Service-to-service connections (important)",
    "",
    "When services run inside Docker containers, `127.0.0.1` / `localhost` refers to **that container**, not the",
    "other services in the compose file.",
    "",
    "So inside containers, use Docker Compose DNS names:",
    "",
    "- Postgres: host `db`, port `5432`",
    "- Redis: host `redis`, port `6379`",
    "",
    "Example env for an app container:",
    "",
    "```yaml",
    "environment:",
    "  DATABASE_URL: postgres://postgres:postgres@db:5432/mydb",
    "  REDIS_URL: redis://redis:6379",
    "```",
    "",
    "If you need to run tools inside an already-running container, prefer `hack exec`:",
    "",
    "```bash",
    "hack exec db -- psql -U postgres -d mydb",
    "hack exec redis -- redis-cli",
    "```",
    "",
    "## Hostnames",
    "",
    `- Primary app: https://${opts.devHost}`,
    `- Subdomains: https://<sub>.${opts.devHost} (e.g. api.${opts.devHost})`,
    ...(oauthHost
      ? [
          "",
          "OAuth note:",
          `- OAuth-safe alias (public suffix): https://${oauthHost}`,
          `- OAuth-safe subdomains: https://<sub>.${oauthHost} (e.g. api.${oauthHost})`,
        ]
      : []),
    "",
    "## Logs (Grafana + Loki)",
    "",
    `- Open Grafana: https://${DEFAULT_GRAFANA_HOST}`,
    "- Default credentials: `admin` / `admin`",
    "",
    "In **Explore**, try queries like:",
    "",
    '- `{project="<compose-project>"}`',
    '- `{project="<compose-project>", service="api"}`',
    "",
    "Tip: `project`/`service` labels come from Docker Compose labels (via Alloy).",
    "",
    "## Adding a routable HTTP service",
    "",
    "Add a service under `services:` in `.hack/docker-compose.yml` and include:",
    "",
    "```yaml",
    "labels:",
    `  caddy: api.${opts.devHost}`,
    '  caddy.reverse_proxy: "{{upstreams 4000}}"',
    "  caddy.tls: internal",
    "networks:",
    "  - hack-dev",
    "  - default",
    "```",
    "",
    "## Adding Postgres / Redis (optional)",
    "",
    "Postgres (default network only):",
    "",
    "```yaml",
    "db:",
    "  image: postgres:17",
    "  environment:",
    "    POSTGRES_USER: postgres",
    "    POSTGRES_PASSWORD: postgres",
    "    POSTGRES_DB: mydb",
    "  volumes:",
    "    - postgres-data:/var/lib/postgresql/data",
    "  networks:",
    "    - default",
    "```",
    "",
    "Redis (default network only):",
    "",
    "```yaml",
    "redis:",
    "  image: bitnami/redis:latest",
    "  environment:",
    '    ALLOW_EMPTY_PASSWORD: "yes"',
    "  volumes:",
    "    - redis-data:/bitnami/redis/data",
    "  networks:",
    "    - default",
    "```",
    "",
    "Add volumes at the bottom:",
    "",
    "```yaml",
    "volumes:",
    "  postgres-data:",
    "  redis-data:",
    "```",
    "",
    "## DB schema tooling (Prisma / Drizzle)",
    "",
    "For DB tooling in a monorepo, the cleanest approach is to run commands inside the project network so you",
    "don’t need to publish DB ports to your host.",
    "",
    "Option A (recommended): create an ops-only service in `.hack/docker-compose.yml`:",
    "",
    "```yaml",
    "db-ops:",
    "  image: imbios/bun-node:latest",
    "  working_dir: /app/packages/db # adjust to your db package",
    "  volumes:",
    "    - ..:/app",
    "  environment:",
    "    DATABASE_URL: postgres://postgres:postgres@db:5432/mydb",
    "  depends_on:",
    "    - db",
    "  networks:",
    "    - default",
    '  profiles: ["ops"]',
    "  # Prisma:",
    "  # command: bunx prisma migrate deploy",
    "  # Drizzle:",
    "  # command: bunx drizzle-kit push",
    "  command: bun run db:push",
    "```",
    "",
    "Then run it on demand:",
    "",
    "```bash",
    "docker compose -f .hack/docker-compose.yml --profile ops run --rm db-ops",
    "```",
    "",
    "Option B: run one-off commands without adding a new service using `hack run`:",
    "",
    "```bash",
    "hack run --workdir /app/packages/db email-sync -- bunx prisma generate",
    "hack run --workdir /app/packages/db email-sync -- bunx prisma migrate dev",
    "hack run --workdir /app/packages/db email-sync -- bunx drizzle-kit push",
    "```",
    "",
    "If your ops service is behind a compose profile, enable it:",
    "",
    "```bash",
    "hack run --profile ops --workdir /app/packages/db db-ops -- bun run db:push",
    "```",
    "",
    "### If you see: “Host version … does not match binary version …”",
    "",
    "That error is from **esbuild** (often triggered by Drizzle tooling compiling `*.ts` config).",
    "It usually means you’re running container commands against a partially mismatched install (common if you try",
    "to share host `node_modules` into a Linux container).",
    "",
    "Best fix: keep host deps on host, and give containers their own deps via a volume:",
    "",
    "```yaml",
    "services:",
    "  www:",
    "    volumes:",
    "      - ..:/app",
    "      - node_modules:/app/node_modules",
    "",
    "volumes:",
    "  node_modules:",
    "```",
    "",
    "Then install once inside the container volume:",
    "",
    "```bash",
    "hack run --workdir /app www -- bun install",
    "```",
    "",
    "",
  ].join("\n");
}

async function requireProjectContext(startDir: string) {
  const ctx = await findProjectContext(startDir);
  if (!ctx) {
    throw new MissingProjectContextError();
  }
  return ctx;
}

type RemoteLifecycleAction = "up" | "down" | "restart";

/**
 * Resolve whether project lifecycle commands should run locally or dispatch remotely.
 */
async function resolveProjectLifecycleTarget(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly requestedTarget: string | undefined;
}): Promise<ReturnType<typeof resolveProjectExecutionTarget>> {
  const controlPlane = await readControlPlaneConfig({
    projectDir: opts.project.projectDir,
  });
  if (controlPlane.parseError) {
    logger.warn({ message: controlPlane.parseError });
  }
  const registry = await readNodesRegistry();
  return resolveProjectExecutionTarget({
    requestedTarget: opts.requestedTarget,
    controlPlane: controlPlane.config,
    defaultNodeId: registry.defaultNodeId ?? undefined,
  });
}

/**
 * Ensure dispatch can select this project by resolving/refreshing registration id.
 */
async function resolveDispatchProjectSelector(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
}): Promise<string> {
  const registration = await upsertProjectRegistration({
    project: opts.project,
  });
  if (registration.status === "conflict") {
    return registration.existing.id;
  }
  return registration.project.id;
}

/**
 * Build remote lifecycle command args that always force local execution on target node.
 */
function buildRemoteLifecycleCommand(opts: {
  readonly action: RemoteLifecycleAction;
  readonly branch: string | null;
  readonly profiles: readonly string[];
  readonly envName?: string | null;
  readonly detach?: boolean;
  readonly services?: readonly string[];
}): readonly string[] {
  const args = [opts.action, "--target", "local"] as string[];
  if (opts.envName) {
    args.push("--env", opts.envName);
  }
  if (opts.branch) {
    args.push("--branch", opts.branch);
  }
  if (opts.profiles.length > 0) {
    args.push("--profile", opts.profiles.join(","));
  }
  if (opts.action === "up" && opts.detach === true) {
    args.push("--detach");
  }
  args.push(...(opts.services ?? []));
  return args;
}

/**
 * Dispatch lifecycle command to remote node when project execution target resolves to remote.
 */
async function runRemoteLifecycleCommand(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly action: RemoteLifecycleAction;
  readonly branch: string | null;
  readonly profiles: readonly string[];
  readonly envName?: string | null;
  readonly requestedTarget: string | undefined;
  readonly detach?: boolean;
  readonly services?: readonly string[];
}): Promise<number | null> {
  if (process.env.HACK_AUTOSTART_LOGIN === "1") {
    // Machine-local unattended intent never dispatches a host command remotely.
    return null;
  }
  const target = await resolveProjectLifecycleTarget({
    project: opts.project,
    requestedTarget: opts.requestedTarget,
  });
  if (target.resolvedTarget === "local") {
    return null;
  }
  if (isLifecycleProgressRequested()) {
    // Dispatch output would precede `start`; remote targets are unsupported.
    throw new CliUsageError("--progress is not supported for remote targets.");
  }

  const projectSelector = await resolveDispatchProjectSelector({
    project: opts.project,
  });
  const dispatchNode = target.nodeSelector ?? "default";
  const remoteCommand = buildRemoteLifecycleCommand({
    action: opts.action,
    branch: opts.branch,
    profiles: opts.profiles,
    envName: opts.envName,
    detach: opts.detach,
    services: opts.services,
  });
  const invocation = await resolveHackInvocation();
  const dispatchArgs = [...invocation.args, "dispatch", "run"] as string[];
  dispatchArgs.push("--project", projectSelector);
  dispatchArgs.push("--node", dispatchNode);
  dispatchArgs.push("--runner", "generic");
  if (opts.branch) {
    dispatchArgs.push("--branch", opts.branch);
  }
  dispatchArgs.push("--", "hack", ...remoteCommand);

  logger.step({
    message: `Dispatching remote ${opts.action} on node ${dispatchNode} (${target.reason})`,
  });
  return await runShell([invocation.bin, ...dispatchArgs], {
    cwd: opts.project.projectRoot,
    hackReexec: true,
    // Under Hack's own --json the dispatch output precedes the envelope
    // (emitRemoteLifecycleJson), so it goes to stderr (HACK-2311).
    stdout: childStdoutTarget(undefined),
  });
}

/** Compose-style line for a service that stopped while `up` runs. */
function nativeServiceExitMessage(exit: NativeServiceExit): string {
  if (exit.state === "exited") {
    return `${exit.service} exited with code ${exit.code}`;
  }
  return exit.state === "dead"
    ? `${exit.service} died (dead or out of memory)`
    : `${exit.service} container was removed`;
}

/**
 * Foreground native progress, matching Compose's attached `up`: steps while the
 * graph starts, one ready line, then the stop sequence after Ctrl-C.
 */
function reportNativeStartupProgress(event: NativeStartupProgress): void {
  switch (event.phase) {
    case "input":
      logger.step({ message: "Preparing native project input…" });
      return;
    case "runtime":
      logger.step({ message: "Starting the native runtime…" });
      return;
    case "build-settled":
      logger.info({
        message: `Build ${event.services.join(", ")}: ${event.outcome} in ${formatDuration(event.durationMs)}`,
      });
      return;
    case "images":
      logger.step({ message: "Acquiring service images…" });
      return;
    case "plan":
      // Only a detached launcher's clocks use it; the terminal shows nothing.
      return;
    case "services":
      logger.step({
        message: `Starting services: ${event.services.join(", ")}…`,
      });
      return;
    case "dependency-wait":
      logger.step({
        message: `Waiting for host listener ${event.binding} (service ${event.service}, host port ${event.hostPort}): ${event.waitedSeconds} s of ${event.limitSeconds} s…`,
      });
      return;
    case "ready":
      logger.success({
        message: [
          `Project is ready (${event.services.join(", ")}; run ${event.run}). Use hack ps and hack logs from another terminal; press Ctrl-C to stop.`,
          ...event.endpoints,
        ].join("\n"),
      });
      return;
    case "service-exited":
      logger.warn({ message: nativeServiceExitMessage(event) });
      return;
    case "all-stopped":
      logger.info({
        message: "All services have stopped; ending native up as Compose does.",
      });
      return;
    case "stopping":
      logger.step({
        message: "Stopping the native project; waiting for owned cleanup…",
      });
      return;
    case "stopped":
      logger.info({ message: event.summary ?? "Native project stopped." });
      return;
    default:
      return;
  }
}

/**
 * Native's Compose profile selection for this project, from the same sources
 * and in the same order as Compose under Hack: `--profile`, else
 * `COMPOSE_PROFILES` in the managed env of the selected env, else in the shell
 * (see {@link selectNativeProfiles}). A managed env that cannot be resolved
 * here contributes nothing; native input preparation refuses it next.
 */
/**
 * The notice for a running or retained native run whose recorded profiles
 * differ from what the environment now selects, read for the run's own env;
 * null when they agree or nothing selects profiles (HACK-2338 item 8).
 */
async function nativeRetainedProfilesDrift(opts: {
  readonly project: Awaited<ReturnType<typeof resolveProjectForArgs>>;
  readonly saved: {
    readonly profiles?: readonly string[];
    readonly effectiveEnvName?: string | null;
  };
}): Promise<string | null> {
  const fromEnv = await resolveNativeProfileSelectionForProject({
    project: opts.project,
    envName: opts.saved.effectiveEnvName,
    cliProfile: undefined,
  });
  if (fromEnv.secretIgnored) {
    return NATIVE_SECRET_PROFILE_SELECTOR_NOTICE;
  }
  const retained = [...(opts.saved.profiles ?? [])].sort();
  const selected = [...fromEnv.profiles].sort();
  if (
    (fromEnv.source !== "managed-env" && fromEnv.source !== "shell") ||
    JSON.stringify(retained) === JSON.stringify(selected)
  ) {
    return null;
  }
  // Environment-selected and retained names are counted, never shown.
  const shownRetained = nativeNoticeProfileNames({
    profiles: retained,
    source: "retained",
  });
  const shownSelected = nativeNoticeProfileNames({
    profiles: selected,
    source: fromEnv.source,
  });
  return nativeRetainedProfilesNotice({
    retained: shownRetained.shown,
    hiddenRetained: shownRetained.hidden,
    selected: shownSelected.shown,
    hiddenSelected: shownSelected.hidden,
    source: fromEnv.source,
  });
}

/** An explicit `--profile` list, with Compose's `*` expanded to every declared profile. */
/**
 * The native `--profile` value, or undefined when it names no profile: as in
 * Hack's Compose path, an empty list (`--profile ""`) falls back to
 * COMPOSE_PROFILES instead of selecting none (HACK-2338 item 8).
 */
export function nativeProfileOption(
  value: string | undefined
): string | undefined {
  return value === undefined || parseCsvList(value).length === 0
    ? undefined
    : value;
}

async function resolveNativeCliProfiles(opts: {
  readonly project: Awaited<ReturnType<typeof resolveProjectForArgs>>;
  readonly cliProfile: string;
}): Promise<readonly string[]> {
  const compose = await readNativeComposeDocument(
    opts.project.composeFile
  ).catch(() => null);
  return selectNativeProfiles({
    cliProfiles: parseCsvList(opts.cliProfile),
    managedEnv: {},
    shellEnv: {},
    declaredProfiles: declaredComposeProfiles(compose),
  }).profiles;
}

async function handleNativeUp({
  ctx,
  args,
  native,
  restart = false,
  recovery,
}: {
  readonly restart?: boolean;
  readonly recovery?: {
    readonly expectAttempt: string;
    readonly legacyPid?: number;
  };
  readonly ctx: CliContext;
  readonly args: UpArgs;
  readonly native: NonNullable<
    ReturnType<typeof resolveNativeRuntimeSelection>
  >;
}): Promise<number> {
  refuseUnsupportedNativeUpOptions({
    restart,
    detach: args.options.detach,
    json: args.options.json,
    target: args.options.target,
    services: args.positionals.services,
  });
  // A detached `up` owner reports a closed refusal from here until VM work
  // starts exactly as this command prints it in the foreground (HACK-2339).
  nativeDetachedUpPrestart(!restart);
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
    touchRegistration: false,
  });
  // HACK-2358: refuse an invalid setting before anything starts or stops,
  // and say what is kept local. A detached owner's output is not shown; its
  // launcher printed these already.
  if (!isNativeDetachedOwnerProcess()) {
    await reportNativeLocalDirectories({
      project,
      warn: (message) => logger.warn({ message }),
    });
  }
  // Native writes machine-local state under `.hack/.internal` too (env
  // fingerprints, run records): keep it out of `git status` as Compose does.
  await ensureHackGitInfoExclude({ projectDir: project.projectDir });
  // Before branch, config, env, lifecycle, storage or runtime work. `down`
  // stays available for any graph a project already has.
  // The selected adaptation applies first: a network it isolates is not
  // external here, exactly as native start normalizes it. Without --env every
  // committed per-env adaptation is a candidate (see nativeAdaptationCandidates).
  // With native builds enabled, build fields native builds implement pass
  // here and native build admission reviews them, secret-valued args included.
  const requestedEnvName = resolveRequestedEnvName({
    envOption: args.options.env,
  });
  const adaptation = await resolveNativeAdaptationSelection({
    env: process.env,
    projectDir: project.projectDir,
  });
  await refuseNativeComposeBackendFeatures({
    composeFile: project.composeFile,
    adaptationCandidates: nativeAdaptationCandidates({
      selection: adaptation,
      requestedEnvName,
    }),
    restart,
    buildsEnabled: nativeBuildsEnabled(),
    // The printed Compose fallback selects the same project and branch.
    projectRoot: project.projectRoot,
    branch:
      typeof args.options.branch === "string" ? args.options.branch : undefined,
    env: typeof args.options.env === "string" ? args.options.env : undefined,
  });
  const branchIdentity = await resolveEffectiveBranchIdentityForCommand({
    project,
    branchOption: args.options.branch,
  });
  const branch = branchIdentity.branch;
  if (!isNativeDetachedOwnerProcess()) {
    await trackNativeLocalDirectories({
      project,
      branch,
      mode: restart ? "restart" : "start",
      warn: (message) => logger.warn({ message }),
    });
  }
  // Foreground native up and restart record the name like Compose up does;
  // the detached owner child keeps the name its launcher recorded.
  await recordBranchUsageIfNeeded({
    project,
    branch,
    name: isNativeDetachedOwnerProcess() ? null : branchIdentity.name,
  });
  const cfg = await readProjectConfig(project);
  if (cfg.parseError) {
    throw new CliUsageError(
      "Native up requires valid project configuration; values omitted."
    );
  }
  const projectName = await resolveComposeProjectName({ project, cfg });
  const host = await resolveNativeHostSettings({
    env: process.env,
    projectName,
    projectRoot: project.projectRoot,
  });
  const composeProject = resolveLifecycleComposeProjectName({
    projectName,
    branch,
  });
  const devHost = await resolveRuntimeDevHost({ project, branch });
  const envFingerprintScope = {
    projectDir: project.projectDir,
    owner: "image" as const,
    branch,
  };
  const envFingerprints =
    createNativeEnvFingerprintSession(envFingerprintScope);
  const { hosts: internalExtraHosts, sources: internalExtraHostSources } =
    await resolveNativeInternalExtraHostSelection({ project, cfg });
  let ready = false;
  const startup: Parameters<typeof startNativeProject>[0] = {
    runtime: native,
    scope: {
      projectRoot: project.projectRoot,
      projectDir: project.projectDir,
      nativeHome: native.home,
      branch,
    },
    composeFile: project.composeFile,
    imageTagMode: nativeImageTagMode(args.options),
    envName: requestedEnvName,
    // An explicit --profile only; otherwise native start resolves Compose's
    // own sources for the effective env (HACK-2338 item 8).
    profiles:
      nativeProfileOption(args.options.profile) === undefined
        ? undefined
        : await resolveNativeCliProfiles({
            project,
            cliProfile: args.options.profile ?? "",
          }),
    resolveProfiles: async (envName) =>
      await resolveNativeProfileSelectionForProject({
        project,
        envName,
        cliProfile: undefined,
      }),
    sharedSource: host.sharedSource,
    dependencyFile: host.dependencyFile,
    dependencyFileByEnv: host.dependencyFileByEnv,
    dependencyOwners: createNativeDependencyOwnerResolver({
      projectDir: project.projectDir,
      composeProject,
      sharedHelpers: cfg.lifecycle?.sharedHelpers ?? [],
    }),
    adaptationFile: adaptation.file,
    adaptationFileByEnv: adaptation.fileByEnv,
    internalExtraHosts,
    internalExtraHostSources,
    allowedHosts: host.allowedHosts,
    preparedBase: host.preparedBase,
    https: host.https,
    aws: host.aws,
    gcloud: host.gcloud,
    gcloudWithheld: host.gcloud === undefined && host.origins.gcloud === "env",
    runtimeMetadata: {
      devHost,
      aliasHost: resolveBranchAliasHost({ devHost, cfg }),
      projectName,
    },
    onEnvironmentReady: async ({ run, fingerprint }) =>
      await envFingerprints.record(
        createNativeEnvFingerprintEntry({ owner: "image", run, fingerprint })
      ),
    onReady: (services, addresses) => {
      const primaryHost = branch
        ? applyBranchToHost({
            branch,
            host: devHost,
            baseHosts: resolveProjectRouteBaseHosts({
              devHost,
              aliasHost: resolveBranchAliasHost({ devHost, cfg }),
            }),
          })
        : devHost;
      nativeDetachedUpReady({
        project: projectName,
        branch,
        composeProject,
        address: selectLifecycleAddress(addresses, primaryHost),
        ...services,
      });
    },
    startTimeoutSeconds: resolveNativeStartTimeoutSeconds({
      env: process.env,
      project: cfg.native?.startTimeoutSeconds,
    }),
    // HACK-2456: the pool stopped under this run; `hack down --recover`
    // starts it and stops the run with data retained before this start.
    // Restart keeps its own refusals.
    ...(restart
      ? {}
      : {
          recoverStoppedPool: async () => {
            const scope = {
              projectRoot: project.projectRoot,
              projectDir: project.projectDir,
              nativeHome: native.home,
              branch,
            };
            await nativeProjectDown({
              ...(await nativeDownRequest({
                project,
                native,
                scope,
                branch,
                routeStdoutToStderr: args.options.json === true,
              })),
              recover: true,
            });
          },
        }),
    onProgress: (event) => {
      if (event.phase === "runtime") {
        // VM work starts: later failures keep the runtime's own reports.
        nativeDetachedUpPrestart(false);
      }
      // A detached launcher's clocks follow these phases (HACK-2351).
      nativeDetachedUpProgress(event.phase);
      if (event.phase === "ready") {
        ready = true;
      }
      if (
        (restart || ready || event.phase !== "stopped") &&
        (event.phase !== "build-settled" || args.options.json !== true)
      ) {
        reportNativeStartupProgress(event);
      }
    },
    before: async (input, signal) => {
      const lifecycle = await runLifecycleUpBeforeAndProcesses({
        title: "Lifecycle (native up before)",
        startupSignal: signal,
        project,
        cfg,
        projectName,
        branch,
        env: input.lifecycleHostEnvironment,
        effectiveEnvName: input.effectiveEnvName,
        composeProject,
      });
      const cleanup = adoptNativeLifecycleCleanup(lifecycle);
      if (lifecycle.code !== 0) {
        await cleanup();
        // Compose reports the same failure as `Lifecycle (up before) failed
        // (exit N)`; the hook's name and output were printed as it ran.
        throw new HackCliError({
          code: "E_LIFECYCLE_FAILED",
          message: `Lifecycle (native up before) failed (exit ${lifecycle.code}); values omitted.`,
        });
      }
      // Native declares these before review; a hook cannot change them now.
      // This re-reads hack.config.json, not the pre-hook `cfg` snapshot.
      await requireNativeProjectInternalExtraHostsUnchanged({
        project,
        reviewed: internalExtraHosts,
        cleanup,
      });
      // The native backend launches services after this returns: refuse when a
      // concurrent down already released this instance's shared helpers.
      await assertNativeSharedHelpersCurrent({ lifecycle, cleanup });
      // Ctrl-C runs these as `hack down` would (journaled, never replayed).
      const down = cfg.lifecycle?.down;
      const stopPhase = (phase: "before" | "after") => (signal: AbortSignal) =>
        runLifecycleCommands({
          title: `Lifecycle (native down ${phase})`,
          commands: down?.[phase],
          projectRoot: project.projectRoot,
          env: input.lifecycleHostEnvironment,
          projectDir: project.projectDir,
          composeProject,
          signal,
        });
      return {
        cleanup,
        listenerHooks: resolvePersistentLifecycleNames(cfg.lifecycle),
        ...(down?.before?.length || down?.after?.length
          ? { stop: { before: stopPhase("before"), after: stopPhase("after") } }
          : {}),
        ready: async (readySignal: AbortSignal) => {
          await assertNativeSharedHelpersCurrent({
            lifecycle,
            cleanup,
            servicesStarted: true,
          });
          const code = await runLifecycleCommands({
            title: "Lifecycle (native up after)",
            startupSignal: readySignal,
            commands: cfg.lifecycle?.up?.after,
            projectRoot: project.projectRoot,
            env: input.lifecycleHostEnvironment,
            projectDir: project.projectDir,
            composeProject,
          });
          if (readySignal.aborted) {
            return;
          }
          if (code !== 0) {
            throw new HackCliError({
              code: "E_LIFECYCLE_FAILED",
              message:
                "Native up lifecycle readiness hook failed; values omitted.",
            });
          }

          await recordEnvMigrationProjectRun({
            projectRoot: project.projectRoot,
            projectDir: project.projectDir,
            projectName,
            serviceNames: await discoverComposeServiceNames({
              composeFile: project.composeFile,
            }),
          }).catch(() =>
            logger.warn({
              message:
                "Could not record successful env migration startup; legacy cleanup remains blocked (values omitted).",
            })
          );
        },
      };
    },
  };
  if (!restart) {
    try {
      const code = await startNativeProject(startup).catch((error: unknown) => {
        if (error instanceof NativeStartupCanceledError) {
          return error.interruptedExit;
        }
        throw error;
      });
      if (code === 130 && !ready) {
        process.stderr.write("Native project startup interrupted.\n");
      }
      return code;
    } finally {
      await envFingerprints.release();
    }
  }
  if (!startup.sharedSource) {
    throw new HackCliError({
      code: "E_PERMISSION",
      message:
        "Native restart requires HACK_NATIVE_SHARED_SOURCE=1 or sharedSource in the native machine settings before cleanup; nothing was stopped. Grant the project share and run the command again.",
    });
  }
  try {
    return await restartNativeImageProject({
      ctx,
      args,
      native,
      project,
      cfg,
      projectName,
      branch,
      composeProject,
      startup,
      recovery,
      // Stopping the previous run makes its record stale; a failed restart
      // then leaves no record, so exec stays silent rather than guessing.
      dropEnvFingerprint: () => envFingerprints.drop(),
    });
  } finally {
    await envFingerprints.release();
  }
}

async function restartNativeImageProject({
  ctx,
  args,
  native,
  project,
  cfg,
  projectName,
  branch,
  composeProject,
  startup,
  recovery,
  dropEnvFingerprint,
}: {
  readonly ctx: CliContext;
  readonly args: UpArgs;
  readonly native: NonNullable<
    ReturnType<typeof resolveNativeRuntimeSelection>
  >;
  readonly project: Awaited<ReturnType<typeof resolveProjectForArgs>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly projectName: string;
  readonly branch: string | null;
  readonly composeProject: string;
  readonly startup: Parameters<typeof startNativeProject>[0];
  readonly recovery?: {
    readonly expectAttempt: string;
    readonly legacyPid?: number;
  };
  readonly dropEnvFingerprint: () => void;
}): Promise<number> {
  // One "Stopping…" line, whether the restart or its new start sees the request.
  let stoppingReported = false;
  const progress = (event: NativeStartupProgress): void => {
    if (event.phase === "stopping") {
      if (stoppingReported) {
        return;
      }
      stoppingReported = true;
    }
    reportNativeStartupProgress(event);
  };
  let verifiedBuildImages:
    | Awaited<ReturnType<typeof preflightNativeRestart>>
    | undefined;
  return await restartNativeProject({
    scope: startup.scope,
    envName: startup.envName,
    profiles:
      nativeProfileOption(args.options.profile) === undefined
        ? undefined
        : startup.profiles,
    recovery: recovery
      ? {
          ...recovery,
          verifyEffects: async ({ run, token }) =>
            await verifyNativeFrontendRecovery({
              runtime: native,
              scope: startup.scope,
              run,
              httpsPort:
                token.version !== 1
                  ? token.httpsPort
                  : (startup.https?.httpsPort ?? null),
              legacy: token.version === 1,
              httpsLease: token.version === 3 ? token.httpsLease : undefined,
              cleanupLifecycle: async () =>
                await stopLifecycleProcesses({
                  project,
                  cfg,
                  projectName: sanitizeProjectSlug(projectName),
                  branch,
                  composeProject,
                }),
            }),
          retirePublisher: async (run) =>
            await retireNativeRecoveredPublisher({
              runtime: native,
              scope: startup.scope,
              run,
            }),
        }
      : undefined,
    preflight: async (run, { cleanedRetry, preparedRetry, signal }) => {
      await preflightNativeProjectSource({
        runtime: native,
        projectRoot: startup.scope.projectRoot,
      });
      // The replacement start pins exactly the build images checked here,
      // so nothing is built after the old graph stopped (HACK-2533).
      verifiedBuildImages = await preflightNativeRestart({
        signal,
        runtime: native,
        scope: startup.scope,
        composeFile: startup.composeFile,
        adaptationFile: startup.adaptationFile,
        adaptationFileByEnv: startup.adaptationFileByEnv,
        dependencyFile: startup.dependencyFile,
        dependencyFileByEnv: startup.dependencyFileByEnv,
        internalExtraHosts: startup.internalExtraHosts,
        dependencyOwners: startup.dependencyOwners,
        internalExtraHostSources: startup.internalExtraHostSources,
        allowedHosts: startup.allowedHosts,
        runtimeMetadata: startup.runtimeMetadata,
        httpsPort: startup.https?.httpsPort ?? null,
        run,
        cleanedRetry,
        preparedRetry,
        recoverStopped: recovery !== undefined,
      });
    },
    down: async () => {
      dropEnvFingerprint();
      const code = await handleDown({
        ctx,
        deferFinalization: true,
        // The restart handles Ctrl-C itself and lets this committed stop
        // finish; its runtime requests must not die with the terminal's
        // process group (HACK-1953).
        invoke: (request) =>
          invokeNativeRuntime({ ...request, processGroup: "own" }),
        args: {
          options: {
            path: args.options.path,
            project: args.options.project,
            branch: args.options.branch,
            env: undefined,
            profile: undefined,
            target: undefined,
            timeout: undefined,
            json: false,
            pruneCaches: false,
            removeData: false,
            yes: false,
            recoverNativeCompose: false,
            progress: false,
          },
          positionals: {},
          raw: args.raw,
        },
      });
      if (code !== 0) {
        throw new HackCliError({
          code: "E_LIFECYCLE_FAILED",
          message:
            "Native restart cleanup failed; retained data was not replaced.",
        });
      }
    },
    progress,
    start: ({ run, onReady, signal, onStopSignals, onStopRequested }) =>
      startNativeProject({
        ...startup,
        ...nativeRestartSelection({ run }),
        restore: run,
        verifiedBuildImages,
        // The restart's own bookkeeping first, then the startup's ready
        // report: a detached owner (`restart --json`) tells its launcher here.
        onReady: async (services, addresses) => {
          await onReady();
          await startup.onReady?.(services, addresses);
        },
        signal,
        onStopSignals,
        onProgress: (event) => {
          if (event.phase === "stopping") {
            onStopRequested();
          }
          progress(event);
        },
      }),
  });
}

/** Publish explicit user intent before runtime effects so a subsequent login respects down. */
async function updateAutostartIntent(opts: {
  readonly ctx: CliContext;
  readonly action: "up" | "down";
  readonly resolvedDownTarget?: { readonly branch: string | null };
  readonly args: {
    readonly options: {
      readonly path?: string;
      readonly project?: string;
      readonly branch?: string;
      readonly always?: boolean;
    };
  };
}): Promise<void> {
  const login = process.env.HACK_AUTOSTART_LOGIN === "1";
  const registry = await readProjectsRegistry();
  const selector =
    opts.args.options.project === undefined
      ? null
      : parseProjectSelectorOption({ projectOpt: opts.args.options.project });
  const requestedStartDir = resolveStartDir(opts.ctx, opts.args.options.path);
  const startDir = await realpath(requestedStartDir).catch(
    () => requestedStartDir
  );
  const marked = findAutostartRegistration({
    projects: registry.projects,
    selectorName: selector?.name,
    startDir,
  });
  if (!(login || opts.args.options.always || marked)) {
    return;
  }
  if (
    marked &&
    (await updateNativeAutostartIntent({
      project: marked,
      selectedRoot: selector ? marked.repoRoot : startDir,
      action: opts.action,
      branch: opts.args.options.branch,
      always: opts.args.options.always,
      login,
    }))
  ) {
    return;
  }
  const project = await resolveProjectForArgs({
    ctx: opts.ctx,
    pathOpt: opts.args.options.path,
    projectOpt: opts.args.options.project,
    touchRegistration: false,
  });
  if (login) {
    await assertAutostartEnvironment({ project });
    return;
  }
  // Inspect selection without printing the normal up/down worktree notice twice.
  const cfg = await readProjectConfig(project);
  const resolvedBranch = await resolveEffectiveBranch({
    explicitBranch: resolveBranchSlug(opts.args.options.branch),
    projectRoot: project.projectRoot,
    autoBranchEnabled: resolveWorktreeAutoBranch(cfg),
  });
  if (resolvedBranch.source === "detached-worktree") {
    throw new CliUsageError(
      "Detached linked worktree requires an explicit --branch <name>."
    );
  }
  const branch = opts.resolvedDownTarget
    ? opts.resolvedDownTarget.branch
    : resolvedBranch.branch;
  if (opts.action === "up" && opts.args.options.always) {
    await enableAutostartForUp({
      project,
      startDir: resolveStartDir(opts.ctx, opts.args.options.path),
      selectorName: selector?.name,
      branch,
      registry,
    });
    return;
  }
  const projectDir = await realpath(project.projectDir).catch(
    () => project.projectDir
  );
  const projectRoot = await realpath(project.projectRoot).catch(
    () => project.projectRoot
  );
  const registered = registry.projects.find(
    (entry) =>
      entry.projectDir === projectDir ||
      entry.worktrees?.some((worktree) => worktree.path === projectRoot)
  );
  if (registered?.autostart && registered.autostart.branch === branch) {
    await setProjectAutostartPaused({
      id: registered.id,
      paused: opts.action === "down",
    });
  }
}

async function handlePull({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: CommandArgs<typeof pullOptions, readonly []>;
}): Promise<number> {
  const json = args.options.json === true;
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
    touchRegistration: false,
  });
  const native = resolveNativeRuntimeSelection();
  const envName = resolveRequestedEnvName({ envOption: args.options.env });
  if (native) {
    const setup = await requireNativeSetup({
      runtime: native,
      cwd: ctx.cwd,
      json,
    });
    if (setup !== 0) {
      return setup;
    }
    const { profiles } = await resolveNativeProfileSelectionForProject({
      project,
      envName,
      cliProfile: args.options.profile,
    });
    const images = await pullNativeProjectImages({
      runtime: native,
      project: { ...project, envName },
      profiles,
    });
    if (json) {
      emitCliResult({ result: okResult({ data: { images } }) });
    }
    return 0;
  }
  const cfg = await readProjectConfig(project);
  const composeProject = await resolveComposeProjectName({ project, cfg });
  const allServiceNames = await readComposeServiceNames(project.composeFile);
  const envOverrides = await resolveComposeEnvOverrides({
    project,
    projectName: sanitizeProjectSlug(composeProject),
    targetServices: allServiceNames,
    allServiceNames,
    envName,
    persist: false,
  });
  const exitCode = await runShell(
    [
      ...buildComposeArgs({
        composeFiles: [project.composeFile],
        composeProject,
        profiles: parseCsvList(args.options.profile),
        cwd: dirname(project.composeFile),
      }),
      "pull",
    ],
    {
      cwd: dirname(project.composeFile),
      env: envOverrides.env,
      forwardSignals: true,
      stdout: json ? "stderr" : "inherit",
    }
  );
  if (json) {
    emitCliResult({
      result:
        exitCode === 0
          ? okResult({ data: { backend: "compose" } })
          : errorResult({
              code: "E_LIFECYCLE_FAILED",
              message: "Compose pull failed.",
            }),
    });
  }
  return exitCode;
}

function nativeImageTagMode(
  options: UpArgs["options"]
): "refresh" | "offline" | undefined {
  if (options.refreshImages && options.offline) {
    throw new CliUsageError("Use either --refresh-images or --offline.");
  }
  if (options.refreshImages) {
    return "refresh";
  }
  if (options.offline) {
    return "offline";
  }
}

async function handleUp(
  input: Parameters<typeof handleUpUnlocked>[0]
): Promise<number> {
  const { json, timings, timingsFile } = input.args.options;
  if (timings || timingsFile !== undefined || json) {
    const native = process.env.HACK_RUNTIME_BACKEND === "native";
    if (!native && (timings || timingsFile !== undefined)) {
      throw new CliUsageError(
        "--timings and --timings-file require the native backend."
      );
    }
    if (native && !isNativeDetachedOwnerProcess()) {
      return await withCommandTimings(
        timingsFile,
        () => runUpWithAutostart(input),
        timings && !json ? printUpTimings : undefined
      );
    }
  }
  return await runUpWithAutostart(input);
}

async function runUpWithAutostart(
  input: Parameters<typeof handleUpUnlocked>[0]
): Promise<number> {
  parseRequestedTarget({ raw: input.args.options.target });
  nativeImageTagMode(input.args.options);
  const login = process.env.HACK_AUTOSTART_LOGIN === "1";
  if (!login) {
    await updateAutostartIntent({ ...input, action: "up" });
  }
  const run = async () => {
    if (login) {
      await updateAutostartIntent({ ...input, action: "up" });
    }
    return await handleUpUnlocked(input);
  };
  // Foreground up owns the terminal until shutdown; its existing supervisor
  // handles stopping. Never hold this startup lock for that whole lifetime.
  if (!(login || input.args.options.detach || input.args.options.json)) {
    return await run();
  }
  return await withAutostartCommandLock({
    action: "up",
    cwd: input.ctx.cwd,
    path: input.args.options.path,
    project: input.args.options.project,
    branch: input.args.options.branch,
    run,
  });
}

/**
 * Starts the detached native owner. An unconfirmed start is explained by the
 * instance's run mapping when another native home owns it (HACK-2339).
 */
async function launchNativeDetachedUp(opts: {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly json: boolean;
  readonly action?: "up" | "restart";
  readonly scope: Parameters<
    typeof explainUnconfirmedNativeDetachedStart
  >[0]["scope"];
}): Promise<number> {
  try {
    return await startNativeDetachedUp({
      cwd: opts.cwd,
      args: opts.args,
      json: opts.json,
      action: opts.action,
    });
  } catch (error) {
    throw await explainUnconfirmedNativeDetachedStart({
      error,
      scope: opts.scope,
    });
  }
}

/** The instance a detached `restart --json` will restart. */
async function resolveNativeRestartLaunchScope(opts: {
  readonly ctx: CliContext;
  readonly args: RestartArgs;
  readonly native: NonNullable<
    ReturnType<typeof resolveNativeRuntimeSelection>
  >;
}): Promise<NativeProjectRunScope> {
  const project = await resolveProjectForArgs({
    ctx: opts.ctx,
    pathOpt: opts.args.options.path,
    projectOpt: opts.args.options.project,
    touchRegistration: false,
  });
  const identity = await resolveEffectiveBranchIdentityForCommand({
    project,
    branchOption: opts.args.options.branch,
    noticeToStderr: true,
  });
  return {
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
    nativeHome: opts.native.home,
    branch: identity.branch,
  };
}

async function handleUpUnlocked({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: UpArgs;
}): Promise<number> {
  prepareLifecycleProgress({
    action: "up",
    progress: args.options.progress,
    json: args.options.json,
    backend: process.env.HACK_RUNTIME_BACKEND,
  });
  // Refuse a malformed --target before any project or runtime work.
  parseRequestedTarget({ raw: args.options.target });
  if (resolveNativeRuntimeSelection()) {
    // Once per `hack up`, whichever native start path follows (HACK-2026).
    noteNativeBackendBeta({ json: args.options.json === true });
  }
  const native = resolveNativeRuntimeSelection();
  if ((args.options.refreshImages || args.options.offline) && !native) {
    throw new CliUsageError(
      "--refresh-images and --offline require the native backend."
    );
  }
  if (args.options.refreshImages && args.options.offline) {
    throw new CliUsageError("Use either --refresh-images or --offline.");
  }
  if (native && args.options.use !== undefined) {
    throw new CliUsageError("--use requires the Compose backend.");
  }
  if (native) {
    refuseUnsupportedNativeUpOptions({
      restart: false,
      target: args.options.target,
      services: args.positionals.services,
    });
    const setupExit = await requireNativeSetup({
      runtime: native,
      cwd: ctx.cwd,
      json: args.options.json === true,
    });
    if (setupExit !== 0) {
      return setupExit;
    }
    // Detached children and setup continuations use exactly the selected home.
    process.env.HACK_NATIVE_HOME = native.home;
  }
  if ((args.options.detach || args.options.json) && native) {
    refuseUnsupportedNativeUpOptions({
      restart: false,
      target: args.options.target,
      services: args.positionals.services,
    });
    const childArgs = nativeDetachedOwnerArgs({
      action: "up",
      options: args.options,
    });
    // The instance the child will start, for explaining an unconfirmed start.
    let launchScope: Parameters<
      typeof explainUnconfirmedNativeDetachedStart
    >[0]["scope"] = null;
    let launchBranch: string | null = null;
    const alreadyRunning = await answerNativeAlreadyRunning({
      native,
      json: args.options.json === true,
      selection: {
        path: args.options.path,
        project: args.options.project,
        branch: args.options.branch,
        env: resolveRequestedEnvName({ envOption: args.options.env }),
        profiles:
          nativeProfileOption(args.options.profile) === undefined
            ? undefined
            : parseCsvList(args.options.profile),
      },
      resolveProject: () =>
        resolveProjectForArgs({
          ctx,
          pathOpt: args.options.path,
          projectOpt: args.options.project,
          touchRegistration: false,
        }),
      resolveBranch: async (project) => {
        const identity = await resolveEffectiveBranchIdentityForCommand({
          project,
          branchOption: args.options.branch,
          noticeToStderr: args.options.json === true,
        });
        // The detached child only sees the slug, so the launcher records
        // the name and the child keeps it.
        await recordBranchUsageIfNeeded({
          project,
          branch: identity.branch,
          name: isNativeDetachedOwnerProcess() ? null : identity.name,
        });
        launchScope = {
          projectRoot: project.projectRoot,
          projectDir: project.projectDir,
          nativeHome: native.home,
          branch: identity.branch,
        };
        return identity.branch;
      },
      onBranchResolved: (branch) => {
        launchBranch = branch;
        if (args.options.branch === undefined && branch !== null) {
          childArgs.push(`--branch=${branch}`);
        }
      },
      notifyRunning: async (saved, project) => {
        if (args.options.refreshImages) {
          const selection = [
            `--path=${quoteShellWord(project.projectRoot)}`,
            ...(launchBranch
              ? [`--branch=${quoteShellWord(launchBranch)}`]
              : []),
          ].join(" ");
          throw new CliUsageError(
            `Stop the running project with hack down ${selection}, then run hack up ${selection} --refresh-images.`
          );
        }
        await trackNativeLocalDirectories({
          project,
          branch: launchBranch ?? args.options.branch ?? null,
          mode: "running",
          warn: nativeLocalDirectoriesWarn(args.options.json === true),
        });
        if (nativeProfileOption(args.options.profile) !== undefined) {
          return;
        }
        const notice = await nativeRetainedProfilesDrift({
          project,
          saved,
        });
        if (notice) {
          process.stderr.write(`${notice}\n`);
        }
      },
    });
    if (alreadyRunning !== null) {
      return alreadyRunning;
    }
    await reportNativeLocalDirectoriesBeforeLaunch({
      ctx,
      path: args.options.path,
      project: args.options.project,
      json: args.options.json === true,
      track: {
        branch: launchBranch ?? args.options.branch ?? null,
        mode: "start",
      },
    });
    return await launchNativeDetachedUp({
      cwd: ctx.cwd,
      args: childArgs,
      json: args.options.json === true,
      scope: launchScope,
    });
  }
  const authored = await tryNativeComposeCommand({
    cwd: ctx.cwd,
    path: args.options.path,
    project: args.options.project,
    operation: "up",
    instance: args.options.branch,
    profiles: parseCsvList(args.options.profile),
    overlay: args.options.env,
    json: args.options.json,
    detach: args.options.detach,
    services: args.positionals.services,
    unsupportedOptions: Boolean(args.options.target || args.options.progress),
  });
  if (authored !== null) {
    return authored;
  }
  if (native) {
    return await handleNativeUp({ ctx, args, native });
  }
  const json = args.options.json === true;
  if (!json) {
    return await runUpCommand({ ctx, args, json: false });
  }

  // `--json`: keep stdout reserved for the result envelope.
  setLoggerBackendOverride({ backend: "console" });
  const startedAtMs = Date.now();
  try {
    return await runUpCommand({ ctx, args, json: true, startedAtMs });
  } catch (error: unknown) {
    return emitLifecycleResult({
      result: buildLifecycleJsonErrorResult({ error }),
      exitCode: 1,
    });
  }
}

const UP_RETRY_VALUE_OPTIONS = new Set([
  "--path",
  "-p",
  "--project",
  "--branch",
  "--env",
  "--profile",
  "--target",
  "--timings-file",
]);

function printedUpRetry(argv: readonly string[]): string {
  const words = [currentCandidateLauncher().command];
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    if (word === undefined) {
      break;
    }
    if (word === "--") {
      words.push(...argv.slice(index));
      break;
    }
    const value = argv[index + 1];
    if (UP_RETRY_VALUE_OPTIONS.has(word) && value !== undefined) {
      words.push(`${word === "-p" ? "--path" : word}=${value}`);
      index += 1;
    } else {
      words.push(word);
    }
  }
  return printedShellCommand(words);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: `up` orchestrates remote routing, lifecycle hooks, compose, and the JSON envelope in one linear flow.
async function runUpCommand({
  ctx,
  args,
  json,
  startedAtMs,
}: {
  readonly ctx: CliContext;
  readonly args: UpArgs;
  readonly json: boolean;
  readonly startedAtMs?: number;
}): Promise<number> {
  const detach = args.options.detach || json;
  const startedAt = performance.now();
  let budgets = resolveDetachedComposeBudgets(detach);
  let project: Awaited<ReturnType<typeof requireProjectContext>>;
  try {
    project = await resolveProjectForArgs({
      ctx,
      pathOpt: args.options.path,
      projectOpt: args.options.project,
    });
  } catch (error: unknown) {
    // Without --json the error reaches the CLI's closed-error renderer, like
    // `down` and `restart`: one `E_PROJECT_NOT_FOUND: ...` line, no stack.
    if (json && error instanceof MissingProjectContextError) {
      return emitLifecycleResult({
        result: errorResult({
          code: "E_PROJECT_NOT_FOUND",
          message: error.message,
        }),
        exitCode: 1,
      });
    }
    throw error;
  }
  const cfg = await readProjectConfig(project);
  const choices = await prepareRemoteChoices({
    projectDir: project.projectDir,
    defaults: cfg.prerequisites?.config?.selected ?? [],
    services: args.positionals.services,
    use: args.options.use,
  });
  if (
    !(await enforceProjectPrerequisites(
      remotePrerequisites(cfg, choices),
      json,
      project.projectRoot,
      { composeFile: project.composeFile, services: args.positionals.services }
    ))
  ) {
    return 1;
  }
  budgets = await withProjectComposeBudgets({ budgets, detach, project });
  const { startupTimeoutMs } = budgets;
  const envName = resolveRequestedEnvName({
    envOption: args.options.env,
  });
  const branchIdentity = await resolveEffectiveBranchIdentityForCommand({
    project,
    branchOption: args.options.branch,
    noticeToStderr: json,
    warnOnRetarget: true,
  });
  const branch = branchIdentity.branch;
  const profiles = parseCsvList(args.options.profile);

  await recordBranchUsageIfNeeded({
    project,
    branch,
    // The detached native child sees only the slug; its launcher recorded
    // the name.
    name: isNativeDetachedOwnerProcess() ? null : branchIdentity.name,
  });
  const remoteUpCode = await runRemoteLifecycleCommand({
    project,
    action: "up",
    branch,
    profiles,
    envName,
    requestedTarget: args.options.target,
    detach,
    services: args.positionals.services,
  });
  if (remoteUpCode !== null) {
    if (json) {
      return emitRemoteLifecycleJson({
        action: "up",
        exitCode: remoteUpCode,
        project: defaultProjectSlugFromPath(project.projectRoot),
        branch,
        startedAtMs,
      });
    }
    return remoteUpCode;
  }
  await maybeSyncOauthAliasesInCompose({ project });
  // Keep machine-local generated files (.internal/, .branch/, .env, env
  // state) out of git status without writing into the user's tree: the rules
  // go into the repository's info/exclude. Only init and doctor --fix write
  // the committed .hack/.gitignore (HACK-1278).
  await ensureHackGitInfoExclude({ projectDir: project.projectDir });

  // Refused before the parse warning, which carries the same message.
  const localDirectoriesRefusal = refuseInvalidLocalDirectories({ cfg, json });
  if (localDirectoriesRefusal !== null) {
    return localDirectoriesRefusal;
  }
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile;
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`,
    });
  }
  const sharedHelperRefusal = refuseInvalidSharedHelpers({ cfg, json });
  if (sharedHelperRefusal !== null) {
    return sharedHelperRefusal;
  }
  if (
    resolveLifecycleRunner({ runner: cfg.lifecycle?.runner }) === "supervisor"
  ) {
    await preflightLifecycleSupervisor();
  }

  const baseProjectName = await resolveComposeProjectName({ project, cfg });
  const composeProjectName = branch ? `${baseProjectName}--${branch}` : null;
  const projectName = sanitizeProjectSlug(baseProjectName);
  const lifecycleComposeProject = resolveLifecycleComposeProjectName({
    projectName,
    branch,
  });
  beginLifecycleProgress({ project: composeProjectName ?? baseProjectName });
  const devHost = await resolveRuntimeDevHost({ project, branch });
  const aliasHost = resolveBranchAliasHost({ devHost, cfg });
  const internalSettings = resolveInternalSettings(cfg);
  await maybePromptToStartGlobal({ internal: internalSettings });

  const allServiceNames = await readComposeServiceNames(project.composeFile);
  const requestedServices = resolveRequestedComposeServices({
    requested: args.positionals.services,
    available: allServiceNames,
  });
  const serviceScoped = requestedServices.length > 0;
  const scopedDependencyCache = serviceScoped
    ? await resolveDependencyCacheOverride({
        projectRoot: project.projectRoot,
        projectDir: project.projectDir,
        projectName,
        composeFile: project.composeFile,
      })
    : null;
  const remoteStartup = await prepareRemoteStartup({
    project,
    baseProjectName,
    composeProject: composeProjectName,
    profiles,
    envName,
    choices,
  });
  const targetServices =
    remoteStartup?.targets ??
    (serviceScoped ? requestedServices : allServiceNames);
  const cacheBootstrapServices = scopedDependencyCache
    ? await resolveDependencyCacheBootstrapServices({
        composeFile: project.composeFile,
        cache: scopedDependencyCache,
        targetServices,
      })
    : [];
  const preparedServices = [
    ...new Set([...targetServices, ...cacheBootstrapServices]),
  ];
  const managedOverrides = await resolveComposeEnvOverrides({
    project,
    projectName,
    targetServices: preparedServices,
    allServiceNames,
    envName,
  });

  const envOverrides = extendRemoteEnv(
    managedOverrides,
    remoteStartup,
    choices
  );
  await assertRegistryCredentialsAvailable({
    projectRoot: project.projectRoot,
    composeFile: project.composeFile,
    targetServices: preparedServices,
    envByService: envOverrides.preflightEnvByService,
  });

  if (serviceScoped) {
    await updateProjectRuntimeServiceEnvFingerprints({
      projectDir: project.projectDir,
      composeProject: lifecycleComposeProject,
      effectiveEnvName: envOverrides.effectiveEnvName,
      services: targetServices,
      envByService: envOverrides.preflightEnvByService,
      outcome: "applied",
    });
  } else {
    await persistProjectRuntimeEnvSelection({
      projectDir: project.projectDir,
      composeProject: lifecycleComposeProject,
      envName: envOverrides.effectiveEnvName,
      services: preparedServices,
      envByService: envOverrides.preflightEnvByService,
      composeProfiles: resolveEffectiveComposeProfiles({
        cliProfiles: profiles,
        composeEnv: envOverrides.env,
      }),
    });
  }

  const progress =
    detach && !json
      ? createComposeUpProgress({
          services: targetServices,
          before: serviceScoped ? undefined : cfg.lifecycle?.up?.before,
          after: serviceScoped ? undefined : cfg.lifecycle?.up?.after,
        })
      : undefined;
  let lifecycleCleanup: LifecycleOperationCleanup | null = null;
  let lifecycleSignalCleanup: { readonly dispose: () => void } | null = null;
  let assertHelpersCurrent: LifecycleUpResult["assertSharedHelpersCurrent"];
  let keepSharedHelpers: LifecycleUpResult["keepSharedHelpers"];
  const retainHelpersIfContainersMayRun = (): Promise<void> =>
    retainHelpersUnlessContainersAbsent({
      probe: () =>
        probeComposeContainers({
          project,
          composeProjectName,
          profiles,
          env: envOverrides.env,
        }),
      keepSharedHelpers,
    });
  let failedHook: string | undefined;
  let failedHookReason: string | undefined;
  const retryCommand = canPrintStartSelection({
    path: args.options.path,
    project: args.options.project,
    branch: args.options.branch,
    services: args.positionals.services,
  })
    ? printedUpRetry(args.raw.argv)
    : undefined;
  const summarizeFailure = json
    ? undefined
    : (name: string, reason?: string) => {
        failedHook = name;
        failedHookReason = reason;
      };
  try {
    const lifecycleUp: LifecycleUpResult = serviceScoped
      ? { code: 0, cleanup: null, signalCleanup: null, sessionName: null }
      : await runLifecycleUpBeforeAndProcesses({
          title: "Lifecycle (up before)",
          onHookStart: progress?.beforeStart,
          onHookComplete: progress?.before,
          summarizeFailure,
          project,
          cfg,
          projectName,
          branch,
          env: envOverrides.lifecycleEnv,
          effectiveEnvName: envOverrides.effectiveEnvName,
          composeProject: lifecycleComposeProject,
        });
    if (lifecycleUp.code !== 0) {
      if (json) {
        return emitLifecycleResult({
          result: errorResult({
            code: "E_LIFECYCLE_FAILED",
            message: `Lifecycle (up before) failed (exit ${lifecycleUp.code})`,
          }),
          exitCode: lifecycleUp.code,
        });
      }
      writeUpHookBlocker(
        "before",
        lifecycleUp.code,
        failedHook,
        retryCommand,
        failedHookReason
      );
      return lifecycleUp.code;
    }
    if (lifecycleUp.sessionName) {
      logger.info({
        message: `Lifecycle processes running in session: ${lifecycleUp.sessionName}`,
      });
    }
    lifecycleCleanup = lifecycleUp.cleanup;
    lifecycleSignalCleanup = lifecycleUp.signalCleanup;
    assertHelpersCurrent = lifecycleUp.assertSharedHelpersCurrent;
    keepSharedHelpers = lifecycleUp.keepSharedHelpers;
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to start lifecycle setup";
    if (json) {
      return emitLifecycleResult({
        result: errorResult({ code: "E_LIFECYCLE_FAILED", message }),
        exitCode: 1,
      });
    }
    writeStartBlocker({
      thing: "lifecycle",
      problem: "setup failed",
      which: message,
      needs: "resolve the setup failure and retry this start",
      command: retryCommand,
    });
    return 1;
  }

  // Set right before Compose may start containers. A signal from then on
  // keeps the shared helpers: a start still in flight can start services
  // after any snapshot, so no probe could prove them absent.
  let containerStartBegun = false;
  const foregroundTermination: {
    guard: ReturnType<typeof installForegroundTerminationGuard> | null;
  } = { guard: null };
  const installOperationSignalCleanup = () =>
    installLifecycleSignalCleanup({
      cleanup: signalCleanupKeepingStartedHelpers({
        cleanup: lifecycleCleanup,
        containerStartBegun: () => containerStartBegun,
        keepSharedHelpers: () => keepSharedHelpers,
      }),
    });
  let signalCleanup = lifecycleSignalCleanup ?? installOperationSignalCleanup();
  try {
    // After `up.before` hooks, which may start the engine, open the tunnel
    // DOCKER_HOST needs or create a shared network, and before any pull: name
    // a missing engine, socket permission, Compose plugin or shared network
    // Compose will need (HACK-2356). The reads use Compose's engine selection
    // from the project env, never its application values. A refusal here
    // runs the same cleanup as other failures; it renders as the JSON
    // envelope or one line.
    const preflightDeps = composeEnginePreflightDeps(envOverrides.env);
    const preflightRedactValues = composeEnvValuesToRedact({
      env: envOverrides.env,
    });
    const preflightRefusal =
      (await preflightComposeEngine({
        deps: preflightDeps,
        redactValues: preflightRedactValues,
      })) ??
      (await preflightSharedNetworks({
        composeYaml: await readTextFile(project.composeFile),
        selection: {
          requested: requestedServices,
          profiles: resolveEffectiveComposeProfiles({
            cliProfiles: profiles,
            composeEnv: envOverrides.env,
          }),
        },
        deps: preflightDeps,
        redactValues: preflightRedactValues,
      }));
    if (preflightRefusal !== null) {
      throw preflightRefusal;
    }
    // Hooks may register or remove runtime aliases; render overrides only after
    // successful preparation, while lifecycle cleanup remains installed.
    const internalOverride = await resolveInternalComposeOverride({
      project,
      cfg,
      branch,
      devHost,
      aliasHost,
      addresses: "fresh",
    });
    const composeFiles =
      branch && devHost
        ? await resolveBranchComposeFiles({
            project,
            branch,
            devHost,
            aliasHost,
            onDropped: (notice) => logger.warn({ message: notice }),
          })
        : [project.composeFile];
    const composeFilesWithInternal = internalOverride
      ? [...composeFiles, internalOverride]
      : composeFiles;
    const dependencyCache =
      scopedDependencyCache ??
      (await resolveDependencyCacheOverride({
        projectRoot: project.projectRoot,
        projectDir: project.projectDir,
        projectName,
        composeFile: project.composeFile,
      }));
    reportDependencyCacheFallback(dependencyCache);
    const composeFilesWithRuntimeOverrides = await withProjectLocalDirectories({
      project,
      composeFiles: dependencyCache.overridePath
        ? [...composeFilesWithInternal, dependencyCache.overridePath]
        : composeFilesWithInternal,
      notify: (message) => logger.warn({ message }),
    });
    const runtimeMetadataOverride = await resolveRuntimeHostMetadataOverride({
      project,
      composeFiles: composeFilesWithRuntimeOverrides,
      branch,
      devHost,
      aliasHost,
      composeProject: composeProjectName ?? baseProjectName,
    });
    const composeFilesWithEnv = [
      ...composeFilesWithRuntimeOverrides,
      ...(runtimeMetadataOverride ? [runtimeMetadataOverride] : []),
      ...envOverrides.composeFiles,
    ];
    if (!progress) {
      reportComposeStartupBudget({ budgets, detach });
    }
    const bootstrapCode = await bootstrapDependencyCaches({
      timeoutMs: detach ? startupTimeoutMs : undefined,
      services: cacheBootstrapServices,
      composeFiles: composeFilesWithEnv,
      composeProject: composeProjectName,
      profiles,
      cwd: dirname(project.composeFile),
      env: envOverrides.env,
    });
    if (bootstrapCode !== 0) {
      // Release whatever this operation started, like every later failure.
      // (Today the cache bootstrap only runs for a service-scoped up, which
      // starts no lifecycle work, so this cleanup is null there.)
      await lifecycleCleanup?.();
      const failure = dependencyCacheBootstrapFailure({
        code: bootstrapCode,
        timeoutMs: detach ? startupTimeoutMs : undefined,
      });
      if (json) {
        return emitLifecycleResult({
          result: errorResult(failure),
          exitCode: bootstrapCode,
        });
      }
      logger.error({ message: failure.message });
      return bootstrapCode;
    }
    const upPhase = trackComposeStartupPhase();
    await remoteStartup?.stopInactive();
    containerStartBegun = true;
    const guarded = await composeUpGuardedBySharedHelpers({
      assertCurrent: assertHelpersCurrent,
      up: (beforeStart) =>
        composeRuntimeBackend.up({
          unattended:
            process.env.HACK_AUTOSTART_LOGIN === "1" ? true : undefined,
          unattendedTrustedBinds:
            process.env.HACK_AUTOSTART_LOGIN === "1"
              ? resolveAutostartTrustedTlsBinds
              : undefined,
          beforeStart: async () => {
            await assertLoginAutostartCurrent(branch, project.projectRoot);
            await beforeStart?.();
            if (!detach) {
              // Compose owns foreground shutdown. Lifecycle cleanup runs after
              // it settles; re-raising here would turn one Ctrl-C into two.
              // Keep an owner until the caller's cleanup has also settled.
              foregroundTermination.guard = installForegroundTerminationGuard();
              signalCleanup.dispose();
            }
          },
          dependencyProgress: resolveDependencyCacheProgress({
            cache: dependencyCache,
            project: composeProjectName,
            baseProject: baseProjectName,
          }),
          startupTimeoutMs,
          imageTimeoutMs: budgets.imageTimeoutMs,
          startupCeilingMs: budgets.startupCeilingMs,
          onStartupPhase: upPhase.onStartupPhase,
          onStartupProgress: upPhase.onStartupProgress,
          onStartupStalled: upPhase.onStartupStalled,
          composeFiles: composeFilesWithEnv,
          composeProject: composeProjectName,
          profiles,
          detach,
          cwd: dirname(project.composeFile),
          env: envOverrides.env,
          routeStdoutToStderr: json,
          services: serviceScoped || remoteStartup ? targetServices : undefined,
          noDeps: serviceScoped,
        }),
    });
    if ("superseded" in guarded) {
      const error = guarded.superseded;
      await lifecycleCleanup?.();
      await removeProjectRuntimeStateEntry({
        projectDir: project.projectDir,
        composeProject: lifecycleComposeProject,
      });
      if (json) {
        return emitLifecycleResult({
          result: errorResult({
            code: "E_LIFECYCLE_FAILED",
            message: error.message,
            detail: { sharedHelpers: "superseded" },
          }),
          exitCode: 1,
        });
      }
      logger.error({ message: error.message });
      return 1;
    }
    const upCode = foregroundTermination.guard?.exitCode() ?? guarded.code;
    if (foregroundTermination.guard?.exitCode() === null) {
      // Normal completion hands later signals back to lifecycle handling.
      signalCleanup = installOperationSignalCleanup();
      foregroundTermination.guard.dispose();
      foregroundTermination.guard = null;
    }
    if (upCode !== 0) {
      // Compose may have started some services before it failed or timed
      // out: their helpers stay unless no container may run.
      await retainHelpersIfContainersMayRun();
      await lifecycleCleanup?.({ force: foregroundTermination.guard?.force });
      await removeProjectRuntimeStateEntry({
        projectDir: project.projectDir,
        composeProject: lifecycleComposeProject,
      });
      if (foregroundTermination.guard?.exitCode() != null) {
        const message = "Project startup interrupted.";
        if (json) {
          return emitLifecycleResult({
            result: errorResult({ code: "E_CANCELLED", message }),
            exitCode: upCode,
          });
        }
        logger.info({ message });
        return upCode;
      }
      const failure = composeStartupFailure({
        code: upCode,
        action: "docker compose up",
        phase: upPhase.phase(),
        budgets,
        inProgress: upPhase.inProgress(),
      });
      if (json) {
        return emitLifecycleResult({
          result: errorResult({
            code: failure.code,
            message: failure.message,
            detail: composeStartupFailureDetail({ failure, exitCode: upCode }),
          }),
          exitCode: upCode,
        });
      }
      logger.error({ message: failure.message });
      return upCode;
    }

    const containersStartedAt = performance.now();
    if (detach) {
      // The containers now run: a later failure keeps their helpers.
      keepSharedHelpers?.();
    }

    const observationBudgetMs = detach
      ? Math.max(
          0,
          budgets.startupTimeoutMs - (performance.now() - upPhase.progressAt())
        )
      : budgets.startupTimeoutMs;
    const readStartup = (strict: boolean) =>
      readComposeServiceStates({
        project,
        composeProjectName,
        profiles,
        services: targetServices,
        env: envOverrides.env,
        strict,
      });
    const completionServices = async () =>
      new Set(
        await discoverSuccessfulCompletionServices({
          composeFile: project.composeFile,
          activeProfiles: resolveEffectiveComposeProfiles({
            cliProfiles: profiles,
            composeEnv: envOverrides.env,
          }),
          selectedServices: serviceScoped ? targetServices : undefined,
        })
      );
    const showBeforeAfter =
      progress && !serviceScoped && (cfg.lifecycle?.up?.after?.length ?? 0) > 0;
    if (showBeforeAfter) {
      // Display a snapshot before hooks without moving the authoritative
      // post-hook confirmation or making the display read a startup gate.
      const clear = progress.serviceWait();
      const snapshot = await Promise.all([
        withProcessDeadline(Date.now() + 1000, () => readStartup(false)),
        completionServices(),
      ])
        .catch(() => null)
        .finally(clear);
      if (snapshot) {
        progress.services(
          classifyComposeStartupState(snapshot[0], {
            successfulCompletionServices: snapshot[1],
          })
        );
      }
    }
    const afterCode = serviceScoped
      ? 0
      : await runLifecycleCommands({
          title: "Lifecycle (up after)",
          onHookStart: progress?.afterStart,
          onHookComplete: progress?.after,
          summarizeFailure,
          commands: cfg.lifecycle?.up?.after,
          projectRoot: project.projectRoot,
          env: envOverrides.lifecycleEnv,
          projectDir: project.projectDir,
          composeProject: lifecycleComposeProject,
        });

    if (afterCode !== 0) {
      await lifecycleCleanup?.();
      if (!json) {
        writeUpHookBlocker("after", afterCode, failedHook, retryCommand);
        return afterCode;
      }
      return emitLifecycleResult({
        result: errorResult({
          code: "E_LIFECYCLE_FAILED",
          message: `Lifecycle (up after) failed (exit ${afterCode})`,
        }),
        exitCode: afterCode,
      });
    }

    const successfulCompletionServices = await completionServices();
    const clearServiceWait = progress?.serviceWait();
    const { states, startup } = await waitForComposeStartupState({
      successfulCompletionServices,
      deadlineMs: performance.now() + observationBudgetMs,
      read: () => readStartup(true),
    }).finally(clearServiceWait);
    if (startupSnapshotIsIncomplete({ states, failed: startup.failed })) {
      await lifecycleCleanup?.();
      await removeProjectRuntimeStateEntry({
        projectDir: project.projectDir,
        composeProject: lifecycleComposeProject,
      });
      const message = composeStartupIncompleteMessage({
        composeProject: composeProjectName ?? baseProjectName,
        failed: startup.failed,
      });
      if (!json) {
        logger.error({ message });
        return 1;
      }
      return emitLifecycleResult({
        result: errorResult({
          code: "E_STARTUP_INCOMPLETE",
          message,
          detail: {
            running: startup.running,
            completed: startup.completed,
            failed: startup.failed,
            ...(states.length === 0
              ? { inspection: "no_services_reported" }
              : {}),
          },
        }),
        exitCode: 1,
      });
    }
    await recordStartedRemotes(
      project.projectDir,
      lifecycleComposeProject,
      choices
    );
    if (!showBeforeAfter) {
      progress?.services(startup);
    }
    if (!serviceScoped) {
      await recordEnvMigrationProjectRun({
        projectRoot: project.projectRoot,
        projectDir: project.projectDir,
        projectName: baseProjectName,
        serviceNames: allServiceNames,
      }).catch(() =>
        logger.warn({
          message:
            "Could not record successful env migration startup; legacy cleanup remains blocked (values omitted).",
        })
      );
    }
    // HACK-2284: two running instances must not claim one Caddy host.
    await warnSharedCaddyHosts({
      composeProject: composeProjectName ?? baseProjectName,
      warn: (message) => logger.warn({ message }),
    });
    if (!json) {
      if (detach) {
        const addresses = await readProjectServiceAddresses({
          project,
          cfg,
          branch,
          native: false,
        });
        writeComposeStarted({
          addresses,
          running: startup.running,
          primaryHost:
            branch && devHost
              ? applyBranchToHost({
                  branch,
                  host: devHost,
                  baseHosts: resolveProjectRouteBaseHosts({
                    devHost,
                    aliasHost,
                  }),
                })
              : devHost,
          durationMs: containersStartedAt - startedAt,
        });
      }
      return 0;
    }
    return emitLifecycleResult({
      result: okResult({
        data: buildLifecycleJsonData({
          action: "up",
          project: baseProjectName,
          branch,
          composeProject: composeProjectName ?? baseProjectName,
          started: startup.running,
          completed: startup.completed,
          durationMs: Date.now() - (startedAtMs ?? Date.now()),
        }),
      }),
      exitCode: 0,
    });
  } catch (error: unknown) {
    await retainHelpersIfContainersMayRun();
    await lifecycleCleanup?.();
    await removeProjectRuntimeStateEntry({
      projectDir: project.projectDir,
      composeProject: lifecycleComposeProject,
    });
    throw error;
  } finally {
    foregroundTermination.guard?.dispose();
    signalCleanup.dispose();
  }
}

/**
 * Real Docker reads for the `up` preflight. `env` is the environment Compose
 * will get; the reads see only its platform and engine-transport settings
 * (the Docker helper projection: DOCKER_*, Podman's CONTAINER_*, SSH agent,
 * proxies), so they check the engine Compose will use while decrypted
 * application values reach only the processes that deliver them.
 */
export function composeEnginePreflightDeps(
  env: Readonly<Record<string, string>> | undefined
): ComposeEnginePreflightDeps {
  const runEnvironment = dockerHelperRunEnvironment(env);
  return {
    dockerOnPath: () => findExecutableInPath("docker") !== null,
    run: async (argv, timeoutMs) =>
      await exec(argv, { stdin: "ignore", timeoutMs, ...runEnvironment }),
  };
}

async function maybePromptToStartGlobal(opts: {
  readonly internal: { readonly dns: boolean; readonly tls: boolean };
}): Promise<void> {
  if (!opts.internal.dns) {
    return;
  }
  // Non-interactive runs (no TTY, HACK_NO_INTERACTIVE, --no-interactive)
  // skip this prompt entirely; global infra stays untouched.
  if (!canPrompt()) {
    return;
  }

  const dnsServer = await resolveCoreDnsServer();
  if (dnsServer) {
    return;
  }

  const ok = await confirm({
    message:
      "Global DNS/TLS is not running. Start it now? (runs `hack global up`, may prompt for sudo)",
    initialValue: true,
  });
  if (isCancel(ok)) {
    throw new Error("Canceled");
  }
  if (!ok) {
    return;
  }

  const exitCode = await globalUp();
  // The stack just started: its addresses are new.
  globalIngressReads.clear();
  if (exitCode !== 0) {
    logger.warn({
      message:
        "Global infra failed to start; continuing without internal DNS/TLS.",
    });
  }
}

function writeDownNotice(opts: {
  readonly json: boolean;
  readonly level: "info" | "warn";
  readonly message: string;
}): void {
  if (opts.json) {
    process.stderr.write(
      `${opts.level === "warn" ? "WARNING: " : ""}${opts.message}\n`
    );
    return;
  }
  if (opts.level === "warn") {
    logger.warn({ message: opts.message });
  } else {
    logger.info({ message: opts.message });
  }
}

function refuseLegacyNativeRecovery(recover: boolean): void {
  if (recover) {
    throw new CliUsageError("--recover requires the native backend.");
  }
}

/** Native down accepts --yes only to confirm --remove-data. */
function refuseNativeDownOptions(options: DownArgs["options"]): void {
  const removeData = options.removeData === true;
  if (removeData && options.recoverNativeCompose) {
    throw new CliUsageError(
      "Native down --recover retains data; it cannot be combined with --remove-data."
    );
  }
  if (
    [
      options.env,
      options.profile,
      options.target,
      options.timeout !== undefined,
      options.pruneCaches,
      !removeData && options.yes,
    ].some(Boolean)
  ) {
    throw new CliUsageError(
      removeData
        ? "Native down --remove-data does not support --env, --profile, --target, --timeout or --prune-caches."
        : "Native down preserves data and does not support --env, --profile, --target, --timeout, --prune-caches or --yes (--yes confirms --remove-data)."
    );
  }
}

/**
 * The project half of a native down: lifecycle hooks, host process retirement
 * and shared-helper marking. Shared by `hack down` and by `hack up`, which
 * runs `hack down --recover` when the pool stopped under its run (HACK-2456).
 */
async function nativeDownRequest(opts: {
  readonly project: Awaited<ReturnType<typeof resolveProjectForArgs>>;
  readonly native: NonNullable<
    ReturnType<typeof resolveNativeRuntimeSelection>
  >;
  readonly scope: Parameters<typeof nativeProjectDown>[0]["scope"];
  readonly branch: string | null;
  readonly routeStdoutToStderr: boolean;
}): Promise<
  Pick<
    Parameters<typeof nativeProjectDown>[0],
    "runtime" | "scope" | "retireHostProcesses" | "hooks" | "beforeCleanup"
  >
> {
  const { project, scope, branch } = opts;
  const cfg = await readProjectConfig(project);
  if (cfg.parseError) {
    throw new CliUsageError(
      "Native down requires valid lifecycle configuration; values omitted."
    );
  }
  let lifecycleEnv: Readonly<Record<string, string>> | undefined;
  const hasHooks = Boolean(
    cfg.lifecycle?.down?.before?.length || cfg.lifecycle?.down?.after?.length
  );
  const projectName = sanitizeProjectSlug(
    await resolveComposeProjectName({ project, cfg })
  );
  const composeProject = resolveLifecycleComposeProjectName({
    projectName,
    branch,
  });
  const hook = async (phase: "before" | "after", graphStopped: boolean) => {
    const code = await runLifecycleCommands({
      title: `Lifecycle (native down ${phase})`,
      commands: cfg.lifecycle?.down?.[phase],
      projectRoot: project.projectRoot,
      projectDir: project.projectDir,
      composeProject,
      env: lifecycleEnv ?? {},
      routeStdoutToStderr: opts.routeStdoutToStderr,
    });
    if (code !== 0) {
      throw new Error(
        `Native down ${phase} hook failed (exit ${code})${graphStopped ? "; native graph cleanup was confirmed and data retained" : "; cleanup was not requested"}.`
      );
    }
  };
  return {
    runtime: opts.native,
    scope,
    retireHostProcesses: async () => {
      await stopLifecycleProcesses({
        project,
        cfg,
        projectName,
        branch,
        composeProject,
      });
    },
    // Journaled: a foreground Ctrl-C may already have run them, or left
    // them owed after a crash; unknown completion refuses.
    hooks: {
      configured: hasHooks,
      run: async ({ phase, run, graphStopped }) => {
        if (!hasHooks) {
          return;
        }
        lifecycleEnv ??= await nativeDownEnvironment({
          scope,
          run,
          serviceNames: await readComposeServiceNames(project.composeFile),
        });
        await hook(phase, graphStopped);
      },
    },
    // Only a committed down (its before hook succeeded and the ownership
    // and finalization rechecks passed) may supersede a concurrent up.
    beforeCleanup: () =>
      markLifecycleSharedHelpersStopping({ cfg, composeProject }),
  };
}

async function handleDown(
  input: Parameters<typeof handleDownUnlocked>[0]
): Promise<number> {
  parseRequestedTarget({ raw: input.args.options.target });
  const isNativeBackend = resolveInitComposeBackend(process.env) === "native";
  if (isNativeBackend && input.args.options.timeout !== undefined) {
    refuseNativeDownOptions(input.args.options);
  }
  const flagTimeoutSeconds = isNativeBackend
    ? undefined
    : parseComposeDownTimeoutFlag(input.args.options.timeout);
  // Publish stop intent before waiting for an earlier start to release its lock.
  const resolvedDownTarget = isNativeBackend
    ? undefined
    : await resolveFinalAutostartDownTarget(
        {
          cwd: input.ctx.cwd,
          path: input.args.options.path,
          project: input.args.options.project,
          branch: input.args.options.branch,
          writeNotice: (notice) =>
            writeDownNotice({
              json: input.args.options.json === true,
              ...notice,
            }),
        },
        {
          isLocalTarget: async (project) =>
            (
              await resolveProjectLifecycleTarget({
                project,
                requestedTarget: input.args.options.target,
              })
            ).resolvedTarget === "local",
        }
      );
  const pinned = {
    ...input,
    flagTimeoutSeconds,
    args: { ...input.args, resolvedAutostartBranch: resolvedDownTarget },
  };
  await updateAutostartIntent({
    ...pinned,
    action: "down",
    resolvedDownTarget,
  });
  return await withAutostartCommandLock({
    action: "down",
    cwd: input.ctx.cwd,
    path: input.args.options.path,
    project: input.args.options.project,
    branch: input.args.options.branch,
    resolvedDownTarget,
    run: () => handleDownUnlocked(pinned),
  });
}

async function handleDownUnlocked({
  ctx,
  args,
  deferFinalization,
  invoke,
  flagTimeoutSeconds,
}: {
  readonly ctx: CliContext;
  readonly args: DownArgs;
  readonly deferFinalization?: boolean;
  /** The native runtime requests of this down; a restart starts them in their own process group. */
  readonly invoke?: typeof invokeNativeRuntime;
  readonly flagTimeoutSeconds?: number;
}): Promise<number> {
  const startedAt = performance.now();
  prepareLifecycleProgress({
    action: "down",
    progress: args.options.progress,
    json: args.options.json,
    backend: process.env.HACK_RUNTIME_BACKEND,
  });
  // Refuse a malformed --target before any project or runtime work.
  parseRequestedTarget({ raw: args.options.target });
  const authored = await tryNativeComposeCommand({
    cwd: ctx.cwd,
    path: args.options.path,
    project: args.options.project,
    operation: "down",
    instance: args.options.branch,
    profiles:
      args.options.profile === undefined
        ? undefined
        : parseCsvList(args.options.profile),
    overlay: args.options.env,
    json: args.options.json,
    recover: args.options.recoverNativeCompose,
    unsupportedOptions: [
      args.options.target,
      args.options.timeout !== undefined,
      args.options.pruneCaches,
      args.options.removeData,
      args.options.yes,
      args.options.progress,
    ].some(Boolean),
  });
  if (authored !== null) {
    return authored;
  }
  const native = resolveNativeRuntimeSelection();
  if (native) {
    if (args.options.json) {
      setLoggerBackendOverride({ backend: "console" });
    }
    refuseNativeDownOptions(args.options);
    const project = await resolveProjectForArgs({
      ctx,
      pathOpt: args.options.path,
      projectOpt: args.options.project,
      touchRegistration: false,
    });
    const branch = await resolveEffectiveBranchForCommand({
      project,
      branchOption: args.options.branch,
      noticeToStderr: args.options.json === true,
    });
    const scope = {
      projectRoot: project.projectRoot,
      projectDir: project.projectDir,
      nativeHome: native.home,
      branch,
    };
    if (args.options.removeData) {
      // Removal never stops compute or runs hooks; a running project refuses.
      return await runNativeDownRemoveData({
        runtime: native,
        scope,
        yes: args.options.yes === true,
        json: args.options.json === true,
      });
    }
    const result = await nativeProjectDown({
      ...(await nativeDownRequest({
        project,
        native,
        scope,
        branch,
        routeStdoutToStderr: args.options.json === true,
      })),
      recover: args.options.recoverNativeCompose,
      deferFinalization,
      invoke,
    });
    if (args.options.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      writeLifecycleStopped(performance.now() - startedAt, {
        retained: result.status === "stopped",
        unchanged: result.status === "not_started",
      });
      if (result.runtimeStarted) {
        logger.info({ message: NATIVE_RECOVERY_RUNTIME_STARTED_NOTE });
      }
    }
    return 0;
  }
  refuseLegacyNativeRecovery(args.options.recoverNativeCompose);
  const json = args.options.json === true;
  if (!json) {
    return await runDownCommand({ ctx, args, json: false, flagTimeoutSeconds });
  }

  // `--json`: keep stdout reserved for the result envelope.
  setLoggerBackendOverride({ backend: "console" });
  const startedAtMs = Date.now();
  try {
    return await runDownCommand({
      ctx,
      args,
      json: true,
      startedAtMs,
      flagTimeoutSeconds,
    });
  } catch (error: unknown) {
    if (error instanceof MissingProjectContextError) {
      return emitLifecycleResult({
        result: errorResult({
          code: "E_PROJECT_NOT_FOUND",
          message: error.message,
        }),
        exitCode: 1,
      });
    }
    return emitLifecycleResult({
      result: buildLifecycleJsonErrorResult({ error }),
      exitCode: 1,
    });
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Down coordinates remote routing, ownership reconciliation, lifecycle hooks, Compose teardown, optional cache cleanup, and JSON reporting in one ordered transaction.
async function runDownCommand({
  ctx,
  args,
  json,
  startedAtMs,
  flagTimeoutSeconds,
}: {
  readonly ctx: CliContext;
  readonly args: DownArgs;
  readonly json: boolean;
  readonly startedAtMs?: number;
  readonly flagTimeoutSeconds?: number;
}): Promise<number> {
  const startedAt = performance.now();
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  const envName = resolveRequestedEnvName({
    envOption: args.options.env,
  });
  let branch = args.resolvedAutostartBranch
    ? args.resolvedAutostartBranch.branch
    : await resolveEffectiveBranchForCommand({
        project,
        branchOption: args.options.branch,
        noticeToStderr: json,
      });
  const profiles = parseCsvList(args.options.profile);
  if (args.options.removeData) {
    throw new CliUsageError(
      "--remove-data applies to the native backend only; Compose-backend down keeps named volumes."
    );
  }
  const pruneCaches = args.options.pruneCaches === true;
  const confirmCachePrune = args.options.yes === true;
  if (confirmCachePrune && !pruneCaches) {
    throw new CliUsageError("--yes is only valid with --prune-caches.");
  }
  if (pruneCaches) {
    const target = await resolveProjectLifecycleTarget({
      project,
      requestedTarget: args.options.target,
    });
    if (target.resolvedTarget !== "local") {
      throw new CliUsageError(
        "--prune-caches is local-only; run the cleanup on the machine that owns the Docker volumes."
      );
    }
  }
  // An override written by an earlier Hack version can hold decrypted values.
  // Down never reads it, so it is removed first: a failed lifecycle hook, a
  // remote target or a failed Compose down cannot leave it behind.
  await scrubPlaintextComposeEnvOverride({ projectDir: project.projectDir });

  const remoteDownCode = await runRemoteLifecycleCommand({
    project,
    action: "down",
    branch,
    profiles,
    envName,
    requestedTarget: args.options.target,
  });
  if (remoteDownCode !== null) {
    await recordBranchUsageIfNeeded({ project, branch });
    if (json) {
      return emitRemoteLifecycleJson({
        action: "down",
        exitCode: remoteDownCode,
        project: defaultProjectSlugFromPath(project.projectRoot),
        branch,
        startedAtMs,
      });
    }
    return remoteDownCode;
  }
  const cfg = await readProjectConfig(project);
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile;
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`,
    });
  }
  const sharedHelperRefusal = refuseInvalidSharedHelpers({ cfg, json });
  if (sharedHelperRefusal !== null) {
    return sharedHelperRefusal;
  }
  const downTimeoutSeconds = resolveComposeDownTimeoutSeconds({
    flagTimeoutSeconds,
    projectValue: cfg.compose?.downTimeoutSeconds,
  });

  const baseProjectName = await resolveComposeProjectName({ project, cfg });
  let runtime: readonly RuntimeProject[] | null = null;
  const implicitLinkedWorktreeTarget =
    !args.resolvedAutostartBranch &&
    resolveBranchSlug(args.options.branch) === null &&
    branch !== null;
  if (implicitLinkedWorktreeTarget || pruneCaches) {
    const runtimeResult = await readRuntimeProjects({ includeGlobal: false });
    if (!runtimeResult.ok) {
      throw new HackCliError({
        code: "E_DOCKER_UNAVAILABLE",
        message: `Cannot inspect runtime ownership before down: ${runtimeResult.error}`,
      });
    }
    runtime = runtimeResult.runtime;
  }
  if (implicitLinkedWorktreeTarget && branch !== null && runtime) {
    branch = reconcileImplicitDownBranch({
      baseProjectName,
      branch,
      projectDir: project.projectDir,
      runtime,
      writeNotice: ({ level, message }) => {
        writeDownNotice({ json, level, message });
      },
    });
  }
  // Include an already-pinned autostart target as well as implicit reconciliation.
  noteActivityBranch(branch);
  await recordBranchUsageIfNeeded({ project, branch });
  const composeProjectName = branch ? `${baseProjectName}--${branch}` : null;
  const cacheVolumesKept: CacheVolumeKept[] = [];
  const cachePruneCandidates =
    pruneCaches && runtime
      ? await prepareDisposableCachePrune({
          composeProject: composeProjectName ?? baseProjectName,
          json,
          projectDir: project.projectDir,
          runtime,
          writeNotice: ({ level, message }) => {
            writeDownNotice({ json, level, message });
          },
          yes: confirmCachePrune,
          kept: cacheVolumesKept,
        })
      : [];
  const projectName = sanitizeProjectSlug(baseProjectName);
  const lifecycleComposeProject = resolveLifecycleComposeProjectName({
    projectName,
    branch,
  });
  beginLifecycleProgress({ project: composeProjectName ?? baseProjectName });
  const effectiveEnvName = await resolveStoredRuntimeEnvName({
    requestedEnvName: envName,
    projectDir: project.projectDir,
    composeProject: lifecycleComposeProject,
  });
  const lifecycleEnv = await resolveLifecycleEnvForProject({
    project,
    projectName,
    envName: effectiveEnvName,
  });

  const hookEnv = await prepareRemoteDown({
    project,
    cfg,
    composeProjectName,
    lifecycleComposeProject,
    env: lifecycleEnv,
  });
  const interruptionCheck = await checkOneShotInterruption({
    project,
    composeProjectName,
    profiles,
    action: "down",
    json,
  });
  if (!interruptionCheck.proceed) {
    return 1;
  }
  // Snapshot what was running before down so the JSON payload can report
  // which services were actually stopped.
  const stopSelection = await resolveInstanceStopSelection({
    projectDir: project.projectDir,
    lifecycleComposeProject,
    cliProfiles: profiles,
    composeEnv: lifecycleEnv,
  });
  const statesBeforeDown =
    json || (downTimeoutSeconds !== undefined && downTimeoutSeconds > 0)
      ? await readComposeServiceStates({
          project,
          composeProjectName,
          profiles: stopSelection.profiles,
          env: lifecycleEnv,
        })
      : [];
  const runningServicesBeforeDown =
    classifyComposeStartupState(statesBeforeDown).running;
  const downCapMs = resolveComposeDownCapMs({
    timeoutSeconds: downTimeoutSeconds,
    runningServiceCount: countDistinctRunningServices(
      runningServicesBeforeDown
    ),
  });

  // Holders are released only once Compose confirmed the containers
  // stopped; an interrupted or failed shutdown keeps them for the next down.
  const lifecycleDownCleanup = async (
    containers: ContainerShutdown
  ): Promise<readonly string[]> =>
    await stopLifecycleProcessesBestEffort({
      project,
      cfg,
      projectName,
      branch,
      composeProject: lifecycleComposeProject,
      containers,
    });
  const signalCleanup = installLifecycleSignalCleanup({
    cleanup: async () => {
      await lifecycleDownCleanup("unconfirmed");
    },
  });
  let code: number;
  let downTimedOut = false;
  let stopObservation: DownObservation = { complete: true };
  let retryFailure: ComposeDownRetryFailure | null = null;
  let helperReleaseFailures: readonly string[] = [];
  try {
    const beforeCode = await runLifecycleCommands({
      title: "Lifecycle (down before)",
      commands: cfg.lifecycle?.down?.before,
      projectRoot: project.projectRoot,
      env: hookEnv,
      projectDir: project.projectDir,
      composeProject: lifecycleComposeProject,
    });
    if (beforeCode !== 0) {
      if (json) {
        return emitLifecycleResult({
          result: errorResult({
            code: "E_LIFECYCLE_FAILED",
            message: `Lifecycle (down before) failed (exit ${beforeCode})`,
          }),
          exitCode: beforeCode,
        });
      }
      return beforeCode;
    }

    await markLifecycleSharedHelpersStopping({
      cfg,
      composeProject: lifecycleComposeProject,
    });
    reportLifecycleProgress({ service: null, phase: "stopping" });
    code = await composeRuntimeBackend.down({
      composeFiles: [project.composeFile],
      composeProject: composeProjectName,
      profiles: stopSelection.profiles,
      cwd: dirname(project.composeFile),
      env: lifecycleEnv,
      routeStdoutToStderr: json,
      timeoutSeconds: downTimeoutSeconds,
      capMs: downCapMs,
      onOutcome: (outcome) => {
        downTimedOut = outcome.timedOut;
      },
    });
    if (code === 0) {
      const finish = await finishInstanceStop({
        project,
        composeProjectName,
        composeProjectLabel: composeProjectName ?? baseProjectName,
        profiles: stopSelection.profiles,
        env: lifecycleEnv,
        routeStdoutToStderr: json,
        timeoutSeconds: downTimeoutSeconds,
      });
      if (finish.ok) {
        stopObservation = finish.observation;
      } else {
        code = finish.exitCode;
        retryFailure = finish;
      }
    }
    helperReleaseFailures = await lifecycleDownCleanup(
      await confirmComposeDownForHelpers({
        cfg,
        lifecycleComposeProject,
        composeProject: composeProjectName ?? baseProjectName,
        downCode: code,
      })
    );
  } finally {
    signalCleanup.dispose();
  }

  if (code !== 0) {
    const failure =
      retryFailure ??
      buildComposeDownFailure({
        exitCode: code,
        timedOut: downTimedOut,
        capMs: downCapMs,
      });
    if (!json && retryFailure) {
      logger.error({ message: failure.message });
    } else if (!json && "capWarning" in failure && failure.capWarning) {
      logger.warn({ message: failure.capWarning });
    }
    if (json) {
      return emitLifecycleResult({
        result: errorResult({
          code: "E_COMPOSE_FAILED",
          message: failure.message,
          detail: failure.detail,
        }),
        exitCode: code,
      });
    }
    return code;
  }
  if (!stopObservation.complete) {
    // Compose exited 0, but the instance is not down: report what was
    // observed. The runtime state entry is kept for the next down.
    const message = downIncompleteMessage({ observation: stopObservation });
    if (json) {
      return emitLifecycleResult({
        result: errorResult({
          code: "E_DOWN_INCOMPLETE",
          message,
          detail: {
            running: [...stopObservation.running],
            foreign: stopObservation.foreign.map((entry) => ({
              service: entry.service,
              workingDir: entry.workingDir,
            })),
            ...(stopObservation.networks && stopObservation.networks.length > 0
              ? { networks: [...stopObservation.networks] }
              : {}),
            ...(stopObservation.unknownReason === undefined
              ? {}
              : { unknown: true, reason: stopObservation.unknownReason }),
            ...(stopObservation.networksUnknownReason === undefined
              ? {}
              : {
                  networksUnknown: true,
                  networksUnknownReason: stopObservation.networksUnknownReason,
                }),
          },
        }),
        exitCode: 1,
      });
    }
    logger.error({ message });
    return 1;
  }
  reportLifecycleProgress({ service: null, phase: "stopped" });
  if (helperReleaseFailures.length > 0) {
    const message = sharedHelperReleaseFailureMessage(helperReleaseFailures);
    if (json) {
      return emitLifecycleResult({
        result: errorResult({
          code: "E_LIFECYCLE_FAILED",
          message,
          detail: { sharedHelpers: [...helperReleaseFailures] },
        }),
        exitCode: 1,
      });
    }
    logger.error({ message });
    return 1;
  }
  const cacheRemoval = await removeDisposableCacheVolumes({
    candidates: cachePruneCandidates,
    kept: cacheVolumesKept,
  });
  for (const volume of cacheVolumesKept) {
    if (volume.reason === "identity-changed") {
      writeDownNotice({
        json,
        level: "warn",
        message: `Kept volume "${volume.name}": its identity could not be verified after stopping.`,
      });
    }
  }
  cacheVolumesKept.sort((left, right) => left.name.localeCompare(right.name));
  await removeProjectRuntimeStateEntry({
    projectDir: project.projectDir,
    composeProject: lifecycleComposeProject,
  });
  await maybeManageProjectLogsAfterDown({ project, branch });

  const afterCode = await runLifecycleCommands({
    title: "Lifecycle (down after)",
    commands: cfg.lifecycle?.down?.after,
    projectRoot: project.projectRoot,
    env: hookEnv,
    projectDir: project.projectDir,
    composeProject: lifecycleComposeProject,
  });

  if (!json) {
    if (cacheRemoval.removed.length > 0) {
      logger.success({
        message: `Removed disposable cache volumes: ${cacheRemoval.removed.join(", ")}`,
      });
    }
    if (cacheRemoval.failed.length > 0) {
      logger.error({
        message: `Project stopped, but cache volume removal failed: ${cacheRemoval.failed.map((failure) => `${failure.name} (${failure.error})`).join(", ")}`,
      });
      return 1;
    }
    if (afterCode === 0) {
      writeLifecycleStopped(performance.now() - startedAt);
    }
    return afterCode;
  }

  if (afterCode !== 0) {
    return emitLifecycleResult({
      result: errorResult({
        code: "E_LIFECYCLE_FAILED",
        message: `Lifecycle (down after) failed (exit ${afterCode})`,
      }),
      exitCode: afterCode,
    });
  }
  if (cacheRemoval.failed.length > 0) {
    return emitLifecycleResult({
      result: errorResult({
        code: "E_COMPOSE_FAILED",
        message:
          "Project stopped, but one or more disposable cache volumes could not be removed.",
        detail: {
          removed: cacheRemoval.removed,
          failed: cacheRemoval.failed,
          kept: cacheVolumesKept,
        },
      }),
      exitCode: 1,
    });
  }

  return emitLifecycleResult({
    result: okResult({
      data: buildLifecycleJsonData({
        action: "down",
        project: baseProjectName,
        branch,
        composeProject: composeProjectName ?? baseProjectName,
        stopped: runningServicesBeforeDown,
        cacheVolumesRemoved: cacheRemoval.removed,
        cacheVolumesKept: pruneCaches ? cacheVolumesKept : undefined,
        interruption: interruptionCheck.interruption,
        durationMs: Date.now() - (startedAtMs ?? Date.now()),
      }),
    }),
    exitCode: 0,
  });
}

async function runRestartDownPhase(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly projectName: string;
  readonly composeProjectName: string | null;
  /** The Compose project label value: `composeProjectName` or the base name. */
  readonly composeProjectLabel: string;
  readonly lifecycleComposeProject: string;
  readonly profiles: readonly string[];
  readonly branch: string | null;
  readonly routeStdoutToStderr?: boolean;
  readonly envForCompose: Readonly<Record<string, string>>;
  readonly preserveComposeRuntime?: boolean;
}): Promise<{
  readonly code: number;
  /** Helpers whose release failed; the restart must stop. */
  readonly sharedHelperFailures?: readonly string[];
}> {
  // As in hack down: holders are released only once the containers are
  // confirmed stopped. A restart that preserves the Compose runtime keeps
  // the containers running, so it keeps their holders (not a failure); the
  // up phase then reuses the helpers.
  const lifecycleDownCleanup = async (
    containers: ContainerShutdown
  ): Promise<readonly string[]> =>
    await stopLifecycleProcessesBestEffort({
      project: opts.project,
      cfg: opts.cfg,
      projectName: opts.projectName,
      branch: opts.branch,
      composeProject: opts.lifecycleComposeProject,
      containers,
    });
  const signalCleanup = installLifecycleSignalCleanup({
    cleanup: async () => {
      await lifecycleDownCleanup("unconfirmed");
    },
  });
  let downCode: number;
  let helperReleaseFailures: readonly string[] = [];
  try {
    const downBefore = await runLifecycleCommands({
      title: "Lifecycle (restart down before)",
      commands: opts.cfg.lifecycle?.down?.before,
      projectRoot: opts.project.projectRoot,
      env: opts.envForCompose,
      projectDir: opts.project.projectDir,
      composeProject: opts.lifecycleComposeProject,
    });
    if (downBefore !== 0) {
      return { code: downBefore };
    }

    await markLifecycleSharedHelpersStopping({
      cfg: opts.cfg,
      composeProject: opts.lifecycleComposeProject,
    });
    downCode = opts.preserveComposeRuntime
      ? 0
      : await composeRuntimeBackend.down({
          composeFiles: [opts.project.composeFile],
          composeProject: opts.composeProjectName,
          profiles: opts.profiles,
          cwd: dirname(opts.project.composeFile),
          routeStdoutToStderr: opts.routeStdoutToStderr === true,
        });
    // A preserved Compose runtime was never shut down: its containers are
    // kept, so their helpers stay held.
    helperReleaseFailures = await lifecycleDownCleanup(
      opts.preserveComposeRuntime
        ? "kept"
        : await confirmComposeDownForHelpers({
            cfg: opts.cfg,
            lifecycleComposeProject: opts.lifecycleComposeProject,
            composeProject: opts.composeProjectLabel,
            downCode,
          })
    );
  } finally {
    signalCleanup.dispose();
  }
  if (downCode !== 0) {
    return { code: downCode };
  }
  if (helperReleaseFailures.length > 0) {
    // An unreleased helper keeps running with its claim kept: restarting on
    // top of it would hide that, so the restart stops here.
    logger.error({
      message: sharedHelperReleaseFailureMessage(helperReleaseFailures),
    });
    return { code: 1, sharedHelperFailures: helperReleaseFailures };
  }

  if (!opts.preserveComposeRuntime) {
    await maybeManageProjectLogsAfterDown({
      project: opts.project,
      branch: opts.branch,
    });
  }

  const downAfter = await runLifecycleCommands({
    title: "Lifecycle (restart down after)",
    commands: opts.cfg.lifecycle?.down?.after,
    projectRoot: opts.project.projectRoot,
    env: opts.envForCompose,
    projectDir: opts.project.projectDir,
    composeProject: opts.lifecycleComposeProject,
  });
  return { code: downAfter };
}

/** Native-path shared helper check: cleans up, then fails with a lifecycle error. */
async function assertNativeSharedHelpersCurrent(opts: {
  readonly lifecycle: LifecycleUpResult;
  readonly cleanup: () => Promise<void>;
  readonly servicesStarted?: boolean;
}): Promise<void> {
  try {
    await opts.lifecycle.assertSharedHelpersCurrent?.({
      servicesStarted: opts.servicesStarted === true,
    });
  } catch (error: unknown) {
    if (!(error instanceof SharedHelperSupersededError)) {
      throw error;
    }
    await opts.cleanup();
    throw new HackCliError({
      code: "E_LIFECYCLE_FAILED",
      message: error.message,
    });
  }
}

/**
 * After a failed restart start, attempt one repair start so the runtime is
 * left startable. The repair launches containers, so it runs behind the same
 * shared helper guard as the first attempt.
 */
export async function repairFailedRestart(opts: {
  readonly budgets: ComposeStartupBudgets;
  readonly upCode: number;
  readonly composePhase: ComposeStartupPhase;
  /** One-shots the cut-short start left running (HACK-2310). */
  readonly inProgress?: readonly string[];
  readonly assertCurrent: LifecycleUpResult["assertSharedHelpersCurrent"];
  readonly cleanup: LifecycleOperationCleanup | null;
  /**
   * Runs before the cleanup of a failed repair: keeps the shared helpers
   * when the failed starts may have left containers running.
   */
  readonly retainHelpersIfContainersMayRun?: () => Promise<void>;
  readonly projectDir: string;
  readonly lifecycleComposeProject: string;
  readonly up: (beforeStart?: () => Promise<void>) => Promise<number>;
}): Promise<{
  readonly code: number;
  readonly phase: "compose" | "lifecycle";
  readonly composePhase?: ComposeStartupPhase;
  readonly inProgress?: readonly string[];
}> {
  reportComposeStartupBudget({
    budgets: opts.budgets,
    detach: true,
    repair: true,
  });
  const repair = await composeUpGuardedBySharedHelpers({
    assertCurrent: opts.assertCurrent,
    up: opts.up,
  });
  if ("superseded" in repair) {
    return await abandonSupersededRestart({
      error: repair.superseded,
      cleanup: opts.cleanup,
      projectDir: opts.projectDir,
      composeProject: opts.lifecycleComposeProject,
    });
  }
  if (repair.code === 0) {
    logger.warn({
      message:
        "Restart failed, but Hack repaired the Compose runtime to a startable state.",
    });
  } else {
    logger.error({
      message: `Restart failed and automatic runtime repair also failed (exit ${repair.code}). Run 'hack doctor --fix'.`,
    });
    await opts.retainHelpersIfContainersMayRun?.();
    await opts.cleanup?.();
    await removeProjectRuntimeStateEntry({
      projectDir: opts.projectDir,
      composeProject: opts.lifecycleComposeProject,
    });
  }
  return {
    code: opts.upCode,
    phase: "compose",
    composePhase: opts.composePhase,
    ...(opts.inProgress ? { inProgress: opts.inProgress } : {}),
  };
}

/**
 * Refuse a command when `lifecycle.sharedHelpers` is invalid, before any
 * lifecycle or runtime effect. Other config parse errors only warn on the
 * Compose path, but running without the helpers would launch services that
 * need them (or leave a down unable to name what to release). Returns the
 * exit code to return, or null to continue.
 */
function refuseInvalidSharedHelpers(opts: {
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly json: boolean;
}): number | null {
  let runnerError = opts.cfg.lifecycleRunnerError;
  try {
    resolveLifecycleRunner({ runner: opts.cfg.lifecycle?.runner });
  } catch {
    runnerError = "Invalid lifecycle runner; use mux or supervisor.";
  }
  if (!(opts.cfg.sharedHelpersError || runnerError)) {
    return null;
  }
  const message =
    runnerError ??
    `Invalid lifecycle.sharedHelpers; nothing was changed: ${opts.cfg.sharedHelpersError}`;
  if (opts.json) {
    return emitLifecycleResult({
      result: errorResult({ code: "E_LIFECYCLE_FAILED", message }),
      exitCode: 1,
    });
  }
  logger.error({ message });
  return 1;
}

/**
 * Before a detached owner starts (its output is not shown): refuse an invalid
 * `localDirectories` and print its notices. Only an ordinary Compose project
 * reads the setting; for an authored or imported project the lookup fails
 * here and the child dispatches it, as `answerNativeAlreadyRunning` does.
 */
export async function reportNativeLocalDirectoriesBeforeLaunch(opts: {
  readonly ctx: CliContext;
  readonly path: string | undefined;
  readonly project: string | undefined;
  readonly json: boolean;
  /** Records the plan this launch starts, and says when a restart changes it. */
  readonly track?: {
    readonly branch: string | null;
    readonly mode: "start" | "restart";
  };
}): Promise<void> {
  let project: Awaited<ReturnType<typeof resolveProjectForArgs>>;
  try {
    project = await resolveProjectForArgs({
      ctx: opts.ctx,
      pathOpt: opts.path,
      projectOpt: opts.project,
      touchRegistration: false,
    });
  } catch {
    return;
  }
  const warn = nativeLocalDirectoriesWarn(opts.json);
  await reportNativeLocalDirectories({ project, warn });
  await ensureHackGitInfoExclude({ projectDir: project.projectDir });
  if (opts.track) {
    await trackNativeLocalDirectories({
      project,
      branch: opts.track.branch,
      mode: opts.track.mode,
      warn,
    });
  }
}

/**
 * Where native `localDirectories` notices go: stderr under `--json`, so the
 * result envelope stays the only thing on stdout; the logger otherwise.
 */
export function nativeLocalDirectoriesWarn(
  json: boolean
): (message: string) => void {
  return json
    ? (message) => process.stderr.write(`${message}\n`)
    : (message) => logger.warn({ message });
}

/**
 * HACK-2358: an invalid `localDirectories` refuses before anything starts or
 * stops (a restart would otherwise stop the project and then refuse).
 */
function refuseInvalidLocalDirectories(opts: {
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly json: boolean;
}): number | null {
  const message = opts.cfg.localDirectoriesError;
  if (!message) {
    return null;
  }
  if (opts.json) {
    return emitLifecycleResult({
      result: errorResult({ code: "E_CONFIG_INVALID", message }),
      exitCode: 1,
    });
  }
  logger.error({ message });
  return 1;
}

/** `hack run`: warn on a config parse error, refuse an invalid `localDirectories`. */
function reviewRunConfig(opts: {
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly project: { readonly configFile: string };
}): number | null {
  // Refused before the parse warning, which carries the same message.
  const refusal = refuseInvalidLocalDirectories({ cfg: opts.cfg, json: false });
  if (refusal !== null) {
    return refusal;
  }
  if (opts.cfg.parseError) {
    const configPath = opts.cfg.configPath ?? opts.project.configFile;
    logger.warn({
      message: `Failed to parse ${configPath}: ${opts.cfg.parseError}`,
    });
  }
  return null;
}

/** Restart's response to a concurrent down: clean up this start and stop. */
async function abandonSupersededRestart(opts: {
  readonly error: SharedHelperSupersededError;
  readonly cleanup: LifecycleOperationCleanup | null;
  readonly projectDir: string;
  readonly composeProject: string;
}): Promise<{ readonly code: number; readonly phase: "lifecycle" }> {
  await opts.cleanup?.();
  await removeProjectRuntimeStateEntry({
    projectDir: opts.projectDir,
    composeProject: opts.composeProject,
  });
  logger.error({ message: opts.error.message });
  return { code: 1, phase: "lifecycle" };
}

function reportLifecycleSession(sessionName: string | null): void {
  if (sessionName) {
    logger.info({
      message: `Lifecycle processes running in session: ${sessionName}`,
    });
  }
}

async function runRestartUpPhase(opts: {
  readonly budgets: ComposeStartupBudgets;
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly baseProjectName: string;
  readonly projectName: string;
  readonly composeProjectName: string | null;
  readonly lifecycleComposeProject: string;
  readonly profiles: readonly string[];
  readonly branch: string | null;
  readonly envName?: string | null;
  readonly detach?: boolean;
  readonly routeStdoutToStderr?: boolean;
}): Promise<{
  readonly code: number;
  readonly phase: "compose" | "lifecycle";
  readonly composePhase?: ComposeStartupPhase;
  readonly inProgress?: readonly string[];
  readonly observationBudgetMs?: number;
}> {
  await maybeSyncOauthAliasesInCompose({ project: opts.project });

  const devHost = await resolveRuntimeDevHost({
    project: opts.project,
    branch: opts.branch,
  });
  const aliasHost = resolveBranchAliasHost({ devHost, cfg: opts.cfg });

  const targetServices = await readComposeServiceNames(
    opts.project.composeFile
  );
  const envOverrides = await resolveComposeEnvOverrides({
    project: opts.project,
    projectName: opts.projectName,
    targetServices,
    allServiceNames: targetServices,
    envName: opts.envName,
  });
  await assertRegistryCredentialsAvailable({
    projectRoot: opts.project.projectRoot,
    composeFile: opts.project.composeFile,
    targetServices,
    envByService: envOverrides.preflightEnvByService,
  });

  await persistProjectRuntimeEnvSelection({
    projectDir: opts.project.projectDir,
    composeProject: opts.lifecycleComposeProject,
    envName: envOverrides.effectiveEnvName,
    services: targetServices,
    envByService: envOverrides.preflightEnvByService,
    composeProfiles: resolveEffectiveComposeProfiles({
      cliProfiles: opts.profiles,
      composeEnv: envOverrides.env,
    }),
  });

  let lifecycleCleanup: LifecycleOperationCleanup | null = null;
  let lifecycleSignalCleanup: { readonly dispose: () => void } | null = null;
  let assertHelpersCurrent: LifecycleUpResult["assertSharedHelpersCurrent"];
  let keepSharedHelpers: LifecycleUpResult["keepSharedHelpers"];
  const retainHelpersIfContainersMayRun = (): Promise<void> =>
    retainHelpersUnlessContainersAbsent({
      probe: () =>
        probeComposeContainers({
          project: opts.project,
          composeProjectName: opts.composeProjectName,
          profiles: opts.profiles,
          env: envOverrides.env,
        }),
      keepSharedHelpers,
    });
  try {
    const lifecycleUp = await runLifecycleUpBeforeAndProcesses({
      title: "Lifecycle (restart up before)",
      project: opts.project,
      cfg: opts.cfg,
      projectName: opts.projectName,
      branch: opts.branch,
      env: envOverrides.lifecycleEnv,
      effectiveEnvName: envOverrides.effectiveEnvName,
      composeProject: opts.lifecycleComposeProject,
    });
    if (lifecycleUp.code !== 0) {
      return { code: lifecycleUp.code, phase: "lifecycle" };
    }
    reportLifecycleSession(lifecycleUp.sessionName);
    lifecycleCleanup = lifecycleUp.cleanup;
    lifecycleSignalCleanup = lifecycleUp.signalCleanup;
    assertHelpersCurrent = lifecycleUp.assertSharedHelpersCurrent;
    keepSharedHelpers = lifecycleUp.keepSharedHelpers;
  } catch (error: unknown) {
    const message =
      error instanceof Error
        ? error.message
        : "Failed to start lifecycle setup";
    logger.error({ message });
    return { code: 1, phase: "lifecycle" };
  }

  // Set right before Compose may start containers. A signal from then on
  // keeps the shared helpers: a start still in flight can start services
  // after any snapshot, so no probe could prove them absent.
  let containerStartBegun = false;
  const signalCleanup =
    lifecycleSignalCleanup ??
    installLifecycleSignalCleanup({
      cleanup: signalCleanupKeepingStartedHelpers({
        cleanup: lifecycleCleanup,
        containerStartBegun: () => containerStartBegun,
        keepSharedHelpers: () => keepSharedHelpers,
      }),
    });
  try {
    // Hooks may register or remove runtime aliases; render overrides only after
    // successful preparation, while lifecycle cleanup remains installed.
    const internalOverride = await resolveInternalComposeOverride({
      project: opts.project,
      cfg: opts.cfg,
      branch: opts.branch,
      devHost,
      aliasHost,
      addresses: "fresh",
    });
    const composeFiles =
      opts.branch && devHost
        ? await resolveBranchComposeFiles({
            project: opts.project,
            branch: opts.branch,
            devHost,
            aliasHost,
          })
        : [opts.project.composeFile];
    const composeFilesWithInternal = internalOverride
      ? [...composeFiles, internalOverride]
      : composeFiles;
    const dependencyCache = await resolveDependencyCacheOverride({
      projectRoot: opts.project.projectRoot,
      projectDir: opts.project.projectDir,
      projectName: opts.projectName,
      composeFile: opts.project.composeFile,
    });
    reportDependencyCacheFallback(dependencyCache);
    const composeFilesWithRuntimeOverrides = await withProjectLocalDirectories({
      project: opts.project,
      composeFiles: dependencyCache.overridePath
        ? [...composeFilesWithInternal, dependencyCache.overridePath]
        : composeFilesWithInternal,
      notify: (message) => logger.warn({ message }),
    });
    const runtimeMetadataOverride = await resolveRuntimeHostMetadataOverride({
      project: opts.project,
      composeFiles: composeFilesWithRuntimeOverrides,
      branch: opts.branch,
      devHost,
      aliasHost,
      composeProject: opts.composeProjectName ?? opts.baseProjectName,
    });
    const composeFilesWithEnv = [
      ...composeFilesWithRuntimeOverrides,
      ...(runtimeMetadataOverride ? [runtimeMetadataOverride] : []),
      ...envOverrides.composeFiles,
    ];
    reportComposeStartupBudget({
      budgets: opts.budgets,
      detach: opts.detach === true,
    });
    const upPhase = trackComposeStartupPhase();
    containerStartBegun = true;
    const guarded = await composeUpGuardedBySharedHelpers({
      assertCurrent: assertHelpersCurrent,
      up: (beforeStart) =>
        composeRuntimeBackend.up({
          ...(beforeStart ? { beforeStart } : {}),
          dependencyProgress: resolveDependencyCacheProgress({
            cache: dependencyCache,
            project: opts.composeProjectName,
            baseProject: opts.baseProjectName,
          }),
          startupTimeoutMs: opts.budgets.startupTimeoutMs,
          imageTimeoutMs: opts.budgets.imageTimeoutMs,
          startupCeilingMs: opts.budgets.startupCeilingMs,
          onStartupPhase: upPhase.onStartupPhase,
          onStartupProgress: upPhase.onStartupProgress,
          onStartupStalled: upPhase.onStartupStalled,
          composeFiles: composeFilesWithEnv,
          composeProject: opts.composeProjectName,
          profiles: opts.profiles,
          detach: opts.detach === true,
          cwd: dirname(opts.project.composeFile),
          env: envOverrides.env,
          routeStdoutToStderr: opts.routeStdoutToStderr === true,
          forceRecreate: true,
        }),
    });
    if ("superseded" in guarded) {
      return await abandonSupersededRestart({
        error: guarded.superseded,
        cleanup: lifecycleCleanup,
        projectDir: opts.project.projectDir,
        composeProject: opts.lifecycleComposeProject,
      });
    }
    const upCode = guarded.code;
    if (upCode !== 0) {
      return await repairFailedRestart({
        budgets: opts.budgets,
        upCode,
        composePhase: upPhase.phase(),
        inProgress: upPhase.inProgress(),
        assertCurrent: assertHelpersCurrent,
        cleanup: lifecycleCleanup,
        retainHelpersIfContainersMayRun,
        projectDir: opts.project.projectDir,
        lifecycleComposeProject: opts.lifecycleComposeProject,
        up: (beforeStart) =>
          composeRuntimeBackend.up({
            ...(beforeStart ? { beforeStart } : {}),
            dependencyProgress: resolveDependencyCacheProgress({
              cache: dependencyCache,
              project: opts.composeProjectName,
              baseProject: opts.baseProjectName,
            }),
            startupTimeoutMs: opts.budgets.startupTimeoutMs,
            imageTimeoutMs: opts.budgets.imageTimeoutMs,
            // The repair keeps the project's resolved ceiling (HACK-2310).
            startupCeilingMs: opts.budgets.startupCeilingMs,
            composeFiles: composeFilesWithEnv,
            composeProject: opts.composeProjectName,
            profiles: opts.profiles,
            detach: true,
            cwd: dirname(opts.project.composeFile),
            env: envOverrides.env,
            routeStdoutToStderr: opts.routeStdoutToStderr === true,
          }),
      });
    }

    if (opts.detach === true) {
      // The containers now run: a later failure keeps their helpers.
      keepSharedHelpers?.();
    }
    const observationBudgetMs = Math.max(
      0,
      opts.budgets.startupTimeoutMs - (performance.now() - upPhase.progressAt())
    );
    const upAfter = await runLifecycleCommands({
      title: "Lifecycle (restart up after)",
      commands: opts.cfg.lifecycle?.up?.after,
      projectRoot: opts.project.projectRoot,
      env: envOverrides.lifecycleEnv,
      projectDir: opts.project.projectDir,
      composeProject: opts.lifecycleComposeProject,
    });
    if (upAfter !== 0) {
      await lifecycleCleanup?.();
    }
    return {
      code: upAfter,
      phase: "lifecycle",
      observationBudgetMs,
    };
  } catch (error: unknown) {
    await retainHelpersIfContainersMayRun();
    await lifecycleCleanup?.();
    await removeProjectRuntimeStateEntry({
      projectDir: opts.project.projectDir,
      composeProject: opts.lifecycleComposeProject,
    });
    throw error;
  } finally {
    signalCleanup.dispose();
  }
}

type TargetedServiceRestartResult =
  | {
      readonly ok: true;
      readonly code: 0;
      readonly running: readonly string[];
      readonly completed: readonly string[];
      /** One-shots among the restarted services it stopped mid-run. */
      readonly interruption?: OneShotInterruption;
    }
  | {
      readonly ok: false;
      readonly code: number;
      readonly errorCode:
        | "E_COMPOSE_FAILED"
        | "E_STARTUP_INCOMPLETE"
        | "E_DEPENDENCY_BOOTSTRAP_FAILED"
        | "E_STARTUP_TIMEOUT"
        | "E_CANCELLED";
      readonly message: string;
      readonly running: readonly string[];
      readonly completed: readonly string[];
    };

/**
 * Recreate only the explicitly selected services. Project lifecycle hooks are
 * intentionally not run because their scope is the whole runtime, not an
 * individual Compose service.
 */
async function runTargetedServiceRestart(opts: {
  readonly budgets: ComposeStartupBudgets;
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly baseProjectName: string;
  readonly projectName: string;
  readonly composeProjectName: string | null;
  readonly profiles: readonly string[];
  readonly branch: string | null;
  readonly envName?: string | null;
  readonly services: readonly string[];
  readonly allServiceNames: readonly string[];
  readonly routeStdoutToStderr: boolean;
  readonly json: boolean;
}): Promise<TargetedServiceRestartResult> {
  await maybeSyncOauthAliasesInCompose({ project: opts.project });
  const devHost = await resolveRuntimeDevHost({
    project: opts.project,
    branch: opts.branch,
  });
  const aliasHost = resolveBranchAliasHost({ devHost, cfg: opts.cfg });
  const internalOverride = await resolveInternalComposeOverride({
    project: opts.project,
    cfg: opts.cfg,
    branch: opts.branch,
    devHost,
    aliasHost,
    addresses: "fresh",
  });
  const composeFiles =
    opts.branch && devHost
      ? await resolveBranchComposeFiles({
          project: opts.project,
          branch: opts.branch,
          devHost,
          aliasHost,
        })
      : [opts.project.composeFile];
  const dependencyCache = await resolveDependencyCacheOverride({
    projectRoot: opts.project.projectRoot,
    projectDir: opts.project.projectDir,
    projectName: opts.projectName,
    composeFile: opts.project.composeFile,
  });
  const cacheBootstrapServices = await resolveDependencyCacheBootstrapServices({
    composeFile: opts.project.composeFile,
    cache: dependencyCache,
    targetServices: opts.services,
  });
  const preparedServices = [
    ...new Set([...opts.services, ...cacheBootstrapServices]),
  ];
  const envOverrides = await resolveComposeEnvOverrides({
    project: opts.project,
    projectName: opts.projectName,
    targetServices: preparedServices,
    allServiceNames: opts.allServiceNames,
    envName: opts.envName,
  });
  await assertRegistryCredentialsAvailable({
    projectRoot: opts.project.projectRoot,
    composeFile: opts.project.composeFile,
    targetServices: preparedServices,
    envByService: envOverrides.preflightEnvByService,
  });
  // Before anything is recreated, with the environment its own reads use.
  const interruptionCheck = await checkOneShotInterruption({
    project: opts.project,
    composeProjectName: opts.composeProjectName,
    profiles: opts.profiles,
    action: "restart",
    json: opts.json,
    services: opts.services,
    env: envOverrides.env,
  });
  if (!interruptionCheck.proceed) {
    return {
      ok: false,
      code: 1,
      errorCode: "E_CANCELLED",
      message: "Restart cancelled; nothing was stopped.",
      running: [],
      completed: [],
    };
  }
  reportDependencyCacheFallback(dependencyCache);
  const composeFilesWithRuntimeOverrides = await withProjectLocalDirectories({
    project: opts.project,
    composeFiles: [
      ...composeFiles,
      ...(internalOverride ? [internalOverride] : []),
      ...(dependencyCache.overridePath ? [dependencyCache.overridePath] : []),
    ],
  });
  const runtimeMetadataOverride = await resolveRuntimeHostMetadataOverride({
    project: opts.project,
    composeFiles: composeFilesWithRuntimeOverrides,
    branch: opts.branch,
    devHost,
    aliasHost,
    composeProject: opts.composeProjectName ?? opts.baseProjectName,
  });
  const composeFilesWithEnv = [
    ...composeFilesWithRuntimeOverrides,
    ...(runtimeMetadataOverride ? [runtimeMetadataOverride] : []),
    ...envOverrides.composeFiles,
  ];
  const bootstrapCode = await bootstrapDependencyCaches({
    timeoutMs: opts.budgets.startupTimeoutMs,
    services: cacheBootstrapServices,
    composeFiles: composeFilesWithEnv,
    composeProject: opts.composeProjectName,
    profiles: opts.profiles,
    cwd: dirname(opts.project.composeFile),
    env: envOverrides.env,
  });
  if (bootstrapCode !== 0) {
    const failure = dependencyCacheBootstrapFailure({
      code: bootstrapCode,
      timeoutMs: opts.budgets.startupTimeoutMs,
    });
    return {
      ok: false,
      code: bootstrapCode,
      errorCode: failure.code,
      message: failure.message,
      running: [],
      completed: [],
    };
  }
  reportComposeStartupBudget({
    budgets: opts.budgets,
    detach: true,
  });
  const upPhase = trackComposeStartupPhase();
  const code = await composeRuntimeBackend.up({
    dependencyProgress: resolveDependencyCacheProgress({
      cache: dependencyCache,
      project: opts.composeProjectName,
      baseProject: opts.baseProjectName,
    }),
    startupTimeoutMs: opts.budgets.startupTimeoutMs,
    imageTimeoutMs: opts.budgets.imageTimeoutMs,
    startupCeilingMs: opts.budgets.startupCeilingMs,
    onStartupPhase: upPhase.onStartupPhase,
    onStartupProgress: upPhase.onStartupProgress,
    onStartupStalled: upPhase.onStartupStalled,
    composeFiles: composeFilesWithEnv,
    composeProject: opts.composeProjectName,
    profiles: opts.profiles,
    detach: true,
    noDeps: true,
    forceRecreate: true,
    services: opts.services,
    cwd: dirname(opts.project.composeFile),
    env: envOverrides.env,
    routeStdoutToStderr: opts.routeStdoutToStderr,
  });
  // Force-recreate applies the env resolved above; after a failure the
  // services' delivered env is unknown, so their digests are dropped.
  await updateProjectRuntimeServiceEnvFingerprints({
    projectDir: opts.project.projectDir,
    composeProject: resolveLifecycleComposeProjectName({
      projectName: opts.projectName,
      branch: opts.branch,
    }),
    effectiveEnvName: envOverrides.effectiveEnvName,
    services: opts.services,
    envByService: envOverrides.preflightEnvByService,
    outcome: code === 0 ? "applied" : "unknown",
  });
  if (code !== 0) {
    const failure = composeStartupFailure({
      code,
      action: "Targeted service restart",
      phase: upPhase.phase(),
      budgets: opts.budgets,
      inProgress: upPhase.inProgress(),
    });
    return {
      ok: false,
      code,
      errorCode: failure.code,
      message: failure.message,
      running: [],
      completed: [],
    };
  }

  const effectiveProfiles = resolveEffectiveComposeProfiles({
    cliProfiles: opts.profiles,
    composeEnv: envOverrides.env,
  });
  const successfulCompletionServices = new Set(
    await discoverSuccessfulCompletionServices({
      composeFile: opts.project.composeFile,
      activeProfiles: effectiveProfiles,
      selectedServices: opts.services,
    })
  );
  const { states, startup } = await waitForComposeStartupState({
    successfulCompletionServices,
    deadlineMs: upPhase.progressAt() + opts.budgets.startupTimeoutMs,
    read: () =>
      readComposeServiceStates({
        project: opts.project,
        composeProjectName: opts.composeProjectName,
        profiles: opts.profiles,
        services: opts.services,
        env: envOverrides.env,
        strict: true,
      }),
  });
  if (startupSnapshotIsIncomplete({ states, failed: startup.failed })) {
    return {
      ok: false,
      code: 1,
      errorCode: "E_STARTUP_INCOMPLETE",
      message: composeStartupIncompleteMessage({
        composeProject:
          opts.composeProjectName ??
          defaultProjectSlugFromPath(opts.project.projectRoot),
        failed: startup.failed,
      }),
      running: startup.running,
      completed: startup.completed,
    };
  }
  return {
    ok: true,
    code: 0,
    running: startup.running,
    completed: startup.completed,
    ...(interruptionCheck.interruption
      ? { interruption: interruptionCheck.interruption }
      : {}),
  };
}

function validateFrontendRecoveryOptions(opts: {
  readonly recover: boolean;
  readonly expectAttempt: string | undefined;
  readonly legacyPid: number | undefined;
}): void {
  const { recover, expectAttempt, legacyPid } = opts;
  if (
    (recover &&
      (typeof expectAttempt !== "string" ||
        !FINALIZATION_ATTEMPT.test(expectAttempt) ||
        (legacyPid !== undefined &&
          (!Number.isSafeInteger(legacyPid) || legacyPid <= 1)))) ||
    (!recover && (expectAttempt !== undefined || legacyPid !== undefined))
  ) {
    throw new CliUsageError(
      "Native frontend recovery requires --recover-frontend and the exact --expect-finalization-attempt; legacy state also requires --expect-frontend-pid."
    );
  }
}

async function handleRestart({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: RestartArgs;
}): Promise<number> {
  const recover = args.options.recoverFrontend === true;
  const expectAttempt = args.options.expectFinalizationAttempt;
  const legacyPid = args.options.expectFrontendPid;
  validateFrontendRecoveryOptions({ recover, expectAttempt, legacyPid });
  prepareLifecycleProgress({
    action: "restart",
    progress: args.options.progress,
    json: args.options.json,
    backend: process.env.HACK_RUNTIME_BACKEND,
  });
  // Refuse a malformed --target before any project or runtime work.
  parseRequestedTarget({ raw: args.options.target });
  const authored = await tryNativeComposeCommand({
    cwd: ctx.cwd,
    path: args.options.path,
    project: args.options.project,
    operation: "restart",
    instance: args.options.branch,
    profiles: parseCsvList(args.options.profile),
    overlay: args.options.env,
    json: args.options.json,
    services: args.positionals.services,
    unsupportedOptions: [
      args.options.target,
      recover,
      expectAttempt,
      legacyPid,
      args.options.progress,
    ].some(Boolean),
  });
  if (authored !== null) {
    return authored;
  }
  const native = resolveNativeRuntimeSelection();
  if (native && args.options.json === true && !recover) {
    // `--json` wants one result envelope once the services are back, as on
    // Compose. The native restart owns the services for as long as they run,
    // so run it in a detached owner and report its readiness (HACK native
    // CLI gaps, item 2); without --json the restart stays in the foreground.
    refuseUnsupportedNativeUpOptions({
      restart: true,
      target: args.options.target,
      services: args.positionals.services,
    });
    // The child's own refusal cannot cross IPC: a run mapping another native
    // home owns is refused here, with its code and release command, as plain
    // restart and `up --detach` do (HACK-2339), and an unconfirmed start is
    // explained by that mapping afterwards.
    // Likewise a mistyped hot-reload setting or admission reuse bound: the
    // owner would refuse it before stopping anything, but its message would
    // not reach this launcher.
    nativeHotReloadEnvironment(["runtime", "up"], process.env);
    nativeAdmissionReuseEnvironment(["runtime", "up"], process.env);
    const scope = await resolveNativeRestartLaunchScope({ ctx, args, native });
    const foreign = await nativeForeignHomeRefusal(scope);
    if (foreign) {
      throw foreign;
    }
    // The detached owner's output is not shown: refuse or report here.
    await reportNativeLocalDirectoriesBeforeLaunch({
      ctx,
      path: args.options.path,
      project: args.options.project,
      json: true,
      track: { branch: scope?.branch ?? null, mode: "restart" },
    });
    return await launchNativeDetachedUp({
      cwd: ctx.cwd,
      args: nativeDetachedOwnerArgs({
        action: "restart",
        options: args.options,
      }),
      json: true,
      action: "restart",
      scope,
    });
  }
  if (native) {
    return await handleNativeUp({
      ctx,
      args: {
        ...args,
        options: {
          ...args.options,
          use: undefined,
          detach: false,
          always: false,
          refreshImages: false,
          timings: false,
          timingsFile: undefined,
          offline: false,
        },
      },
      native,
      restart: true,
      recovery:
        recover && expectAttempt
          ? { expectAttempt, ...(legacyPid ? { legacyPid } : {}) }
          : undefined,
    });
  }
  if (recover) {
    throw new CliUsageError(
      "Frontend recovery is available only for the native runtime."
    );
  }
  requireComposeOperationAvailable("restart");
  const json = args.options.json === true;
  if (!json) {
    return await runRestartCommand({ ctx, args, json: false });
  }

  // `--json`: keep stdout reserved for the result envelope.
  setLoggerBackendOverride({ backend: "console" });
  const startedAtMs = Date.now();
  try {
    return await runRestartCommand({ ctx, args, json: true, startedAtMs });
  } catch (error: unknown) {
    if (error instanceof MissingProjectContextError) {
      return emitLifecycleResult({
        result: errorResult({
          code: "E_PROJECT_NOT_FOUND",
          message: error.message,
        }),
        exitCode: 1,
      });
    }
    return emitLifecycleResult({
      result: buildLifecycleJsonErrorResult({ error }),
      exitCode: 1,
    });
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: restart coordinates preflight, scoped recreation, lifecycle preparation, repair, and JSON reporting in one transaction.
async function runRestartCommand({
  ctx,
  args,
  json,
  startedAtMs,
}: {
  readonly ctx: CliContext;
  readonly args: RestartArgs;
  readonly json: boolean;
  readonly startedAtMs?: number;
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  const cfg = await readProjectConfig(project);
  refuseRemoteStart(cfg.prerequisites?.config?.selected, "hack restart");
  if (
    !(await enforceProjectPrerequisites(
      cfg.prerequisites,
      json,
      project.projectRoot,
      { composeFile: project.composeFile, services: args.positionals.services }
    ))
  ) {
    return 1;
  }
  const budgets = await withProjectComposeBudgets({
    budgets: resolveDetachedComposeBudgets(true),
    detach: true,
    project,
  });
  const envName = resolveRequestedEnvName({
    envOption: args.options.env,
  });
  const branchIdentity = await resolveEffectiveBranchIdentityForCommand({
    project,
    branchOption: args.options.branch,
    noticeToStderr: json,
    warnOnRetarget: true,
  });
  const branch = branchIdentity.branch;
  const profiles = parseCsvList(args.options.profile);

  await recordBranchUsageIfNeeded({
    project,
    branch,
    name: branchIdentity.name,
  });
  const remoteRestartCode = await runRemoteLifecycleCommand({
    project,
    action: "restart",
    branch,
    profiles,
    envName,
    requestedTarget: args.options.target,
    services: args.positionals.services,
  });
  if (remoteRestartCode !== null) {
    if (json) {
      return emitRemoteLifecycleJson({
        action: "restart",
        exitCode: remoteRestartCode,
        project: defaultProjectSlugFromPath(project.projectRoot),
        branch,
        startedAtMs,
      });
    }
    return remoteRestartCode;
  }
  // Refused before the parse warning, which carries the same message.
  const localDirectoriesRefusal = refuseInvalidLocalDirectories({ cfg, json });
  if (localDirectoriesRefusal !== null) {
    return localDirectoriesRefusal;
  }
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile;
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`,
    });
  }
  const sharedHelperRefusal = refuseInvalidSharedHelpers({ cfg, json });
  if (sharedHelperRefusal !== null) {
    return sharedHelperRefusal;
  }

  const baseProjectName = await resolveComposeProjectName({ project, cfg });
  if (
    resolveLifecycleRunner({ runner: cfg.lifecycle?.runner }) === "supervisor"
  ) {
    await preflightLifecycleSupervisor();
  }
  const { composeProjectName, lifecycleComposeProject } = resolveRestartTarget({
    baseProjectName,
    branch,
  });
  beginLifecycleProgress({ project: composeProjectName ?? baseProjectName });
  const projectName = sanitizeProjectSlug(baseProjectName);
  const allServiceNames = await readComposeServiceNames(project.composeFile);
  const requestedServices = resolveRequestedComposeServices({
    requested: args.positionals.services,
    available: allServiceNames,
  });
  // Whole-stack and service-scoped restarts both keep the recorded running
  // selection when --env is omitted (HACK-2280); a targeted restart also
  // records its selection, so the default must not replace it.
  const effectiveEnvName = await resolveStoredRuntimeEnvName({
    requestedEnvName: envName,
    projectDir: project.projectDir,
    composeProject: lifecycleComposeProject,
  });
  if (requestedServices.length > 0) {
    const result = await runTargetedServiceRestart({
      budgets,
      project,
      cfg,
      baseProjectName,
      projectName,
      composeProjectName,
      profiles,
      branch,
      envName: effectiveEnvName,
      services: requestedServices,
      allServiceNames,
      routeStdoutToStderr: json,
      json,
    });
    if (!json) {
      if (!result.ok) {
        logger.error({ message: result.message });
      }
      return result.code;
    }
    if (!result.ok) {
      return emitLifecycleResult({
        result: errorResult({
          code: result.errorCode,
          message: result.message,
          detail: { services: requestedServices },
        }),
        exitCode: result.code,
      });
    }
    return emitLifecycleResult({
      result: okResult({
        data: buildLifecycleJsonData({
          action: "restart",
          project: baseProjectName,
          branch,
          composeProject: composeProjectName ?? baseProjectName,
          started: result.running,
          completed: result.completed,
          interruption: result.interruption,
          durationMs: Date.now() - (startedAtMs ?? Date.now()),
        }),
      }),
      exitCode: 0,
    });
  }
  const lifecycleEnv = await resolveLifecycleEnvForProject({
    project,
    projectName,
    envName: effectiveEnvName,
  });
  const preflightEnv = await resolveComposeEnvOverrides({
    project,
    projectName,
    targetServices: allServiceNames,
    allServiceNames,
    envName: effectiveEnvName,
  });
  await assertRegistryCredentialsAvailable({
    projectRoot: project.projectRoot,
    composeFile: project.composeFile,
    targetServices: allServiceNames,
    envByService: preflightEnv.preflightEnvByService,
  });

  const interruptionCheck = await checkOneShotInterruption({
    project,
    composeProjectName,
    profiles,
    action: "restart",
    json,
    env: preflightEnv.env,
  });
  if (!interruptionCheck.proceed) {
    return 1;
  }
  reportLifecycleProgress({ service: null, phase: "stopping" });
  const downPhase = await runRestartDownPhase({
    project,
    cfg,
    projectName,
    composeProjectName,
    composeProjectLabel: composeProjectName ?? baseProjectName,
    lifecycleComposeProject,
    profiles,
    branch,
    envForCompose: lifecycleEnv,
    routeStdoutToStderr: json,
    preserveComposeRuntime: true,
  });
  const downCode = downPhase.code;
  if (downPhase.sharedHelperFailures) {
    if (json) {
      return emitLifecycleResult({
        result: errorResult({
          code: "E_LIFECYCLE_FAILED",
          message: sharedHelperReleaseFailureMessage(
            downPhase.sharedHelperFailures
          ),
          detail: {
            sharedHelpers: [...downPhase.sharedHelperFailures],
            phase: "down",
          },
        }),
        exitCode: 1,
      });
    }
    return 1;
  }
  if (downCode !== 0) {
    if (json) {
      return emitLifecycleResult({
        result: errorResult({
          code: "E_COMPOSE_FAILED",
          message: `Restart down phase failed (exit ${downCode})`,
          detail: { exitCode: downCode, phase: "down" },
        }),
        exitCode: downCode,
      });
    }
    return downCode;
  }

  reportLifecycleProgress({ service: null, phase: "stopped" });
  await removeProjectRuntimeStateEntry({
    projectDir: project.projectDir,
    composeProject: lifecycleComposeProject,
  });

  const upOutcome = await runRestartUpPhase({
    budgets,
    project,
    cfg,
    baseProjectName,
    projectName,
    composeProjectName,
    lifecycleComposeProject,
    profiles,
    branch,
    envName: effectiveEnvName,
    detach: true,
    routeStdoutToStderr: json,
  });

  const upCode = upOutcome.code;
  if (upCode !== 0) {
    const failure =
      upOutcome.phase === "compose"
        ? composeStartupFailure({
            code: upCode,
            action: "Restart up phase",
            phase: upOutcome.composePhase ?? "start",
            budgets,
            inProgress: upOutcome.inProgress,
          })
        : {
            code: "E_LIFECYCLE_FAILED" as const,
            message: `Restart lifecycle hook failed (exit ${upCode})`,
          };
    if (!json) {
      logger.error({ message: failure.message });
      return upCode;
    }
    return emitLifecycleResult({
      result: errorResult({
        code: failure.code,
        message: failure.message,
        detail: {
          ...("phase" in failure
            ? composeStartupFailureDetail({ failure, exitCode: upCode })
            : { exitCode: upCode }),
          phase: "up",
        },
      }),
      exitCode: upCode,
    });
  }

  const effectiveProfiles = resolveEffectiveComposeProfiles({
    cliProfiles: profiles,
    composeEnv: preflightEnv.env,
  });
  const successfulCompletionServices = new Set(
    await discoverSuccessfulCompletionServices({
      composeFile: project.composeFile,
      activeProfiles: effectiveProfiles,
    })
  );
  const cleanupIncompleteStartup = async () => {
    // Some containers may still run: keep the helper holders for hack down.
    await stopLifecycleProcessesBestEffort({
      project,
      cfg,
      projectName,
      branch,
      composeProject: lifecycleComposeProject,
      containers: "unconfirmed",
    });
    await removeProjectRuntimeStateEntry({
      projectDir: project.projectDir,
      composeProject: lifecycleComposeProject,
    });
  };
  const { states, startup } = await waitForComposeStartupState({
    successfulCompletionServices,
    deadlineMs: performance.now() + (upOutcome.observationBudgetMs ?? 0),
    read: () =>
      readComposeServiceStates({
        project,
        composeProjectName,
        profiles,
        env: preflightEnv.env,
        strict: true,
      }),
  }).catch(async (error: unknown) => {
    await cleanupIncompleteStartup();
    throw error;
  });
  if (startupSnapshotIsIncomplete({ states, failed: startup.failed })) {
    await cleanupIncompleteStartup();
    const message = composeStartupIncompleteMessage({
      composeProject: composeProjectName ?? baseProjectName,
      failed: startup.failed,
    });
    if (!json) {
      logger.error({ message });
      return 1;
    }
    return emitLifecycleResult({
      result: errorResult({
        code: "E_STARTUP_INCOMPLETE",
        message,
        detail: {
          running: startup.running,
          completed: startup.completed,
          failed: startup.failed,
          ...(states.length === 0
            ? { inspection: "no_services_reported" }
            : {}),
        },
      }),
      exitCode: 1,
    });
  }
  if (!json) {
    return 0;
  }
  return emitLifecycleResult({
    result: okResult({
      data: buildLifecycleJsonData({
        action: "restart",
        project: baseProjectName,
        branch,
        composeProject: composeProjectName ?? baseProjectName,
        started: startup.running,
        completed: startup.completed,
        interruption: interruptionCheck.interruption,
        durationMs: Date.now() - (startedAtMs ?? Date.now()),
      }),
    }),
    exitCode: 0,
  });
}

/**
 * The overlay a command against a running instance uses: an explicit
 * `--env`, else the instance's recorded running selection (base included),
 * else `undefined` so the configured default applies. See
 * {@link selectEnvForRunningInstance}.
 */
export async function resolveStoredRuntimeEnvName(opts: {
  readonly requestedEnvName: string | null | undefined;
  readonly projectDir: string;
  readonly composeProject: string;
}): Promise<string | null | undefined> {
  if (opts.requestedEnvName !== undefined) {
    return opts.requestedEnvName;
  }

  const state = await readProjectRuntimeStateEntry({
    projectDir: opts.projectDir,
    composeProject: opts.composeProject,
  });
  return selectEnvForRunningInstance({
    requestedEnvName: undefined,
    running: state,
  });
}

export function resolveRestartTarget(opts: {
  readonly baseProjectName: string;
  readonly branch: string | null;
}): {
  readonly composeProjectName: string | null;
  readonly lifecycleComposeProject: string;
} {
  return {
    composeProjectName: opts.branch
      ? `${opts.baseProjectName}--${opts.branch}`
      : null,
    lifecycleComposeProject: resolveLifecycleComposeProjectName({
      projectName: sanitizeProjectSlug(opts.baseProjectName),
      branch: opts.branch,
    }),
  };
}

/**
 * Record the env selection of a full-stack up/restart together with fresh,
 * value-free digests of the env set delivered to each prepared service, so
 * `hack exec` can warn when the resolved env later changes.
 *
 * Compose profiles accumulate while the entry exists: a full up with fewer
 * profiles does not stop the services of the others, so `down` must still
 * enable them. A complete `down` removes the entry, which clears them.
 */
async function persistProjectRuntimeEnvSelection(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
  readonly envName: string | null;
  readonly services: readonly string[];
  readonly envByService: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
  /** Profiles Compose activated, so `down` can enable them (HACK-2340). */
  readonly composeProfiles: readonly string[];
}): Promise<void> {
  const previous = await readProjectRuntimeStateEntry({
    projectDir: opts.projectDir,
    composeProject: opts.composeProject,
  });
  await upsertProjectRuntimeStateEntry({
    projectDir: opts.projectDir,
    entry: {
      composeProject: opts.composeProject,
      envName: opts.envName,
      updatedAt: new Date().toISOString(),
      envFingerprint: withComposeServiceEnvFingerprints({
        existing: undefined,
        services: opts.services,
        envByService: opts.envByService,
      }),
      composeProfiles: unionProfiles([
        ...(previous?.composeProfiles ?? []),
        ...opts.composeProfiles,
      ]),
    },
  });
}

/** Bound on one docker ps/rm call while finishing a stop. */
const INSTANCE_STOP_DOCKER_TIMEOUT_MS = 15_000;
/**
 * Bound on `docker stop` of leftovers. Each container keeps its own
 * `stop_grace_period` (Compose stores it as the container's stop timeout),
 * so this only caps a daemon that never answers.
 */
const INSTANCE_STOP_GRACE_CAP_MS = 10 * 60_000;

/**
 * The profiles a stop of the instance enables (HACK-2340): every profile it
 * may have started. Compose itself receives the env `down` resolved for its
 * hooks from the instance's recorded selection (the host-target global
 * env). That is close to, but not exactly, the env `up` gave Compose; the
 * recorded profiles and the leftover stop below do not depend on it.
 */
async function resolveInstanceStopSelection(opts: {
  readonly projectDir: string;
  readonly lifecycleComposeProject: string;
  readonly cliProfiles: readonly string[];
  readonly composeEnv: Readonly<Record<string, string>>;
}): Promise<{ readonly profiles: string[] }> {
  const recorded = await readProjectRuntimeStateEntry({
    projectDir: opts.projectDir,
    composeProject: opts.lifecycleComposeProject,
  });
  return {
    profiles: resolveInstanceStopProfiles({
      recorded: recorded?.composeProfiles,
      cliProfiles: opts.cliProfiles,
      currentProfiles: resolveEffectiveComposeProfiles({
        cliProfiles: [],
        composeEnv: opts.composeEnv,
      }),
    }),
  };
}

/**
 * Every container labelled with the instance's Compose project, any state,
 * with service and working dir, from `docker compose ps --all` (Compose
 * resolves the project name and lists profiled and orphaned containers
 * too). A failed or unreadable read is unknown, never empty.
 */
async function listInstanceContainers(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly composeProjectName: string | null;
  readonly profiles: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}): Promise<InstanceContainerListing> {
  const res = await composeRuntimeBackend.psJson({
    composeFiles: [opts.project.composeFile],
    composeProject: opts.composeProjectName,
    profiles: opts.profiles,
    cwd: dirname(opts.project.composeFile),
    all: true,
    env: opts.env,
  });
  if (res.exitCode !== 0) {
    return {
      ok: false,
      reason:
        res.exitCode === 124
          ? "docker compose ps timed out"
          : `docker compose ps failed (exit ${res.exitCode})`,
    };
  }
  return parseComposePsInstanceContainers(res.stdout);
}

/** Docker networks labelled with this Compose project; failed/timed-out read is unknown. */
async function listInstanceNetworks(opts: {
  readonly composeProject: string;
  readonly env: Readonly<Record<string, string>>;
}): Promise<InstanceNetworkListing> {
  const res = await exec(
    [
      "docker",
      "network",
      "ls",
      "--filter",
      `label=com.docker.compose.project=${opts.composeProject}`,
      "--format",
      "{{.Name}}",
    ],
    {
      stdin: "ignore",
      env: { ...opts.env },
      timeoutMs: INSTANCE_STOP_DOCKER_TIMEOUT_MS,
    }
  ).catch(() => null);
  if (res === null || res.exitCode !== 0) {
    const reason =
      res?.exitCode === 124
        ? "docker network ls timed out"
        : `docker network ls failed${res ? ` (exit ${res.exitCode})` : ""}`;
    return { ok: false, reason };
  }
  return {
    ok: true,
    networks: res.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

/**
 * After `docker compose down`: stop and remove the containers of the
 * instance that this checkout owns and Compose left behind (a profile the
 * down did not enable, an orphan), run down once more so the network goes
 * too, and carry its outcome together with what was observed. Containers of
 * another checkout are never stopped; while they run, the down is incomplete.
 */
async function finishInstanceStop(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly composeProjectName: string | null;
  readonly composeProjectLabel: string;
  readonly profiles: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly routeStdoutToStderr: boolean;
  readonly timeoutSeconds?: number;
}): Promise<
  | { readonly ok: true; readonly observation: DownObservation }
  | ({ readonly ok: false } & ComposeDownRetryFailure)
> {
  const leftovers = await listInstanceContainers(opts);
  if (leftovers.ok) {
    const owned = selectOwnedInstanceContainers({
      containers: leftovers.containers,
      projectDir: opts.project.projectDir,
    });
    if (owned.length > 0) {
      const ids = owned.map((container) => container.id);
      // The same env Compose ran with, so a managed DOCKER_HOST or
      // DOCKER_CONTEXT targets the same daemon.
      const stopCmd =
        opts.timeoutSeconds === undefined
          ? ["docker", "stop", ...ids]
          : ["docker", "stop", "-t", String(opts.timeoutSeconds), ...ids];
      await exec(stopCmd, {
        stdin: "ignore",
        env: { ...opts.env },
        timeoutMs: Math.max(
          INSTANCE_STOP_GRACE_CAP_MS,
          resolveComposeDownCapMs({
            timeoutSeconds: opts.timeoutSeconds,
            runningServiceCount: countDistinctRunningServices(
              owned.map((container) => container.service || container.id)
            ),
          })
        ),
      });
      await exec(["docker", "rm", ...ids], {
        stdin: "ignore",
        env: { ...opts.env },
        timeoutMs: INSTANCE_STOP_DOCKER_TIMEOUT_MS,
      });
      const retryCapMs = resolveComposeDownCapMs({
        timeoutSeconds: opts.timeoutSeconds,
      });
      let retryTimedOut = false;
      const retryExitCode = await composeRuntimeBackend.down({
        composeFiles: [opts.project.composeFile],
        composeProject: opts.composeProjectName,
        profiles: opts.profiles,
        cwd: dirname(opts.project.composeFile),
        env: opts.env,
        routeStdoutToStderr: opts.routeStdoutToStderr,
        timeoutSeconds: opts.timeoutSeconds,
        capMs: retryCapMs,
        onOutcome: (outcome) => {
          retryTimedOut = outcome.timedOut;
        },
      });
      const [listing, networks] = await Promise.all([
        listInstanceContainers(opts),
        listInstanceNetworks({
          composeProject: opts.composeProjectLabel,
          env: opts.env,
        }),
      ]);
      if (retryExitCode !== 0) {
        return {
          ok: false,
          ...buildComposeDownRetryFailure({
            exitCode: retryExitCode,
            timedOut: retryTimedOut,
            capMs: retryCapMs,
            listing,
            networks,
            projectDir: opts.project.projectDir,
          }),
        };
      }
      return {
        ok: true,
        observation: classifyDownObservation({
          listing,
          networks,
          projectDir: opts.project.projectDir,
        }),
      };
    }
  }
  return {
    ok: true,
    observation: classifyDownObservation({
      listing: await listInstanceContainers(opts),
      projectDir: opts.project.projectDir,
    }),
  };
}

async function maybeManageProjectLogsAfterDown(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly branch: string | null;
}): Promise<void> {
  const cfg = await readProjectConfig(opts.project);
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? opts.project.configFile;
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`,
    });
  }
  const baseName = await resolveComposeProjectName({
    project: opts.project,
    cfg,
  });
  const projectName = opts.branch ? `${baseName}--${opts.branch}` : baseName;
  const logsCfg = cfg.logs;

  if (!logsCfg) {
    return;
  }

  const baseUrl = lokiBaseUrl();
  const lokiReachable = await canReachLoki({ baseUrl });
  if (!lokiReachable) {
    return;
  }

  const selector = buildLogSelector({
    project: projectName.length > 0 ? projectName : null,
    services: [],
  });
  const now = Date.now();

  const lookbackMs = 30 * 24 * 60 * 60 * 1000; // 30d (covers the default global retention)
  const lookbackStart = new Date(now - lookbackMs);

  if (logsCfg.clearOnDown) {
    logger.step({ message: "Clearing Loki logs for this project…" });
    const res = await requestLokiDelete({
      baseUrl,
      query: selector,
      start: lookbackStart,
    });
    if (!res.ok) {
      logger.warn({ message: res.message });
      return;
    }
    logger.success({
      message:
        "Requested Loki log deletion (may take time due to cancellation window)",
    });
    return;
  }

  const retentionRaw = logsCfg.retentionPeriod;
  if (!retentionRaw) {
    return;
  }

  const retentionMs = parseDurationMs(retentionRaw);
  if (!retentionMs) {
    const configPath = cfg.configPath ?? opts.project.configFile;
    logger.warn({
      message: `Invalid logs.retention_period in ${configPath}: "${retentionRaw}" (expected e.g. "24h", "7d")`,
    });
    return;
  }

  const pruneEndMs = now - retentionMs;
  if (pruneEndMs <= lookbackStart.getTime()) {
    return;
  }

  logger.step({
    message: `Pruning Loki logs older than ${retentionRaw} for this project…`,
  });
  const res = await requestLokiDelete({
    baseUrl,
    query: selector,
    start: lookbackStart,
    end: new Date(pruneEndMs),
  });
  if (!res.ok) {
    logger.warn({ message: res.message });
    return;
  }

  logger.success({
    message:
      "Requested Loki log prune (may take time due to cancellation window)",
  });
}

async function handlePs({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: PsArgs;
}): Promise<number> {
  if (args.options.copies) {
    if (
      args.options.branch !== undefined ||
      args.options.profile !== undefined ||
      args.options.wide
    ) {
      throw new CliUsageError(
        "--copies cannot be combined with --branch, --profile or --wide."
      );
    }
    return await runProjectCopies({
      cwd: ctx.cwd,
      path: args.options.path,
      project: args.options.project,
      json: args.options.json === true,
      legacyContext: () =>
        resolveProjectForArgs({
          ctx,
          pathOpt: args.options.path,
          projectOpt: args.options.project,
          touchRegistration: false,
        }),
      addresses: async (project, branch, native) =>
        readProjectServiceAddresses({
          project,
          cfg: await readProjectConfig(project),
          branch,
          native,
        }),
    });
  }
  const authored = await tryNativeComposeCommand({
    cwd: ctx.cwd,
    path: args.options.path,
    project: args.options.project,
    operation: "ps",
    instance: args.options.branch,
    profiles:
      args.options.profile === undefined
        ? undefined
        : parseCsvList(args.options.profile),
    json: args.options.json,
    psWide: args.options.wide === true,
  });
  if (authored !== null) {
    return authored;
  }
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
    touchRegistration: false,
  });
  const json = args.options.json === true;
  const branch = await resolveEffectiveBranchForCommand({
    project,
    branchOption: args.options.branch,
    noticeToStderr: json,
  });
  const cfg = await readProjectConfig(project);
  const native = resolveNativeRuntimeSelection();
  let addressUnavailable = false;
  const addresses = json
    ? new Map<string, readonly string[]>()
    : await readProjectServiceAddresses({
        project,
        cfg,
        branch,
        native: native !== null,
      }).catch((error: unknown) => {
        if (
          !(
            native &&
            error instanceof HackCliError &&
            (error.code === "E_CONFIG_INVALID" || error.code === "E_PERMISSION")
          )
        ) {
          throw error;
        }
        addressUnavailable = true;
        return new Map<string, readonly string[]>();
      });
  if (native) {
    if (args.options.profile) {
      throw new CliUsageError("Native ps does not support profile filtering.");
    }
    const result = await nativeProjectPs({
      runtime: native,
      scope: {
        projectRoot: project.projectRoot,
        projectDir: project.projectDir,
        nativeHome: native.home,
        branch,
      },
    });
    const imageTags =
      json || args.options.wide
        ? await nativeImageTagStatuses({
            runtime: native,
            projectRoot: project.projectRoot,
            composeFile: project.composeFile,
          })
        : [];
    await displayNativePs(
      imageTags.length ? { ...result, imageTags } : result,
      json,
      {
        addresses,
        wide: args.options.wide,
        recoveryCommand: scopedHackCommand("down", {
          path: args.options.path,
          project: args.options.project,
          branch: branch ?? undefined,
        }),
      }
    );
    if (addressUnavailable) {
      createTextOutput().line(
        "native https settings invalid · addresses unavailable",
        "faint"
      );
    }
    return 0;
  }
  const profiles = parseCsvList(args.options.profile);

  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile;
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`,
    });
  }

  const baseProjectName = await resolveComposeProjectName({ project, cfg });
  const composeProjectName = branch ? `${baseProjectName}--${branch}` : null;

  const cwd = dirname(project.composeFile);

  // Read Compose directly: the daemon cache omits state and exit codes and can
  // lag behind a failed startup. Both formats must observe the same containers.
  // A failed or unparsable read throws a coded error with the engine's cause
  // (envelope under --json, one line otherwise); see compose-ps-result.ts.
  const read = await readComposePs({
    run: () =>
      composeRuntimeBackend.psJson({
        composeFiles: [project.composeFile],
        composeProject: composeProjectName,
        profiles,
        cwd,
        all: true,
      }),
  });
  if (!read.ok) {
    if (!json && read.error.code === "E_DOCKER_UNAVAILABLE") {
      process.stderr.write("E_DOCKER_UNAVAILABLE: docker engine unavailable\n");
      return 1;
    }
    if (!json && read.error.code === "E_PERMISSION") {
      process.stderr.write(
        "E_PERMISSION: access denied while reading compose status\n"
      );
      return 1;
    }
    if (!json && composePsTextFallbackAllowed(read.error)) {
      process.stderr.write(
        `${read.error.code}: docker compose did not return a formatted service list\n`
      );
      return 1;
    }
    throw read.error;
  }
  const entries = read.entries;
  // A Created service whose one-shot dependency is still running starts only
  // when it completes and a Compose client waits for it (HACK-2310).
  const psInterpolationEnv = await readComposeInterpolationEnv({
    composeFiles: [project.composeFile],
    env: process.env,
  });
  const waiting = waitingDependents({
    graph: await readComposeOneShotGraph([project.composeFile], {
      activeProfiles: effectiveComposeProfiles({
        cliProfiles: profiles,
        env: psInterpolationEnv,
      }),
      interpolationEnv: psInterpolationEnv,
      presentServices: new Set(
        entries.flatMap((entry) =>
          typeof entry.Service === "string" ? [entry.Service] : []
        )
      ),
    }),
    entries,
  });
  const remotes = projectRemoteStatuses(
    cfg.prerequisites?.config?.selected,
    await observedRemoteChoices(project, cfg, composeProjectName, entries)
  );
  if (json) {
    const payload = {
      project: baseProjectName,
      branch,
      composeProject: composeProjectName ?? baseProjectName,
      items: await annotateEmulatedPsItems({ items: entries }),
      waiting,
      ...(remotes.length > 0 ? { remotes } : {}),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  displayComposePs({
    entries,
    addresses,
    waiting,
    remotes,
    wide: args.options.wide === true,
  });
  return 0;
}

async function readProjectServiceAddresses(opts: {
  readonly project: Awaited<ReturnType<typeof resolveProjectForArgs>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly branch: string | null;
  readonly native: boolean;
}): Promise<ReadonlyMap<string, readonly string[]>> {
  const { project, cfg, branch } = opts;
  const devHost = await readProjectDevHost(project);
  const aliasHost = devHost ? resolveBranchAliasHost({ devHost, cfg }) : null;
  const composeYaml = await Bun.file(project.composeFile)
    .text()
    .catch(() => "");
  return composeServiceAddresses({
    composeYaml,
    branch,
    baseHosts: devHost
      ? resolveProjectRouteBaseHosts({ devHost, aliasHost })
      : [],
    httpsPort: opts.native
      ? await resolveNativeStatusHttpsPort({
          env: process.env,
          projectName: await resolveComposeProjectName({ project, cfg }),
          projectRoot: project.projectRoot,
        })
      : null,
  });
}

/**
 * Compose runs need the Compose operation; a native one-off instead carries its
 * `--env`/`--profile` request. Omitted options inherit the running selection;
 * an empty value was already refused by {@link refuseEmptyNativeRunSelection};
 * given options must match it exactly, which the native backend checks before
 * any runtime request (no implicit restart).
 */
function runBackendSelection(
  native: boolean,
  args: RunArgs
): NativeRunSelection | undefined {
  if (!native) {
    requireComposeOperationAvailable("run");
    return;
  }
  return {
    envName: resolveRequestedEnvName({ envOption: args.options.env }),
    profiles:
      args.options.profile === undefined
        ? undefined
        : parseCsvList(args.options.profile),
  };
}

/**
 * On the native backend an empty `--env` or `--profile` is a usage error before
 * any dispatch, so authored, adopted and legacy projects all refuse it with the
 * same E_USAGE line, not the authored path's broader
 * E_NATIVE_PROJECT_UNSUPPORTED. The Compose backend keeps its meaning: there
 * an empty `--env` selects the base layers.
 */
function refuseEmptyNativeRunSelection(args: RunArgs): void {
  if (process.env.HACK_RUNTIME_BACKEND !== "native") {
    return;
  }
  requireNonEmptyNativeRunOptions({
    env: args.options.env,
    profile: args.options.profile,
  });
}

async function handleRun({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: RunArgs;
}): Promise<number> {
  refuseEmptyNativeRunSelection(args);
  const background = parseBackgroundRequest(args.options);
  const authored = await startNativeBackgroundIfRequested({
    ctx,
    args,
    background,
    operation: "run",
    otherwise: () =>
      tryNativeComposeCommand({
        cwd: ctx.cwd,
        path: args.options.path,
        project: args.options.project,
        operation: "run",
        instance: args.options.branch,
        profiles: optionalCsvList(args.options.profile),
        overlay: args.options.env,
        service: args.positionals.service,
        command: args.positionals.cmd,
        workdir: args.options.workdir,
      }),
  });
  if (authored !== null) {
    return authored;
  }
  const native = resolveNativeRuntimeSelection();
  const selection = runBackendSelection(Boolean(native), args);
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
    touchRegistration: false,
  });
  const branch = await resolveEffectiveBranchForCommand({
    project,
    branchOption: args.options.branch,
    // run/exec pass the target command's stdout through; keep the worktree
    // notice on stderr so it never corrupts captured output.
    noticeToStderr: true,
  });
  if (native) {
    const result = await nativeProjectOneOff({
      runtime: native,
      scope: {
        projectRoot: project.projectRoot,
        projectDir: project.projectDir,
        nativeHome: native.home,
        branch,
      },
      service: args.positionals.service ?? "",
      argv: args.positionals.cmd,
      workdir: args.options.workdir,
      composeFile: project.composeFile,
      selection,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.truncated) {
      process.stderr.write("Native run output was truncated.\n");
    }
    return result.exitCode;
  }
  const requestedEnvName = resolveRequestedEnvName({
    envOption: args.options.env,
  });

  await recordBranchUsageIfNeeded({ project, branch });
  const service = (args.positionals.service ?? "").trim();
  if (service.length === 0) {
    throw new CliUsageError("Missing required argument: service");
  }

  const workdir = (args.options.workdir ?? "").trim();
  const profiles = parseCsvList(args.options.profile);
  const cmdArgs = args.positionals.cmd;

  const cfg = await readProjectConfig(project);
  refuseRemoteStart(cfg.prerequisites?.config?.selected, "hack run");
  if (
    !(await enforceProjectPrerequisites(
      cfg.prerequisites,
      background?.json === true,
      project.projectRoot,
      { composeFile: project.composeFile, services: [service] }
    ))
  ) {
    return 1;
  }
  const configRefusal = reviewRunConfig({ cfg, project });
  if (configRefusal !== null) {
    return configRefusal;
  }

  const baseProjectName = await resolveComposeProjectName({ project, cfg });
  const composeProjectName = branch ? `${baseProjectName}--${branch}` : null;
  const devHost = await resolveRuntimeDevHost({ project, branch });
  const aliasHost = resolveBranchAliasHost({ devHost, cfg });
  const internalOverride = await resolveInternalComposeOverride({
    project,
    cfg,
    branch,
    devHost,
    aliasHost,
    // A background run cannot retry, so it reads Docker once up front.
    addresses: runAddressMode(background),
  });
  const composeFiles = branch
    ? await resolveBranchComposeFiles({ project, branch, devHost, aliasHost })
    : [project.composeFile];
  const composeFilesWithInternal = internalOverride
    ? [...composeFiles, internalOverride]
    : composeFiles;
  const projectName = sanitizeProjectSlug(baseProjectName);
  const lifecycleComposeProject = resolveLifecycleComposeProjectName({
    projectName,
    branch,
  });
  // HACK-2280: with no --env, a one-off uses the overlay the instance runs
  // with, so it can reuse the running dependencies instead of starting them
  // under the configured default.
  const envName = await resolveStoredRuntimeEnvName({
    requestedEnvName,
    projectDir: project.projectDir,
    composeProject: lifecycleComposeProject,
  });
  const dependencyCache = await resolveDependencyCacheOverride({
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
    projectName,
    composeFile: project.composeFile,
  });
  reportDependencyCacheFallback(dependencyCache);
  const composeFilesWithRuntimeOverrides = await withProjectLocalDirectories({
    project,
    composeFiles: dependencyCache.overridePath
      ? [...composeFilesWithInternal, dependencyCache.overridePath]
      : composeFilesWithInternal,
  });
  const runtimeMetadataOverride = await resolveRuntimeHostMetadataOverride({
    project,
    composeFiles: composeFilesWithRuntimeOverrides,
    branch,
    devHost,
    aliasHost,
    composeProject: composeProjectName ?? baseProjectName,
  });

  const cacheBootstrapServices = await resolveDependencyCacheBootstrapServices({
    composeFile: project.composeFile,
    cache: dependencyCache,
    targetServices: [service],
  });
  const preparedServices = [...new Set([service, ...cacheBootstrapServices])];
  const allServiceNames = await readComposeServiceNames(project.composeFile);
  const envOverrides = await resolveComposeEnvOverrides({
    project,
    projectName,
    targetServices: preparedServices,
    allServiceNames,
    envName,
  });
  const composeFilesWithEnv = [
    ...composeFilesWithRuntimeOverrides,
    ...(runtimeMetadataOverride ? [runtimeMetadataOverride] : []),
    ...envOverrides.composeFiles,
  ];
  await assertRegistryCredentialsAvailable({
    projectRoot: project.projectRoot,
    composeFile: project.composeFile,
    targetServices: preparedServices,
    envByService: envOverrides.preflightEnvByService,
  });
  refuseDetachedCacheBootstrap({
    background,
    services: cacheBootstrapServices,
  });
  const bootstrapCode = await bootstrapDependencyCaches({
    services: cacheBootstrapServices,
    composeFiles: composeFilesWithEnv,
    composeProject: composeProjectName,
    profiles,
    cwd: dirname(project.composeFile),
    env: envOverrides.env,
  });
  if (bootstrapCode !== 0) {
    return bootstrapCode;
  }
  const stackIsRunning =
    !dependencyCache.sharingDisabledReason &&
    (await resolveCanSkipRunDependencies({
      composeFiles: composeFilesWithEnv,
      composeProjectKey: composeProjectName ?? baseProjectName,
      runtimeStateKey: lifecycleComposeProject,
      composeProject: composeProjectName,
      project,
      profiles,
      effectiveEnvName: envOverrides.effectiveEnvName,
      cacheVolumeNames: dependencyCache.volumes.map(
        (volume) => volume.resolvedName
      ),
      env: envOverrides.env,
      service,
    }));
  const runOptions = {
    composeFiles: composeFilesWithEnv,
    composeProject: composeProjectName,
    profiles,
    service,
    noDeps: stackIsRunning,
    workdir: workdir.length > 0 ? workdir : undefined,
    cmdArgs,
    cwd: dirname(project.composeFile),
    env: envOverrides.env,
  };
  const dispatch = async (): Promise<number> =>
    await runOrStartComposeCommand({
      background,
      project,
      branch,
      compose: { operation: "run", options: runOptions },
      callerOptions: args.options,
      envOverrides,
    });
  return await runAndRefreshStaleAddresses({
    dispatch,
    background,
    internalOverride,
    rebuild: async () =>
      await resolveInternalComposeOverride({
        project,
        cfg,
        branch,
        devHost,
        aliasHost,
        addresses: "fresh",
      }),
  });
}

function runAddressMode(background: unknown): "recorded" | "fresh" {
  return background ? "fresh" : "recorded";
}

/**
 * Runs a foreground one-off. When it fails, checks the recorded global
 * addresses it used against Docker once (see
 * {@link refreshStaleInternalOverride}). The command is never run again:
 * a changed address does not show that it never started, and a one-off can
 * have side effects (a migration) before it fails.
 */
async function runAndRefreshStaleAddresses(opts: {
  readonly dispatch: () => Promise<number>;
  readonly background: unknown;
  readonly internalOverride: string | null;
  readonly rebuild: () => Promise<string | null>;
}): Promise<number> {
  const exitCode = await opts.dispatch();
  if (exitCode === 0 || opts.background || opts.internalOverride === null) {
    return exitCode;
  }
  try {
    await refreshStaleInternalOverride(opts.rebuild);
  } catch (error) {
    // The command's own result stands; the refresh is only for the next one.
    // stderr: a run's stdout is the command's own output.
    process.stderr.write(
      `Hack: could not check the recorded proxy and DNS addresses after the command failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
  return exitCode;
}

/**
 * Reads the global addresses once from Docker when the failed run used
 * recorded ones. When they differ (the proxy or DNS container came back with
 * new addresses outside Hack), rewrites (or removes) the stored override and
 * says so on stderr, so the next command gets the current addresses.
 */
async function refreshStaleInternalOverride(
  rebuild: () => Promise<string | null>
): Promise<void> {
  const used = await resolveGlobalIngressAddresses("recorded");
  if (!used.fromRecord) {
    return;
  }
  const current = await resolveGlobalIngressAddresses("fresh");
  if (current.coreDns === used.coreDns && current.caddy === used.caddy) {
    return;
  }
  await rebuild();
  process.stderr.write(
    "Hack: the global proxy or DNS address changed since Hack recorded it, so this run may have used the old one. The internal override is updated; run the command again if the failure was a name or connection error.\n"
  );
}

/**
 * On the native backend an empty exec `--env` or `--profile` refuses before
 * any dispatch, as for run, so authored and legacy projects give the same
 * closed E_USAGE line. A non-empty value refuses later: legacy projects with
 * that same line, authored projects with their E_NATIVE_PROJECT_UNSUPPORTED.
 */
function refuseEmptyNativeExecSelection(args: ExecArgs): void {
  if (process.env.HACK_RUNTIME_BACKEND !== "native") {
    return;
  }
  requireNonEmptyNativeRunOptions({
    env: args.options.env,
    profile: args.options.profile,
    refusal: NATIVE_EXEC_SELECTION_REFUSAL,
  });
}

async function handleExec({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: ExecArgs;
}): Promise<number> {
  refuseEmptyNativeExecSelection(args);
  const background = parseBackgroundRequest(args.options);
  const authored = await startNativeBackgroundIfRequested({
    ctx,
    args,
    background,
    operation: "exec",
    otherwise: () =>
      tryNativeComposeCommand({
        cwd: ctx.cwd,
        path: args.options.path,
        project: args.options.project,
        operation: "exec",
        instance: args.options.branch,
        profiles: optionalCsvList(args.options.profile),
        overlay: args.options.env,
        service: args.positionals.service,
        command: args.positionals.cmd,
        workdir: args.options.workdir,
      }),
  });
  if (authored !== null) {
    return authored;
  }
  const native = resolveNativeRuntimeSelection();
  // Any given value refuses, an empty one included, with the same closed
  // E_USAGE line (no usage hint) as native run's selection refusals.
  if (
    native &&
    (args.options.env !== undefined || args.options.profile !== undefined)
  ) {
    throw new HackCliError({
      code: "E_USAGE",
      message: NATIVE_EXEC_SELECTION_REFUSAL,
    });
  }
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
    touchRegistration: false,
  });
  const branch = await resolveEffectiveBranchForCommand({
    project,
    branchOption: args.options.branch,
    // run/exec pass the target command's stdout through; keep the worktree
    // notice on stderr so it never corrupts captured output.
    noticeToStderr: true,
  });
  if (native) {
    return await runNativeProjectExec({
      runtime: native,
      scope: {
        projectRoot: project.projectRoot,
        projectDir: project.projectDir,
        nativeHome: native.home,
        branch,
      },
      service: args.positionals.service,
      argv: args.positionals.cmd,
      workdir: args.options.workdir,
      composeFile: project.composeFile,
    });
  }
  const requestedEnvName = resolveRequestedEnvName({
    envOption: args.options.env,
  });

  await recordBranchUsageIfNeeded({ project, branch });
  const service = (args.positionals.service ?? "").trim();
  if (service.length === 0) {
    throw new CliUsageError("Missing required argument: service");
  }

  const workdir = (args.options.workdir ?? "").trim();
  const profiles = parseCsvList(args.options.profile);
  const cmdArgs = args.positionals.cmd;
  if (cmdArgs.length === 0) {
    throw new CliUsageError("Command is required.");
  }

  const cfg = await readProjectConfig(project);
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile;
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`,
    });
  }

  const baseProjectName = await resolveComposeProjectName({ project, cfg });
  const composeProjectName = branch ? `${baseProjectName}--${branch}` : null;
  // The container already exists: DNS, host entries, trust and runtime
  // labels were applied when it was created, and Compose only needs the
  // service in its file list to find it. Pass the generated files `up` left
  // on disk; generate nothing and read no global address. A stored file that
  // still names a service the Compose file no longer has would make Compose
  // reject the whole model, so then regenerate them as before.
  const allServiceNames = await readComposeServiceNames(project.composeFile);
  const stored = await existingExecComposeFiles({ project, branch });
  const { composeFilesWithInternal, runtimeMetadataOverride } =
    (await generatedFilesMatchServices({
      files: stored.generated,
      serviceNames: allServiceNames,
    }))
      ? stored
      : await generateExecComposeFiles({
          project,
          cfg,
          branch,
          composeProject: composeProjectName ?? baseProjectName,
        });

  const projectName = sanitizeProjectSlug(baseProjectName);
  const lifecycleComposeProject = resolveLifecycleComposeProjectName({
    projectName,
    branch,
  });
  // HACK-2280: with no --env, exec into the overlay the instance runs with,
  // as down/restart do, instead of the configured default.
  const envName = await resolveStoredRuntimeEnvName({
    requestedEnvName,
    projectDir: project.projectDir,
    composeProject: lifecycleComposeProject,
  });
  const envOverrides = await resolveComposeEnvOverrides({
    project,
    projectName,
    targetServices: [service],
    allServiceNames,
    envName,
    persist: false,
  });
  const composeFilesWithEnv = [
    ...composeFilesWithInternal,
    ...(runtimeMetadataOverride ? [runtimeMetadataOverride] : []),
    ...envOverrides.composeFiles,
  ];
  const readiness = {
    composeFiles: composeFilesWithEnv,
    composeProjectKey: lifecycleComposeProject,
    composeProject: composeProjectName,
    project,
    profiles,
    effectiveEnvName: envOverrides.effectiveEnvName,
    branchOption: args.options.branch,
    service,
    env: envOverrides.env,
  };
  await requireExecTargetReady({ readiness, background: background !== null });
  // exec stdout is the target command's output; keep the warning on stderr.
  const staleEnvWarning = await resolveComposeExecStaleEnvWarning({
    projectDir: project.projectDir,
    composeProject: lifecycleComposeProject,
    service,
    currentEnv: envOverrides.preflightEnvByService[service] ?? {},
  });
  if (staleEnvWarning) {
    process.stderr.write(`WARNING: ${staleEnvWarning}\n`);
  }

  const execOptions = {
    composeFiles: composeFilesWithEnv,
    composeProject: composeProjectName,
    profiles,
    service,
    workdir: workdir.length > 0 ? workdir : undefined,
    cmdArgs,
    cwd: dirname(project.composeFile),
    env: envOverrides.env,
  };
  const exitCode = await runOrStartComposeCommand({
    background,
    project,
    branch,
    compose: { operation: "exec", options: execOptions },
    callerOptions: args.options,
    envOverrides,
  });
  await explainRefusedForegroundExec({
    exitCode,
    readiness,
    background: background !== null,
  });
  return exitCode;
}

async function answerExistingBackgroundRequest(opts: {
  readonly ctx: CliContext;
  readonly args: RunArgs;
  readonly background: NonNullable<ReturnType<typeof parseBackgroundRequest>>;
  readonly operation: "exec" | "run";
}): Promise<number | null> {
  if (opts.background.requestKey === null) {
    return null;
  }
  const { args } = opts;
  const project = await resolveProjectForArgs({
    ctx: opts.ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
    touchRegistration: false,
  });
  return await answerExistingRequest({
    request: opts.background,
    projectRoot: project.projectRoot,
    identity: callerIdentity({
      request: opts.background,
      operation: opts.operation,
      projectRoot: project.projectRoot,
      branch: await resolveEffectiveBranchForCommand({
        project,
        branchOption: args.options.branch,
        noticeToStderr: true,
      }),
      service: args.positionals.service ?? "",
      cmdArgs: args.positionals.cmd,
      options: args.options,
    }),
  });
}

/**
 * `--detach` on the native backend: the supervisor runs this same CLI in the
 * foreground (see background-command-start.ts). Otherwise runs `otherwise`.
 */
async function startNativeBackgroundIfRequested(opts: {
  readonly ctx: CliContext;
  readonly args: RunArgs;
  readonly background: ReturnType<typeof parseBackgroundRequest>;
  readonly operation: "exec" | "run";
  /** The ordinary authored/adopted dispatch, run when this does not apply. */
  readonly otherwise: () => Promise<number | null>;
}): Promise<number | null> {
  if (!opts.background) {
    return await opts.otherwise();
  }
  // Background start prints only the command id (or `--json` envelope) on
  // stdout; Hack's own notices go to stderr.
  setLoggerBackendOverride({ backend: "console" });
  const { args } = opts;
  await refuseDetachForAuthoredProject({
    cwd: opts.ctx.cwd,
    path: args.options.path,
    project: args.options.project,
  });
  // A retried request key is answered before any runtime check, so a retry
  // finds its command even if the service has stopped since.
  const existing = await answerExistingBackgroundRequest({
    ctx: opts.ctx,
    args,
    background: opts.background,
    operation: opts.operation,
  });
  if (existing !== null) {
    return existing;
  }
  if (process.env.HACK_RUNTIME_BACKEND !== "native") {
    return await opts.otherwise();
  }
  // The synchronous refusals of the foreground native command, before any
  // acceptance: runtime selection, then exec's env/profile refusal or run's
  // selection parsing.
  const native = resolveNativeRuntimeSelection();
  if (
    opts.operation === "exec" &&
    (args.options.env !== undefined || args.options.profile !== undefined)
  ) {
    throw new HackCliError({
      code: "E_USAGE",
      message: NATIVE_EXEC_SELECTION_REFUSAL,
    });
  }
  if (opts.operation === "run") {
    runBackendSelection(Boolean(native), args);
  }
  const project = await resolveProjectForArgs({
    ctx: opts.ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
    touchRegistration: false,
  });
  const service = (args.positionals.service ?? "").trim();
  if (service.length === 0) {
    throw new CliUsageError("Missing required argument: service");
  }
  if (opts.operation === "exec" && args.positionals.cmd.length === 0) {
    throw new CliUsageError("Command is required.");
  }
  return await startNativeBackgroundCommand({
    request: opts.background,
    operation: opts.operation,
    project,
    branch: await resolveEffectiveBranchForCommand({
      project,
      branchOption: args.options.branch,
      noticeToStderr: true,
    }),
    cwd: opts.ctx.cwd,
    service,
    cmdArgs: args.positionals.cmd,
    options: args.options,
  });
}

function reportDependencyCacheFallback(cache: {
  readonly sharingDisabledReason?: string;
}): void {
  if (cache.sharingDisabledReason) {
    logger.warn({
      message:
        "Shared dependency cache disabled: installer image/build inputs and platform must be explicit and resolved. Using the original Compose volume configuration.",
    });
  }
}

async function resolveCanSkipRunDependencies(opts: {
  readonly composeFiles: readonly string[];
  /** The Compose project label the running containers carry. */
  readonly composeProjectKey: string;
  /** The instance's runtime-state key (the lifecycle compose project). */
  readonly runtimeStateKey: string;
  readonly composeProject: string | null;
  readonly profiles: readonly string[];
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly effectiveEnvName: string | null;
  readonly service: string;
  readonly cacheVolumeNames: readonly string[];
  readonly env?: Record<string, string>;
}): Promise<boolean> {
  const runtimeState = await readProjectRuntimeStateEntry({
    projectDir: opts.project.projectDir,
    composeProject: opts.runtimeStateKey,
  });
  if (runtimeState && runtimeState.envName !== opts.effectiveEnvName) {
    return false;
  }

  const psResult = await composeRuntimeBackend.psJson({
    composeFiles: opts.composeFiles,
    composeProject: opts.composeProject,
    profiles: opts.profiles,
    cwd: dirname(opts.project.composeFile),
    env: opts.env,
  });
  if (psResult.exitCode !== 0) {
    return false;
  }

  const runningServices = parseJsonLines(psResult.stdout);
  const runningTarget = runningServices.find((entry) => {
    const service = getString(entry, "Service")?.trim();
    const state = getString(entry, "State")?.trim().toLowerCase();
    return service === opts.service && state === "running";
  });
  return (
    runningTarget !== undefined &&
    (await canReuseRunningDependencyCache({
      containerId: getString(runningTarget, "ID"),
      composeProject: opts.composeProjectKey,
      service: opts.service,
      volumeNames: opts.cacheVolumeNames,
      cwd: dirname(opts.project.composeFile),
      env: opts.env,
    }))
  );
}

/**
 * The generated Compose files an instance's `up` wrote, as far as they exist,
 * in `up`'s order: the branch override, the internal override (stored, else
 * the in-project file of an older Hack), the runtime metadata override.
 */
async function existingExecComposeFiles(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly branch: string | null;
}): Promise<ExecComposeFiles & { readonly generated: readonly string[] }> {
  const { project, branch } = opts;
  const branchOverride = branch
    ? resolve(project.projectDir, ".branch", `compose.${branch}.override.yml`)
    : null;
  const runtimeOverride = branch
    ? resolve(
        project.projectDir,
        ".branch",
        `compose.${branch}.runtime.override.yml`
      )
    : resolve(project.projectDir, ".internal", "compose.runtime.override.yml");
  const [hasBranchOverride, internalOverride, hasRuntimeOverride] =
    await Promise.all([
      branchOverride ? pathExists(branchOverride) : false,
      existingInternalOverride({
        hackHome: resolveGlobalHackDir(),
        projectDir: project.projectDir,
        branch,
      }),
      pathExists(runtimeOverride),
    ]);
  const generated = [
    ...(hasBranchOverride && branchOverride ? [branchOverride] : []),
    ...(internalOverride ? [internalOverride] : []),
  ];
  return {
    composeFilesWithInternal: [project.composeFile, ...generated],
    runtimeMetadataOverride: hasRuntimeOverride ? runtimeOverride : null,
    generated: [...generated, ...(hasRuntimeOverride ? [runtimeOverride] : [])],
  };
}

interface ExecComposeFiles {
  readonly composeFilesWithInternal: readonly string[];
  readonly runtimeMetadataOverride: string | null;
}

/**
 * True when every service the generated `files` declare is still in
 * `serviceNames` (the Compose file's). A local YAML read, no Docker call.
 */
async function generatedFilesMatchServices(opts: {
  readonly files: readonly string[];
  readonly serviceNames: readonly string[];
}): Promise<boolean> {
  const known = new Set(opts.serviceNames);
  const declared = await Promise.all(opts.files.map(readComposeServiceNames));
  return declared.every((names) => names.every((name) => known.has(name)));
}

/** Renders the generated Compose files against the current graph, as `up` does. */
async function generateExecComposeFiles(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
  readonly branch: string | null;
  readonly composeProject: string;
}): Promise<ExecComposeFiles> {
  const { project, cfg, branch } = opts;
  const devHost = await resolveRuntimeDevHost({ project, branch });
  const aliasHost = resolveBranchAliasHost({ devHost, cfg });
  const internalOverride = await resolveInternalComposeOverride({
    project,
    cfg,
    branch,
    devHost,
    aliasHost,
    // The container exists; its addresses were applied when it was created.
    addresses: "recorded",
  });
  const composeFiles = branch
    ? await resolveBranchComposeFiles({ project, branch, devHost, aliasHost })
    : [project.composeFile];
  const composeFilesWithInternal = internalOverride
    ? [...composeFiles, internalOverride]
    : composeFiles;
  const runtimeMetadataOverride = await resolveRuntimeHostMetadataOverride({
    project,
    composeFiles: composeFilesWithInternal,
    branch,
    devHost,
    aliasHost,
    composeProject: opts.composeProject,
  });
  return { composeFilesWithInternal, runtimeMetadataOverride };
}

/** Exit code of `docker compose exec` when the service is not running. */
const COMPOSE_EXEC_REFUSED_EXIT_CODE = 1;

interface ExecReadinessOptions {
  readonly composeFiles: readonly string[];
  readonly composeProjectKey: string;
  readonly composeProject: string | null;
  readonly profiles: readonly string[];
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly effectiveEnvName: string | null;
  readonly branchOption?: string | undefined;
  readonly service: string;
  /**
   * The Compose env, including the `HACK_ENV_*` values the env override
   * references. `ps` does not use them, but without them Compose warns once
   * per unset reference.
   */
  readonly env?: Record<string, string>;
}

/**
 * A background exec refuses before its supervisor starts. A foreground exec
 * checks only the env overlay (a state file read) up front: Compose itself
 * refuses a stopped service, and {@link explainRefusedForegroundExec} adds
 * the hint after that exit, so a ready service costs no `compose ps`.
 */
async function requireExecTargetReady(opts: {
  readonly readiness: ExecReadinessOptions;
  readonly background: boolean;
}): Promise<void> {
  const message = await resolveExecEnvMismatch(opts.readiness);
  if (message !== null) {
    throw new CliUsageError(message);
  }
  if (opts.background) {
    await requireExecTargetRunning(opts.readiness);
  }
}

/**
 * After a foreground `compose exec` exits with Compose's refusal code, throws
 * the usage error naming `hack up -d` and `hack run` when the service is not
 * running, or the read's coded error (an unreachable engine, a failed
 * Compose) when the listing cannot be read. A command that itself exited 1 in
 * a running service gets nothing added.
 */
async function explainRefusedForegroundExec(opts: {
  readonly exitCode: number;
  readonly readiness: ExecReadinessOptions;
  readonly background: boolean;
}): Promise<void> {
  if (opts.background || opts.exitCode !== COMPOSE_EXEC_REFUSED_EXIT_CODE) {
    return;
  }
  // A stopped service gets the `hack up -d` / `hack run` hint; an engine that
  // cannot be reached gets its coded cause, as `hack ps` reports it.
  await requireExecTargetRunning(opts.readiness);
}

/** The refusal when the instance runs another env overlay; no Docker read. */
async function resolveExecEnvMismatch(
  opts: ExecReadinessOptions
): Promise<string | null> {
  const runtimeState = await readProjectRuntimeStateEntry({
    projectDir: opts.project.projectDir,
    composeProject: opts.composeProjectKey,
  });
  // Reached only with an explicit --env: an omitted one already resolved to
  // the running selection.
  if (runtimeState && runtimeState.envName !== opts.effectiveEnvName) {
    return buildRunningEnvMismatchMessage({
      command: "exec",
      runningEnvName: runtimeState.envName,
      requestedEnvName: opts.effectiveEnvName,
      branchOption: opts.branchOption,
    });
  }
  return null;
}

/**
 * Throws a usage error naming `hack up -d` and `hack run` when the target
 * service is not running; an engine or Compose failure keeps its own code.
 */
async function requireExecTargetRunning(
  opts: ExecReadinessOptions
): Promise<void> {
  const read = await readComposePs({
    run: () =>
      composeRuntimeBackend.psJson({
        composeFiles: opts.composeFiles,
        composeProject: opts.composeProject,
        profiles: opts.profiles,
        cwd: dirname(opts.project.composeFile),
        env: opts.env,
      }),
    redactValues: composeEnvValuesToRedact({ env: opts.env }),
  });
  if (!read.ok) {
    throw read.error;
  }

  const targetIsRunning = read.entries.some((entry) => {
    const service = getString(entry, "Service")?.trim();
    const state = getString(entry, "State")?.trim().toLowerCase();
    return service === opts.service && state === "running";
  });
  if (!targetIsRunning) {
    throw new CliUsageError(
      `Service "${opts.service}" is not running. Start the stack with \`hack up -d\` or use \`hack run ${opts.service} ...\` for a one-off container.`
    );
  }
}

function computeWantsLokiExplicit(opts: {
  readonly options: {
    readonly loki: boolean | undefined;
    readonly query: string | undefined;
    readonly since: string | undefined;
    readonly until: string | undefined;
  };
}): boolean {
  return (
    opts.options.loki === true ||
    opts.options.query !== undefined ||
    opts.options.since !== undefined ||
    opts.options.until !== undefined
  );
}

function validateLogsArgs(opts: {
  readonly forceCompose: boolean;
  readonly wantsLokiExplicit: boolean;
  readonly json: boolean;
  readonly pretty: boolean | undefined;
  readonly follow: boolean;
  readonly timeRange: ReturnType<typeof parseLogTimeRange>;
  readonly maxLineBytes: number | undefined;
}): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (opts.forceCompose && opts.wantsLokiExplicit) {
    return {
      ok: false,
      message: "Cannot combine --compose with --loki/--query/--since/--until.",
    };
  }
  const maxLineBytes = validateMaxLineBytes({
    value: opts.maxLineBytes,
    json: opts.json,
  });
  if (!maxLineBytes.ok) {
    return maxLineBytes;
  }
  if (opts.json && opts.pretty) {
    return { ok: false, message: "Cannot combine --json with --pretty." };
  }
  if (opts.timeRange.error) {
    return { ok: false, message: opts.timeRange.error };
  }
  if (opts.follow && opts.timeRange.end) {
    return { ok: false, message: "Cannot combine --until with --follow." };
  }

  return { ok: true };
}

/**
 * `--max-line-bytes` bounds JSON entries only, so it requires `--json`, and it
 * must be a whole number of bytes from 1 to {@link MAX_LINE_BYTES_LIMIT}.
 */
function validateMaxLineBytes(opts: {
  readonly value: number | undefined;
  readonly json: boolean;
}): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (opts.value === undefined) {
    return { ok: true };
  }
  if (!opts.json) {
    return { ok: false, message: "--max-line-bytes requires --json." };
  }
  if (
    !Number.isSafeInteger(opts.value) ||
    opts.value < 1 ||
    opts.value > MAX_LINE_BYTES_LIMIT
  ) {
    return {
      ok: false,
      message: `--max-line-bytes requires a whole number from 1 to ${MAX_LINE_BYTES_LIMIT}.`,
    };
  }
  return { ok: true };
}

/** `--services` plus the positional service, deduplicated in that order. */
function resolveRequestedServices(opts: {
  readonly servicesOpt: readonly string[];
  readonly positionalService: string | undefined;
}): string[] {
  const serviceFromPositional = (opts.positionalService ?? "").trim();
  if (serviceFromPositional.length === 0) {
    return [...opts.servicesOpt];
  }
  if (opts.servicesOpt.includes(serviceFromPositional)) {
    return [...opts.servicesOpt];
  }
  return [...opts.servicesOpt, serviceFromPositional];
}

function buildLogStreamContext(opts: {
  readonly json: boolean;
  readonly backend: "loki" | "compose";
  readonly projectNameForPrefix: string;
  readonly branch: string | null;
  readonly services: readonly string[] | undefined;
  readonly follow: boolean;
  readonly since: string | undefined;
  readonly until: string | undefined;
  readonly maxLineBytes: number | undefined;
}): LogStreamContext | undefined {
  if (!opts.json) {
    return undefined;
  }

  return {
    backend: opts.backend,
    project:
      opts.projectNameForPrefix.length > 0
        ? opts.projectNameForPrefix
        : undefined,
    branch: opts.branch ?? undefined,
    services:
      opts.services && opts.services.length > 0
        ? [...opts.services]
        : undefined,
    follow: opts.follow,
    since: opts.since,
    until: opts.until,
    maxLineBytes: opts.maxLineBytes,
  };
}

function resolveLokiQuery(opts: {
  readonly queryOpt: string | undefined;
  readonly projectNameForPrefix: string;
  readonly services: readonly string[];
}): string {
  const queryRaw = (opts.queryOpt ?? "").trim();
  if (queryRaw.length > 0) {
    return queryRaw;
  }

  return buildLogSelector({
    project:
      opts.projectNameForPrefix.length > 0 ? opts.projectNameForPrefix : null,
    services: [...opts.services],
  });
}

/**
 * Whether `hack logs` can use Loki. The local logging stack is opt-in: with
 * it off there is nothing to probe, and the logs come from the containers. A
 * Loki named by `HACK_LOKI_URL` is the user's own, so the setting does not
 * apply to it.
 */
/**
 * The backend for `hack logs`. With the opt-in logging stack off, a request
 * that only asks for a time range (`--since`/`--until`) reads container logs,
 * which take both; `--loki` and `--query` still need Loki and say so.
 */
async function decideLogsBackend(opts: {
  readonly shouldTryLoki: boolean;
  readonly baseUrl: string;
  readonly forceCompose: boolean;
  readonly wantsLokiExplicit: boolean;
  readonly onlyTimeRange: boolean;
}): Promise<{
  readonly loggingOff: boolean;
  readonly lokiReachable: boolean;
  readonly useLoki: boolean;
}> {
  const availability = await resolveLokiAvailability(opts);
  const useLoki =
    resolveUseLoki({ ...opts, lokiReachable: availability.lokiReachable }) &&
    !(availability.loggingOff && opts.onlyTimeRange);
  return { ...availability, useLoki };
}

async function resolveLokiAvailability(opts: {
  readonly shouldTryLoki: boolean;
  readonly baseUrl: string;
}): Promise<{ readonly loggingOff: boolean; readonly lokiReachable: boolean }> {
  if (!opts.shouldTryLoki) {
    return { loggingOff: false, lokiReachable: false };
  }
  if (
    process.env.HACK_LOKI_URL === undefined &&
    !(await resolveGlobalLoggingForHome()).enabled
  ) {
    return { loggingOff: true, lokiReachable: false };
  }
  return {
    loggingOff: false,
    lokiReachable: await lokiLogBackend.isAvailable({ baseUrl: opts.baseUrl }),
  };
}

async function runLogsWithLoki(opts: {
  readonly baseUrl: string;
  readonly lokiReachable: boolean;
  /** The global logging stack is turned off (it is opt-in). */
  readonly loggingOff: boolean;
  readonly projectNameForPrefix: string;
  readonly branch: string | null;
  readonly json: boolean;
  readonly follow: boolean;
  readonly tail: number;
  readonly format: ReturnType<typeof resolveLogFormat>;
  readonly timeRange: ReturnType<typeof parseLogTimeRange>;
  readonly servicesOpt: string | undefined;
  readonly positionalService: string | undefined;
  readonly queryOpt: string | undefined;
  readonly since: string | undefined;
  readonly until: string | undefined;
  readonly wantsLokiExplicit: boolean;
  readonly maxLineBytes: number | undefined;
  /** Project selection repeated in suggested `hack logs --compose` commands. */
  readonly target: LogsCommandTarget;
  /** `--tail` as passed; undefined when the user left the default. */
  readonly tailOpt: number | undefined;
  readonly profiles: readonly string[];
  readonly pretty: boolean;
  /** Compose snapshot used when an implicit Loki snapshot comes back empty. */
  readonly runCompose: () => Promise<number>;
}): Promise<number> {
  if (isSlimExecutionMode()) {
    process.stderr.write(
      `${renderSlimModeUnavailableMessage({
        feature: "Loki-backed project logs",
        alternative:
          "Use `hack logs --compose` when a Docker-backed compose runtime is available.",
      })}\n`
    );
    return 1;
  }

  if (opts.loggingOff) {
    // Thrown so that `--json` gets the `{ ok: false }` envelope.
    throw new HackCliError({
      code: LOGGING_OFF_CODE,
      message: `${renderLoggingOffMessage({ feature: "Loki-backed logs (--loki, --query)" })}. Plain \`hack logs\` (with or without --since/--until) reads container logs without it.`,
    });
  }
  if (!opts.lokiReachable) {
    process.stderr.write(`Loki is not reachable at ${opts.baseUrl}.\n`);
    process.stderr.write(
      "Tip: run `hack global install` (or `hack global up`) and ensure Loki is reachable.\n"
    );
    return 1;
  }

  const services = resolveRequestedServices({
    servicesOpt: parseCsvList(opts.servicesOpt),
    positionalService: opts.positionalService,
  });

  const streamContext = buildLogStreamContext({
    json: opts.json,
    backend: "loki",
    projectNameForPrefix: opts.projectNameForPrefix,
    branch: opts.branch,
    services,
    follow: opts.follow,
    since: opts.since,
    until: opts.until,
    maxLineBytes: opts.maxLineBytes,
  });

  const query = resolveLokiQuery({
    queryOpt: opts.queryOpt,
    projectNameForPrefix: opts.projectNameForPrefix,
    services,
  });
  // Every selector the user passed, so an empty-result hint suggests the same
  // selection on the compose backend (HACK-1379).
  const selectors: LogsCommandSelectors = {
    services,
    tail: opts.tailOpt,
    profiles: opts.profiles,
    pretty: opts.pretty,
    json: opts.json,
    query: opts.queryOpt,
    since: opts.since,
    until: opts.until,
  };

  const lokiOptions = {
    baseUrl: opts.baseUrl,
    query,
    tail: opts.tail,
    format: opts.format,
    showProjectPrefix: true,
    streamContext,
    start: opts.timeRange.start ?? undefined,
    end: opts.timeRange.end ?? undefined,
  };
  if (opts.follow) {
    return await lokiLogBackend.run({
      ...lokiOptions,
      follow: true,
      noEntriesNotice: {
        afterMs: LOKI_FOLLOW_EMPTY_NOTICE_DELAY_MS,
        notify: () => {
          process.stderr.write(
            `${renderEmptyLokiFollowNotice({
              query,
              target: opts.target,
              selectors,
            })}\n`
          );
        },
      },
    });
  }

  return await runLokiSnapshotWithFallback({
    wantsLokiExplicit: opts.wantsLokiExplicit,
    query,
    target: opts.target,
    selectors,
    runLoki: async ({ deferEmpty }) =>
      await lokiLogBackend.snapshot({ ...lokiOptions, deferEmpty }),
    runCompose: opts.runCompose,
    writeNotice: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });
}

async function runLogsWithCompose(opts: {
  readonly project: Awaited<ReturnType<typeof requireProjectContext>>;
  readonly projectNameForPrefix: string;
  readonly composeProject: string | undefined;
  readonly branch: string | null;
  readonly json: boolean;
  readonly follow: boolean;
  readonly tail: number;
  /** Requested services; empty reads every service. */
  readonly services: readonly string[];
  readonly profiles: readonly string[];
  readonly format: ReturnType<typeof resolveLogFormat>;
  readonly since: string | undefined;
  readonly until: string | undefined;
  readonly maxLineBytes: number | undefined;
}): Promise<number> {
  const lifecycleComposeProject =
    opts.composeProject ?? opts.projectNameForPrefix;
  const selection = await resolveLifecycleLogCompanion({
    projectDir: opts.project.projectDir,
    composeProject: lifecycleComposeProject,
    services: opts.services,
    follow: opts.follow,
  });
  const streamContext = buildLogStreamContext({
    json: opts.json,
    backend: "compose",
    projectNameForPrefix: opts.projectNameForPrefix,
    branch: opts.branch,
    services: opts.services,
    follow: opts.follow,
    since: opts.since,
    until: opts.until,
    maxLineBytes: opts.maxLineBytes,
  });

  return await composeLogBackend.run({
    composeFile: opts.project.composeFile,
    cwd: dirname(opts.project.composeFile),
    follow: opts.follow,
    tail: opts.tail,
    services: selection.composeServices,
    projectName:
      opts.projectNameForPrefix.length > 0
        ? opts.projectNameForPrefix
        : undefined,
    composeProject: opts.composeProject,
    profiles: opts.profiles,
    since: opts.since,
    until: opts.until,
    format: opts.format,
    streamContext,
    lifecycle: selection.lifecycle,
  });
}

/**
 * Split requested services between `docker compose logs` and the lifecycle log
 * that persistent `hack up` processes write.
 *
 * - A persistent lifecycle process is read from the lifecycle log only.
 * - A Compose service is read from Compose (and the lifecycle log, if any).
 * - A name that is neither is passed to Compose, which refuses it, unless a
 *   lifecycle log exists or is being followed; then only that log is read.
 *
 * With no requested service, Compose reads every service and the lifecycle
 * log is included when it exists, has state, or is followed. Compose is
 * disabled only when services were requested and none of them is for Compose.
 */
async function resolveLifecycleLogCompanion(opts: {
  readonly projectDir: string;
  readonly composeProject: string;
  readonly services: readonly string[];
  readonly follow: boolean;
}): Promise<{
  readonly composeServices: readonly string[];
  readonly lifecycle:
    | {
        readonly logPath: string;
        readonly services?: readonly string[];
        readonly composeDisabled?: boolean;
      }
    | undefined;
}> {
  const logPath = resolveLifecycleLogPath({
    projectDir: opts.projectDir,
    composeProject: opts.composeProject,
  });
  const state = await readLifecycleState({ projectDir: opts.projectDir });
  const entry =
    state.find((item) => item.composeProject === opts.composeProject) ?? null;
  const hasLogFile = await pathExists(logPath);
  const lifecycleAvailable = Boolean(entry) || hasLogFile || opts.follow;

  if (opts.services.length === 0) {
    return {
      composeServices: [],
      lifecycle: lifecycleAvailable ? { logPath } : undefined,
    };
  }

  const persistentServices = new Set(
    (entry?.processes ?? []).map((process) => process.name)
  );
  const composeNames = new Set(
    await readComposeServiceNames(
      resolve(opts.projectDir, PROJECT_COMPOSE_FILENAME)
    )
  );
  const composeServices = opts.services.filter(
    (service) =>
      !persistentServices.has(service) &&
      (composeNames.has(service) || !lifecycleAvailable)
  );
  const hasPersistent = opts.services.some((service) =>
    persistentServices.has(service)
  );
  if (!(hasPersistent || lifecycleAvailable)) {
    return { composeServices, lifecycle: undefined };
  }
  return {
    composeServices,
    lifecycle: {
      logPath,
      services: [...opts.services],
      ...(composeServices.length === 0 ? { composeDisabled: true } : {}),
    },
  };
}

async function handleNativeLogs({
  args,
  project,
  branch,
  native,
}: {
  readonly args: LogsArgs;
  readonly project: Awaited<ReturnType<typeof resolveProjectForArgs>>;
  readonly branch: string | null;
  readonly native: NonNullable<
    ReturnType<typeof resolveNativeRuntimeSelection>
  >;
}): Promise<number> {
  const json = args.options.json === true;
  const service = args.positionals.service;
  const tail = args.options.tail ?? 200;
  assertNativeLogFlags(args.options);
  const follow = !args.options.noFollow;
  const scope = {
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
    nativeHome: native.home,
    branch,
  };
  if (follow) {
    const followService = (input: {
      readonly service: string;
      readonly stdout?: Writable;
      readonly stderr?: Writable;
    }) =>
      followNativeProjectLogs({
        runtime: native,
        scope,
        service: input.service,
        tail,
        since: args.options.since,
        timestamps: args.options.timestamps,
        json,
        project: args.options.project,
        stdout: input.stdout,
        stderr: input.stderr,
      });
    if (service) {
      return await followService({ service });
    }
    // No service: follow every service, as Compose does.
    return await followAllNativeServices({
      services: await nativeProjectLogServices({ runtime: native, scope }),
      json,
      follow: followService,
    });
  }
  if (!service) {
    return writeNativeAllLogs({
      result: await nativeProjectAllLogs({ runtime: native, scope, tail }),
      json,
    });
  }
  const result = await nativeProjectLogs({
    runtime: native,
    scope,
    service,
    tail,
    follow,
  });
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stderr.write(
      `Native logs: ${result.service}${result.truncated ? " (truncated; older lines omitted)" : ""}\n`
    );
    // Engine order interleaves the streams by time; each keeps its own descriptor.
    for (const line of result.lines) {
      (line.stream === "stdout" ? process.stdout : process.stderr).write(
        line.text
      );
    }
  }
  return 0;
}

/**
 * Prints every service's native log snapshot. Text output prefixes each line
 * with its service, Compose-style, keeping each line on its own stream; JSON
 * is one object with a `services` array.
 */
function writeNativeAllLogs(opts: {
  readonly result: Awaited<ReturnType<typeof nativeProjectAllLogs>>;
  readonly json: boolean;
}): number {
  const { result } = opts;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  const truncated = result.services
    .filter((entry) => entry.truncated)
    .map((entry) => entry.service);
  process.stderr.write(
    `Native logs: all services${truncated.length ? ` (truncated; older lines omitted for ${truncated.join(", ")})` : ""}\n`
  );
  const width = Math.max(0, ...result.services.map((e) => e.service.length));
  for (const entry of result.services) {
    const prefix = nativeLogPrefix({ service: entry.service, width });
    for (const line of entry.lines) {
      const text = line.text.endsWith("\n") ? line.text : `${line.text}\n`;
      const prefixed = text
        .slice(0, -1)
        .split("\n")
        .map((part) => `${prefix}${part}\n`)
        .join("");
      (line.stream === "stdout" ? process.stdout : process.stderr).write(
        prefixed
      );
    }
  }
  if (result.skipped.length > 0) {
    process.stderr.write(
      `No container to read for: ${result.skipped.join(", ")}.\n`
    );
  }
  return 0;
}

function logsHaveUnsupportedNativeOptions(
  options: LogsArgs["options"]
): boolean {
  if (process.env.HACK_RUNTIME_BACKEND === "native") {
    return Boolean(
      options.loki ||
        options.compose ||
        options.pretty ||
        options.query !== undefined ||
        options.services !== undefined ||
        options.maxLineBytes !== undefined ||
        options.until !== undefined ||
        (options.follow && options.noFollow)
    );
  }
  return Boolean(
    options.loki ||
      options.query ||
      options.services ||
      options.maxLineBytes !== undefined ||
      options.since ||
      options.until
  );
}

async function handleLogs({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: LogsArgs;
}): Promise<number> {
  if (process.env.HACK_RUNTIME_BACKEND === "native") {
    assertNativeLogFlags(args.options);
  }
  if (
    process.env.HACK_RUNTIME_BACKEND !== "native" &&
    args.options.timestamps
  ) {
    throw new CliUsageError("--timestamps currently requires native --follow.");
  }
  const authored = await tryNativeComposeCommand({
    cwd: ctx.cwd,
    path: args.options.path,
    project: args.options.project,
    operation: "logs",
    instance: args.options.branch,
    profiles:
      args.options.profile === undefined
        ? undefined
        : parseCsvList(args.options.profile),
    service: args.positionals.service,
    json: args.options.json,
    follow: !args.options.noFollow,
    tail: args.options.tail,
    since: args.options.since,
    timestamps: args.options.timestamps,
    logFormat: resolveLogFormat({
      json: args.options.json,
      pretty: args.options.pretty,
    }),
    unsupportedOptions: logsHaveUnsupportedNativeOptions(args.options),
  });
  if (authored !== null) {
    return authored;
  }
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
    touchRegistration: false,
  });
  const json = args.options.json === true;
  const branch = await resolveEffectiveBranchForCommand({
    project,
    branchOption: args.options.branch,
    noticeToStderr: json,
  });
  const follow = !args.options.noFollow;
  const tail = args.options.tail ?? 200;
  const service = args.positionals.service;
  const native = resolveNativeRuntimeSelection();
  if (native) {
    return await handleNativeLogs({ args, project, branch, native });
  }
  const profiles = parseCsvList(args.options.profile);
  const format = resolveLogFormat({ json, pretty: args.options.pretty });
  const timeRange = parseLogTimeRange({
    since: args.options.since,
    until: args.options.until,
  });

  const wantsLokiExplicit = computeWantsLokiExplicit({ options: args.options });
  const validation = validateLogsArgs({
    forceCompose: args.options.compose === true,
    wantsLokiExplicit,
    json,
    pretty: args.options.pretty,
    follow,
    timeRange,
    maxLineBytes: args.options.maxLineBytes,
  });
  if (!validation.ok) {
    // Thrown so that `--json` refusals use the `{ ok: false }` envelope.
    throw new CliUsageError(validation.message);
  }
  const services = resolveRequestedServices({
    servicesOpt: parseCsvList(args.options.services),
    positionalService: typeof service === "string" ? service : undefined,
  });
  const baseUrl = lokiBaseUrl();
  const cfg = await readProjectConfig(project);
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile;
    logger.warn({
      message: `Failed to parse ${configPath}: ${cfg.parseError}`,
    });
  }
  const baseProjectName = await resolveComposeProjectName({ project, cfg });
  const projectNameForPrefix = branch
    ? `${baseProjectName}--${branch}`
    : baseProjectName;
  const followBackend = cfg.logs?.followBackend ?? "compose";
  const snapshotBackend = cfg.logs?.snapshotBackend ?? "loki";

  const shouldTryLoki = resolveShouldTryLoki({
    forceCompose: args.options.compose === true,
    wantsLokiExplicit,
    follow,
    followBackend,
    snapshotBackend,
  });

  const { loggingOff, lokiReachable, useLoki } = await decideLogsBackend({
    shouldTryLoki,
    baseUrl,
    forceCompose: args.options.compose === true,
    wantsLokiExplicit,
    // --since/--until alone can be served from container logs.
    onlyTimeRange:
      args.options.loki !== true && args.options.query === undefined,
  });

  const runCompose = async (): Promise<number> =>
    await runLogsWithCompose({
      project,
      projectNameForPrefix,
      composeProject: branch ? projectNameForPrefix : undefined,
      branch,
      json,
      follow,
      tail,
      services,
      profiles,
      format,
      since: args.options.since,
      until: args.options.until,
      maxLineBytes: args.options.maxLineBytes,
    });

  if (useLoki) {
    return await runLogsWithLoki({
      baseUrl,
      lokiReachable,
      loggingOff,
      projectNameForPrefix,
      branch,
      json,
      follow,
      tail,
      format,
      timeRange,
      servicesOpt: args.options.services,
      positionalService: typeof service === "string" ? service : undefined,
      queryOpt: args.options.query,
      since: args.options.since,
      until: args.options.until,
      wantsLokiExplicit,
      maxLineBytes: args.options.maxLineBytes,
      target: {
        path: args.options.path,
        project: args.options.project,
        branch: args.options.branch,
      },
      tailOpt: args.options.tail,
      profiles,
      pretty: args.options.pretty === true,
      runCompose,
    });
  }

  // Fallback to docker compose logs when Loki isn't available.
  return await runCompose();
}

/** An omitted option stays omitted so native dispatch can distinguish it from an explicit empty list. */
function optionalCsvList(value: string | undefined): string[] | undefined {
  return value === undefined ? undefined : parseCsvList(value);
}
function parseCsvList(value: string | undefined): string[] {
  const raw = (value ?? "").trim();
  if (raw.length === 0) {
    return [];
  }
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const uniq = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (uniq.has(p)) {
      continue;
    }
    uniq.add(p);
    out.push(p);
  }
  return out;
}

/** Resolve the profiles Compose activates after CLI-over-environment precedence. */
function resolveEffectiveComposeProfiles(opts: {
  readonly cliProfiles: readonly string[];
  readonly composeEnv: Readonly<Record<string, string>>;
}): string[] {
  return effectiveComposeProfiles({
    cliProfiles: opts.cliProfiles,
    env: opts.composeEnv,
  });
}

function parseLogTimeRange(opts: {
  readonly since: string | undefined;
  readonly until: string | undefined;
}): {
  readonly start: Date | null;
  readonly end: Date | null;
  readonly error?: string;
} {
  const sinceRaw = (opts.since ?? "").trim();
  const untilRaw = (opts.until ?? "").trim();

  if (sinceRaw.length === 0 && untilRaw.length === 0) {
    return { start: null, end: null };
  }

  const now = new Date();
  const start = sinceRaw.length > 0 ? parseTimeInput(sinceRaw, now) : null;
  if (sinceRaw.length > 0 && !start) {
    return {
      start: null,
      end: null,
      error: `Invalid --since: "${sinceRaw}" (expected RFC3339 or duration like 15m)`,
    };
  }

  const end = untilRaw.length > 0 ? parseTimeInput(untilRaw, now) : null;
  if (untilRaw.length > 0 && !end) {
    return {
      start: null,
      end: null,
      error: `Invalid --until: "${untilRaw}" (expected RFC3339 or duration like 15m)`,
    };
  }

  if (start && end && start.getTime() > end.getTime()) {
    return {
      start,
      end,
      error: "--since must be before --until.",
    };
  }

  return { start, end };
}

async function handleOpen({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: OpenArgs;
}): Promise<number> {
  const nativeOrigin = await tryNativeComposeOpen({
    cwd: ctx.cwd,
    path: args.options.path,
    project: args.options.project,
    instance: args.options.branch,
    target: args.positionals.target,
    prefer: args.options.prefer,
  });
  if (nativeOrigin !== null) {
    return await emitOpenOrigin({
      url: nativeOrigin,
      json: args.options.json === true,
      origin: "native",
    });
  }
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
    touchRegistration: false,
  });
  const json = args.options.json === true;
  const branch = await resolveEffectiveBranchForCommand({
    project,
    branchOption: args.options.branch,
    noticeToStderr: json,
  });
  const derivedHost = `${defaultProjectSlugFromPath(project.projectRoot)}.${DEFAULT_PROJECT_TLD}`;
  const devHost = (await readProjectDevHost(project)) ?? derivedHost;
  const cfg = await readProjectConfig(project);
  if (cfg.parseError) {
    const configPath = cfg.configPath ?? project.configFile;
    if (json) {
      process.stderr.write(
        `Failed to parse ${configPath}: ${cfg.parseError}\n`
      );
    } else {
      logger.warn({
        message: `Failed to parse ${configPath}: ${cfg.parseError}`,
      });
    }
  }
  const aliasHost = resolveBranchAliasHost({ devHost, cfg });
  const baseHosts = resolveProjectRouteBaseHosts({ devHost, aliasHost });

  const targetRaw = (args.positionals.target ?? "").trim();
  const startupOrigin = await startupOpenOrigin({
    target: targetRaw,
    project,
    branch,
  });
  if (startupOrigin !== null) {
    return await emitOpenOrigin({ url: startupOrigin, json, origin: "native" });
  }
  const preferenceRaw = args.options.prefer;
  const optionPreference = parseOpenHostPreference(preferenceRaw);
  if (preferenceRaw !== undefined && !optionPreference) {
    throw new CliUsageError("--prefer must be 'auto', 'alias', or 'dev'");
  }
  const usesProjectBaseHost =
    targetRaw === "" ||
    targetRaw === "www" ||
    (targetRaw !== "logs" &&
      !hasUrlScheme(targetRaw) &&
      !targetRaw.includes("."));
  const preferred = resolvePreferredOpenHost({
    devHost,
    aliasHost,
    configPreference: cfg.open?.prefer,
    ...(optionPreference ? { optionPreference } : {}),
  });
  if (usesProjectBaseHost && !preferred.ok) {
    throw new CliUsageError(
      "OAuth alias host is unavailable. Enable oauth.enabled or use --prefer dev."
    );
  }
  const baseHost =
    usesProjectBaseHost && preferred.ok ? preferred.host : devHost;
  const rawHost = resolveRawHost({ targetRaw, devHost: baseHost });
  const resolvedHost =
    branch && usesProjectBaseHost
      ? applyBranchToHost({ host: rawHost, branch, baseHosts })
      : rawHost;
  const grafanaHost = await resolveOpenGrafanaHost(targetRaw);
  const nativeOpen = await resolveNativeOpenPort({ targetRaw, project, cfg });
  const url = resolveOpenUrl({
    targetRaw,
    resolvedHost,
    grafanaHost,
    httpsPort: nativeOpen.httpsPort,
  });

  return await emitOpenOrigin({
    url,
    json,
    origin: nativeOpen.native ? "native" : "compose",
  });
}

export async function emitOpenOrigin(opts: {
  readonly url: string;
  readonly json: boolean;
  readonly origin: "compose" | "native";
  readonly checkLoopback?: typeof openProxyLoopbackWarning;
  readonly checkResolution?: typeof openUnresolvedHostWarning;
  readonly openerAvailable?: () => boolean;
}): Promise<number> {
  const warning =
    opts.origin === "compose"
      ? await (opts.checkLoopback ?? openProxyLoopbackWarning)({
          url: opts.url,
        })
      : null;
  if (warning) {
    throw new HackCliError({ code: "E_GLOBAL_INFRA_DOWN", message: warning });
  }
  // A URL whose host has no address is still the right URL, so this is a
  // warning, not a refusal: JSON keeps `url` and adds `dns` and `hint`.
  // Compose origins only, like the loopback check: native routes have their
  // own DNS path and checks, and a native open stays free of host probes.
  const unresolved =
    opts.origin === "compose"
      ? await (opts.checkResolution ?? openUnresolvedHostWarning)({
          url: opts.url,
        })
      : null;
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        unresolved
          ? { url: opts.url, dns: unresolved.dns, hint: unresolved.hint }
          : { url: opts.url },
        null,
        2
      )}\n`
    );
    noteBrowserTargetsForLocalNetworkHint([opts.url]);
    return 0;
  }
  if (!(opts.openerAvailable ?? urlOpenerAvailable)()) {
    // No desktop here (a server, container or cloud sandbox): the URL is the
    // answer. Stdout carries only the URL, so `url=$(hack open)` works; every
    // note goes to stderr.
    if (unresolved) {
      process.stderr.write(`${unresolved.hint}\n`);
    }
    process.stderr.write(
      "No program to open URLs on this machine (xdg-open is not installed), so open this URL yourself.\n"
    );
    process.stdout.write(`${opts.url}\n`);
    return 0;
  }
  if (unresolved) {
    logger.warn({ message: unresolved.hint });
  }
  logger.step({ message: `Opening ${opts.url}` });
  noteBrowserTargetsForLocalNetworkHint([opts.url]);
  return await openUrl(opts.url);
}

function hasUrlScheme(value: string): boolean {
  return URL_SCHEME_PATTERN.test(value);
}

/**
 * Parses a potentially quoted string value and returns the quote character and inner value.
 */
function parseQuotedValue(valueTrimmed: string): {
  quote: string | null;
  value: string;
} {
  if (
    valueTrimmed.startsWith('"') &&
    valueTrimmed.endsWith('"') &&
    valueTrimmed.length >= 2
  ) {
    return { quote: '"', value: valueTrimmed.slice(1, -1) };
  }
  if (
    valueTrimmed.startsWith("'") &&
    valueTrimmed.endsWith("'") &&
    valueTrimmed.length >= 2
  ) {
    return { quote: "'", value: valueTrimmed.slice(1, -1) };
  }
  return { quote: null, value: valueTrimmed };
}

/**
 * Normalizes a relative path by removing "./" prefix if present.
 */
function normalizeRelativePath(relRaw: string): string {
  if (relRaw === ".") {
    return ".";
  }
  if (relRaw.startsWith("./")) {
    return relRaw.slice(2);
  }
  return relRaw;
}

/**
 * Resolves the log output format based on options.
 */
function resolveLogFormat(opts: {
  readonly json: boolean;
  readonly pretty: boolean | undefined;
}): "json" | "pretty" | "plain" {
  if (opts.json) {
    return "json";
  }
  if (opts.pretty) {
    return "pretty";
  }
  return "plain";
}

/**
 * Resolves the raw host from target input for the open command.
 */
function resolveRawHost(opts: {
  readonly targetRaw: string;
  readonly devHost: string;
}): string {
  if (opts.targetRaw === "" || opts.targetRaw === "www") {
    return opts.devHost;
  }
  if (opts.targetRaw.includes(".")) {
    return opts.targetRaw;
  }
  return `${opts.targetRaw}.${opts.devHost}`;
}

/**
 * Resolves the final URL to open based on target input.
 */
async function resolveOpenGrafanaHost(
  target: string
): Promise<string | undefined> {
  if (target !== "logs") {
    return undefined;
  }
  if (!(await resolveGlobalLoggingForHome()).enabled) {
    throw new HackCliError({
      code: LOGGING_OFF_CODE,
      message: renderLoggingOffMessage({ feature: "Grafana (hack open logs)" }),
    });
  }
  const host = await resolveInstalledGrafanaHost();
  if (!host) {
    throw new CliUsageError(
      "Cannot identify a configured global Grafana route; review the global logging Compose file or pass an explicit URL."
    );
  }
  return host;
}

export function resolveOpenUrl(opts: {
  readonly grafanaHost?: string;
  readonly targetRaw: string;
  readonly resolvedHost: string;
  /**
   * The native HTTPS frontend's port when the project runs on the native
   * backend; 443 and null stay implicit, any other port is written out.
   */
  readonly httpsPort?: number | null;
}): string {
  if (opts.targetRaw === "logs") {
    return `https://${opts.grafanaHost ?? DEFAULT_GRAFANA_HOST}`;
  }
  if (hasUrlScheme(opts.targetRaw)) {
    return opts.targetRaw;
  }
  return runtimeHostUrl({
    host: opts.resolvedHost,
    httpsPort: opts.httpsPort,
  });
}

/**
 * On the native backend a project host is served by native's own HTTPS
 * frontend, which may listen on another port (for example 18443). The target
 * is checked first: Grafana and full URLs never consult the native runtime.
 */
async function startupOpenOrigin(opts: {
  readonly target: string;
  readonly project: Awaited<ReturnType<typeof resolveProjectForArgs>>;
  readonly branch: string | null;
}): Promise<string | null> {
  const runtime = resolveNativeRuntimeSelection();
  if (!(runtime && openTargetIsProjectHost(opts.target))) {
    return null;
  }
  const scope = {
    projectRoot: opts.project.projectRoot,
    projectDir: opts.project.projectDir,
    nativeHome: runtime.home,
    branch: opts.branch,
  };
  if (!(await nativeProjectStartupPending(scope))) {
    return null;
  }
  const snapshot = await nativeStartupProjectPs({ runtime, scope });
  const ports = snapshot?.ports?.filter(
    (port) =>
      port.state === "observed" &&
      (!opts.target || port.service === opts.target)
  );
  if (ports?.length === 1) {
    return `http://127.0.0.1:${ports[0]?.port}`;
  }
  throw new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message:
      "Native project is still starting. The requested address is not available yet.",
  });
}

async function resolveNativeOpenPort(opts: {
  readonly targetRaw: string;
  readonly project: Awaited<ReturnType<typeof resolveProjectForArgs>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
}): Promise<{ readonly native: boolean; readonly httpsPort?: number | null }> {
  if (
    !openTargetIsProjectHost(opts.targetRaw) ||
    resolveNativeRuntimeSelection() === null
  ) {
    return { native: false };
  }
  return { native: true, httpsPort: await resolveNativeProjectHttpsPort(opts) };
}

async function resolveNativeProjectHttpsPort(opts: {
  readonly project: Awaited<ReturnType<typeof resolveProjectForArgs>>;
  readonly cfg: Awaited<ReturnType<typeof readProjectConfig>>;
}): Promise<number | null> {
  const host = await resolveNativeHostSettings({
    env: process.env,
    projectName: await resolveComposeProjectName({
      project: opts.project,
      cfg: opts.cfg,
    }),
    projectRoot: opts.project.projectRoot,
  });
  return host.https?.httpsPort ?? null;
}

/** Whether `hack open <target>` names a project host, not Grafana or a URL. */
function openTargetIsProjectHost(targetRaw: string): boolean {
  return targetRaw !== "logs" && !hasUrlScheme(targetRaw);
}
