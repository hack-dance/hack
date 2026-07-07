import { homedir } from "node:os";
import { resolve } from "node:path";
import { GLOBAL_CLOUDFLARE_DIR_NAME } from "../../../constants.ts";
import {
  isProcessRunning,
  removeFileIfExists,
  waitForProcessExit,
} from "../../../daemon/process.ts";
import { resolveGlobalHackDir } from "../../../lib/config-paths.ts";
import {
  ensureDir,
  pathExists,
  readTextFile,
  writeTextFile,
  writeTextFileIfChanged,
} from "../../../lib/fs.ts";
import { getString, isRecord } from "../../../lib/guards.ts";
import { display } from "../../../ui/display.ts";
import type { ControlPlaneConfig } from "../../sdk/config.ts";
import { readControlPlaneConfig } from "../../sdk/config.ts";
import { resolveGatewayConfig } from "../gateway/config.ts";
import type { ExtensionCommand, ExtensionCommandContext } from "../types.ts";

type CloudflareExtensionConfig = {
  readonly hostname?: string;
  readonly tunnel?: string;
  readonly origin?: string;
  readonly sshHostname?: string;
  readonly sshOrigin?: string;
  readonly credentialsFile?: string;
};

type TunnelPrintArgs = {
  hostname?: string;
  tunnel?: string;
  origin?: string;
  sshHostname?: string;
  sshOrigin?: string;
  credentialsFile?: string;
  out?: string;
};

type TunnelSetupArgs = TunnelPrintArgs & {
  skipLogin: boolean;
  skipCreate: boolean;
  skipRoute: boolean;
};

type TunnelStartArgs = {
  config?: string;
  tunnel?: string;
};

type ParseResult =
  | { readonly ok: true; readonly value: TunnelPrintArgs }
  | { readonly ok: false; readonly error: string };

type SetupParseResult =
  | { readonly ok: true; readonly value: TunnelSetupArgs }
  | { readonly ok: false; readonly error: string };

type StartParseResult =
  | { readonly ok: true; readonly value: TunnelStartArgs }
  | { readonly ok: false; readonly error: string };

type AccessSetupArgs = {
  sshHostname?: string;
  user?: string;
};

type AccessSetupParseResult =
  | { readonly ok: true; readonly value: AccessSetupArgs }
  | { readonly ok: false; readonly error: string };

const DEFAULT_ORIGIN = "http://127.0.0.1:7788";
const DEFAULT_SSH_ORIGIN = "ssh://127.0.0.1:22";
const DEFAULT_TUNNEL = "hack-gateway";
const DEFAULT_CONFIG_PATH = "~/.cloudflared/config.yml";
const CLOUDFLARED_PID_FILENAME = "cloudflared.pid";

export const CLOUDFLARE_COMMANDS: readonly ExtensionCommand[] = [
  {
    name: "tunnel-print",
    summary: "Print a cloudflared config for the gateway",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const parsed = parseTunnelPrintArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const defaultOrigin = await resolveDefaultOrigin();
      const globalConfig = (await readControlPlaneConfig({})).config;
      const config = resolveTunnelConfig({
        controlPlaneConfig: globalConfig,
        overrides: parsed.value,
        defaultOrigin,
      });
      if (!config.hostname) {
        ctx.logger.error({
          message:
            "Missing hostname. Use --hostname or set global config: hack config set --global 'controlPlane.extensions[\"dance.hack.cloudflare\"].config.hostname' <host>.",
        });
        return 1;
      }

      const yaml = renderCloudflaredConfig({
        tunnel: config.tunnel,
        hostname: config.hostname,
        origin: config.origin,
        ...(config.sshHostname ? { sshHostname: config.sshHostname } : {}),
        ...(config.sshOrigin ? { sshOrigin: config.sshOrigin } : {}),
        ...(config.credentialsFile
          ? { credentialsFile: config.credentialsFile }
          : {}),
      });

      const outPath = config.out ? resolve(ctx.cwd, config.out) : null;
      if (outPath) {
        const result = await writeTextFileIfChanged(outPath, `${yaml}\n`);
        ctx.logger.success({
          message: result.changed
            ? `Wrote ${outPath}`
            : `No changes needed: ${outPath}`,
        });
      } else {
        process.stdout.write(`${yaml}\n`);
      }

      const nextSteps = buildNextSteps({
        hostname: config.hostname,
        tunnel: config.tunnel,
        outPath: outPath ?? "<path-to-config.yml>",
        credentialsFile: config.credentialsFile,
        ...(config.sshHostname ? { sshHostname: config.sshHostname } : {}),
      });

      await display.panel({
        title: "Cloudflare tunnel setup",
        tone: "info",
        lines: nextSteps,
      });
      return 0;
    },
  },
  {
    name: "tunnel-setup",
    summary: "Create a Cloudflare tunnel and write config",
    scope: "global",
    handler: handleTunnelSetup,
  },
  {
    name: "tunnel-start",
    summary: "Start a Cloudflare tunnel in the background",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const parsed = parseTunnelStartArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const defaultOrigin = await resolveDefaultOrigin();
      const globalConfig = (await readControlPlaneConfig({})).config;
      const config = resolveTunnelConfig({
        controlPlaneConfig: globalConfig,
        overrides: { tunnel: parsed.value.tunnel },
        defaultOrigin,
      });
      const configPath = resolveOutPath({
        cwd: ctx.cwd,
        raw: parsed.value.config ?? DEFAULT_CONFIG_PATH,
      });

      if (!(await pathExists(configPath))) {
        ctx.logger.error({
          message: `Missing config: ${configPath}. Run tunnel-setup or tunnel-print first.`,
        });
        return 1;
      }

      const check = await ensureCloudflared();
      if (!check.ok) {
        ctx.logger.error({ message: check.error });
        return 1;
      }

      const statePaths = resolveCloudflareStatePaths();
      await ensureDir(statePaths.root);

      const existingPid = await readPidFile({ path: statePaths.pidPath });
      if (existingPid && isProcessRunning({ pid: existingPid })) {
        ctx.logger.info({
          message: `cloudflared already running (pid ${existingPid}).`,
        });
        return 0;
      }

      if (existingPid) {
        await removeFileIfExists({ path: statePaths.pidPath });
      }

      const proc = Bun.spawn(
        ["cloudflared", "tunnel", "--config", configPath, "run", config.tunnel],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          detached: true,
        }
      );
      proc.unref();

      if (!Number.isFinite(proc.pid)) {
        ctx.logger.error({ message: "Failed to start cloudflared." });
        return 1;
      }

      await writePidFile({ path: statePaths.pidPath, pid: proc.pid });
      ctx.logger.success({ message: `cloudflared started (pid ${proc.pid}).` });
      ctx.logger.info({ message: "Stop with: hack x cloudflare tunnel-stop" });
      return 0;
    },
  },
  {
    name: "tunnel-stop",
    summary: "Stop the background Cloudflare tunnel",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const parsed = parseTunnelStopArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const statePaths = resolveCloudflareStatePaths();
      const pid = await readPidFile({ path: statePaths.pidPath });
      if (!pid) {
        ctx.logger.info({ message: "cloudflared is not running." });
        return 0;
      }

      if (!isProcessRunning({ pid })) {
        await removeFileIfExists({ path: statePaths.pidPath });
        ctx.logger.info({ message: "Removed stale cloudflared pid file." });
        return 0;
      }

      try {
        process.kill(pid, "SIGTERM");
      } catch {
        ctx.logger.error({
          message: `Failed to stop cloudflared (pid ${pid}).`,
        });
        return 1;
      }

      const exited = await waitForProcessExit({
        pid,
        timeoutMs: 2000,
        pollMs: 200,
      });
      if (!exited) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          ctx.logger.error({
            message: `Failed to force-stop cloudflared (pid ${pid}).`,
          });
          return 1;
        }
      }

      await removeFileIfExists({ path: statePaths.pidPath });
      ctx.logger.success({ message: `cloudflared stopped (pid ${pid}).` });
      return 0;
    },
  },
  {
    name: "access-setup",
    summary: "Print Cloudflare Access SSH setup steps",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const parsed = parseAccessSetupArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const globalConfig = (await readControlPlaneConfig({})).config;
      const extension = globalConfig.extensions["dance.hack.cloudflare"];
      const configured = extension?.config ?? {};
      const sshHostname =
        parsed.value.sshHostname ?? getString(configured, "sshHostname");
      if (!sshHostname) {
        ctx.logger.error({
          message:
            'Missing ssh hostname. Pass --ssh-hostname or set controlPlane.extensions["dance.hack.cloudflare"].config.sshHostname in the global config.',
        });
        return 1;
      }

      const user = parsed.value.user ?? "<user>";
      const lines = [
        "1) Open Zero Trust: https://one.dash.cloudflare.com/",
        "2) Access → Applications → Add an application → Self-hosted",
        `3) Set hostname: ${sshHostname}`,
        "4) Add an Access policy that allows your identity/device",
        `5) Test (desktop): cloudflared access ssh --hostname ${sshHostname}`,
        "6) Optional SSH config:",
        `   Host ${sshHostname}`,
        `     User ${user}`,
        "     ProxyCommand /opt/homebrew/bin/cloudflared access ssh --hostname %h",
      ];

      await display.panel({
        title: "Cloudflare Access (SSH)",
        tone: "info",
        lines,
      });
      return 0;
    },
  },
];

export function parseTunnelPrintArgs(opts: {
  readonly args: readonly string[];
}): ParseResult {
  const out: TunnelPrintArgs = {};

  for (let i = 0; i < opts.args.length; i += 1) {
    const token = opts.args[i] ?? "";
    if (token === "--") {
      return { ok: true, value: out };
    }

    const parsed = parseTunnelPrintValueFlag({
      token,
      next: opts.args[i + 1],
    });
    if (!parsed.ok) {
      return parsed;
    }

    if (parsed.value) {
      out[parsed.value.key] = normalizeValue(parsed.value.rawValue);
      i += parsed.value.consume;
      continue;
    }

    if (token.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${token}` };
    }

    return { ok: false, error: `Unexpected argument: ${token}` };
  }

  return { ok: true, value: out };
}

type TunnelPrintValueFlag = {
  readonly key: keyof TunnelPrintArgs;
  readonly rawValue: string;
  readonly consume: number;
};

type TunnelPrintValueFlagResult =
  | { readonly ok: true; readonly value: TunnelPrintValueFlag | null }
  | { readonly ok: false; readonly error: string };

const TUNNEL_PRINT_VALUE_FLAGS: Record<string, keyof TunnelPrintArgs> = {
  "--hostname": "hostname",
  "--tunnel": "tunnel",
  "--origin": "origin",
  "--ssh-hostname": "sshHostname",
  "--ssh-origin": "sshOrigin",
  "--credentials-file": "credentialsFile",
  "--out": "out",
};

function parseTunnelPrintValueFlag(opts: {
  readonly token: string;
  readonly next: string | undefined;
}): TunnelPrintValueFlagResult {
  const split = splitFlagToken({ token: opts.token });
  const key = TUNNEL_PRINT_VALUE_FLAGS[split.name];
  if (!key) {
    return { ok: true, value: null };
  }

  if (split.inlineValue !== null) {
    return {
      ok: true,
      value: { key, rawValue: split.inlineValue, consume: 0 },
    };
  }

  const value = takeValueFromNextToken({ value: opts.next });
  if (value === null) {
    return { ok: false, error: `${split.name} requires a value.` };
  }
  return { ok: true, value: { key, rawValue: value, consume: 1 } };
}

function splitFlagToken(opts: { readonly token: string }): {
  readonly name: string;
  readonly inlineValue: string | null;
} {
  const idx = opts.token.indexOf("=");
  if (idx === -1) {
    return { name: opts.token, inlineValue: null };
  }
  return {
    name: opts.token.slice(0, idx),
    inlineValue: opts.token.slice(idx + 1),
  };
}

function takeValueFromNextToken(opts: {
  readonly value: string | undefined;
}): string | null {
  if (!opts.value || opts.value.startsWith("-")) {
    return null;
  }
  return opts.value;
}

async function handleTunnelSetup({
  ctx,
  args,
}: {
  readonly ctx: ExtensionCommandContext;
  readonly args: readonly string[];
}): Promise<number> {
  const parsed = parseTunnelSetupArgs({ args });
  if (!parsed.ok) {
    ctx.logger.error({ message: parsed.error });
    return 1;
  }

  const configResult = await resolveTunnelSetupConfig({
    ctx,
    overrides: parsed.value,
  });
  if (!configResult.ok) {
    ctx.logger.error({ message: configResult.error });
    return 1;
  }

  const check = await ensureCloudflared();
  if (!check.ok) {
    ctx.logger.error({ message: check.error });
    return 1;
  }

  const login = await maybeCloudflaredLogin({
    skipLogin: parsed.value.skipLogin,
  });
  if (!login.ok) {
    ctx.logger.error({ message: login.error });
    return 1;
  }

  const tunnelIdResult = await resolveOrCreateTunnelId({
    tunnel: configResult.value.config.tunnel,
    skipCreate: parsed.value.skipCreate,
  });
  if (!tunnelIdResult.ok) {
    ctx.logger.error({ message: tunnelIdResult.error });
    return 1;
  }

  await maybeRouteDns({
    skipRoute: parsed.value.skipRoute,
    tunnel: configResult.value.config.tunnel,
    hostname: configResult.value.config.hostname,
    sshHostname: configResult.value.config.sshHostname,
    logger: ctx.logger,
  });

  const credentialsFile =
    configResult.value.config.credentialsFile ??
    (await resolveCredentialsFile({ tunnelId: tunnelIdResult.value.tunnelId }));
  const yaml = renderCloudflaredConfig({
    tunnel: tunnelIdResult.value.tunnelId,
    hostname: configResult.value.config.hostname,
    origin: configResult.value.config.origin,
    ...(configResult.value.config.sshHostname
      ? { sshHostname: configResult.value.config.sshHostname }
      : {}),
    ...(configResult.value.config.sshOrigin
      ? { sshOrigin: configResult.value.config.sshOrigin }
      : {}),
    ...(credentialsFile ? { credentialsFile } : {}),
  });

  const result = await writeTextFileIfChanged(
    configResult.value.outPath,
    `${yaml}\n`
  );
  ctx.logger.success({
    message: result.changed
      ? `Wrote ${configResult.value.outPath}`
      : `No changes needed: ${configResult.value.outPath}`,
  });

  await display.panel({
    title: "Next steps",
    tone: "info",
    lines: [
      `Run tunnel: cloudflared tunnel --config ${configResult.value.outPath} run ${configResult.value.config.tunnel}`,
      "Optional: use Cloudflare Access policies to protect the hostname.",
    ],
  });
  return 0;
}

type TunnelSetupConfigResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly config: Required<Pick<CloudflareExtensionConfig, "hostname">> &
          Required<Pick<CloudflareExtensionConfig, "tunnel" | "origin">> &
          CloudflareExtensionConfig & { readonly out?: string };
        readonly outPath: string;
      };
    }
  | { readonly ok: false; readonly error: string };

async function resolveTunnelSetupConfig(opts: {
  readonly ctx: ExtensionCommandContext;
  readonly overrides: TunnelPrintArgs;
}): Promise<TunnelSetupConfigResult> {
  const defaultOrigin = await resolveDefaultOrigin();
  const config = resolveTunnelConfig({
    controlPlaneConfig: opts.ctx.controlPlaneConfig,
    overrides: opts.overrides,
    defaultOrigin,
  });
  if (!config.hostname) {
    return {
      ok: false,
      error:
        "Missing hostname. Use --hostname or set global config: hack config set --global 'controlPlane.extensions[\"dance.hack.cloudflare\"].config.hostname' <host>.",
    };
  }

  const outPath = resolveOutPath({
    cwd: opts.ctx.cwd,
    raw: config.out ?? DEFAULT_CONFIG_PATH,
  });

  return {
    ok: true,
    value: {
      config: {
        ...config,
        hostname: config.hostname,
      },
      outPath,
    },
  };
}

async function maybeCloudflaredLogin(opts: {
  readonly skipLogin: boolean;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  if (opts.skipLogin) {
    return { ok: true };
  }

  const login = await runCloudflared({
    args: ["tunnel", "login"],
    inherit: true,
  });
  if (!login.ok) {
    return { ok: false, error: "cloudflared login failed." };
  }
  return { ok: true };
}

async function resolveOrCreateTunnelId(opts: {
  readonly tunnel: string;
  readonly skipCreate: boolean;
}): Promise<
  | { readonly ok: true; readonly value: { readonly tunnelId: string } }
  | { readonly ok: false; readonly error: string }
> {
  let tunnelId = await findTunnelId({ name: opts.tunnel });
  if (!(tunnelId || opts.skipCreate)) {
    const created = await runCloudflared({
      args: ["tunnel", "create", opts.tunnel],
      inherit: true,
    });
    if (!created.ok) {
      return { ok: false, error: "cloudflared tunnel create failed." };
    }
    tunnelId = await findTunnelId({ name: opts.tunnel });
  }

  if (!tunnelId) {
    return { ok: false, error: `Tunnel "${opts.tunnel}" not found.` };
  }

  return { ok: true, value: { tunnelId } };
}

async function maybeRouteDns(opts: {
  readonly skipRoute: boolean;
  readonly tunnel: string;
  readonly hostname: string;
  readonly sshHostname: string | undefined;
  readonly logger: ExtensionCommandContext["logger"];
}): Promise<void> {
  if (opts.skipRoute) {
    return;
  }

  await routeDnsForHostname({
    tunnel: opts.tunnel,
    hostname: opts.hostname,
    logger: opts.logger,
  });

  if (!opts.sshHostname) {
    return;
  }
  await routeDnsForHostname({
    tunnel: opts.tunnel,
    hostname: opts.sshHostname,
    logger: opts.logger,
  });
}

async function routeDnsForHostname(opts: {
  readonly tunnel: string;
  readonly hostname: string;
  readonly logger: ExtensionCommandContext["logger"];
}): Promise<void> {
  const routed = await runCloudflared({
    args: ["tunnel", "route", "dns", opts.tunnel, opts.hostname],
    inherit: true,
  });
  if (!routed.ok) {
    opts.logger.warn({
      message: `cloudflared route dns failed for ${opts.hostname} (it may already exist).`,
    });
  }
}

function parseTunnelSetupArgs(opts: {
  readonly args: readonly string[];
}): SetupParseResult {
  let skipLogin = false;
  let skipCreate = false;
  let skipRoute = false;
  const filtered: string[] = [];

  for (const token of opts.args) {
    if (token === "--skip-login") {
      skipLogin = true;
      continue;
    }
    if (token === "--skip-create") {
      skipCreate = true;
      continue;
    }
    if (token === "--skip-route") {
      skipRoute = true;
      continue;
    }
    filtered.push(token);
  }

  const base = parseTunnelPrintArgs({ args: filtered });
  if (!base.ok) {
    return base;
  }

  return {
    ok: true,
    value: {
      ...base.value,
      skipLogin,
      skipCreate,
      skipRoute,
    },
  };
}

export function parseTunnelStartArgs(opts: {
  readonly args: readonly string[];
}): StartParseResult {
  const out: TunnelStartArgs = {};

  for (let i = 0; i < opts.args.length; i += 1) {
    const token = opts.args[i] ?? "";
    if (token === "--") {
      return { ok: true, value: out };
    }

    const parsed = parseTunnelStartValueFlag({
      token,
      next: opts.args[i + 1],
    });
    if (!parsed.ok) {
      return parsed;
    }

    if (parsed.value) {
      out[parsed.value.key] = normalizeValue(parsed.value.rawValue);
      i += parsed.value.consume;
      continue;
    }

    if (token.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${token}` };
    }

    return { ok: false, error: `Unexpected argument: ${token}` };
  }

  return { ok: true, value: out };
}

type TunnelStartValueFlag = {
  readonly key: keyof TunnelStartArgs;
  readonly rawValue: string;
  readonly consume: number;
};

type TunnelStartValueFlagResult =
  | { readonly ok: true; readonly value: TunnelStartValueFlag | null }
  | { readonly ok: false; readonly error: string };

const TUNNEL_START_VALUE_FLAGS: Record<string, keyof TunnelStartArgs> = {
  "--config": "config",
  "--out": "config",
  "--tunnel": "tunnel",
};

function parseTunnelStartValueFlag(opts: {
  readonly token: string;
  readonly next: string | undefined;
}): TunnelStartValueFlagResult {
  const split = splitFlagToken({ token: opts.token });
  const key = TUNNEL_START_VALUE_FLAGS[split.name];
  if (!key) {
    return { ok: true, value: null };
  }

  if (split.inlineValue !== null) {
    return {
      ok: true,
      value: { key, rawValue: split.inlineValue, consume: 0 },
    };
  }

  const value = takeValueFromNextToken({ value: opts.next });
  if (value === null) {
    return { ok: false, error: `${split.name} requires a value.` };
  }
  return { ok: true, value: { key, rawValue: value, consume: 1 } };
}

export function parseAccessSetupArgs(opts: {
  readonly args: readonly string[];
}): AccessSetupParseResult {
  const out: AccessSetupArgs = {};

  const takeValue = (
    _token: string,
    value: string | undefined
  ): string | null => {
    if (!value || value.startsWith("-")) {
      return null;
    }
    return value;
  };

  for (let i = 0; i < opts.args.length; i += 1) {
    const token = opts.args[i] ?? "";
    if (token === "--") {
      return { ok: true, value: out };
    }

    if (token.startsWith("--ssh-hostname=")) {
      out.sshHostname = normalizeValue(token.slice("--ssh-hostname=".length));
      continue;
    }

    if (token === "--ssh-hostname") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--ssh-hostname requires a value." };
      }
      out.sshHostname = normalizeValue(value);
      i += 1;
      continue;
    }

    if (token.startsWith("--user=")) {
      out.user = normalizeValue(token.slice("--user=".length));
      continue;
    }

    if (token === "--user") {
      const value = takeValue(token, opts.args[i + 1]);
      if (!value) {
        return { ok: false, error: "--user requires a value." };
      }
      out.user = normalizeValue(value);
      i += 1;
      continue;
    }

    if (token.startsWith("-")) {
      return { ok: false, error: `Unknown option: ${token}` };
    }

    return { ok: false, error: `Unexpected argument: ${token}` };
  }

  return { ok: true, value: out };
}

function parseTunnelStopArgs(opts: {
  readonly args: readonly string[];
}): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  if (opts.args.length === 0) {
    return { ok: true };
  }
  const token = opts.args[0] ?? "";
  if (token.startsWith("-")) {
    return { ok: false, error: `Unknown option: ${token}` };
  }
  return { ok: false, error: `Unexpected argument: ${token}` };
}

function resolveTunnelConfig(opts: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly overrides: TunnelPrintArgs;
  readonly defaultOrigin?: string;
}): Required<Pick<CloudflareExtensionConfig, "tunnel" | "origin">> &
  CloudflareExtensionConfig & { readonly out?: string } {
  const configured = readExtensionConfig({
    controlPlaneConfig: opts.controlPlaneConfig,
  });
  const hostname = opts.overrides.hostname ?? configured.hostname;
  const tunnel = opts.overrides.tunnel ?? configured.tunnel ?? DEFAULT_TUNNEL;
  const origin =
    opts.overrides.origin ??
    configured.origin ??
    opts.defaultOrigin ??
    DEFAULT_ORIGIN;
  const sshHostname = opts.overrides.sshHostname ?? configured.sshHostname;
  const sshOrigin =
    opts.overrides.sshOrigin ??
    configured.sshOrigin ??
    (sshHostname ? DEFAULT_SSH_ORIGIN : undefined);
  const credentialsFile =
    opts.overrides.credentialsFile ?? configured.credentialsFile;
  const out = opts.overrides.out;

  return {
    ...(hostname ? { hostname } : {}),
    tunnel,
    origin,
    ...(sshHostname ? { sshHostname } : {}),
    ...(sshOrigin ? { sshOrigin } : {}),
    ...(credentialsFile ? { credentialsFile } : {}),
    ...(out ? { out } : {}),
  };
}

function readExtensionConfig(opts: {
  readonly controlPlaneConfig: ControlPlaneConfig;
}): CloudflareExtensionConfig {
  const raw = opts.controlPlaneConfig.extensions?.["dance.hack.cloudflare"];
  if (!(raw && isRecord(raw))) {
    return {};
  }
  const config = raw.config;
  if (!(config && isRecord(config))) {
    return {};
  }
  return {
    hostname: getString(config, "hostname") ?? undefined,
    tunnel: getString(config, "tunnel") ?? undefined,
    origin: getString(config, "origin") ?? undefined,
    sshHostname: getString(config, "sshHostname") ?? undefined,
    sshOrigin: getString(config, "sshOrigin") ?? undefined,
    credentialsFile: getString(config, "credentialsFile") ?? undefined,
  };
}

function renderCloudflaredConfig(opts: {
  readonly tunnel: string;
  readonly hostname: string;
  readonly origin: string;
  readonly sshHostname?: string;
  readonly sshOrigin?: string;
  readonly credentialsFile?: string;
}): string {
  const ingress: string[] = [
    `  - hostname: ${opts.hostname}`,
    `    service: ${opts.origin}`,
  ];
  if (opts.sshHostname) {
    const sshOrigin = opts.sshOrigin ?? DEFAULT_SSH_ORIGIN;
    ingress.push(`  - hostname: ${opts.sshHostname}`);
    ingress.push(`    service: ${sshOrigin}`);
  }

  const lines = [
    `tunnel: ${opts.tunnel}`,
    ...(opts.credentialsFile
      ? [`credentials-file: ${opts.credentialsFile}`]
      : []),
    "ingress:",
    ...ingress,
    "  - service: http_status:404",
  ];
  return lines.join("\n");
}

function buildNextSteps(opts: {
  readonly hostname: string;
  readonly tunnel: string;
  readonly outPath: string;
  readonly credentialsFile?: string;
  readonly sshHostname?: string;
}): readonly string[] {
  const lines: string[] = [
    "1) Authenticate: cloudflared tunnel login",
    `2) Create tunnel: cloudflared tunnel create ${opts.tunnel}`,
    `3) Route DNS: cloudflared tunnel route dns ${opts.tunnel} ${opts.hostname}`,
  ];

  if (opts.sshHostname) {
    lines.push(
      `4) Route SSH DNS: cloudflared tunnel route dns ${opts.tunnel} ${opts.sshHostname}`
    );
    lines.push(
      "5) SSH connect (desktop): cloudflared access ssh --hostname <ssh-hostname>"
    );
    lines.push(
      "   Or add to ~/.ssh/config: ProxyCommand cloudflared access ssh --hostname %h"
    );
    lines.push(
      `6) Run tunnel: cloudflared tunnel --config ${opts.outPath} run ${opts.tunnel}`
    );
  } else {
    lines.push(
      `4) Run tunnel: cloudflared tunnel --config ${opts.outPath} run ${opts.tunnel}`
    );
  }

  if (!opts.credentialsFile) {
    lines.push(
      "Note: credentials-file is optional if ~/.cloudflared/<tunnel-id>.json exists."
    );
  }

  return lines;
}

function normalizeValue(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveOutPath(opts: {
  readonly cwd: string;
  readonly raw: string;
}): string {
  const raw = opts.raw.trim();
  if (raw.startsWith("~/")) {
    return resolve(homedir(), raw.slice(2));
  }
  return resolve(opts.cwd, raw);
}

async function resolveDefaultOrigin(): Promise<string> {
  const resolved = await resolveGatewayConfig();
  const bind =
    resolved.config.bind === "0.0.0.0" ? "127.0.0.1" : resolved.config.bind;
  const host = bind.includes(":") ? `[${bind}]` : bind;
  return `http://${host}:${resolved.config.port}`;
}

type CloudflareStatePaths = {
  readonly root: string;
  readonly pidPath: string;
};

function resolveCloudflareStatePaths(): CloudflareStatePaths {
  const root = resolve(resolveGlobalHackDir(), GLOBAL_CLOUDFLARE_DIR_NAME);
  return {
    root,
    pidPath: resolve(root, CLOUDFLARED_PID_FILENAME),
  };
}

async function readPidFile(opts: {
  readonly path: string;
}): Promise<number | null> {
  const text = await readTextFile(opts.path);
  if (!text) {
    return null;
  }
  const value = Number.parseInt(text.trim(), 10);
  return Number.isFinite(value) ? value : null;
}

async function writePidFile(opts: {
  readonly path: string;
  readonly pid: number;
}): Promise<void> {
  await writeTextFile(opts.path, `${opts.pid}\n`);
}

async function ensureCloudflared(): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  const result = await runCloudflared({ args: ["--version"], inherit: false });
  if (!result.ok) {
    return {
      ok: false,
      error:
        "cloudflared not found. Install with: brew install cloudflare/cloudflare/cloudflared",
    };
  }
  return { ok: true };
}

async function runCloudflared(opts: {
  readonly args: readonly string[];
  readonly inherit: boolean;
}): Promise<{ readonly ok: boolean; readonly stdout?: string }> {
  const proc = Bun.spawn(["cloudflared", ...opts.args], {
    stdin: opts.inherit ? "inherit" : "ignore",
    stdout: opts.inherit ? "inherit" : "pipe",
    stderr: "inherit",
  });

  const stdout = opts.inherit
    ? undefined
    : await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, ...(stdout ? { stdout } : {}) };
}

async function findTunnelId(opts: {
  readonly name: string;
}): Promise<string | null> {
  const result = await runCloudflared({
    args: ["tunnel", "list", "--output", "json"],
    inherit: false,
  });
  if (!(result.ok && result.stdout)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  for (const item of parsed) {
    if (!isRecord(item)) {
      continue;
    }
    const name = getString(item, "name");
    if (name !== opts.name) {
      continue;
    }
    const id = getString(item, "id");
    if (id) {
      return id;
    }
  }
  return null;
}

async function resolveCredentialsFile(opts: {
  readonly tunnelId: string;
}): Promise<string | undefined> {
  const candidate = resolve(homedir(), ".cloudflared", `${opts.tunnelId}.json`);
  return (await pathExists(candidate)) ? candidate : undefined;
}
