import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { confirm, isCancel, note, spinner } from "@clack/prompts";
import type { CliContext, CommandArgs } from "../cli/command.ts";
import { defineCommand, defineOption, withHandler } from "../cli/command.ts";

/** Regex to split strings on whitespace. */
const WHITESPACE_PATTERN = /\s+/;

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
  GLOBAL_GRAFANA_DASHBOARD_FILENAME,
  GLOBAL_GRAFANA_DASHBOARDS_PROVISIONING_FILENAME,
  GLOBAL_GRAFANA_DATASOURCE_FILENAME,
  GLOBAL_HACK_DIR_NAME,
  GLOBAL_LOGGING_COMPOSE_FILENAME,
  GLOBAL_LOGGING_DIR_NAME,
  GLOBAL_LOKI_CONFIG_FILENAME,
  GLOBAL_SCHEMAS_DIR_NAME,
} from "../constants.ts";
import { resolveGatewayConfig } from "../control-plane/extensions/gateway/config.ts";
import { listGatewayTokens } from "../control-plane/extensions/gateway/tokens.ts";
import type { ControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { resolveDaemonPaths } from "../daemon/paths.ts";
import { isProcessRunning } from "../daemon/process.ts";
import { readDaemonStatus } from "../daemon/status.ts";
import { resolveGlobalConfigPath } from "../lib/config-paths.ts";
import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFileIfChanged,
} from "../lib/fs.ts";
import { getString, isRecord } from "../lib/guards.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import { parseJsonLines } from "../lib/json-lines.ts";
import { isMac } from "../lib/os.ts";
import { exec, execOrThrow, findExecutableInPath, run } from "../lib/shell.ts";
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
} from "../templates.ts";
import { display } from "../ui/display.ts";
import { dockerComposeLogsPretty } from "../ui/docker-logs.ts";
import { ensureBundledGumInstalled } from "../ui/gum.ts";
import { logger } from "../ui/logger.ts";

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
    branchesSchema: resolve(schemasDir, GLOBAL_BRANCHES_SCHEMA_FILENAME),
  };
}

async function ensureDockerRunning(): Promise<void> {
  const res = await exec(["docker", "info"], { stdin: "ignore" });
  if (res.exitCode !== 0) {
    throw new Error("Docker does not seem to be running (docker info failed)");
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
  const s = spinner();
  s.start("Ensuring gum…");
  const gum = await ensureBundledGumInstalled();
  if (gum.ok) {
    s.stop(gum.installed ? "Installed bundled gum" : "gum already installed");
  } else {
    const systemGum = Bun.which("gum");
    s.stop(
      systemGum ? "gum available on PATH" : "gum not installed (optional)"
    );
    if (gum.reason === "failed") {
      logger.warn({
        message: `gum install failed: ${gum.message ?? "unknown error"}`,
      });
    }
  }

  if (isMac()) {
    await ensureMacChafa();
    await ensureMacMkcert();
  } else {
    logger.warn({
      message: "Skipping chafa install (only automated on macOS for now).",
    });
  }

  s.start("Checking Docker…");
  await ensureDockerRunning();
  s.stop("Docker is running");

  s.start("Ensuring shared networks…");
  const ingressNetwork = await ensureNetwork(DEFAULT_INGRESS_NETWORK, {
    subnet: DEFAULT_INGRESS_SUBNET,
    gateway: DEFAULT_INGRESS_GATEWAY,
  });
  await ensureNetwork(DEFAULT_LOGGING_NETWORK);
  s.stop(
    `Networks ready (${DEFAULT_INGRESS_NETWORK}, ${DEFAULT_LOGGING_NETWORK})`
  );
  if (!ingressNetwork.hasSubnet) {
    logger.warn({
      message:
        "hack-dev network has no subnet; CoreDNS will resolve via dynamic IP.",
    });
  }
  const useStaticIps = false;

  if (isMac()) {
    await ensureMacHackDns();
  } else {
    logger.warn({
      message: "Skipping DNS bootstrap (only implemented for macOS for now).",
    });
    note(
      [
        "You need wildcard DNS for *.hack pointing to 127.0.0.1.",
        "Recommended: dnsmasq + OS resolver config for the 'hack' TLD.",
      ].join("\n"),
      "DNS setup"
    );
  }

  const paths = getGlobalPaths();
  await ensureDir(paths.caddyDir);
  await ensureDir(paths.loggingDir);
  await ensureDir(paths.schemasDir);
  await ensureDir(dirname(paths.grafanaDatasource));
  await ensureDir(dirname(paths.grafanaDashboardsProvisioning));
  await ensureDir(dirname(paths.grafanaDashboard));
  await ensureDir(dirname(paths.alloyConfig));
  await ensureDir(dirname(paths.lokiConfig));

  await writeWithPromptIfDifferent(
    paths.caddyCompose,
    renderGlobalCaddyCompose({
      useStaticCoreDnsIp: useStaticIps,
      useStaticCaddyIp: useStaticIps,
    })
  );
  await writeWithPromptIfDifferent(
    paths.coreDnsConfig,
    renderGlobalCoreDnsConfig({ useStaticCaddyIp: useStaticIps })
  );
  await writeWithPromptIfDifferent(
    paths.loggingCompose,
    renderGlobalLoggingCompose()
  );
  await writeWithPromptIfDifferent(
    paths.alloyConfig,
    renderGlobalAlloyConfig()
  );
  await writeWithPromptIfDifferent(
    paths.lokiConfig,
    renderGlobalLokiConfigYaml()
  );
  await writeWithPromptIfDifferent(
    paths.grafanaDatasource,
    renderGlobalGrafanaDatasourceYaml()
  );
  await writeWithPromptIfDifferent(
    paths.grafanaDashboardsProvisioning,
    renderGlobalGrafanaDashboardsProvisioningYaml()
  );
  await writeWithPromptIfDifferent(
    paths.grafanaDashboard,
    renderGlobalGrafanaLogsDashboardJson()
  );
  await writeWithPromptIfDifferent(
    paths.configSchema,
    renderProjectConfigSchemaJson()
  );
  await writeWithPromptIfDifferent(
    paths.branchesSchema,
    renderProjectBranchesSchemaJson()
  );

  logger.success({ message: "Global files ready in ~/.hack/" });
  await globalUp();

  if (isMac()) {
    await ensureMacTrustCaddyLocalCa();
  }

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

async function globalLogsReset(): Promise<number> {
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
    const blockers = conflicts.filter(
      (conflict) => !isGlobalProxyContainer({ name: conflict.containerName })
    );
    if (blockers.length > 0) {
      logger.error({
        message: renderIngressConflictMessage({ conflicts: blockers }),
      });
      return 1;
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

  const inspect = await exec(
    ["docker", "network", "inspect", DEFAULT_INGRESS_NETWORK],
    {
      stdin: "ignore",
    }
  );
  if (inspect.exitCode !== 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(inspect.stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }

  const conflicts: IngressIpConflict[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const containers = (entry as { Containers?: Record<string, unknown> })
      .Containers;
    if (!containers || typeof containers !== "object") {
      continue;
    }

    for (const info of Object.values(containers)) {
      if (!info || typeof info !== "object") {
        continue;
      }
      const record = info as { Name?: unknown; IPv4Address?: unknown };
      const name = typeof record.Name === "string" ? record.Name : "";
      const ipRaw =
        typeof record.IPv4Address === "string" ? record.IPv4Address : "";
      if (!(name && ipRaw)) {
        continue;
      }
      const ip = extractIpv4Address({ raw: ipRaw });
      if (!opts.reservedIps.includes(ip)) {
        continue;
      }
      conflicts.push({ ip, containerName: name });
    }
  }

  return conflicts;
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

async function globalDown(): Promise<number> {
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
      await run(["sudo", "brew", "services", "stop", "dnsmasq"], {
        stdin: "inherit",
      });
    }
  }

  logger.success({ message: "Global infra is down" });
  return 0;
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
  readonly gateway_projects?: string;
  readonly exposures: readonly GatewayExposurePayload[];
  readonly warnings: readonly string[];
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
    cloudflareHostname,
    cloudflareTunnel,
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
  if (!isMac()) {
    logger.warn({
      message: "Trust is only implemented for macOS (System keychain).",
    });
    return 0;
  }

  await ensureDockerRunning();
  await ensureMacTrustCaddyLocalCa();

  return 0;
}

async function handleGlobalCa({
  args,
}: {
  readonly ctx: CliContext;
  readonly args: GlobalCaArgs;
}): Promise<number> {
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

async function ensureMacHackDns(): Promise<void> {
  const brew = await findExecutableInPath("brew");
  if (!brew) {
    logger.warn({ message: "Homebrew not found; skipping dnsmasq bootstrap." });
    return;
  }

  const hasDnsmasq =
    (await exec(["brew", "list", "dnsmasq"], { stdin: "ignore" })).exitCode ===
    0;

  if (!hasDnsmasq) {
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
      return;
    }
    logger.step({ message: "Installing dnsmasq via Homebrew…" });
    const installExit = await run(["brew", "install", "dnsmasq"], {
      stdin: "inherit",
    });
    if (installExit !== 0) {
      throw new Error(`brew install dnsmasq failed (exit ${installExit})`);
    }
  }

  // Configure dnsmasq: map local dev domains → Caddy container IP
  // (bypasses OrbStack port forwarding issues with port 443)
  const prefixRes = await exec(["brew", "--prefix"], { stdin: "ignore" });
  const brewPrefix =
    prefixRes.exitCode === 0 ? prefixRes.stdout.trim() : "/opt/homebrew";
  const dnsmasqConf = resolve(brewPrefix, "etc", "dnsmasq.conf");

  const containerIpLines = [
    `address=/.${DEFAULT_PROJECT_TLD}/${DEFAULT_CADDY_IP}`,
    `address=/.${DEFAULT_OAUTH_ALIAS_ROOT}/${DEFAULT_CADDY_IP}`,
  ] as const;
  const legacyLines = [
    `address=/.${DEFAULT_PROJECT_TLD}/127.0.0.1`,
    `address=/.${DEFAULT_OAUTH_ALIAS_ROOT}/127.0.0.1`,
    `address=/.${DEFAULT_PROJECT_TLD}/::1`,
    `address=/.${DEFAULT_OAUTH_ALIAS_ROOT}/::1`,
  ] as const;

  let existing = (await readTextFile(dnsmasqConf)) ?? "";

  // Migrate: replace legacy localhost lines with container IP
  let migrated = false;
  for (const legacyLine of legacyLines) {
    if (existing.includes(legacyLine)) {
      existing = existing.replace(legacyLine, "");
      migrated = true;
    }
  }
  if (migrated) {
    // Clean up any double newlines left from removal
    existing = existing.replace(/\n{3,}/g, "\n\n").trim();
    logger.info({ message: "Migrating dnsmasq to use container IP..." });
  }

  const missing = containerIpLines.filter((line) => !existing.includes(line));
  if (missing.length > 0 || migrated) {
    const next =
      existing.length === 0
        ? `${missing.join("\n")}\n`
        : `${existing.trimEnd()}\n${missing.join("\n")}\n`;
    await ensureDir(dirname(dnsmasqConf));
    await Bun.write(dnsmasqConf, next);
    logger.success({ message: `Updated ${dnsmasqConf}` });
  } else {
    logger.info({
      message: `dnsmasq already configured for .${DEFAULT_PROJECT_TLD} and .${DEFAULT_OAUTH_ALIAS_ROOT}`,
    });
  }

  // Configure macOS resolver(s) → 127.0.0.1 (dnsmasq)
  for (const domain of [
    DEFAULT_PROJECT_TLD,
    DEFAULT_OAUTH_ALIAS_ROOT,
  ] as const) {
    const resolverPath = `/etc/resolver/${domain}`;
    const resolverOk = await confirm({
      message: `Write ${resolverPath} (requires sudo)?`,
      initialValue: true,
    });
    if (isCancel(resolverOk)) {
      throw new Error("Canceled");
    }
    if (resolverOk) {
      await run([
        "sudo",
        "sh",
        "-c",
        `mkdir -p /etc/resolver && printf '%s\\n' 'nameserver 127.0.0.1' > ${resolverPath}`,
      ]);
      logger.success({ message: `Wrote ${resolverPath}` });
    } else {
      logger.warn({
        message: `Skipping /etc/resolver setup for ${domain}; *.${domain} may not resolve.`,
      });
    }
  }

  // Start/restart dnsmasq.
  //
  // We run via sudo so dnsmasq can bind :53 (required for /etc/resolver/<tld>).
  logger.step({ message: "Restarting dnsmasq (requires sudo)…" });
  const restartExit = await run(
    ["sudo", "brew", "services", "restart", "dnsmasq"],
    {
      stdin: "inherit",
    }
  );
  if (restartExit !== 0) {
    throw new Error(
      `sudo brew services restart dnsmasq failed (exit ${restartExit})`
    );
  }

  // Flush macOS DNS cache to clear stale entries
  logger.step({ message: "Flushing DNS cache…" });
  await run(["sudo", "dscacheutil", "-flushcache"], { stdin: "inherit" });
  await run(["sudo", "killall", "-HUP", "mDNSResponder"], { stdin: "inherit" });

  note(
    [
      `DNS configured: *.${DEFAULT_PROJECT_TLD} → ${DEFAULT_CADDY_IP} (container)`,
      `DNS configured: *.${DEFAULT_OAUTH_ALIAS_ROOT} → ${DEFAULT_CADDY_IP} (container)`,
      `- dnsmasq: ${dnsmasqConf}`,
      `- resolver: /etc/resolver/${DEFAULT_PROJECT_TLD}`,
      `- resolver: /etc/resolver/${DEFAULT_OAUTH_ALIAS_ROOT}`,
    ].join("\n"),
    "DNS"
  );
}

async function ensureMacDnsmasqRunning(): Promise<void> {
  const brew = await findExecutableInPath("brew");
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

  const exit = await run(["sudo", "brew", "services", "restart", "dnsmasq"], {
    stdin: "inherit",
  });
  if (exit !== 0) {
    logger.warn({
      message: `Failed to start dnsmasq (exit ${exit}). *.${DEFAULT_PROJECT_TLD} may not resolve.`,
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

async function ensureMacTrustCaddyLocalCa(): Promise<void> {
  const ok = await confirm({
    message:
      "Trust Caddy Local CA in macOS System keychain? (enables trusted https://*.hack; requires sudo)",
    initialValue: true,
  });
  if (isCancel(ok)) {
    throw new Error("Canceled");
  }
  if (!ok) {
    return;
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
    return;
  }
  const certPath = await exportCaddyLocalCaCert();
  if (!certPath) {
    return;
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
      certPath,
    ],
    { stdin: "inherit" }
  );

  if (installExit !== 0) {
    logger.warn({
      message: `Failed to trust Caddy Local CA (exit ${installExit}). You may see HTTPS warnings in the browser.`,
    });
    return;
  }

  logger.success({ message: "Trusted Caddy Local CA (macOS System keychain)" });
  note(
    [
      "If your browser still shows a warning, restart the browser.",
      "To remove later: Keychain Access → System → search 'Caddy Local Authority'.",
    ].join("\n"),
    "TLS"
  );
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
