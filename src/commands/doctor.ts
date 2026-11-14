import { lookup } from "node:dns/promises";
import { dirname, join, relative, resolve } from "node:path";
import { note, spinner } from "@clack/prompts";
import { YAML } from "bun";
import { HACK_AGENT_INTEGRATION_CONTENT_REVISION } from "../agents/integration-revision.ts";
import {
  checkLegacyProjectAgentArtifacts,
  checkLegacyUserAgentArtifacts,
} from "../agents/legacy-artifacts.ts";
import { nativeBuildsEnabled } from "../backends/native-project-builds.ts";
import { runNativeProjectCleanupCommand } from "../backends/native-project-cleanup-command.ts";
import {
  parseNativeRunMappingRecoveryOptions,
  runNativeProjectMappingCommand,
} from "../backends/native-project-mapping-command.ts";
import { hostRosettaAvailable } from "../backends/native-project-platform.ts";
import { selectNativeEnvFile } from "../backends/native-project-selection.ts";
import {
  nativeAdaptationCandidates,
  resolveNativeAdaptationSelection,
} from "../backends/native-project-settings.ts";
import {
  type NativeRuntimeSelection,
  resolveNativeRuntimeSelection,
} from "../backends/native-runtime-client.ts";
import type { CommandHandlerFor } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optBranch, optJson, optPath } from "../cli/options.ts";
import {
  DEFAULT_CADDY_IP,
  DEFAULT_HOST_DNS_IP,
  DEFAULT_INGRESS_GATEWAY,
  DEFAULT_INGRESS_NETWORK,
  DEFAULT_INGRESS_SUBNET,
  DEFAULT_LOGGING_NETWORK,
  DEFAULT_NEW_PROJECT_TLD,
  DEFAULT_OAUTH_ALIAS_ROOT,
  DEFAULT_PROJECT_TLD,
  GLOBAL_CADDY_COMPOSE_FILENAME,
  GLOBAL_CADDY_DIR_NAME,
  GLOBAL_COREDNS_FILENAME,
  GLOBAL_LOGGING_COMPOSE_FILENAME,
  GLOBAL_LOGGING_DIR_NAME,
  HACK_PROJECT_DIR_PRIMARY,
  LEGACY_GRAFANA_HOST,
  PROJECT_ENV_CONTRACT_FILENAME,
  PROJECT_ENV_KEY_FILENAME,
  PROJECT_ENV_STATE_FILENAME,
} from "../constants.ts";
import { resolveGatewayConfig } from "../control-plane/extensions/gateway/config.ts";
import { listGatewayTokensForStatus } from "../control-plane/extensions/gateway/tokens.ts";
import {
  isCandidateRun,
  probeDaemonApi,
  resolveDaemonAutostartAccess,
} from "../daemon/client.ts";
import { resolveDaemonPaths } from "../daemon/paths.ts";
import { buildDaemonStatusReport, readDaemonStatus } from "../daemon/status.ts";
import {
  resolveSystemdUnitPath,
  SYSTEMD_READ_ONLY_ENV,
} from "../daemon/systemd.ts";
import {
  type CaTrustReport,
  inspectCaTrust,
  listDirOutcome,
  pathExistsOutcome,
  readTextOutcome,
} from "../lib/ca-trust-status.ts";
import { repairCaddyCaExport } from "../lib/caddy-ca-export.ts";
import { inspectCaddyCaIdentity } from "../lib/caddy-ca-identity.ts";
import {
  readInternalExtraHostsIp,
  resolveGlobalCaddyIp,
} from "../lib/caddy-hosts.ts";
import { emitCliResult, okResult } from "../lib/cli-result.ts";
import {
  adoptedComposeEnvOverrideNextStep,
  composeEnvAtRestRepairs,
  describeComposeEnvAtRest,
  inspectComposeEnvAtRest,
  removePlaintextComposeEnvOverride,
} from "../lib/compose-env-at-rest.ts";
import {
  resolveGlobalConfigPath,
  resolveGlobalHackDir,
} from "../lib/config-paths.ts";
import { resolveDefaultDomain } from "../lib/default-domain.ts";
import { queryDnsARecord } from "../lib/dns-query.ts";
import {
  adoptedProjectCheckResult,
  adoptedProjectNotApplicableResults,
  type DoctorAdoptedProject,
  findDoctorAdoptedProject,
  preflightDoctorProject,
} from "../lib/doctor-adopted-project.ts";
import {
  checkBrowserLocalNetwork,
  parseBrowserNetworkOptions,
} from "../lib/doctor-browser-network.ts";
import {
  COMPOSE_BACKEND_CHECK,
  type ComposeBackendReport,
  composeBackendCheckResult,
} from "../lib/doctor-compose-backend.ts";
import {
  buildDoctorDaemonCheck,
  CANDIDATE_DAEMON_GUIDANCE,
} from "../lib/doctor-daemon.ts";
import {
  buildDaemonServiceCheck,
  DAEMON_SERVICE_CHECK,
  decideDaemonServiceFix,
} from "../lib/doctor-daemon-service.ts";
import {
  describeEnvKeyInspection,
  type EnvKeyInspection,
  gitIsLocalKeyIgnored,
  gitListTrackedKeyPaths,
  inspectProjectEnvKey,
  resolveEnvKeyCandidates,
} from "../lib/doctor-env-key.ts";
import {
  inspectHackDirGitignoreForDoctor,
  inspectTrackedGeneratedFiles,
  untrackGeneratedFiles,
} from "../lib/doctor-generated-files.ts";
import { checkMacHostTlsTrust } from "../lib/doctor-host-tls.ts";
import {
  AMD64_EMULATION_CHECK,
  type Amd64EmulationReport,
  amd64EmulationCheckResult,
} from "../lib/doctor-native-emulation.ts";
import {
  checkNativeSettings,
  NATIVE_SETTINGS_CHECK,
  type NativeSettingsReport,
} from "../lib/doctor-native-settings.ts";
import {
  checkNativeSourceSize,
  NATIVE_SOURCE_CHECK,
  type NativeSourceReport,
} from "../lib/doctor-native-source.ts";
import { inspectSecretIntegrity } from "../lib/doctor-secret-integrity.ts";
import {
  findCrossCheckoutInstances,
  inspectWorktreeSecretKeys,
} from "../lib/doctor-worktree.ts";
import { parseDotEnv } from "../lib/env.ts";
import {
  applyEnvMigration,
  previewEnvMigration,
} from "../lib/env-migration.ts";
import { envMigrationSnapshots } from "../lib/env-migration-snapshot.ts";
import {
  ensureDir,
  ensureGitignoreEntry,
  pathExists,
  readOptionalTextFile,
  readTextFile,
  writeTextFileIfChanged,
} from "../lib/fs.ts";
import { describeProxyNetworkIssue } from "../lib/global-proxy-network.ts";
import { resolveInstalledGrafanaHost } from "../lib/global-service-host.ts";
import { getString, isRecord } from "../lib/guards.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import {
  inspectHackEnvOverlayWarnings,
  readHackEnvContract,
} from "../lib/hack-env.ts";
import { normalizeHomeDir, resolveUserHomeDir } from "../lib/home-dir.ts";
import {
  canPrompt,
  confirmSafe,
  requireInteractive,
} from "../lib/interactivity.ts";
import { resolveInternalExtraHosts } from "../lib/internal-extra-hosts.ts";
import { createLinuxTrustHost } from "../lib/linux-trust-host.ts";
import { resolveLiveInputScope } from "../lib/live-inputs.ts";
import { findHackLocalCaCertPath } from "../lib/local-ca.ts";
import { noteBrowserTargetsForLocalNetworkHint } from "../lib/local-network-hint.ts";
import {
  describeSupersededRoots,
  inspectSupersededMacRoots,
  type SupersededRootInventory,
} from "../lib/mac-ca-trust.ts";
import {
  ensureBundledMutagenInstalled,
  getManagedMutagenAgentBundlePath,
  getManagedMutagenInstallPath,
  getMutagenPath,
} from "../lib/mutagen.ts";
import {
  inspectNativeCaTrust,
  type NativeCaDoctorDependencies,
  repairNativeCaTrust,
} from "../lib/native-ca-doctor.ts";
import { selectLegacyComposeAdoptedRoot } from "../lib/native-compose-adoption-command.ts";
import {
  readComposeBackendReading,
  readNativeComposeDocument,
  readNativePlatformModes,
} from "../lib/native-compose-backend-features.ts";
import {
  NATIVE_DATA_CHECK,
  type NativeDataReport,
  nativeDataCheckResult,
  readNativeDataAdvisories,
} from "../lib/native-data-advisories.ts";
import {
  describeHackLocalRoute,
  HACK_LOCAL_ROLLBACK_COMMAND,
  type HackLocalRouteDependencies,
  type HackLocalRouteReport,
  inspectHackLocalRoute,
  printable,
  repairHackLocalRoute,
  reportHackLocalRoute,
} from "../lib/native-hack-local-route.ts";
import { createNativeHackLocalRouteDependencies } from "../lib/native-hack-local-route-host.ts";
import {
  NATIVE_PROCESS_CHECK,
  type NativeProcessReport,
  nativeProcessCheckFromCompose,
} from "../lib/native-process-wrappers.ts";
import { isLinux, isMac } from "../lib/os.ts";
import { readPrivateEnvFile } from "../lib/private-env-file.ts";
import {
  defaultProjectSlugFromPath,
  findProjectContext,
  readProjectConfig,
  readProjectDefaultEnvConfig,
  readProjectDevHost,
} from "../lib/project.ts";
import { runProjectDomainCommand } from "../lib/project-domain-command.ts";
import {
  canMigrateCheckoutLegacyDotenv,
  discoverComposeServiceNames,
  dropRemovedLegacySecretStorePointer,
  ensureHackDirGitignore,
  HACK_DIR_GITIGNORE_READ_ONLY_WARNING,
  HACK_DIR_GITIGNORE_REFUSAL,
  HackDirGitignoreRefusalError,
  inspectProjectEnvMaterialization,
  LegacyDotenvMigrationRefusalError,
  LegacyEnvCleanupError,
  type LegacyProjectEnvMigration,
  listProjectEnvPlaintextEntries,
  ProjectEnvLayerPathConflictError,
  projectEnvConfigExistsForMutation,
  removeLegacyProjectEnvArtifacts,
  resolveProjectEnvConfig,
  type TrackedEnvMigrationChange,
} from "../lib/project-env-config.ts";
import {
  inspectProjectLifecycleHygiene,
  repairProjectLifecycleSessions,
} from "../lib/project-lifecycle-hygiene.ts";
import {
  findIncompleteRuntimeProjects,
  findMissingRegistryEntries,
  findOrphanRuntimeProjects,
  scopeRuntimeHygieneToProject,
} from "../lib/project-runtime-hygiene.ts";
import { readProjectsRegistry } from "../lib/projects-registry.ts";
import { resolveProxyBindAddress } from "../lib/proxy-bind.ts";
import { inspectProxyLoopback } from "../lib/proxy-loopback.ts";
import { readRuntimeProjects } from "../lib/runtime-projects.ts";
import {
  applySecretsHygieneFixes,
  inspectSecretsHygiene,
  type SecretsHygieneFinding,
  type SecretsHygieneScope,
} from "../lib/secrets-hygiene.ts";
import { exec, findExecutableInPath, run } from "../lib/shell.ts";
import {
  type PausableProgress,
  pausableSpinner,
  withTerminalHandoff,
} from "../lib/terminal-handoff.ts";
import { vettedHelperEnv } from "../lib/vetted-env.ts";
import { resolveSessionsMuxMode } from "../mux/mux-config.ts";
import {
  renderGlobalCaddyCompose,
  renderGlobalCoreDnsConfig,
} from "../templates.ts";
import { type DisplayStatusItem, display } from "../ui/display.ts";
import { getFzfPath } from "../ui/fzf.ts";
import { getGumPath } from "../ui/gum.ts";
import {
  resolveSystemdSummary,
  withSystemdIncompatibleNextStep,
} from "./daemon-systemd.ts";
import { runNativePreflightCommand } from "./doctor-native-preflight.ts";
import {
  analyzeComposeNetworkHygiene,
  resolvePreferredHostDnsTarget,
} from "./doctor-utils.ts";
import { inspectLinuxGlobalDns } from "./global-linux-dns.ts";
import {
  checkMacDnsmasqConfigForDomain,
  checkMacDnsmasqPort53,
  checkMacResolverForDomain,
} from "./global-mac-dns.ts";
import { inspectProxyNetwork } from "./global-proxy-network.ts";
import { noteNativeBackendBeta } from "./native-beta-notice.ts";
import {
  buildDoctorRecoveryGuidance,
  buildRecoveryWorkflowLines,
  type RecoveryCheckResult,
} from "./recovery-guidance.ts";

type CheckStatus = "ok" | "warn" | "error";

interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly message: string;
  /** Counts and public fingerprints only; never paths or keychain contents. */
  readonly supersededRoots?: SupersededRootInventory;
  /** Native hack.local route state; lines and paths only, never file contents. */
  readonly hackLocalRoute?: HackLocalRouteReport;
  /** Closed, value-free env key findings; project-relative subjects only. */
  readonly envKey?: EnvKeyInspection;
  /** Trust-store states for the local CA; paths and fingerprints only. */
  readonly caTrust?: CaTrustReport;
  /** Closed Compose-backend feature names only; never authored values. */
  readonly composeBackend?: ComposeBackendReport;
  /** Closed native data advisory codes and service names only. */
  readonly nativeData?: NativeDataReport;
  /** Counts of services opted in to amd64 emulation; never service names. */
  readonly amd64Emulation?: Amd64EmulationReport;
  /** Native setting origins and closed warnings only; never setting values. */
  readonly nativeSettings?: NativeSettingsReport;
  /** Selected source sizes and project-relative paths; never file contents. */
  readonly nativeSource?: NativeSourceReport;
  /** Service names and closed process fields only. */
  readonly nativeProcess?: NativeProcessReport;
}

const HACK_LOCAL_ROUTE_CHECK = "native hack.local route";
const HACK_LOCAL_REPAIR_CHECK = "native hack.local repair";

const SUPERSEDED_ROOTS_CHECK = "superseded caddy roots";

/** Informational inventory: Doctor and --fix never remove a keychain root. */
function supersededRootsCheck(
  inventory: SupersededRootInventory | undefined
): CheckResult {
  return {
    name: SUPERSEDED_ROOTS_CHECK,
    ...describeSupersededRoots(inventory),
    ...(inventory ? { supersededRoots: inventory } : {}),
  };
}

async function checkSupersededCaddyRoots(): Promise<CheckResult> {
  const certPath = await findHackLocalCaCertPath();
  return supersededRootsCheck(
    certPath ? await inspectSupersededMacRoots({ certPath }) : undefined
  );
}

interface TimedCheckResult extends CheckResult {
  readonly durationMs: number;
}

const optFix = defineOption({
  name: "fix",
  type: "boolean",
  long: "--fix",
  description: "Attempt safe auto-remediations (network + CoreDNS + CA)",
} as const);

const optMigrateEnvConfig = defineOption({
  name: "migrateEnvConfig",
  type: "boolean",
  long: "--migrate-env-config",
  description:
    "Migrate legacy hack.env.json/.env state to the new env config files",
} as const);

const optAcceptTrackedEnvChanges = defineOption({
  name: "acceptTrackedEnvChanges",
  type: "boolean",
  long: "--accept-tracked-env-changes",
  description:
    "With --migrate-env-config and no prompt, allow deleting or editing git-tracked files (hack.env.json, the Compose file)",
} as const);

const optBrowserUrl = defineOption({
  name: "browserUrl",
  type: "string",
  long: "--browser-url",
  valueHint: "https://app.hack",
  description:
    "HTTPS origin manually tested in the browser (no path or credentials)",
} as const);
const optDomainMigration = defineOption({
  name: "domainMigration",
  type: "string",
  long: "--domain-migration",
  valueHint: "preview|apply|rollback",
  description:
    "Preview, apply, or roll back only this project's hack.local migration",
} as const);
const optBrowserResult = defineOption({
  name: "browserResult",
  type: "string",
  long: "--browser-result",
  valueHint: "unknown|works|fails|permission-denied",
  description:
    "Your manual browser observation for --browser-url (default: unknown)",
} as const);
const doctorOptions = [
  optPath,
  optFix,
  optMigrateEnvConfig,
  optAcceptTrackedEnvChanges,
  optDomainMigration,
  optJson,
  optBrowserUrl,
  optBrowserResult,
  optBranch,
  defineOption({
    name: "nativePreflight",
    type: "boolean",
    long: "--native-preflight",
    description:
      "List everything that would stop this Compose project from starting on the native backend, with a fix for each; read-only, with --path, --profile and --json",
  } as const),
  defineOption({
    name: "profile",
    type: "string",
    long: "--profile",
    valueHint: "<name[,name...]>",
    description:
      "Compose profiles to review with --native-preflight (comma-separated)",
  } as const),
  defineOption({
    name: "nativeCleanup",
    type: "string",
    long: "--native-cleanup",
    valueHint: "inspect",
    description:
      "Inspect one mapped native graph's pending cleanup without recovery or stop replay",
  } as const),
  defineOption({
    name: "nativeRunMapping",
    type: "string",
    long: "--native-run-mapping",
    valueHint: "inspect|repair|release",
    description:
      "Inspect a native run mapping, explicitly repair it after filesystem device renumbering, or release one another native home left after a clean stop",
  } as const),
  defineOption({
    name: "expectSelection",
    type: "string",
    long: "--expect-selection",
    valueHint: "<64-hex>",
    description: "Require the exact run-mapping recovery inspection selection",
  } as const),
  defineOption({
    name: "acceptLegacyDeviceRebind",
    type: "boolean",
    long: "--accept-legacy-device-rebind",
    description:
      "Explicitly accept legacy migration without proof of original filesystem volume continuity",
  } as const),
] as const;
const doctorPositionals = [] as const;

const doctorSpec = defineCommand({
  name: "doctor",
  summary:
    "Validate local setup for the selected runtime, routing, trust and project",
  group: "Diagnostics",
  options: doctorOptions,
  positionals: doctorPositionals,
  subcommands: [],
} as const);

/** Linux resolver route for Hack's routed suffixes (HACK-2053). */
const LINUX_DNS_ROUTE_CHECK = "linux dns route";
/** Proxy containers that run without their ingress network (HACK-2056). */
const PROXY_NETWORK_CHECK = "proxy network";

/** Doctor check for a missing or outdated committed `.hack/.gitignore`. */
const HACK_GITIGNORE_CHECK = "hack gitignore";

const DOCTOR_SUMMARY_GROUPS = [
  {
    title: "Dependencies",
    checks: new Set([
      "bun",
      "docker",
      "docker compose",
      "brew (optional)",
      "dnsmasq (optional)",
      "mkcert (optional)",
      "gum (optional)",
      "fzf (optional)",
      "tmux (sessions)",
      "zellij (sessions)",
      "mutagen",
      "go (optional)",
      "caddy (optional)",
      "asdf (optional)",
    ]),
  },
  {
    title: "Global runtime & agents",
    checks: new Set([
      "docker daemon",
      `network:${DEFAULT_INGRESS_NETWORK}`,
      `network:${DEFAULT_LOGGING_NETWORK}`,
      `network:${DEFAULT_INGRESS_NETWORK} subnet`,
      "global files",
      "daemon",
      DAEMON_SERVICE_CHECK,
      "gateway config",
      "gateway tokens",
      "grafana",
      "proxy ports",
      PROXY_NETWORK_CHECK,
      "caddy local ca",
      "host tls trust",
      SUPERSEDED_ROOTS_CHECK,
      "native https owner",
      "native root trust",
      "native ca repair",
      "native https route",
    ]),
  },
  {
    title: "Browser access",
    checks: new Set(["browser local network"]),
  },
  {
    title: "Resolver & DNS",
    checks: new Set([
      `resolver:${DEFAULT_PROJECT_TLD}`,
      `resolver:${DEFAULT_NEW_PROJECT_TLD}`,
      `resolver:${DEFAULT_OAUTH_ALIAS_ROOT}`,
      `dnsmasq.conf:${DEFAULT_PROJECT_TLD}`,
      `dnsmasq.conf:${DEFAULT_NEW_PROJECT_TLD}`,
      `dnsmasq.conf:${DEFAULT_OAUTH_ALIAS_ROOT}`,
      "dnsmasq:53",
      LINUX_DNS_ROUTE_CHECK,
      HACK_LOCAL_REPAIR_CHECK,
      HACK_LOCAL_ROUTE_CHECK,
      "native host dns",
      `dns:${DEFAULT_PROJECT_TLD}`,
      `dns:${DEFAULT_NEW_PROJECT_TLD}`,
      `dns:${DEFAULT_OAUTH_ALIAS_ROOT}`,
      "coredns forwarding",
      "caddy hosts",
      "DEV_HOST",
    ]),
  },
  {
    title: "Project & env",
    checks: new Set([
      "project",
      "runtime hygiene",
      "lifecycle hygiene",
      "compose networks",
      "env mode",
      "env materialization",
      "env overlay warnings",
      "worktree keys",
      "worktree instances",
      "generated files",
      HACK_GITIGNORE_CHECK,
    ]),
  },
  {
    title: "Sessions",
    checks: new Set(["sessions mux"]),
  },
] as const;

async function maybeRunDomainMigration(
  args: Parameters<CommandHandlerFor<typeof doctorSpec>>[0]["args"]
): Promise<number | null> {
  if (args.options.domainMigration !== undefined) {
    if (args.options.nativeCleanup !== undefined) {
      throw new CliUsageError(
        "--native-cleanup accepts only inspect with --path, --branch and --json; recovery is explicit and separate."
      );
    }
    if (
      args.options.fix ||
      args.options.migrateEnvConfig ||
      args.options.browserUrl ||
      args.options.browserResult
    ) {
      throw new CliUsageError(
        "--domain-migration cannot be combined with other Doctor repair or browser options"
      );
    }
    return await runProjectDomainCommand({
      action: args.options.domainMigration,
      startDir: args.options.path
        ? resolve(process.cwd(), args.options.path)
        : process.cwd(),
      json: args.options.json === true,
    });
  }
  return null;
}

async function maybeRunNativeMappingRecovery(
  args: Parameters<CommandHandlerFor<typeof doctorSpec>>[0]["args"]
): Promise<number | null> {
  if (args.options.nativeCleanup !== undefined) {
    if (
      args.options.nativeCleanup !== "inspect" ||
      args.options.nativeRunMapping !== undefined ||
      args.options.expectSelection !== undefined ||
      args.options.acceptLegacyDeviceRebind ||
      args.options.fix ||
      args.options.migrateEnvConfig ||
      args.options.domainMigration ||
      args.options.browserUrl ||
      args.options.browserResult
    ) {
      throw new CliUsageError(
        "--native-cleanup accepts only inspect with --path, --branch and --json; recovery is explicit and separate."
      );
    }
    const runtime = resolveNativeRuntimeSelection();
    if (!runtime) {
      throw new CliUsageError(
        "Native cleanup inspection requires an explicitly selected native runtime."
      );
    }
    return await runNativeProjectCleanupCommand({
      runtime,
      startDir: args.options.path
        ? resolve(process.cwd(), args.options.path)
        : process.cwd(),
      branch: args.options.branch,
      json: args.options.json === true,
    });
  }
  const mapping = parseNativeRunMappingRecoveryOptions({
    action: args.options.nativeRunMapping,
    expectSelection: args.options.expectSelection,
    acceptLegacyDeviceRebind: args.options.acceptLegacyDeviceRebind,
    branch: args.options.branch,
    otherOptions: Boolean(
      args.options.fix ||
        args.options.migrateEnvConfig ||
        args.options.domainMigration ||
        args.options.browserUrl ||
        args.options.browserResult
    ),
  });
  if (mapping) {
    const runtime = resolveNativeRuntimeSelection();
    if (!runtime) {
      throw new CliUsageError(
        "Native run-mapping recovery requires an explicitly selected native runtime."
      );
    }
    return await runNativeProjectMappingCommand({
      selection: mapping,
      runtime,
      startDir: args.options.path
        ? resolve(process.cwd(), args.options.path)
        : process.cwd(),
      branch: args.options.branch,
      json: args.options.json === true,
    });
  }
  return null;
}

/** The only options `--native-preflight` accepts beside itself. */
const NATIVE_PREFLIGHT_OPTIONS = new Set([
  "nativePreflight",
  "path",
  "json",
  "profile",
]);

/** Comma-separated profile names, trimmed, unique, in the order given. */
function preflightProfiles(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
    ),
  ];
}

/**
 * `--native-preflight` is its own read-only mode: it runs no other check. An
 * allow-list, so an option added to doctor later is refused here until it is
 * deliberately supported.
 */
async function runNativePreflightMode(
  args: Parameters<CommandHandlerFor<typeof doctorSpec>>[0]["args"]
): Promise<number> {
  const options: Readonly<Record<string, unknown>> = args.options;
  const other = Object.entries(options).some(
    ([name, value]) =>
      !NATIVE_PREFLIGHT_OPTIONS.has(name) &&
      value !== undefined &&
      value !== false
  );
  if (other) {
    throw new CliUsageError(
      "--native-preflight accepts only --path, --profile and --json; it changes nothing and runs no other check."
    );
  }
  return await runNativePreflightCommand({
    startDir: resolveDoctorStartDir(args.options.path),
    json: args.options.json === true,
    profiles: preflightProfiles(args.options.profile),
  });
}

const handleDoctor: CommandHandlerFor<typeof doctorSpec> = async ({
  args,
}): Promise<number> => {
  if (args.options.nativePreflight) {
    return await runNativePreflightMode(args);
  }
  if (args.options.profile !== undefined) {
    throw new CliUsageError("--profile applies only to --native-preflight.");
  }
  const adopted = await preflightDoctorProject({
    startDir: resolveDoctorStartDir(args.options.path),
  });
  const mappingResult = await maybeRunNativeMappingRecovery(args);
  if (mappingResult !== null) {
    return mappingResult;
  }
  const domainResult = await maybeRunDomainMigration(args);
  if (domainResult !== null) {
    return domainResult;
  }
  const browser = parseBrowserNetworkOptions({
    url: args.options.browserUrl,
    result: args.options.browserResult,
  });
  const json = args.options.json === true;
  assertDoctorOptionCompatibility({
    json,
    fix: args.options.fix === true,
    migrateEnvConfig: args.options.migrateEnvConfig === true,
    acceptTrackedEnvChanges: args.options.acceptTrackedEnvChanges === true,
  });
  const native = resolveNativeRuntimeSelection();
  if (native) {
    noteNativeBackendBeta({ json });
    return await handleNativeDoctor({
      runtime: native,
      startDir: resolveDoctorStartDir(args.options.path),
      browser,
      json,
      fix: args.options.fix === true,
      migrateEnvConfig: args.options.migrateEnvConfig === true,
      acceptTrackedEnvChanges: args.options.acceptTrackedEnvChanges === true,
    });
  }
  const results: TimedCheckResult[] = [];
  const defaultDomain = await resolveDefaultDomain();
  const s = createDoctorProgress({ json });
  s.start("Running doctor checks...");

  results.push(
    await runCheck(
      s,
      "browser local network",
      () =>
        checkBrowserLocalNetwork({ platform: process.platform, ...browser }),
      { timeoutMs: 7000 }
    )
  );

  // Tools
  results.push(
    await runCheck(s, "bun", () => checkTool({ name: "bun", cmd: "bun" }))
  );
  results.push(
    await runCheck(s, "docker", () =>
      checkTool({ name: "docker", cmd: "docker" })
    )
  );
  results.push(
    await runCheck(s, "docker compose", () =>
      checkTool({ name: "docker compose", cmd: "docker" })
    )
  );
  results.push(
    await runCheck(s, "brew", () =>
      checkTool({ name: "brew (optional)", cmd: "brew", optional: true })
    )
  );
  results.push(
    await runCheck(s, "dnsmasq", () =>
      checkTool({ name: "dnsmasq (optional)", cmd: "dnsmasq", optional: true })
    )
  );
  results.push(
    await runCheck(s, "mkcert", () =>
      checkTool({ name: "mkcert (optional)", cmd: "mkcert", optional: true })
    )
  );
  results.push(await runCheck(s, "gum", () => checkOptionalGum()));
  results.push(await runCheck(s, "fzf", () => checkOptionalFzf()));
  results.push(
    await runCheck(s, "tmux", () =>
      checkTool({ name: "tmux (sessions)", cmd: "tmux", optional: true })
    )
  );
  results.push(
    await runCheck(s, "zellij", () =>
      checkTool({ name: "zellij (sessions)", cmd: "zellij", optional: true })
    )
  );
  results.push(await runCheck(s, "mutagen", () => checkMutagenBinary()));
  results.push(
    await runCheck(s, "go", () =>
      checkTool({ name: "go (optional)", cmd: "go", optional: true })
    )
  );
  results.push(
    await runCheck(s, "caddy", () =>
      checkTool({ name: "caddy (optional)", cmd: "caddy", optional: true })
    )
  );
  results.push(
    await runCheck(s, "asdf", () =>
      checkTool({ name: "asdf (optional)", cmd: "asdf", optional: true })
    )
  );

  // Docker running
  results.push(
    await runCheck(s, "docker daemon", () => checkDockerRunning(), {
      timeoutMs: 5000,
    })
  );

  // Networks
  results.push(
    await runCheck(
      s,
      `network:${DEFAULT_INGRESS_NETWORK}`,
      () => checkDockerNetwork(DEFAULT_INGRESS_NETWORK),
      {
        timeoutMs: 5000,
      }
    )
  );
  results.push(
    await runCheck(
      s,
      `network:${DEFAULT_LOGGING_NETWORK}`,
      () => checkDockerNetwork(DEFAULT_LOGGING_NETWORK),
      {
        timeoutMs: 5000,
      }
    )
  );
  results.push(
    await runCheck(
      s,
      `network:${DEFAULT_INGRESS_NETWORK} subnet`,
      () => checkIngressSubnet(),
      {
        timeoutMs: 5000,
      }
    )
  );

  // Global files
  results.push(await runCheck(s, "global files", () => checkGlobalFiles()));
  results.push(await runCheck(s, "daemon", () => checkDaemonStatus()));
  if (isLinux() && !isCandidateRun()) {
    // Candidate trials do not manage the stable login service. Otherwise the
    // row is omitted when systemd management is disabled for this process
    // (isolated HACK_HOME, HACK_SYSTEMD_DISABLE=1); read failures are reported.
    const serviceCheck = await resolveSystemdSummary({
      paths: resolveDaemonPaths({}),
    }).then(buildDaemonServiceCheck, (error: unknown) => ({
      name: DAEMON_SERVICE_CHECK,
      status: "warn" as const,
      message: `Could not read the hackd systemd service: ${error instanceof Error ? error.message : String(error)}`,
    }));
    if (serviceCheck) {
      results.push(await runCheck(s, DAEMON_SERVICE_CHECK, () => serviceCheck));
    }
  }
  results.push(await runCheck(s, "gateway config", () => checkGatewayConfig()));
  results.push(await runCheck(s, "gateway tokens", () => checkGatewayTokens()));

  if (isMac()) {
    results.push(
      await runCheck(
        s,
        `resolver:${DEFAULT_NEW_PROJECT_TLD}`,
        () => checkMacResolverForDomain(DEFAULT_NEW_PROJECT_TLD),
        { timeoutMs: 1000 }
      )
    );
    results.push(
      await runCheck(
        s,
        `dnsmasq.conf:${DEFAULT_NEW_PROJECT_TLD}`,
        () => checkMacDnsmasqConfigForDomain(DEFAULT_NEW_PROJECT_TLD),
        { timeoutMs: 3000 }
      )
    );
    results.push(
      await runCheck(
        s,
        `resolver:${DEFAULT_PROJECT_TLD}`,
        () => checkMacResolverForDomain(DEFAULT_PROJECT_TLD),
        {
          timeoutMs: 1000,
        }
      )
    );
    results.push(
      await runCheck(
        s,
        `resolver:${DEFAULT_OAUTH_ALIAS_ROOT}`,
        () => checkMacResolverForDomain(DEFAULT_OAUTH_ALIAS_ROOT),
        {
          timeoutMs: 1000,
        }
      )
    );
    results.push(
      await runCheck(
        s,
        `dnsmasq.conf:${DEFAULT_PROJECT_TLD}`,
        () => checkMacDnsmasqConfigForDomain(DEFAULT_PROJECT_TLD),
        {
          timeoutMs: 1500,
        }
      )
    );
    results.push(
      await runCheck(
        s,
        `dnsmasq.conf:${DEFAULT_OAUTH_ALIAS_ROOT}`,
        () => checkMacDnsmasqConfigForDomain(DEFAULT_OAUTH_ALIAS_ROOT),
        {
          timeoutMs: 1500,
        }
      )
    );
    results.push(
      await runCheck(s, "dnsmasq:53", () => checkMacDnsmasqPort53(), {
        timeoutMs: 2000,
      })
    );
  }
  if (isLinux()) {
    results.push(
      await runCheck(s, LINUX_DNS_ROUTE_CHECK, () => checkLinuxDnsRoute(), {
        // Up to four sequential probes with 3s timeouts each.
        timeoutMs: 13_000,
      })
    );
  }

  results.push(
    await runCheck(
      s,
      `dns:${DEFAULT_NEW_PROJECT_TLD}`,
      () => checkHackLocalDns(),
      { timeoutMs: 3000 }
    )
  );

  // DNS (can be very slow if wildcard DNS isn't configured)
  const dns = await runCheck(
    s,
    `dns:${DEFAULT_PROJECT_TLD}`,
    () => checkHackDns(),
    {
      timeoutMs: 1500,
    }
  );
  results.push(dns);

  const oauthDns = await runCheck(
    s,
    `dns:${DEFAULT_OAUTH_ALIAS_ROOT}`,
    () => checkOauthAliasDns(),
    {
      timeoutMs: 1500,
    }
  );
  results.push(oauthDns);
  await appendCustomDomainDnsChecks({ results, progress: s, defaultDomain });

  // Endpoint reachability (best-effort). Skip if DNS isn't set up.
  if (dns.status === "ok") {
    results.push(
      await runCheck(s, "grafana", () => checkGrafanaReachable(), {
        timeoutMs: 2000,
      })
    );
  } else {
    results.push({
      name: "grafana",
      status: "warn",
      message: `Skipped reachability (DNS for ${LEGACY_GRAFANA_HOST} not configured)`,
      durationMs: 0,
    });
  }

  // Authenticate loopback independently of direct container reachability.
  results.push(
    await runCheck(s, "proxy ports", () => inspectProxyLoopback(), {
      timeoutMs: 8000,
    })
  );
  results.push(
    await runCheck(s, PROXY_NETWORK_CHECK, () => checkProxyNetwork(), {
      timeoutMs: 12_000,
    })
  );

  results.push(
    await runCheck(s, "coredns forwarding", () => checkCoreDnsForwarding(), {
      timeoutMs: 2000,
    })
  );
  results.push(
    await runCheck(s, "caddy local ca", () => checkCaddyLocalCa(), {
      // The identity probe allows three sequential Docker calls up to 5s each.
      timeoutMs: 16_000,
    })
  );
  results.push(
    await runCheck(s, LOCAL_CA_TRUST_CHECK, () => checkLocalCaTrust(), {
      // A few bounded trust-store queries (5s each), plus one per NSS db.
      timeoutMs: 30_000,
    })
  );
  if (isMac()) {
    results.push(
      await runCheck(s, "host tls trust", () => checkMacHostTlsTrust(), {
        timeoutMs: 1500,
      })
    );
    results.push(
      await runCheck(
        s,
        SUPERSEDED_ROOTS_CHECK,
        () => checkSupersededCaddyRoots(),
        { timeoutMs: 1500 }
      )
    );
  }

  // Project (if in a repo or --path)
  const startDir = args.options.path
    ? resolve(process.cwd(), args.options.path)
    : process.cwd();
  const projectCtx = await runCheck(s, "project", () =>
    checkProject({ startDir, adopted })
  );
  results.push(projectCtx);
  results.push(
    await runCheck(s, "sessions mux", () =>
      checkSessionsMuxConfig({ startDir, adopted })
    )
  );

  results.push(
    ...(await runProjectChecks({
      progress: s,
      startDir,
      adopted,
      projectFound: projectCtx.status === "ok",
      dockerOk: results.some(
        (result) => result.name === "docker daemon" && result.status === "ok"
      ),
    }))
  );

  s.stop(`Doctor checks complete (${results.length} checks)`);

  const hasError = results.some((r) => r.status === "error");

  const reported = await reportDoctorResults({
    results,
    hasError,
    json,
    browserHintTargets: composeDoctorBrowserHintTargets({
      url: browser.url,
      defaultDomain,
    }),
    renderHuman: async () => {
      await renderDoctorSummary(results);
      emitSlowChecksNote(results);
      await renderMacNote(results);
    },
  });
  if (reported !== null) {
    return reported;
  }
  if (!args.options.fix) {
    await renderRecoveryGuidance(results);
  }

  if (args.options.fix || args.options.migrateEnvConfig) {
    await runDoctorFix({
      startDir,
      migrateEnvConfig: args.options.migrateEnvConfig === true,
      acceptTrackedEnvChanges: args.options.acceptTrackedEnvChanges === true,
    });
    note("Re-run: hack doctor", "doctor");
  }

  if (hasError) {
    note("Fix the errors above, then rerun: hack doctor", "doctor");
    return 1;
  }

  return 0;
};

/**
 * Compose doctor's browser check concerns the reported origin, else the
 * default domain.
 */
export function composeDoctorBrowserHintTargets(opts: {
  readonly url: string | null;
  readonly defaultDomain: string;
}): readonly string[] {
  return [opts.url ?? opts.defaultDomain];
}

/** Native doctor names a browser target only through `--browser-url`. */
export function nativeDoctorBrowserHintTargets(
  url: string | null
): readonly string[] {
  return url ? [url] : [];
}

/**
 * Writes the doctor report, then the macOS Local Network hint for the
 * browser targets. JSON mode writes the envelope to stdout and returns its
 * exit code; the hint goes to stderr afterwards, so the payload is unchanged.
 * Human mode runs `renderHuman` and returns null so the caller continues.
 * `noteHint` defaults to the process-wide hint; tests inject an emitter.
 */
export async function reportDoctorResults(opts: {
  readonly results: readonly TimedCheckResult[];
  readonly hasError: boolean;
  readonly json: boolean;
  readonly browserHintTargets: readonly string[];
  readonly renderHuman: () => Promise<void>;
  readonly noteHint?: (targets: readonly string[]) => boolean;
}): Promise<number | null> {
  const noteHint = opts.noteHint ?? noteBrowserTargetsForLocalNetworkHint;
  if (opts.json) {
    const code = finishDoctorJson({
      results: opts.results,
      hasError: opts.hasError,
    });
    noteHint(opts.browserHintTargets);
    return code;
  }
  await opts.renderHuman();
  noteHint(opts.browserHintTargets);
  return null;
}

function resolveDoctorStartDir(pathOption: string | undefined): string {
  return resolve(process.cwd(), pathOption ?? ".");
}

async function handleNativeDoctor(opts: {
  readonly runtime: NativeRuntimeSelection;
  /** Where project discovery starts for project-scoped checks. */
  readonly startDir: string;
  readonly browser: ReturnType<typeof parseBrowserNetworkOptions>;
  readonly json: boolean;
  readonly fix: boolean;
  /**
   * Runs the same project-file env migration as Compose doctor after the
   * checks. It changes project files only, so it needs no native runtime.
   */
  readonly migrateEnvConfig: boolean;
  readonly acceptTrackedEnvChanges: boolean;
}): Promise<number> {
  if (opts.migrateEnvConfig) {
    await assertTrackedEnvMigrationConsent({
      startDir: opts.startDir,
      accept: opts.acceptTrackedEnvChanges,
    });
  }
  const results: TimedCheckResult[] = [];
  const progress = createDoctorProgress({ json: opts.json });
  progress.start("Checking the active native HTTPS root...");
  const hostname = opts.browser.url
    ? new URL(opts.browser.url).hostname
    : undefined;
  if (opts.fix) {
    results.push(
      await runCheck(progress, "native ca repair", async () => {
        if (!isMac()) {
          return {
            name: "native ca repair",
            status: "error",
            message: "System-keychain repair requires macOS.",
          };
        }
        return await repairNativeCaTrustCheck({
          progress,
          runtime: opts.runtime,
          hostname,
        });
      })
    );
  }
  let inspected: Awaited<ReturnType<typeof inspectNativeCaTrust>> | undefined;
  try {
    inspected = await inspectNativeCaTrust({ runtime: opts.runtime });
    results.push({
      name: "native https owner",
      status: "ok",
      message: "Active Caddy listener and exact current root verified.",
      durationMs: 0,
    });
  } catch {
    results.push({
      name: "native https owner",
      status: "warn",
      message:
        "No verified active native Caddy listener/root. Trust cannot be inferred from a retained certificate or similarly named keychain entry.",
      durationMs: 0,
    });
  }
  if (inspected) {
    results.push({
      name: "native root trust",
      status: inspected.trust.trusted ? "ok" : "error",
      message: inspected.trust.trusted
        ? "Exact live root passes macOS System-keychain TLS trust."
        : (inspected.trust.issue ??
          "Exact live root is not trusted in the macOS System keychain."),
      durationMs: 0,
    });
    results.push({
      ...supersededRootsCheck(inspected.trust.supersededRoots),
      durationMs: 0,
    });
    if (hostname) {
      results.push(
        await runCheck(progress, "native https route", async () => {
          const after = await inspectNativeCaTrust({
            runtime: opts.runtime,
            hostname,
          });
          if (
            after.owner.listenerFingerprint !==
              inspected.owner.listenerFingerprint ||
            after.owner.caSha256 !== inspected.owner.caSha256
          ) {
            throw new Error(
              "Native HTTPS owner changed during route verification."
            );
          }
          return {
            name: "native https route",
            status: "ok",
            message: `${hostname} completed a loopback TLS handshake against the exact live root.`,
          };
        })
      );
    }
  } else {
    results.push({
      name: "native root trust",
      status: "warn",
      message: "Skipped until the active Caddy owner and root are verified.",
      durationMs: 0,
    });
  }
  if (isMac()) {
    results.push(
      ...(await checkNativeHackLocalRoute({
        progress,
        fix: opts.fix,
        dependencies: () =>
          createNativeHackLocalRouteDependencies({ runtime: opts.runtime }),
      }))
    );
  }
  if (hostname) {
    results.push(
      await runCheck(
        progress,
        "native host dns",
        () => checkNativeHostDns({ hostname }),
        { timeoutMs: 3000 }
      )
    );
  }
  if (opts.browser.url) {
    results.push(
      await runCheck(
        progress,
        "browser local network",
        () =>
          checkBrowserLocalNetwork({
            platform: process.platform,
            ...opts.browser,
          }),
        { timeoutMs: 7000 }
      )
    );
  }
  // The env key audit is runtime-independent; outside a project there is no
  // key to audit, so native Doctor adds no check there.
  const nativeProject = await findProjectContext(opts.startDir).catch(
    () => null
  );
  if (nativeProject) {
    results.push(
      await runCheck(
        progress,
        ENV_KEY_CHECK,
        () => checkProjectEnvKey({ startDir: opts.startDir }),
        { timeoutMs: 5000 }
      )
    );
    results.push(
      await runCheck(
        progress,
        SECRET_INTEGRITY_CHECK,
        () => checkSecretIntegrity({ startDir: opts.startDir }),
        { timeoutMs: 5000 }
      )
    );
    results.push(
      await runCheck(progress, COMPOSE_BACKEND_CHECK, () =>
        checkComposeBackendFeatures({
          startDir: opts.startDir,
          backend: "native",
        })
      )
    );
    results.push(
      await runCheck(progress, NATIVE_DATA_CHECK, () =>
        checkNativeDataAdvisories({ startDir: opts.startDir })
      )
    );
    results.push(
      await runCheck(progress, AMD64_EMULATION_CHECK, () =>
        checkNativeAmd64Emulation({ startDir: opts.startDir })
      )
    );
    results.push(
      await runCheck(
        progress,
        NATIVE_SETTINGS_CHECK,
        () => checkNativeProjectSettings({ startDir: opts.startDir }),
        { timeoutMs: 5000 }
      )
    );
    results.push(
      await runCheck(progress, NATIVE_PROCESS_CHECK, () =>
        checkNativeProcessWrappers({ startDir: opts.startDir })
      )
    );
    results.push(
      await runCheck(
        progress,
        NATIVE_SOURCE_CHECK,
        () =>
          checkNativeSourceSize({
            runtime: opts.runtime,
            projectRoot: nativeProject.projectRoot,
          }),
        { timeoutMs: 25_000 }
      )
    );
  }
  progress.stop(`Native doctor checks complete (${results.length} checks)`);
  const hasError = results.some((result) => result.status === "error");
  const reported = await reportDoctorResults({
    results,
    hasError,
    json: opts.json,
    browserHintTargets: nativeDoctorBrowserHintTargets(opts.browser.url),
    renderHuman: () => renderDoctorSummary(results),
  });
  if (reported !== null) {
    return reported;
  }
  if (!opts.browser.url) {
    note(
      "Pass --browser-url https://your-app.hack.local --browser-result works|fails|permission-denied to check an exact app route and record a separate browser observation.",
      "Native HTTPS"
    );
  }
  await maybeRunNativeDoctorEnvMigration(opts);
  return hasError ? 1 : 0;
}

/**
 * Native doctor's `--migrate-env-config`: the same project-file migration as
 * Compose doctor, including its consent for git-tracked files. It needs no
 * Docker and no native runtime.
 */
async function maybeRunNativeDoctorEnvMigration(opts: {
  readonly startDir: string;
  readonly migrateEnvConfig: boolean;
  readonly acceptTrackedEnvChanges: boolean;
}): Promise<void> {
  if (!opts.migrateEnvConfig) {
    return;
  }
  await maybeMigrateProjectEnvConfig({
    startDir: opts.startDir,
    acceptTrackedChanges: opts.acceptTrackedEnvChanges,
  });
  note("Re-run: hack doctor", "doctor");
}

/**
 * The `native ca repair` check body. The spinner is released at the trust
 * confirmation and stays off through the administrator prompt and the sudo -n
 * install, so nothing erases the password prompt.
 */
export async function repairNativeCaTrustCheck(opts: {
  readonly progress: DoctorProgress;
  readonly runtime: NativeRuntimeSelection;
  readonly hostname: string | undefined;
  readonly dependencies?: Partial<NativeCaDoctorDependencies>;
}): Promise<CheckResult> {
  const confirm = opts.dependencies?.confirm ?? confirmSafe;
  const repaired = await withTerminalHandoff(
    opts.progress,
    async (claim) =>
      await repairNativeCaTrust({
        runtime: opts.runtime,
        hostname: opts.hostname,
        dependencies: {
          ...opts.dependencies,
          confirm: async (prompt) => {
            claim();
            return await confirm(prompt);
          },
        },
      })
  );
  const messages = {
    installed: "Verified live native root installed in the System keychain.",
    "already-trusted": "Verified live native root was already trusted.",
    declined:
      "Trust repair requires an interactive confirmation and native administrator prompt.",
  } as const;
  return {
    name: "native ca repair",
    status: repaired === "declined" ? "warn" : "ok",
    message: messages[repaired],
  };
}

/**
 * Report, and with --fix authorize and apply, the native hack.local route
 * repair. Refusals are warnings with a closed reason; only an unexpected
 * failure is an error.
 */
export async function checkNativeHackLocalRoute(opts: {
  readonly progress: DoctorProgress;
  readonly fix: boolean;
  readonly dependencies: () => Promise<HackLocalRouteDependencies>;
}): Promise<readonly TimedCheckResult[]> {
  const results: TimedCheckResult[] = [];
  let deps: HackLocalRouteDependencies;
  try {
    deps = await opts.dependencies();
  } catch (error) {
    return [
      {
        name: HACK_LOCAL_ROUTE_CHECK,
        status: "warn",
        message: printable(
          `Unable to inspect the hack.local route: ${error instanceof Error ? error.message : String(error)}`
        ),
        durationMs: 0,
      },
    ];
  }
  if (opts.fix) {
    results.push(
      await runCheck(opts.progress, HACK_LOCAL_REPAIR_CHECK, async () => {
        // Release the terminal before the first prompt and keep it released
        // through the administrator prompt and every later sudo -n step.
        const repaired = await withTerminalHandoff(
          opts.progress,
          async (claim) =>
            await repairHackLocalRoute({
              ...deps,
              authorize: async (message) => {
                claim();
                return await deps.authorize(message);
              },
              confirm: async (message) => {
                claim();
                return await deps.confirm(message);
              },
            })
        );
        if (repaired.outcome === "repaired") {
          return {
            name: HACK_LOCAL_REPAIR_CHECK,
            status: "ok",
            message: printable(
              `Rewrote "${repaired.receipt.oldLine}" to "${repaired.receipt.newLine}"${
                repaired.receipt.resolverAction === "create"
                  ? ` and created ${repaired.receipt.resolverPath}`
                  : ""
              }; live DNS verified. Receipt: ${deps.paths.receiptPath}. Undo with: ${HACK_LOCAL_ROLLBACK_COMMAND}`
            ),
          };
        }
        if (repaired.outcome === "current") {
          return {
            name: HACK_LOCAL_REPAIR_CHECK,
            status: "ok",
            message:
              "No repair needed; *.hack.local already routes to the native relay.",
          };
        }
        return {
          name: HACK_LOCAL_REPAIR_CHECK,
          status: "warn",
          message: printable(
            `Repair refused (${repaired.reason}): ${repaired.detail}`
          ),
        };
      })
    );
  }
  results.push(
    await runCheck(opts.progress, HACK_LOCAL_ROUTE_CHECK, async () => {
      const report = reportHackLocalRoute(await inspectHackLocalRoute(deps));
      return {
        name: HACK_LOCAL_ROUTE_CHECK,
        status: report.status === "current" ? "ok" : "warn",
        message: describeHackLocalRoute(report),
        hackLocalRoute: report,
      };
    })
  );
  return results;
}

export type DoctorJsonCheck = {
  readonly id: string;
  readonly status: CheckStatus;
  readonly detail: string;
  readonly durationMs: number;
  /** Present only on the superseded Caddy roots check. */
  readonly supersededRoots?: SupersededRootInventory;
  /** Present only on the native hack.local route check. */
  readonly hackLocalRoute?: HackLocalRouteReport;
  /** Present only on the env key check: closed codes, no key bytes or absolute paths. */
  readonly envKey?: EnvKeyInspection;
  /** Present only on the local CA trust check (`docs/reference/local-ca-trust.md`). */
  readonly caTrust?: CaTrustReport;
  /** Present only on the Compose-backend feature check: closed feature names. */
  readonly composeBackend?: ComposeBackendReport;
  /** Present only on the native data-service check: closed codes and service names. */
  readonly nativeData?: NativeDataReport;
  /** Present only on the native amd64 emulation check: counts only. */
  readonly amd64Emulation?: Amd64EmulationReport;
  /** Present only on the native settings check: origins and closed warnings. */
  readonly nativeSettings?: NativeSettingsReport;
  /** Present only on the native process-wrapper check: service names and closed fields. */
  readonly nativeProcess?: NativeProcessReport;
  /** Present only on the native source size check: sizes and project-relative paths. */
  readonly nativeSource?: NativeSourceReport;
};

export type DoctorJsonData = {
  readonly checks: readonly DoctorJsonCheck[];
  readonly summary: readonly string[];
  readonly counts: {
    readonly ok: number;
    readonly warn: number;
    readonly error: number;
  };
};

/**
 * Shape the doctor check results for the `--json` envelope.
 */
export function buildDoctorJsonData(opts: {
  readonly results: readonly TimedCheckResult[];
}): DoctorJsonData {
  const counts = { ok: 0, warn: 0, error: 0 };
  for (const result of opts.results) {
    counts[result.status] += 1;
  }
  return {
    checks: opts.results.map((result) => ({
      id: result.name,
      status: result.status,
      detail: result.message,
      durationMs: result.durationMs,
      ...(result.supersededRoots
        ? { supersededRoots: result.supersededRoots }
        : {}),
      ...(result.hackLocalRoute
        ? { hackLocalRoute: result.hackLocalRoute }
        : {}),
      ...(result.envKey ? { envKey: result.envKey } : {}),
      ...(result.caTrust ? { caTrust: result.caTrust } : {}),
      ...(result.composeBackend
        ? { composeBackend: result.composeBackend }
        : {}),
      ...(result.nativeData ? { nativeData: result.nativeData } : {}),
      ...(result.amd64Emulation
        ? { amd64Emulation: result.amd64Emulation }
        : {}),
      ...(result.nativeSettings
        ? { nativeSettings: result.nativeSettings }
        : {}),
      ...(result.nativeProcess ? { nativeProcess: result.nativeProcess } : {}),
      ...(result.nativeSource ? { nativeSource: result.nativeSource } : {}),
    })),
    summary: buildDoctorSummaryLines({ results: opts.results }),
    counts,
  };
}

/**
 * JSON tail for `hack doctor --json`: emits the envelope and maps error
 * checks to exit 1. `--fix` is intentionally not combined with `--json`.
 */
function finishDoctorJson(opts: {
  readonly results: readonly TimedCheckResult[];
  readonly hasError: boolean;
}): number {
  emitCliResult({
    result: okResult({ data: buildDoctorJsonData({ results: opts.results }) }),
  });
  return opts.hasError ? 1 : 0;
}

export function assertDoctorOptionCompatibility(opts: {
  readonly json: boolean;
  readonly fix: boolean;
  readonly migrateEnvConfig: boolean;
  readonly acceptTrackedEnvChanges?: boolean;
}): void {
  if (opts.json && (opts.fix || opts.migrateEnvConfig)) {
    throw new CliUsageError(
      "--json cannot be combined with --fix or --migrate-env-config because repair commands mutate state. Run the repair and JSON audit separately."
    );
  }
  if (opts.acceptTrackedEnvChanges === true && !opts.migrateEnvConfig) {
    throw new CliUsageError(
      "--accept-tracked-env-changes applies only to --migrate-env-config."
    );
  }
}

type DoctorProgress = PausableProgress;

/**
 * Spinner wrapper that stays silent on non-TTY stdout (piped/automation) so
 * cursor-control ANSI sequences never leak into machine-read output, and
 * emits nothing at all in `--json` mode.
 */
function createDoctorProgress(opts: {
  readonly json: boolean;
}): DoctorProgress {
  const interactive =
    !opts.json &&
    process.stdout.isTTY === true &&
    (process.env.NO_COLOR ?? "").trim().length === 0;
  if (interactive) {
    return pausableSpinner(spinner());
  }

  return {
    start: (_message?: string) => {
      // Quiet in non-TTY/JSON mode.
    },
    pause: () => undefined,
    resume: () => undefined,
    stop: (message?: string) => {
      if (!opts.json && message) {
        process.stdout.write(`${message}\n`);
      }
    },
  };
}

export const doctorCommand = withHandler(doctorSpec, handleDoctor);

async function checkTool(opts: {
  readonly name: string;
  readonly cmd: string;
  readonly optional?: boolean;
}): Promise<CheckResult> {
  const path = await findExecutableInPath(opts.cmd);
  let status: CheckStatus;
  let message: string;
  if (path) {
    status = "ok";
    message = path;
  } else if (opts.optional) {
    status = "warn";
    message = "Not found (optional)";
  } else {
    status = "error";
    message = "Not found in PATH";
  }

  return { name: opts.name, status, message };
}

function muxInstallCommand(opts: {
  readonly provider: "tmux" | "zellij";
}): string {
  if (isMac()) {
    return `brew install ${opts.provider}`;
  }
  return `install ${opts.provider} with your package manager`;
}

async function checkSessionsMuxConfig(opts: {
  readonly startDir: string;
  readonly adopted?: DoctorAdoptedProject | null;
}): Promise<CheckResult> {
  // An adopted project's config belongs to the adoption: global settings only.
  const project = opts.adopted ? null : await findProjectContext(opts.startDir);
  const mode = await resolveSessionsMuxMode({ project });
  const tmuxPath = findExecutableInPath("tmux");
  const zellijPath = findExecutableInPath("zellij");

  if (mode === "none") {
    return {
      name: "sessions mux",
      status: "ok",
      message: "sessions.mux=none (session management disabled)",
    };
  }

  if (mode === "tmux") {
    if (!tmuxPath) {
      return {
        name: "sessions mux",
        status: "warn",
        message: `sessions.mux=tmux, but tmux is missing (run: ${muxInstallCommand({ provider: "tmux" })})`,
      };
    }
    return {
      name: "sessions mux",
      status: "ok",
      message: `sessions.mux=tmux (${tmuxPath})`,
    };
  }

  if (mode === "zellij") {
    if (!zellijPath) {
      return {
        name: "sessions mux",
        status: "warn",
        message: `sessions.mux=zellij, but zellij is missing (run: ${muxInstallCommand({ provider: "zellij" })})`,
      };
    }
    return {
      name: "sessions mux",
      status: "ok",
      message: `sessions.mux=zellij (${zellijPath})`,
    };
  }

  if (tmuxPath) {
    return {
      name: "sessions mux",
      status: "ok",
      message: `sessions.mux=auto (using tmux: ${tmuxPath})`,
    };
  }

  if (zellijPath) {
    return {
      name: "sessions mux",
      status: "ok",
      message: `sessions.mux=auto (using zellij: ${zellijPath})`,
    };
  }

  return {
    name: "sessions mux",
    status: "warn",
    message: `sessions.mux=auto, but neither tmux nor zellij is available (run: ${muxInstallCommand({ provider: "tmux" })})`,
  };
}

function checkOptionalGum(): CheckResult {
  const gum = getGumPath();
  if (!gum) {
    return {
      name: "gum (optional)",
      status: "warn",
      message: "gum not found (optional)",
    };
  }
  return { name: "gum (optional)", status: "ok", message: gum };
}

function checkOptionalFzf(): CheckResult {
  const fzf = getFzfPath();
  if (!fzf) {
    return {
      name: "fzf (optional)",
      status: "warn",
      message: "fzf not found (optional)",
    };
  }
  return { name: "fzf (optional)", status: "ok", message: fzf };
}

async function checkMutagenBinary(): Promise<CheckResult> {
  const mutagen = getMutagenPath();
  if (!mutagen) {
    return {
      name: "mutagen",
      status: "warn",
      message: "Not found (run: hack doctor --fix)",
    };
  }

  const managedMutagenPath = getManagedMutagenInstallPath();
  const managedAgentBundlePath = getManagedMutagenAgentBundlePath();
  if (
    managedMutagenPath &&
    managedAgentBundlePath &&
    mutagen === managedMutagenPath &&
    !(await pathExists(managedAgentBundlePath))
  ) {
    return {
      name: "mutagen",
      status: "warn",
      message: "Managed mutagen agent bundle missing (run: hack doctor --fix)",
    };
  }

  const version = await exec([mutagen, "version"], { stdin: "ignore" });
  if (version.exitCode !== 0) {
    return {
      name: "mutagen",
      status: "warn",
      message: `${mutagen} (version probe failed)`,
    };
  }

  const firstLine = version.stdout.trim().split("\n")[0]?.trim();
  return {
    name: "mutagen",
    status: "ok",
    message: firstLine && firstLine.length > 0 ? firstLine : mutagen,
  };
}

async function checkDockerRunning(): Promise<CheckResult> {
  const res = await exec(["docker", "info"], { stdin: "ignore" });
  return {
    name: "docker daemon",
    status: res.exitCode === 0 ? "ok" : "error",
    message:
      res.exitCode === 0
        ? "Docker is running"
        : "Docker daemon is not reachable",
  };
}

async function checkDockerNetwork(name: string): Promise<CheckResult> {
  const res = await exec(["docker", "network", "inspect", name], {
    stdin: "ignore",
  });
  return {
    name: `network:${name}`,
    status: res.exitCode === 0 ? "ok" : "error",
    message:
      res.exitCode === 0
        ? `Exists (${name})`
        : `Missing (${name}) (run: hack global install)`,
  };
}

async function checkIngressSubnet(): Promise<CheckResult> {
  const inspect = await inspectDockerNetwork(DEFAULT_INGRESS_NETWORK);
  if (!inspect.exists) {
    return {
      name: `network:${DEFAULT_INGRESS_NETWORK} subnet`,
      status: "warn",
      message: `Missing ${DEFAULT_INGRESS_NETWORK} (run: hack global install)`,
    };
  }

  if (!inspect.hasSubnet) {
    return {
      name: `network:${DEFAULT_INGRESS_NETWORK} subnet`,
      status: "warn",
      message: `Missing subnet ${DEFAULT_INGRESS_SUBNET} (run: hack doctor --fix)`,
    };
  }

  return {
    name: `network:${DEFAULT_INGRESS_NETWORK} subnet`,
    status: "ok",
    message: `Subnet ${DEFAULT_INGRESS_SUBNET} present`,
  };
}

async function checkGlobalFiles(): Promise<CheckResult> {
  const root = resolveGlobalHackDir();
  const caddyCompose = resolve(
    root,
    GLOBAL_CADDY_DIR_NAME,
    GLOBAL_CADDY_COMPOSE_FILENAME
  );
  const loggingCompose = resolve(
    root,
    GLOBAL_LOGGING_DIR_NAME,
    GLOBAL_LOGGING_COMPOSE_FILENAME
  );

  const ok =
    (await pathExists(caddyCompose)) && (await pathExists(loggingCompose));
  return {
    name: "global files",
    status: ok ? "ok" : "warn",
    message: ok
      ? root
      : `Missing compose files under ${root} (run: hack global install)`,
  };
}

async function checkDaemonStatus(): Promise<CheckResult> {
  const paths = resolveDaemonPaths({});
  const status = await readDaemonStatus({ paths });
  const probe = status.socketExists
    ? await probeDaemonApi({ socketPath: paths.socketPath, timeoutMs: 500 })
    : { reachable: false, compatible: false, version: null };

  const report = await withSystemdIncompatibleNextStep({
    report: buildDaemonStatusReport({
      pid: status.pid,
      processRunning: status.running,
      socketExists: status.socketExists,
      logExists: status.logExists,
      apiReachable: probe.reachable,
      apiCompatible: probe.compatible,
    }),
  });

  return buildDoctorDaemonCheck({ report, candidate: isCandidateRun() });
}

async function checkGatewayConfig(): Promise<CheckResult> {
  const resolved = await resolveGatewayConfig();
  const configPath = resolveGlobalConfigPath();
  if (!resolved.config.enabled) {
    return {
      name: "gateway config",
      status: "ok",
      message: `Gateway disabled (enable per project if needed). Global config: ${configPath}`,
    };
  }

  const warningSuffix =
    resolved.warnings.length > 0
      ? ` | warnings: ${resolved.warnings.join(" | ")}`
      : "";

  return {
    name: "gateway config",
    status: resolved.warnings.length > 0 ? "warn" : "ok",
    message: [
      `Enabled (projects: ${resolved.enabledProjects.length})`,
      `bind=${resolved.config.bind}`,
      `port=${resolved.config.port}`,
      `allowWrites=${resolved.config.allowWrites}`,
      `global=${configPath}${warningSuffix}`,
    ].join(" | "),
  };
}

async function checkGatewayTokens(): Promise<CheckResult> {
  const daemonPaths = resolveDaemonPaths({});
  const { tokens, untrusted } = await listGatewayTokensForStatus({
    rootDir: daemonPaths.root,
  });
  if (untrusted !== null) {
    return { name: "gateway tokens", status: "warn", message: untrusted };
  }
  const active = tokens.filter((token) => !token.revokedAt);
  const revoked = tokens.filter((token) => token.revokedAt);
  const writeTokens = active.filter((token) => token.scope === "write");
  const readTokens = active.filter((token) => token.scope === "read");

  const gateway = await resolveGatewayConfig();
  if (gateway.config.enabled && active.length === 0) {
    return {
      name: "gateway tokens",
      status: "warn",
      message: "No active tokens (run: hack x gateway token-create)",
    };
  }

  return {
    name: "gateway tokens",
    status: "ok",
    message: `active=${active.length} (write=${writeTokens.length}, read=${readTokens.length}), revoked=${revoked.length}`,
  };
}

export async function checkCoreDnsForwarding(): Promise<CheckResult> {
  const server = await resolveCoreDnsServer();
  if (!server) {
    return {
      name: "coredns forwarding",
      status: "warn",
      message: "CoreDNS not running (run: hack global up)",
    };
  }

  const ip = await queryDnsARecord({
    hostname: "example.com",
    server,
    port: 53,
    timeoutMs: 900,
  });

  return {
    name: "coredns forwarding",
    status: ip ? "ok" : "warn",
    message: ip
      ? `example.com → ${ip} (via ${server})`
      : "SERVFAIL (run: hack doctor --fix)",
  };
}

const LOCAL_CA_TRUST_CHECK = "local ca trust";

/**
 * Whether the system trust store (and, on Linux, NSS) trusts the exported
 * Caddy Local CA (HACK-2218, R16). Read-only and bounded; `caddy local ca`
 * checks the export itself. Unknown is a warning that says so.
 */
export async function checkLocalCaTrust(): Promise<CheckResult> {
  const helperEnv = vettedHelperEnv();
  const report = await inspectCaTrust({
    platform: process.platform,
    caPath: getGlobalPaths().caddyCaCert,
    readText: readTextOutcome,
    query: async (argv, queryOpts) =>
      await exec(argv, {
        stdin: "ignore",
        timeoutMs: queryOpts.timeoutMs,
        env: { ...helperEnv.env },
        unsetEnvKeys: helperEnv.unsetEnvKeys,
      }).catch(() => ({ exitCode: 127, stdout: "", stderr: "" })),
    ...(isLinux() ? { linuxHost: createLinuxTrustHost() } : {}),
    exists: pathExistsOutcome,
    listDir: listDirOutcome,
    now: () => Date.now(),
  });
  return {
    name: LOCAL_CA_TRUST_CHECK,
    status: report.state === "trusted" ? "ok" : "warn",
    message: describeCaTrust(report),
    caTrust: report,
  };
}

function describeCaTrust(report: CaTrustReport): string {
  const nss = report.nss
    .filter((db) => db.state !== "trusted")
    .map((db) => `${db.db}: ${db.detail}`);
  if (report.state === "trusted") {
    const browsers =
      report.nss.length > 0 ? ` and ${report.nss.length} NSS database(s)` : "";
    return `Trusted by ${report.system.store ?? "the system"}${browsers}`;
  }
  const lead =
    report.state === "unknown"
      ? "Could not tell whether the local CA is trusted"
      : "The local CA is not trusted everywhere";
  return [`${lead}: ${report.system.detail}`, ...nss].join("; ");
}

export async function checkCaddyLocalCa(): Promise<CheckResult> {
  const paths = getGlobalPaths();
  const identity = await inspectCaddyCaIdentity({
    certPath: paths.caddyCaCert,
  });
  return {
    name: "caddy local ca",
    status: identity.state === "current" ? "ok" : "warn",
    message: identity.message,
  };
}

/** Linux resolver route for Hack's suffixes; see `lib/linux-dns.ts`. */
async function checkLinuxDnsRoute(): Promise<CheckResult> {
  const inspection = await inspectLinuxGlobalDns();
  return {
    name: LINUX_DNS_ROUTE_CHECK,
    status: inspection.state === "configured" ? "ok" : "warn",
    message: [
      inspection.code
        ? `${inspection.message} (code=${inspection.code})`
        : inspection.message,
      ...inspection.fix.map((line) => `fix: ${line}`),
    ].join("\n"),
  };
}

async function appendCustomDomainDnsChecks(opts: {
  readonly results: TimedCheckResult[];
  readonly progress: DoctorProgress;
  readonly defaultDomain: string;
}): Promise<void> {
  const { results, progress, defaultDomain } = opts;
  const builtInDomains: ReadonlySet<string> = new Set([
    DEFAULT_NEW_PROJECT_TLD,
    DEFAULT_PROJECT_TLD,
    DEFAULT_OAUTH_ALIAS_ROOT,
  ]);
  if (builtInDomains.has(defaultDomain)) {
    return;
  }
  if (isMac()) {
    results.push(
      await runCheck(progress, `resolver:${defaultDomain}`, () =>
        checkMacResolverForDomain(defaultDomain)
      )
    );
    results.push(
      await runCheck(progress, `dnsmasq.conf:${defaultDomain}`, () =>
        checkMacDnsmasqConfigForDomain(defaultDomain)
      )
    );
  }
  results.push(
    await runCheck(
      progress,
      `dns:${defaultDomain}`,
      () => checkHackLocalDns({ domain: defaultDomain }),
      { timeoutMs: 3000 }
    )
  );
}

/** The native HTTPS relay is bound to IPv4 loopback; other DNS answers cannot reach it. */
export async function checkNativeHostDns(opts: {
  readonly hostname: string;
  readonly lookupAll?: (
    hostname: string
  ) => Promise<readonly { address: string }[]>;
}): Promise<CheckResult> {
  try {
    const addresses = await (
      opts.lookupAll ?? ((hostname) => lookup(hostname, { all: true }))
    )(opts.hostname);
    const ready =
      addresses.length > 0 &&
      addresses.every((entry) => entry.address === DEFAULT_HOST_DNS_IP);
    return {
      name: "native host dns",
      status: ready ? "ok" : "warn",
      message: ready
        ? `${opts.hostname} resolves to the native loopback HTTPS relay.`
        : `${opts.hostname} has a non-loopback DNS answer; the native HTTPS relay is bound to ${DEFAULT_HOST_DNS_IP}.`,
    };
  } catch {
    return {
      name: "native host dns",
      status: "warn",
      message: `Unable to resolve ${opts.hostname} for the native HTTPS relay.`,
    };
  }
}

/** DNS observation only; it does not assert an HTTP service exists at this probe name. */
export async function checkHackLocalDns(
  opts: {
    readonly lookup?: (host: string) => Promise<{ address: string }>;
    readonly caddyIp?: () => Promise<string | null>;
    readonly domain?: string;
  } = {}
): Promise<CheckResult> {
  const domain = opts.domain ?? DEFAULT_NEW_PROJECT_TLD;
  const host = `doctor.${domain}`;
  const name = `dns:${domain}`;
  try {
    const { address } = await (opts.lookup ?? lookup)(host);
    let ok = [DEFAULT_CADDY_IP, DEFAULT_HOST_DNS_IP, "::1"].includes(address);
    if (!ok) {
      ok = address === (await (opts.caddyIp ?? resolveGlobalCaddyIp)());
    }
    return {
      name,
      status: ok ? "ok" : "warn",
      message: `${host} → ${address}`,
    };
  } catch {
    return {
      name,
      status: "warn",
      message: `Unable to resolve ${host} (run: hack global install)`,
    };
  }
}

async function checkHackDns(): Promise<CheckResult> {
  try {
    const res = await lookup(LEGACY_GRAFANA_HOST);
    const ok =
      res.address === DEFAULT_CADDY_IP ||
      res.address === "127.0.0.1" ||
      res.address === "::1";
    return {
      name: `dns:${DEFAULT_PROJECT_TLD}`,
      status: ok ? "ok" : "warn",
      message: `${LEGACY_GRAFANA_HOST} → ${res.address}`,
    };
  } catch {
    return {
      name: `dns:${DEFAULT_PROJECT_TLD}`,
      status: "warn",
      message: `Unable to resolve ${LEGACY_GRAFANA_HOST} (run: hack global install)`,
    };
  }
}

async function checkOauthAliasDns(): Promise<CheckResult> {
  const host = `logs.${DEFAULT_OAUTH_ALIAS_ROOT}`;
  try {
    const res = await lookup(host);
    const ok =
      res.address === DEFAULT_CADDY_IP ||
      res.address === "127.0.0.1" ||
      res.address === "::1";
    return {
      name: `dns:${DEFAULT_OAUTH_ALIAS_ROOT}`,
      status: ok ? "ok" : "warn",
      message: `${host} → ${res.address}`,
    };
  } catch {
    return {
      name: `dns:${DEFAULT_OAUTH_ALIAS_ROOT}`,
      status: "warn",
      message: `Unable to resolve ${host} (run: hack global install)`,
    };
  }
}

async function checkGrafanaReachable(): Promise<CheckResult> {
  const host = await resolveInstalledGrafanaHost();
  if (!host) {
    return {
      name: "grafana",
      status: "warn",
      message:
        "Cannot identify configured Grafana route; review global logging Compose configuration",
    };
  }
  // Best-effort; TLS may fail if CA isn't trusted. Don't error on this.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://${host}`, {
      signal: controller.signal,
      redirect: "manual",
    });
    clearTimeout(timeout);
    return {
      name: "grafana",
      status:
        res.ok ||
        res.status === 301 ||
        res.status === 302 ||
        res.status === 307 ||
        res.status === 308
          ? "ok"
          : "warn",
      message: `http://${host} → ${res.status}`,
    };
  } catch {
    return {
      name: "grafana",
      status: "warn",
      message: `Unable to reach http://${host} (is global infra up?)`,
    };
  }
}

async function checkProject({
  startDir,
  adopted,
}: {
  readonly startDir: string;
  readonly adopted: DoctorAdoptedProject | null;
}): Promise<CheckResult> {
  if (adopted) {
    return adoptedProjectCheckResult(adopted);
  }
  const ctx = await findProjectContext(startDir);
  if (ctx) {
    return {
      name: "project",
      status: "ok",
      message: `Found ${HACK_PROJECT_DIR_PRIMARY}/ (or legacy .dev/) at ${dirname(ctx.composeFile)}`,
    };
  }
  return {
    name: "project",
    status: "warn",
    message: `No ${HACK_PROJECT_DIR_PRIMARY}/ found in current path (run 'hack init' in a repo)`,
  };
}

async function checkDevHost({
  startDir,
}: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const ctx = await findProjectContext(startDir);
  if (!ctx) {
    return {
      name: "DEV_HOST",
      status: "warn",
      message: `Missing ${HACK_PROJECT_DIR_PRIMARY}/ (run 'hack init' in a repo)`,
    };
  }

  const cfg = await readProjectConfig(ctx);
  const envHost = await readLegacyEnvDevHost(ctx.envFile);
  const configPath = cfg.configPath ?? ctx.configFile;

  if (cfg.parseError) {
    return {
      name: "DEV_HOST",
      status: "warn",
      message: envHost
        ? `Invalid ${configPath}: ${cfg.parseError} (legacy DEV_HOST=${envHost} in ${ctx.envFile})`
        : `Invalid ${configPath}: ${cfg.parseError}`,
    };
  }

  if (cfg.devHost) {
    return {
      name: "DEV_HOST",
      status: "ok",
      message: cfg.devHost,
    };
  }

  if (envHost) {
    return {
      name: "DEV_HOST",
      status: "warn",
      message: `Using legacy DEV_HOST=${envHost} from ${ctx.envFile} (move to ${ctx.configFile})`,
    };
  }

  const devHost = await readProjectDevHost(ctx);
  return {
    name: "DEV_HOST",
    status: devHost ? "ok" : "warn",
    message: devHost ? devHost : `Missing dev_host in ${configPath}`,
  };
}

async function checkProjectRuntimeHygiene({
  startDir,
}: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const ctx = await findProjectContext(startDir);
  if (!ctx) {
    return {
      name: "runtime hygiene",
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
    };
  }

  const [registry, runtimeResult] = await Promise.all([
    readProjectsRegistry(),
    readRuntimeProjects({ includeGlobal: false }),
  ]);

  if (!runtimeResult.ok) {
    return {
      name: "runtime hygiene",
      status: "warn",
      message: "Skipped (docker runtime unavailable)",
    };
  }
  const scoped = scopeRuntimeHygieneToProject({
    projectRoot: ctx.projectRoot,
    projectDir: ctx.projectDir,
    projects: registry.projects,
    runtime: runtimeResult.runtime,
  });
  const baseProjectName = await resolveDoctorBaseProjectName(ctx);

  const [missing, orphaned] = await Promise.all([
    findMissingRegistryEntries({ projects: scoped.projects }),
    findOrphanRuntimeProjects({ runtime: scoped.runtime }),
  ]);
  const incomplete = findIncompleteRuntimeProjects({ runtime: scoped.runtime });

  if (
    missing.length === 0 &&
    orphaned.length === 0 &&
    incomplete.length === 0
  ) {
    return {
      name: "runtime hygiene",
      status: "ok",
      message: "No missing registry entries or orphaned runtime containers",
    };
  }

  const details: string[] = [];
  if (missing.length > 0) {
    const names = missing.map((entry) => entry.project.name).join(", ");
    details.push(
      `${missing.length} missing registry entr${missing.length === 1 ? "y" : "ies"}: ${names}`
    );
  }
  if (orphaned.length > 0) {
    const names = orphaned.map((entry) => entry.project).join(", ");
    details.push(
      `${orphaned.length} orphaned runtime project${orphaned.length === 1 ? "" : "s"}: ${names}`
    );
  }
  if (incomplete.length > 0) {
    const names = incomplete
      .map((entry) => `${entry.project} [${entry.createdServices.join(", ")}]`)
      .join("; ");
    details.push(
      `${incomplete.length} incomplete runtime project${incomplete.length === 1 ? "" : "s"} with containers stuck in Created: ${names}`
    );
  }

  const guidance = [
    ...(missing.length > 0 || orphaned.length > 0
      ? [`run: hack projects prune --project ${baseProjectName}`]
      : []),
    ...(incomplete.length > 0 ? ["repair: hack doctor --fix"] : []),
  ];

  return {
    name: "runtime hygiene",
    status: "warn",
    message: `${details.join("; ")} (${guidance.join("; ")})`,
  };
}

async function checkProjectLifecycleHygiene({
  startDir,
}: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const ctx = await findProjectContext(startDir);
  if (!ctx) {
    return {
      name: "lifecycle hygiene",
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
    };
  }

  const inspection = await inspectProjectLifecycleHygiene({
    projectDir: ctx.projectDir,
    projectRoot: ctx.projectRoot,
  });
  if (
    inspection.staleEntries.length === 0 &&
    inspection.orphanedProcessGroups.length === 0 &&
    inspection.orphanedSessions.length === 0 &&
    inspection.unverifiedSessions.length === 0
  ) {
    return {
      name: "lifecycle hygiene",
      status: "ok",
      message:
        "No stale lifecycle state entries or orphaned lifecycle processes",
    };
  }

  const orphanedGroups = new Set<number>(inspection.orphanedProcessGroups);
  for (const entry of inspection.staleEntries) {
    for (const group of entry.liveProcessGroups) {
      orphanedGroups.add(group);
    }
  }

  const details = [
    ...(inspection.staleEntries.length > 0
      ? [
          `${inspection.staleEntries.length} stale lifecycle state entr${inspection.staleEntries.length === 1 ? "y" : "ies"}`,
        ]
      : []),
    ...(orphanedGroups.size > 0
      ? [
          `${orphanedGroups.size} orphaned lifecycle process group${orphanedGroups.size === 1 ? "" : "s"}`,
        ]
      : []),
    ...(inspection.orphanedSessions.length > 0
      ? [
          `${inspection.orphanedSessions.length} owned lifecycle session${inspection.orphanedSessions.length === 1 ? "" : "s"} without a running instance`,
        ]
      : []),
    ...(inspection.unverifiedSessions.length > 0
      ? [
          `${inspection.unverifiedSessions.length} same-name lifecycle session collision${inspection.unverifiedSessions.length === 1 ? "" : "s"} with unverified ownership`,
        ]
      : []),
  ];

  let nextStep = "run: hack down";
  if (inspection.orphanedSessions.length > 0) {
    nextStep = "run: hack doctor --fix";
  } else if (inspection.unverifiedSessions.length > 0) {
    nextStep = "manual review required; no session was modified";
  }

  return {
    name: "lifecycle hygiene",
    status: "warn",
    message: `${details.join("; ")} (${nextStep})`,
  };
}

async function checkProjectEnvMode({
  startDir,
}: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const ctx = await findProjectContext(startDir);
  if (!ctx) {
    return {
      name: "env mode",
      status: "warn",
      message: `Missing ${HACK_PROJECT_DIR_PRIMARY}/ (run 'hack init' in a repo)`,
    };
  }

  const cfg = await readProjectConfig(ctx);
  const configPath = cfg.configPath ?? ctx.configFile;
  if (cfg.parseError) {
    return {
      name: "env mode",
      status: "warn",
      message: `Invalid ${configPath}: ${cfg.parseError}`,
    };
  }

  const format = await doctorEnvFormat({ projectDir: ctx.projectDir });
  if (format.kind === "conflict") {
    return { name: "env mode", status: "error", message: format.message };
  }
  if (format.kind === "layers") {
    const defaultOverlay =
      cfg.env?.defaultOverlay ?? cfg.defaultEnvConfig ?? null;
    return {
      name: "env mode",
      status: "ok",
      message: defaultOverlay
        ? `Pulumi-style env config files enabled (default overlay: ${defaultOverlay})`
        : "Pulumi-style env config files enabled (default overlay: none)",
    };
  }

  const contractPath = resolve(ctx.projectDir, PROJECT_ENV_CONTRACT_FILENAME);
  const contract = await readHackEnvContract({ projectDir: ctx.projectDir });
  if (!contract.exists) {
    return {
      name: "env mode",
      status: "warn",
      message: `Missing ${contractPath} and no .hack/hack.env.default.yaml present`,
    };
  }
  // The migration refuses this contract, so don't send the user to it. The parser's
  // message isn't printed, because it can quote the file.
  if (contract.parseError !== undefined) {
    return {
      name: "env mode",
      status: "warn",
      message: `${contractPath} can't be read or parsed. Correct it or remove it, then run \`hack doctor --migrate-env-config\`.`,
    };
  }

  return {
    name: "env mode",
    status: "warn",
    message:
      "Legacy env format detected (.hack/hack.env.json). Run `hack doctor --migrate-env-config` to upgrade.",
  };
}

/**
 * The env format the doctor checks report, decided by the same check that
 * `hack env set`/`unset` use. A dangling or non-file `.hack/hack.env.*.yaml`
 * entry is a conflict to report, never a silent "legacy format" (HACK-1370).
 */
async function doctorEnvFormat(opts: {
  readonly projectDir: string;
}): Promise<
  | { readonly kind: "layers" | "legacy" }
  | { readonly kind: "conflict"; readonly message: string }
> {
  try {
    return (await projectEnvConfigExistsForMutation({
      projectDir: opts.projectDir,
    }))
      ? { kind: "layers" }
      : { kind: "legacy" };
  } catch (error: unknown) {
    if (error instanceof ProjectEnvLayerPathConflictError) {
      return { kind: "conflict", message: error.message };
    }
    throw error;
  }
}

async function checkProjectEnvOverlayWarnings({
  startDir,
}: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const ctx = await findProjectContext(startDir);
  if (!ctx) {
    return {
      name: "env overlay warnings",
      status: "warn",
      message: "No project detected",
    };
  }

  const cfg = await readProjectConfig(ctx);
  if (cfg.parseError) {
    return {
      name: "env overlay warnings",
      status: "warn",
      message: cfg.parseError,
    };
  }

  const format = await doctorEnvFormat({ projectDir: ctx.projectDir });
  if (format.kind === "conflict") {
    return {
      name: "env overlay warnings",
      status: "warn",
      message: "Skipped: an env layer entry is unusable (see env mode)",
    };
  }
  if (format.kind === "layers") {
    const serviceNames = await discoverComposeServiceNames({
      composeFile: ctx.composeFile,
    });
    const modern = await resolveProjectEnvConfig({
      projectRoot: ctx.projectRoot,
      projectDir: ctx.projectDir,
      envName: undefined,
      serviceNames,
    });
    if (!modern || modern.unknownScopes.length === 0) {
      return {
        name: "env overlay warnings",
        status: "ok",
        message: "No unknown service scopes detected in env config",
      };
    }
    return {
      name: "env overlay warnings",
      status: "warn",
      message: `Unknown env scopes: ${modern.unknownScopes.join(", ")}`,
    };
  }

  if (!cfg.defaultEnvConfig) {
    return {
      name: "env overlay warnings",
      status: "ok",
      message: "No default overlay selected",
    };
  }

  const warnings = await inspectHackEnvOverlayWarnings({
    projectDir: ctx.projectDir,
    envName: cfg.defaultEnvConfig,
  });
  if (warnings.length === 0) {
    return {
      name: "env overlay warnings",
      status: "ok",
      message: `No ignored plaintext secret entries detected in .hack/.env.${cfg.defaultEnvConfig}`,
    };
  }

  const keys = warnings.map((warning) => warning.key).join(", ");
  return {
    name: "env overlay warnings",
    status: "warn",
    message: `defaultEnvConfig=${cfg.defaultEnvConfig} contains plaintext entries for secret-backed vars (${keys}). Those overlay values are ignored; use "hack doctor --migrate-env-config" or "<value-source> | hack env add --env ${cfg.defaultEnvConfig} KEY --secret --value-stdin".`,
  };
}

async function checkProjectEnvMaterialization({
  startDir,
}: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const ctx = await findProjectContext(startDir);
  if (!ctx) {
    return {
      name: "env materialization",
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
    };
  }

  const format = await doctorEnvFormat({ projectDir: ctx.projectDir });
  if (format.kind === "conflict") {
    return {
      name: "env materialization",
      status: "warn",
      message: "Skipped: an env layer entry is unusable (see env mode)",
    };
  }
  // Recorded state means modern inputs once existed; inspect it for staleness.
  if (
    format.kind === "legacy" &&
    !(await pathExists(resolve(ctx.projectDir, PROJECT_ENV_STATE_FILENAME)))
  ) {
    return {
      name: "env materialization",
      status: "ok",
      message: "Not applicable (legacy env format)",
    };
  }

  const serviceNames = await discoverComposeServiceNames({
    composeFile: ctx.composeFile,
  });
  const inspected = await inspectProjectEnvMaterialization({
    projectRoot: ctx.projectRoot,
    projectDir: ctx.projectDir,
    envName: undefined,
    serviceNames,
  });

  return {
    name: "env materialization",
    status: inspected.status,
    message: inspected.message,
  };
}

async function checkWorktreeSecretKeys({
  startDir,
}: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const name = "worktree keys";
  const ctx = await findProjectContext(startDir);
  if (!ctx) {
    return {
      name,
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
    };
  }

  const inspection = await inspectWorktreeSecretKeys({
    projectRoot: ctx.projectRoot,
  });
  if (!inspection) {
    return {
      name,
      status: "ok",
      message: "Skipped (not a git checkout)",
    };
  }
  if (inspection.checkouts.length <= 1) {
    return {
      name,
      status: "ok",
      message: "Single checkout (no linked worktrees)",
    };
  }
  if (inspection.divergent) {
    const shared = inspection.sharedKeyPath ?? "unavailable";
    return {
      name,
      status: "warn",
      message: `Divergent .hack.secret.key contents across checkouts: ${inspection.divergentKeyPaths.join(
        ", "
      )}. Secrets encrypted in one checkout will not decrypt in another. Keep one key (shared location: ${shared}) and remove the divergent copies.`,
    };
  }

  return {
    name,
    status: "ok",
    message: `Env key consistent across ${inspection.checkouts.length} checkouts`,
  };
}

const ENV_KEY_CHECK = "env key";
const SECRET_INTEGRITY_CHECK = "secret integrity";

/**
 * Stores and env layers whose secrets cannot all be read with the key in
 * use (HACK-2169): an unreadable store, a missing or refused store key, and
 * an env layer holding secrets under more than one key. Value-free; each
 * finding says how to recover.
 */
async function checkSecretIntegrity({
  startDir,
}: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const project = await findProjectContext(startDir);
  if (!project) {
    return {
      name: SECRET_INTEGRITY_CHECK,
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
    };
  }
  const cfg = await readProjectConfig(project);
  const projectName = (
    cfg.name ??
    project.projectRoot.split("/").at(-1) ??
    "project"
  ).trim();
  let findings: Awaited<ReturnType<typeof inspectSecretIntegrity>>;
  try {
    findings = await inspectSecretIntegrity({
      projectRoot: project.projectRoot,
      projectDir: project.projectDir,
      projectName,
    });
  } catch {
    // Not inspected is not fine (HACK-2169); fixed text, no values.
    return {
      name: SECRET_INTEGRITY_CHECK,
      status: "error",
      message:
        "The secret store and env layers could not be checked (the secrets configuration or a layer could not be read). Make the project and global Hack config and the env layer files readable and valid, then re-run hack doctor.",
    };
  }
  if (findings.length === 0) {
    return {
      name: SECRET_INTEGRITY_CHECK,
      status: "ok",
      message: "Every stored secret opens with the key in use",
    };
  }
  // Information alone (a retired store kept beside its old name) is ok.
  let status: CheckResult["status"] = "ok";
  if (findings.some((finding) => finding.status === "error")) {
    status = "error";
  } else if (findings.some((finding) => finding.status === "warn")) {
    status = "warn";
  }
  return {
    name: SECRET_INTEGRITY_CHECK,
    status,
    message: findings.map((finding) => finding.message).join("\n"),
  };
}

/** Doctor check result for an env key inspection; message and data stay value-free. */
export function envKeyCheckResult(inspection: EnvKeyInspection): CheckResult {
  return {
    name: ENV_KEY_CHECK,
    status: inspection.status,
    message: describeEnvKeyInspection(inspection),
    envKey: inspection,
  };
}

/**
 * Reports which Compose features keep the current project on the Compose
 * backend (HACK-1291). Reads only the project's Compose file and, on the native
 * backend, the adaptation selection native up applies without `--env`
 * (`HACK_NATIVE_ADAPTATION`, else the committed `.hack/native/` files). An
 * invalid selection is the same value-free error native up gives.
 */
async function checkComposeBackendFeatures(opts: {
  readonly startDir: string;
  readonly backend: "native" | "compose";
}): Promise<CheckResult> {
  const ctx = await findProjectContext(opts.startDir);
  if (!ctx) {
    return {
      name: COMPOSE_BACKEND_CHECK,
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
    };
  }
  const adaptationCandidates =
    opts.backend === "native"
      ? nativeAdaptationCandidates({
          selection: await resolveNativeAdaptationSelection({
            env: process.env,
            projectDir: ctx.projectDir,
          }),
          requestedEnvName: undefined,
        })
      : undefined;
  // The same build classification native up applies under HACK_NATIVE_BUILDS.
  const buildsEnabled = nativeBuildsEnabled();
  const reading = await readComposeBackendReading(ctx.composeFile, {
    adaptationCandidates,
    buildsEnabled,
  });
  return composeBackendCheckResult({
    backend: opts.backend,
    buildsEnabled,
    features: reading.features,
    basicBuild: reading.basicBuild,
  });
}

/**
 * Warning-only native data-service advisories (image entrypoint ownership
 * handoff and mutable tags on services with named data volumes). Reads only
 * the project's Compose file; never blocks native up.
 */
async function checkNativeDataAdvisories(opts: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const ctx = await findProjectContext(opts.startDir);
  if (!ctx) {
    return {
      name: NATIVE_DATA_CHECK,
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
    };
  }
  return nativeDataCheckResult(await readNativeDataAdvisories(ctx.composeFile));
}

/**
 * Reports native services opted in to `linux/amd64` emulation and whether this
 * host provides Rosetta 2. Reads only the Compose file and the adaptation native
 * up applies for the project default env (`HACK_NATIVE_ADAPTATION`, else the
 * committed `.hack/native/` files); counts only, no service names.
 */
async function checkNativeAmd64Emulation(opts: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const ctx = await findProjectContext(opts.startDir);
  if (!ctx) {
    return {
      name: AMD64_EMULATION_CHECK,
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
    };
  }
  return amd64EmulationCheckResult({
    modes: await readNativePlatformModes({
      composeFile: ctx.composeFile,
      adaptationFile: selectNativeEnvFile({
        selection: await resolveNativeAdaptationSelection({
          env: process.env,
          projectDir: ctx.projectDir,
        }),
        envName: await readProjectDefaultEnvConfig({
          projectDir: ctx.projectDir,
        }),
      }),
    }),
    hostRosetta: await hostRosettaAvailable(),
  });
}

/** The `native settings` check: origins and closed warnings, never values. */
async function checkNativeProjectSettings(opts: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const ctx = await findProjectContext(opts.startDir);
  if (!ctx) {
    return {
      name: NATIVE_SETTINGS_CHECK,
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
    };
  }
  const cfg = await readProjectConfig(ctx);
  if (cfg.parseError) {
    return {
      name: NATIVE_SETTINGS_CHECK,
      status: "error",
      message:
        "Native settings require valid project configuration; values omitted.",
    };
  }
  return await checkNativeSettings({ project: ctx, cfg, env: process.env });
}

/**
 * Predicts the Compose-declared settings native up's process wrappers refuse
 * (HACK-1939), for the services it may wrap: every service when project-wide
 * host aliases exist, services with host-gateway extra hosts, and services
 * with bare environment keys. Read-only and value-free; image-inherited
 * settings are checked by native up against the pinned image.
 */
async function checkNativeProcessWrappers(opts: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const ctx = await findProjectContext(opts.startDir);
  if (!ctx) {
    return {
      name: NATIVE_PROCESS_CHECK,
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
    };
  }
  const cfg = await readProjectConfig(ctx);
  const aliases = await resolveInternalExtraHosts({
    projectRoot: ctx.projectRoot,
    projectDir: ctx.projectDir,
    staticHosts: cfg.internal?.extraHosts,
  }).catch(() => ({ hosts: {} }));
  return nativeProcessCheckFromCompose({
    compose: await readNativeComposeDocument(ctx.composeFile),
    projectWideAliases: Object.keys(aliases.hosts).length > 0,
  });
}

/**
 * Read-only key-strength and exposure audit (HACK-1127). `--fix` never acts on
 * it; each finding suggests the exact command instead. It also catches a key
 * that a later `git init` left unignored (`env-key-unignored`, HACK-1386).
 */
export async function checkProjectEnvKey({
  startDir,
}: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const ctx = await findProjectContext(startDir);
  if (!ctx) {
    return {
      name: ENV_KEY_CHECK,
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
    };
  }
  return await checkEnvKeyAtRoot({ projectRoot: ctx.projectRoot });
}

/** The env key audit for a resolved project root (legacy or adopted). */
async function checkEnvKeyAtRoot(opts: {
  readonly projectRoot: string;
}): Promise<CheckResult> {
  const inspection = await inspectProjectEnvKey({
    projectRoot: opts.projectRoot,
    candidates: await resolveEnvKeyCandidates({
      projectRoot: opts.projectRoot,
    }),
    env: process.env,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    listTrackedKeyPaths: gitListTrackedKeyPaths,
    isLocalKeyIgnored: gitIsLocalKeyIgnored,
  });
  return envKeyCheckResult(inspection);
}

/**
 * Warns when hack-generated machine-local files (`.hack/.internal/`,
 * `.hack/.branch/`, `.hack/.env`, `.hack/.env.state.json`,
 * `.hack/hack.env.*.local.yaml`, `.hack/tickets`, `.hack/.hack.env*.tmp`
 * staging files, `.hack.secret.key`) are tracked in git.
 * A tracked secret key is reported as an error because it is a committed
 * secret. `hack doctor --fix` untracks the offenders (files stay on disk) and
 * ensures the committed `.hack/.gitignore`.
 */
export async function checkTrackedGeneratedFiles({
  startDir,
}: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const ctx = await findProjectContext(startDir);
  if (!ctx) {
    return {
      name: "generated files",
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
    };
  }
  return await checkTrackedGeneratedFilesAt({ ...ctx, adopted: false });
}

/**
 * The tracked generated-files check for a resolved project (legacy or
 * adopted). For an adopted project `--fix` only untracks the files and leaves
 * the adoption's `.gitignore` unchanged, so the warning says that instead of
 * promising to ensure it (HACK-1380).
 */
async function checkTrackedGeneratedFilesAt(ctx: {
  readonly projectRoot: string;
  readonly projectDirName: string;
  readonly adopted: boolean;
}): Promise<CheckResult> {
  const name = "generated files";
  const inspection = await inspectTrackedGeneratedFiles({
    projectRoot: ctx.projectRoot,
    projectDirName: ctx.projectDirName,
  });
  if (!inspection) {
    return {
      name,
      status: "ok",
      message: "Skipped (not a git checkout)",
    };
  }
  if (
    inspection.trackedPaths.length === 0 &&
    inspection.trackedOverlayPaths.length === 0 &&
    inspection.unignoredOverlayPaths.length === 0
  ) {
    return {
      name,
      status: "ok",
      message: "No generated files tracked in git",
    };
  }

  const offenders = inspection.trackedPaths.join(", ");
  if (inspection.secretKeyTracked) {
    return {
      name,
      status: "error",
      message: `${PROJECT_ENV_KEY_FILENAME} is committed to git — it is a secret. Run 'hack doctor --fix' to untrack it (file stays on disk), rewrite or rotate the key ('hack env' secrets encrypted with it should be re-encrypted), and commit the removal. Tracked generated files: ${offenders}. Unignored legacy env files: ${inspection.unignoredOverlayPaths.join(", ") || "none"}. Tracked legacy overlays: ${inspection.trackedOverlayPaths.join(", ") || "none"}; migrate those with 'hack doctor --migrate-env-config' before considering removal.`,
    };
  }
  if (inspection.unignoredOverlayPaths.length > 0) {
    return {
      name,
      status: "warn",
      message: `Unignored legacy env files: ${inspection.unignoredOverlayPaths.join(", ")}. Run 'hack doctor --fix' to maintain ignore rules. Shared legacy overlays remain tracked; use 'hack doctor --migrate-env-config' before considering their removal. Tracked legacy overlays: ${inspection.trackedOverlayPaths.join(", ") || "none"}. Tracked generated files: ${inspection.trackedPaths.join(", ") || "none"}.`,
    };
  }
  if (inspection.trackedOverlayPaths.length > 0) {
    return {
      name,
      status: "warn",
      message: `Shared legacy env overlays are tracked in git: ${inspection.trackedOverlayPaths.join(", ")}. Run 'hack doctor --migrate-env-config' to preserve their values before considering removal. 'hack doctor --fix' leaves these overlays in the index. Tracked generated files: ${offenders || "none"}.`,
    };
  }
  return {
    name,
    status: "warn",
    message: ctx.adopted
      ? `Machine-local generated files are tracked in git: ${offenders}. Run 'hack doctor --fix' to untrack them (files stay on disk). It leaves the adopted project's ${ctx.projectDirName}/.gitignore unchanged, so keep these files out of later commits.`
      : `Machine-local generated files are tracked in git: ${offenders}. Run 'hack doctor --fix' to untrack them (files stay on disk) and ensure the committed ${ctx.projectDirName}/.gitignore.`,
  };
}

/**
 * Warns when the committed `.hack/.gitignore` is missing or lacks Hack's
 * managed block, for example in a project an earlier Hack version
 * initialized. Runtime commands keep `git status` clean through the local
 * `info/exclude` either way, but only the committed file reaches fresh clones.
 * `hack doctor --fix` creates or repairs it. A read-only file that lacks the
 * block, or a symlinked file or project dir (even one linking outside the
 * repository), is reported as a warning and never written.
 */
export async function checkHackDirGitignore({
  startDir,
}: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const name = HACK_GITIGNORE_CHECK;
  const ctx = await findProjectContext(startDir);
  if (!ctx) {
    return {
      name,
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
    };
  }
  const file = `${ctx.projectDirName}/.gitignore`;
  const state = await inspectHackDirGitignoreForDoctor({
    projectDir: ctx.projectDir,
  });
  switch (state) {
    case null:
      return { name, status: "ok", message: "Skipped (not a git checkout)" };
    case "current":
      return { name, status: "ok", message: `${file} has the managed block` };
    case "missing":
      return {
        name,
        status: "warn",
        message: `${file} is missing. Run 'hack doctor --fix' to create it, then commit it so fresh clones and worktrees ignore machine-local files.`,
      };
    case "outdated":
      return {
        name,
        status: "warn",
        message: `${file} lacks Hack's current managed block. Run 'hack doctor --fix' to update it (your own lines are kept), then commit it.`,
      };
    case "read-only":
      return {
        name,
        status: "warn",
        message: `${file} is read-only and lacks Hack's current managed block; Hack leaves it unchanged. Make it writable (chmod u+w ${file}), then run 'hack doctor --fix' and commit it.`,
      };
    case "unsafe":
      return {
        name,
        status: "warn",
        message: `${file} or its directory is a symlink or not a regular file; Hack will not read or write through it. Replace it with a regular file.`,
      };
    case "unreadable":
      return {
        name,
        status: "warn",
        message: `${file} cannot be read; check its permissions.`,
      };
    default:
      return state satisfies never;
  }
}

const SECRETS_HYGIENE_CHECK = "secrets hygiene";

/**
 * What the "secrets hygiene" section covers from `startDir`: the project, when
 * there is a legacy (not adopted) one, its shared key, and the encrypted-file
 * stores the global and project configuration name. Reads configuration and
 * git only. A report tolerates what it cannot read; with `strict` (used to
 * authorize a removal) any discovery, read or parse failure rejects instead,
 * so an unknown configuration never looks like one that names nothing.
 */
export async function resolveSecretsHygieneScope(opts: {
  readonly startDir: string;
  readonly strict?: boolean;
}): Promise<SecretsHygieneScope> {
  return await resolveLiveInputScope({
    ...opts,
    findProject: findDoctorLegacyProjectContext,
  });
}

/**
 * Secret-bearing files at rest for the project and the global Hack home
 * (HACK-2165): loose modes, links, tracked or unignored files, leftover
 * staging copies and terminal-session payloads, and a store whose key is
 * missing. File names only, never values; `hack doctor --fix` applies the
 * safe fixes (see `secrets-hygiene.ts`).
 */
export async function checkSecretsHygiene(opts: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const findings = await inspectSecretsHygiene(
    await resolveSecretsHygieneScope(opts)
  );
  return { name: SECRETS_HYGIENE_CHECK, ...describeSecretsHygiene(findings) };
}

function describeSecretsHygiene(findings: readonly SecretsHygieneFinding[]): {
  readonly status: "ok" | "warn" | "error";
  readonly message: string;
} {
  if (findings.length === 0) {
    return {
      status: "ok",
      message:
        "Env files, keys and stores are private, ignored by git, and no staging copies are left behind",
    };
  }
  const fixable = findings.some((finding) => finding.fix !== null);
  return {
    status: findings.some((finding) => finding.status === "error")
      ? "error"
      : "warn",
    message: [
      ...findings.map((finding) => finding.message),
      ...(fixable
        ? [
            "Run 'hack doctor --fix' to tighten modes, add the ignore entries and remove Hack's leftovers; it never deletes a store, a key or a file you wrote.",
          ]
        : []),
    ].join("\n"),
  };
}

const COMPOSE_ENV_AT_REST_CHECK = "compose env at rest";

/**
 * Warns when `.hack/.internal/compose.env.override.yml` holds literal env
 * values (an earlier Hack version wrote decrypted values there) or cannot be
 * verified, and when an interrupted removal left an aside that may hold them.
 * Counts only; never a key or value. `hack doctor --fix` removes them, except
 * an override that a saved adoption pins (the message gives the next step).
 */
export async function checkComposeEnvOverrideAtRest({
  startDir,
}: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const name = COMPOSE_ENV_AT_REST_CHECK;
  const ctx = await findComposeEnvAtRestProject({ startDir });
  if (!ctx) {
    return {
      name,
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
    };
  }
  const report = await inspectComposeEnvAtRest({ projectDir: ctx.projectDir });
  return {
    name,
    ...describeComposeEnvAtRest({
      report,
      projectDirName: ctx.projectDirName,
    }),
  };
}

/**
 * The project whose generated Compose env override doctor inspects. A legacy
 * adoption makes ordinary discovery refuse the project (its inputs become
 * native), yet the adoption can pin an earlier version's literal override, so
 * an active or pending adoption root is selected explicitly.
 */
async function findComposeEnvAtRestProject(opts: {
  readonly startDir: string;
}): Promise<{
  readonly projectDir: string;
  readonly projectDirName: string;
} | null> {
  try {
    const ctx = await findProjectContext(opts.startDir);
    if (ctx) {
      return ctx;
    }
  } catch {
    // Adopted or refused inputs: fall through to the adoption selector.
  }
  const adopted = await selectLegacyComposeAdoptedRoot({
    cwd: opts.startDir,
  }).catch(() => null);
  return adopted
    ? {
        projectDir: join(adopted, HACK_PROJECT_DIR_PRIMARY),
        projectDirName: HACK_PROJECT_DIR_PRIMARY,
      }
    : null;
}

/**
 * Project-scoped checks after the project check. An adopted project gets its
 * own set (HACK-1311); a legacy project the full set; no project two skips.
 */
async function runProjectChecks(opts: {
  readonly progress: DoctorProgress;
  readonly startDir: string;
  readonly adopted: DoctorAdoptedProject | null;
  readonly projectFound: boolean;
  readonly dockerOk: boolean;
}): Promise<TimedCheckResult[]> {
  const { progress: s, startDir, adopted, dockerOk } = opts;
  if (adopted) {
    return await runAdoptedProjectChecks({ progress: s, adopted, startDir });
  }
  const results: TimedCheckResult[] = [];
  if (!opts.projectFound) {
    results.push({
      name: "DEV_HOST",
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
      durationMs: 0,
    });
    results.push({
      name: "env mode",
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
      durationMs: 0,
    });
    // The global Hack home is covered without a project.
    results.push(
      await runCheck(
        s,
        SECRETS_HYGIENE_CHECK,
        () => checkSecretsHygiene({ startDir }),
        { timeoutMs: 10_000 }
      )
    );
    return results;
  }
  if (dockerOk) {
    results.push(
      await runCheck(s, "runtime hygiene", () =>
        checkProjectRuntimeHygiene({ startDir })
      )
    );
  }
  results.push(
    await runCheck(s, "lifecycle hygiene", () =>
      checkProjectLifecycleHygiene({ startDir })
    )
  );
  results.push(
    await runCheck(s, "compose networks", () =>
      checkComposeNetworkHygiene({ startDir })
    )
  );
  results.push(
    await runCheck(s, COMPOSE_BACKEND_CHECK, () =>
      checkComposeBackendFeatures({ startDir, backend: "compose" })
    )
  );
  results.push(await runCheck(s, "DEV_HOST", () => checkDevHost({ startDir })));
  results.push(
    await runCheck(s, "env mode", () => checkProjectEnvMode({ startDir }))
  );
  results.push(
    await runCheck(s, "env materialization", () =>
      checkProjectEnvMaterialization({ startDir })
    )
  );
  results.push(
    await runCheck(s, "env overlay warnings", () =>
      checkProjectEnvOverlayWarnings({ startDir })
    )
  );
  results.push(
    await runCheck(
      s,
      "worktree keys",
      () => checkWorktreeSecretKeys({ startDir }),
      {
        timeoutMs: 5000,
      }
    )
  );
  results.push(
    await runCheck(s, ENV_KEY_CHECK, () => checkProjectEnvKey({ startDir }), {
      timeoutMs: 5000,
    })
  );
  results.push(
    await runCheck(
      s,
      SECRET_INTEGRITY_CHECK,
      () => checkSecretIntegrity({ startDir }),
      { timeoutMs: 5000 }
    )
  );
  results.push(
    await runCheck(
      s,
      "generated files",
      () => checkTrackedGeneratedFiles({ startDir }),
      {
        timeoutMs: 5000,
      }
    )
  );
  results.push(
    await runCheck(
      s,
      HACK_GITIGNORE_CHECK,
      () => checkHackDirGitignore({ startDir }),
      {
        timeoutMs: 5000,
      }
    )
  );
  results.push(
    await runCheck(s, COMPOSE_ENV_AT_REST_CHECK, () =>
      checkComposeEnvOverrideAtRest({ startDir })
    )
  );
  results.push(
    await runCheck(
      s,
      SECRETS_HYGIENE_CHECK,
      () => checkSecretsHygiene({ startDir }),
      { timeoutMs: 10_000 }
    )
  );
  if (dockerOk) {
    results.push(
      await runCheck(
        s,
        "worktree instances",
        () => checkWorktreeInstanceCollisions({ startDir }),
        {
          timeoutMs: 5000,
        }
      )
    );
  }
  results.push(
    await runCheck(
      s,
      "caddy hosts",
      () => checkCaddyHostMapping({ startDir }),
      {
        timeoutMs: 2000,
      }
    )
  );
  return results;
}

/**
 * Project checks for an adopted Compose project: those that do not read the
 * inputs the adoption owns, then a not-applicable entry for each other
 * project check (HACK-1311). The env-at-rest check keeps its own adopted-root
 * selection.
 */
async function runAdoptedProjectChecks(opts: {
  readonly progress: DoctorProgress;
  readonly adopted: DoctorAdoptedProject;
  readonly startDir: string;
}): Promise<TimedCheckResult[]> {
  const { progress, adopted } = opts;
  return [
    await runCheck(
      progress,
      ENV_KEY_CHECK,
      () => checkEnvKeyAtRoot({ projectRoot: adopted.projectRoot }),
      { timeoutMs: 5000 }
    ),
    await runCheck(
      progress,
      "generated files",
      () => checkTrackedGeneratedFilesAt({ ...adopted, adopted: true }),
      { timeoutMs: 5000 }
    ),
    await runCheck(progress, COMPOSE_ENV_AT_REST_CHECK, () =>
      checkComposeEnvOverrideAtRest({ startDir: opts.startDir })
    ),
    await runCheck(
      progress,
      SECRETS_HYGIENE_CHECK,
      () => checkSecretsHygiene({ startDir: opts.startDir }),
      { timeoutMs: 10_000 }
    ),
    ...adoptedProjectNotApplicableResults().map((result) => ({
      ...result,
      durationMs: 0,
    })),
  ];
}

/**
 * The legacy project context for a `--fix` step, or null when there is none
 * or the project is adopted: an adoption owns its project's Compose inputs,
 * env config and runtime, so those steps leave it alone.
 */
async function findDoctorLegacyProjectContext(
  startDir: string
): Promise<Awaited<ReturnType<typeof findProjectContext>>> {
  if (await findDoctorAdoptedProject({ startDir })) {
    return null;
  }
  return await findProjectContext(startDir);
}

async function checkWorktreeInstanceCollisions({
  startDir,
}: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const name = "worktree instances";
  const ctx = await findProjectContext(startDir);
  if (!ctx) {
    return {
      name,
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
    };
  }

  const baseProjectName = await resolveDoctorBaseProjectName(ctx);
  const runtime = await readRuntimeProjects({ includeGlobal: false });
  if (!runtime.ok) {
    return {
      name,
      status: "warn",
      message: `Skipped (${runtime.error})`,
    };
  }

  const instances = findCrossCheckoutInstances({
    baseProjectName,
    currentProjectDir: ctx.projectDir,
    runtime: runtime.runtime,
  });
  const runningBase = instances.filter(
    (instance) => instance.running && instance.branch === null
  );
  if (runningBase.length > 0) {
    const dirs = runningBase
      .map((instance) => instance.workingDir ?? "unknown path")
      .join(", ");
    return {
      name,
      status: "warn",
      message: `Base instance "${baseProjectName}" is running from another checkout (${dirs}) and claims this project's dev_host. Use --branch here (linked worktrees default to a branch instance) or run 'hack down' in that checkout.`,
    };
  }

  const runningBranches = instances.filter(
    (instance) => instance.running && instance.branch !== null
  );
  if (runningBranches.length > 0) {
    const summary = runningBranches
      .map(
        (instance) =>
          `${instance.composeProject} (${instance.workingDir ?? "unknown path"})`
      )
      .join(", ");
    return {
      name,
      status: "ok",
      message: `Branch instances running from other checkouts: ${summary}`,
    };
  }

  return {
    name,
    status: "ok",
    message: "No cross-checkout instances running",
  };
}

async function resolveDoctorBaseProjectName(
  ctx: NonNullable<Awaited<ReturnType<typeof findProjectContext>>>
): Promise<string> {
  const text = await readTextFile(ctx.composeFile);
  if (text) {
    let parsed: unknown = null;
    try {
      parsed = YAML.parse(text);
    } catch {
      parsed = null;
    }
    if (isRecord(parsed)) {
      const composeName = getString(parsed, "name")?.trim();
      if (composeName && composeName.length > 0) {
        return composeName;
      }
    }
  }

  const cfg = await readProjectConfig(ctx);
  const derived = defaultProjectSlugFromPath(ctx.projectRoot);
  const cfgName = (cfg.name ?? derived).trim();
  return cfgName.length > 0 ? cfgName : derived;
}

async function checkCaddyHostMapping({
  startDir,
}: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const ctx = await findProjectContext(startDir);
  if (!ctx) {
    return {
      name: "caddy hosts",
      status: "warn",
      message: `Missing ${HACK_PROJECT_DIR_PRIMARY}/ (run 'hack init' in a repo)`,
    };
  }

  const caddyIp = await resolveGlobalCaddyIp();
  if (!caddyIp) {
    return {
      name: "caddy hosts",
      status: "warn",
      message: "Caddy not running (run: hack global up)",
    };
  }

  const mappedIp = await readInternalExtraHostsIp({
    projectDir: ctx.projectDir,
  });
  if (!mappedIp) {
    return {
      name: "caddy hosts",
      status: "warn",
      message: "No internal extra_hosts mapping found (run: hack restart)",
    };
  }

  if (mappedIp !== caddyIp) {
    return {
      name: "caddy hosts",
      status: "warn",
      message: `Caddy IP ${caddyIp} does not match hosts ${mappedIp} (run: hack restart)`,
    };
  }

  return {
    name: "caddy hosts",
    status: "ok",
    message: `Caddy IP ${caddyIp} matches internal host mapping`,
  };
}

async function checkComposeNetworkHygiene({
  startDir,
}: {
  readonly startDir: string;
}): Promise<CheckResult> {
  const ctx = await findProjectContext(startDir);
  if (!ctx) {
    return {
      name: "compose networks",
      status: "warn",
      message: `Skipped (no ${HACK_PROJECT_DIR_PRIMARY}/ found)`,
    };
  }

  const yamlText = await readTextFile(ctx.composeFile);
  if (!yamlText) {
    return {
      name: "compose networks",
      status: "warn",
      message: `Unable to read ${ctx.composeFile}`,
    };
  }

  const analysis = analyzeComposeNetworkHygiene({ yamlText });
  if ("error" in analysis) {
    let message: string;
    if (analysis.error === "invalid-yaml") {
      message = `Invalid YAML in ${ctx.composeFile}`;
    } else if (analysis.error === "missing-services") {
      message = `Missing services in ${ctx.composeFile}`;
    } else {
      message = `Unexpected compose format in ${ctx.composeFile}`;
    }
    return {
      name: "compose networks",
      status: "warn",
      message,
    };
  }

  return {
    name: "compose networks",
    status: analysis.offenders.length > 0 ? "warn" : "ok",
    message:
      analysis.offenders.length > 0
        ? `Internal services attached to ${DEFAULT_INGRESS_NETWORK} without Caddy labels: ${analysis.offenders.join(", ")}`
        : "OK",
  };
}

async function readLegacyEnvDevHost(envFile: string): Promise<string | null> {
  // No-follow (HACK-2165): a linked .hack/.env is not read, so its values
  // are never printed.
  const envText = await readPrivateEnvFile({ envFile }).catch(() => null);
  if (!envText) {
    return null;
  }
  const env = parseDotEnv(envText);
  const host = env.DEV_HOST;
  return typeof host === "string" && host.length > 0 ? host : null;
}

async function runDoctorFix(opts: {
  readonly startDir: string;
  readonly migrateEnvConfig: boolean;
  readonly acceptTrackedEnvChanges: boolean;
}): Promise<void> {
  if (opts.migrateEnvConfig) {
    await assertTrackedEnvMigrationConsent({
      startDir: opts.startDir,
      accept: opts.acceptTrackedEnvChanges,
    });
  }
  const remediationPlan = await buildDoctorRemediationPlanLines({
    startDir: opts.startDir,
    migrateEnvConfig: opts.migrateEnvConfig,
  });
  note(remediationPlan.join("\n"), "doctor plan");
  skippedDoctorFixSteps.length = 0;

  const ok = await doctorConfirm({
    message: opts.migrateEnvConfig
      ? "Start guided remediation steps now? (includes env migration when applicable)"
      : "Start guided remediation steps now?",
    initialValue: true,
  });
  if (!ok) {
    return;
  }

  await maybeInstallMutagenForDoctorFix();
  await maybeUntrackGeneratedFiles({ startDir: opts.startDir });
  // Let env migration refuse before creating an unrelated missing gitignore.
  if (!opts.migrateEnvConfig) {
    await maybeEnsureHackDirGitignore({ startDir: opts.startDir });
  }
  await maybeRemovePlaintextComposeEnvOverride({ startDir: opts.startDir });
  await maybeFixSecretsHygiene({ startDir: opts.startDir });
  const serviceWrites = await maybeInstallDaemonService();
  await maybeRepairHackd({ serviceWrites });
  // Env migration changes project files only, so it runs before the Docker
  // gate: an unreachable Docker never skips a requested migration.
  if (opts.migrateEnvConfig) {
    await maybeMigrateProjectEnvConfig({
      startDir: opts.startDir,
      acceptTrackedChanges: opts.acceptTrackedEnvChanges,
    });
    await maybeEnsureHackDirGitignore({ startDir: opts.startDir });
  }

  const dockerOk = await dockerInfoOk();
  if (!dockerOk) {
    note(
      "Docker is not reachable; daemon repairs were still applied, but Docker-backed fixes were skipped.",
      "doctor"
    );
    return;
  }

  await maybeRepairProjectLifecycleSessions({ startDir: opts.startDir });
  await maybeRepairIncompleteRuntime({ startDir: opts.startDir });

  const paths = getGlobalPaths();
  await ensureDir(paths.caddyDir);

  const ingressAfterFix = await ensureIngressNetwork();
  await ensureLoggingNetwork();

  const useStaticIps = ingressAfterFix.hasSubnet;
  await writeWithPromptIfDifferent(
    paths.caddyCompose,
    renderGlobalCaddyCompose({
      useStaticCoreDnsIp: useStaticIps,
      useStaticCaddyIp: useStaticIps,
      bindAddress: await resolveProxyBindAddress(),
    })
  );
  await writeWithPromptIfDifferent(
    paths.coreDnsConfig,
    renderGlobalCoreDnsConfig({ useStaticCaddyIp: useStaticIps })
  );

  await maybeStartGlobalCaddyCompose({ paths });
  await maybeExportCaddyCaCert({ paths });
  await maybeRepairMacHostTlsTrust();
  await maybeMigrateDnsmasq();

  renderSkippedDoctorFixSteps();
}

async function maybeRepairIncompleteRuntime(opts: {
  readonly startDir: string;
}): Promise<void> {
  const project = await findDoctorLegacyProjectContext(opts.startDir);
  if (!project) {
    return;
  }
  const [registry, runtimeResult] = await Promise.all([
    readProjectsRegistry(),
    readRuntimeProjects({ includeGlobal: false }),
  ]);
  if (!runtimeResult.ok) {
    return;
  }
  const scoped = scopeRuntimeHygieneToProject({
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
    projects: registry.projects,
    runtime: runtimeResult.runtime,
  });
  const incomplete = findIncompleteRuntimeProjects({ runtime: scoped.runtime });
  for (const entry of incomplete) {
    if (entry.containerIds.length === 0) {
      note(
        `Could not identify Created containers for ${entry.project}; left unchanged.`,
        "runtime repair"
      );
      continue;
    }
    const code = await run(["docker", "start", ...entry.containerIds], {
      stdin: "ignore",
      timeoutMs: 30_000,
    });
    note(
      code === 0
        ? `Started Created services for ${entry.project}: ${entry.createdServices.join(", ")}`
        : `Failed to start Created services for ${entry.project} (exit ${code}); no containers were removed.`,
      "runtime repair"
    );
  }
}

/**
 * Prints a single summary of destructive/system-level `--fix` steps that
 * were skipped because the run was non-interactive (no TTY, `--no-interactive`,
 * or `HACK_NO_INTERACTIVE`), with the command to run them interactively.
 */
function renderSkippedDoctorFixSteps(): void {
  if (skippedDoctorFixSteps.length === 0) {
    return;
  }
  note(
    [
      "Skipped (non-interactive; involve sudo/system-level changes):",
      ...skippedDoctorFixSteps.map((what) => `- ${what}`),
      "Run interactively (without --no-interactive/HACK_NO_INTERACTIVE) to apply them: hack doctor --fix",
    ].join("\n"),
    "doctor fix"
  );
}

/** `delete .hack/hack.env.json; edit .hack/docker-compose.yml`, relative to the project root. */
function describeTrackedEnvMigrationChanges(opts: {
  readonly projectRoot: string;
  readonly changes: readonly TrackedEnvMigrationChange[];
}): string {
  return opts.changes
    .map(
      (change) => `${change.change} ${relative(opts.projectRoot, change.path)}`
    )
    .join("; ");
}

/**
 * Refuses an env migration that would delete or edit git-tracked files when
 * it cannot ask and `--accept-tracked-env-changes` was not passed. It runs
 * before any doctor fix step writes, so the refusal changes nothing.
 * Teammates share those files (the contract, the Compose file), so a run with
 * no prompt never changes one on its own; an interactive run asks per step.
 */
export async function assertTrackedEnvMigrationConsent(opts: {
  readonly startDir: string;
  readonly accept: boolean;
}): Promise<void> {
  if (opts.accept || canPrompt()) {
    return;
  }
  const project = await findDoctorLegacyProjectContext(opts.startDir);
  if (!project) {
    return;
  }
  const config = await readProjectConfig(project);
  const preview = await previewEnvMigration({
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
    projectName: config.name ?? "project",
    serviceNames: await discoverComposeServiceNames({
      composeFile: project.composeFile,
    }),
  });
  const changes: TrackedEnvMigrationChange[] = preview.files
    .filter((file) => file.tracked && file.action !== "removable")
    .map((file) => ({ path: file.path, change: "edit" }));
  if (changes.length === 0) {
    return;
  }
  requireInteractive({
    what: `confirm env migration changes to git-tracked files (${describeTrackedEnvMigrationChanges({ projectRoot: project.projectRoot, changes })})`,
    hint: "Nothing was changed. Teammates share these files, so they change only with consent. Re-run interactively to confirm each change, or pass --accept-tracked-env-changes to apply them without a prompt.",
  });
}

/**
 * Confirms a step that deletes or edits a git-tracked file. Without a prompt it
 * proceeds only with `--accept-tracked-env-changes`; otherwise it declines.
 */
async function confirmTrackedEnvChange(opts: {
  readonly message: string;
  readonly accept: boolean;
}): Promise<boolean> {
  return await confirmSafe({
    message: opts.message,
    initialValue: true,
    nonInteractive: opts.accept ? "accept-default" : "decline",
  });
}

/** Confirms the Compose env_file repair, as a tracked change when git tracks the file. */
async function maybeMigrateProjectEnvConfig(opts: {
  readonly startDir: string;
  readonly acceptTrackedChanges: boolean;
}): Promise<void> {
  const project = await findDoctorLegacyProjectContext(opts.startDir);
  if (!project) {
    return;
  }
  const config = await readProjectConfig(project);
  const migrationProject = {
    projectRoot: project.projectRoot,
    projectDir: project.projectDir,
    projectName: config.name ?? "project",
    serviceNames: await discoverComposeServiceNames({
      composeFile: project.composeFile,
    }),
  };
  const preview = await previewEnvMigration(migrationProject);
  const tracked = preview.files.filter(
    (file) => file.tracked && file.action !== "removable"
  );
  const accept =
    opts.acceptTrackedChanges ||
    tracked.length === 0 ||
    (await confirmTrackedEnvChange({
      message: "Apply the previewed env migration changes to tracked files?",
      accept: false,
    }));
  if (!accept) {
    return;
  }
  const result = await applyEnvMigration({
    project: migrationProject,
    acceptTrackedChanges: accept,
    snapshots: await envMigrationSnapshots(),
  });
  note(
    result.status === "already_complete"
      ? "Env migration already completed; no files were changed."
      : "Env migration completed. Legacy files were kept for a separate cleanup step.",
    "env migration"
  );
  if (result.manifestPath) {
    note(
      `Journal: ${result.journalPath}\nRollback snapshot: ${result.manifestPath}\nAfter validating the project, preview cleanup with: hack env migrate --cleanup --path ${JSON.stringify(project.projectRoot)}`,
      "env migration"
    );
  }
  await printMigrationProtectionHint(project);
}

/** End migration with names-only guidance for encrypting plaintext values in place. */
async function printMigrationProtectionHint(project: {
  readonly projectRoot: string;
  readonly projectDir: string;
}): Promise<void> {
  let entries: Awaited<ReturnType<typeof listProjectEnvPlaintextEntries>>;
  try {
    entries = await listProjectEnvPlaintextEntries(project);
  } catch {
    note(
      "Could not inspect plaintext env names. Check env layers, then run hack env protect to inspect names and choose keys (values omitted).",
      "env protection"
    );
    return;
  }
  const keys = [...new Set(entries.map((entry) => entry.key))].sort();
  if (keys.length === 0) {
    note("No plaintext env entries remain.", "env protection");
    return;
  }
  note(
    [
      "Plaintext env keys remain (values omitted):",
      ...keys.map((key) => `- ${key}`),
      "Encrypt chosen keys in their current scopes and overlays:",
      "hack env protect <KEY> [KEY...]",
    ].join("\n"),
    "env protection"
  );
}

/**
 * Removes confirmed legacy env files. Once the encrypted secret store itself is
 * gone, its pointer leaves `hack.config.json` too; the migration kept it so a
 * declined removal keeps the store readable. Partial failures reconcile the
 * pointer against confirmed removals before the cleanup error is rethrown.
 */
export async function removeDoctorEnvCleanup(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly projectName: string;
  readonly paths: readonly string[];
  readonly context?: LegacyProjectEnvMigration["cleanupContext"];
}): Promise<void> {
  let removed: readonly string[];
  try {
    removed = await removeLegacyProjectEnvArtifacts({
      paths: opts.paths,
      projectRoot: opts.projectRoot,
      context: opts.context,
    });
  } catch (error) {
    if (error instanceof LegacyEnvCleanupError) {
      try {
        await dropRemovedLegacySecretStorePointer({
          projectRoot: opts.projectRoot,
          projectDir: opts.projectDir,
          projectName: opts.projectName,
          removed: error.removedPaths,
        });
      } catch {
        note(
          "Could not reconcile the legacy secret store pointer. Check hack.config.json for a pointer to the removed store before retrying cleanup (values omitted).",
          "env cleanup"
        );
      }
    }
    throw error;
  }
  if (removed.length > 0) {
    note(`Removed ${removed.join(", ")}`, "env cleanup");
  }
  if (
    await dropRemovedLegacySecretStorePointer({
      projectRoot: opts.projectRoot,
      projectDir: opts.projectDir,
      projectName: opts.projectName,
      removed,
    })
  ) {
    note(
      "Removed the encrypted secret store pointer from hack.config.json: the store it named is gone.",
      "env cleanup"
    );
  }
}

/**
 * Legacy env files doctor offers to delete after a migration. Files compose
 * still names as `env_file` (`blockedCleanupCandidates`) are offered only when
 * the compose repair removed those references; deleting them otherwise would
 * break the next `hack up`.
 */
export function doctorEnvCleanupCandidates(opts: {
  readonly migrated: Pick<
    LegacyProjectEnvMigration,
    "cleanupCandidates" | "blockedCleanupCandidates"
  >;
  readonly composeRepaired: boolean;
}): string[] {
  return [
    ...opts.migrated.cleanupCandidates,
    ...(opts.composeRepaired ? opts.migrated.blockedCleanupCandidates : []),
  ].sort((left, right) => left.localeCompare(right));
}

export async function buildDoctorRemediationPlanLines(opts: {
  readonly startDir: string;
  readonly migrateEnvConfig: boolean;
}): Promise<string[]> {
  const steps = [
    "Review and repair global Docker networks, CoreDNS, CA, host TLS env, and daemon drift where needed.",
  ];

  const adopted = await findDoctorAdoptedProject({ startDir: opts.startDir });
  const project = adopted ? null : await findProjectContext(opts.startDir);
  // Generated files and env values at rest are checked for either kind.
  const target = adopted ?? project;
  if (adopted) {
    steps.push(
      "Leave the adopted Compose project's inputs, retained containers and adoption state to 'hack config adopt'; --fix changes none of them."
    );
  }
  if (project) {
    steps.push(
      "Reconcile lifecycle sessions and remove only ownership-proven sessions whose Compose instance is absent."
    );
  }
  const trackedGenerated = target
    ? await inspectTrackedGeneratedFiles({
        projectRoot: target.projectRoot,
        projectDirName: target.projectDirName,
      })
    : null;
  if (trackedGenerated && trackedGenerated.trackedPaths.length > 0) {
    steps.push(
      adopted
        ? `Untrack machine-local generated files from git (git rm --cached; files stay on disk) and leave the adopted project's ${adopted.projectDirName}/.gitignore unchanged: ${trackedGenerated.trackedPaths.join(", ")}`
        : `Untrack machine-local generated files from git (git rm --cached; files stay on disk) and ensure the committed ${target?.projectDirName}/.gitignore: ${trackedGenerated.trackedPaths.join(", ")}`
    );
  }
  const hackGitignore = project
    ? await inspectHackDirGitignoreForDoctor({
        projectDir: project.projectDir,
      })
    : null;
  if (hackGitignore === "missing" || hackGitignore === "outdated") {
    steps.push(
      `${hackGitignore === "missing" ? "Create" : "Update the managed block in"} the committed ${project?.projectDirName}/.gitignore so machine-local generated files stay out of git (commit it afterwards).`
    );
  }

  const composeEnvAtRest = target
    ? composeEnvAtRestRepairs(
        await inspectComposeEnvAtRest({ projectDir: target.projectDir })
      )
    : null;
  if (composeEnvAtRest?.override) {
    steps.push(
      `Remove ${target?.projectDirName}/.internal/compose.env.override.yml, which may hold env values at rest; Compose commands regenerate it with references only.`
    );
  }
  if (composeEnvAtRest?.asides) {
    steps.push(
      `Remove leftover ${target?.projectDirName}/.internal/.compose.env.override.yml.<id>.remove files from an interrupted removal, which may hold env values.`
    );
  }

  if (opts.migrateEnvConfig) {
    steps.push(
      adopted
        ? "Skip env migration because an adopted Compose project's env config belongs to 'hack config adopt'."
        : await buildEnvMigrationPlanStep({ project })
    );
  }

  return steps.map((step, index) => `${index + 1}. ${step}`);
}

async function buildEnvMigrationPlanStep(opts: {
  readonly project: Awaited<ReturnType<typeof findProjectContext>>;
}): Promise<string> {
  if (!opts.project) {
    return "Skip env migration because no project was detected from this path.";
  }

  // Match the execution gate, including checkout values not yet in the layers.
  // A layer conflict is reported as a plan; escaping paths still stop the run.
  let modernExists: boolean;
  try {
    modernExists = await projectEnvConfigExistsForMutation({
      projectDir: opts.project.projectDir,
    });
    if (modernExists) {
      modernExists = !(await canMigrateCheckoutLegacyDotenv({
        projectRoot: opts.project.projectRoot,
        projectDir: opts.project.projectDir,
        serviceNames: await discoverComposeServiceNames({
          composeFile: opts.project.composeFile,
        }),
      }));
    }
  } catch (error: unknown) {
    if (error instanceof LegacyDotenvMigrationRefusalError) {
      return error.message;
    }
    if (error instanceof ProjectEnvLayerPathConflictError) {
      return `Refuse env migration (E_PATH_CONFLICT) because ${error.path} is not a regular env layer file.`;
    }
    throw error;
  }
  if (modernExists) {
    const config = await readProjectConfig(opts.project);
    const composeFile = opts.project.composeFile;
    const preview = await previewEnvMigration({
      projectRoot: opts.project.projectRoot,
      projectDir: opts.project.projectDir,
      projectName: config.name ?? "project",
      serviceNames: await discoverComposeServiceNames({
        composeFile,
      }),
    });
    if (preview.composeRepair === "unavailable") {
      return "Compose repair unavailable: keep legacy copies and review their values privately against current layers and Compose references, or explicitly restore the snapshot with --preserve-changes.";
    }
    if (
      preview.files.some(
        (file) => file.action === "change" && file.path === composeFile
      )
    ) {
      return "Prompt to repair retained Compose env_file references; keep completed env layers and legacy files.";
    }
    return "Skip env migration because this project already uses hack.env.*.yaml.";
  }

  const contract = await readHackEnvContract({
    projectDir: opts.project.projectDir,
  });
  if (contract.parseError !== undefined) {
    return "Refuse env migration (E_CONFIG_INVALID) because .hack/hack.env.json can't be read or parsed.";
  }
  if (contract.exists) {
    return "Prompt to migrate legacy env config (.hack/hack.env.json) to hack.env.*.yaml.";
  }

  return "Prompt to migrate legacy env values (.hack/.env and its overlays, no .hack/hack.env.json) to the gitignored machine-local hack.env.local.yaml and hack.env.<overlay>.local.yaml layers.";
}

/**
 * `hack doctor --fix` step: untracks hack-generated machine-local files from
 * the git index (`git rm --cached`; working-tree files are untouched) and
 * ensures the committed `.hack/.gitignore` so they cannot leak back in.
 */
async function maybeUntrackGeneratedFiles(opts: {
  readonly startDir: string;
}): Promise<void> {
  // An adopted project gets the git-index change and the root key entry only:
  // its `.hack/` belongs to the adoption, and the legacy `.hack/.gitignore`
  // writer refuses it as native input (HACK-1311).
  const adopted = await findDoctorAdoptedProject({ startDir: opts.startDir });
  const project = adopted ?? (await findProjectContext(opts.startDir));
  if (!project) {
    return;
  }

  const inspection = await inspectTrackedGeneratedFiles({
    projectRoot: project.projectRoot,
    projectDirName: project.projectDirName,
  });
  if (!inspection || inspection.trackedPaths.length === 0) {
    return;
  }

  note(
    [
      "Untracking machine-local generated files from git (files stay on disk):",
      ...inspection.trackedPaths.map((path) => `- ${path}`),
    ].join("\n"),
    "generated files"
  );

  const untracked = await untrackGeneratedFiles({
    projectRoot: project.projectRoot,
    paths: inspection.trackedPaths,
  });
  if (!untracked.ok) {
    note(
      `Failed to untrack generated files: ${untracked.error ?? "unknown error"}`,
      "generated files"
    );
    return;
  }

  const notes: string[] = [];
  if (adopted) {
    notes.push(
      `Removed ${inspection.trackedPaths.length} path(s) from the git index. Left ${project.projectDirName}/.gitignore unchanged: an adopted Compose project's ${project.projectDirName}/ belongs to 'hack config adopt'.`,
      "Commit the removal to stop sharing these files, and keep them out of later commits."
    );
  } else {
    const ignoreEnsured = await ensureHackDirGitignoreForDoctor({ project });
    notes.push(
      ignoreEnsured
        ? `Removed ${inspection.trackedPaths.length} path(s) from the git index and ensured ${project.projectDirName}/.gitignore.`
        : `Removed ${inspection.trackedPaths.length} path(s) from the git index; ${project.projectDirName}/.gitignore was left alone.`,
      "Commit the removal to stop sharing these files."
    );
  }
  if (inspection.secretKeyTracked) {
    // The nested .hack/.gitignore cannot cover the repo-root key file; without
    // the root entry the just-untracked key shows up as untracked and gets
    // re-committed.
    await ensureGitignoreEntry({
      gitignorePath: resolve(project.projectRoot, ".gitignore"),
      entry: PROJECT_ENV_KEY_FILENAME,
      comment: "# project env key",
    });
    notes.push(
      `Ensured ${PROJECT_ENV_KEY_FILENAME} is ignored in the root .gitignore.`,
      `${PROJECT_ENV_KEY_FILENAME} was committed — treat it as leaked: rotate the key and re-encrypt secrets, and consider rewriting git history if the repo is shared.`
    );
  }
  note(notes.join("\n"), "generated files");
}

/**
 * `hack doctor --fix` step: applies the "secrets hygiene" fixes and prints
 * each change. Safe by construction (modes, ignore entries, Hack's own
 * leftovers), so it needs no confirmation of its own.
 */
async function maybeFixSecretsHygiene(opts: {
  readonly startDir: string;
}): Promise<void> {
  const findings = await inspectSecretsHygiene(
    await resolveSecretsHygieneScope(opts)
  );
  if (!findings.some((finding) => finding.fix !== null)) {
    return;
  }
  const lines: string[] = [];
  await applySecretsHygieneFixes({
    findings,
    report: (line) => lines.push(line),
    // Removals check the configuration as it is then, not as inspected.
    currentScope: () => resolveSecretsHygieneScope({ ...opts, strict: true }),
  });
  note(lines.join("\n"), SECRETS_HYGIENE_CHECK);
}

/**
 * `hack doctor --fix` step: creates a missing committed `.hack/.gitignore`, or
 * restores its managed block, in a git checkout. This is the explicit,
 * user-invoked way to add the file to an existing project: runtime commands
 * never write it, and `hack init` refuses or rescaffolds an existing project.
 * Lines outside the managed markers are kept. An unreadable file is left alone.
 */
async function maybeEnsureHackDirGitignore(opts: {
  readonly startDir: string;
}): Promise<void> {
  // An adopted project's .hack/ belongs to `hack config adopt`: leave it alone.
  const project = await findDoctorLegacyProjectContext(opts.startDir);
  if (!project) {
    return;
  }
  const state = await inspectHackDirGitignoreForDoctor({
    projectDir: project.projectDir,
  });
  if (state !== "missing" && state !== "outdated") {
    return;
  }
  const file = `${project.projectDirName}/.gitignore`;
  const ok = await doctorConfirm({
    message:
      state === "missing"
        ? `Create ${file} with Hack's managed ignore block?`
        : `Update Hack's managed block in ${file}? (your own lines are kept)`,
    initialValue: true,
  });
  if (!ok) {
    return;
  }
  if (!(await ensureHackDirGitignoreForDoctor({ project }))) {
    return;
  }
  note(
    `${state === "missing" ? "Created" : "Updated"} ${file}. Commit it so fresh clones and worktrees ignore machine-local generated files.`,
    HACK_GITIGNORE_CHECK
  );
}

/**
 * Runs `ensureHackDirGitignore` for a doctor repair step. A symlink or
 * non-regular entry (possibly planted after the check) is reported with the
 * fixed refusal and left alone; so is a read-only file that lacks the managed
 * block (possibly made read-only after the check). Returns whether the file is
 * now ensured.
 */
async function ensureHackDirGitignoreForDoctor(opts: {
  readonly project: { readonly projectDir: string };
}): Promise<boolean> {
  try {
    const result = await ensureHackDirGitignore({
      projectDir: opts.project.projectDir,
    });
    if (result.readOnly) {
      note(HACK_DIR_GITIGNORE_READ_ONLY_WARNING, HACK_GITIGNORE_CHECK);
      return false;
    }
    return true;
  } catch (error: unknown) {
    if (error instanceof HackDirGitignoreRefusalError) {
      note(HACK_DIR_GITIGNORE_REFUSAL, HACK_GITIGNORE_CHECK);
      return false;
    }
    throw error;
  }
}

/**
 * `hack doctor --fix` step: removes a generated Compose env override that holds
 * (or may hold) literal env values, and stale asides that an interrupted
 * removal left. Hack-owned and regenerated value-free by the next Compose
 * command, so it is a safe generated-file repair. The file is re-inspected
 * immediately before removal; a value-free file is kept, and so is one that a
 * saved adoption pins (removing it would break the adoption).
 */
async function maybeRemovePlaintextComposeEnvOverride(opts: {
  readonly startDir: string;
}): Promise<void> {
  const project = await findComposeEnvAtRestProject(opts);
  if (!project) {
    return;
  }
  const report = await inspectComposeEnvAtRest({
    projectDir: project.projectDir,
  });
  const file = `${project.projectDirName}/.internal/compose.env.override.yml`;
  const repairs = composeEnvAtRestRepairs(report);
  if (report.adoptionBound) {
    note(
      `Kept ${file}: a saved 'hack config adopt' generation pins it, and removing it would break the adoption (values omitted). ${adoptedComposeEnvOverrideNextStep(report)}`,
      "compose env at rest"
    );
  }
  if (!(repairs.override || repairs.asides)) {
    return;
  }
  const targets = [
    ...(repairs.override ? [file] : []),
    ...(repairs.asides
      ? [
          `leftover ${project.projectDirName}/.internal/.compose.env.override.yml.<id>.remove files`,
        ]
      : []),
  ].join(" and ");
  const ok = await doctorConfirm({
    message: `Remove ${targets}? They may hold env values at rest; Compose commands regenerate the override with references only.`,
    initialValue: true,
  });
  if (!ok) {
    return;
  }
  try {
    const removal = await removePlaintextComposeEnvOverride({
      projectDir: project.projectDir,
      includeUnverifiable: true,
    });
    note(
      composeEnvAtRestFixLines({
        removal,
        file,
        overrideRequested: repairs.override,
      }).join("\n"),
      "compose env at rest"
    );
  } catch {
    note(
      `Failed to remove ${targets}; remove them manually (values omitted).`,
      "compose env at rest"
    );
  }
}

/** Value-free outcome lines for the `--fix` step above. */
function composeEnvAtRestFixLines(opts: {
  readonly removal: Awaited<
    ReturnType<typeof removePlaintextComposeEnvOverride>
  >;
  readonly file: string;
  readonly overrideRequested: boolean;
}): string[] {
  const { removal, file } = opts;
  const lines =
    removal.asidesRemoved > 0
      ? [
          `Removed ${removal.asidesRemoved} leftover removal file(s) (values omitted).`,
        ]
      : [];
  if (!opts.overrideRequested) {
    return lines;
  }
  if (removal.removed) {
    lines.push(`Removed ${file} (values omitted).`);
  } else if (removal.adoptionBound) {
    lines.push(
      `Kept ${file}: a saved 'hack config adopt' generation now pins it (values omitted).`
    );
  } else if (removal.state.kind === "refused") {
    lines.push(
      `Left ${file} in place: it or its directory is now a symlink or not a regular file or directory (values omitted).`
    );
  } else {
    lines.push(`Left ${file} in place: it no longer holds env values.`);
  }
  return lines;
}

async function maybeRepairProjectLifecycleSessions(opts: {
  readonly startDir: string;
}): Promise<void> {
  const project = await findDoctorLegacyProjectContext(opts.startDir);
  if (!project) {
    return;
  }
  const repaired = await repairProjectLifecycleSessions({
    projectDir: project.projectDir,
    projectRoot: project.projectRoot,
  });
  if (repaired.repairedSessions.length > 0) {
    note(
      [
        `Removed ${repaired.repairedSessions.length} ownership-proven orphan lifecycle session${repaired.repairedSessions.length === 1 ? "" : "s"}:`,
        ...repaired.repairedSessions.map((sessionName) => `- ${sessionName}`),
      ].join("\n"),
      "lifecycle repair"
    );
  }
  if (repaired.failures.length > 0) {
    note(
      [
        "Lifecycle sessions left unchanged because safe repair could not be re-proven:",
        ...repaired.failures.map((failure) => `- ${failure}`),
      ].join("\n"),
      "lifecycle repair"
    );
  }
}

async function maybeInstallMutagenForDoctorFix(): Promise<void> {
  if (getMutagenPath()) {
    return;
  }

  const okMutagen = await doctorConfirm({
    message: "Install managed mutagen at ~/.hack/bin/mutagen?",
    initialValue: true,
  });
  if (!okMutagen) {
    return;
  }

  const installed = await ensureBundledMutagenInstalled();
  if (installed.ok) {
    note(
      installed.installed
        ? `Installed mutagen at ${installed.mutagenPath}`
        : `Mutagen already installed at ${installed.mutagenPath}`,
      "doctor"
    );
    return;
  }

  const detail = installed.message ? `: ${installed.message}` : "";
  note(`Mutagen install failed (${installed.reason}${detail})`, "doctor");
}

/**
 * `hack doctor --fix` confirmation helper.
 *
 * Wraps {@link confirmSafe} with the doctor-specific non-interactive
 * defaults: safe remediations (network/CoreDNS/CA/daemon restarts and generated
 * file writes) proceed automatically
 * (`nonInteractive: "accept-default"`); destructive/system-level steps
 * (anything invoking `sudo`, touching the macOS keychain, or writing outside
 * the project) decline automatically and print a note via
 * {@link noteSkippedDoctorFixStep} so the run stays non-blocking and
 * auditable.
 */
async function doctorConfirm(opts: {
  readonly message: string;
  readonly initialValue: boolean;
  readonly destructive?: boolean;
}): Promise<boolean> {
  const ok = await confirmSafe({
    message: opts.message,
    initialValue: opts.initialValue,
    nonInteractive: opts.destructive ? "decline" : "accept-default",
  });
  if (!ok && opts.destructive && !canPrompt()) {
    noteSkippedDoctorFixStep({ what: firstLine(opts.message) });
  }
  return ok;
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}

const skippedDoctorFixSteps: string[] = [];

/**
 * Records a destructive/system-level `--fix` step skipped under
 * non-interactive mode so {@link runDoctorFix} can print a single summary
 * note (with the interactive command to run them) instead of scattering the
 * detail across the remediation log.
 */
function noteSkippedDoctorFixStep(opts: { readonly what: string }): void {
  skippedDoctorFixSteps.push(opts.what);
}

async function dockerInfoOk(): Promise<boolean> {
  const dockerOk = await exec(["docker", "info"], { stdin: "ignore" });
  return dockerOk.exitCode === 0;
}

/**
 * The `--fix` hackd repair: restart an incompatible hackd, clear stale
 * pid/socket files, then start hackd. Each step runs `hack daemon ...` through
 * the first `hack` on PATH, and non-interactive runs accept every step.
 *
 * HACK-1368: for a candidate run that `hack` is the stable CLI, so a candidate
 * run, or any run with `HACK_DAEMON_AUTOSTART_DISABLE=1`, skips the whole
 * repair through {@link resolveDaemonAutostartAccess}, in interactive and
 * non-interactive mode alike, before it prompts or runs anything. It notes the
 * skip with the reason and the command to run instead.
 */
async function maybeRepairHackd(opts: {
  readonly serviceWrites: DaemonServiceWrites;
}): Promise<void> {
  const env = daemonRepairEnv(opts.serviceWrites);
  const report = await resolveDaemonReportForDoctorFix();
  if (report.status === "running") {
    return;
  }

  const autostart = resolveDaemonAutostartAccess();
  if (!autostart.allowed) {
    note(
      [
        `Skipped hackd repair (hackd is ${report.status}): ${autostart.message}`,
        isCandidateRun()
          ? CANDIDATE_DAEMON_GUIDANCE
          : `To repair it yourself, run: ${hackdRepairCommand(report.status)}`,
      ].join("\n"),
      "doctor fix"
    );
    return;
  }

  if (report.status === "incompatible") {
    const okRestart = await doctorConfirm({
      message: "Restart incompatible hackd now?",
      initialValue: true,
    });
    if (okRestart) {
      await runHackSubcommand({ args: ["daemon", "restart"], env });
    }
    return;
  }

  if (report.status === "stale") {
    const okClear = await doctorConfirm({
      message: "Clear stale hackd pid/socket files?",
      initialValue: true,
    });
    if (okClear) {
      await runHackSubcommand({ args: ["daemon", "clear"], env });
    }
  }

  const okStart = await doctorConfirm({
    message: "Start hackd now?",
    initialValue: true,
  });
  if (okStart) {
    await runHackSubcommand({ args: ["daemon", "start"], env });
  }
}

/**
 * Linux `--fix`: offer `hack daemon install` when the hackd systemd unit is
 * missing, drifted or disabled ({@link decideDaemonServiceFix}). It writes
 * under `~/.config/systemd/user` and enables a login service, so it is a
 * destructive step: confirmed interactively, skipped and listed without a
 * TTY. Linger is reported by the check but never changed.
 */
async function maybeInstallDaemonService(): Promise<DaemonServiceWrites> {
  if (isCandidateRun()) {
    note(CANDIDATE_DAEMON_GUIDANCE, "doctor fix");
    return "refused";
  }
  // Owner decision (HACK-2052): without a TTY, doctor --fix may start hackd
  // but never writes or reloads the unit; an interactive run that declines
  // the install carries the same refusal into the hackd repair below.
  const interactive = canPrompt();
  if (!isLinux()) {
    return interactive ? "allowed" : "refused";
  }
  const decision = decideDaemonServiceFix({
    summary: await resolveSystemdSummary({ paths: resolveDaemonPaths({}) }),
    autostart: resolveDaemonAutostartAccess(),
  });
  if (decision.kind === "none") {
    return interactive ? "allowed" : "refused";
  }
  if (decision.kind === "skip") {
    note(
      [
        `Skipped the hackd systemd service install: ${decision.reason}`,
        `To install it yourself, run: ${decision.command}`,
      ].join("\n"),
      "doctor fix"
    );
    return "refused";
  }
  const ok = await doctorConfirm({
    message: `Install hackd as a systemd user service (hack daemon install)?\nIt writes ${resolveSystemdUnitPath()} and starts hackd at login.`,
    initialValue: true,
    destructive: true,
  });
  if (!ok) {
    return "refused";
  }
  await runHackSubcommand({ args: ["daemon", "install"] });
  return "allowed";
}

/**
 * Whether the hackd repair that follows may change the systemd unit.
 * "refused" runs its `hack daemon` steps with
 * {@link SYSTEMD_READ_ONLY_ENV}=1, so `hack daemon start` neither writes nor
 * reloads the unit.
 */
type DaemonServiceWrites = "allowed" | "refused";

function daemonRepairEnv(
  writes: DaemonServiceWrites
): Record<string, string> | undefined {
  return writes === "refused" ? { [SYSTEMD_READ_ONLY_ENV]: "1" } : undefined;
}

/** The explicit commands that perform the {@link maybeRepairHackd} steps. */
function hackdRepairCommand(
  status: ReturnType<typeof buildDaemonStatusReport>["status"]
): string {
  if (status === "incompatible") {
    return "hack daemon restart";
  }
  if (status === "stale") {
    return "hack daemon clear && hack daemon start";
  }
  return "hack daemon start";
}

/**
 * Optional integrations are current when absent: a path is stale only when it
 * exists and lacks the current revision marker, or exists but cannot be read.
 * AGENTS.md/CLAUDE.md are user-owned, so they count only when they carry a
 * Hack start or end marker; a section with only one of the two markers is
 * corrupted and stale. Retained legacy artifacts are always stale.
 */
export async function inspectDoctorAgentIntegrations(opts: {
  readonly projectRoot: string | null;
  readonly homeDir?: string;
}): Promise<{ readonly status: "current" | "stale" }> {
  const home = normalizeHomeDir(opts.homeDir) ?? resolveUserHomeDir();
  const hackOwnedPaths = [
    ...(opts.projectRoot
      ? [
          resolve(opts.projectRoot, ".cursor", "rules", "hack.mdc"),
          resolve(opts.projectRoot, ".codex", "skills", "hack-cli", "SKILL.md"),
        ]
      : []),
    resolve(home, ".cursor", "rules", "hack.mdc"),
    resolve(home, ".codex", "skills", "hack-cli", "SKILL.md"),
    resolve(home, ".ai", "skills", "hack-cli", "SKILL.md"),
  ];
  const sharedDocPaths = opts.projectRoot
    ? [
        resolve(opts.projectRoot, "AGENTS.md"),
        resolve(opts.projectRoot, "CLAUDE.md"),
      ]
    : [];
  const marker = `Content revision: \`${HACK_AGENT_INTEGRATION_CONTENT_REVISION}\``;
  const [ownedContents, docContents, legacyProject, legacyUser] =
    await Promise.all([
      Promise.all(
        hackOwnedPaths.map((path) => readOptionalIntegrationText(path))
      ),
      Promise.all(
        sharedDocPaths.map((path) => readOptionalIntegrationText(path))
      ),
      opts.projectRoot
        ? checkLegacyProjectAgentArtifacts({ projectRoot: opts.projectRoot })
        : Promise.resolve([]),
      checkLegacyUserAgentArtifacts({ home }),
    ]);
  const hasLegacyArtifacts = [...legacyProject, ...legacyUser].some(
    (check) => check.status !== "absent"
  );
  // Present but unreadable paths are treated as stale rather than absent.
  const hasStalePath =
    ownedContents.some(
      (content) =>
        content.present &&
        (content.text === null || !content.text.includes(marker))
    ) ||
    docContents.some(
      (content) =>
        content.present &&
        (content.text === null ||
          isStaleAgentDocSection({ text: content.text, marker }))
    );
  return {
    status: hasStalePath || hasLegacyArtifacts ? "stale" : "current",
  };
}

const HACK_AGENT_DOCS_SECTION_START = "<!-- hack:agent-docs:start -->";
const HACK_AGENT_DOCS_SECTION_END = "<!-- hack:agent-docs:end -->";

/**
 * A user-owned doc with neither Hack marker is not stale. A doc with only one
 * marker is a corrupted managed section; a complete section is stale when it
 * lacks the current revision marker.
 */
function isStaleAgentDocSection(opts: {
  readonly text: string;
  readonly marker: string;
}): boolean {
  const hasStart = opts.text.includes(HACK_AGENT_DOCS_SECTION_START);
  const hasEnd = opts.text.includes(HACK_AGENT_DOCS_SECTION_END);
  if (!(hasStart || hasEnd)) {
    return false;
  }
  if (!(hasStart && hasEnd)) {
    return true;
  }
  return !opts.text.includes(opts.marker);
}

async function readOptionalIntegrationText(
  path: string
): Promise<
  | { readonly present: false }
  | { readonly present: true; readonly text: string | null }
> {
  const file = await readOptionalTextFile(path);
  if (file.kind === "absent") {
    return { present: false };
  }
  return { present: true, text: file.kind === "text" ? file.text : null };
}

async function resolveDaemonReportForDoctorFix(): Promise<
  ReturnType<typeof buildDaemonStatusReport>
> {
  const daemonPaths = resolveDaemonPaths({});
  const daemonStatus = await readDaemonStatus({ paths: daemonPaths });
  const probe = daemonStatus.socketExists
    ? await probeDaemonApi({
        socketPath: daemonPaths.socketPath,
        timeoutMs: 500,
      })
    : { reachable: false, compatible: false, version: null };

  return buildDaemonStatusReport({
    pid: daemonStatus.pid,
    processRunning: daemonStatus.running,
    socketExists: daemonStatus.socketExists,
    logExists: daemonStatus.logExists,
    apiReachable: probe.reachable,
    apiCompatible: probe.compatible,
  });
}

async function runHackSubcommand(opts: {
  readonly args: readonly string[];
  readonly env?: Record<string, string>;
}): Promise<void> {
  const invocation = await resolveHackInvocation();
  await run([invocation.bin, ...invocation.args, ...opts.args], {
    hackReexec: true,
    stdin: "inherit",
    ...(opts.env ? { env: opts.env } : {}),
  });
}

async function ensureIngressNetwork(): Promise<{
  exists: boolean;
  hasSubnet: boolean;
}> {
  const ingress = await inspectDockerNetwork(DEFAULT_INGRESS_NETWORK);
  if (ingress.exists && ingress.hasSubnet) {
    return ingress;
  }

  const action = ingress.exists ? "Recreate" : "Create";
  const okNetwork = await doctorConfirm({
    message: `${action} ${DEFAULT_INGRESS_NETWORK} with subnet ${DEFAULT_INGRESS_SUBNET}?`,
    initialValue: true,
  });
  if (!okNetwork) {
    return ingress;
  }

  if (ingress.exists) {
    const removed = await exec(
      ["docker", "network", "rm", DEFAULT_INGRESS_NETWORK],
      {
        stdin: "ignore",
      }
    );
    if (removed.exitCode !== 0) {
      note(commandFailureDetail({ result: removed }), "runtime repair");
      return ingress;
    }
  }
  const created = await exec(
    [
      "docker",
      "network",
      "create",
      DEFAULT_INGRESS_NETWORK,
      "--subnet",
      DEFAULT_INGRESS_SUBNET,
      "--gateway",
      DEFAULT_INGRESS_GATEWAY,
    ],
    { stdin: "ignore" }
  );
  if (created.exitCode !== 0) {
    note(commandFailureDetail({ result: created }), "runtime repair");
  }

  return await inspectDockerNetwork(DEFAULT_INGRESS_NETWORK);
}

async function ensureLoggingNetwork(): Promise<void> {
  const logging = await inspectDockerNetwork(DEFAULT_LOGGING_NETWORK);
  if (logging.exists) {
    return;
  }

  const created = await exec(
    ["docker", "network", "create", DEFAULT_LOGGING_NETWORK],
    {
      stdin: "ignore",
    }
  );
  if (created.exitCode !== 0) {
    note(commandFailureDetail({ result: created }), "runtime repair");
  }
}

async function maybeStartGlobalCaddyCompose(opts: {
  readonly paths: ReturnType<typeof getGlobalPaths>;
}): Promise<void> {
  if (!(await pathExists(opts.paths.caddyCompose))) {
    return;
  }

  const started = await exec(
    [
      "docker",
      "compose",
      "-f",
      opts.paths.caddyCompose,
      "up",
      "-d",
      "--remove-orphans",
    ],
    {
      cwd: dirname(opts.paths.caddyCompose),
      stdin: "ignore",
    }
  );
  if (started.exitCode !== 0) {
    note(commandFailureDetail({ result: started }), "runtime repair");
    return;
  }
  note("CoreDNS and Caddy are ready.", "runtime repair");
}

function commandFailureDetail(input: {
  readonly result: {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  };
}): string {
  const detail = input.result.stderr.trim() || input.result.stdout.trim();
  return detail.length > 0
    ? `Repair command failed: ${detail}`
    : `Repair command failed (exit ${input.result.exitCode}).`;
}

async function maybeExportCaddyCaCert(opts: {
  readonly paths: ReturnType<typeof getGlobalPaths>;
}): Promise<void> {
  const result = await repairCaddyCaExport({
    composeFile: opts.paths.caddyCompose,
    certPath: opts.paths.caddyCaCert,
    confirm: () =>
      doctorConfirm({
        message:
          "Refresh the exported Caddy Local CA from the running Caddy container? (does not change system trust)",
        initialValue: true,
      }),
  });
  note(result.message, "Caddy CA export");
}

async function maybeRepairMacHostTlsTrust(): Promise<void> {
  if (!isMac()) {
    return;
  }

  const hostTlsTrust = await checkMacHostTlsTrust();
  if (hostTlsTrust.status === "ok") {
    return;
  }

  note(hostTlsTrust.message, "doctor");
  // Not classified destructive: `hack global trust` is itself
  // non-interactive-safe — it preflights sudo and skips only the System
  // keychain step, while the safe host trust env/bundle writes always run.
  const okRepair = await doctorConfirm({
    message:
      "Repair macOS host TLS trust now? (Bun/Node/curl/git trust for https://*.hack; the sudo System-keychain step is skipped automatically when it would prompt)",
    initialValue: true,
  });
  if (!okRepair) {
    return;
  }

  await runHackSubcommand({
    args: ["global", "trust"],
  });
}

async function maybeMigrateDnsmasq(): Promise<void> {
  if (!isMac()) {
    return;
  }

  const migrationResult = await migrateDnsmasqToContainerIpIfNeeded();
  if (migrationResult !== "migrated") {
    return;
  }

  note("dnsmasq updated to the reachable local ingress target", "doctor");
}

/**
 * Reconcile dnsmasq host routing to whichever ingress target is actually reachable.
 */
async function migrateDnsmasqToContainerIpIfNeeded(): Promise<
  "migrated" | "skipped" | "not-needed"
> {
  const brew = await findExecutableInPath("brew");
  if (!brew) {
    return "skipped";
  }

  const prefixRes = await exec(["brew", "--prefix"], { stdin: "ignore" });
  const brewPrefix =
    prefixRes.exitCode === 0 ? prefixRes.stdout.trim() : "/opt/homebrew";
  const dnsmasqConf = resolve(brewPrefix, "etc", "dnsmasq.conf");
  const text = await readTextFile(dnsmasqConf);

  if (!text) {
    return "skipped";
  }

  const targetIp = await resolvePreferredMacHostDnsTarget();
  const desiredHackLine = `address=/.${DEFAULT_PROJECT_TLD}/${targetIp}`;
  const desiredNewLine = `address=/.${DEFAULT_NEW_PROJECT_TLD}/${targetIp}`;
  const desiredOauthLine = `address=/.${DEFAULT_OAUTH_ALIAS_ROOT}/${targetIp}`;
  const legacyHostTarget =
    targetIp === DEFAULT_CADDY_IP ? DEFAULT_HOST_DNS_IP : DEFAULT_CADDY_IP;
  const legacyLines = [
    `address=/.${DEFAULT_PROJECT_TLD}/${legacyHostTarget}`,
    `address=/.${DEFAULT_NEW_PROJECT_TLD}/${legacyHostTarget}`,
    `address=/.${DEFAULT_OAUTH_ALIAS_ROOT}/${legacyHostTarget}`,
    `address=/.${DEFAULT_PROJECT_TLD}/::1`,
    `address=/.${DEFAULT_NEW_PROJECT_TLD}/::1`,
    `address=/.${DEFAULT_OAUTH_ALIAS_ROOT}/::1`,
  ];

  const hasDesired =
    text.includes(desiredHackLine) &&
    text.includes(desiredOauthLine) &&
    text.includes(desiredNewLine);
  const hasLegacy = legacyLines.some((line) => text.includes(line));

  if (hasDesired && !hasLegacy) {
    return "not-needed";
  }

  const okMigrate = await doctorConfirm({
    message: `Update dnsmasq to use ${targetIp} for .${DEFAULT_PROJECT_TLD}, .${DEFAULT_NEW_PROJECT_TLD} and .${DEFAULT_OAUTH_ALIAS_ROOT} host routing? (requires sudo to restart dnsmasq and flush the DNS cache)`,
    initialValue: true,
    destructive: true,
  });
  if (!okMigrate) {
    return "skipped";
  }

  // Remove the old host target lines and add the newly selected one.
  let updated = text;
  for (const legacyLine of legacyLines) {
    updated = updated.replace(legacyLine, "");
  }
  updated = updated.replace(/\n{3,}/g, "\n\n").trim();
  const missing = [desiredHackLine, desiredNewLine, desiredOauthLine].filter(
    (line) => !updated.split("\n").includes(line)
  );
  updated = `${updated}\n${missing.join("\n")}\n`;

  await writeTextFileIfChanged(dnsmasqConf, updated);

  // Restart dnsmasq (requires sudo)
  note("Restarting dnsmasq (requires sudo)...", "doctor");
  const restartExit = await run(
    ["sudo", "brew", "services", "restart", "dnsmasq"],
    {
      stdin: "inherit",
    }
  );

  if (restartExit !== 0) {
    note(
      `Failed to restart dnsmasq (exit ${restartExit}). Run: sudo brew services restart dnsmasq`,
      "doctor"
    );
    return "skipped";
  }

  // Flush macOS DNS cache to clear stale entries
  note("Flushing DNS cache...", "doctor");
  await run(["sudo", "dscacheutil", "-flushcache"], { stdin: "inherit" });
  await run(["sudo", "killall", "-HUP", "mDNSResponder"], { stdin: "inherit" });

  return "migrated";
}

async function inspectDockerNetwork(
  name: string
): Promise<{ exists: boolean; hasSubnet: boolean }> {
  const res = await exec(["docker", "network", "inspect", name], {
    stdin: "ignore",
  });
  if (res.exitCode !== 0) {
    return { exists: false, hasSubnet: false };
  }
  return {
    exists: true,
    hasSubnet: networkHasSubnet(res.stdout, DEFAULT_INGRESS_SUBNET),
  };
}

function networkHasSubnet(raw: string, subnet: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) {
    return false;
  }
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const ipam = (item as { IPAM?: { Config?: Array<{ Subnet?: string }> } })
      .IPAM;
    const configs = ipam?.Config ?? [];
    if (configs.some((cfg) => cfg?.Subnet === subnet)) {
      return true;
    }
  }
  return false;
}

async function resolveCoreDnsServer(): Promise<string | null> {
  const paths = getGlobalPaths();
  if (!(await pathExists(paths.caddyCompose))) {
    return null;
  }

  const ps = await exec(
    ["docker", "compose", "-f", paths.caddyCompose, "ps", "-q", "coredns"],
    {
      cwd: dirname(paths.caddyCompose),
      stdin: "ignore",
    }
  );
  const id = ps.exitCode === 0 ? ps.stdout.trim() : "";
  if (!id) {
    return null;
  }

  const inspect = await exec(
    ["docker", "inspect", "--format", "{{json .NetworkSettings.Networks}}", id],
    { stdin: "ignore" }
  );
  if (inspect.exitCode !== 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(inspect.stdout);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const network = (parsed as Record<string, { IPAddress?: string }>)[
    DEFAULT_INGRESS_NETWORK
  ];
  if (!network) {
    return null;
  }
  return typeof network.IPAddress === "string" && network.IPAddress.length > 0
    ? network.IPAddress
    : null;
}

type GlobalPaths = {
  readonly root: string;
  readonly caddyDir: string;
  readonly caddyCompose: string;
  readonly coreDnsConfig: string;
  readonly caddyCaCert: string;
  readonly loggingCompose: string;
};

function getGlobalPaths(): GlobalPaths {
  const root = resolveGlobalHackDir();
  const caddyDir = resolve(root, GLOBAL_CADDY_DIR_NAME);
  const caddyCompose = resolve(caddyDir, GLOBAL_CADDY_COMPOSE_FILENAME);
  const coreDnsConfig = resolve(caddyDir, GLOBAL_COREDNS_FILENAME);
  const caddyCaCert = resolve(caddyDir, "pki", "caddy-local-authority.crt");
  const loggingCompose = resolve(
    root,
    GLOBAL_LOGGING_DIR_NAME,
    GLOBAL_LOGGING_COMPOSE_FILENAME
  );
  return {
    root,
    caddyDir,
    caddyCompose,
    coreDnsConfig,
    caddyCaCert,
    loggingCompose,
  };
}

async function writeWithPromptIfDifferent(
  absolutePath: string,
  content: string
): Promise<void> {
  const existing = await readTextFile(absolutePath);
  if (existing === content) {
    return;
  }

  if (existing !== null) {
    const ok = await doctorConfirm({
      message: `Overwrite existing file?\n${absolutePath}`,
      initialValue: true,
    });
    if (!ok) {
      return;
    }
  }

  await ensureDir(dirname(absolutePath));
  await writeTextFileIfChanged(absolutePath, content);
}

function emitSlowChecksNote(results: readonly TimedCheckResult[]): void {
  const slow = results
    .filter((r) => r.durationMs >= 500)
    .map((r) => `${r.name} (${r.durationMs}ms)`);
  if (slow.length === 0) {
    return;
  }
  note(slow.join("\n"), "Slow checks");
}

async function renderRecoveryGuidance(
  results: readonly TimedCheckResult[]
): Promise<void> {
  const guidance = buildDoctorRecoveryGuidance({ results });
  const hasActions =
    guidance.temporaryBreakage.length > 0 ||
    guidance.configurationRepair.length > 0 ||
    (guidance.choices?.length ?? 0) > 0 ||
    guidance.followUp.length > 0;

  if (!hasActions) {
    return;
  }

  await display.panel({
    title: "Recovery workflow",
    tone: "info",
    lines: buildRecoveryWorkflowLines({
      guidance,
      projectRoot: null,
    }),
  });
}

export function buildDoctorSummaryLines(input: {
  readonly results: readonly RecoveryCheckResult[];
}): readonly string[] {
  const lines: string[] = [];

  for (const group of DOCTOR_SUMMARY_GROUPS) {
    const members = input.results.filter((result) =>
      group.checks.has(result.name)
    );
    if (members.length === 0) {
      continue;
    }

    const issues = members.filter(
      (result) =>
        result.status !== "ok" && !isIgnorableDoctorSummaryIssue(result)
    );
    if (issues.length === 0) {
      lines.push(`${group.title}: ok`);
      continue;
    }

    const status = issues.some((result) => result.status === "error")
      ? "error"
      : "warn";
    lines.push(
      `${group.title}: ${status} - ${summarizeDoctorGroupIssues({
        title: group.title,
        issues,
      })}`
    );
  }

  const ungrouped = input.results.filter(
    (result) =>
      !DOCTOR_SUMMARY_GROUPS.some((group) => group.checks.has(result.name))
  );
  if (ungrouped.length > 0) {
    const issues = ungrouped.filter(
      (result) =>
        result.status !== "ok" && !isIgnorableDoctorSummaryIssue(result)
    );
    lines.push(
      issues.length === 0
        ? "Other checks: ok"
        : `Other checks: warn - ${summarizeDoctorIssues(issues)}`
    );
  }

  return lines;
}

export function buildDoctorSummaryStatusItems(input: {
  readonly results: readonly RecoveryCheckResult[];
}): readonly DisplayStatusItem[] {
  const items: DisplayStatusItem[] = [];

  for (const group of DOCTOR_SUMMARY_GROUPS) {
    const members = input.results.filter((result) =>
      group.checks.has(result.name)
    );
    if (members.length === 0) {
      continue;
    }
    items.push(buildDoctorSummaryStatusItem({ title: group.title, members }));
  }

  const ungrouped = input.results.filter(
    (result) =>
      !DOCTOR_SUMMARY_GROUPS.some((group) => group.checks.has(result.name))
  );
  if (ungrouped.length > 0) {
    items.push(
      buildDoctorSummaryStatusItem({
        title: "Other checks",
        members: ungrouped,
      })
    );
  }

  return items;
}

function buildDoctorSummaryStatusItem(input: {
  readonly title: string;
  readonly members: readonly RecoveryCheckResult[];
}): DisplayStatusItem {
  const issues = input.members.filter(
    (result) => result.status !== "ok" && !isIgnorableDoctorSummaryIssue(result)
  );
  const errorCount = issues.filter(
    (result) => result.status === "error"
  ).length;
  const warningCount = issues.length - errorCount;
  let status: DisplayStatusItem["status"] = "ok";
  if (errorCount > 0) {
    status = "error";
  } else if (warningCount > 0) {
    status = "warn";
  }

  const issueCounts = [
    errorCount > 0 ? `${errorCount} error${errorCount === 1 ? "" : "s"}` : null,
    warningCount > 0
      ? `${warningCount} warning${warningCount === 1 ? "" : "s"}`
      : null,
  ].filter((part): part is string => part !== null);

  return {
    label: input.title,
    status,
    meta:
      issueCounts.length > 0
        ? issueCounts.join(", ")
        : `${input.members.length} checks`,
    detail:
      issues.length > 0
        ? summarizeDoctorGroupIssues({ title: input.title, issues })
        : undefined,
  };
}

async function renderDoctorSummary(
  results: readonly TimedCheckResult[]
): Promise<void> {
  await display.statusList({
    title: "Doctor summary",
    items: buildDoctorSummaryStatusItems({ results }),
  });
}

function summarizeDoctorGroupIssues(input: {
  readonly title: string;
  readonly issues: readonly RecoveryCheckResult[];
}): string {
  if (input.title === "Dependencies") {
    const optionalMissing = input.issues
      .filter((result) => result.message === "Not found (optional)")
      .map((result) => result.name.replace(" (optional)", ""));
    const other = input.issues.filter(
      (result) => result.message !== "Not found (optional)"
    );

    const parts: string[] = [];
    if (optionalMissing.length > 0) {
      parts.push(`optional missing: ${optionalMissing.join(", ")}`);
    }
    if (other.length > 0) {
      parts.push(summarizeDoctorIssues(other));
    }
    return parts.join("; ");
  }

  return summarizeDoctorIssues(input.issues);
}

function isIgnorableDoctorSummaryIssue(issue: RecoveryCheckResult): boolean {
  return (
    issue.message === "Not found (optional)" ||
    (issue.name === "gateway tokens" &&
      issue.message.includes("No active tokens"))
  );
}

function summarizeDoctorIssues(issues: readonly RecoveryCheckResult[]): string {
  const descriptions = issues.map((issue) => summarizeDoctorIssue(issue));
  if (descriptions.length <= 2) {
    return descriptions.join("; ");
  }

  return `${descriptions.slice(0, 2).join("; ")}; +${descriptions.length - 2} more`;
}

function summarizeDoctorIssue(issue: RecoveryCheckResult): string {
  if (
    issue.name === "env mode" &&
    issue.message.includes("Legacy env format detected")
  ) {
    return "legacy env format detected";
  }

  if (
    issue.name === "gateway tokens" &&
    issue.message.includes("No active tokens")
  ) {
    return "no active gateway tokens";
  }

  if (issue.message === "Not found (optional)") {
    return `${issue.name} missing`;
  }

  return `${issue.name}: ${issue.message}`;
}

async function renderMacNote(
  results: readonly TimedCheckResult[]
): Promise<void> {
  const hasResolverIssue = results.some(
    (result) =>
      result.status !== "ok" &&
      (result.name.startsWith("resolver:") ||
        result.name.startsWith("dnsmasq.conf:"))
  );
  if (!(isMac() && hasResolverIssue)) {
    return;
  }

  await display.statusList({
    title: "macOS resolver setup",
    items: [
      {
        label: `*.${DEFAULT_NEW_PROJECT_TLD}`,
        status: "info",
        detail: `/etc/resolver/${DEFAULT_NEW_PROJECT_TLD} with dnsmasq address=/.${DEFAULT_NEW_PROJECT_TLD}/<reachable-ingress-target> (run: hack global install)`,
      },
      {
        label: `*.${DEFAULT_PROJECT_TLD}`,
        status: "info",
        detail: `/etc/resolver/${DEFAULT_PROJECT_TLD} with dnsmasq address=/.${DEFAULT_PROJECT_TLD}/<reachable-ingress-target>`,
      },
      {
        label: `*.${DEFAULT_OAUTH_ALIAS_ROOT}`,
        status: "info",
        detail: `/etc/resolver/${DEFAULT_OAUTH_ALIAS_ROOT} with dnsmasq address=/.${DEFAULT_OAUTH_ALIAS_ROOT}/<reachable-ingress-target>`,
      },
    ],
  });
}

async function resolvePreferredMacHostDnsTarget(): Promise<string> {
  const [containerIpReachable, localhostReachable] = await Promise.all([
    canConnectTcp({ host: DEFAULT_CADDY_IP, port: 443, timeoutMs: 1500 }),
    canConnectTcp({ host: DEFAULT_HOST_DNS_IP, port: 443, timeoutMs: 1500 }),
  ]);

  return resolvePreferredHostDnsTarget({
    containerIpReachable,
    localhostReachable,
  });
}

async function canConnectTcp(opts: {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
}): Promise<boolean> {
  const { createConnection } = await import("node:net");

  return await new Promise((resolve) => {
    const socket = createConnection({
      host: opts.host,
      port: opts.port,
      timeout: opts.timeoutMs,
    });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

// Keep macOS guidance at the end so it doesn't push other output off-screen.
// (Called from the command handler.)
async function runCheck(
  _s: DoctorProgress,
  name: string,
  fn: () => CheckResult | Promise<CheckResult>,
  opts?: { readonly timeoutMs?: number }
): Promise<TimedCheckResult> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = opts?.timeoutMs
      ? await Promise.race([
          fn(),
          new Promise<CheckResult>((resolve) => {
            timer = setTimeout(
              () => resolve({ name, status: "warn", message: "Timed out" }),
              opts.timeoutMs
            );
          }),
        ])
      : await fn();
    const durationMs = Date.now() - start;
    return { ...res, durationMs };
  } catch (err: unknown) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : "Unknown error";
    const res: CheckResult = { name, status: "error", message };
    return { ...res, durationMs };
  } finally {
    // A settled check must not keep the process alive until its deadline.
    clearTimeout(timer);
  }
}

async function checkProxyNetwork(): Promise<CheckResult> {
  const composeFile = getGlobalPaths().caddyCompose;
  if (!(await pathExists(composeFile))) {
    return {
      name: PROXY_NETWORK_CHECK,
      status: "warn",
      message: `Missing ${composeFile} (run: hack global install)`,
    };
  }
  const issues = await inspectProxyNetwork({ composeFile });
  if (issues === null) {
    return {
      name: PROXY_NETWORK_CHECK,
      status: "warn",
      message: "Unable to read the proxy containers from Docker",
    };
  }
  if (issues.length === 0) {
    return {
      name: PROXY_NETWORK_CHECK,
      status: "ok",
      message: `Proxy containers are on ${DEFAULT_INGRESS_NETWORK}`,
    };
  }
  return {
    name: PROXY_NETWORK_CHECK,
    status: "error",
    message: [
      ...issues.map(describeProxyNetworkIssue),
      "fix: hack global up (recreates the proxy stack)",
    ].join("\n"),
  };
}
