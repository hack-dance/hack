import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { note, spinner } from "@clack/prompts";
import {
  type NativeRuntimeSelection,
  resolveNativeRuntimeSelection,
} from "../backends/native-runtime-client.ts";
import type {
  CliContext,
  CommandArgs,
  CommandHandlerFor,
} from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import {
  optFollow,
  optJson,
  optNoFollow,
  optPretty,
  optTail,
} from "../cli/options.ts";
import {
  DEFAULT_CADDY_IP,
  DEFAULT_COREDNS_IP,
  DEFAULT_GRAFANA_HOST,
  DEFAULT_HOST_DNS_IP,
  DEFAULT_INGRESS_GATEWAY,
  DEFAULT_INGRESS_NETWORK,
  DEFAULT_INGRESS_SUBNET,
  DEFAULT_LOGGING_NETWORK,
  DEFAULT_NEW_PROJECT_TLD,
  DEFAULT_OAUTH_ALIAS_ROOT,
  DEFAULT_PROJECT_TLD,
  GLOBAL_ALLOY_FILENAME,
  GLOBAL_BRANCHES_SCHEMA_FILENAME,
  GLOBAL_CADDY_COMPOSE_FILENAME,
  GLOBAL_CADDY_DIR_NAME,
  GLOBAL_CERTS_DIR_NAME,
  GLOBAL_CLOUDFLARE_DIR_NAME,
  GLOBAL_CONFIG_SCHEMA_FILENAME,
  GLOBAL_COREDNS_FILENAME,
  GLOBAL_ENV_SCHEMA_FILENAME,
  GLOBAL_GRAFANA_DASHBOARD_FILENAME,
  GLOBAL_GRAFANA_DASHBOARDS_PROVISIONING_FILENAME,
  GLOBAL_GRAFANA_DATASOURCE_FILENAME,
  GLOBAL_LOGGING_COMPOSE_FILENAME,
  GLOBAL_LOGGING_DIR_NAME,
  GLOBAL_LOGGING_PROJECT_NAME,
  GLOBAL_LOKI_CONFIG_FILENAME,
  GLOBAL_MANAGED_ENV_SCHEMA_FILENAME,
  GLOBAL_SCHEMAS_DIR_NAME,
} from "../constants.ts";
import { resolveGatewayConfig } from "../control-plane/extensions/gateway/config.ts";
import { listGatewayTokensForStatus } from "../control-plane/extensions/gateway/tokens.ts";
import type { ControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { resolveDaemonAutostartAccess } from "../daemon/client.ts";
import {
  getLaunchdServiceStatus,
  resolveLaunchdAccess,
} from "../daemon/launchd.ts";
import { resolveDaemonPaths } from "../daemon/paths.ts";
import { isProcessRunning } from "../daemon/process.ts";
import { readDaemonStatus } from "../daemon/status.ts";
import { caddyCaExportReplaceable } from "../lib/caddy-ca-export.ts";
import {
  copyRuntimeRoot,
  inspectCaddyCaIdentity,
} from "../lib/caddy-ca-identity.ts";
import { observeGlobalCaddyIp } from "../lib/caddy-hosts.ts";
import {
  emitCliResult,
  errorResult,
  HackCliError,
  okResult,
} from "../lib/cli-result.ts";
import { updateGlobalConfig } from "../lib/config.ts";
import {
  resolveGlobalConfigPath,
  resolveGlobalHackDir,
} from "../lib/config-paths.ts";
import {
  managedLocalDomains,
  parseDefaultDomain,
  resolveDefaultDomain,
  resolveDefaultDomainStrictly,
} from "../lib/default-domain.ts";
import { dockerEngineSupportsStartInterval } from "../lib/docker-engine-features.ts";
import {
  isSlimExecutionMode,
  renderSlimModeUnavailableMessage,
} from "../lib/execution-mode.ts";
import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFile,
  writeTextFileIfChanged,
} from "../lib/fs.ts";
import {
  containerReadableGlobalPaths,
  describeUnreadableContainerPaths,
  ensureContainerReadable,
  unreadableContainerPaths,
} from "../lib/global-container-config.ts";
import {
  LOGGING_ENABLE_COMMAND,
  LOGGING_ENABLED_CONFIG_KEY,
  resolveAndSaveGlobalLogging,
  resolveGlobalLogging,
  resolveLoggingFlag,
} from "../lib/global-logging.ts";
import { describeProxyNetworkIssue } from "../lib/global-proxy-network.ts";
import * as routeChecks from "../lib/global-route-checks.ts";
import {
  classifyNslookup,
  lookHttps,
  type RouteProbeResult,
  routeHttpsTargets,
  routeProbeName,
  waitForRoutes,
} from "../lib/global-route-probe.ts";
import {
  describeContainersNotHealthy,
  describeContainersNotRunning,
  parseComposePs,
  waitForStartedContainers,
} from "../lib/global-stack-state.ts";
import { getString, isRecord } from "../lib/guards.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import {
  canPrompt,
  confirmSafe,
  isExplicitlyNonInteractive,
} from "../lib/interactivity.ts";
import { parseJsonLines } from "../lib/json-lines.ts";
import { createLinuxDnsHost } from "../lib/linux-dns-host.ts";
import { createLinuxTrustHost } from "../lib/linux-trust-host.ts";
import { prepareLinuxSystemTrust } from "../lib/linux-trust-setup.ts";
import {
  buildHackHostTrustEnvironment,
  renderHackHostTrustShellExports,
  resolveHackHostTrustBundlePath,
  resolveHackHostTrustEnvScriptPath,
  resolveHackLocalCaCertPath,
} from "../lib/local-ca.ts";
import { inspectMacCaEligibility } from "../lib/mac-ca-trust.ts";
import { MACHINE_SCHEMAS, machineSuccess } from "../lib/machine-output.ts";
import { childStdoutTarget } from "../lib/machine-stdout.ts";
import {
  isHackRenderedLoggingCompose,
  removeUnstartedProxyContainers,
  resolveManagedProxyBind,
  writeManagedProxyCompose,
} from "../lib/managed-proxy-compose.ts";
import {
  ensureBundledMutagenInstalled,
  getMutagenPath,
} from "../lib/mutagen.ts";
import type { NativeDnsActivationInspection } from "../lib/native-domain-dns-activate.ts";
import { activateNativeDomainDns } from "../lib/native-domain-dns-activate.ts";
import { createNativeDnsAuthorizer } from "../lib/native-domain-dns-authorization.ts";
import { deactivateNativeDomainDns } from "../lib/native-domain-dns-deactivate.ts";
import { createNativeDnsHostDependencies } from "../lib/native-domain-dns-host.ts";
import { prepareNativeDnsLaunchdRestart } from "../lib/native-domain-dns-launchd.ts";
import {
  describeNativeDnsPreview,
  type NativeDnsReceipt,
  planNativeDomainDns,
} from "../lib/native-domain-dns-plan.ts";
import {
  inspectNativeDnsHost,
  readStableNativeDnsFile,
} from "../lib/native-domain-dns-snapshot.ts";
import {
  describeHackLocalRollback,
  describeHackLocalRoute,
  inspectHackLocalRoute,
  reportHackLocalRoute,
  rollbackHackLocalRoute,
  selectNativeDnsCommandDomain,
} from "../lib/native-hack-local-route.ts";
import { createNativeHackLocalRouteDependencies } from "../lib/native-hack-local-route-host.ts";
import { isLinux, isMac } from "../lib/os.ts";
import { resolveTrustedSudo } from "../lib/privileged-sudo.ts";
import { withProcessDeadline } from "../lib/process-deadline.ts";
import { readProxyBindFromCompose } from "../lib/proxy-bind.ts";
import {
  defaultIngressAddressDeps,
  resolveIngressAddresses,
  selectedDockerEngine,
  withIngressChange,
} from "../lib/proxy-ingress-addresses.ts";
import { diagnoseProxyPortConflict } from "../lib/proxy-port-listeners.ts";
import { stopRemoteCaddyRoutesStack } from "../lib/remote-caddy-routes.ts";
import {
  detectDockerBackend,
  formatDockerConnectionGuidance,
} from "../lib/runtime-guidance.ts";
import {
  exec,
  execOrThrow,
  findExecutableInPath,
  run as runShell,
} from "../lib/shell.ts";
import { createTrustedDockerExec } from "../lib/trusted-docker.ts";
import { resolveSessionsMuxMode } from "../mux/mux-config.ts";
import {
  renderGlobalAlloyConfig,
  renderGlobalCaddyCompose,
  renderGlobalCoreDnsConfig,
  renderGlobalGrafanaDashboardsProvisioningYaml,
  renderGlobalGrafanaDatasourceYaml,
  renderGlobalGrafanaLogsDashboardJson,
  renderGlobalLoggingCompose,
  renderGlobalLokiConfigYaml,
  renderProjectBranchesSchemaJson,
  renderProjectConfigSchemaJson,
  renderProjectEnvSchemaJson,
  renderProjectManagedEnvSchemaJson,
} from "../templates.ts";
import { display } from "../ui/display.ts";
import { dockerComposeLogsPretty } from "../ui/docker-logs.ts";
import { ensureBundledGumInstalled } from "../ui/gum.ts";
import {
  captureLoggedProblems,
  logger,
  setLoggerBackendOverride,
} from "../ui/logger.ts";
import { resolvePreferredHostDnsTarget } from "./doctor-utils.ts";
import {
  type AdminPlan,
  classifyDockerInfo,
  type MacInstallSnapshot,
  planGlobalInstall,
  planGlobalInstallTrust,
  planGlobalTrust,
  type TrustPlanDeps,
} from "./global-admin-plan.ts";
import {
  assertGlobalBackendStartAllowed,
  assertGlobalLoginRoutingImages,
  globalDnsRecoveryAllowed,
  globalLoggingUpArguments,
  globalRoutingUpArguments,
  reconcileGlobalRoutingBridge,
  secureGlobalLoginRouting,
} from "./global-autostart.ts";
import {
  executeMacPrivilegedCommand,
  macAuthorizationArgv,
  macDnsmasqNeedsStart,
  macFlushCommands,
  macResolverArgv,
  macRestartCommands,
} from "./global-install-actions.ts";
import {
  bootstrapLinuxGlobalDns,
  inspectLinuxGlobalDns,
  linuxDnsStatusPayload,
  offerLinuxGlobalDnsRemoval,
} from "./global-linux-dns.ts";
import {
  configureLinuxSystemAndBrowserTrust,
  configureLinuxTrustFromRuntime,
  type LinuxTrustResult,
} from "./global-linux-trust.ts";
import { observeMacHostDns } from "./global-mac-dns.ts";
import {
  ensureMacTrustCaddyLocalCa,
  prepareMacTrustForPlan,
} from "./global-mac-trust.ts";
import {
  inspectProxyNetwork,
  proxyNetworkStatusPayload,
  repairProxyNetworkBeforeUp,
} from "./global-proxy-network.ts";
import {
  DOCKER_PROBE_TIMEOUT_MS,
  observeGlobalStatus,
} from "./global-status-observe.ts";
import {
  DOCKER_READ_TIMEOUT_MS,
  isServiceRunning,
  observeComposeStack,
  observeNetworks,
  observeProxyNetwork,
} from "./global-status-observe-host.ts";

/** Regex to split strings on whitespace. */

/**
 * `run` for this file's commands: while stdout is reserved for a `--json`
 * envelope (set by `runCli` from Hack's own argv), a child's stdout goes to
 * stderr, so `hack daemon start`, Compose and the rest cannot print into
 * the envelope. Without `--json` it is inherited, as before.
 */
function run(
  cmd: readonly string[],
  opts: Parameters<typeof runShell>[1] = {}
): ReturnType<typeof runShell> {
  return runShell(cmd, {
    ...opts,
    stdout: opts.stdout ?? childStdoutTarget(undefined),
  });
}
const WHITESPACE_PATTERN = /\s+/;
const MAC_DNS_SUDOERS_PATH = "/etc/sudoers.d/dance.hack-dns-recovery";
const MAC_DNS_SUDOERS_TEMP_FILENAME = "dance.hack-dns-recovery.sudoers";
const MAC_DNS_RECOVERY_HELPER_PATH = "/usr/local/libexec/hack-dns-recovery";
const MAC_DNS_RECOVERY_HELPER_TEMP_FILENAME = "hack-dns-recovery";
const ROOT_UID = 0;
const WHEEL_GID = 0;

const globalLogsOptions = [optFollow, optNoFollow, optTail, optPretty] as const;
const globalLogsPositionals = [{ name: "service", required: false }] as const;

type GlobalLogsArgs = CommandArgs<
  typeof globalLogsOptions,
  typeof globalLogsPositionals
>;

const globalCaPositionals = [] as const;
const globalCaOptions = [
  defineOption({
    name: "print",
    type: "boolean",
    long: "--print",
    description:
      "Print the CA cert PEM to stdout (instead of printing its path)",
  } as const),
] as const;

type GlobalCaArgs = CommandArgs<
  typeof globalCaOptions,
  typeof globalCaPositionals
>;

const globalCertPositionals = [
  { name: "hosts", required: true, multiple: true },
] as const;
const globalCertOptions = [
  defineOption({
    name: "install",
    type: "boolean",
    long: "--install",
    description: "Run mkcert -install before generating certs",
  } as const),
  defineOption({
    name: "out",
    type: "string",
    long: "--out",
    valueHint: "<dir>",
    description: "Directory for generated cert/key (default: ~/.hack/certs)",
  } as const),
] as const;

type GlobalCertArgs = CommandArgs<
  typeof globalCertOptions,
  typeof globalCertPositionals
>;

const globalSpec = defineCommand({
  name: "global",
  summary: "Manage machine-wide infra (DNS/TLS, Caddy proxy, logs)",
  group: "Global",
  expandInRootHelp: true,
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const optAdminPlan = defineOption({
  name: "plan",
  type: "boolean",
  long: "--plan",
  description:
    "Print the steps (root and user) and exact root argv this command would run, without running anything (needs --json)",
} as const);

const optInstallBrewDeps = defineOption({
  name: "installBrewDeps",
  type: "boolean",
  long: "--install-brew-deps",
  description: "Allow installation of missing macOS Homebrew dependencies",
} as const);

const globalInstallSpec = defineCommand({
  name: "install",
  summary:
    "Bootstrap ~/.hack and start Caddy and CoreDNS (Grafana/Loki/Alloy only when logging is on)",
  group: "Global",
  options: [optJson, optAdminPlan, optInstallBrewDeps] as const,
  positionals: [],
  subcommands: [],
} as const);

const globalDnsPreviewSpec = defineCommand({
  name: "preview",
  summary:
    "Preview a scoped native custom-domain DNS claim or the hack.local relay repair without changing the host",
  group: "Global",
  options: [
    optJson,
    defineOption({
      name: "domain",
      type: "string",
      long: "--domain",
      valueHint: "v5.hack.gy",
      description:
        "Suffix to inspect: a custom suffix, or hack.local for the native relay repair (default: a custom global default_domain)",
    } as const),
  ] as const,
  positionals: [],
  subcommands: [],
} as const);

const globalDnsActivateSpec = defineCommand({
  name: "activate",
  summary: "Activate only the selected native custom-domain DNS suffix",
  group: "Global",
  options: [
    defineOption({
      name: "domain",
      type: "string",
      long: "--domain",
      valueHint: "v5.hack.gy",
      description:
        "Custom suffix to activate (default: a custom global default_domain)",
    } as const),
  ] as const,
  positionals: [],
  subcommands: [],
} as const);

const globalDnsDeactivateSpec = defineCommand({
  name: "deactivate",
  summary:
    "Remove an owned native custom-domain DNS suffix, or undo the hack.local relay repair",
  group: "Global",
  options: [
    defineOption({
      name: "domain",
      type: "string",
      long: "--domain",
      valueHint: "v5.hack.gy",
      description:
        "Custom suffix to deactivate, or hack.local to undo the native relay repair (default: a custom global default_domain)",
    } as const),
  ] as const,
  positionals: [],
  subcommands: [],
} as const);

const globalDnsSpec = defineCommand({
  name: "dns",
  summary: "Manage scoped native custom-domain DNS",
  group: "Global",
  options: [],
  positionals: [],
  subcommands: [
    withHandler(globalDnsPreviewSpec, handleGlobalDnsPreview),
    withHandler(globalDnsActivateSpec, handleGlobalDnsActivate),
    withHandler(globalDnsDeactivateSpec, handleGlobalDnsDeactivate),
  ],
} as const);

const globalUpOptions = [
  defineOption({
    name: "logging",
    type: "boolean",
    long: "--logging",
    description:
      "Turn the logging stack (Loki, Alloy, Grafana) on, save logging.enabled=true and start it",
  } as const),
  defineOption({
    name: "noLogging",
    type: "boolean",
    long: "--no-logging",
    description:
      "Turn the logging stack off, save logging.enabled=false and stop it; its logs are kept",
  } as const),
  optJson,
] as const;

const globalUpSpec = defineCommand({
  name: "up",
  summary: "Start global infra containers",
  group: "Global",
  options: globalUpOptions,
  positionals: [],
  subcommands: [],
} as const);

const globalDownSpec = defineCommand({
  name: "down",
  summary: "Stop global infra containers",
  group: "Global",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const globalStatusOptions = [
  optJson,
  defineOption({
    name: "observe",
    type: "boolean",
    long: "--observe",
    description:
      "Read only: never start Docker, a container or hackd; unknown parts say unknown (needs --json)",
  } as const),
] as const;

const globalStatusSpec = defineCommand({
  name: "status",
  summary: "Show status for global infra (containers + networks)",
  group: "Global",
  options: globalStatusOptions,
  positionals: [],
  subcommands: [],
} as const);

const globalLogsSpec = defineCommand({
  name: "logs",
  summary: "Tail global infra logs (caddy|grafana|loki|alloy)",
  group: "Global",
  options: globalLogsOptions,
  positionals: globalLogsPositionals,
  subcommands: [],
} as const);

const globalCaSpec = defineCommand({
  name: "ca",
  summary: "Export Caddy Local CA cert (print path or PEM)",
  group: "Global",
  options: globalCaOptions,
  positionals: globalCaPositionals,
  subcommands: [],
} as const);

const globalCertSpec = defineCommand({
  name: "cert",
  summary: "Generate local TLS certs via mkcert (for non-Caddy services)",
  description:
    "Uses mkcert to generate a cert/key pair under ~/.hack/certs (or --out).",
  group: "Global",
  options: globalCertOptions,
  positionals: globalCertPositionals,
  subcommands: [],
} as const);

type GlobalStatusArgs = CommandArgs<
  typeof globalStatusSpec.options,
  readonly []
>;

const globalTrustSpec = defineCommand({
  name: "trust",
  summary:
    "Trust Caddy Local CA (macOS keychain; Linux trust store and NSS) so https://*.hack is trusted",
  group: "Global",
  options: [optJson, optAdminPlan] as const,
  positionals: [],
  subcommands: [],
} as const);

const globalLogsResetSpec = defineCommand({
  name: "logs-reset",
  summary:
    "Wipe Loki, Grafana and Alloy volumes (fresh logs, dashboards and Alloy read positions)",
  group: "Global",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const globalAuthorizeSpec = defineCommand({
  name: "authorize",
  summary: "Authorize passwordless DNS recovery commands on macOS",
  group: "Global",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

export const globalCommand = defineCommand({
  ...globalSpec,
  subcommands: [
    withHandler(globalInstallSpec, async ({ args }) => {
      if (args.options.json === true && args.options.plan !== true) {
        emitCliResult({
          result: errorResult({
            code: "E_USAGE",
            message:
              "Use --json with --plan: hack global install --plan --json",
          }),
        });
        return 2;
      }
      if (args.options.plan === true) {
        return await printAdminPlan({
          json: args.options.json === true,
          build: buildGlobalInstallPlan,
        });
      }
      return await globalInstall(args.options.installBrewDeps === true);
    }),
    globalDnsSpec,
    withHandler(globalUpSpec, async ({ args }) => {
      const choice = resolveLoggingFlag(args.options);
      if (choice === "conflict") {
        if (args.options.json === true) {
          throw new CliUsageError(
            "Use either --logging or --no-logging, not both."
          );
        }
        logger.error({
          message: "Use either --logging or --no-logging, not both.",
        });
        return 1;
      }
      return await globalUpCommand({
        choice,
        json: args.options.json === true,
      });
    }),
    withHandler(globalDownSpec, async () => await globalDown()),
    withHandler(globalStatusSpec, handleGlobalStatus),
    withHandler(globalLogsSpec, handleGlobalLogs),
    withHandler(globalCaSpec, handleGlobalCa),
    withHandler(globalCertSpec, handleGlobalCert),
    withHandler(globalTrustSpec, async ({ args }) => {
      if (args.options.json === true && args.options.plan !== true) {
        emitCliResult({
          result: errorResult({
            code: "E_USAGE",
            message: "Use --json with --plan: hack global trust --plan --json",
          }),
        });
        return 2;
      }
      if (args.options.plan === true) {
        return await printAdminPlan({
          json: args.options.json === true,
          build: async () => await planGlobalTrust(trustPlanDeps()),
        });
      }
      return await globalTrust();
    }),
    withHandler(globalLogsResetSpec, async () => await globalLogsReset()),
    withHandler(globalAuthorizeSpec, async () => await globalAuthorize()),
  ],
} as const);

async function selectGlobalDnsDomain(opts: {
  readonly verb: "preview" | "activate" | "deactivate";
  readonly option: string | undefined;
}) {
  const explicit =
    opts.option === undefined ? undefined : parseDefaultDomain(opts.option);
  return selectNativeDnsCommandDomain({
    verb: opts.verb,
    explicit,
    configuredDefault: explicit ?? (await resolveDefaultDomain()),
  });
}

async function handleGlobalDnsPreview({
  args,
}: Parameters<
  CommandHandlerFor<typeof globalDnsPreviewSpec>
>[0]): Promise<number> {
  const selected = await selectGlobalDnsDomain({
    verb: "preview",
    option: args.options.domain,
  });
  const runtime = resolveNativeRuntimeSelection();
  if (!(runtime && isMac())) {
    logger.error({
      message:
        "Native DNS preview requires an explicitly selected macOS native candidate.",
    });
    return 1;
  }
  if (selected.kind === "hack-local") {
    const report = reportHackLocalRoute(
      await inspectHackLocalRoute(
        await createNativeHackLocalRouteDependencies({ runtime })
      )
    );
    if (args.options.json) {
      console.log(JSON.stringify({ ok: true, data: report }));
    } else {
      logger.info({ message: describeHackLocalRoute(report) });
    }
    return 0;
  }
  const { domain } = selected;
  const inspected = await inspectNativeDnsPlan({
    runtime,
    domain,
  });
  const { receiptPath, includeDir } = inspected;
  const { plan } = inspected.inspection;
  const output = {
    domain: plan.domain,
    status: plan.status,
    dnsmasqPath: plan.dnsmasqPath,
    resolverPath: plan.resolverPath,
    receiptPath,
    address: DEFAULT_HOST_DNS_IP,
    includeDir,
    includeLoadedBy: plan.includeArgument,
    activation: plan.activation,
  };
  if (args.options.json) {
    console.log(JSON.stringify({ ok: true, data: output }));
  } else {
    logger.info({
      message: describeNativeDnsPreview({ plan, receiptPath }).join("\n"),
    });
  }
  return 0;
}

async function handleGlobalDnsActivate({
  args,
}: Parameters<
  CommandHandlerFor<typeof globalDnsActivateSpec>
>[0]): Promise<number> {
  const selected = await selectGlobalDnsDomain({
    verb: "activate",
    option: args.options.domain,
  });
  const runtime = resolveNativeRuntimeSelection();
  if (!(runtime && isMac())) {
    logger.error({
      message:
        "Native DNS activation requires an explicitly selected macOS native candidate.",
    });
    return 1;
  }
  if (selected.kind !== "custom") {
    logger.error({
      message: "hack.local is repaired with hack doctor --fix, not activated.",
    });
    return 1;
  }
  const { domain } = selected;
  const initial = await inspectNativeDnsPlan({ runtime, domain });
  if (
    initial.inspection.plan.status === "available" &&
    !isInteractiveTerminal()
  ) {
    logger.error({
      message:
        "Native DNS activation requires interactive confirmation and a macOS administrator prompt.",
    });
    return 1;
  }
  const restartDnsmasq = await prepareNativeDnsLaunchdRestart({
    dnsmasqBinary: initial.dnsmasqBinary,
    mainConfigPath: initial.mainConfigPath,
    includeDir: initial.includeDir,
    inspectedArgs: initial.dnsmasqArgs,
  });
  const inspectPlan = async () => {
    const current = await inspectNativeDnsPlan({ runtime, domain });
    if (
      current.inspection.fingerprint !== initial.inspection.fingerprint ||
      current.receiptPath !== initial.receiptPath ||
      current.dnsmasqBinary !== initial.dnsmasqBinary ||
      current.mainConfigPath !== initial.mainConfigPath ||
      current.includeDir !== initial.includeDir
    ) {
      throw new Error("Native DNS inputs changed before activation");
    }
    return current.inspection;
  };
  const authorize = createNativeDnsAuthorizer({ action: "activate", domain });
  const deps = createNativeDnsHostDependencies({
    receiptPath: initial.receiptPath,
    dnsmasqPath: initial.inspection.plan.dnsmasqPath,
    resolverPath: initial.inspection.plan.resolverPath,
    dnsmasqBinary: initial.dnsmasqBinary,
    dnsmasqMainConfigPath: initial.mainConfigPath,
    dnsmasqIncludeDir: initial.includeDir,
    inspectPlan,
    authorize,
    restartDnsmasq,
    flushDnsCache: flushMacDnsCachePrivileged,
  });
  if (initial.inspection.plan.status === "active") {
    await deps.verifyLiveDns(initial.inspection.plan);
    logger.success({
      message: `Native DNS for *.${domain} is active and verified.`,
    });
    return 0;
  }
  if (initial.receipt?.state === "inactive") {
    await deps.adoptReceipt(initial.inspection.plan.inactiveReceipt);
  }
  await activateNativeDomainDns({ dependencies: deps });
  logger.success({
    message: `Native DNS for *.${domain} is active. Check the exact app origin with hack doctor --browser-url.`,
  });
  return 0;
}

async function handleGlobalDnsDeactivate({
  args,
}: Parameters<
  CommandHandlerFor<typeof globalDnsDeactivateSpec>
>[0]): Promise<number> {
  const selected = await selectGlobalDnsDomain({
    verb: "deactivate",
    option: args.options.domain,
  });
  const runtime = resolveNativeRuntimeSelection();
  if (!(runtime && isMac())) {
    logger.error({
      message:
        "Native DNS deactivation requires an explicitly selected macOS native candidate.",
    });
    return 1;
  }
  if (selected.kind === "hack-local") {
    const result = await rollbackHackLocalRoute(
      await createNativeHackLocalRouteDependencies({ runtime })
    );
    const message = describeHackLocalRollback(result);
    if (result.outcome === "refused") {
      logger.error({ message });
      return 1;
    }
    logger.success({ message });
    return 0;
  }
  const { domain } = selected;
  const initial = await inspectNativeDnsPlan({ runtime, domain });
  if (initial.inspection.plan.status === "available") {
    if (initial.receipt?.state === "inactive") {
      const deps = createNativeDnsHostDependencies({
        receiptPath: initial.receiptPath,
        dnsmasqPath: initial.inspection.plan.dnsmasqPath,
        resolverPath: initial.inspection.plan.resolverPath,
        dnsmasqBinary: initial.dnsmasqBinary,
        dnsmasqMainConfigPath: initial.mainConfigPath,
        dnsmasqIncludeDir: initial.includeDir,
        inspectPlan: async () => initial.inspection,
        authorize: async () => false,
        restartDnsmasq: restartMacDnsmasq,
        flushDnsCache: flushMacDnsCachePrivileged,
      });
      await deps.verifyDeactivatedDns(initial.inspection.plan);
    }
    logger.success({ message: `No active native DNS claim for *.${domain}.` });
    return 0;
  }
  if (!isInteractiveTerminal()) {
    logger.error({
      message:
        "Native DNS deactivation requires interactive confirmation and a macOS administrator prompt.",
    });
    return 1;
  }
  const restartDnsmasq = await prepareNativeDnsLaunchdRestart({
    dnsmasqBinary: initial.dnsmasqBinary,
    mainConfigPath: initial.mainConfigPath,
    includeDir: initial.includeDir,
    inspectedArgs: initial.dnsmasqArgs,
  });
  const inspectPlan = async () => {
    const current = await inspectNativeDnsPlan({ runtime, domain });
    if (
      current.inspection.fingerprint !== initial.inspection.fingerprint ||
      current.receiptPath !== initial.receiptPath ||
      current.dnsmasqBinary !== initial.dnsmasqBinary ||
      current.mainConfigPath !== initial.mainConfigPath ||
      current.includeDir !== initial.includeDir
    ) {
      throw new Error("Native DNS inputs changed before deactivation");
    }
    return current.inspection;
  };
  const authorize = createNativeDnsAuthorizer({
    action: "deactivate",
    domain,
  });
  const deps = createNativeDnsHostDependencies({
    receiptPath: initial.receiptPath,
    dnsmasqPath: initial.inspection.plan.dnsmasqPath,
    resolverPath: initial.inspection.plan.resolverPath,
    dnsmasqBinary: initial.dnsmasqBinary,
    dnsmasqMainConfigPath: initial.mainConfigPath,
    dnsmasqIncludeDir: initial.includeDir,
    inspectPlan,
    authorize,
    restartDnsmasq,
    flushDnsCache: flushMacDnsCachePrivileged,
  });
  await deactivateNativeDomainDns({
    dependencies: deps,
    receiptPath: initial.receiptPath,
  });
  logger.success({
    message: `Owned native DNS claim for *.${domain} was removed; fallback resolution verified.`,
  });
  return 0;
}

async function inspectNativeDnsPlan(opts: {
  readonly runtime: NativeRuntimeSelection;
  readonly domain: string;
}): Promise<{
  readonly inspection: NativeDnsActivationInspection;
  readonly receiptPath: string;
  readonly dnsmasqBinary: string;
  readonly dnsmasqArgs: readonly string[];
  readonly mainConfigPath: string;
  readonly includeDir: string;
  readonly receipt: NativeDnsReceipt | null;
}> {
  const prefix = await resolveBrewPrefix();
  const host = await inspectNativeDnsHost({ brewPrefix: prefix });
  const receiptPath = join(
    opts.runtime.home,
    "native-dns",
    `${opts.domain}.json`
  );
  const receiptText = await readStableNativeDnsFile(receiptPath);
  let receipt: NativeDnsReceipt | null = null;
  if (receiptText !== null) {
    try {
      receipt = JSON.parse(receiptText) as NativeDnsReceipt;
    } catch {
      throw new Error(
        "Private native DNS receipt is invalid; refusing to infer ownership"
      );
    }
  }
  const plan = planNativeDomainDns({
    domain: opts.domain,
    ...host,
    receipt,
    ...(opts.domain.endsWith(".hack.gy")
      ? { builtInParentClaim: "hack.gy" as const }
      : {}),
  });
  return {
    inspection: {
      plan,
      fingerprint: createHash("sha256")
        .update(JSON.stringify({ host, receiptText }), "utf8")
        .digest("hex"),
    },
    receiptPath,
    dnsmasqBinary: host.dnsmasqArgs[0] ?? "",
    dnsmasqArgs: host.dnsmasqArgs,
    mainConfigPath: host.mainConfig.path,
    includeDir: host.includeDir,
    receipt,
  };
}

function getGlobalPaths() {
  const root = resolveGlobalHackDir();
  const caddyDir = resolve(root, GLOBAL_CADDY_DIR_NAME);
  const loggingDir = resolve(root, GLOBAL_LOGGING_DIR_NAME);
  const schemasDir = resolve(root, GLOBAL_SCHEMAS_DIR_NAME);
  const certsDir = resolve(root, GLOBAL_CERTS_DIR_NAME);
  return {
    root,
    caddyDir,
    loggingDir,
    schemasDir,
    certsDir,
    caddyCompose: resolve(caddyDir, GLOBAL_CADDY_COMPOSE_FILENAME),
    loggingCompose: resolve(loggingDir, GLOBAL_LOGGING_COMPOSE_FILENAME),
    coreDnsConfig: resolve(caddyDir, GLOBAL_COREDNS_FILENAME),
    alloyConfig: resolve(loggingDir, GLOBAL_ALLOY_FILENAME),
    lokiConfig: resolve(loggingDir, GLOBAL_LOKI_CONFIG_FILENAME),
    grafanaDatasource: resolve(loggingDir, GLOBAL_GRAFANA_DATASOURCE_FILENAME),
    grafanaDashboardsProvisioning: resolve(
      loggingDir,
      GLOBAL_GRAFANA_DASHBOARDS_PROVISIONING_FILENAME
    ),
    grafanaDashboard: resolve(loggingDir, GLOBAL_GRAFANA_DASHBOARD_FILENAME),
    configSchema: resolve(schemasDir, GLOBAL_CONFIG_SCHEMA_FILENAME),
    envSchema: resolve(schemasDir, GLOBAL_ENV_SCHEMA_FILENAME),
    managedEnvSchema: resolve(schemasDir, GLOBAL_MANAGED_ENV_SCHEMA_FILENAME),
    branchesSchema: resolve(schemasDir, GLOBAL_BRANCHES_SCHEMA_FILENAME),
  };
}

async function ensureDockerRunning(opts?: {
  readonly login: boolean;
}): Promise<void> {
  const res = await exec(["docker", "info"], { stdin: "ignore" });
  if (res.exitCode === 0) {
    return;
  }

  assertGlobalBackendStartAllowed({ login: opts?.login === true });

  const backend = await detectDockerBackend();
  if (!backend) {
    throw new Error(
      formatDockerConnectionGuidance({
        backend,
        failureText:
          "Docker does not seem to be running and no Docker backend was detected.",
        retryCommand: "hack global install",
      })
    );
  }

  const ok = await confirmSafe({
    message: `Docker is not running. Start ${backend.name}?`,
    initialValue: true,
    nonInteractive: "accept-default",
  });
  if (!ok) {
    throw new Error("Docker is not running (user declined to start)");
  }

  logger.step({ message: `Starting ${backend.name}…` });
  await run(backend.startCommand, { stdin: "ignore" });

  const ready = await waitForDocker({ timeoutMs: 30_000, intervalMs: 1000 });
  if (!ready) {
    throw new Error(
      `Docker did not become ready after starting ${backend.name}. Check that ${backend.name} is running and retry.`
    );
  }

  logger.success({ message: `${backend.name} is running` });
}
async function waitForDocker(opts: {
  readonly timeoutMs: number;
  readonly intervalMs: number;
}): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const check = await exec(["docker", "info"], { stdin: "ignore" });
    if (check.exitCode === 0) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
  }
  return false;
}

function muxInstallCommand(opts: { readonly provider: "tmux" }): string {
  if (isMac()) {
    return `brew install ${opts.provider}`;
  }
  return `install ${opts.provider} with your package manager`;
}

function failIfSlimMode(opts: {
  readonly feature: string;
  readonly alternative?: string;
}): number | null {
  if (!isSlimExecutionMode()) {
    return null;
  }

  process.stderr.write(
    `${renderSlimModeUnavailableMessage({
      feature: opts.feature,
      alternative: opts.alternative,
    })}\n`
  );
  return 1;
}

async function warnIfSessionsMuxUnavailable(): Promise<void> {
  const mode = await resolveSessionsMuxMode({ project: null });
  const tmuxPath = findExecutableInPath("tmux");

  if (mode === "none") {
    return;
  }

  if (mode === "tmux" && !tmuxPath) {
    logger.warn({
      message: [
        "sessions.mux is set to tmux but tmux is not on PATH.",
        `Install hint: ${muxInstallCommand({ provider: "tmux" })}`,
      ].join("\n"),
    });
    return;
  }

  if (mode === "auto" && !tmuxPath) {
    logger.warn({
      message: [
        "sessions.mux is auto, but tmux is unavailable on PATH.",
        `Install hint: ${muxInstallCommand({ provider: "tmux" })}`,
      ].join("\n"),
    });
  }
}

async function ensureNetwork(
  name: string,
  opts?: { readonly subnet?: string; readonly gateway?: string }
): Promise<{ readonly hasSubnet: boolean }> {
  const inspect = await exec(["docker", "network", "inspect", name], {
    stdin: "ignore",
  });
  if (inspect.exitCode === 0) {
    const hasSubnet = opts?.subnet
      ? networkHasSubnet(inspect.stdout, opts.subnet)
      : true;
    return { hasSubnet };
  }

  const cmd = ["docker", "network", "create", name];
  if (opts?.subnet) {
    cmd.push("--subnet", opts.subnet);
  }
  if (opts?.gateway) {
    cmd.push("--gateway", opts.gateway);
  }
  await execOrThrow(cmd, { stdin: "ignore" });
  return { hasSubnet: Boolean(opts?.subnet) };
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

async function globalInstall(installBrewDeps: boolean): Promise<number> {
  if (resolveNativeRuntimeSelection()) {
    logger.error({
      message:
        "Native global DNS/TLS installation needs a scoped host-domain plan; hack global install would start the Docker stack and may change v4 routing. Use hack doctor --browser-url https://your-app.hack.local to verify the current native route.",
    });
    return 1;
  }
  const slimExit = failIfSlimMode({
    feature: "hack global install",
    alternative:
      "Use `bash scripts/install-codex-slim.sh` for managed Codex or CI environments.",
  });
  if (slimExit !== null) {
    return slimExit;
  }

  await requireGlobalBrewInstallConsent(installBrewDeps);
  await preflightCustomDomainDnsClaim();

  const s = spinner();
  await ensureOptionalInstallDependencies({ spinner: s, installBrewDeps });
  await warnIfSessionsMuxUnavailable();
  const useStaticIps = await ensureGlobalDockerNetworks({ spinner: s });
  const paths = getGlobalPaths();
  const logging = await settleGlobalLoggingSetting({ paths });
  await materializeGlobalInstallFiles({
    paths,
    useStaticIps,
    logging: logging.enabled,
  });
  logger.success({ message: "Global files ready in ~/.hack/" });
  const up = await runGlobalUp();
  if (up.error) {
    logger.error({ message: `${up.error.code}: ${up.error.message}` });
  }
  if (up.failedStage === "routing") {
    // Host DNS and trust steps would point at a proxy that is not running;
    // stop before them and before the success next steps (HACK-2328).
    logger.error({
      message:
        "Global install did not finish: the global proxy (Caddy and CoreDNS) did not start. Fix the problem above, then rerun: hack global install",
    });
    return up.exit;
  }
  const hostBootstrapOk = await completeGlobalInstallHostBootstrap({
    useStaticIps,
    installBrewDeps,
  });
  if (up.failedStage === "logging") {
    // Routing works, so DNS and trust were set up; the logs URL would not.
    logger.error({
      message:
        "Global install did not finish: the proxy is up, but the logging stack (Grafana, Loki, Alloy) did not start. Fix the problem above, then rerun: hack global install",
    });
    return up.exit;
  }
  note(
    [
      "Next:",
      logging.enabled
        ? `- Open https://${DEFAULT_GRAFANA_HOST}`
        : `- Logs: hack logs (for Loki and Grafana: ${LOGGING_ENABLE_COMMAND})`,
      "- Start a repo with: hack init && hack up",
    ].join("\n"),
    "Global install"
  );

  return hostBootstrapOk ? 0 : 1;
}

async function ensureOptionalInstallDependencies(opts: {
  readonly installBrewDeps: boolean;
  readonly spinner: ReturnType<typeof spinner>;
}): Promise<void> {
  await ensureManagedGum({ spinner: opts.spinner });
  await ensureManagedMutagen({ spinner: opts.spinner });
  await ensureMacInstallDependencies(opts.installBrewDeps);
}

async function ensureManagedGum(opts: {
  readonly spinner: ReturnType<typeof spinner>;
}): Promise<void> {
  opts.spinner.start("Ensuring gum…");
  const gum = await ensureBundledGumInstalled();
  if (gum.ok) {
    opts.spinner.stop(
      gum.installed ? "Installed bundled gum" : "gum already installed"
    );
    return;
  }

  const systemGum = Bun.which("gum");
  opts.spinner.stop(
    systemGum ? "gum available on PATH" : "gum not installed (optional)"
  );
  if (gum.reason === "failed") {
    logger.warn({
      message: `gum install failed: ${gum.message ?? "unknown error"}`,
    });
  }
}

async function ensureManagedMutagen(opts: {
  readonly spinner: ReturnType<typeof spinner>;
}): Promise<void> {
  opts.spinner.start("Ensuring mutagen…");
  const mutagen = await ensureBundledMutagenInstalled();
  if (mutagen.ok) {
    opts.spinner.stop(
      mutagen.installed
        ? "Installed managed mutagen"
        : "mutagen already installed"
    );
    return;
  }

  const systemMutagen = getMutagenPath();
  opts.spinner.stop(
    systemMutagen ? "mutagen available on PATH" : "mutagen not installed"
  );
  if (!systemMutagen) {
    const detail = mutagen.message ? `: ${mutagen.message}` : "";
    logger.warn({
      message: `mutagen install skipped (${mutagen.reason}${detail})`,
    });
    logger.warn({
      message:
        "Remote sync may fail without mutagen. Repair with: hack doctor --fix",
    });
  }
}

function brewInstallConsentError(): HackCliError {
  return new HackCliError({
    code: "E_INTERACTIVE_REQUIRED",
    message: "Homebrew install requires consent. Run: brew install dnsmasq",
  });
}

async function needsMacHostDns(domains: readonly string[]): Promise<boolean> {
  const existing = await Promise.all(
    domains.map((domain) => pathExists(`/etc/resolver/${domain}`))
  );
  return existing.includes(false);
}

async function requireGlobalBrewInstallConsent(
  allowed: boolean
): Promise<void> {
  if (allowed || !isMac() || canPrompt() || !(await resolveBrewPath())) {
    return;
  }
  if (
    !(await isBrewFormulaInstalled({ formula: "dnsmasq" })) &&
    (await needsMacHostDns(managedLocalDomains(await resolveDefaultDomain())))
  ) {
    throw brewInstallConsentError();
  }
}

async function confirmGlobalBrewInstall(opts: {
  readonly allowed?: boolean;
  readonly message: string;
  readonly initialValue: boolean;
}): Promise<boolean> {
  return (
    opts.allowed === true ||
    (await confirmSafe({
      ...opts,
      nonInteractive: "decline",
    }))
  );
}

async function ensureMacInstallDependencies(
  installBrewDeps: boolean
): Promise<void> {
  if (isMac()) {
    await ensureMacChafa(installBrewDeps);
    await ensureMacMkcert(installBrewDeps);
    return;
  }

  logger.warn({
    message: "Skipping chafa install (only automated on macOS for now).",
  });
}

async function ensureGlobalDockerNetworks(opts: {
  readonly spinner: ReturnType<typeof spinner>;
}): Promise<boolean> {
  opts.spinner.start("Checking Docker…");
  await ensureDockerRunning();
  opts.spinner.stop("Docker is running");

  opts.spinner.start("Ensuring shared networks…");
  const ingressNetwork = await ensureNetwork(DEFAULT_INGRESS_NETWORK, {
    subnet: DEFAULT_INGRESS_SUBNET,
    gateway: DEFAULT_INGRESS_GATEWAY,
  });
  await ensureNetwork(DEFAULT_LOGGING_NETWORK);
  opts.spinner.stop(
    `Networks ready (${DEFAULT_INGRESS_NETWORK}, ${DEFAULT_LOGGING_NETWORK})`
  );

  if (!ingressNetwork.hasSubnet) {
    logger.warn({
      message:
        "hack-dev network has no subnet; CoreDNS will resolve via dynamic IP.",
    });
  }
  return ingressNetwork.hasSubnet;
}

async function materializeGlobalInstallFiles(opts: {
  readonly paths: ReturnType<typeof getGlobalPaths>;
  readonly useStaticIps: boolean;
  readonly logging: boolean;
}): Promise<void> {
  await ensureGlobalInstallDirectories({
    paths: opts.paths,
    logging: opts.logging,
  });
  const templates = await writeGlobalInstallAssets({
    paths: opts.paths,
    useStaticIps: opts.useStaticIps,
    logging: opts.logging,
    startInterval: await dockerEngineSupportsStartInterval(),
  });
  await ensureGlobalConfigsReadable({
    paths: opts.paths,
    templates,
    logging: opts.logging,
  });
}

/**
 * Writes the logging stack's files into a home that has the rest, for
 * `hack global up` after logging was turned on.
 */
async function materializeGlobalLoggingFiles(opts: {
  readonly paths: ReturnType<typeof getGlobalPaths>;
}): Promise<void> {
  await ensureGlobalLoggingDirectories({ paths: opts.paths });
  const templates = renderContainerConfigTemplates({
    coreDnsConfig: (await readTextFile(opts.paths.coreDnsConfig)) ?? "",
  });
  await writeGlobalLoggingAssets({
    paths: opts.paths,
    templates,
    startInterval: await dockerEngineSupportsStartInterval(),
  });
  await ensureGlobalConfigsReadable({
    paths: opts.paths,
    templates,
    logging: true,
    onlyLogging: true,
  });
}

/** The rendered logging configs; CoreDNS's comes from the caller. */
function renderContainerConfigTemplates(opts: {
  readonly coreDnsConfig: string;
}): ContainerConfigTemplates {
  return {
    coreDnsConfig: opts.coreDnsConfig,
    lokiConfig: renderGlobalLokiConfigYaml(),
    grafanaDatasource: renderGlobalGrafanaDatasourceYaml(),
    grafanaDashboardsProvisioning:
      renderGlobalGrafanaDashboardsProvisioningYaml(),
    grafanaDashboard: renderGlobalGrafanaLogsDashboardJson(),
  };
}

async function ensureGlobalConfigsReadable(opts: {
  readonly paths: ReturnType<typeof getGlobalPaths>;
  readonly templates: ContainerConfigTemplates;
  readonly logging: boolean;
  /** Only the logging stack's configs (CoreDNS's was handled by install). */
  readonly onlyLogging?: boolean;
}): Promise<void> {
  const { templates } = opts;
  // After the writes, and on every install whether or not a file changed:
  // the configs that non-root containers read must not depend on the umask
  // this run, or an earlier one, happened to have (HACK-2381). Only content
  // that is Hack's own template is widened; a file the user customised and
  // kept is left exactly as it is.
  const { retained } = await ensureContainerReadable(
    containerReadableGlobalPaths({
      coreDnsConfig: {
        path: opts.paths.coreDnsConfig,
        template: templates.coreDnsConfig,
      },
      lokiConfig: {
        path: opts.paths.lokiConfig,
        template: templates.lokiConfig,
      },
      grafanaDatasource: {
        path: opts.paths.grafanaDatasource,
        template: templates.grafanaDatasource,
      },
      grafanaDashboardsProvisioning: {
        path: opts.paths.grafanaDashboardsProvisioning,
        template: templates.grafanaDashboardsProvisioning,
      },
      grafanaDashboardsDir: dirname(opts.paths.grafanaDashboard),
      grafanaDashboard: {
        path: opts.paths.grafanaDashboard,
        template: templates.grafanaDashboard,
      },
    }).filter((entry) => {
      const isLogging = entry.path.startsWith(`${opts.paths.loggingDir}/`);
      return opts.onlyLogging === true ? isLogging : opts.logging || !isLogging;
    })
  );
  if (retained.length > 0) {
    logger.warn({
      message: [
        "Kept the permissions of global configs whose content differs from what this Hack writes.",
        describeUnreadableContainerPaths(retained),
      ].join("\n"),
    });
  }
}

async function ensureGlobalInstallDirectories(opts: {
  readonly paths: ReturnType<typeof getGlobalPaths>;
  readonly logging: boolean;
}): Promise<void> {
  await ensureDir(opts.paths.caddyDir);
  await ensureDir(opts.paths.schemasDir);
  if (opts.logging) {
    await ensureGlobalLoggingDirectories({ paths: opts.paths });
  }
}

async function ensureGlobalLoggingDirectories(opts: {
  readonly paths: ReturnType<typeof getGlobalPaths>;
}): Promise<void> {
  await ensureDir(opts.paths.loggingDir);
  await ensureDir(dirname(opts.paths.grafanaDatasource));
  await ensureDir(dirname(opts.paths.grafanaDashboardsProvisioning));
  await ensureDir(dirname(opts.paths.grafanaDashboard));
  await ensureDir(dirname(opts.paths.alloyConfig));
  await ensureDir(dirname(opts.paths.lokiConfig));
}

/** The rendered content of the configs non-root containers read. */
type ContainerConfigTemplates = {
  readonly coreDnsConfig: string;
  readonly lokiConfig: string;
  readonly grafanaDatasource: string;
  readonly grafanaDashboardsProvisioning: string;
  readonly grafanaDashboard: string;
};

async function writeGlobalInstallAssets(opts: {
  readonly paths: ReturnType<typeof getGlobalPaths>;
  readonly useStaticIps: boolean;
  /** Write the logging stack's files too; off leaves them absent. */
  readonly logging: boolean;
  /** The engine accepts healthcheck `start_interval` (Docker Engine 25+). */
  readonly startInterval: boolean;
}): Promise<ContainerConfigTemplates> {
  const defaultDomain = await resolveDefaultDomain();
  const bind = await resolveManagedProxyBind({ path: opts.paths.caddyCompose });
  if (bind.saveError !== undefined) {
    logger.warn({
      message: `Kept the proxy on ${bind.bindAddress} from the existing proxy file, but could not save it as proxy.bind_address: ${bind.saveError}. Fix the global config, then run: hack config set --global proxy.bind_address ${bind.bindAddress}`,
    });
  }
  if (bind.migrated !== null) {
    logger.info({
      message: `Kept the proxy on ${bind.migrated} from the existing proxy file and saved it as proxy.bind_address. To publish on every IPv4 interface: hack config set --global proxy.bind_address 0.0.0.0`,
    });
  }
  if (bind.keep !== undefined) {
    logger.warn({ message: `Proxy file not updated: ${bind.keep}` });
  } else {
    await writeGlobalManagedCompose({
      path: opts.paths.caddyCompose,
      content: renderGlobalCaddyCompose({
        useStaticCoreDnsIp: opts.useStaticIps,
        useStaticCaddyIp: opts.useStaticIps,
        bindAddress: bind.bindAddress,
        startInterval: opts.startInterval,
      }),
    });
  }
  const templates = renderContainerConfigTemplates({
    coreDnsConfig: renderGlobalCoreDnsConfig({
      useStaticCaddyIp: opts.useStaticIps,
      defaultDomain,
    }),
  });
  await writeWithPromptIfDifferent(
    opts.paths.coreDnsConfig,
    templates.coreDnsConfig
  );
  if (opts.logging) {
    await writeGlobalLoggingAssets({
      paths: opts.paths,
      templates,
      startInterval: opts.startInterval,
    });
  }
  await writeWithPromptIfDifferent(
    opts.paths.configSchema,
    renderProjectConfigSchemaJson()
  );
  await writeWithPromptIfDifferent(
    opts.paths.envSchema,
    renderProjectEnvSchemaJson()
  );
  await writeWithPromptIfDifferent(
    opts.paths.managedEnvSchema,
    renderProjectManagedEnvSchemaJson()
  );
  await writeWithPromptIfDifferent(
    opts.paths.branchesSchema,
    renderProjectBranchesSchemaJson()
  );
  return templates;
}

/**
 * The logging stack's files, written only when logging is on. Its compose
 * file is replaced without a prompt only while it is one of Hack's own
 * renderings (an engine upgrade changes its healthchecks). Any other file
 * (edited by hand, or written by an older Hack) is replaced only after a
 * confirmation that defaults to no, with a backup first: that file decides
 * whether the unauthenticated Loki and Grafana are routed through the proxy,
 * so a hardened copy is never undone, and started, unasked. The configs
 * beside it (Loki, Alloy, Grafana) also ask before an overwrite.
 */
async function writeGlobalLoggingAssets(opts: {
  readonly paths: ReturnType<typeof getGlobalPaths>;
  readonly templates: ContainerConfigTemplates;
  readonly startInterval: boolean;
}): Promise<void> {
  const { paths, templates } = opts;
  await writeLoggingCompose({
    path: paths.loggingCompose,
    content: renderGlobalLoggingCompose({ startInterval: opts.startInterval }),
  });
  await writeWithPromptIfDifferent(
    paths.alloyConfig,
    renderGlobalAlloyConfig()
  );
  await writeWithPromptIfDifferent(paths.lokiConfig, templates.lokiConfig);
  await writeWithPromptIfDifferent(
    paths.grafanaDatasource,
    templates.grafanaDatasource
  );
  await writeWithPromptIfDifferent(
    paths.grafanaDashboardsProvisioning,
    templates.grafanaDashboardsProvisioning
  );
  await writeWithPromptIfDifferent(
    paths.grafanaDashboard,
    templates.grafanaDashboard
  );
}

/** Returns `false` only when a confirmed host step failed (exit non-zero). */
async function completeGlobalInstallHostBootstrap(opts: {
  readonly installBrewDeps: boolean;
  readonly useStaticIps: boolean;
}): Promise<boolean> {
  if (isMac()) {
    await bootstrapMacGlobalInstall(opts.installBrewDeps);
    return true;
  }
  if (isLinux()) {
    const dns = await bootstrapLinuxGlobalDns({
      useStaticIps: opts.useStaticIps,
    });
    logger.info({ message: `Linux DNS result: ${dns}` });
    return dns !== "failed";
  }

  logger.warn({
    message: "Skipping DNS bootstrap (implemented for macOS and Linux).",
  });
  note(
    [
      `You need wildcard DNS for *.hack pointing to ${DEFAULT_HOST_DNS_IP}.`,
      "Recommended: dnsmasq + OS resolver config for the 'hack' TLD.",
    ].join("\n"),
    "DNS setup"
  );
  return true;
}

async function bootstrapMacGlobalInstall(
  installBrewDeps: boolean
): Promise<void> {
  const hostDnsTarget = await resolvePreferredMacHostDnsTarget();
  await ensureMacHackDns({ targetIp: hostDnsTarget, installBrewDeps });
  const certPath = await exportCaddyLocalCaCert();
  if (certPath) {
    const trustReady = await ensureMacTrustCaddyLocalCa({ certPath });
    // Mirror globalTrust: the host trust env (Bun/Node/curl/git) is
    // independent of the macOS System keychain step — prepare it regardless
    // so non-interactive installs still get CLI-tool trust.
    const hostTrustReady = await configureMacHostTlsTrust({ certPath });
    if (hostTrustReady && !trustReady) {
      note(
        "Host trust env is prepared, but the browser will still show warnings for https://*.hack until the System keychain step runs. Run `hack global trust` interactively to finish it.",
        "TLS"
      );
    }
  }
  await maybeOfferMacRecoverySetup();
}

/**
 * `logs-reset` with logging off and no logging files: the stack's volumes
 * can still exist (its files were deleted, or the stack ran before they
 * were). Compose labels volumes with the project only, not the home, so
 * Hack cannot tell this home's from another's on the same engine: it lists
 * them with the command to remove them, and deletes nothing. Exit 1 when
 * any remain or Docker could not be asked, since nothing was reset.
 */
async function reportLeftoverLoggingVolumes(): Promise<number> {
  const found = await exec(
    [
      "docker",
      "volume",
      "ls",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${GLOBAL_LOGGING_PROJECT_NAME}`,
    ],
    { stdin: "ignore", timeoutMs: 10_000 }
  ).catch(() => null);
  if (!found || found.exitCode !== 0) {
    logger.error({
      message: `Could not ask Docker for the logging stack's volumes${found?.stderr.trim() ? `: ${found.stderr.trim().split("\n")[0]}` : "."} Nothing was reset.`,
    });
    return 1;
  }
  const volumes = found.stdout.split(WHITESPACE).filter(Boolean);
  if (volumes.length === 0) {
    logger.info({
      message: `The logging stack (Loki, Alloy, Grafana) is off, with no files or volumes here, so there are no logs to reset. Turn it on with: ${LOGGING_ENABLE_COMMAND}`,
    });
    return 0;
  }
  logger.error({
    message: [
      `The logging stack is off and its files are gone, but Docker still has ${volumes.length} of its volume${volumes.length === 1 ? "" : "s"}: ${volumes.join(", ")}.`,
      "Hack cannot tell which Hack home made them, so it did not delete them. If they are this home's, remove them with:",
      `  docker volume rm ${volumes.join(" ")}`,
    ].join("\n"),
  });
  return 1;
}

async function globalLogsReset(): Promise<number> {
  const slimExit = failIfSlimMode({
    feature: "hack global logs-reset",
  });
  if (slimExit !== null) {
    return slimExit;
  }

  await ensureDockerRunning();
  const paths = getGlobalPaths();

  if (!(await pathExists(paths.loggingCompose))) {
    // A home that never turned the opt-in stack on has no logs to remove.
    const logging = await resolveGlobalLogging({
      loggingCompose: paths.loggingCompose,
    }).catch(() => null);
    if (logging && !logging.enabled) {
      return await reportLeftoverLoggingVolumes();
    }
    logger.error({
      message: `Missing ${paths.loggingCompose}. Run: hack global install`,
    });
    return 1;
  }

  const ok = await confirmSafe({
    message:
      "This will stop the logging stack and delete its volumes: ALL Loki logs, Grafana state and Alloy read positions.\nContinue?",
    initialValue: false,
    nonInteractive: "accept-default",
  });
  if (!ok) {
    return 0;
  }

  logger.step({ message: "Stopping logging stack and removing volumes…" });
  const code = await run(
    [
      "docker",
      "compose",
      "-f",
      paths.loggingCompose,
      "down",
      "-v",
      "--remove-orphans",
    ],
    { cwd: dirname(paths.loggingCompose) }
  );
  if (code !== 0) {
    return code;
  }

  logger.success({
    message: "Logs wiped (fresh volumes next time the stack starts)",
  });
  return 0;
}

async function globalAuthorize(): Promise<number> {
  if (!isMac()) {
    logger.warn({
      message: "DNS authorization setup is only available on macOS",
    });
    return 1;
  }

  const sudoersRuleExists = await pathExists(MAC_DNS_SUDOERS_PATH);

  const brew = await findExecutableInPath("brew");
  if (!brew) {
    logger.error({
      message: "Homebrew not found; cannot authorize dnsmasq recovery commands",
    });
    return 1;
  }

  const user = await resolveCurrentUsername();
  if (!user) {
    logger.error({ message: "Unable to determine the current macOS username" });
    return 1;
  }

  const ok = await confirmSafe({
    message:
      "Install a sudoers rule so Hack can restart dnsmasq and flush DNS cache without asking for your password during recovery?",
    initialValue: true,
    nonInteractive: "decline",
  });
  if (!ok) {
    logger.info({ message: "Skipped DNS authorization setup" });
    return 0;
  }

  if (sudoersRuleExists) {
    logger.info({
      message: `Refreshing ${MAC_DNS_SUDOERS_PATH}`,
    });
  }

  const tempDir = resolve(getGlobalPaths().root, "tmp");
  await ensureDir(tempDir);
  const tempPath = resolve(tempDir, MAC_DNS_SUDOERS_TEMP_FILENAME);
  const helperTempPath = resolve(
    tempDir,
    MAC_DNS_RECOVERY_HELPER_TEMP_FILENAME
  );
  await Bun.write(
    helperTempPath,
    renderMacDnsRecoveryHelper({
      brewPath: brew,
    })
  );
  const sudoersText = renderMacDnsSudoers({
    helperPath: MAC_DNS_RECOVERY_HELPER_PATH,
    user,
  });
  await Bun.write(tempPath, sudoersText);

  const visudo = (await findExecutableInPath("visudo")) ?? "/usr/sbin/visudo";
  const authorization = macAuthorizationArgv({
    helperPath: MAC_DNS_RECOVERY_HELPER_PATH,
    helperTempPath,
    sudoersPath: MAC_DNS_SUDOERS_PATH,
    sudoersTempPath: tempPath,
    visudo,
  });
  const validateTempExit = await run([visudo, "-cf", tempPath], {
    stdin: "ignore",
  });
  if (validateTempExit !== 0) {
    logger.error({
      message: `Refusing to install invalid sudoers content (visudo exit ${validateTempExit})`,
    });
    return 1;
  }

  logger.step({ message: "Installing DNS recovery sudoers rule…" });
  const parentPathsSecure = await verifyMacRootControlledPaths(
    [
      dirname(dirname(MAC_DNS_RECOVERY_HELPER_PATH)),
      dirname(MAC_DNS_RECOVERY_HELPER_PATH),
    ],
    {
      allowMissingPaths: [dirname(MAC_DNS_RECOVERY_HELPER_PATH)],
    }
  );
  if (!parentPathsSecure) {
    logger.error({
      message: [
        `${MAC_DNS_RECOVERY_HELPER_PATH} is not under a root-controlled path.`,
        "Refusing to authorize passwordless sudo for an insecure helper location.",
      ].join(" "),
    });
    return 1;
  }

  const installHelperDirExit = await run(authorization.helperDirectory, {
    stdin: "inherit",
  });
  if (installHelperDirExit !== 0) {
    logger.error({
      message: `Failed to create ${dirname(MAC_DNS_RECOVERY_HELPER_PATH)} (exit ${installHelperDirExit})`,
    });
    return 1;
  }

  const installHelperExit = await run(authorization.helper, {
    stdin: "inherit",
  });
  if (installHelperExit !== 0) {
    logger.error({
      message: `Failed to install ${MAC_DNS_RECOVERY_HELPER_PATH} (exit ${installHelperExit})`,
    });
    return 1;
  }

  const helperSecurityOk = await verifyMacRootControlledPaths([
    dirname(MAC_DNS_RECOVERY_HELPER_PATH),
    MAC_DNS_RECOVERY_HELPER_PATH,
  ]);
  if (!helperSecurityOk) {
    logger.error({
      message: [
        `${MAC_DNS_RECOVERY_HELPER_PATH} is not under a root-controlled path.`,
        "Refusing to authorize passwordless sudo for an insecure helper location.",
      ].join(" "),
    });
    return 1;
  }

  const installDirExit = await run(authorization.sudoersDirectory, {
    stdin: "inherit",
  });
  if (installDirExit !== 0) {
    logger.error({
      message: `Failed to create /etc/sudoers.d (exit ${installDirExit})`,
    });
    return 1;
  }

  const installFileExit = await run(authorization.sudoers, {
    stdin: "inherit",
  });
  if (installFileExit !== 0) {
    logger.error({
      message: `Failed to install ${MAC_DNS_SUDOERS_PATH} (exit ${installFileExit})`,
    });
    return 1;
  }

  const validateInstalledExit = await run(authorization.validate, {
    stdin: "inherit",
  });
  if (validateInstalledExit !== 0) {
    logger.error({
      message: `Installed sudoers rule failed validation (visudo exit ${validateInstalledExit})`,
    });
    return 1;
  }

  const verifyAuthorizationExit = await run(authorization.invalidate, {
    stdin: "ignore",
  });
  if (verifyAuthorizationExit !== 0) {
    logger.warn({
      message: `Unable to invalidate the sudo authentication timestamp before verification (exit ${verifyAuthorizationExit}).`,
    });
  }

  const verifyPasswordlessExit = await run(authorization.check, {
    stdin: "ignore",
  });
  if (verifyPasswordlessExit !== 0) {
    logger.error({
      message: [
        `Installed ${MAC_DNS_SUDOERS_PATH}, but passwordless DNS authorization is still not active (sudo exit ${verifyPasswordlessExit}).`,
        `Check whether your main sudoers config includes ${dirname(MAC_DNS_SUDOERS_PATH)} and whether another sudoers rule is overriding Hack's entry.`,
      ].join("\n"),
    });
    return 1;
  }

  logger.success({
    message: `Installed ${MAC_DNS_SUDOERS_PATH}`,
  });
  note(
    [
      "Authorized commands:",
      `- sudo ${MAC_DNS_RECOVERY_HELPER_PATH} restart-dnsmasq`,
      `- sudo ${MAC_DNS_RECOVERY_HELPER_PATH} stop-dnsmasq`,
      `- sudo ${MAC_DNS_RECOVERY_HELPER_PATH} flush-cache`,
    ].join("\n"),
    "DNS authorization"
  );
  return 0;
}

function renderMacDnsSudoers(opts: {
  readonly helperPath: string;
  readonly user: string;
}): string {
  return [
    "# Managed by hack for local DNS recovery.",
    "# Allows Hack to repair dnsmasq and macOS DNS cache without prompting.",
    `${opts.user} ALL = (root) NOPASSWD: ${opts.helperPath} check, ${opts.helperPath} restart-dnsmasq, ${opts.helperPath} stop-dnsmasq, ${opts.helperPath} flush-cache`,
    "",
  ].join("\n");
}

function renderMacDnsRecoveryHelper(opts: {
  readonly brewPath: string;
}): string {
  const brewLiteral = toPosixShellSingleQuotedLiteral(opts.brewPath);
  return [
    "#!/bin/sh",
    "set -eu",
    `command="\${1:-}"`,
    'case "$command" in',
    "  check)",
    "    exit 0",
    "    ;;",
    "  restart-dnsmasq)",
    `    exec ${brewLiteral} services restart dnsmasq`,
    "    ;;",
    "  stop-dnsmasq)",
    `    exec ${brewLiteral} services stop dnsmasq`,
    "    ;;",
    "  flush-cache)",
    "    /usr/bin/dscacheutil -flushcache",
    "    exec /usr/bin/killall -HUP mDNSResponder",
    "    ;;",
    "  *)",
    '    echo "usage: hack-dns-recovery {check|restart-dnsmasq|stop-dnsmasq|flush-cache}" >&2',
    "    exit 64",
    "    ;;",
    "esac",
    "",
  ].join("\n");
}

function toPosixShellSingleQuotedLiteral(value: string): string {
  return `'${value.replaceAll("'", String.raw`'\''`)}'`;
}

async function verifyMacRootControlledPaths(
  paths: readonly string[],
  options?: {
    readonly allowMissingPaths?: readonly string[];
    readonly timeoutMs?: number;
    readonly onUnreadable?: () => void;
    readonly quiet?: boolean;
  }
): Promise<boolean> {
  const allowMissingPaths = new Set(options?.allowMissingPaths ?? []);
  const report = (message: string) => {
    if (!options?.quiet) {
      logger.error({ message });
    }
  };
  for (const path of paths) {
    const metadata = await readMacOwnershipAndMode(path, options);
    if (metadata === null) {
      if (allowMissingPaths.has(path)) {
        continue;
      }
      report(`Unable to inspect ownership for ${path}.`);
      return false;
    }
    if (metadata.uid !== ROOT_UID || metadata.gid !== WHEEL_GID) {
      report(
        `${path} must be owned by root:wheel before enabling passwordless sudo.`
      );
      return false;
    }
    if ((metadata.mode & 0o022) !== 0) {
      report(
        `${path} must not be writable by group or others before enabling passwordless sudo.`
      );
      return false;
    }
  }

  return true;
}

async function readMacOwnershipAndMode(
  path: string,
  options?: {
    readonly timeoutMs?: number;
    readonly onUnreadable?: () => void;
  }
): Promise<{
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
} | null> {
  const result = await exec(["/usr/bin/stat", "-f", "%u:%g:%Lp", path], {
    stdin: "ignore",
    ...(options?.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  }).catch((error: unknown) => {
    if (!options?.onUnreadable) {
      throw error;
    }
    options.onUnreadable();
    return { exitCode: 127, stdout: "", stderr: "" };
  });
  if (result.exitCode === 124 || result.exitCode === 127) {
    options?.onUnreadable?.();
  }
  if (result.exitCode !== 0) {
    return null;
  }

  const [uidText, gidText, modeText] = result.stdout.trim().split(":");
  const hasParsedMetadata = uidText && gidText && modeText;
  if (!hasParsedMetadata) {
    return null;
  }

  const uid = Number.parseInt(uidText, 10);
  const gid = Number.parseInt(gidText, 10);
  const mode = Number.parseInt(modeText, 8);
  const hasValidNumericMetadata =
    Number.isInteger(uid) && Number.isInteger(gid) && Number.isInteger(mode);
  if (!hasValidNumericMetadata) {
    return null;
  }

  return { uid, gid, mode };
}

async function resolveCurrentUsername(): Promise<string | null> {
  const whoami = await exec(["id", "-un"], { stdin: "ignore" });
  if (whoami.exitCode !== 0) {
    return null;
  }
  const user = whoami.stdout.trim();
  return user.length > 0 ? user : null;
}

async function maybeOfferMacRecoverySetup(): Promise<void> {
  await maybeOfferMacDnsRecoveryAuthorization();
  await maybeOfferMacHackdLaunchdInstall();
}

async function maybeOfferMacDnsRecoveryAuthorization(): Promise<void> {
  if (await pathExists(MAC_DNS_SUDOERS_PATH)) {
    logger.info({
      message: "Passwordless DNS recovery already configured",
    });
    return;
  }

  const exit = await globalAuthorize();
  if (exit !== 0) {
    logger.warn({
      message:
        "Skipping passwordless DNS recovery setup; future `hack global up` may still prompt for sudo.",
    });
  }
}

/**
 * The macOS `hack global install` offer to run `hack daemon install`, which
 * installs the per-user hackd launchd service and starts hackd through it.
 * Non-interactive runs accept the offer.
 *
 * HACK-1368: `hack daemon install` runs through the first `hack` on PATH,
 * which for a candidate run is the stable CLI, so it would install and start
 * the stable hackd. A candidate run, or any run with
 * `HACK_DAEMON_AUTOSTART_DISABLE=1`, skips the offer through
 * {@link resolveDaemonAutostartAccess} before it reads launchd state or
 * prompts. Exported for tests.
 */
export async function maybeOfferMacHackdLaunchdInstall(): Promise<void> {
  const autostart = resolveDaemonAutostartAccess();
  if (!autostart.allowed) {
    logger.info({
      message: `Skipping hackd launchd setup: ${autostart.message}`,
    });
    return;
  }
  const access = resolveLaunchdAccess();
  if (!access.allowed) {
    logger.info({ message: `Skipping hackd launchd setup: ${access.message}` });
    return;
  }
  const paths = resolveDaemonPaths({});
  const launchdStatus = await getLaunchdServiceStatus({ paths });
  if (launchdStatus.installed) {
    logger.info({
      message: "hackd launchd service already installed",
    });
    return;
  }

  const ok = await confirmSafe({
    message:
      "Install hackd as a launchd service so it restarts automatically on login and daemon crashes?",
    initialValue: true,
    nonInteractive: "accept-default",
  });
  if (!ok) {
    logger.warn({
      message:
        "Skipping hackd launchd setup; daemon recovery will be less durable after login or local crashes.",
    });
    return;
  }

  const invocation = await resolveHackInvocation();
  const exit = await run(
    [invocation.bin, ...invocation.args, "daemon", "install"],
    {
      hackReexec: true,
      stdin: "inherit",
    }
  );
  if (exit !== 0) {
    logger.warn({
      message:
        "Failed to install hackd launchd service; run `hack daemon install` manually.",
    });
  }
}

/**
 * The proxy Compose file is rendered from settings, so it is replaced without
 * a prompt (HACK-2328); see {@link writeManagedProxyCompose}.
 */
/** See {@link writeGlobalLoggingAssets}: silent only for Hack's renderings. */
async function writeLoggingCompose(opts: {
  readonly path: string;
  readonly content: string;
}): Promise<void> {
  const existing = await readTextFile(opts.path);
  if (
    existing !== null &&
    existing !== opts.content &&
    !isHackRenderedLoggingCompose(existing)
  ) {
    const replace = await confirmSafe({
      message: `Replace ${opts.path}?\nIt differs from Hack's rendering (edited by hand, or written by an older Hack). The current file is backed up first. It controls whether Loki and Grafana are routed through the proxy.`,
      initialValue: false,
      nonInteractive: "accept-default",
    });
    if (!replace) {
      logger.warn({
        message: `Kept ${opts.path}: it differs from Hack's rendering, so \`hack global up\` keeps its fixed waits unless it has healthchecks. To take Hack's file, run \`hack global install\` in a terminal and accept, or move the file aside first.`,
      });
      return;
    }
  }
  await writeGlobalManagedCompose({
    path: opts.path,
    content: opts.content,
    // Confirmed above, or Hack's own: replace, backing up a non-rendering.
    isHackRendered: isHackRenderedLoggingCompose,
  });
}

async function writeGlobalManagedCompose(opts: {
  readonly path: string;
  readonly content: string;
  readonly isHackRendered?: (text: string) => boolean;
}): Promise<void> {
  const result = await writeManagedProxyCompose(opts);
  if (result.kind === "replaced-hand-edit") {
    logger.warn({
      message: `Replaced ${opts.path}: it differed from Hack's current rendering (edited by hand, or written by an older Hack). The previous copy is at ${result.backupPath}`,
    });
  }
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
    const ok = await confirmSafe({
      message: `Overwrite existing file?\n${absolutePath}`,
      initialValue: false,
      nonInteractive: "accept-default",
    });
    if (!ok) {
      return;
    }
  }

  await writeTextFileIfChanged(absolutePath, content);
}

/**
 * The `daemon.autoStart` step of `hack global up`: runs `hack daemon start`
 * through the first `hack` on PATH and only warns when it fails.
 *
 * HACK-1368: for a candidate run that `hack` is the stable CLI, so a candidate
 * run, or any run with `HACK_DAEMON_AUTOSTART_DISABLE=1`, skips the step
 * through {@link resolveDaemonAutostartAccess}, as the implicit autostart in
 * `requestDaemonJson` does. A denied run reads no config and spawns nothing.
 */
async function ensureHackdForGlobalUp(): Promise<void> {
  const access = resolveDaemonAutostartAccess();
  if (!access.allowed) {
    logger.info({ message: `Skipping hackd start: ${access.message}` });
    return;
  }
  const controlPlane = await readControlPlaneConfig({});
  if (!controlPlane.config.daemon.autoStart) {
    return;
  }
  logger.step({ message: "Ensuring hackd is running…" });
  const invocation = await resolveHackInvocation();
  const daemonExit = await run(
    [invocation.bin, ...invocation.args, "daemon", "start"],
    {
      hackReexec: true,
      stdin: "ignore",
    }
  );
  if (daemonExit !== 0) {
    logger.warn({ message: "Unable to start hackd (continuing)" });
  }
}

/**
 * After the proxy's `compose up` failed: a failed start can leave the proxy
 * created but never started, with no network endpoint, so remove it for the
 * next attempt to recreate (HACK-2328), then name the listeners on 80/443.
 */
async function reportProxyStartFailure(opts: {
  readonly composeFile: string;
}): Promise<void> {
  const cleanup = await removeUnstartedProxyContainers();
  if (cleanup.kind === "failed") {
    logger.warn({ message: cleanup.message });
  }
  logger.error({
    message: await diagnoseProxyPortConflict({
      bindAddress: readProxyBindFromCompose(
        (await readTextFile(opts.composeFile)) ?? ""
      ),
    }),
  });
}

/**
 * The most `hack global up` waits for each stack to become ready. A healthy
 * stack ends the wait as soon as its healthchecks pass (about a second for
 * Caddy, about ten for Loki); these bounds only matter when one never does.
 * Grafana migrates its database on a first start, so the logging stack gets
 * longer. A container that stops after the wait is not caught here: `hack
 * doctor` and the stack's own symptoms report it.
 */
/** Stable codes for a global stack that did not become ready, or stopped. */
const GLOBAL_NOT_READY_CODE = "E_GLOBAL_NOT_READY" as const;
const GLOBAL_STOPPED_CODE = "E_GLOBAL_STOPPED" as const;

const ROUTING_READY_TIMEOUT_MS = 30_000;
const LOGGING_READY_TIMEOUT_MS = 120_000;
/**
 * The fixed watch windows Hack used before healthchecks, kept only for a
 * stack whose compose file has none (written by an older `hack global
 * install`); `hack global install` replaces such a file.
 */
const ROUTING_LEGACY_WATCH_MS = 2000;
const LOGGING_LEGACY_WATCH_MS = 10_000;

/**
 * After a successful `docker compose up -d`: waits until the stack is ready
 * (every container running, every healthcheck passing) and reports the
 * containers that are not, by name (HACK-2381). `up -d` exits 0 for a
 * container that starts and then fails at once, so without this a stack with
 * exited containers was reported as up. Returns whether the stack failed to
 * become ready. No answer from Docker is not a finding.
 */
async function globalStackNotReady(opts: {
  readonly composeFile: string;
  readonly stack: string;
  readonly login: boolean;
  readonly timeoutMs: number;
  readonly legacyWatchMs: number;
}): Promise<HackCliError | null> {
  const notReady = await waitForStartedContainers({
    timeoutMs: opts.timeoutMs,
    withoutHealthchecksMs: opts.legacyWatchMs,
    read: async () => {
      const ps = await exec(
        [
          "docker",
          "compose",
          // The same environment rule as the `up` this follows.
          ...(opts.login ? ["--env-file", "/dev/null"] : []),
          "-f",
          opts.composeFile,
          "ps",
          "--all",
          "--format",
          "json",
        ],
        { stdin: "ignore" }
      );
      return ps.exitCode === 0 ? parseComposePs(ps.stdout) : [];
    },
  });
  if (notReady === null) {
    return null;
  }
  if (notReady.reason !== "stopped") {
    return new HackCliError({
      code: GLOBAL_NOT_READY_CODE,
      message: describeContainersNotHealthy({
        stack: opts.stack,
        reason: notReady.reason,
        timeoutMs: opts.timeoutMs,
        containers: notReady.containers,
      }),
    });
  }
  // The usual cause on Linux: a config the container's user cannot read.
  // Named by mode alone; nothing is read or changed here.
  const paths = getGlobalPaths();
  // Only the configs this stack's containers mount.
  const unreadable = await unreadableContainerPaths(
    opts.composeFile === paths.caddyCompose
      ? [{ path: paths.coreDnsConfig, kind: "file" }]
      : [
          { path: paths.lokiConfig, kind: "file" },
          { path: paths.grafanaDatasource, kind: "file" },
          { path: paths.grafanaDashboardsProvisioning, kind: "file" },
          { path: dirname(paths.grafanaDashboard), kind: "directory" },
          { path: paths.grafanaDashboard, kind: "file" },
        ]
  );
  return new HackCliError({
    code: GLOBAL_STOPPED_CODE,
    message: [
      describeContainersNotRunning({
        stack: opts.stack,
        containers: notReady.containers,
      }),
      ...(unreadable.length > 0
        ? [describeUnreadableContainerPaths(unreadable)]
        : []),
    ].join("\n"),
  });
}

const WHITESPACE = /\s+/;

/** The most `hack global up` waits for DNS and HTTPS through the proxy. */
const ROUTES_READY_TIMEOUT_MS = 15_000;

/**
 * After the proxy's containers are ready: waits, bounded and with progress,
 * until a `.hack` name resolves through CoreDNS to the proxy's own address
 * and TLS through the published port is answered by the proxy itself (see
 * src/lib/global-route-probe.ts). The HTTPS endpoints are the ones doctor
 * checks, from the proxy's live bindings. A step Hack cannot check is
 * reported and does not fail `global up`; only a real refusal or a wrong
 * answer does, returned as a coded error.
 */
async function globalRoutesNotReady(opts: {
  readonly paths: ReturnType<typeof getGlobalPaths>;
  readonly login: boolean;
}): Promise<{
  readonly error: HackCliError | null;
  readonly routes: RouteProbeResult;
}> {
  const { paths, login } = opts;
  const proxyCompose = (await readTextFile(paths.caddyCompose)) ?? "";
  const engine = `host:${await dockerEngineEndpoint()}`;
  let runtime = await routeChecks.readProxyRuntime();
  const targets = routeHttpsTargets({
    engine,
    loopbackPorts: runtime.loopbackPorts,
  });
  let caddyAddresses = await routeChecks.readCaddyAddresses();
  const result = await waitForRoutes(
    {
      name: routeProbeName(proxyCompose),
      resolveName: async (name) => {
        caddyAddresses ??= await routeChecks.readCaddyAddresses();
        const answer = await exec(
          [
            "docker",
            "compose",
            ...(login ? ["--env-file", "/dev/null"] : []),
            "-f",
            paths.caddyCompose,
            "exec",
            "-T",
            "caddy",
            "nslookup",
            name,
            "coredns",
          ],
          { stdin: "ignore", timeoutMs: 3000 }
        );
        return classifyNslookup({
          exitCode: answer.exitCode,
          output: `${answer.stdout}\n${answer.stderr}`,
          expected: caddyAddresses,
        });
      },
      requestHttps: async (name) => {
        if (runtime.caPem === null) {
          runtime = await routeChecks.readProxyRuntime();
        }
        const caPem = runtime.caPem;
        if (caPem === null) {
          return {
            kind: "unknown",
            detail:
              "the running proxy's CA could not be read, so HTTPS through the proxy was not checked",
            // Caddy has its root before its healthcheck passes; a CA that
            // cannot be read then is not one a few more looks would find.
            retry: false,
          };
        }
        return await lookHttps({
          name,
          resolve: routeChecks.resolveSystemAddresses,
          fallback: targets,
          probe: (addresses) =>
            routeChecks.probeProxyHttpsAt({ addresses, caPem, name }),
        });
      },
      progress: login
        ? undefined
        : ({ waitingFor, elapsedMs }) =>
            logger.step({
              message: `Waiting for ${waitingFor.join(" and ")} through the proxy (${Math.round(elapsedMs / 1000)} s)…`,
            }),
    },
    { timeoutMs: ROUTES_READY_TIMEOUT_MS }
  );
  const notReady = (["dns", "https"] as const).filter(
    (step) => result[step].state === "not-ready"
  );
  for (const step of ["dns", "https"] as const) {
    const outcome = result[step];
    if (outcome.state === "unknown" && !login) {
      logger.info({ message: `Not checked: ${outcome.detail}.` });
    }
  }
  if (notReady.length === 0) {
    return { error: null, routes: result };
  }
  return {
    routes: result,
    error: new HackCliError({
      code: GLOBAL_NOT_READY_CODE,
      message: [
        `The global proxy's containers are running, but within ${Math.round(ROUTES_READY_TIMEOUT_MS / 1000)} s ${notReady
          .map((step) => {
            const outcome = result[step];
            return outcome.state === "not-ready" ? outcome.detail : "";
          })
          .join(", and ")}.`,
        "See why: docker logs --tail 50 hack-dev-proxy-caddy-1; docker logs --tail 50 hack-dev-proxy-coredns-1; hack doctor",
      ].join("\n"),
    }),
  };
}

/**
 * The endpoint `docker` talks to, without starting anything: `DOCKER_HOST`,
 * else the selected context's endpoint (one `docker context inspect`), else
 * the default local socket.
 */
async function dockerEngineEndpoint(): Promise<string> {
  const engine = await selectedDockerEngine(process.env);
  if (engine.startsWith("host:")) {
    return engine.slice("host:".length);
  }
  const context = engine.slice("context:".length);
  if (context === "default") {
    return "unix://default";
  }
  const inspect = await exec(
    [
      "docker",
      "context",
      "inspect",
      context,
      "--format",
      "{{.Endpoints.docker.Host}}",
    ],
    { stdin: "ignore", timeoutMs: 3000 }
  ).catch(() => null);
  const endpoint = inspect?.exitCode === 0 ? inspect.stdout.trim() : "";
  return endpoint === "" ? "unknown://" : endpoint;
}

/** Which part of `hack global up` failed, for install's decision (HACK-2328). */
type GlobalUpResult = {
  readonly exit: number;
  /** `routing`: proxy/CoreDNS (or a prerequisite); `logging`: only the logging stack. */
  readonly failedStage: "routing" | "logging" | null;
  /** A coded readiness failure (E_GLOBAL_NOT_READY / E_GLOBAL_STOPPED). */
  readonly error?: HackCliError;
  /** The route probe's outcome per step, once it ran. */
  readonly routes?: RouteProbeResult;
  /** Whether this run kept the logging stack on. */
  readonly logging?: boolean;
};

/** For callers that continue on failure: prints a coded failure, returns the code. */
export async function globalUp(): Promise<number> {
  const result = await runGlobalUp();
  if (result.error) {
    logger.error({
      message: `${result.error.code}: ${result.error.message}`,
    });
  }
  return result.exit;
}

/** `hack global up`: a coded failure is thrown, for its text line or JSON envelope. */
/**
 * `hack global up`. A `--logging`/`--no-logging` choice is saved first; if
 * the save fails this run still follows it. Without `--json` a coded
 * failure is thrown for its text line. With `--json`, human lines go to
 * stderr and stdout holds one envelope: `{ok: true, data}` or `{ok: false,
 * error: {code, message, detail}}`, where `code` is E_GLOBAL_NOT_READY or
 * E_GLOBAL_STOPPED for a readiness failure, else E_GLOBAL_INFRA_DOWN, and
 * `data`/`detail` is `hack.global-up.v1` (see {@link globalUpData}). Exit
 * codes are the same in both modes.
 */
async function globalUpCommand(opts: {
  readonly choice: boolean | null;
  readonly json: boolean;
}): Promise<number> {
  if (opts.json) {
    setLoggerBackendOverride({ backend: "console" });
  }
  const problems = opts.json ? captureLoggedProblems() : null;
  let result: GlobalUpResult;
  try {
    const loggingOverride = await saveLoggingChoice(opts.choice);
    result = await runGlobalUp(
      loggingOverride === undefined ? {} : { loggingOverride }
    );
  } finally {
    problems?.stop();
    if (opts.json) {
      setLoggerBackendOverride({ backend: null });
    }
  }
  if (!opts.json) {
    if (result.error) {
      throw result.error;
    }
    return result.exit;
  }
  const data = globalUpData(result);
  emitCliResult({
    result:
      result.exit === 0
        ? okResult({ data })
        : errorResult({
            code: result.error?.code ?? "E_GLOBAL_INFRA_DOWN",
            message:
              result.error?.message ??
              problems?.last() ??
              "hack global up failed",
            detail: data,
          }),
  });
  return result.exit;
}

/**
 * Saves a `--logging`/`--no-logging` choice. Returns it when the save
 * failed, so this run follows it anyway (reported), else undefined.
 */
async function saveLoggingChoice(
  choice: boolean | null
): Promise<boolean | undefined> {
  if (choice === null) {
    return undefined;
  }
  try {
    await updateGlobalConfig({
      path: LOGGING_ENABLED_CONFIG_KEY,
      value: choice,
    });
    return undefined;
  } catch (error) {
    // Not saved: this run still follows the flag, and routing starts.
    logger.warn({
      message: `${LOGGING_ENABLED_CONFIG_KEY}=${choice} was not saved: ${error instanceof Error ? error.message : String(error)}. This run uses it; later runs follow the saved setting.`,
    });
    return choice;
  }
}

/**
 * `hack global up --json` data (`hack.global-up.v1`): which stage failed
 * (`routing`, `logging` or null), whether logging ran on, and the route
 * probe's outcome per step (`ready`, `not-ready` or `unknown` with its
 * detail; null when the probe did not run).
 */
function globalUpData(result: GlobalUpResult) {
  return {
    schema: MACHINE_SCHEMAS.globalUp,
    failedStage: result.failedStage,
    logging: result.logging === undefined ? null : { enabled: result.logging },
    routes: result.routes ?? null,
  } as const;
}

/**
 * `hack global up` inside a change of the ingress generation (see
 * withIngressChange), then, once routing is up, one read that records the
 * proxy and DNS addresses under the settled token for later `hack run`s.
 */
type UpOptions = {
  /** A `--logging`/`--no-logging` choice that could not be saved. */
  readonly loggingOverride?: boolean;
};

async function runGlobalUp(opts: UpOptions = {}): Promise<GlobalUpResult> {
  const root = resolveGlobalHackDir();
  const result = await withIngressChange(root, () => runGlobalUpChange(opts));
  if (result.exit === 0 || result.failedStage === "logging") {
    await resolveIngressAddresses(defaultIngressAddressDeps(root), "fresh");
  }
  return result;
}

/**
 * The logging setting this run uses: an unsaved flag choice as given;
 * login only reads the setting; a manual start also saves an existing
 * home's choice.
 */
async function upLoggingChoice(opts: {
  readonly opts: UpOptions;
  readonly paths: ReturnType<typeof getGlobalPaths>;
  readonly login: boolean;
}): Promise<{ readonly enabled: boolean }> {
  if (opts.opts.loggingOverride !== undefined) {
    return { enabled: opts.opts.loggingOverride };
  }
  if (opts.login) {
    return await resolveGlobalLogging({
      loggingCompose: opts.paths.loggingCompose,
    });
  }
  return await settleGlobalLoggingSetting({ paths: opts.paths });
}

/**
 * Moves other containers off the proxy's reserved ingress IPs before it
 * starts. False when some still hold them (reported).
 */
async function clearReservedIngressIps(opts: {
  readonly composePath: string;
}): Promise<boolean> {
  const reservedIps = await resolveReservedIngressIps(opts);
  if (reservedIps.length === 0) {
    return true;
  }
  const blockersOf = (conflicts: readonly IngressIpConflict[]) =>
    conflicts.filter(
      (conflict) => !isGlobalProxyContainer({ name: conflict.containerName })
    );
  const blockers = blockersOf(await findIngressIpConflicts({ reservedIps }));
  if (blockers.length === 0) {
    return true;
  }
  logger.warn({
    message: [
      `Reserved ingress IPs are currently occupied on ${DEFAULT_INGRESS_NETWORK}.`,
      "Attempting to reassign conflicting containers and retry global startup…",
    ].join("\n"),
  });
  await reassignIngressIpConflicts({ conflicts: blockers, reservedIps });
  const remaining = blockersOf(await findIngressIpConflicts({ reservedIps }));
  if (remaining.length > 0) {
    logger.error({
      message: renderIngressConflictMessage({ conflicts: remaining }),
    });
    return false;
  }
  logger.success({
    message: "Recovered reserved ingress IP conflicts; continuing startup.",
  });
  return true;
}

async function runGlobalUpChange(opts: UpOptions): Promise<GlobalUpResult> {
  const slimExit = failIfSlimMode({
    feature: "hack global up",
  });
  if (slimExit !== null) {
    return { exit: slimExit, failedStage: "routing" };
  }

  const paths = getGlobalPaths();
  const login = process.env.HACK_AUTOSTART_LOGIN === "1";
  await secureGlobalLoginRouting({ root: paths.root, login });
  const logging = await upLoggingChoice({ opts, paths, login });

  await ensureDockerRunning({ login });
  await assertGlobalLoginRoutingImages({
    composeFile: paths.caddyCompose,
    login,
  });
  if (isMac() && globalDnsRecoveryAllowed({ login })) {
    await ensureMacDnsmasqRunning();
  }
  if (!(await pathExists(paths.caddyCompose))) {
    logger.error({
      message: `Missing ${paths.caddyCompose}. Run: hack global install`,
    });
    return { exit: 1, failedStage: "routing" };
  }
  if (logging.enabled && !login && !(await pathExists(paths.loggingCompose))) {
    // Turned on (`--logging` or the config) in a home that never had it.
    await materializeGlobalLoggingFiles({ paths });
  }

  const proxyRepairExit = await repairProxyNetworkBeforeUp({
    composeFile: paths.caddyCompose,
  });
  if (proxyRepairExit !== 0) {
    return { exit: proxyRepairExit, failedStage: "routing" };
  }

  if (!(await clearReservedIngressIps({ composePath: paths.caddyCompose }))) {
    return { exit: 1, failedStage: "routing" };
  }

  await ensureHackdForGlobalUp();

  logger.step({ message: "Starting Caddy…" });
  const caddyExit = await run(
    globalRoutingUpArguments({ composeFile: paths.caddyCompose, login }),
    { cwd: dirname(paths.caddyCompose) }
  );
  if (caddyExit !== 0) {
    await reportProxyStartFailure({ composeFile: paths.caddyCompose });
    return { exit: caddyExit, failedStage: "routing" };
  }
  const remainingProxyIssues = await inspectProxyNetwork({
    composeFile: paths.caddyCompose,
  });
  if (remainingProxyIssues && remainingProxyIssues.length > 0) {
    logger.error({
      message: [
        "Global proxy is still not on its ingress network after startup:",
        ...remainingProxyIssues.map(
          (issue) => `- ${describeProxyNetworkIssue(issue)}`
        ),
        "Fix: hack global down && hack global up, then hack doctor",
      ].join("\n"),
    });
    return { exit: 1, failedStage: "routing" };
  }
  const stackError = await globalStackNotReady({
    composeFile: paths.caddyCompose,
    stack: "The global proxy (Caddy and CoreDNS)",
    login,
    timeoutMs: ROUTING_READY_TIMEOUT_MS,
    legacyWatchMs: ROUTING_LEGACY_WATCH_MS,
  });
  if (stackError) {
    return { exit: 1, failedStage: "routing", error: stackError };
  }
  const { error: routesError, routes } = await globalRoutesNotReady({
    paths,
    login,
  });
  if (routesError) {
    return { exit: 1, failedStage: "routing", error: routesError, routes };
  }
  await reconcileGlobalRoutingBridge({ enabled: !login });

  const loggingResult = await settleGlobalLogging({
    paths,
    login,
    enabled: logging.enabled,
  });
  if (loggingResult.exit !== 0) {
    return {
      ...loggingResult,
      failedStage: "logging",
      routes,
      logging: logging.enabled,
    };
  }
  logger.success({ message: "Global infra is up" });
  return { exit: 0, failedStage: null, routes, logging: logging.enabled };
}

/**
 * The logging part of `hack global up`: starts the stack and waits for it
 * when it is on (not at login), stops what is left of it when it is off.
 * Returns the exit code; non-zero means only the logging stack failed.
 */
async function settleGlobalLogging(opts: {
  readonly paths: ReturnType<typeof getGlobalPaths>;
  readonly login: boolean;
  readonly enabled: boolean;
}): Promise<{ readonly exit: number; readonly error?: HackCliError }> {
  const { paths, login } = opts;
  if (!opts.enabled) {
    return { exit: await stopDisabledLoggingStack({ paths, login }) };
  }
  const loggingArguments = globalLoggingUpArguments({
    composeFile: paths.loggingCompose,
    login,
  });
  if (!loggingArguments) {
    return { exit: 0 };
  }
  logger.step({ message: "Starting logging stack…" });
  const logExit = await run(loggingArguments, {
    cwd: dirname(paths.loggingCompose),
  });
  if (logExit !== 0) {
    return { exit: logExit };
  }
  const error = await globalStackNotReady({
    composeFile: paths.loggingCompose,
    stack: "The logging stack (Grafana, Loki, Alloy)",
    login,
    timeoutMs: LOGGING_READY_TIMEOUT_MS,
    legacyWatchMs: LOGGING_LEGACY_WATCH_MS,
  });
  return error ? { exit: 1, error } : { exit: 0 };
}

/** {@link resolveAndSaveGlobalLogging} for this home, saying when it saved. */
async function settleGlobalLoggingSetting(opts: {
  readonly paths: ReturnType<typeof getGlobalPaths>;
}): Promise<{ readonly enabled: boolean }> {
  const logging = await resolveAndSaveGlobalLogging({
    loggingCompose: opts.paths.loggingCompose,
    save: async (value) =>
      await updateGlobalConfig({ path: LOGGING_ENABLED_CONFIG_KEY, value }),
  });
  if (logging.saved) {
    logger.info({
      message: `This home already ran the logging stack, so it stays on: saved ${LOGGING_ENABLED_CONFIG_KEY}=true. Turn it off with: hack global up --no-logging`,
    });
  } else if (logging.saveError !== undefined) {
    logger.warn({
      message: `This home already ran the logging stack, so it stays on for this run, but ${LOGGING_ENABLED_CONFIG_KEY}=true was not saved: ${logging.saveError}. Hack decides again from the home's files next time; save it with: hack config set --global ${LOGGING_ENABLED_CONFIG_KEY} true`,
    });
  }
  return logging;
}

/**
 * With logging off: stops the stack's containers if a home still has them
 * (it was on before), keeping its volumes, and says how to turn it on. A
 * home that never had the stack makes no Docker call here. Returns the exit
 * code: a failed lookup or stop is reported, since the containers may still
 * run.
 */
async function stopDisabledLoggingStack(opts: {
  readonly paths: ReturnType<typeof getGlobalPaths>;
  readonly login: boolean;
}): Promise<number> {
  if (!opts.login) {
    const ids = await thisHomeLoggingContainers({
      loggingDir: dirname(opts.paths.loggingCompose),
    });
    if (ids === null) {
      // Not known to be stopped: a failed lookup is not an absent stack.
      logger.error({
        message: [
          "Logging is off, but Docker could not be asked for its containers, so none were stopped.",
          "They may still be running. Retry: hack global up --no-logging",
        ].join("\n"),
      });
      return 1;
    }
    const stop =
      ids.length > 0
        ? await exec(["docker", "stop", ...ids], { stdin: "ignore" })
        : null;
    if (stop && stop.exitCode !== 0) {
      const cause = stop.stderr.trim().split("\n")[0] ?? "";
      logger.error({
        message: [
          `Logging is off, but its containers could not be stopped (docker stop exited ${stop.exitCode})${cause ? `: ${cause}` : "."}`,
          "They may still be running. Retry: hack global up --no-logging",
        ].join("\n"),
      });
      return stop.exitCode;
    }
  }
  logger.info({
    message: `Logging stack (Loki, Alloy, Grafana) is off; \`hack logs\` reads container logs. Turn it on with: ${LOGGING_ENABLE_COMMAND}`,
  });
  return 0;
}

type IngressIpConflict = {
  readonly ip: string;
  readonly containerName: string;
};

type IngressNetworkSnapshot = {
  readonly subnet: string | null;
  readonly gateway: string | null;
  readonly usedIps: ReadonlySet<string>;
  readonly containerIpByName: ReadonlyMap<string, string>;
};

async function resolveReservedIngressIps(opts: {
  readonly composePath: string;
}): Promise<string[]> {
  const text = await readTextFile(opts.composePath);
  if (!text) {
    return [];
  }

  const reserved: string[] = [];
  if (text.includes(`ipv4_address: ${DEFAULT_CADDY_IP}`)) {
    reserved.push(DEFAULT_CADDY_IP);
  }
  if (text.includes(`ipv4_address: ${DEFAULT_COREDNS_IP}`)) {
    reserved.push(DEFAULT_COREDNS_IP);
  }
  return reserved;
}

async function findIngressIpConflicts(opts: {
  readonly reservedIps: readonly string[];
}): Promise<IngressIpConflict[]> {
  if (opts.reservedIps.length === 0) {
    return [];
  }

  const snapshot = await inspectIngressNetworkSnapshot();
  if (!snapshot) {
    return [];
  }

  const reservedIps = new Set(opts.reservedIps);
  const conflicts: IngressIpConflict[] = [];
  for (const [containerName, ip] of snapshot.containerIpByName.entries()) {
    if (!reservedIps.has(ip)) {
      continue;
    }
    conflicts.push({ ip, containerName });
  }

  return conflicts;
}

async function inspectIngressNetworkSnapshot(): Promise<IngressNetworkSnapshot | null> {
  const inspect = await exec(
    ["docker", "network", "inspect", DEFAULT_INGRESS_NETWORK],
    {
      stdin: "ignore",
    }
  );
  if (inspect.exitCode !== 0) {
    return null;
  }

  const parsed = parseIngressNetworkInspectPayload({ stdout: inspect.stdout });
  if (!parsed) {
    return null;
  }

  let subnet: string | null = null;
  let gateway: string | null = null;
  const usedIps = new Set<string>();
  const containerIpByName = new Map<string, string>();
  for (const entry of parsed) {
    if (subnet === null) {
      const ipamConfig = readIngressIpamConfig({ entry });
      subnet = ipamConfig.subnet;
      gateway = ipamConfig.gateway;
    }

    collectIngressContainerIps({
      entry,
      usedIps,
      containerIpByName,
    });
  }

  return {
    subnet,
    gateway,
    usedIps,
    containerIpByName,
  };
}

function parseIngressNetworkInspectPayload(opts: {
  readonly stdout: string;
}): readonly Record<string, unknown>[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  return parsed.filter(isRecord);
}

function readIngressIpamConfig(opts: {
  readonly entry: Record<string, unknown>;
}): {
  readonly subnet: string | null;
  readonly gateway: string | null;
} {
  const ipam = opts.entry.IPAM;
  if (!isRecord(ipam)) {
    return { subnet: null, gateway: null };
  }

  const rawConfig = ipam.Config;
  if (!Array.isArray(rawConfig)) {
    return { subnet: null, gateway: null };
  }

  let subnet: string | null = null;
  let gateway: string | null = null;
  for (const config of rawConfig) {
    if (!isRecord(config)) {
      continue;
    }
    if (subnet === null && typeof config.Subnet === "string") {
      subnet = config.Subnet;
    }
    if (gateway === null && typeof config.Gateway === "string") {
      gateway = config.Gateway;
    }
    if (subnet !== null && gateway !== null) {
      break;
    }
  }

  return { subnet, gateway };
}

function collectIngressContainerIps(opts: {
  readonly entry: Record<string, unknown>;
  readonly usedIps: Set<string>;
  readonly containerIpByName: Map<string, string>;
}): void {
  const containers = opts.entry.Containers;
  if (!isRecord(containers)) {
    return;
  }

  for (const info of Object.values(containers)) {
    if (!isRecord(info)) {
      continue;
    }
    const name = typeof info.Name === "string" ? info.Name : "";
    const ipRaw = typeof info.IPv4Address === "string" ? info.IPv4Address : "";
    if (!(name && ipRaw)) {
      continue;
    }
    const ip = extractIpv4Address({ raw: ipRaw });
    if (ip.length === 0) {
      continue;
    }
    opts.usedIps.add(ip);
    opts.containerIpByName.set(name, ip);
  }
}

async function reassignIngressIpConflicts(opts: {
  readonly conflicts: readonly IngressIpConflict[];
  readonly reservedIps: readonly string[];
}): Promise<void> {
  const snapshot = await inspectIngressNetworkSnapshot();
  const usedIps = new Set(snapshot?.usedIps ?? []);
  const reservedIps = new Set(opts.reservedIps);
  const containerIpByName = new Map(snapshot?.containerIpByName ?? []);
  const conflictIpsByContainer = new Map(
    opts.conflicts.map((conflict) => [conflict.containerName, conflict.ip])
  );
  const containerNames = [
    ...new Set(opts.conflicts.map((conflict) => conflict.containerName)),
  ];

  for (const containerName of containerNames) {
    logger.step({
      message: `Reassigning ${containerName} on ${DEFAULT_INGRESS_NETWORK}…`,
    });

    const disconnect = await exec(
      [
        "docker",
        "network",
        "disconnect",
        "-f",
        DEFAULT_INGRESS_NETWORK,
        containerName,
      ],
      {
        stdin: "ignore",
      }
    );
    if (disconnect.exitCode !== 0) {
      logger.warn({
        message: [
          `Failed to disconnect ${containerName} from ${DEFAULT_INGRESS_NETWORK} (exit ${disconnect.exitCode}).`,
          trimShellError({ text: disconnect.stderr }),
        ].join("\n"),
      });
      continue;
    }

    const previousIp =
      conflictIpsByContainer.get(containerName) ??
      containerIpByName.get(containerName) ??
      null;
    if (previousIp !== null) {
      usedIps.delete(previousIp);
      containerIpByName.delete(containerName);
    }

    const desiredIp = pickAvailableIngressIp({
      subnet: snapshot?.subnet ?? null,
      gateway: snapshot?.gateway ?? null,
      usedIps,
      reservedIps,
    });

    const connectCommand = desiredIp
      ? [
          "docker",
          "network",
          "connect",
          "--ip",
          desiredIp,
          DEFAULT_INGRESS_NETWORK,
          containerName,
        ]
      : [
          "docker",
          "network",
          "connect",
          DEFAULT_INGRESS_NETWORK,
          containerName,
        ];
    const connect = await exec(connectCommand, {
      stdin: "ignore",
    });
    if (connect.exitCode !== 0) {
      logger.warn({
        message: [
          `Failed to reconnect ${containerName} to ${DEFAULT_INGRESS_NETWORK} (exit ${connect.exitCode}).`,
          trimShellError({ text: connect.stderr }),
        ].join("\n"),
      });
      continue;
    }

    if (desiredIp) {
      usedIps.add(desiredIp);
      containerIpByName.set(containerName, desiredIp);
    }
  }
}

function pickAvailableIngressIp(opts: {
  readonly subnet: string | null;
  readonly gateway: string | null;
  readonly usedIps: ReadonlySet<string>;
  readonly reservedIps: ReadonlySet<string>;
}): string | null {
  if (!opts.subnet) {
    return null;
  }
  const cidr = parseIpv4Cidr(opts.subnet);
  if (!cidr) {
    return null;
  }
  if (cidr.prefix >= 31) {
    return null;
  }

  const hostCapacity = 2 ** (32 - cidr.prefix);
  const firstHost = cidr.network + 1;
  const lastHost = cidr.network + hostCapacity - 2;
  const maxCandidates = Math.min(4096, Math.max(0, lastHost - firstHost + 1));

  for (let offset = 0; offset < maxCandidates; offset += 1) {
    const candidate = intToIpv4(firstHost + offset);
    if (candidate === opts.gateway) {
      continue;
    }
    if (opts.reservedIps.has(candidate)) {
      continue;
    }
    if (opts.usedIps.has(candidate)) {
      continue;
    }
    return candidate;
  }
  return null;
}

function parseIpv4Cidr(
  cidr: string
): { readonly network: number; readonly prefix: number } | null {
  const [ipText, prefixText] = cidr.split("/");
  if (!(ipText && prefixText)) {
    return null;
  }

  const prefix = Number.parseInt(prefixText, 10);
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) {
    return null;
  }

  const ip = ipv4ToInt(ipText);
  if (ip === null) {
    return null;
  }

  let mask = 0;
  if (prefix === 0) {
    mask = 0;
  } else if (prefix === 32) {
    mask = 0xff_ff_ff_ff;
  } else {
    mask = (0xff_ff_ff_ff << (32 - prefix)) >>> 0;
  }

  return {
    network: (ip & mask) >>> 0,
    prefix,
  };
}

function ipv4ToInt(ip: string): number | null {
  const octets = ip.split(".");
  if (octets.length !== 4) {
    return null;
  }

  const numbers = octets.map((octet) => Number.parseInt(octet, 10));
  if (
    numbers.some((octet) => !Number.isFinite(octet) || octet < 0 || octet > 255)
  ) {
    return null;
  }

  const a = numbers[0] ?? 0;
  const b = numbers[1] ?? 0;
  const c = numbers[2] ?? 0;
  const d = numbers[3] ?? 0;
  return (((a << 24) >>> 0) | (b << 16) | (c << 8) | d) >>> 0;
}

function intToIpv4(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join(".");
}

function extractIpv4Address(opts: { readonly raw: string }): string {
  return opts.raw.split("/")[0] ?? "";
}

function isGlobalProxyContainer(opts: { readonly name: string }): boolean {
  return opts.name.startsWith("hack-dev-proxy-");
}

function renderIngressConflictMessage(opts: {
  readonly conflicts: readonly IngressIpConflict[];
}): string {
  const lines = [
    `Cannot start global proxy: reserved IPs are already in use on ${DEFAULT_INGRESS_NETWORK}.`,
    "Conflicts:",
  ];

  for (const conflict of opts.conflicts) {
    lines.push(`- ${conflict.ip} is used by ${conflict.containerName}`);
  }

  lines.push(
    "Fix:",
    "- Stop the project using that IP (ex: hack down --project <name>).",
    [
      "- Or disconnect the container: docker network disconnect",
      `${DEFAULT_INGRESS_NETWORK} <container>.`,
    ].join(" "),
    "- Then run: hack global up (before hack up after reboot)."
  );

  return lines.join("\n");
}

function trimShellError(opts: { readonly text: string }): string {
  const trimmed = opts.text.trim();
  return trimmed.length > 0 ? trimmed : "(no stderr output)";
}

async function globalDown(): Promise<number> {
  const slimExit = failIfSlimMode({
    feature: "hack global down",
  });
  if (slimExit !== null) {
    return slimExit;
  }

  await ensureDockerRunning();
  const paths = getGlobalPaths();

  if (await pathExists(paths.loggingCompose)) {
    await run(["docker", "compose", "-f", paths.loggingCompose, "down"], {
      cwd: dirname(paths.loggingCompose),
    });
  }
  if (await pathExists(paths.caddyCompose)) {
    await withIngressChange(paths.root, async () => {
      await run(["docker", "compose", "-f", paths.caddyCompose, "down"], {
        cwd: dirname(paths.caddyCompose),
      });
    });
  }
  const remoteRoutes = await stopRemoteCaddyRoutesStack();
  if (remoteRoutes.status === "failed") {
    logger.warn({
      message: `Unable to stop remote route bridge during shutdown: ${remoteRoutes.error}`,
    });
  }

  if (isLinux()) {
    await offerLinuxGlobalDnsRemoval();
  }

  if (isMac()) {
    const ok = await confirmSafe({
      message: `Stop dnsmasq? (disables *.${DEFAULT_PROJECT_TLD}, *.${DEFAULT_NEW_PROJECT_TLD} and *.${DEFAULT_OAUTH_ALIAS_ROOT} DNS; requires sudo)`,
      initialValue: false,
      nonInteractive: "accept-default",
    });
    if (ok) {
      logger.step({ message: "Stopping dnsmasq (requires sudo)…" });
      if (await pathExists(MAC_DNS_RECOVERY_HELPER_PATH)) {
        const helperExit = await runMacPrivilegedCommand({
          command: [MAC_DNS_RECOVERY_HELPER_PATH, "stop-dnsmasq"],
          interactive: isInteractiveTerminal(),
        });
        if (helperExit === 0) {
          logger.success({ message: "Global infra is down" });
          return 0;
        }
      }

      const brew = await resolveBrewPath();
      if (brew) {
        await runMacPrivilegedCommand({
          command: [brew, "services", "stop", "dnsmasq"],
          interactive: isInteractiveTerminal(),
        });
      } else {
        logger.warn({
          message: "Homebrew not found; skipping dnsmasq shutdown",
        });
      }
    }
  }

  logger.success({ message: "Global infra is down" });
  return 0;
}

async function runMacPrivilegedCommand(opts: {
  readonly command: readonly string[];
  readonly interactive: boolean;
}): Promise<number> {
  return await executeMacPrivilegedCommand(opts);
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true;
}

async function resolveBrewPath(): Promise<string | null> {
  return await findExecutableInPath("brew");
}

async function restartMacDnsmasq(): Promise<void> {
  const brew = await resolveBrewPath();
  const commands = macRestartCommands({
    brew,
    helperPath: MAC_DNS_RECOVERY_HELPER_PATH,
    helperInstalled: await pathExists(MAC_DNS_RECOVERY_HELPER_PATH),
  });
  if (commands.length === 0) {
    throw new Error("Homebrew not found; cannot restart dnsmasq");
  }
  for (const [index, command] of commands.entries()) {
    const exit = await runMacPrivilegedCommand({
      command,
      interactive: isInteractiveTerminal(),
    });
    if (exit === 0) {
      return;
    }
    if (index === commands.length - 1) {
      throw new Error(`sudo ${command.join(" ")} failed (exit ${exit})`);
    }
  }
}

async function flushMacDnsCachePrivileged(): Promise<void> {
  for (const command of macFlushCommands({
    helperPath: MAC_DNS_RECOVERY_HELPER_PATH,
    helperInstalled: await pathExists(MAC_DNS_RECOVERY_HELPER_PATH),
  })) {
    const exit = await runMacPrivilegedCommand({
      command,
      interactive: isInteractiveTerminal(),
    });
    if (exit !== 0) {
      throw new Error(`sudo ${command.join(" ")} failed (exit ${exit})`);
    }
  }
}

async function handleGlobalStatus({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: GlobalStatusArgs;
}): Promise<number> {
  if (args.options.observe === true) {
    if (args.options.json !== true) {
      logger.error({
        message:
          "--observe prints JSON only: run hack global status --json --observe",
      });
      return 2;
    }
    return await globalStatusObserve();
  }
  return await globalStatus({ json: args.options.json ?? false });
}

/**
 * `hack global status --json --observe`: never starts anything (see
 * global-status-observe.ts). Not gated by slim mode: it starts nothing.
 */
async function globalStatusObserve(): Promise<number> {
  const paths = getGlobalPaths();
  const payload = await observeGlobalStatus({
    platform: process.platform,
    dockerInstalled: () => findExecutableInPath("docker") !== null,
    probeDocker: async () =>
      await exec(["docker", "info", "--format", "{{.ServerVersion}}"], {
        stdin: "ignore",
        timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
      }),
    readCaddy: async () =>
      await observeComposeStack({ composeFile: paths.caddyCompose }),
    readLogging: async () =>
      (await resolveGlobalLogging({ loggingCompose: paths.loggingCompose }))
        .enabled
        ? await observeComposeStack({ composeFile: paths.loggingCompose })
        : await loggingOffStatus({ timeoutMs: DOCKER_READ_TIMEOUT_MS }),
    readNetworks: async () =>
      await observeNetworks({
        names: [DEFAULT_INGRESS_NETWORK, DEFAULT_LOGGING_NETWORK],
      }),
    readProxyNetwork: async () =>
      await observeProxyNetwork({ composeFile: paths.caddyCompose }),
    caddyIp: async () =>
      await observeGlobalCaddyIp({ timeoutMs: DOCKER_READ_TIMEOUT_MS }),
    inspectLinuxDns: async () => {
      // A config that cannot be read throws here: host DNS is then unknown.
      const domains = managedLocalDomains(await resolveDefaultDomainStrictly());
      const unreadable: string[] = [];
      const inspection = await inspectLinuxGlobalDns({
        domains,
        host: createLinuxDnsHost({
          onUnreadable: (what) => unreadable.push(what),
        }),
      });
      return { inspection, unreadable };
    },
    macDomains: async () =>
      managedLocalDomains(await resolveDefaultDomainStrictly()),
    observeMacDns: observeMacHostDns,
    now: () => new Date(),
  });
  emitCliResult({
    result: machineSuccess({
      schema: MACHINE_SCHEMAS.globalStatusObserve,
      data: payload,
    }),
  });
  return 0;
}

async function globalStatus(opts: { readonly json: boolean }): Promise<number> {
  const slimExit = failIfSlimMode({
    feature: "hack global status",
  });
  if (slimExit !== null) {
    return slimExit;
  }

  await ensureDockerRunning();
  const paths = getGlobalPaths();
  const loggingSetting = await resolveGlobalLogging({
    loggingCompose: paths.loggingCompose,
  });

  if (opts.json) {
    const [caddy, logging, networks, gateway, proxyIssues, hostDns] =
      await Promise.all([
        readComposeStatus(paths.caddyCompose),
        loggingSetting.enabled
          ? readComposeStatus(paths.loggingCompose)
          : loggingOffStatus(),
        readNetworksStatus([DEFAULT_INGRESS_NETWORK, DEFAULT_LOGGING_NETWORK]),
        collectGatewayStatus(),
        inspectProxyNetwork({ composeFile: paths.caddyCompose }),
        readLinuxHostDnsStatus(),
      ]);
    const proxyNetwork = proxyNetworkStatusPayload(proxyIssues);
    // Unknown (Docker unreadable) does not fail the summary; real issues do.
    const proxyNetworkOk = proxyNetwork.ok !== false;
    const summary = {
      caddy_ok: caddy.ok,
      logging_ok: logging.ok,
      networks_ok: networks.ok,
      proxy_network_ok: proxyNetwork.ok,
      gateway_enabled: gateway.gateway_enabled,
      ...(hostDns === null
        ? {}
        : { host_dns_ok: hostDns.state === "configured" }),
      ok: caddy.ok && logging.ok && networks.ok && proxyNetworkOk,
    };
    const payload = {
      generated_at: new Date().toISOString(),
      caddy,
      proxy_network: proxyNetwork,
      logging,
      networks,
      gateway,
      ...(hostDns === null ? {} : { host_dns: hostDns }),
      summary,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  await display.section("Caddy");
  await renderComposeStatusTable(paths.caddyCompose);
  const proxyIssues = await inspectProxyNetwork({
    composeFile: paths.caddyCompose,
  });
  if (proxyIssues && proxyIssues.length > 0) {
    await display.panel({
      title: "Proxy network",
      tone: "warn",
      lines: [
        ...proxyIssues.map(describeProxyNetworkIssue),
        "Fix: hack global up (recreates the proxy stack)",
      ],
    });
  }

  await display.section("Logging");
  if (loggingSetting.enabled) {
    await renderComposeStatusTable(paths.loggingCompose);
  } else {
    const off = await loggingOffStatus();
    process.stdout.write(
      `${off.error ?? "Off (opt-in)."} Turn it on with: ${LOGGING_ENABLE_COMMAND}\n`
    );
  }

  await display.section("Networks");
  await renderNetworksTable([DEFAULT_INGRESS_NETWORK, DEFAULT_LOGGING_NETWORK]);

  await display.section("Gateway");
  await renderGatewayStatus();

  const hostDns = await readLinuxHostDnsStatus();
  if (hostDns) {
    await display.section("Host DNS");
    await display.panel({
      title: `Linux DNS (${hostDns.resolver})`,
      tone: hostDns.state === "configured" ? "success" : "warn",
      lines: [
        hostDns.code
          ? `${hostDns.message} (code=${hostDns.code})`
          : hostDns.message,
        ...hostDns.fix.map((line) => `fix: ${line}`),
      ],
    });
  }

  return 0;
}

/** Linux host DNS route, or `null` on other platforms. */
async function readLinuxHostDnsStatus(): Promise<ReturnType<
  typeof linuxDnsStatusPayload
> | null> {
  if (!isLinux()) {
    return null;
  }
  return linuxDnsStatusPayload(await inspectLinuxGlobalDns());
}

type ComposeServiceStatus = {
  readonly service: string;
  readonly name: string;
  readonly status: string;
  readonly ports: string;
};

/**
 * The running containers of this home's logging stack: Compose project
 * `hack-logging` whose recorded working directory is this home's logging
 * directory (as written, or with symlinks resolved), so another Hack home on
 * the same engine is never touched. Null when Docker could not be asked.
 * Found by labels, so they are found even when the compose file is gone.
 */
async function thisHomeLoggingContainers(opts: {
  readonly loggingDir: string;
  readonly timeoutMs?: number;
}): Promise<string[] | null> {
  const found = await exec(
    [
      "docker",
      "ps",
      "--filter",
      `label=com.docker.compose.project=${GLOBAL_LOGGING_PROJECT_NAME}`,
      "--format",
      '{{.ID}}\t{{.Label "com.docker.compose.project.working_dir"}}',
    ],
    { stdin: "ignore", timeoutMs: opts.timeoutMs }
  ).catch(() => null);
  if (!found || found.exitCode !== 0) {
    return null;
  }
  const dirs = new Set([
    opts.loggingDir,
    await realpath(opts.loggingDir).catch(() => opts.loggingDir),
  ]);
  return found.stdout
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(
      ([id, dir]) => Boolean(id) && dir !== undefined && dirs.has(dir.trim())
    )
    .map(([id]) => (id ?? "").trim());
}

/**
 * Status of the logging stack while it is off. Docker is still asked: after
 * `hack config set --global logging.enabled false` and before the next
 * `hack global up`, its containers may still run, which is not "off".
 */
async function loggingOffStatus(opts?: {
  readonly timeoutMs?: number;
}): Promise<{
  readonly ok: boolean | "unknown";
  readonly enabled: false;
  readonly error: string | null;
  readonly services: readonly [];
}> {
  const ids = await thisHomeLoggingContainers({
    loggingDir: dirname(getGlobalPaths().loggingCompose),
    timeoutMs: opts?.timeoutMs,
  });
  if (ids === null) {
    return {
      ok: "unknown",
      enabled: false,
      error: "Could not ask Docker for the logging stack's containers",
      services: [],
    };
  }
  const running = ids.length;
  return running === 0
    ? { ok: true, enabled: false, error: null, services: [] }
    : {
        ok: false,
        enabled: false,
        error: `Logging is off, but ${running} logging container${running === 1 ? " is" : "s are"} still running. Stop ${running === 1 ? "it" : "them"} with: hack global up`,
        services: [],
      };
}

type ComposeStatusGroup = {
  readonly ok: boolean;
  /** `false` only for the logging stack while it is turned off (opt-in). */
  readonly enabled?: false;
  readonly error: string | null;
  readonly services: readonly ComposeServiceStatus[];
};

type NetworkStatus = {
  readonly name: string;
  readonly id: string;
  readonly driver: string;
  readonly scope: string;
};

type NetworkStatusGroup = {
  readonly ok: boolean;
  readonly missing: readonly string[];
  readonly networks: readonly NetworkStatus[];
};

type GatewayExposureState =
  | "disabled"
  | "needs_config"
  | "configured"
  | "running"
  | "blocked"
  | "unknown";

type GatewayExposurePayload = {
  readonly id: string;
  readonly label: string;
  readonly state: GatewayExposureState;
  readonly enabled: boolean;
  readonly detail?: string;
  readonly url?: string;
};

type GatewayStatusPayload = {
  readonly config_path: string;
  readonly gateway_url: string;
  readonly gateway_bind: string;
  readonly gateway_port: number;
  readonly allow_writes: boolean;
  readonly gateway_enabled: boolean;
  readonly gateway_projects_enabled: number;
  readonly tokens_active: number;
  readonly tokens_revoked: number;
  readonly tokens_write: number;
  readonly tokens_read: number;
  readonly tokens: readonly GatewayTokenPayload[];
  readonly gateway_projects?: string;
  readonly exposures: readonly GatewayExposurePayload[];
  readonly warnings: readonly string[];
};

type GatewayTokenPayload = {
  readonly id: string;
  readonly scope: "read" | "write";
  readonly label?: string;
  readonly created_at: string;
  readonly last_used_at?: string;
  readonly revoked_at?: string;
};

async function readComposeStatus(
  composeFile: string
): Promise<ComposeStatusGroup> {
  const res = await exec(
    ["docker", "compose", "-f", composeFile, "ps", "--format", "json"],
    {
      cwd: dirname(composeFile),
      stdin: "ignore",
    }
  );

  if (res.exitCode !== 0) {
    return {
      ok: false,
      error: `Failed to read status for ${composeFile}`,
      services: [],
    };
  }

  const entries = parseJsonLines(res.stdout);
  const services = entries.map((entry) => ({
    service: getString(entry, "Service") ?? "",
    name: getString(entry, "Name") ?? "",
    status: getString(entry, "Status") ?? "",
    ports: getString(entry, "Ports") ?? "",
  }));
  const ok =
    services.length > 0 &&
    services.every((service) => isServiceRunning(service.status));
  return { ok, error: null, services };
}

async function readNetworksStatus(
  names: readonly string[]
): Promise<NetworkStatusGroup> {
  const res = await exec(["docker", "network", "ls", "--format", "json"], {
    stdin: "ignore",
  });
  if (res.exitCode !== 0) {
    return { ok: false, missing: [...names], networks: [] };
  }

  const entries = parseJsonLines(res.stdout);
  const networks = entries
    .map((entry) => ({
      name: getString(entry, "Name") ?? "",
      id: getString(entry, "ID") ?? "",
      driver: getString(entry, "Driver") ?? "",
      scope: getString(entry, "Scope") ?? "",
    }))
    .filter((entry) => entry.name.length > 0 && names.includes(entry.name));

  const present = new Set(networks.map((network) => network.name));
  const missing = names.filter((name) => !present.has(name));
  return { ok: missing.length === 0, missing, networks };
}

async function collectGatewayStatus(): Promise<GatewayStatusPayload> {
  const gatewayResolution = await resolveGatewayConfig();
  const configPath = resolveGlobalConfigPath();
  const gatewayUrl = buildGatewayUrl({
    bind: gatewayResolution.config.bind,
    port: gatewayResolution.config.port,
  });
  const daemonPaths = resolveDaemonPaths({});
  const daemonStatus = await readDaemonStatus({ paths: daemonPaths });
  const controlPlane = await readControlPlaneConfig({});
  const exposures = await resolveGatewayExposures({
    controlPlane: controlPlane.config,
    gatewayEnabled: gatewayResolution.config.enabled,
    gatewayBind: gatewayResolution.config.bind,
    gatewayUrl,
    daemonRunning: daemonStatus.running,
  });

  const { tokens, untrusted: untrustedTokenStore } =
    await listGatewayTokensForStatus({ rootDir: daemonPaths.root });
  const activeTokens = tokens.filter((token) => !token.revokedAt);
  const revokedTokens = tokens.filter((token) => token.revokedAt);
  const writeTokens = activeTokens.filter((token) => token.scope === "write");
  const readTokens = activeTokens.filter((token) => token.scope === "read");
  const serializedTokens: GatewayTokenPayload[] = tokens.map((token) => ({
    id: token.id,
    scope: token.scope,
    ...(token.label ? { label: token.label } : {}),
    created_at: token.createdAt,
    ...(token.lastUsedAt ? { last_used_at: token.lastUsedAt } : {}),
    ...(token.revokedAt ? { revoked_at: token.revokedAt } : {}),
  }));

  const payload: GatewayStatusPayload = {
    config_path: configPath,
    gateway_url: gatewayUrl,
    gateway_bind: gatewayResolution.config.bind,
    gateway_port: gatewayResolution.config.port,
    allow_writes: gatewayResolution.config.allowWrites,
    gateway_enabled: gatewayResolution.config.enabled,
    gateway_projects_enabled: gatewayResolution.enabledProjects.length,
    tokens_active: activeTokens.length,
    tokens_revoked: revokedTokens.length,
    tokens_write: writeTokens.length,
    tokens_read: readTokens.length,
    tokens: serializedTokens,
    exposures,
    warnings:
      untrustedTokenStore === null
        ? gatewayResolution.warnings
        : [...gatewayResolution.warnings, untrustedTokenStore],
  };

  if (gatewayResolution.enabledProjects.length > 0) {
    const projects = gatewayResolution.enabledProjects.map(
      (project) => `${project.projectName} (${project.projectId})`
    );
    return { ...payload, gateway_projects: projects.join(", ") };
  }

  return payload;
}

async function resolveGatewayExposures(opts: {
  readonly controlPlane: ControlPlaneConfig;
  readonly gatewayEnabled: boolean;
  readonly gatewayBind: string;
  readonly gatewayUrl: string;
  readonly daemonRunning: boolean;
}): Promise<GatewayExposurePayload[]> {
  const exposures: GatewayExposurePayload[] = [];
  exposures.push(resolveLanExposure(opts));
  exposures.push(await resolveTailscaleExposure(opts));
  exposures.push(await resolveCloudflareExposure(opts));
  return exposures;
}

function resolveLanExposure(opts: {
  readonly gatewayEnabled: boolean;
  readonly gatewayBind: string;
  readonly gatewayUrl: string;
  readonly daemonRunning: boolean;
}): GatewayExposurePayload {
  const blocked = resolveGatewayBlockReason({
    ...opts,
    requiresPublicBind: true,
  });
  if (blocked) {
    return buildGatewayExposure({
      id: "lan",
      label: "Local network",
      state: "blocked",
      detail: blocked,
    });
  }

  return buildGatewayExposure({
    id: "lan",
    label: "Local network",
    state: "running",
    detail: `Bind ${opts.gatewayBind}`,
    url: opts.gatewayUrl,
  });
}

async function resolveTailscaleExposure(opts: {
  readonly controlPlane: ControlPlaneConfig;
  readonly gatewayEnabled: boolean;
  readonly gatewayBind: string;
  readonly gatewayUrl: string;
  readonly daemonRunning: boolean;
}): Promise<GatewayExposurePayload> {
  const extensionEnabled = readExtensionEnabled(
    opts.controlPlane,
    "dance.hack.tailscale"
  );
  if (!extensionEnabled) {
    return buildGatewayExposure({
      id: "tailscale",
      label: "Tailscale",
      state: "disabled",
      detail: "Extension disabled",
    });
  }

  const blocked = resolveGatewayBlockReason({
    ...opts,
    requiresPublicBind: true,
  });
  if (blocked) {
    return buildGatewayExposure({
      id: "tailscale",
      label: "Tailscale",
      state: "blocked",
      detail: blocked,
    });
  }

  const tailscalePath = await findExecutableInPath("tailscale");
  if (!tailscalePath) {
    return buildGatewayExposure({
      id: "tailscale",
      label: "Tailscale",
      state: "needs_config",
      detail: "tailscale not installed",
    });
  }

  const status = await readTailscaleStatus();
  if (!status.ok) {
    return buildGatewayExposure({
      id: "tailscale",
      label: "Tailscale",
      state: "unknown",
      detail: status.error,
    });
  }

  const backendState = status.backendState ?? "offline";
  const isLoginRequired = backendState.toLowerCase() === "needslogin";
  const url =
    status.ip && status.running
      ? resolveGatewayUrlForHost({
          gatewayUrl: opts.gatewayUrl,
          host: status.ip,
        })
      : undefined;
  const detail = resolveTailscaleDetail({
    running: status.running,
    ip: status.ip,
    backendState,
  });

  if (status.running) {
    return buildGatewayExposure({
      id: "tailscale",
      label: "Tailscale",
      state: "running",
      detail,
      ...(url ? { url } : {}),
    });
  }

  if (isLoginRequired) {
    return buildGatewayExposure({
      id: "tailscale",
      label: "Tailscale",
      state: "needs_config",
      detail: "Needs login",
    });
  }

  return buildGatewayExposure({
    id: "tailscale",
    label: "Tailscale",
    state: "configured",
    detail,
  });
}

async function resolveCloudflareExposure(opts: {
  readonly controlPlane: ControlPlaneConfig;
  readonly gatewayEnabled: boolean;
  readonly gatewayBind: string;
  readonly daemonRunning: boolean;
}): Promise<GatewayExposurePayload> {
  const extensionEnabled = readExtensionEnabled(
    opts.controlPlane,
    "dance.hack.cloudflare"
  );
  if (!extensionEnabled) {
    return buildGatewayExposure({
      id: "cloudflare",
      label: "Cloudflare",
      state: "disabled",
      detail: "Extension disabled",
    });
  }

  const cloudflareConfig = readExtensionConfig(
    opts.controlPlane,
    "dance.hack.cloudflare"
  );
  const cloudflareHostname = cloudflareConfig
    ? getString(cloudflareConfig, "hostname")
    : null;
  const cloudflareTunnel = cloudflareConfig
    ? getString(cloudflareConfig, "tunnel")
    : null;
  const cloudflareConfigured = Boolean(cloudflareHostname || cloudflareTunnel);
  if (!cloudflareConfigured) {
    return buildGatewayExposure({
      id: "cloudflare",
      label: "Cloudflare",
      state: "needs_config",
      detail: "Missing hostname",
    });
  }

  const blocked = resolveGatewayBlockReason({
    ...opts,
    requiresPublicBind: false,
  });
  if (blocked) {
    return buildGatewayExposure({
      id: "cloudflare",
      label: "Cloudflare",
      state: "blocked",
      detail: blocked,
    });
  }

  const cloudflaredPath = await findExecutableInPath("cloudflared");
  if (!cloudflaredPath) {
    return buildGatewayExposure({
      id: "cloudflare",
      label: "Cloudflare",
      state: "needs_config",
      detail: "cloudflared not installed",
    });
  }

  const pid = await readCloudflaredPid();
  const running = pid !== null && isProcessRunning({ pid });
  const detail = resolveCloudflareDetail({
    cloudflareHostname: cloudflareHostname ?? null,
    cloudflareTunnel: cloudflareTunnel ?? null,
  });
  const url = cloudflareHostname ? `https://${cloudflareHostname}` : undefined;

  if (running) {
    return buildGatewayExposure({
      id: "cloudflare",
      label: "Cloudflare",
      state: "running",
      detail,
      ...(url ? { url } : {}),
    });
  }

  return buildGatewayExposure({
    id: "cloudflare",
    label: "Cloudflare",
    state: "configured",
    detail: `${detail} (cloudflared not running)`,
    ...(url ? { url } : {}),
  });
}

function resolveTailscaleDetail(opts: {
  readonly running: boolean;
  readonly ip: string | undefined;
  readonly backendState: string;
}): string {
  if (!opts.running) {
    return `Backend ${opts.backendState}`;
  }
  if (opts.ip) {
    return `Tailnet IP ${opts.ip}`;
  }
  return "Tailnet connected";
}

function resolveCloudflareDetail(opts: {
  readonly cloudflareHostname: string | null;
  readonly cloudflareTunnel: string | null;
}): string {
  if (opts.cloudflareHostname) {
    return `Hostname ${opts.cloudflareHostname}`;
  }
  if (opts.cloudflareTunnel) {
    return `Tunnel ${opts.cloudflareTunnel}`;
  }
  return "Configured";
}

function resolveGatewayBlockReason(opts: {
  readonly gatewayEnabled: boolean;
  readonly gatewayBind: string;
  readonly daemonRunning: boolean;
  readonly requiresPublicBind: boolean;
}): string | null {
  if (!opts.gatewayEnabled) {
    return "Gateway disabled";
  }
  if (!opts.daemonRunning) {
    return "hackd not running";
  }
  if (opts.requiresPublicBind && isLoopbackAddress(opts.gatewayBind)) {
    return "Bind is loopback";
  }
  return null;
}

function buildGatewayExposure(
  payload: Omit<GatewayExposurePayload, "enabled">
): GatewayExposurePayload {
  return {
    ...payload,
    enabled: payload.state === "configured" || payload.state === "running",
  };
}

async function readTailscaleStatus(): Promise<
  | {
      readonly ok: true;
      readonly running: boolean;
      readonly backendState?: string;
      readonly hostname?: string;
      readonly ip?: string;
    }
  | { readonly ok: false; readonly error: string }
> {
  const res = await exec(["tailscale", "status", "--json"], {
    stdin: "ignore",
  });
  if (res.exitCode !== 0) {
    return { ok: false, error: "tailscale status failed" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return { ok: false, error: "tailscale status returned invalid JSON" };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: "tailscale status returned invalid JSON" };
  }

  const backendState = getString(parsed, "BackendState") ?? undefined;
  const self = isRecord(parsed.Self) ? parsed.Self : null;
  const hostname = self
    ? (getString(self, "HostName") ?? undefined)
    : undefined;
  const online = self ? self.Online === true : false;
  let ip: string | undefined;
  if (self) {
    const ips = self.TailscaleIPs;
    if (Array.isArray(ips)) {
      for (const value of ips) {
        if (typeof value === "string" && value.length > 0) {
          ip = value;
          break;
        }
      }
    }
  }

  const running = online || backendState === "Running";
  return { ok: true, running, backendState, hostname, ip };
}

async function readCloudflaredPid(): Promise<number | null> {
  const pidPath = resolve(
    resolveGlobalHackDir(),
    GLOBAL_CLOUDFLARE_DIR_NAME,
    "cloudflared.pid"
  );
  const text = await readTextFile(pidPath);
  if (!text) {
    return null;
  }
  const value = Number.parseInt(text.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

function resolveGatewayUrlForHost(opts: {
  readonly gatewayUrl: string;
  readonly host: string;
}): string | undefined {
  try {
    const url = new URL(opts.gatewayUrl);
    url.hostname = opts.host;
    return url.toString();
  } catch {
    return undefined;
  }
}

function readExtensionEnabled(
  controlPlane: ControlPlaneConfig,
  extensionId: string
): boolean {
  const raw = controlPlane.extensions?.[extensionId];
  if (!(raw && isRecord(raw))) {
    return false;
  }
  return raw.enabled === true;
}

function readExtensionConfig(
  controlPlane: ControlPlaneConfig,
  extensionId: string
): Record<string, unknown> | null {
  const raw = controlPlane.extensions?.[extensionId];
  if (!(raw && isRecord(raw))) {
    return null;
  }
  const config = raw.config;
  if (!(config && isRecord(config))) {
    return null;
  }
  return config;
}

function isLoopbackAddress(bind: string): boolean {
  const normalized = bind.trim().toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  ) {
    return true;
  }
  return normalized.startsWith("127.");
}

async function renderComposeStatusTable(composeFile: string): Promise<void> {
  const res = await exec(
    ["docker", "compose", "-f", composeFile, "ps", "--format", "json"],
    {
      cwd: dirname(composeFile),
      stdin: "ignore",
    }
  );

  if (res.exitCode !== 0) {
    // Not a "log", but do show something actionable.
    process.stdout.write(`Failed to read status for ${composeFile}\n`);
    return;
  }

  const entries = parseJsonLines(res.stdout);
  const rows = entries.map((e) => [
    getString(e, "Service") ?? "",
    getString(e, "Name") ?? "",
    getString(e, "Status") ?? "",
    getString(e, "Ports") ?? "",
  ]);

  await display.table({
    columns: ["SERVICE", "NAME", "STATUS", "PORTS"],
    rows,
  });
}

async function renderNetworksTable(names: readonly string[]): Promise<void> {
  const res = await exec(["docker", "network", "ls", "--format", "json"], {
    stdin: "ignore",
  });
  if (res.exitCode !== 0) {
    process.stdout.write("Failed to list docker networks\n");
    return;
  }

  const entries = parseJsonLines(res.stdout).filter((e) => {
    const name = getString(e, "Name");
    return typeof name === "string" && names.includes(name);
  });

  const rows = entries.map((e) => [
    getString(e, "Name") ?? "",
    getString(e, "ID") ?? "",
    getString(e, "Driver") ?? "",
    getString(e, "Scope") ?? "",
  ]);

  await display.table({
    columns: ["NAME", "ID", "DRIVER", "SCOPE"],
    rows,
  });
}

async function renderGatewayStatus(): Promise<void> {
  const payload = await collectGatewayStatus();

  const entries: Array<readonly [string, string | number | boolean]> = [
    ["config_path", payload.config_path],
    ["gateway_url", payload.gateway_url],
    ["gateway_bind", payload.gateway_bind],
    ["gateway_port", payload.gateway_port],
    ["allow_writes", payload.allow_writes],
    ["gateway_enabled", payload.gateway_enabled],
    ["gateway_projects_enabled", payload.gateway_projects_enabled],
    ["tokens_active", payload.tokens_active],
    ["tokens_revoked", payload.tokens_revoked],
    ["tokens_write", payload.tokens_write],
    ["tokens_read", payload.tokens_read],
  ];

  if (payload.gateway_projects) {
    entries.push(["gateway_projects", payload.gateway_projects]);
  }

  await display.kv({ entries });

  if (payload.warnings.length > 0) {
    await display.panel({
      title: "Gateway warnings",
      tone: "warn",
      lines: payload.warnings,
    });
  }

  await display.panel({
    title: "Gateway tokens",
    tone: "info",
    lines: [
      "List: hack x gateway token-list",
      "Revoke: hack x gateway token-revoke <token-id>",
    ],
  });
}

function buildGatewayUrl(opts: {
  readonly bind: string;
  readonly port: number;
}): string {
  const host = opts.bind.includes(":") ? `[${opts.bind}]` : opts.bind;
  return `http://${host}:${opts.port}`;
}

/**
 * Print an admin plan as JSON. Exit 0 for a complete plan, 1 when the real
 * command would refuse, 3 when a later phase cannot be known yet.
 */
async function printAdminPlan(opts: {
  readonly json: boolean;
  readonly build: () => Promise<AdminPlan>;
}): Promise<number> {
  if (!opts.json) {
    logger.error({ message: "--plan prints JSON only: add --json" });
    return 2;
  }
  const result = await opts.build();
  if (result.refused !== null) {
    emitCliResult({
      result: errorResult({
        code: "E_PLAN_REFUSED",
        message: result.refused,
        detail: { plan: result },
      }),
    });
    return 1;
  }
  if (!result.complete) {
    emitCliResult({
      result: errorResult({
        code: "E_PLAN_INCOMPLETE",
        message:
          "Administrator plan is incomplete; inspect error.detail.plan.blocked before proceeding.",
        detail: { plan: result },
      }),
    });
    return 3;
  }
  emitCliResult({
    result: machineSuccess({
      schema: MACHINE_SCHEMAS.globalAdminPlan,
      data: result,
    }),
  });
  return 0;
}

/** Install's read-only snapshot. Never enter the mutating install handler. */
async function buildGlobalInstallPlan(): Promise<AdminPlan> {
  let unreadableLinux = false;
  const domains = managedLocalDomains(await resolveDefaultDomain());
  return await planGlobalInstall({
    platform: process.platform,
    refusal: () => {
      if (resolveNativeRuntimeSelection()) {
        return "Native global DNS/TLS installation needs a scoped host-domain plan; hack global install refuses on the native runtime";
      }
      return isSlimExecutionMode()
        ? "hack global install is unavailable in slim mode"
        : null;
    },
    preflight: async () => {
      const deadline = Date.now() + DOCKER_PROBE_TIMEOUT_MS;
      try {
        await withProcessDeadline(deadline, preflightCustomDomainDnsClaim);
        return Date.now() >= deadline
          ? {
              unresolved:
                "The host-domain ownership probe exceeded its read-only deadline",
            }
          : null;
      } catch (error) {
        if (Date.now() >= deadline) {
          return {
            unresolved:
              "The host-domain ownership probe exceeded its read-only deadline",
          };
        }
        return error instanceof Error
          ? error.message
          : "Custom-domain preflight failed";
      }
    },
    domains,
    dockerStartup: async () => {
      const result = await exec(["docker", "info"], {
        stdin: "ignore",
        timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
      }).catch(() => null);
      const reachable = classifyDockerInfo(result);
      return {
        reachable,
        backend: reachable === false ? await detectDockerBackend() : null,
      };
    },
    useStaticIps: async () => {
      const inspected = await exec(
        ["docker", "network", "inspect", DEFAULT_INGRESS_NETWORK],
        { stdin: "ignore", timeoutMs: DOCKER_PROBE_TIMEOUT_MS }
      ).catch(() => null);
      return inspected?.exitCode === 0
        ? networkHasSubnet(inspected.stdout, DEFAULT_INGRESS_SUBNET)
        : "unknown";
    },
    ...(isLinux()
      ? {
          linuxHost: createLinuxDnsHost({
            onUnreadable: () => {
              unreadableLinux = true;
            },
          }),
        }
      : {}),
    unreadableLinux: () => unreadableLinux,
    sudoPath: resolveTrustedSudo,
    macSnapshot: async () => await readMacInstallSnapshot(domains),
    trust: async () => await planGlobalInstallTrust(trustPlanDeps()),
  });
}

async function readMacInstallSnapshot(
  domains: readonly string[]
): Promise<MacInstallSnapshot> {
  const brew = await resolveBrewPath();
  const probe = async (argv: readonly string[]) =>
    await exec(argv, {
      stdin: "ignore",
      timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
    }).catch(() => null);
  const formula = brew ? await probe(["brew", "list", "dnsmasq"]) : null;
  const installed =
    formula === null || formula.exitCode === 124 || formula.exitCode === 127
      ? "unknown"
      : formula.exitCode === 0;
  const services =
    brew && installed === true
      ? await probe(["brew", "services", "list"])
      : null;
  const resolverDomains: string[] = [];
  const builtInDomains: ReadonlySet<string> = new Set([
    DEFAULT_PROJECT_TLD,
    DEFAULT_NEW_PROJECT_TLD,
    DEFAULT_OAUTH_ALIAS_ROOT,
  ]);
  for (const domain of domains) {
    if (
      builtInDomains.has(domain) ||
      (await readTextFile(`/etc/resolver/${domain}`)) === null
    ) {
      resolverDomains.push(domain);
    }
  }
  const recovery = await readMacAuthorizationSnapshot(brew);
  return {
    brew,
    dnsmasqInstalled: brew ? installed : false,
    services: services?.exitCode === 0 ? services.stdout : null,
    helperPath: MAC_DNS_RECOVERY_HELPER_PATH,
    helperInstalled: await pathExists(MAC_DNS_RECOVERY_HELPER_PATH),
    resolverDomains,
    ...recovery,
  };
}

async function readMacAuthorizationSnapshot(
  brew: string | null
): Promise<
  Pick<
    MacInstallSnapshot,
    "authorization" | "authorizationRefusal" | "authorizationUnknown"
  >
> {
  const probe = async (argv: readonly string[]) =>
    await exec(argv, {
      stdin: "ignore",
      timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
    }).catch(() => null);
  let authorization: MacInstallSnapshot["authorization"] = null;
  let authorizationRefusal: string | null = null;
  let authorizationUnknown = false;
  if (!(await pathExists(MAC_DNS_SUDOERS_PATH))) {
    const user = brew ? await probe(["id", "-un"]) : null;
    if (
      brew &&
      (user === null || user.exitCode === 124 || user.exitCode === 127)
    ) {
      authorizationUnknown = true;
    }
    if (!brew || user?.exitCode !== 0 || !user.stdout.trim()) {
      authorizationRefusal =
        "Recovery authorization cannot run without Homebrew and a readable current username";
    } else if (
      await verifyMacRootControlledPaths(
        [
          dirname(dirname(MAC_DNS_RECOVERY_HELPER_PATH)),
          dirname(MAC_DNS_RECOVERY_HELPER_PATH),
        ],
        {
          allowMissingPaths: [dirname(MAC_DNS_RECOVERY_HELPER_PATH)],
          timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
          quiet: true,
          onUnreadable: () => {
            authorizationUnknown = true;
          },
        }
      )
    ) {
      const tempDir = resolve(getGlobalPaths().root, "tmp");
      authorization = {
        helperPath: MAC_DNS_RECOVERY_HELPER_PATH,
        helperTempPath: resolve(tempDir, MAC_DNS_RECOVERY_HELPER_TEMP_FILENAME),
        sudoersPath: MAC_DNS_SUDOERS_PATH,
        sudoersTempPath: resolve(tempDir, MAC_DNS_SUDOERS_TEMP_FILENAME),
        visudo: (await findExecutableInPath("visudo")) ?? "/usr/sbin/visudo",
      };
    } else {
      authorizationRefusal =
        "Recovery authorization refuses insecure helper parent directories";
    }
  }
  return { authorization, authorizationRefusal, authorizationUnknown };
}

/** The real `hack global trust` sources, used read-only by its plan. */
function trustPlanDeps(): TrustPlanDeps {
  const certPath = resolveHackLocalCaCertPath();
  const native = resolveNativeRuntimeSelection();
  return {
    platform: process.platform,
    refusal: () => {
      if (native) {
        return "Native trust needs an exact reviewed HTTPS origin; hack global trust refuses on the native runtime";
      }
      return isSlimExecutionMode()
        ? "hack global trust is unavailable in slim mode"
        : null;
    },
    certPath,
    inspectIdentity: async () =>
      await inspectCaddyCaIdentity({
        certPath,
        ...(isLinux() ? { exec: createTrustedDockerExec() } : {}),
      }),
    readExport: async () => await readTextFile(certPath),
    exportReplaceable: async () =>
      await caddyCaExportReplaceable(certPath).catch(() => "unknown" as const),
    ...(isLinux() ? { linuxHost: createLinuxTrustHost() } : {}),
    prepareLinux: prepareLinuxSystemTrust,
    dockerAnswers: async () =>
      classifyDockerInfo(
        await exec(["docker", "info", "--format", "{{.ServerVersion}}"], {
          stdin: "ignore",
          timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
        }).catch(() => null)
      ),
    // The export's own selector (exportCaddyLocalCaCert), read without
    // writing: no single container means the export keeps the current file.
    readExportSource: async () => {
      const composeFile = getGlobalPaths().caddyCompose;
      const ps = await exec(
        ["docker", "compose", "-f", composeFile, "ps", "-q", "caddy"],
        {
          cwd: dirname(composeFile),
          stdin: "ignore",
          timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
        }
      ).catch(() => null);
      if (ps === null || ps.exitCode === 124) {
        return "unknown";
      }
      const id = ps.exitCode === 0 ? ps.stdout.trim() : "";
      if (id.length === 0 || id.includes("\n")) {
        return "none";
      }
      const root = await copyRuntimeRoot({
        id,
        execute: exec,
        timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
      }).catch(() => null);
      return root !== null && "pem" in root ? { pem: root.pem } : "unknown";
    },
    prepareMac: async ({ certPath: path }) =>
      await prepareMacTrustForPlan({
        certPath: path,
        timeoutMs: DOCKER_PROBE_TIMEOUT_MS,
      }),
    explicitlyNonInteractive: isExplicitlyNonInteractive,
  };
}

async function globalTrust(): Promise<number> {
  const native = resolveNativeRuntimeSelection();
  if (native) {
    logger.warn({
      message:
        "Native trust needs an exact reviewed HTTPS origin. Run hack doctor --fix --browser-url https://your-app.hack.local while its native app is running. No Docker-era CA was installed.",
    });
    return 1;
  }
  const slimExit = failIfSlimMode({
    feature: "hack global trust",
  });
  if (slimExit !== null) {
    return slimExit;
  }

  if (!(isMac() || isLinux())) {
    logger.warn({
      message:
        "Trust automation is only implemented for macOS and Linux; export the CA with `hack global ca` and trust it manually.",
    });
    return 0;
  }

  if (isLinux()) {
    return (await configureLinuxTrustFromRuntime({
      certPath: resolveHackLocalCaCertPath(),
      composeFile: getGlobalPaths().caddyCompose,
      configureHostTrust: configureLinuxHostTlsTrust,
    }))
      ? 0
      : 1;
  }

  const existingCertPath = (await pathExists(resolveHackLocalCaCertPath()))
    ? resolveHackLocalCaCertPath()
    : null;
  let certPath = existingCertPath;
  const dockerStatus = await exec(["docker", "info"], { stdin: "ignore" });
  if (dockerStatus.exitCode === 0) {
    certPath = (await exportCaddyLocalCaCert()) ?? certPath;
  } else if (certPath) {
    logger.info({
      message:
        "Docker is not running; using the previously exported Caddy Local CA for trust setup.",
    });
  } else {
    await ensureDockerRunning();
    certPath = (await exportCaddyLocalCaCert()) ?? certPath;
  }
  if (!certPath) {
    return 1;
  }

  if (isMac()) {
    const trustReady = await ensureMacTrustCaddyLocalCa({
      certPath,
    });
    // Host trust env (Bun/Node/curl/git) is independent of the macOS System
    // keychain step, which is what makes the browser trust *.hack. Prepare
    // it regardless so non-interactive runs still get CLI-tool trust even
    // when the keychain step was skipped (declined, or sudo would have
    // prompted for a password with no TTY to answer it).
    if (!(await configureMacHostTlsTrust({ certPath }))) {
      return 1;
    }
    if (!trustReady) {
      note(
        "Host trust env is prepared, but the browser will still show warnings for https://*.hack until the System keychain step runs. Run `hack global trust` interactively to finish it.",
        "TLS"
      );
    }
    return 0;
  }

  const linuxTrustOk = await configureLinuxHostTlsTrust({ certPath });
  return linuxTrustOk ? 0 : 1;
}

async function handleGlobalCa({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: GlobalCaArgs;
}): Promise<number> {
  const slimExit = failIfSlimMode({
    feature: "hack global ca",
  });
  if (slimExit !== null) {
    return slimExit;
  }

  await ensureDockerRunning();
  const certPath = await exportCaddyLocalCaCert();
  if (!certPath) {
    return 1;
  }

  if (args.options.print) {
    const pem = await Bun.file(certPath).text();
    process.stdout.write(pem.endsWith("\n") ? pem : `${pem}\n`);
    return 0;
  }

  process.stdout.write(`${certPath}\n`);
  return 0;
}

async function handleGlobalCert({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: GlobalCertArgs;
}): Promise<number> {
  const slimExit = failIfSlimMode({
    feature: "hack global cert",
  });
  if (slimExit !== null) {
    return slimExit;
  }

  let mkcertPath = await findExecutableInPath("mkcert");
  if (!mkcertPath && isMac()) {
    await ensureMacMkcert();
    mkcertPath = await findExecutableInPath("mkcert");
  }
  if (!mkcertPath) {
    logger.error({
      message:
        "mkcert is not installed. Install it to generate local certs.\nmacOS: brew install mkcert",
    });
    return 1;
  }

  const hosts = args.positionals.hosts
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  if (hosts.length === 0) {
    logger.error({ message: "No hosts provided for mkcert generation." });
    return 1;
  }

  const paths = getGlobalPaths();
  const outDir =
    typeof args.options.out === "string"
      ? resolve(ctx.cwd, args.options.out)
      : paths.certsDir;
  await ensureDir(outDir);

  if (!args.options.install) {
    const hasLocalCa = await hasMkcertLocalCa({ mkcertPath });
    if (!hasLocalCa) {
      logger.warn({
        message:
          "mkcert local CA is not installed. Run `hack global cert --install` (or `mkcert -install`) to trust generated certs.",
      });
    }
  }

  if (args.options.install) {
    logger.step({ message: "Installing mkcert local CA…" });
    const installExit = await run([mkcertPath, "-install"], {
      stdin: "inherit",
    });
    if (installExit !== 0) {
      return installExit;
    }
  }

  const base = buildCertFileBase({ hosts });
  const certPath = resolve(outDir, `${base}.pem`);
  const keyPath = resolve(outDir, `${base}-key.pem`);

  logger.step({ message: "Generating cert with mkcert…" });
  const exit = await run(
    [mkcertPath, "-cert-file", certPath, "-key-file", keyPath, ...hosts],
    {
      stdin: "inherit",
    }
  );
  if (exit !== 0) {
    return exit;
  }

  note([`Cert: ${certPath}`, `Key: ${keyPath}`].join("\n"), "mkcert");
  return 0;
}

async function handleGlobalLogs({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: GlobalLogsArgs;
}): Promise<number> {
  const slimExit = failIfSlimMode({
    feature: "hack global logs",
  });
  if (slimExit !== null) {
    return slimExit;
  }

  await ensureDockerRunning();
  const service = (args.positionals.service ?? "caddy").toLowerCase();
  const follow = !args.options.noFollow;
  const tail = args.options.tail ?? 200;

  const paths = getGlobalPaths();

  const isCaddy = service === "caddy";
  const composeFile = isCaddy ? paths.caddyCompose : paths.loggingCompose;

  const serviceArg = isCaddy ? [] : [service];
  const followArg = follow ? ["-f"] : [];
  const tailArg = ["--tail", String(tail)];

  if (args.options.pretty) {
    return await dockerComposeLogsPretty({
      composeFile,
      cwd: dirname(composeFile),
      follow,
      tail,
      services: isCaddy ? undefined : [service],
    });
  }

  return await run(
    [
      "docker",
      "compose",
      "-f",
      composeFile,
      "logs",
      ...followArg,
      ...tailArg,
      ...serviceArg,
    ],
    { cwd: dirname(composeFile) }
  );
}

function buildCertFileBase({
  hosts,
}: {
  readonly hosts: readonly string[];
}): string {
  const primary = hosts[0] ?? "cert";
  const base = sanitizeCertFileBase({ value: primary });
  return hosts.length > 1 ? `${base}+${hosts.length - 1}` : base;
}

function sanitizeCertFileBase({ value }: { readonly value: string }): string {
  const trimmed = value.trim().toLowerCase();
  const normalized = trimmed.replaceAll("*", "wildcard").replaceAll(".", "-");
  const cleaned = normalized.replaceAll(/[^a-z0-9-]/g, "-");
  const collapsed = cleaned.replaceAll(/-+/g, "-").replaceAll(/^-|-$/g, "");
  return collapsed.length > 0 ? collapsed : "cert";
}

async function hasMkcertLocalCa({
  mkcertPath,
}: {
  readonly mkcertPath: string;
}): Promise<boolean> {
  const res = await exec([mkcertPath, "-CAROOT"], { stdin: "ignore" });
  if (res.exitCode !== 0) {
    return false;
  }
  const caRoot = res.stdout.trim();
  if (!caRoot) {
    return false;
  }
  const certPath = resolve(caRoot, "rootCA.pem");
  const keyPath = resolve(caRoot, "rootCA-key.pem");
  return (await pathExists(certPath)) && (await pathExists(keyPath));
}

async function ensureMacHackDns(opts: {
  readonly installBrewDeps: boolean;
  readonly targetIp: string;
}): Promise<void> {
  const domains = managedLocalDomains(await resolveDefaultDomain());
  const customDomain = domains.at(-1);
  if (domains.length > 3 && customDomain) {
    await assertCustomResolverAvailable(customDomain);
  }
  const brewOk = await ensureBrewForDnsmasq();
  if (!brewOk) {
    return;
  }

  const dnsmasqOk = await ensureDnsmasqInstalled(opts.installBrewDeps, domains);
  if (!dnsmasqOk) {
    return;
  }

  const brewPrefix = await resolveBrewPrefix();
  const dnsmasqConf = resolve(brewPrefix, "etc", "dnsmasq.conf");
  await ensureDnsmasqHackAliases({
    dnsmasqConf,
    targetIp: opts.targetIp,
    domains,
  });
  await ensureMacResolverFiles(domains);
  await restartMacDnsmasq();
  await flushMacDnsCachePrivileged();
  noteDnsConfigured({ dnsmasqConf, targetIp: opts.targetIp, domains });
}

async function preflightCustomDomainDnsClaim(): Promise<void> {
  const domains = managedLocalDomains(await resolveDefaultDomain());
  const customDomain = domains.length > 3 ? domains.at(-1) : undefined;
  if (!(isMac() && customDomain)) {
    return;
  }
  await assertCustomResolverAvailable(customDomain);
  const brew = await findExecutableInPath("brew");
  if (!brew) {
    return;
  }
  const brewPrefix = await resolveBrewPrefix();
  const conf = await readTextFile(resolve(brewPrefix, "etc", "dnsmasq.conf"));
  assertCustomDnsmasqClaimAvailable({
    domain: customDomain,
    content: conf ?? "",
  });
}

function assertCustomDnsmasqClaimAvailable(opts: {
  readonly domain: string;
  readonly content: string;
}): void {
  const prefix = `address=/.${opts.domain}/`;
  const managedTargets: ReadonlySet<string> = new Set([
    DEFAULT_CADDY_IP,
    DEFAULT_HOST_DNS_IP,
    "::1",
  ]);
  const claim = opts.content
    .split("\n")
    .map((line) => line.trim())
    .find(
      (line) =>
        line.startsWith(prefix) &&
        !managedTargets.has(line.slice(prefix.length))
    );
  if (claim) {
    throw new Error(
      `Existing dnsmasq claim for .${opts.domain}; resolve it before global install`
    );
  }
}

async function ensureBrewForDnsmasq(): Promise<boolean> {
  const brew = await findExecutableInPath("brew");
  if (!brew) {
    logger.warn({ message: "Homebrew not found; skipping dnsmasq bootstrap." });
    return false;
  }
  return true;
}

async function ensureDnsmasqInstalled(
  installBrewDeps: boolean,
  domains: readonly string[]
): Promise<boolean> {
  const hasDnsmasq = await isBrewFormulaInstalled({ formula: "dnsmasq" });
  if (hasDnsmasq) {
    return true;
  }

  if (!(installBrewDeps || canPrompt())) {
    if (await needsMacHostDns(domains)) {
      throw brewInstallConsentError();
    }
    return false;
  }

  const ok = await confirmGlobalBrewInstall({
    allowed: installBrewDeps,
    message: "Install dnsmasq via Homebrew? (required for *.hack DNS)",
    initialValue: true,
  });
  if (!ok) {
    logger.warn({
      message: "Skipping dnsmasq install; *.hack hostnames may not resolve.",
    });
    return false;
  }

  logger.step({ message: "Installing dnsmasq via Homebrew…" });
  const installExit = await run(["brew", "install", "dnsmasq"], {
    stdin: "inherit",
  });
  if (installExit !== 0) {
    throw new Error(`brew install dnsmasq failed (exit ${installExit})`);
  }

  return true;
}

async function isBrewFormulaInstalled(opts: {
  readonly formula: string;
}): Promise<boolean> {
  const result = await exec(["brew", "list", opts.formula], {
    stdin: "ignore",
  });
  return result.exitCode === 0;
}

async function resolveBrewPrefix(): Promise<string> {
  const prefixRes = await exec(["brew", "--prefix"], { stdin: "ignore" });
  const prefix = prefixRes.exitCode === 0 ? prefixRes.stdout.trim() : "";
  return prefix.length > 0 ? prefix : "/opt/homebrew";
}

async function ensureDnsmasqHackAliases(opts: {
  readonly dnsmasqConf: string;
  readonly targetIp: string;
  readonly domains: readonly string[];
}): Promise<void> {
  const desiredLines = opts.domains.map(
    (domain) => `address=/.${domain}/${opts.targetIp}`
  );
  const legacyHostTarget =
    opts.targetIp === DEFAULT_CADDY_IP ? DEFAULT_HOST_DNS_IP : DEFAULT_CADDY_IP;
  const legacyLines = opts.domains.flatMap((domain) => [
    `address=/.${domain}/${legacyHostTarget}`,
    `address=/.${domain}/::1`,
  ]);

  const existing = (await readTextFile(opts.dnsmasqConf)) ?? "";
  const builtInDomains: ReadonlySet<string> = new Set([
    DEFAULT_PROJECT_TLD,
    DEFAULT_NEW_PROJECT_TLD,
    DEFAULT_OAUTH_ALIAS_ROOT,
  ]);
  for (const domain of opts.domains) {
    if (builtInDomains.has(domain)) {
      continue;
    }
    assertCustomDnsmasqClaimAvailable({ domain, content: existing });
  }
  const migrated = removeLegacyDnsmasqLines({
    content: existing,
    legacyLines,
  });
  const missing = desiredLines.filter(
    (line) => !migrated.content.includes(line)
  );
  const shouldWrite = migrated.changed || missing.length > 0;
  if (!shouldWrite) {
    logger.info({
      message: `dnsmasq already configured for ${opts.domains.map((domain) => `*.${domain}`).join(", ")}`,
    });
    return;
  }

  const next = buildDnsmasqConf({
    existing: migrated.content,
    lines: missing,
  });
  await ensureDir(dirname(opts.dnsmasqConf));
  await Bun.write(opts.dnsmasqConf, next);
  logger.success({ message: `Updated ${opts.dnsmasqConf}` });
}

function removeLegacyDnsmasqLines(opts: {
  readonly content: string;
  readonly legacyLines: readonly string[];
}): { readonly content: string; readonly changed: boolean } {
  let updated = opts.content;
  let changed = false;

  for (const legacyLine of opts.legacyLines) {
    if (!updated.includes(legacyLine)) {
      continue;
    }
    updated = updated.replaceAll(legacyLine, "");
    changed = true;
  }

  if (!changed) {
    return { content: updated, changed: false };
  }

  // Clean up any double newlines left from removal.
  const cleaned = updated.replace(/\n{3,}/g, "\n\n").trim();
  logger.info({
    message: "Migrating dnsmasq to the reachable local ingress target...",
  });
  return { content: cleaned, changed: true };
}

function buildDnsmasqConf(opts: {
  readonly existing: string;
  readonly lines: readonly string[];
}): string {
  const existing = opts.existing.trimEnd();
  if (existing.length === 0) {
    return `${opts.lines.join("\n")}\n`;
  }
  return `${existing}\n${opts.lines.join("\n")}\n`;
}

async function ensureMacResolverFiles(
  domains: readonly string[]
): Promise<void> {
  const builtInDomains: ReadonlySet<string> = new Set([
    DEFAULT_PROJECT_TLD,
    DEFAULT_NEW_PROJECT_TLD,
    DEFAULT_OAUTH_ALIAS_ROOT,
  ]);
  for (const domain of domains) {
    await maybeWriteResolver({
      domain,
      refuseForeign: !builtInDomains.has(domain),
    });
  }
}

async function assertCustomResolverAvailable(domain: string): Promise<void> {
  const resolverPath = `/etc/resolver/${domain}`;
  const existing = await readTextFile(resolverPath);
  if (existing !== null && existing.trim() !== "nameserver 127.0.0.1") {
    throw new Error(
      `Existing resolver ${resolverPath} is not Hack-owned; refusing to overwrite it`
    );
  }
}

async function maybeWriteResolver(opts: {
  readonly domain: string;
  readonly refuseForeign: boolean;
}): Promise<void> {
  const resolverPath = `/etc/resolver/${opts.domain}`;
  if (opts.refuseForeign) {
    await assertCustomResolverAvailable(opts.domain);
    const existing = await readTextFile(resolverPath);
    if (existing !== null) {
      return;
    }
  }
  const resolverOk = await confirmSafe({
    message: `Write ${resolverPath} (requires sudo)?`,
    initialValue: true,
    nonInteractive: "decline",
  });
  if (!resolverOk) {
    logger.warn({
      message: `Skipping /etc/resolver setup for ${opts.domain}; *.${opts.domain} may not resolve.`,
    });
    return;
  }

  await run(macResolverArgv(opts.domain));
  logger.success({ message: `Wrote ${resolverPath}` });
}

function noteDnsConfigured(opts: {
  readonly dnsmasqConf: string;
  readonly targetIp: string;
  readonly domains: readonly string[];
}): void {
  const targetLabel =
    opts.targetIp === DEFAULT_CADDY_IP ? "container ingress" : "localhost";
  note(
    [
      ...opts.domains.map(
        (domain) =>
          `DNS configured: *.${domain} → ${opts.targetIp} (${targetLabel})`
      ),
      `- dnsmasq: ${opts.dnsmasqConf}`,
      ...opts.domains.map((domain) => `- resolver: /etc/resolver/${domain}`),
    ].join("\n"),
    "DNS"
  );
}

async function resolvePreferredMacHostDnsTarget(): Promise<string> {
  const [containerIpReachable, localhostReachable] = await Promise.all([
    canConnectTcp({ host: DEFAULT_CADDY_IP, port: 443, timeoutMs: 1500 }),
    canConnectTcp({ host: DEFAULT_HOST_DNS_IP, port: 443, timeoutMs: 1500 }),
  ]);

  const targetIp = resolvePreferredHostDnsTarget({
    containerIpReachable,
    localhostReachable,
  });

  if (!containerIpReachable && localhostReachable) {
    logger.warn({
      message: [
        `Host cannot reach ${DEFAULT_CADDY_IP}:443 directly.`,
        `Falling back to ${DEFAULT_HOST_DNS_IP} for macOS host DNS.`,
      ].join("\n"),
    });
  } else if (!(containerIpReachable || localhostReachable)) {
    logger.warn({
      message: [
        `Unable to reach either ${DEFAULT_CADDY_IP}:443 or ${DEFAULT_HOST_DNS_IP}:443 after startup.`,
        `Keeping ${DEFAULT_CADDY_IP} as the host DNS target.`,
      ].join("\n"),
    });
  }

  return targetIp;
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

async function ensureMacDnsmasqRunning(): Promise<void> {
  const brew = await resolveBrewPath();
  if (!brew) {
    return;
  }

  const hasDnsmasq =
    (await exec(["brew", "list", "dnsmasq"], { stdin: "ignore" })).exitCode ===
    0;
  if (!hasDnsmasq) {
    return;
  }

  const services = await exec(["brew", "services", "list"], {
    stdin: "ignore",
  });
  const line =
    services.exitCode === 0
      ? services.stdout
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.startsWith("dnsmasq"))
      : undefined;

  const parts = line ? line.split(WHITESPACE_PATTERN) : [];
  const status = parts[1] ?? "";
  const user = parts[2] ?? "";

  if (!macDnsmasqNeedsStart(services.exitCode === 0 ? services.stdout : "")) {
    return;
  }

  logger.warn({
    message:
      status === "started"
        ? `dnsmasq is started as ${user || "unknown user"}; restarting as root so it can bind :53`
        : "dnsmasq is not started; starting it as root so it can bind :53",
  });

  const interactive = isInteractiveTerminal();
  const helperInstalled = await pathExists(MAC_DNS_RECOVERY_HELPER_PATH);
  let exit = 1;
  for (const command of macRestartCommands({
    brew,
    helperPath: MAC_DNS_RECOVERY_HELPER_PATH,
    helperInstalled,
  })) {
    exit = await runMacPrivilegedCommand({ command, interactive });
    if (exit === 0) {
      break;
    }
  }
  if (exit !== 0) {
    logger.warn({
      message: interactive
        ? `Failed to start dnsmasq (exit ${exit}). *.${DEFAULT_PROJECT_TLD} may not resolve.`
        : [
            `Failed to start dnsmasq without interactive sudo (exit ${exit}).`,
            "Open a terminal and run: hack global up",
          ].join("\n"),
    });
  }
}

async function ensureMacChafa(installBrewDeps: boolean): Promise<void> {
  const brew = await findExecutableInPath("brew");
  if (!brew) {
    logger.warn({ message: "Homebrew not found; skipping chafa install." });
    return;
  }

  const hasChafa =
    (await exec(["brew", "list", "chafa"], { stdin: "ignore" })).exitCode === 0;
  if (hasChafa) {
    return;
  }

  const ok = await confirmGlobalBrewInstall({
    allowed: installBrewDeps,
    message: "Install chafa via Homebrew? (used for hack the planet)",
    initialValue: true,
  });
  if (!ok) {
    logger.warn({
      message: "Skipping chafa install. Run: brew install chafa",
    });
    return;
  }

  logger.step({ message: "Installing chafa via Homebrew…" });
  const installExit = await run(["brew", "install", "chafa"], {
    stdin: "inherit",
  });
  if (installExit !== 0) {
    throw new Error(`brew install chafa failed (exit ${installExit})`);
  }
}

async function ensureMacMkcert(installBrewDeps?: boolean): Promise<void> {
  const brew = await findExecutableInPath("brew");
  if (!brew) {
    logger.warn({ message: "Homebrew not found; skipping mkcert install." });
    return;
  }

  const hasMkcert =
    (await exec(["brew", "list", "mkcert"], { stdin: "ignore" })).exitCode ===
    0;
  if (hasMkcert) {
    return;
  }

  const ok = await confirmGlobalBrewInstall({
    allowed: installBrewDeps,
    message: "Install mkcert via Homebrew? (used for hack global cert)",
    initialValue: false,
  });
  if (!ok) {
    logger.warn({
      message: "Skipping mkcert install. Run: brew install mkcert",
    });
    return;
  }

  logger.step({ message: "Installing mkcert via Homebrew…" });
  const installExit = await run(["brew", "install", "mkcert"], {
    stdin: "inherit",
  });
  if (installExit !== 0) {
    throw new Error(`brew install mkcert failed (exit ${installExit})`);
  }
}

/**
 * Whether `sudo` can run without prompting for a password right now
 * (`sudo -n true`). Used to avoid launching a `sudo` command that would hang
 * waiting on a password prompt when there is no TTY to answer it.
 */
/** Prepare local trust exports; only permitted homes may update launchd. */
export async function configureMacHostTlsTrust(input: {
  readonly certPath: string;
}): Promise<boolean> {
  const eligibility = await inspectMacCaEligibility(input);
  if (!eligibility.installable) {
    logger.warn({ message: eligibility.issue });
    return false;
  }
  const bundlePath = await writeMacHostTrustBundle({
    certPath: input.certPath,
  });
  const env = buildHackHostTrustEnvironment({
    certPath: input.certPath,
    bundlePath,
  });
  const scriptPath = resolveHackHostTrustEnvScriptPath();
  await ensureDir(dirname(scriptPath));
  await writeTextFile(
    scriptPath,
    renderHackHostTrustShellExports({
      certPath: input.certPath,
      bundlePath,
    })
  );

  const access = resolveLaunchdAccess();
  if (!access.allowed) {
    logger.info({
      message: `Prepared local host trust exports at ${scriptPath}; skipping launchd registration: ${access.message}`,
    });
    return true;
  }

  for (const [key, value] of Object.entries(env)) {
    const exitCode = await run(["launchctl", "setenv", key, value], {
      stdin: "ignore",
    });
    if (exitCode !== 0) {
      logger.warn({
        message: `Failed to set ${key} for future macOS shells via launchctl (exit ${exitCode}).`,
      });
    }
  }

  logger.success({
    message:
      "Prepared host trust env for Bun/Node/curl/git and registered it for future macOS shells.",
  });
  note(
    [
      `Current shell: source ${scriptPath}`,
      "New Terminal/iTerm windows should inherit the trust env automatically.",
    ].join("\n"),
    "Host TLS"
  );
  return true;
}

async function writeMacHostTrustBundle(input: {
  readonly certPath: string;
}): Promise<string | null> {
  const bundlePath = resolveHackHostTrustBundlePath();
  const systemRootsKeychain =
    "/System/Library/Keychains/SystemRootCertificates.keychain";

  const pemChunks: string[] = [];
  if (await pathExists(systemRootsKeychain)) {
    const result = await exec(
      ["security", "find-certificate", "-a", "-p", systemRootsKeychain],
      {
        stdin: "ignore",
      }
    );
    if (result.exitCode !== 0) {
      logger.warn({
        message: `Failed to export trust roots from ${systemRootsKeychain}; host bundle will skip it.`,
      });
    } else {
      const pemText = result.stdout.trim();
      if (pemText.length > 0) {
        pemChunks.push(pemText);
      }
    }
  }

  const localCaPem = (await readTextFile(input.certPath))?.trim() ?? "";
  if (localCaPem.length === 0) {
    logger.warn({
      message: `Unable to read exported Caddy Local CA at ${input.certPath}.`,
    });
    return null;
  }

  if (pemChunks.length === 0) {
    logger.warn({
      message:
        "No macOS system trust roots were exported for the host trust bundle; falling back to NODE_EXTRA_CA_CERTS only.",
    });
    return null;
  }

  const bundleText = `${[...pemChunks, localCaPem].join("\n")}\n`;
  const expectedPath = resolveHackLocalCaCertPath();
  if (input.certPath !== expectedPath) {
    logger.info({
      message: `Using exported Caddy Local CA at ${input.certPath} instead of ${expectedPath}.`,
    });
  }
  await ensureDir(dirname(bundlePath));
  await writeTextFileIfChanged(bundlePath, bundleText);
  return bundlePath;
}

const LINUX_SYSTEM_BUNDLE_CANDIDATES = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/etc/ssl/cert.pem",
] as const;

/**
 * Builds the combined public+local trust bundle on Linux by concatenating the
 * distro's canonical CA bundle with the Caddy local CA. Containers and host
 * tools point replace-semantics SSL vars at this bundle so public roots and
 * `*.hack` trust coexist (the same contract writeMacHostTrustBundle provides
 * via the macOS system keychain export).
 */
export async function writeLinuxHostTrustBundle(input: {
  readonly certPath: string;
  /** Verified CA bytes; when given, `certPath` is not re-read. */
  readonly localCaPem?: string;
  readonly systemBundleCandidates?: readonly string[];
  readonly bundlePath?: string;
}): Promise<string | null> {
  const bundlePath = input.bundlePath ?? resolveHackHostTrustBundlePath();
  const candidates = input.systemBundleCandidates ?? [
    ...LINUX_SYSTEM_BUNDLE_CANDIDATES,
  ];

  let systemBundle = "";
  for (const candidate of candidates) {
    const text = (await readTextFile(candidate))?.trim() ?? "";
    if (text.length > 0) {
      systemBundle = text;
      break;
    }
  }
  if (systemBundle.length === 0) {
    logger.warn({
      message:
        "No Linux system CA bundle found; falling back to NODE_EXTRA_CA_CERTS only.",
    });
    return null;
  }

  const localCaPem = (
    input.localCaPem ??
    (await readTextFile(input.certPath)) ??
    ""
  ).trim();
  if (localCaPem.length === 0) {
    logger.warn({
      message: `Unable to read exported Caddy Local CA at ${input.certPath}.`,
    });
    return null;
  }

  await ensureDir(dirname(bundlePath));
  await writeTextFileIfChanged(bundlePath, `${systemBundle}\n${localCaPem}\n`);
  return bundlePath;
}

/**
 * Linux host trust setup: updates system/NSS stores, persists the verified
 * CA, then generates the combined bundle and shell env from those bytes.
 * Returns false when an attempted step failed.
 */
export async function configureLinuxHostTlsTrust(input: {
  readonly certPath: string;
  /** Test seams; default to the real system/NSS step and bundle writer. */
  readonly applySystemTrust?: () => Promise<LinuxTrustResult>;
  readonly writeBundle?: (opts: {
    readonly certPath: string;
    readonly localCaPem: string;
  }) => Promise<string | null>;
}): Promise<boolean> {
  // System trust first: the host bundle copies the system bundle, so after a
  // Caddy root rotation it must be built from the refreshed system bundle,
  // not the one that still holds the superseded root.
  const trust = await (
    input.applySystemTrust ??
    (() =>
      configureLinuxSystemAndBrowserTrust({
        certPath: input.certPath,
        composeFile: getGlobalPaths().caddyCompose,
      }))
  )();
  if (trust.verifiedPem === null) {
    // The CA was refused: leave the host bundle and env as they are rather
    // than writing an unverified certificate into them.
    return false;
  }
  const verifiedCertPath = join(
    dirname(resolveHackHostTrustBundlePath()),
    "caddy-verified-authority.crt"
  );
  await ensureDir(dirname(verifiedCertPath));
  await writeTextFileIfChanged(verifiedCertPath, trust.verifiedPem);
  // Use the verified bytes, not a re-read of the mutable export: a file
  // replaced during the prompt must not reach the host bundle.
  const bundlePath = await (
    input.writeBundle ??
    ((opts: { readonly certPath: string; readonly localCaPem: string }) =>
      writeLinuxHostTrustBundle(opts))
  )({ certPath: verifiedCertPath, localCaPem: trust.verifiedPem });
  const scriptPath = resolveHackHostTrustEnvScriptPath();
  await ensureDir(dirname(scriptPath));
  await writeTextFile(
    scriptPath,
    renderHackHostTrustShellExports({
      certPath: verifiedCertPath,
      bundlePath,
    })
  );

  logger.success({
    message: bundlePath
      ? "Generated the combined public+local trust bundle and host trust env."
      : "Prepared host trust env (NODE_EXTRA_CA_CERTS only; no system bundle found).",
  });
  note(`Current shell: source ${scriptPath}`, "Host TLS");
  return trust.ok;
}

async function exportCaddyLocalCaCert(): Promise<string | null> {
  const paths = getGlobalPaths();

  // Find the running Caddy container.
  const ps = await exec(
    ["docker", "compose", "-f", paths.caddyCompose, "ps", "-q", "caddy"],
    {
      cwd: dirname(paths.caddyCompose),
      stdin: "ignore",
    }
  );
  const id = ps.exitCode === 0 ? ps.stdout.trim() : "";
  if (id.length === 0) {
    logger.warn({
      message:
        "Unable to locate Caddy container to export CA cert (is global infra up?)",
    });
    return null;
  }

  const outDir = resolve(paths.caddyDir, "pki");
  await ensureDir(outDir);
  const certPath = resolve(outDir, "caddy-local-authority.crt");

  // Export the CA cert from Caddy's data dir in the container.
  // Default location for internal PKI: /data/caddy/pki/authorities/local/root.crt
  const cpExit = await run(
    [
      "docker",
      "cp",
      `${id}:/data/caddy/pki/authorities/local/root.crt`,
      certPath,
    ],
    { stdin: "ignore" }
  );
  if (cpExit !== 0) {
    logger.warn({
      message: `Failed to export Caddy Local CA (exit ${cpExit}).`,
    });
    return null;
  }

  return certPath;
}
