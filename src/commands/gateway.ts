import { dirname, resolve } from "node:path";
import type { CliContext, CommandArgs } from "../cli/command.ts";
import {
  CliUsageError,
  defineCommand,
  defineOption,
  withHandler,
} from "../cli/command.ts";
import { optPath, optProject } from "../cli/options.ts";
import {
  HACK_PROJECT_DIR_PRIMARY,
  PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_LEGACY_FILENAME,
} from "../constants.ts";
import { createGatewayToken } from "../control-plane/extensions/gateway/tokens.ts";
import type { ControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { readControlPlaneConfig } from "../control-plane/sdk/config.ts";
import { resolveDaemonPaths } from "../daemon/paths.ts";
import { readDaemonStatus } from "../daemon/status.ts";
import { resolveGlobalConfigPath } from "../lib/config-paths.ts";
import { ensureDir, readTextFile, writeTextFileIfChanged } from "../lib/fs.ts";
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
import {
  gumChooseOne,
  gumConfirm,
  gumInput,
  isGumAvailable,
} from "../ui/gum.ts";
import { logger } from "../ui/logger.ts";
import {
  buildGatewayQrPayload,
  buildSshQrPayload,
  renderQrPayload,
} from "../ui/qr.ts";
import { isTty } from "../ui/terminal.ts";

const gatewaySpec = defineCommand({
  name: "gateway",
  summary: "Manage gateway enablement",
  group: "Extensions",
  options: [],
  positionals: [],
  subcommands: [],
} as const);

const toggleOptions = [optPath, optProject] as const;

const enableSpec = defineCommand({
  name: "enable",
  summary: "Enable the gateway and start hackd",
  group: "Extensions",
  options: toggleOptions,
  positionals: [],
  subcommands: [],
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

const optYes = defineOption({
  name: "yes",
  type: "boolean",
  long: "--yes",
  description: "Skip confirmation prompts when printing QR payloads",
} as const);

const setupOptions = [optPath, optProject, optQr, optNoQr, optYes] as const;

const setupSpec = defineCommand({
  name: "setup",
  summary: "Guided gateway setup (enable + token)",
  group: "Extensions",
  options: setupOptions,
  positionals: [],
  subcommands: [],
} as const);

const disableSpec = defineCommand({
  name: "disable",
  summary: "Disable the gateway (does not stop hackd)",
  group: "Extensions",
  options: toggleOptions,
  positionals: [],
  subcommands: [],
} as const);

type ToggleArgs = CommandArgs<typeof toggleOptions, readonly []>;
type SetupArgs = CommandArgs<typeof setupOptions, readonly []>;

const gatewayCommand = defineCommand({
  ...gatewaySpec,
  subcommands: [
    withHandler(enableSpec, handleGatewayEnable),
    withHandler(setupSpec, handleGatewaySetup),
    withHandler(disableSpec, handleGatewayDisable),
  ],
} as const);

export { gatewayCommand };

async function handleGatewayEnable({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: ToggleArgs;
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });

  const updated = await setGatewayEnabled({ project, enabled: true });
  if (!updated.ok) {
    logger.error({ message: updated.error });
    return 1;
  }

  const enableExtension = await setExtensionEnabled({
    scope: "global",
    extensionId: "dance.hack.gateway",
    enabled: true,
  });
  if (!enableExtension.ok) {
    logger.warn({ message: enableExtension.error });
  }

  logger.success({
    message: updated.changed ? "Gateway enabled." : "Gateway already enabled.",
  });
  return await startDaemon();
}

async function handleGatewaySetup({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: SetupArgs;
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });

  const identity = await resolveProjectIdentityForQr({ project });

  await display.panel({
    title: "Gateway setup",
    tone: "info",
    lines: [
      `Project: ${identity.projectName}`,
      "One-command remote setup (gateway + token + exposure).",
      "Steps:",
      "1) Enable gateway for this project",
      "2) Optionally enable writes for shells/jobs",
      "3) Start/restart hackd",
      "4) Create a token + QR for remote access",
      "5) Choose an exposure option (Cloudflare/Tailscale/SSH)",
    ],
  });

  const currentConfig = await readControlPlaneConfig({
    projectDir: project.projectDir,
  });
  const allowWritesCurrent = currentConfig.config.gateway.allowWrites;

  const updated = await setGatewayEnabled({ project, enabled: true });
  if (!updated.ok) {
    logger.error({ message: updated.error });
    return 1;
  }

  const enableExtension = await setExtensionEnabled({
    scope: "global",
    extensionId: "dance.hack.gateway",
    enabled: true,
  });
  if (!enableExtension.ok) {
    logger.warn({ message: enableExtension.error });
  }

  if (updated.changed) {
    logger.success({ message: "Gateway enabled." });
  } else {
    logger.info({ message: "Gateway already enabled." });
  }

  let allowWrites = allowWritesCurrent;
  if (!allowWritesCurrent && isTty() && isGumAvailable()) {
    const confirmed = await gumConfirm({
      prompt:
        "Enable write access for jobs/shells? (recommended for remote shell)",
      default: false,
    });
    if (confirmed.ok && confirmed.value) {
      allowWrites = true;
    }
  }

  let allowWritesChanged = false;
  if (allowWrites && !allowWritesCurrent) {
    const writeUpdate = await setGatewayAllowWrites({ allowWrites: true });
    if (!writeUpdate.ok) {
      logger.error({ message: writeUpdate.error });
      return 1;
    }
    allowWritesChanged = writeUpdate.changed;
    if (writeUpdate.changed) {
      logger.success({ message: "Gateway writes enabled." });
    }
  }

  if (!(allowWrites || allowWritesCurrent)) {
    logger.info({
      message:
        "Gateway writes remain disabled (shell/jobs require allowWrites + write token).",
    });
  }

  const extensionChanged = enableExtension.ok ? enableExtension.changed : false;
  if (updated.changed || allowWritesChanged || extensionChanged) {
    const restart = await restartDaemon();
    if (restart !== 0) {
      return restart;
    }
  } else {
    await startDaemon({
      onRunningMessage: "hackd already running; no restart needed.",
    });
  }

  const scope = await resolveGatewayTokenScope({
    allowWrites,
  });
  const label = await resolveGatewayTokenLabel();

  const paths = resolveDaemonPaths({});
  const issued = await createGatewayToken({
    rootDir: paths.root,
    ...(label ? { label } : {}),
    scope,
  });

  await display.kv({
    title: "Gateway token",
    entries: [
      ["id", issued.record.id],
      ["label", issued.record.label ?? ""],
      ["scope", issued.record.scope],
      ["created_at", issued.record.createdAt],
      ["token", issued.token],
    ],
  });

  logger.info({
    message: "Store this token securely; it cannot be recovered once lost.",
  });
  logger.info({ message: "Export it as HACK_GATEWAY_TOKEN for future use." });

  let finalConfig = await readControlPlaneConfig({
    projectDir: project.projectDir,
  });

  const exposurePlan = await runExposureWizard({
    project,
    config: finalConfig.config,
  });

  if (exposurePlan.configChanged) {
    finalConfig = await readControlPlaneConfig({
      projectDir: project.projectDir,
    });
  }

  const gatewayUrl = resolveGatewayUrlForQr({
    config: finalConfig.config,
    override: exposurePlan.gatewayUrlOverride,
  });

  const printQr = args.options.noQr !== true;

  if (printQr) {
    if (exposurePlan.sshQrPayload) {
      await renderQrPayload({
        label: "SSH",
        payload: exposurePlan.sshQrPayload,
        sensitive: false,
        yes: true,
      });
    }

    const payload = buildGatewayQrPayload({
      baseUrl: gatewayUrl,
      token: issued.token,
      projectId: identity.projectId,
    });
    await renderQrPayload({
      label: "Gateway",
      payload,
      sensitive: true,
      yes: args.options.yes === true,
    });
  }

  await display.panel({
    title: "Next steps",
    tone: "info",
    lines: [
      `Gateway URL: ${gatewayUrl}`,
      "Remote status: hack remote status",
      "Remote shell: hack x supervisor shell --token <token> (write scope required)",
      "Expose gateway for off-network access (Cloudflare/Tailscale/SSH)",
    ],
  });
  await renderExposureHints({
    config: finalConfig.config,
    projectName: identity.projectName,
  });
  return 0;
}

async function handleGatewayDisable({
  ctx,
  args,
}: {
  readonly ctx: CliContext;
  readonly args: ToggleArgs;
}): Promise<number> {
  const project = await resolveProjectForArgs({
    ctx,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });

  const updated = await setGatewayEnabled({ project, enabled: false });
  if (!updated.ok) {
    logger.error({ message: updated.error });
    return 1;
  }

  logger.success({
    message: updated.changed
      ? "Gateway disabled."
      : "Gateway already disabled.",
  });
  return 0;
}

type ExposureMode = "local" | "cloudflare" | "tailscale" | "ssh";

type ExposurePlan = {
  readonly mode: ExposureMode;
  readonly gatewayUrlOverride?: string;
  readonly sshQrPayload?: string;
  readonly configChanged: boolean;
};

async function runExposureWizard(opts: {
  readonly project: ProjectContext;
  readonly config: ControlPlaneConfig;
}): Promise<ExposurePlan> {
  if (!(isTty() && isGumAvailable())) {
    return { mode: "local", configChanged: false };
  }

  const choice = await gumChooseOne({
    header: "How will you connect remotely?",
    options: [
      "Cloudflare Tunnel (HTTPS gateway, recommended for mobile)",
      "Tailscale (tailnet access)",
      "SSH tunnel (port forward)",
      "Skip (local only for now)",
    ],
    selectIfOne: true,
  });

  if (!choice.ok) {
    return { mode: "local", configChanged: false };
  }

  const selection = choice.value;
  if (selection.startsWith("Cloudflare")) {
    return await configureCloudflareExposure({
      project: opts.project,
      config: opts.config,
    });
  }

  if (selection.startsWith("Tailscale")) {
    return await configureTailscaleExposure({
      project: opts.project,
      config: opts.config,
    });
  }

  if (selection.startsWith("SSH")) {
    return await configureSshExposure({ config: opts.config });
  }

  return { mode: "local", configChanged: false };
}

async function configureCloudflareExposure(opts: {
  readonly project: ProjectContext;
  readonly config: ControlPlaneConfig;
}): Promise<ExposurePlan> {
  const existingHost = getString(
    opts.config.extensions["dance.hack.cloudflare"]?.config ?? {},
    "hostname"
  );
  const existingSshHost = getString(
    opts.config.extensions["dance.hack.cloudflare"]?.config ?? {},
    "sshHostname"
  );
  const existingSshOrigin = getString(
    opts.config.extensions["dance.hack.cloudflare"]?.config ?? {},
    "sshOrigin"
  );

  const hostname = await promptHostname({
    label: "Cloudflare hostname",
    placeholder: "gateway.example.com",
    initial: existingHost,
  });

  if (!hostname) {
    logger.warn({ message: "Cloudflare selected but no hostname provided." });
    return { mode: "cloudflare", configChanged: false };
  }

  const sshHostname = await promptHostname({
    label: "Cloudflare SSH hostname (optional)",
    placeholder: "ssh.example.com",
    initial: existingSshHost,
  });
  let sshOrigin: string | null = null;
  if (sshHostname) {
    const defaultPort = parseSshOriginPort(existingSshOrigin) ?? 22;
    const sshPort = await promptNumber({
      label: "SSH port for tunnel (default 22)",
      fallback: defaultPort,
    });
    sshOrigin = `ssh://127.0.0.1:${sshPort}`;
  }

  let configChanged = false;
  const enableResult = await setExtensionEnabled({
    scope: "global",
    extensionId: "dance.hack.cloudflare",
    enabled: true,
  });
  if (!enableResult.ok) {
    logger.warn({ message: enableResult.error });
  } else if (enableResult.changed) {
    configChanged = true;
  }

  const hostnameResult = await setExtensionConfigValue({
    scope: "global",
    extensionId: "dance.hack.cloudflare",
    path: ["hostname"],
    value: hostname,
  });
  if (!hostnameResult.ok) {
    logger.warn({ message: hostnameResult.error });
  } else if (hostnameResult.changed) {
    configChanged = true;
  }

  if (sshHostname && sshOrigin) {
    const sshHostnameResult = await setExtensionConfigValue({
      scope: "global",
      extensionId: "dance.hack.cloudflare",
      path: ["sshHostname"],
      value: sshHostname,
    });
    if (!sshHostnameResult.ok) {
      logger.warn({ message: sshHostnameResult.error });
    } else if (sshHostnameResult.changed) {
      configChanged = true;
    }

    const sshOriginResult = await setExtensionConfigValue({
      scope: "global",
      extensionId: "dance.hack.cloudflare",
      path: ["sshOrigin"],
      value: sshOrigin,
    });
    if (!sshOriginResult.ok) {
      logger.warn({ message: sshOriginResult.error });
    } else if (sshOriginResult.changed) {
      configChanged = true;
    }
  }

  const runSetup = await gumConfirm({
    prompt: "Run Cloudflare tunnel setup now?",
    default: true,
  });
  if (runSetup.ok && runSetup.value) {
    await runHackCommand({
      cwd: opts.project.projectRoot,
      args: [
        "x",
        "cloudflare",
        "tunnel-setup",
        "--hostname",
        hostname,
        ...(sshHostname ? ["--ssh-hostname", sshHostname] : []),
        ...(sshOrigin ? ["--ssh-origin", sshOrigin] : []),
      ],
    });

    const runStart = await gumConfirm({
      prompt: "Start the Cloudflare tunnel now?",
      default: true,
    });
    if (runStart.ok && runStart.value) {
      await runHackCommand({
        cwd: opts.project.projectRoot,
        args: ["x", "cloudflare", "tunnel-start"],
      });
    }
  }

  return {
    mode: "cloudflare",
    gatewayUrlOverride: `https://${hostname}`,
    configChanged,
  };
}

async function configureTailscaleExposure(opts: {
  readonly project: ProjectContext;
  readonly config: ControlPlaneConfig;
}): Promise<ExposurePlan> {
  let configChanged = false;
  const enableResult = await setExtensionEnabled({
    scope: "global",
    extensionId: "dance.hack.tailscale",
    enabled: true,
  });
  if (!enableResult.ok) {
    logger.warn({ message: enableResult.error });
  } else if (enableResult.changed) {
    configChanged = true;
  }

  await runHackCommand({
    cwd: opts.project.projectRoot,
    args: ["x", "tailscale", "setup"],
  });

  const host = await promptHostname({
    label: "Tailnet hostname (optional for QR)",
    placeholder: "device.tailnet.ts.net",
  });

  const port = opts.config.gateway.port;
  const gatewayUrlOverride = host ? `http://${host}:${port}` : undefined;

  if (host) {
    await display.panel({
      title: "Tailscale note",
      tone: "info",
      lines: [
        "Make sure the gateway is reachable on this host.",
        "Options:",
        `- tailscale serve tcp ${port} 127.0.0.1:${port}`,
        "- or set controlPlane.gateway.bind = 0.0.0.0 and restart hackd",
      ],
    });
  }

  return {
    mode: "tailscale",
    gatewayUrlOverride,
    configChanged,
  };
}

async function configureSshExposure(opts: {
  readonly config: ControlPlaneConfig;
}): Promise<ExposurePlan> {
  const host = await promptHostname({
    label: "SSH host",
    placeholder: "ssh.example.com",
  });
  if (!host) {
    logger.warn({ message: "SSH selected but no host provided." });
    return { mode: "ssh", configChanged: false };
  }

  const user = await promptText({
    label: "SSH user (optional)",
    placeholder: process.env.USER ?? "",
  });
  const port = await promptNumber({
    label: "SSH port (default 22)",
    fallback: 22,
  });

  const sshQrPayload = buildSshQrPayload({
    host,
    user: user || undefined,
    port,
  });

  return {
    mode: "ssh",
    gatewayUrlOverride: `http://127.0.0.1:${opts.config.gateway.port}`,
    sshQrPayload,
    configChanged: false,
  };
}

async function promptHostname(opts: {
  readonly label: string;
  readonly placeholder?: string;
  readonly initial?: string;
}): Promise<string | null> {
  const result = await gumInput({
    prompt: `${opts.label}: `,
    placeholder: opts.placeholder,
    value: opts.initial,
  });
  if (!result.ok) {
    return null;
  }
  const trimmed = result.value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function promptText(opts: {
  readonly label: string;
  readonly placeholder?: string;
}): Promise<string> {
  const result = await gumInput({
    prompt: `${opts.label}: `,
    placeholder: opts.placeholder,
  });
  if (!result.ok) {
    return "";
  }
  return result.value.trim();
}

async function promptNumber(opts: {
  readonly label: string;
  readonly fallback: number;
}): Promise<number> {
  const result = await gumInput({
    prompt: `${opts.label}: `,
    placeholder: String(opts.fallback),
  });
  if (!result.ok) {
    return opts.fallback;
  }
  const trimmed = result.value.trim();
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : opts.fallback;
}

function parseSshOriginPort(origin: string | undefined): number | null {
  if (!origin) {
    return null;
  }
  try {
    const url = new URL(origin);
    if (!url.port) {
      return null;
    }
    const parsed = Number.parseInt(url.port, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function resolveProjectForArgs(opts: {
  readonly ctx: CliContext;
  readonly pathOpt: string | undefined;
  readonly projectOpt: string | undefined;
}): Promise<ProjectContext> {
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
    await touchProjectRegistration(fromRegistry);
    return fromRegistry;
  }

  const startDir = opts.pathOpt
    ? resolve(opts.ctx.cwd, opts.pathOpt)
    : opts.ctx.cwd;
  const project = await requireProjectContext(startDir);
  await touchProjectRegistration(project);
  return project;
}

async function requireProjectContext(
  startDir: string
): Promise<ProjectContext> {
  const ctx = await findProjectContext(startDir);
  if (!ctx) {
    throw new Error(
      `No ${HACK_PROJECT_DIR_PRIMARY}/ (or legacy .dev/) found. Run: hack init`
    );
  }
  return ctx;
}

async function touchProjectRegistration(
  project: ProjectContext
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

async function resolveProjectIdentityForQr(opts: {
  readonly project: ProjectContext;
}): Promise<{ readonly projectId?: string; readonly projectName: string }> {
  const config = await readProjectConfig(opts.project);
  const defaultName = defaultProjectSlugFromPath(opts.project.projectRoot);
  const projectName = (config.name ?? "").trim() || defaultName;

  const outcome = await upsertProjectRegistration({ project: opts.project });
  if (outcome.status === "conflict") {
    return { projectName };
  }

  return { projectId: outcome.project.id, projectName: outcome.project.name };
}

type ConfigReadResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly value: Record<string, unknown>;
    }
  | { readonly ok: false; readonly error: string };

async function readConfigJsonForGateway(opts: {
  readonly scope: "project" | "global";
  readonly project?: ProjectContext;
  readonly allowMissing?: boolean;
}): Promise<ConfigReadResult> {
  if (opts.scope === "global") {
    const jsonPath = resolveGlobalConfigPath();
    const jsonText = await readTextFile(jsonPath);
    if (jsonText === null) {
      if (opts.allowMissing) {
        return { ok: true, path: jsonPath, value: {} };
      }
      return {
        ok: false,
        error: `Missing global config at ${jsonPath}. Run: hack config set --global <key> <value>`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Invalid JSON";
      return { ok: false, error: `Failed to parse ${jsonPath}: ${message}` };
    }

    if (!isRecord(parsed)) {
      return { ok: false, error: `Expected ${jsonPath} to be an object.` };
    }

    return { ok: true, path: jsonPath, value: parsed };
  }

  if (!opts.project) {
    return {
      ok: false,
      error: "Missing project context to update gateway config.",
    };
  }

  const jsonPath = resolve(opts.project.projectDir, PROJECT_CONFIG_FILENAME);
  const jsonText = await readTextFile(jsonPath);
  if (jsonText === null) {
    const tomlPath = resolve(
      opts.project.projectDir,
      PROJECT_CONFIG_LEGACY_FILENAME
    );
    const tomlText = await readTextFile(tomlPath);
    if (tomlText !== null) {
      return {
        ok: false,
        error: `Legacy config found at ${tomlPath}. Convert to ${PROJECT_CONFIG_FILENAME} to use gateway commands.`,
      };
    }
    return {
      ok: false,
      error: `Missing ${PROJECT_CONFIG_FILENAME}. Run: hack init`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    return { ok: false, error: `Failed to parse ${jsonPath}: ${message}` };
  }

  if (!isRecord(parsed)) {
    return { ok: false, error: `Expected ${jsonPath} to be an object.` };
  }

  return { ok: true, path: jsonPath, value: parsed };
}

async function setGatewayEnabled(opts: {
  readonly project: ProjectContext;
  readonly enabled: boolean;
}): Promise<
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly error: string }
> {
  const read = await readConfigJsonForGateway({
    scope: "project",
    project: opts.project,
  });
  if (!read.ok) {
    return read;
  }

  const update = setPathValue({
    target: read.value,
    path: ["controlPlane", "gateway", "enabled"],
    value: opts.enabled,
  });
  if (update.error) {
    return { ok: false, error: update.error };
  }

  const nextText = `${JSON.stringify(read.value, null, 2)}\n`;
  const writeResult = await writeTextFileIfChanged(read.path, nextText);
  return { ok: true, changed: writeResult.changed };
}

async function setGatewayAllowWrites(opts: {
  readonly allowWrites: boolean;
}): Promise<
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly error: string }
> {
  const read = await readConfigJsonForGateway({
    scope: "global",
    allowMissing: true,
  });
  if (!read.ok) {
    return read;
  }

  const result = setPathValue({
    target: read.value,
    path: ["controlPlane", "gateway", "allowWrites"],
    value: opts.allowWrites,
  });
  if (result.error) {
    return { ok: false, error: result.error };
  }

  await ensureDir(dirname(read.path));
  const nextText = `${JSON.stringify(read.value, null, 2)}\n`;
  const update = await writeTextFileIfChanged(read.path, nextText);
  return { ok: true, changed: update.changed };
}

function setPathValue(opts: {
  readonly target: Record<string, unknown>;
  readonly path: readonly string[];
  readonly value: unknown;
}): { readonly error?: string } {
  let current: Record<string, unknown> = opts.target;
  for (let i = 0; i < opts.path.length - 1; i += 1) {
    const key = opts.path[i] ?? "";
    const existing = current[key];
    if (existing === undefined) {
      const next: Record<string, unknown> = {};
      current[key] = next;
      current = next;
      continue;
    }
    if (!isRecord(existing)) {
      return {
        error: `Cannot set ${opts.path.join(".")}: ${opts.path.slice(0, i + 1).join(".")} is not an object.`,
      };
    }
    current = existing;
  }

  const lastKey = opts.path.at(-1) ?? "";
  current[lastKey] = opts.value;
  return {};
}

async function setExtensionEnabled(opts: {
  readonly scope: "project" | "global";
  readonly project?: ProjectContext;
  readonly extensionId: string;
  readonly enabled: boolean;
}): Promise<
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly error: string }
> {
  const read = await readConfigJsonForGateway({
    scope: opts.scope,
    project: opts.project,
    allowMissing: opts.scope === "global",
  });
  if (!read.ok) {
    return read;
  }

  const result = setPathValue({
    target: read.value,
    path: ["controlPlane", "extensions", opts.extensionId, "enabled"],
    value: opts.enabled,
  });
  if (result.error) {
    return { ok: false, error: result.error };
  }

  await ensureDir(dirname(read.path));
  const nextText = `${JSON.stringify(read.value, null, 2)}\n`;
  const update = await writeTextFileIfChanged(read.path, nextText);
  return { ok: true, changed: update.changed };
}

async function setExtensionConfigValue(opts: {
  readonly scope: "project" | "global";
  readonly project?: ProjectContext;
  readonly extensionId: string;
  readonly path: readonly string[];
  readonly value: unknown;
}): Promise<
  | { readonly ok: true; readonly changed: boolean }
  | { readonly ok: false; readonly error: string }
> {
  const read = await readConfigJsonForGateway({
    scope: opts.scope,
    project: opts.project,
    allowMissing: opts.scope === "global",
  });
  if (!read.ok) {
    return read;
  }

  const result = setPathValue({
    target: read.value,
    path: [
      "controlPlane",
      "extensions",
      opts.extensionId,
      "config",
      ...opts.path,
    ],
    value: opts.value,
  });
  if (result.error) {
    return { ok: false, error: result.error };
  }

  await ensureDir(dirname(read.path));
  const nextText = `${JSON.stringify(read.value, null, 2)}\n`;
  const update = await writeTextFileIfChanged(read.path, nextText);
  return { ok: true, changed: update.changed };
}

function resolveGatewayUrlForQr(opts: {
  readonly config: ControlPlaneConfig;
  readonly override?: string;
}): string {
  const override = (opts.override ?? "").trim();
  if (override) {
    return override;
  }

  const cloudflareExtension = opts.config.extensions["dance.hack.cloudflare"];
  const config = cloudflareExtension?.config ?? {};
  const hostname = getString(config, "hostname");
  if (hostname && hostname.trim().length > 0) {
    const trimmed = hostname.trim();
    return trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  }

  const bind = opts.config.gateway.bind;
  const host = bind.includes(":") ? `[${bind}]` : bind;
  return `http://${host}:${opts.config.gateway.port}`;
}

async function renderExposureHints(opts: {
  readonly config: ControlPlaneConfig;
  readonly projectName: string;
}): Promise<void> {
  const port = opts.config.gateway.port;
  const bind = opts.config.gateway.bind;
  const exposeHost = resolveExposeHost({ bind });

  const lines: string[] = [
    "Pick one to expose the gateway:",
    "SSH (ad-hoc, local port forward):",
    `  ssh -L ${port}:${exposeHost}:${port} <user>@<host>`,
    "Cloudflare Tunnel (Zero Trust, good for phones):",
    buildCloudflareHint({ config: opts.config, projectName: opts.projectName }),
    "Tailscale (VPN, good for SSH access):",
    buildTailscaleHint({ config: opts.config }),
  ];
  const cloudflareSshHint = buildCloudflareSshHint({ config: opts.config });
  if (cloudflareSshHint) {
    lines.splice(5, 0, cloudflareSshHint);
  }

  await display.panel({
    title: "Expose gateway",
    tone: "info",
    lines,
  });
}

function resolveExposeHost(opts: { readonly bind: string }): string {
  const trimmed = opts.bind.trim();
  const host =
    trimmed === "0.0.0.0" || trimmed === ""
      ? "127.0.0.1"
      : trimmed === "::"
        ? "127.0.0.1"
        : trimmed;
  return host.includes(":") ? `[${host}]` : host;
}

function buildCloudflareHint(opts: {
  readonly config: ControlPlaneConfig;
  readonly projectName: string;
}): string {
  const extension = opts.config.extensions["dance.hack.cloudflare"];
  if (!extension?.enabled) {
    return "  Enable: hack config set --global 'controlPlane.extensions[\"dance.hack.cloudflare\"].enabled' true";
  }

  const hostname = getString(extension.config ?? {}, "hostname");
  if (hostname) {
    return `  Use: https://${hostname} (start with: hack x cloudflare tunnel-start)`;
  }

  return "  Setup: hack x cloudflare tunnel-setup --hostname gateway.example.com";
}

function buildCloudflareSshHint(opts: {
  readonly config: ControlPlaneConfig;
}): string | null {
  const extension = opts.config.extensions["dance.hack.cloudflare"];
  if (!extension?.enabled) {
    return null;
  }
  const sshHostname = getString(extension.config ?? {}, "sshHostname");
  if (!sshHostname) {
    return null;
  }
  return `  SSH: cloudflared access ssh --hostname ${sshHostname}`;
}

function buildTailscaleHint(opts: {
  readonly config: ControlPlaneConfig;
}): string {
  const extension = opts.config.extensions["dance.hack.tailscale"];
  if (!extension?.enabled) {
    return "  Enable: hack config set --global 'controlPlane.extensions[\"dance.hack.tailscale\"].enabled' true";
  }

  return "  Setup: hack x tailscale setup";
}

async function resolveGatewayTokenScope(opts: {
  readonly allowWrites: boolean;
}): Promise<"read" | "write"> {
  if (!opts.allowWrites) {
    return "read";
  }
  if (!(isTty() && isGumAvailable())) {
    return "write";
  }

  const choice = await gumChooseOne({
    header: "Token scope",
    options: ["write", "read"],
    selectIfOne: true,
  });
  if (!choice.ok) {
    return "write";
  }
  return choice.value === "read" ? "read" : "write";
}

async function resolveGatewayTokenLabel(): Promise<string | undefined> {
  if (!(isTty() && isGumAvailable())) {
    return undefined;
  }
  const label = await gumInput({
    prompt: "Token label (optional):",
    placeholder: "e.g. phone, agent, laptop",
  });
  if (!label.ok) {
    return undefined;
  }
  return label.value.trim() || undefined;
}

async function startDaemon(opts?: {
  readonly onRunningMessage?: string;
}): Promise<number> {
  const paths = resolveDaemonPaths({});
  const status = await readDaemonStatus({ paths });
  if (status.running) {
    logger.info({
      message:
        opts?.onRunningMessage ??
        "hackd already running; restart to apply gateway config.",
    });
    return 0;
  }

  const invocation = await resolveHackInvocation();
  const cmd = [...invocation.args, "daemon", "start"];
  const proc = Bun.spawn([invocation.bin, ...cmd], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}

async function restartDaemon(): Promise<number> {
  const invocation = await resolveHackInvocation();
  const stop = Bun.spawn(
    [invocation.bin, ...invocation.args, "daemon", "stop"],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    }
  );
  const stopExit = await stop.exited;
  if (stopExit !== 0) {
    logger.warn({
      message: "hackd stop did not exit cleanly; continuing with start.",
    });
  }

  const start = Bun.spawn(
    [invocation.bin, ...invocation.args, "daemon", "start"],
    {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    }
  );
  return await start.exited;
}

async function runHackCommand(opts: {
  readonly cwd: string;
  readonly args: readonly string[];
}): Promise<number> {
  const invocation = await resolveHackInvocation();
  const proc = Bun.spawn([invocation.bin, ...invocation.args, ...opts.args], {
    cwd: opts.cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await proc.exited;
}
