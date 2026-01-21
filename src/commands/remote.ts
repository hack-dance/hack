import { stat } from "node:fs/promises";

import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  BoxRenderable,
  createCliRenderer,
  dim,
  fg,
  ScrollBoxRenderable,
  TextRenderable,
  t,
} from "@opentui/core";
import type { CliContext, CommandArgs } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optPath, optProject } from "../cli/options.ts";
import {
  GLOBAL_CLOUDFLARE_DIR_NAME,
  GLOBAL_HACK_DIR_NAME,
  HACK_PROJECT_DIR_PRIMARY,
} from "../constants.ts";
import type { GatewayAuditEntry } from "../control-plane/extensions/gateway/audit.ts";
import type { GatewayProject } from "../control-plane/extensions/gateway/config.ts";
import { resolveGatewayConfig } from "../control-plane/extensions/gateway/config.ts";
import { listGatewayTokens } from "../control-plane/extensions/gateway/tokens.ts";
import type { ControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { requestDaemonJson } from "../daemon/client.ts";
import { resolveDaemonPaths } from "../daemon/paths.ts";
import { isProcessRunning } from "../daemon/process.ts";
import type { DaemonStatus } from "../daemon/status.ts";
import { readDaemonStatus } from "../daemon/status.ts";
import { resolveGlobalConfigPath } from "../lib/config-paths.ts";
import { pathExists, readTextFile } from "../lib/fs.ts";
import { getString, isRecord } from "../lib/guards.ts";
import { resolveHackInvocation } from "../lib/hack-cli.ts";
import type { ProjectContext } from "../lib/project.ts";
import {
  defaultProjectSlugFromPath,
  findProjectContext,
  readProjectConfig,
  sanitizeProjectSlug,
} from "../lib/project.ts";
import {
  resolveRegisteredProjectByName,
  upsertProjectRegistration,
} from "../lib/projects-registry.ts";
import { display } from "../ui/display.ts";
import { gumConfirm, isGumAvailable } from "../ui/gum.ts";
import { logger } from "../ui/logger.ts";
import {
  buildGatewayQrPayload,
  buildSshQrPayload,
  renderQrPayload,
} from "../ui/qr.ts";
import { isTty } from "../ui/terminal.ts";

const remoteOptions = [optPath, optProject] as const;

const optGatewayUrl = defineOption({
  name: "gatewayUrl",
  type: "string",
  long: "--gateway-url",
  valueHint: "<url>",
  description: "Gateway base URL to embed in QR output",
} as const);

const optToken = defineOption({
  name: "token",
  type: "string",
  long: "--token",
  valueHint: "<token>",
  description: "Gateway token to embed in QR output",
} as const);

const optSsh = defineOption({
  name: "ssh",
  type: "boolean",
  long: "--ssh",
  description: "Emit an SSH QR payload instead of a gateway payload",
} as const);

const optSshHost = defineOption({
  name: "sshHost",
  type: "string",
  long: "--ssh-host",
  valueHint: "<host>",
  description: "SSH host for QR payload (required with --ssh)",
} as const);

const optSshUser = defineOption({
  name: "sshUser",
  type: "string",
  long: "--ssh-user",
  valueHint: "<user>",
  description: "SSH user for QR payload (defaults to $USER)",
} as const);

const optSshPort = defineOption({
  name: "sshPort",
  type: "number",
  long: "--ssh-port",
  valueHint: "<port>",
  description: "SSH port for QR payload (defaults to 22)",
} as const);

const optYes = defineOption({
  name: "yes",
  type: "boolean",
  long: "--yes",
  description: "Skip confirmation before printing sensitive QR payloads",
} as const);

const optQr = defineOption({
  name: "qr",
  type: "boolean",
  long: "--qr",
  description: "Force QR output after setup (default)",
} as const);

const optNoQr = defineOption({
  name: "noQr",
  type: "boolean",
  long: "--no-qr",
  description: "Skip QR output after setup",
} as const);

const qrOptions = [
  optPath,
  optProject,
  optGatewayUrl,
  optToken,
  optSsh,
  optSshHost,
  optSshUser,
  optSshPort,
  optYes,
] as const;

const setupOptions = [optPath, optProject, optQr, optNoQr, optYes] as const;

const remoteSpec = defineCommand({
  name: "remote",
  summary: "Remote workflow helpers",
  group: "Extensions",
  options: remoteOptions,
  positionals: [],
  subcommands: [],
} as const);

const setupSpec = defineCommand({
  name: "setup",
  summary: "Run the guided gateway setup",
  group: "Extensions",
  options: setupOptions,
  positionals: [],
  subcommands: [],
} as const);

const statusSpec = defineCommand({
  name: "status",
  summary: "Show remote/gateway status",
  group: "Extensions",
  options: remoteOptions,
  positionals: [],
  subcommands: [],
} as const);

const monitorSpec = defineCommand({
  name: "monitor",
  summary: "Open a remote status TUI",
  group: "Extensions",
  options: remoteOptions,
  positionals: [],
  subcommands: [],
} as const);

const qrSpec = defineCommand({
  name: "qr",
  summary: "Print a QR payload for remote access",
  group: "Extensions",
  options: qrOptions,
  positionals: [],
  subcommands: [],
} as const);

type RemoteArgs = CommandArgs<typeof remoteOptions, readonly []>;
type RemoteQrArgs = CommandArgs<typeof qrOptions, readonly []>;
type RemoteSetupArgs = CommandArgs<typeof setupOptions, readonly []>;

export const remoteCommand = withHandler(
  defineCommand({
    ...remoteSpec,
    subcommands: [
      withHandler(setupSpec, handleRemoteSetup),
      withHandler(statusSpec, handleRemoteStatus),
      withHandler(monitorSpec, handleRemoteMonitor),
      withHandler(qrSpec, handleRemoteQr),
    ],
  } as const),
  handleRemoteDefault
);

async function handleRemoteDefault({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: RemoteArgs;
}): Promise<number> {
  const resolved = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });

  const status = await renderRemoteStatus({ project: resolved });

  if (!status.projectGatewayEnabled) {
    if (!(isTty() && isGumAvailable())) {
      logger.info({
        message:
          "Run `hack remote setup` to enable the gateway for this project.",
      });
      return 1;
    }

    const confirmed = await gumConfirm({
      prompt: "Gateway not enabled for this project. Run setup now?",
      default: true,
    });
    if (!(confirmed.ok && confirmed.value)) {
      return 1;
    }
    const exitCode = await runGatewaySetup({
      cwd: ctx.cwd,
      pathOpt: args.options.path,
      projectOpt: args.options.project,
    });
    if (exitCode !== 0) {
      return exitCode;
    }
    await renderRemoteStatus({ project: resolved });
  }

  return 0;
}

async function handleRemoteSetup({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: RemoteSetupArgs;
}): Promise<number> {
  await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  return await runGatewaySetup({
    cwd: ctx.cwd,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
    qr: args.options.qr === true,
    noQr: args.options.noQr === true,
    yes: args.options.yes === true,
  });
}

async function handleRemoteStatus({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: RemoteArgs;
}): Promise<number> {
  const resolved = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  await renderRemoteStatus({ project: resolved });
  return 0;
}

async function handleRemoteMonitor({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: RemoteArgs;
}): Promise<number> {
  const resolved = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  return await runRemoteMonitor({ project: resolved });
}

async function handleRemoteQr({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: RemoteQrArgs;
}): Promise<number> {
  const resolved = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });

  if (args.options.ssh) {
    const host = (args.options.sshHost ?? "").trim();
    if (!host) {
      logger.error({ message: "Missing --ssh-host for SSH QR." });
      return 1;
    }

    const user = (args.options.sshUser ?? process.env.USER ?? "").trim();
    const port = args.options.sshPort;
    const payload = buildSshQrPayload({
      host,
      user: user.length > 0 ? user : undefined,
      port: typeof port === "number" ? port : undefined,
    });

    await renderQrPayload({
      label: "SSH",
      payload,
      sensitive: false,
      yes: args.options.yes === true,
    });
    return 0;
  }

  const token = (
    args.options.token ??
    process.env.HACK_GATEWAY_TOKEN ??
    ""
  ).trim();
  if (!token) {
    logger.error({
      message: "Missing gateway token. Set HACK_GATEWAY_TOKEN or pass --token.",
    });
    return 1;
  }

  const cloudflareStatus = await resolveCloudflareStatus({
    controlPlaneConfig: (await readControlPlaneConfig({})).config,
  });

  const gatewayUrl = await resolveGatewayUrl({
    override: args.options.gatewayUrl,
    cloudflareHostname: cloudflareStatus.hostname,
  });

  const payload = buildGatewayQrPayload({
    baseUrl: gatewayUrl,
    token,
    projectId: resolved.projectId,
  });

  const ok = await renderQrPayload({
    label: "Gateway",
    payload,
    sensitive: true,
    yes: args.options.yes === true,
  });
  return ok ? 0 : 1;
}

type ResolvedProject = {
  readonly project: ProjectContext;
  readonly projectName: string;
  readonly projectId?: string;
};

async function resolveProjectForArgs(opts: {
  readonly ctx: CliContext;
  readonly pathOpt?: string;
  readonly projectOpt?: string;
}): Promise<ResolvedProject> {
  if (opts.pathOpt && opts.projectOpt) {
    throw new CliUsageError("Use either --path or --project (not both).");
  }

  if (opts.projectOpt) {
    const name = sanitizeProjectSlug(opts.projectOpt);
    if (name.length === 0) {
      throw new CliUsageError("Invalid --project value.");
    }
    const fromRegistry = await resolveRegisteredProjectByName({ name });
    if (!fromRegistry) {
      throw new CliUsageError(
        `Unknown project "${name}". Run 'hack init' in that repo (or run 'hack projects' to see registered projects).`
      );
    }
    return await resolveProjectIdentity({ project: fromRegistry });
  }

  const startDir = opts.pathOpt
    ? resolve(opts.ctx.cwd, opts.pathOpt)
    : opts.ctx.cwd;
  const project = await findProjectContext(startDir);
  if (!project) {
    throw new Error(
      `No ${HACK_PROJECT_DIR_PRIMARY}/ (or legacy .dev/) found. Run: hack init`
    );
  }
  return await resolveProjectIdentity({ project });
}

async function resolveProjectIdentity(opts: {
  readonly project: ProjectContext;
}): Promise<ResolvedProject> {
  const cfg = await readProjectConfig(opts.project);
  const defaultName = defaultProjectSlugFromPath(opts.project.projectRoot);
  const projectName = (cfg.name ?? "").trim() || defaultName;

  const outcome = await upsertProjectRegistration({ project: opts.project });
  if (outcome.status === "conflict") {
    return { project: opts.project, projectName };
  }

  return {
    project: opts.project,
    projectId: outcome.project.id,
    projectName: outcome.project.name,
  };
}

type RemoteStatus = {
  readonly projectGatewayEnabled: boolean;
};

type TokenSummary = {
  readonly active: number;
  readonly revoked: number;
  readonly write: number;
  readonly read: number;
};

type RemoteStatusSnapshot = {
  readonly project: ResolvedProject;
  readonly projectGatewayEnabled: boolean;
  readonly gatewayEnabled: boolean;
  readonly gatewayConfig: ControlPlaneConfig["gateway"];
  readonly gatewayProjects: readonly GatewayProject[];
  readonly gatewayUrl: string;
  readonly daemonStatus: DaemonStatus;
  readonly streamsActive?: number;
  readonly cloudflare: CloudflareStatus;
  readonly tokens: TokenSummary;
  readonly globalConfigExists: boolean;
};

async function collectRemoteStatusSnapshot(opts: {
  readonly project: ResolvedProject;
}): Promise<RemoteStatusSnapshot> {
  const projectConfig = await readControlPlaneConfig({
    projectDir: opts.project.project.projectDir,
  });
  const projectGatewayEnabled = projectConfig.config.gateway.enabled;

  const gatewayResolution = await resolveGatewayConfig();
  const gatewayEnabled = gatewayResolution.config.enabled;
  const gatewayUrl = buildGatewayUrl({
    bind: gatewayResolution.config.bind,
    port: gatewayResolution.config.port,
  });

  const globalConfigPath = resolveGlobalConfigPath();
  const globalConfigExists = await pathExists(globalConfigPath);

  const daemonPaths = resolveDaemonPaths({});
  const daemonStatus = await readDaemonStatus({ paths: daemonPaths });

  const tokenRecords = await listGatewayTokens({ rootDir: daemonPaths.root });
  const activeTokens = tokenRecords.filter((token) => !token.revokedAt);
  const revokedTokens = tokenRecords.filter((token) => token.revokedAt);
  const writeTokens = activeTokens.filter((token) => token.scope === "write");
  const readTokens = activeTokens.filter((token) => token.scope === "read");

  let streamsActive: number | undefined;
  if (daemonStatus.running) {
    const metrics = await requestDaemonJson({ path: "/v1/metrics" });
    const raw = metrics?.ok ? metrics.json?.streams_active : undefined;
    if (typeof raw === "number") {
      streamsActive = raw;
    }
  }

  const cloudflareStatus = await resolveCloudflareStatus({
    controlPlaneConfig: (await readControlPlaneConfig({})).config,
  });

  return {
    project: opts.project,
    projectGatewayEnabled,
    gatewayEnabled,
    gatewayConfig: gatewayResolution.config,
    gatewayProjects: gatewayResolution.enabledProjects,
    gatewayUrl,
    daemonStatus,
    tokens: {
      active: activeTokens.length,
      revoked: revokedTokens.length,
      write: writeTokens.length,
      read: readTokens.length,
    },
    globalConfigExists,
    ...(streamsActive !== undefined ? { streamsActive } : {}),
    cloudflare: cloudflareStatus,
  };
}

function buildRemoteStatusEntries(opts: {
  readonly snapshot: RemoteStatusSnapshot;
}): Array<readonly [string, string | number | boolean]> {
  const snapshot = opts.snapshot;
  const entries: Array<readonly [string, string | number | boolean]> = [
    [
      "project",
      `${snapshot.project.projectName}${snapshot.project.projectId ? ` (${snapshot.project.projectId})` : ""}`,
    ],
    ["project_dir", snapshot.project.project.projectDir],
    ["project_gateway_enabled", snapshot.projectGatewayEnabled],
    ["gateway_enabled", snapshot.gatewayEnabled],
    ["gateway_config_path", resolveGlobalConfigPath()],
    ["gateway_config_exists", snapshot.globalConfigExists],
    ["gateway_projects_enabled", snapshot.gatewayProjects.length],
    ["gateway_url", snapshot.gatewayUrl],
    ["gateway_bind", snapshot.gatewayConfig.bind],
    ["gateway_port", snapshot.gatewayConfig.port],
    ["allow_writes", snapshot.gatewayConfig.allowWrites],
    ["tokens_active", snapshot.tokens.active],
    ["tokens_revoked", snapshot.tokens.revoked],
    ["tokens_write", snapshot.tokens.write],
    ["tokens_read", snapshot.tokens.read],
    [
      "hackd_running",
      snapshot.daemonStatus.running
        ? `true (pid ${snapshot.daemonStatus.pid ?? "unknown"})`
        : "false",
    ],
  ];

  if (snapshot.gatewayProjects.length > 0) {
    const projects = snapshot.gatewayProjects.map(
      (project) => `${project.projectName} (${project.projectId})`
    );
    entries.push(["gateway_projects", projects.join(", ")]);
  }

  if (snapshot.streamsActive !== undefined) {
    entries.push(["streams_active", snapshot.streamsActive]);
  }

  const cloudflareStatus = snapshot.cloudflare;
  const hasCloudflareConfig =
    cloudflareStatus.enabled ||
    cloudflareStatus.hostname ||
    cloudflareStatus.tunnel ||
    cloudflareStatus.origin ||
    cloudflareStatus.running !== undefined;

  if (hasCloudflareConfig) {
    entries.push(["cloudflare_enabled", cloudflareStatus.enabled]);
    if (cloudflareStatus.hostname) {
      entries.push(["cloudflare_hostname", cloudflareStatus.hostname]);
      entries.push(["cloudflare_url", `https://${cloudflareStatus.hostname}`]);
    }
    if (cloudflareStatus.tunnel) {
      entries.push(["cloudflare_tunnel", cloudflareStatus.tunnel]);
    }
    if (cloudflareStatus.origin) {
      entries.push(["cloudflare_origin", cloudflareStatus.origin]);
    }
    if (cloudflareStatus.running !== undefined) {
      entries.push([
        "cloudflared_running",
        cloudflareStatus.running
          ? `true (pid ${cloudflareStatus.pid ?? "unknown"})`
          : "false",
      ]);
    }
  }

  return entries;
}

async function renderRemoteStatus(opts: {
  readonly project: ResolvedProject;
}): Promise<RemoteStatus> {
  const snapshot = await collectRemoteStatusSnapshot({ project: opts.project });
  const entries = buildRemoteStatusEntries({ snapshot });

  await display.kv({
    title: "Remote status",
    entries,
  });

  if (!snapshot.globalConfigExists) {
    await display.panel({
      title: "Global config",
      tone: "warn",
      lines: [
        "Global control plane config not found.",
        `Run: hack config set --global 'controlPlane.gateway.bind' '${snapshot.gatewayConfig.bind}'`,
      ],
    });
  }

  if (!snapshot.projectGatewayEnabled) {
    await display.panel({
      title: "Next step",
      tone: "warn",
      lines: [
        "Gateway not enabled for this project.",
        "Run: hack remote setup",
      ],
    });
  }

  if (snapshot.projectGatewayEnabled && !snapshot.daemonStatus.running) {
    await display.panel({
      title: "Daemon",
      tone: "warn",
      lines: ["hackd is not running.", "Run: hack daemon start"],
    });
  }

  if (snapshot.gatewayEnabled && !snapshot.gatewayConfig.allowWrites) {
    await display.panel({
      title: "Writes disabled",
      tone: "info",
      lines: [
        "Shells and job creation require allowWrites + a write token.",
        "Run: hack gateway setup",
        "Or: hack config set --global 'controlPlane.gateway.allowWrites' true && hack daemon stop && hack daemon start",
      ],
    });
  }

  const cloudflareStatus = snapshot.cloudflare;
  if (cloudflareStatus.enabled && !cloudflareStatus.hostname) {
    await display.panel({
      title: "Cloudflare",
      tone: "warn",
      lines: [
        "Cloudflare enabled but no hostname configured.",
        "Set:",
        "  hack config set --global 'controlPlane.extensions[\"dance.hack.cloudflare\"].config.hostname' gateway.example.com",
      ],
    });
  }

  if (
    cloudflareStatus.enabled &&
    cloudflareStatus.hostname &&
    cloudflareStatus.running === false
  ) {
    await display.panel({
      title: "Cloudflare",
      tone: "warn",
      lines: [
        "cloudflared is not running.",
        "Run: hack x cloudflare tunnel-start",
      ],
    });
  }

  if (
    cloudflareStatus.enabled &&
    cloudflareStatus.hostname &&
    cloudflareStatus.running === undefined
  ) {
    await display.panel({
      title: "Cloudflare",
      tone: "info",
      lines: [
        "cloudflared status unknown (no pid file).",
        "Run: hack x cloudflare tunnel-start",
      ],
    });
  }

  await display.panel({
    title: "Tokens",
    tone: "info",
    lines: [
      `Active: ${snapshot.tokens.active} (write ${snapshot.tokens.write}, read ${snapshot.tokens.read})`,
      `Revoked: ${snapshot.tokens.revoked}`,
      "Export token: HACK_GATEWAY_TOKEN=...",
      "Create token: hack x gateway token-create --scope write",
      "List tokens: hack x gateway token-list",
      "Revoke token: hack x gateway token-revoke <token-id>",
    ],
  });

  return { projectGatewayEnabled: snapshot.projectGatewayEnabled };
}

async function runGatewaySetup(opts: {
  readonly cwd: string;
  readonly pathOpt?: string;
  readonly projectOpt?: string;
  readonly qr?: boolean;
  readonly noQr?: boolean;
  readonly yes?: boolean;
}): Promise<number> {
  const invocation = await resolveHackInvocation();
  const argv: string[] = ["gateway", "setup"];
  if (opts.pathOpt) {
    argv.push("--path", opts.pathOpt);
  }
  if (opts.projectOpt) {
    argv.push("--project", opts.projectOpt);
  }
  if (opts.qr) {
    argv.push("--qr");
  }
  if (opts.noQr) {
    argv.push("--no-qr");
  }
  if (opts.yes) {
    argv.push("--yes");
  }

  const proc = Bun.spawn([invocation.bin, ...invocation.args, ...argv], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    cwd: opts.cwd,
  });
  return await proc.exited;
}

function buildGatewayUrl(opts: {
  readonly bind: string;
  readonly port: number;
}): string {
  const host = opts.bind.includes(":") ? `[${opts.bind}]` : opts.bind;
  return `http://${host}:${opts.port}`;
}

async function resolveGatewayUrl(opts: {
  readonly override?: string;
  readonly cloudflareHostname?: string;
}): Promise<string> {
  const explicit = (opts.override ?? "").trim();
  if (explicit) {
    return explicit;
  }

  const env = (process.env.HACK_GATEWAY_URL ?? "").trim();
  if (env) {
    return env;
  }

  const hostname = (opts.cloudflareHostname ?? "").trim();
  if (hostname) {
    return `https://${hostname}`;
  }

  const gatewayResolution = await resolveGatewayConfig();
  return buildGatewayUrl({
    bind: gatewayResolution.config.bind,
    port: gatewayResolution.config.port,
  });
}

type CloudflareStatus = {
  readonly enabled: boolean;
  readonly hostname?: string;
  readonly tunnel?: string;
  readonly origin?: string;
  readonly running?: boolean;
  readonly pid?: number;
};

async function resolveCloudflareStatus(opts: {
  readonly controlPlaneConfig: ControlPlaneConfig;
}): Promise<CloudflareStatus> {
  const extension = opts.controlPlaneConfig.extensions["dance.hack.cloudflare"];
  const enabled = extension?.enabled ?? false;
  const config = extension?.config ?? {};
  const hostname = getString(config, "hostname");
  const tunnel = getString(config, "tunnel");
  const origin = getString(config, "origin");

  const pid = await readCloudflaredPid();
  const running = pid ? isProcessRunning({ pid }) : undefined;

  return {
    enabled,
    ...(hostname ? { hostname } : {}),
    ...(tunnel ? { tunnel } : {}),
    ...(origin ? { origin } : {}),
    ...(pid ? { pid } : {}),
    ...(running !== undefined ? { running } : {}),
  };
}

async function readCloudflaredPid(): Promise<number | null> {
  const baseHome = (process.env.HOME ?? homedir()).trim();
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
  const parsed = Number.parseInt(text.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

type AuditTailState = {
  offset: number;
  buffer: string;
};

type AuditLine = {
  readonly raw: string;
  readonly formatted: string;
};

class WrappedTextRenderable extends TextRenderable {
  protected override onResize(width: number, height: number): void {
    super.onResize(width, height);
    if (this.wrapMode !== "none" && width > 0) {
      this.textBufferView.setWrapWidth(width);
    }
  }

  public syncWrapWidth(): void {
    const width = Math.floor(this.width);
    if (this.wrapMode !== "none" && width > 0) {
      this.textBufferView.setWrapWidth(width);
    }
  }
}

async function runRemoteMonitor(opts: {
  readonly project: ResolvedProject;
}): Promise<number> {
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let auditTimer: ReturnType<typeof setInterval> | null = null;
  let isActive = true;

  const daemonPaths = resolveDaemonPaths({});
  const auditPath = resolve(daemonPaths.root, "gateway", "audit.jsonl");
  const auditState: AuditTailState = { offset: 0, buffer: "" };
  const auditLines: AuditLine[] = [];
  const maxAuditLines = 400;

  const activeRenderer = await createCliRenderer({
    targetFps: 30,
    exitOnCtrlC: false,
    useConsole: false,
    useAlternateScreen: true,
    useMouse: false,
  });
  activeRenderer.setBackgroundColor("#0f111a");

  const root = new BoxRenderable(activeRenderer, {
    id: "hack-remote-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    backgroundColor: "#0f111a",
    padding: 1,
    gap: 1,
  });

  const header = new BoxRenderable(activeRenderer, {
    id: "hack-remote-header",
    width: "100%",
    height: 2,
    border: false,
    backgroundColor: "#141828",
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 0,
    paddingBottom: 0,
  });

  const headerText = new TextRenderable(activeRenderer, {
    id: "hack-remote-header-text",
    content: "",
  });

  header.add(headerText);

  const statusBox = new BoxRenderable(activeRenderer, {
    id: "hack-remote-status",
    width: "100%",
    minHeight: 7,
    border: true,
    borderColor: "#2f344a",
    backgroundColor: "#0f111a",
    title: "Status",
    titleAlignment: "left",
    padding: 1,
  });

  const statusText = new TextRenderable(activeRenderer, {
    id: "hack-remote-status-text",
    content: "Loading status...",
  });

  statusBox.add(statusText);

  const logsBox = new BoxRenderable(activeRenderer, {
    id: "hack-remote-logs",
    width: "100%",
    flexGrow: 1,
    border: true,
    borderColor: "#2f344a",
    backgroundColor: "#0f111a",
    title: "Gateway audit log",
    titleAlignment: "left",
  });

  const logsScroll = new ScrollBoxRenderable(activeRenderer, {
    id: "hack-remote-logs-scroll",
    flexGrow: 1,
    stickyScroll: true,
    stickyStart: "bottom",
    rootOptions: {
      backgroundColor: "#0f111a",
    },
    wrapperOptions: {
      backgroundColor: "#0f111a",
    },
    viewportOptions: {
      backgroundColor: "#0f111a",
    },
    contentOptions: {
      backgroundColor: "#0f111a",
      minHeight: "100%",
    },
    scrollbarOptions: {
      trackOptions: {
        foregroundColor: "#3b4160",
        backgroundColor: "#151a2a",
      },
    },
  });

  const logsText = new WrappedTextRenderable(activeRenderer, {
    id: "hack-remote-logs-text",
    width: "100%",
    content: "Waiting for gateway activity...",
    wrapMode: "char",
  });

  logsScroll.add(logsText);
  logsBox.add(logsScroll);

  const footer = new BoxRenderable(activeRenderer, {
    id: "hack-remote-footer",
    width: "100%",
    border: false,
    backgroundColor: "#141828",
    paddingLeft: 1,
    paddingRight: 1,
    paddingTop: 0,
    paddingBottom: 0,
  });

  const footerText = new TextRenderable(activeRenderer, {
    id: "hack-remote-footer-text",
    content: t`${dim("[")}${fg("#9ad7ff")("q")}${dim("]")} quit  ${dim("[")}${fg(
      "#9ad7ff"
    )("↑/↓")}${dim("]")} scroll`,
  });

  footer.add(footerText);

  root.add(header);
  root.add(statusBox);
  root.add(logsBox);
  root.add(footer);
  activeRenderer.root.add(root);

  const shutdown = async () => {
    if (!isActive) {
      return;
    }
    isActive = false;
    if (statusTimer) {
      clearInterval(statusTimer);
      statusTimer = null;
    }
    if (auditTimer) {
      clearInterval(auditTimer);
      auditTimer = null;
    }
    activeRenderer.stop();
    activeRenderer.destroy();
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  };

  const handleSignal = () => {
    void shutdown();
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  activeRenderer.keyInput.on("keypress", (key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      key.preventDefault();
      void shutdown();
    }
  });

  logsScroll.focus();

  const renderHeader = () => {
    const label = "hack remote monitor";
    const projectLabel = opts.project.projectName;
    headerText.content = `${label} — ${projectLabel}`;
  };

  const renderStatus = async () => {
    const snapshot = await collectRemoteStatusSnapshot({
      project: opts.project,
    });
    statusText.content = buildStatusLines({ snapshot }).join("\n");
  };

  const updateAuditLines = async () => {
    const nextLines = await readAuditLines({
      path: auditPath,
      state: auditState,
    });
    if (nextLines.length === 0) {
      return;
    }

    for (const line of nextLines) {
      const formatted = formatAuditLine({ raw: line });
      auditLines.push({ raw: line, formatted });
    }

    if (auditLines.length > maxAuditLines) {
      auditLines.splice(0, auditLines.length - maxAuditLines);
    }

    const rendered = auditLines.map((entry) => entry.formatted).join("\n");
    logsText.content =
      rendered.length > 0 ? rendered : "Waiting for gateway activity...";
    logsText.syncWrapWidth();
  };

  renderHeader();
  await renderStatus();
  statusTimer = setInterval(() => void renderStatus(), 2000);

  await initializeAuditOffset({ path: auditPath, state: auditState });
  auditTimer = setInterval(() => void updateAuditLines(), 800);

  return await new Promise<number>((resolve) => {
    const poll = setInterval(() => {
      if (!isActive) {
        clearInterval(poll);
        resolve(0);
      }
    }, 250);
  });
}

function buildStatusLines(opts: {
  readonly snapshot: RemoteStatusSnapshot;
}): string[] {
  const snapshot = opts.snapshot;
  const projectLabel = snapshot.project.projectId
    ? `${snapshot.project.projectName} (${snapshot.project.projectId})`
    : snapshot.project.projectName;
  const daemonLabel = snapshot.daemonStatus.running
    ? `running (pid ${snapshot.daemonStatus.pid ?? "unknown"})`
    : "stopped";

  const cloudflareLabel = formatCloudflareStatus({
    status: snapshot.cloudflare,
  });

  const lines = [
    `Project: ${projectLabel}`,
    `Gateway: ${snapshot.gatewayEnabled ? "enabled" : "disabled"}  ${snapshot.gatewayUrl}`,
    `Project gateway: ${snapshot.projectGatewayEnabled ? "enabled" : "disabled"}`,
    `Gateway projects: ${snapshot.gatewayProjects.length}`,
    `Allow writes: ${snapshot.gatewayConfig.allowWrites ? "yes" : "no"}`,
    `hackd: ${daemonLabel}`,
    `Cloudflare: ${cloudflareLabel}`,
  ];

  if (!snapshot.globalConfigExists) {
    lines.push(`Gateway config missing: ${resolveGlobalConfigPath()}`);
    lines.push(
      "Create config: hack config set --global 'controlPlane.gateway.port' 7788"
    );
  }

  if (snapshot.gatewayProjects.length > 0) {
    const projects = snapshot.gatewayProjects.map(
      (project) => `${project.projectName} (${project.projectId})`
    );
    lines.push(`Gateway routing: ${projects.join(", ")}`);
  }

  if (snapshot.streamsActive !== undefined) {
    lines.push(`Streams active: ${snapshot.streamsActive}`);
  }

  lines.push(`Audit log: ${auditPathHint()}`);
  return lines;
}

function formatCloudflareStatus(opts: {
  readonly status: CloudflareStatus;
}): string {
  const status = opts.status;
  if (!status.enabled) {
    return "disabled";
  }
  if (!status.hostname) {
    return "enabled (hostname missing)";
  }
  if (status.running === true) {
    return `https://${status.hostname} (running)`;
  }
  if (status.running === false) {
    return `https://${status.hostname} (stopped)`;
  }
  return `https://${status.hostname} (status unknown)`;
}

function auditPathHint(): string {
  const daemonPaths = resolveDaemonPaths({});
  return resolve(daemonPaths.root, "gateway", "audit.jsonl");
}

async function initializeAuditOffset(opts: {
  readonly path: string;
  readonly state: AuditTailState;
}): Promise<void> {
  const stats = await stat(opts.path).catch(() => null);
  if (!stats) {
    return;
  }
  opts.state.offset = stats.size;
  opts.state.buffer = "";
}

async function readAuditLines(opts: {
  readonly path: string;
  readonly state: AuditTailState;
}): Promise<string[]> {
  const stats = await stat(opts.path).catch(() => null);
  if (!stats) {
    return [];
  }
  if (stats.size < opts.state.offset) {
    opts.state.offset = 0;
    opts.state.buffer = "";
  }
  if (stats.size === opts.state.offset) {
    return [];
  }

  const file = Bun.file(opts.path);
  const slice = file.slice(opts.state.offset, stats.size);
  const text = await slice.text();
  opts.state.offset = stats.size;

  const combined = `${opts.state.buffer}${text}`;
  const lines = combined.split("\n");
  opts.state.buffer = lines.pop() ?? "";
  return lines.filter((line) => line.trim().length > 0);
}

function formatAuditLine(opts: { readonly raw: string }): string {
  const entry = parseAuditEntry({ raw: opts.raw });
  if (!entry) {
    return opts.raw;
  }
  const parts = [entry.ts, String(entry.status), entry.method, entry.path];
  if (entry.tokenId) {
    parts.push(`token=${entry.tokenId}`);
  }
  if (entry.remoteAddress) {
    parts.push(`ip=${entry.remoteAddress}`);
  }
  return parts.join(" ");
}

function parseAuditEntry(opts: {
  readonly raw: string;
}): GatewayAuditEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  const ts = typeof parsed.ts === "string" ? parsed.ts : null;
  const method = typeof parsed.method === "string" ? parsed.method : null;
  const path = typeof parsed.path === "string" ? parsed.path : null;
  const status = typeof parsed.status === "number" ? parsed.status : null;
  if (!(ts && method && path) || status === null) {
    return null;
  }

  return {
    ts,
    method,
    path,
    status,
    ...(typeof parsed.tokenId === "string" ? { tokenId: parsed.tokenId } : {}),
    ...(typeof parsed.remoteAddress === "string"
      ? { remoteAddress: parsed.remoteAddress }
      : {}),
    ...(typeof parsed.userAgent === "string"
      ? { userAgent: parsed.userAgent }
      : {}),
  };
}
