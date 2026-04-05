import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { confirm, isCancel, note, spinner } from "@clack/prompts";
import type { CliContext, CommandArgs } from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";

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
  DEFAULT_HOST_DNS_IP,
  DEFAULT_INGRESS_GATEWAY,
  DEFAULT_INGRESS_NETWORK,
  DEFAULT_INGRESS_SUBNET,
  DEFAULT_LOGGING_NETWORK,
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
  GLOBAL_HACK_DIR_NAME,
  GLOBAL_LOGGING_COMPOSE_FILENAME,
  GLOBAL_LOGGING_DIR_NAME,
  GLOBAL_LOKI_CONFIG_FILENAME,
  GLOBAL_MANAGED_ENV_SCHEMA_FILENAME,
  GLOBAL_SCHEMAS_DIR_NAME,
} from "../constants.ts";
import { resolveGatewayConfig } from "../control-plane/extensions/gateway/config.ts";
import { listGatewayTokens } from "../control-plane/extensions/gateway/tokens.ts";
import type { ControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { getLaunchdServiceStatus } from "../daemon/launchd.ts";
import { resolveDaemonPaths } from "../daemon/paths.ts";
import { isProcessRunning } from "../daemon/process.ts";
import { readDaemonStatus } from "../daemon/status.ts";
import { resolveGlobalConfigPath } from "../lib/config-paths.ts";
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
import { getString, isRecord } from "../lib/guards.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import { parseJsonLines } from "../lib/json-lines.ts";
import {
  buildHackHostTrustEnvironment,
  renderHackHostTrustShellExports,
  resolveHackHostTrustBundlePath,
  resolveHackHostTrustEnvScriptPath,
  resolveHackLocalCaCertPath,
} from "../lib/local-ca.ts";
import {
  ensureBundledMutagenInstalled,
  getMutagenPath,
} from "../lib/mutagen.ts";
import { isMac } from "../lib/os.ts";
import {
  reconcileRemoteCaddyRoutesStack,
  stopRemoteCaddyRoutesStack,
} from "../lib/remote-caddy-routes.ts";
import {
  detectDockerBackend,
  formatDockerConnectionGuidance,
} from "../lib/runtime-guidance.ts";
import { exec, execOrThrow, findExecutableInPath, run } from "../lib/shell.ts";
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
import { logger } from "../ui/logger.ts";
import { resolvePreferredHostDnsTarget } from "./doctor-utils.ts";

/** Regex to split strings on whitespace. */
const WHITESPACE_PATTERN = /\s+/;
const MAC_DNS_SUDOERS_PATH = "/etc/sudoers.d/dance.hack-dns-recovery";
const MAC_DNS_SUDOERS_TEMP_FILENAME = "dance.hack-dns-recovery.sudoers";
const MAC_DNS_RECOVERY_HELPER_PATH = "/usr/local/libexec/hack-dns-recovery";
const MAC_DNS_RECOVERY_HELPER_TEMP_FILENAME = "hack-dns-recovery";

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

const globalInstallSpec = defineCommand({
  name: "install",
  summary: "Bootstrap ~/.hack and start Caddy + Grafana/Loki/Alloy",
  group: "Global",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const globalUpSpec = defineCommand({
  name: "up",
  summary: "Start global infra containers",
  group: "Global",
  options: [],
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

const globalStatusSpec = defineCommand({
  name: "status",
  summary: "Show status for global infra (containers + networks)",
  group: "Global",
  options: [optJson] as const,
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
  summary: "Trust Caddy Local CA (macOS) so https://*.hack is trusted",
  group: "Global",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const globalLogsResetSpec = defineCommand({
  name: "logs-reset",
  summary: "Wipe Loki/Grafana volumes (fresh logs + dashboards)",
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
    withHandler(globalInstallSpec, async () => await globalInstall()),
    withHandler(globalUpSpec, async () => await globalUp()),
    withHandler(globalDownSpec, async () => await globalDown()),
    withHandler(globalStatusSpec, handleGlobalStatus),
    withHandler(globalLogsSpec, handleGlobalLogs),
    withHandler(globalCaSpec, handleGlobalCa),
    withHandler(globalCertSpec, handleGlobalCert),
    withHandler(globalTrustSpec, async () => await globalTrust()),
    withHandler(globalLogsResetSpec, async () => await globalLogsReset()),
    withHandler(globalAuthorizeSpec, async () => await globalAuthorize()),
  ],
} as const);

function getHomeDir(): string {
  const home = process.env.HOME;
  if (!home) {
    throw new Error("HOME is not set");
  }
  return home;
}

function getGlobalPaths() {
  const root = resolve(getHomeDir(), GLOBAL_HACK_DIR_NAME);
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

async function ensureDockerRunning(): Promise<void> {
  const res = await exec(["docker", "info"], { stdin: "ignore" });
  if (res.exitCode === 0) {
    return;
  }

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

  const ok = await confirm({
    message: `Docker is not running. Start ${backend.name}?`,
    initialValue: true,
  });
  if (isCancel(ok)) {
    throw new Error("Canceled");
  }
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

function muxInstallCommand(opts: {
  readonly provider: "tmux" | "zellij";
}): string {
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
  const zellijPath = findExecutableInPath("zellij");

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

  if (mode === "zellij" && !zellijPath) {
    logger.warn({
      message: [
        "sessions.mux is set to zellij but zellij is not on PATH.",
        `Install hint: ${muxInstallCommand({ provider: "zellij" })}`,
      ].join("\n"),
    });
    return;
  }

  if (mode === "auto" && !tmuxPath && !zellijPath) {
    logger.warn({
      message: [
        "sessions.mux is auto, but neither tmux nor zellij is available on PATH.",
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

async function globalInstall(): Promise<number> {
  const slimExit = failIfSlimMode({
    feature: "hack global install",
    alternative:
      "Use `bash scripts/install-codex-slim.sh` for managed Codex or CI environments.",
  });
  if (slimExit !== null) {
    return slimExit;
  }

  const s = spinner();
  await ensureOptionalInstallDependencies({ spinner: s });
  await warnIfSessionsMuxUnavailable();
  const useStaticIps = await ensureGlobalDockerNetworks({ spinner: s });
  const paths = getGlobalPaths();
  await materializeGlobalInstallFiles({ paths, useStaticIps });
  logger.success({ message: "Global files ready in ~/.hack/" });
  await globalUp();
  await completeGlobalInstallHostBootstrap();
  note(
    [
      "Next:",
      "- Open https://logs.hack",
      "- Start a repo with: hack init && hack up",
    ].join("\n"),
    "Global install"
  );

  return 0;
}

async function ensureOptionalInstallDependencies(opts: {
  readonly spinner: ReturnType<typeof spinner>;
}): Promise<void> {
  await ensureManagedGum({ spinner: opts.spinner });
  await ensureManagedMutagen({ spinner: opts.spinner });
  await ensureMacInstallDependencies();
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

async function ensureMacInstallDependencies(): Promise<void> {
  if (isMac()) {
    await ensureMacChafa();
    await ensureMacMkcert();
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
}): Promise<void> {
  await ensureGlobalInstallDirectories({ paths: opts.paths });
  await writeGlobalInstallAssets({
    paths: opts.paths,
    useStaticIps: opts.useStaticIps,
  });
}

async function ensureGlobalInstallDirectories(opts: {
  readonly paths: ReturnType<typeof getGlobalPaths>;
}): Promise<void> {
  await ensureDir(opts.paths.caddyDir);
  await ensureDir(opts.paths.loggingDir);
  await ensureDir(opts.paths.schemasDir);
  await ensureDir(dirname(opts.paths.grafanaDatasource));
  await ensureDir(dirname(opts.paths.grafanaDashboardsProvisioning));
  await ensureDir(dirname(opts.paths.grafanaDashboard));
  await ensureDir(dirname(opts.paths.alloyConfig));
  await ensureDir(dirname(opts.paths.lokiConfig));
}

async function writeGlobalInstallAssets(opts: {
  readonly paths: ReturnType<typeof getGlobalPaths>;
  readonly useStaticIps: boolean;
}): Promise<void> {
  await writeWithPromptIfDifferent(
    opts.paths.caddyCompose,
    renderGlobalCaddyCompose({
      useStaticCoreDnsIp: opts.useStaticIps,
      useStaticCaddyIp: opts.useStaticIps,
    })
  );
  await writeWithPromptIfDifferent(
    opts.paths.coreDnsConfig,
    renderGlobalCoreDnsConfig({ useStaticCaddyIp: opts.useStaticIps })
  );
  await writeWithPromptIfDifferent(
    opts.paths.loggingCompose,
    renderGlobalLoggingCompose()
  );
  await writeWithPromptIfDifferent(
    opts.paths.alloyConfig,
    renderGlobalAlloyConfig()
  );
  await writeWithPromptIfDifferent(
    opts.paths.lokiConfig,
    renderGlobalLokiConfigYaml()
  );
  await writeWithPromptIfDifferent(
    opts.paths.grafanaDatasource,
    renderGlobalGrafanaDatasourceYaml()
  );
  await writeWithPromptIfDifferent(
    opts.paths.grafanaDashboardsProvisioning,
    renderGlobalGrafanaDashboardsProvisioningYaml()
  );
  await writeWithPromptIfDifferent(
    opts.paths.grafanaDashboard,
    renderGlobalGrafanaLogsDashboardJson()
  );
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
}

async function completeGlobalInstallHostBootstrap(): Promise<void> {
  if (isMac()) {
    await bootstrapMacGlobalInstall();
    return;
  }

  logger.warn({
    message: "Skipping DNS bootstrap (only implemented for macOS for now).",
  });
  note(
    [
      `You need wildcard DNS for *.hack pointing to ${DEFAULT_HOST_DNS_IP}.`,
      "Recommended: dnsmasq + OS resolver config for the 'hack' TLD.",
    ].join("\n"),
    "DNS setup"
  );
}

async function bootstrapMacGlobalInstall(): Promise<void> {
  const hostDnsTarget = await resolvePreferredMacHostDnsTarget();
  await ensureMacHackDns({ targetIp: hostDnsTarget });
  const certPath = await exportCaddyLocalCaCert();
  if (certPath) {
    const trustReady = await ensureMacTrustCaddyLocalCa({ certPath });
    if (trustReady) {
      await configureMacHostTlsTrust({ certPath });
    }
  }
  await maybeOfferMacRecoverySetup();
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
    logger.error({
      message: `Missing ${paths.loggingCompose}. Run: hack global install`,
    });
    return 1;
  }

  const ok = await confirm({
    message:
      "This will stop the logging stack and delete ALL Loki logs and Grafana state (volumes).\nContinue?",
    initialValue: false,
  });
  if (isCancel(ok)) {
    throw new Error("Canceled");
  }
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

  const ok = await confirm({
    message:
      "Install a sudoers rule so Hack can restart dnsmasq and flush DNS cache without asking for your password during recovery?",
    initialValue: true,
  });
  if (isCancel(ok)) {
    throw new Error("Canceled");
  }
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
  const installHelperDirExit = await run(
    [
      "sudo",
      "install",
      "-d",
      "-m",
      "0755",
      dirname(MAC_DNS_RECOVERY_HELPER_PATH),
    ],
    {
      stdin: "inherit",
    }
  );
  if (installHelperDirExit !== 0) {
    logger.error({
      message: `Failed to create ${dirname(MAC_DNS_RECOVERY_HELPER_PATH)} (exit ${installHelperDirExit})`,
    });
    return 1;
  }

  const installHelperExit = await run(
    [
      "sudo",
      "install",
      "-m",
      "0755",
      helperTempPath,
      MAC_DNS_RECOVERY_HELPER_PATH,
    ],
    {
      stdin: "inherit",
    }
  );
  if (installHelperExit !== 0) {
    logger.error({
      message: `Failed to install ${MAC_DNS_RECOVERY_HELPER_PATH} (exit ${installHelperExit})`,
    });
    return 1;
  }

  const installDirExit = await run(
    ["sudo", "install", "-d", "-m", "0755", "/etc/sudoers.d"],
    {
      stdin: "inherit",
    }
  );
  if (installDirExit !== 0) {
    logger.error({
      message: `Failed to create /etc/sudoers.d (exit ${installDirExit})`,
    });
    return 1;
  }

  const installFileExit = await run(
    ["sudo", "install", "-m", "0440", tempPath, MAC_DNS_SUDOERS_PATH],
    {
      stdin: "inherit",
    }
  );
  if (installFileExit !== 0) {
    logger.error({
      message: `Failed to install ${MAC_DNS_SUDOERS_PATH} (exit ${installFileExit})`,
    });
    return 1;
  }

  const validateInstalledExit = await run(
    ["sudo", visudo, "-cf", MAC_DNS_SUDOERS_PATH],
    {
      stdin: "inherit",
    }
  );
  if (validateInstalledExit !== 0) {
    logger.error({
      message: `Installed sudoers rule failed validation (visudo exit ${validateInstalledExit})`,
    });
    return 1;
  }

  const verifyAuthorizationExit = await run(["sudo", "-k"], {
    stdin: "ignore",
  });
  if (verifyAuthorizationExit !== 0) {
    logger.warn({
      message: `Unable to invalidate the sudo authentication timestamp before verification (exit ${verifyAuthorizationExit}).`,
    });
  }

  const verifyPasswordlessExit = await run(
    ["sudo", "-n", MAC_DNS_RECOVERY_HELPER_PATH, "check"],
    {
      stdin: "ignore",
    }
  );
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
  return [
    "#!/bin/sh",
    "set -eu",
    `brew_path=${JSON.stringify(opts.brewPath)}`,
    `command="\${1:-}"`,
    'case "$command" in',
    "  check)",
    "    exit 0",
    "    ;;",
    "  restart-dnsmasq)",
    '    exec "$brew_path" services restart dnsmasq',
    "    ;;",
    "  stop-dnsmasq)",
    '    exec "$brew_path" services stop dnsmasq',
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

async function maybeOfferMacHackdLaunchdInstall(): Promise<void> {
  const paths = resolveDaemonPaths({});
  const launchdStatus = await getLaunchdServiceStatus({ paths });
  if (launchdStatus.installed) {
    logger.info({
      message: "hackd launchd service already installed",
    });
    return;
  }

  const ok = await confirm({
    message:
      "Install hackd as a launchd service so it restarts automatically on login and daemon crashes?",
    initialValue: true,
  });
  if (isCancel(ok)) {
    throw new Error("Canceled");
  }
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

async function writeWithPromptIfDifferent(
  absolutePath: string,
  content: string
): Promise<void> {
  const existing = await readTextFile(absolutePath);
  if (existing === content) {
    return;
  }

  if (existing !== null) {
    const ok = await confirm({
      message: `Overwrite existing file?\n${absolutePath}`,
      initialValue: false,
    });
    if (isCancel(ok)) {
      throw new Error("Canceled");
    }
    if (!ok) {
      return;
    }
  }

  await writeTextFileIfChanged(absolutePath, content);
}

export async function globalUp(): Promise<number> {
  const slimExit = failIfSlimMode({
    feature: "hack global up",
  });
  if (slimExit !== null) {
    return slimExit;
  }

  await ensureDockerRunning();
  if (isMac()) {
    await ensureMacDnsmasqRunning();
  }
  const paths = getGlobalPaths();

  if (!(await pathExists(paths.caddyCompose))) {
    logger.error({
      message: `Missing ${paths.caddyCompose}. Run: hack global install`,
    });
    return 1;
  }
  if (!(await pathExists(paths.loggingCompose))) {
    logger.error({
      message: `Missing ${paths.loggingCompose}. Run: hack global install`,
    });
    return 1;
  }

  const reservedIps = await resolveReservedIngressIps({
    composePath: paths.caddyCompose,
  });
  if (reservedIps.length > 0) {
    const conflicts = await findIngressIpConflicts({ reservedIps });
    let blockers = conflicts.filter(
      (conflict) => !isGlobalProxyContainer({ name: conflict.containerName })
    );
    if (blockers.length > 0) {
      logger.warn({
        message: [
          `Reserved ingress IPs are currently occupied on ${DEFAULT_INGRESS_NETWORK}.`,
          "Attempting to reassign conflicting containers and retry global startup…",
        ].join("\n"),
      });

      await reassignIngressIpConflicts({
        conflicts: blockers,
        reservedIps,
      });

      const remainingConflicts = await findIngressIpConflicts({
        reservedIps,
      });
      blockers = remainingConflicts.filter(
        (conflict) => !isGlobalProxyContainer({ name: conflict.containerName })
      );

      if (blockers.length > 0) {
        logger.error({
          message: renderIngressConflictMessage({ conflicts: blockers }),
        });
        return 1;
      }

      logger.success({
        message: "Recovered reserved ingress IP conflicts; continuing startup.",
      });
    }
  }

  const controlPlane = await readControlPlaneConfig({});
  if (controlPlane.config.daemon.autoStart) {
    logger.step({ message: "Ensuring hackd is running…" });
    const invocation = await resolveHackInvocation();
    const daemonExit = await run(
      [invocation.bin, ...invocation.args, "daemon", "start"],
      {
        stdin: "ignore",
      }
    );
    if (daemonExit !== 0) {
      logger.warn({ message: "Unable to start hackd (continuing)" });
    }
  }

  logger.step({ message: "Starting Caddy…" });
  const caddyExit = await run(
    [
      "docker",
      "compose",
      "-f",
      paths.caddyCompose,
      "up",
      "-d",
      "--remove-orphans",
    ],
    { cwd: dirname(paths.caddyCompose) }
  );
  if (caddyExit !== 0) {
    return caddyExit;
  }
  const remoteRoutes = await reconcileRemoteCaddyRoutesStack();
  if (remoteRoutes.status === "failed") {
    logger.warn({
      message: `Remote route bridge sync failed: ${remoteRoutes.error}`,
    });
  } else if (remoteRoutes.status === "applied") {
    logger.step({
      message: `Remote route bridge active (${remoteRoutes.routeCount} host${remoteRoutes.routeCount === 1 ? "" : "s"})`,
    });
  }

  logger.step({ message: "Starting logging stack…" });
  const logExit = await run(
    [
      "docker",
      "compose",
      "-f",
      paths.loggingCompose,
      "up",
      "-d",
      "--remove-orphans",
    ],
    { cwd: dirname(paths.loggingCompose) }
  );
  if (logExit !== 0) {
    return logExit;
  }

  logger.success({ message: "Global infra is up" });
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
    await run(["docker", "compose", "-f", paths.caddyCompose, "down"], {
      cwd: dirname(paths.caddyCompose),
    });
  }
  const remoteRoutes = await stopRemoteCaddyRoutesStack();
  if (remoteRoutes.status === "failed") {
    logger.warn({
      message: `Unable to stop remote route bridge during shutdown: ${remoteRoutes.error}`,
    });
  }

  if (isMac()) {
    const ok = await confirm({
      message: `Stop dnsmasq? (disables *.${DEFAULT_PROJECT_TLD} and *.${DEFAULT_OAUTH_ALIAS_ROOT} DNS; requires sudo)`,
      initialValue: false,
    });
    if (isCancel(ok)) {
      throw new Error("Canceled");
    }
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
  const silentExit = await run(["sudo", "-n", ...opts.command], {
    stdin: "ignore",
  });
  if (silentExit === 0) {
    return 0;
  }
  if (!opts.interactive) {
    return silentExit;
  }
  return await run(["sudo", ...opts.command], {
    stdin: "inherit",
  });
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true;
}

async function resolveBrewPath(): Promise<string | null> {
  return await findExecutableInPath("brew");
}

async function restartMacDnsmasq(): Promise<void> {
  const brew = await resolveBrewPath();
  if (await pathExists(MAC_DNS_RECOVERY_HELPER_PATH)) {
    const restartExit = await runMacPrivilegedCommand({
      command: [MAC_DNS_RECOVERY_HELPER_PATH, "restart-dnsmasq"],
      interactive: isInteractiveTerminal(),
    });
    if (restartExit === 0) {
      return;
    }
    if (!brew) {
      throw new Error(
        `sudo ${MAC_DNS_RECOVERY_HELPER_PATH} restart-dnsmasq failed (exit ${restartExit})`
      );
    }
  }

  if (!brew) {
    throw new Error("Homebrew not found; cannot restart dnsmasq");
  }

  const restartExit = await runMacPrivilegedCommand({
    command: [brew, "services", "restart", "dnsmasq"],
    interactive: isInteractiveTerminal(),
  });
  if (restartExit !== 0) {
    throw new Error(
      `sudo ${brew} services restart dnsmasq failed (exit ${restartExit})`
    );
  }
}

async function flushMacDnsCachePrivileged(): Promise<void> {
  if (await pathExists(MAC_DNS_RECOVERY_HELPER_PATH)) {
    const flushExit = await runMacPrivilegedCommand({
      command: [MAC_DNS_RECOVERY_HELPER_PATH, "flush-cache"],
      interactive: isInteractiveTerminal(),
    });
    if (flushExit !== 0) {
      throw new Error(
        `sudo ${MAC_DNS_RECOVERY_HELPER_PATH} flush-cache failed (exit ${flushExit})`
      );
    }
    return;
  }

  const flushExit = await runMacPrivilegedCommand({
    command: ["/usr/bin/dscacheutil", "-flushcache"],
    interactive: isInteractiveTerminal(),
  });
  if (flushExit !== 0) {
    throw new Error(`sudo dscacheutil -flushcache failed (exit ${flushExit})`);
  }

  const hupExit = await runMacPrivilegedCommand({
    command: ["/usr/bin/killall", "-HUP", "mDNSResponder"],
    interactive: isInteractiveTerminal(),
  });
  if (hupExit !== 0) {
    throw new Error(`sudo killall -HUP mDNSResponder failed (exit ${hupExit})`);
  }
}

async function handleGlobalStatus({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: GlobalStatusArgs;
}): Promise<number> {
  return await globalStatus({ json: args.options.json ?? false });
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

  if (opts.json) {
    const [caddy, logging, networks, gateway] = await Promise.all([
      readComposeStatus(paths.caddyCompose),
      readComposeStatus(paths.loggingCompose),
      readNetworksStatus([DEFAULT_INGRESS_NETWORK, DEFAULT_LOGGING_NETWORK]),
      collectGatewayStatus(),
    ]);
    const summary = {
      caddy_ok: caddy.ok,
      logging_ok: logging.ok,
      networks_ok: networks.ok,
      gateway_enabled: gateway.gateway_enabled,
      ok: caddy.ok && logging.ok && networks.ok,
    };
    const payload = {
      generated_at: new Date().toISOString(),
      caddy,
      logging,
      networks,
      gateway,
      summary,
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  await display.section("Caddy");
  await renderComposeStatusTable(paths.caddyCompose);

  await display.section("Logging");
  await renderComposeStatusTable(paths.loggingCompose);

  await display.section("Networks");
  await renderNetworksTable([DEFAULT_INGRESS_NETWORK, DEFAULT_LOGGING_NETWORK]);

  await display.section("Gateway");
  await renderGatewayStatus();

  return 0;
}

type ComposeServiceStatus = {
  readonly service: string;
  readonly name: string;
  readonly status: string;
  readonly ports: string;
};

type ComposeStatusGroup = {
  readonly ok: boolean;
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

  const tokens = await listGatewayTokens({ rootDir: daemonPaths.root });
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
    warnings: gatewayResolution.warnings,
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
  const baseHome = (process.env.HOME ?? homedir()).trim();
  if (!baseHome) {
    return null;
  }
  const pidPath = resolve(
    baseHome,
    GLOBAL_HACK_DIR_NAME,
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

function isServiceRunning(status: string): boolean {
  const normalized = status.toLowerCase();
  return normalized.includes("running") || normalized.includes("up");
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

async function globalTrust(): Promise<number> {
  const slimExit = failIfSlimMode({
    feature: "hack global trust",
  });
  if (slimExit !== null) {
    return slimExit;
  }

  if (!isMac()) {
    logger.warn({
      message: "Trust is only implemented for macOS (System keychain).",
    });
    return 0;
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

  const trustReady = await ensureMacTrustCaddyLocalCa({
    certPath,
  });
  if (trustReady) {
    await configureMacHostTlsTrust({
      certPath,
    });
  }

  return 0;
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
      service: isCaddy ? undefined : service,
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
  readonly targetIp: string;
}): Promise<void> {
  const brewOk = await ensureBrewForDnsmasq();
  if (!brewOk) {
    return;
  }

  const dnsmasqOk = await ensureDnsmasqInstalled();
  if (!dnsmasqOk) {
    return;
  }

  const brewPrefix = await resolveBrewPrefix();
  const dnsmasqConf = resolve(brewPrefix, "etc", "dnsmasq.conf");
  await ensureDnsmasqHackAliases({ dnsmasqConf, targetIp: opts.targetIp });
  await ensureMacResolverFiles();
  await restartMacDnsmasq();
  await flushMacDnsCachePrivileged();
  noteDnsConfigured({ dnsmasqConf, targetIp: opts.targetIp });
}

async function ensureBrewForDnsmasq(): Promise<boolean> {
  const brew = await findExecutableInPath("brew");
  if (!brew) {
    logger.warn({ message: "Homebrew not found; skipping dnsmasq bootstrap." });
    return false;
  }
  return true;
}

async function ensureDnsmasqInstalled(): Promise<boolean> {
  const hasDnsmasq = await isBrewFormulaInstalled({ formula: "dnsmasq" });
  if (hasDnsmasq) {
    return true;
  }

  const ok = await confirm({
    message: "Install dnsmasq via Homebrew? (required for *.hack DNS)",
    initialValue: true,
  });
  if (isCancel(ok)) {
    throw new Error("Canceled");
  }
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
}): Promise<void> {
  const desiredLines = [
    `address=/.${DEFAULT_PROJECT_TLD}/${opts.targetIp}`,
    `address=/.${DEFAULT_OAUTH_ALIAS_ROOT}/${opts.targetIp}`,
  ] as const;
  const legacyHostTarget =
    opts.targetIp === DEFAULT_CADDY_IP ? DEFAULT_HOST_DNS_IP : DEFAULT_CADDY_IP;
  const legacyLines = [
    `address=/.${DEFAULT_PROJECT_TLD}/${legacyHostTarget}`,
    `address=/.${DEFAULT_OAUTH_ALIAS_ROOT}/${legacyHostTarget}`,
    `address=/.${DEFAULT_PROJECT_TLD}/::1`,
    `address=/.${DEFAULT_OAUTH_ALIAS_ROOT}/::1`,
  ] as const;

  const existing = (await readTextFile(opts.dnsmasqConf)) ?? "";
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
      message: `dnsmasq already configured for .${DEFAULT_PROJECT_TLD} and .${DEFAULT_OAUTH_ALIAS_ROOT}`,
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

async function ensureMacResolverFiles(): Promise<void> {
  await maybeWriteResolver({ domain: DEFAULT_PROJECT_TLD });
  await maybeWriteResolver({ domain: DEFAULT_OAUTH_ALIAS_ROOT });
}

async function maybeWriteResolver(opts: {
  readonly domain: string;
}): Promise<void> {
  const resolverPath = `/etc/resolver/${opts.domain}`;
  const resolverOk = await confirm({
    message: `Write ${resolverPath} (requires sudo)?`,
    initialValue: true,
  });
  if (isCancel(resolverOk)) {
    throw new Error("Canceled");
  }
  if (!resolverOk) {
    logger.warn({
      message: `Skipping /etc/resolver setup for ${opts.domain}; *.${opts.domain} may not resolve.`,
    });
    return;
  }

  await run([
    "sudo",
    "sh",
    "-c",
    `mkdir -p /etc/resolver && printf '%s\\n' 'nameserver 127.0.0.1' > ${resolverPath}`,
  ]);
  logger.success({ message: `Wrote ${resolverPath}` });
}

function noteDnsConfigured(opts: {
  readonly dnsmasqConf: string;
  readonly targetIp: string;
}): void {
  const targetLabel =
    opts.targetIp === DEFAULT_CADDY_IP ? "container ingress" : "localhost";
  note(
    [
      `DNS configured: *.${DEFAULT_PROJECT_TLD} → ${opts.targetIp} (${targetLabel})`,
      `DNS configured: *.${DEFAULT_OAUTH_ALIAS_ROOT} → ${opts.targetIp} (${targetLabel})`,
      `- dnsmasq: ${opts.dnsmasqConf}`,
      `- resolver: /etc/resolver/${DEFAULT_PROJECT_TLD}`,
      `- resolver: /etc/resolver/${DEFAULT_OAUTH_ALIAS_ROOT}`,
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

  if (status === "started" && user === "root") {
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
  let exit = await runMacPrivilegedCommand({
    command: helperInstalled
      ? [MAC_DNS_RECOVERY_HELPER_PATH, "restart-dnsmasq"]
      : [brew, "services", "restart", "dnsmasq"],
    interactive,
  });
  if (helperInstalled && exit !== 0) {
    exit = await runMacPrivilegedCommand({
      command: [brew, "services", "restart", "dnsmasq"],
      interactive,
    });
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

async function ensureMacChafa(): Promise<void> {
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

  const ok = await confirm({
    message: "Install chafa via Homebrew? (used for hack the planet)",
    initialValue: true,
  });
  if (isCancel(ok)) {
    throw new Error("Canceled");
  }
  if (!ok) {
    logger.warn({
      message:
        "Skipping chafa install; hack the planet will use the fallback renderer.",
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

async function ensureMacMkcert(): Promise<void> {
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

  const ok = await confirm({
    message: "Install mkcert via Homebrew? (used for hack global cert)",
    initialValue: false,
  });
  if (isCancel(ok)) {
    throw new Error("Canceled");
  }
  if (!ok) {
    logger.warn({
      message: "Skipping mkcert install; hack global cert will be unavailable.",
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

async function ensureMacTrustCaddyLocalCa(input: {
  readonly certPath: string;
}): Promise<boolean> {
  const ok = await confirm({
    message:
      "Trust Caddy Local CA in macOS System keychain? (enables trusted https://*.hack; requires sudo)",
    initialValue: true,
  });
  if (isCancel(ok)) {
    throw new Error("Canceled");
  }
  if (!ok) {
    logger.info({
      message:
        "Skipped macOS System keychain trust; leaving host TLS env unchanged.",
    });
    return false;
  }

  // Fast-path: already trusted.
  const existing = await exec(
    [
      "security",
      "find-certificate",
      "-c",
      "Caddy Local Authority",
      "/Library/Keychains/System.keychain",
    ],
    { stdin: "ignore" }
  );
  if (existing.exitCode === 0) {
    logger.info({
      message: "Caddy Local CA already present in System keychain",
    });
    return true;
  }

  logger.step({
    message: "Installing Caddy Local CA to System keychain (requires sudo)…",
  });
  const installExit = await run(
    [
      "sudo",
      "security",
      "add-trusted-cert",
      "-d",
      "-r",
      "trustRoot",
      "-k",
      "/Library/Keychains/System.keychain",
      input.certPath,
    ],
    { stdin: "inherit" }
  );

  if (installExit !== 0) {
    logger.warn({
      message: `Failed to trust Caddy Local CA (exit ${installExit}). You may see HTTPS warnings in the browser.`,
    });
    return false;
  }

  logger.success({ message: "Trusted Caddy Local CA (macOS System keychain)" });
  note(
    [
      "If your browser still shows a warning, restart the browser.",
      "To remove later: Keychain Access → System → search 'Caddy Local Authority'.",
    ].join("\n"),
    "TLS"
  );
  return true;
}

async function configureMacHostTlsTrust(input: {
  readonly certPath: string;
}): Promise<void> {
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
