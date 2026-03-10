import { secrets } from "bun";
import { updateGlobalConfig } from "../../../lib/config.ts";
import {
  getRecord,
  getString,
  getStringArray,
  isRecord,
} from "../../../lib/guards.ts";
import { exec, findExecutableInPath } from "../../../lib/shell.ts";
import { display } from "../../../ui/display.ts";

import type { ControlPlaneConfig } from "../../sdk/config.ts";
import type { ExtensionCommand } from "../types.ts";

const TAILSCALE_EXTENSION_ID = "dance.hack.tailscale";
const RAILWAY_EXTENSION_ID = "dance.hack.railway";
const TAILSCALE_OAUTH_SECRET_SERVICE = "hack-node-provider-railway";
const TAILSCALE_OAUTH_TOKEN_URL =
  "https://api.tailscale.com/api/v2/oauth/token";
const DEFAULT_TAILSCALE_OAUTH_AUTH_REF = "tailscale.oauth.default";
const DEFAULT_TAILSCALE_TAILNET = "-";
const DEFAULT_TAILSCALE_KEY_EXPIRY_SECONDS = 3600;

export const TAILSCALE_COMMANDS: readonly ExtensionCommand[] = [
  {
    name: "setup",
    summary: "Print Tailscale setup guidance",
    scope: "global",
    handler: async ({ ctx }) => {
      const check = await ensureTailscale();
      if (!check.ok) {
        ctx.logger.error({ message: check.error });
        return 1;
      }

      const lines = [
        "1) Join tailnet: tailscale up",
        "2) Optional SSH: tailscale up --ssh",
        "3) Confirm status: tailscale status",
        "4) Get IP: tailscale ip -4",
        "5) Use SSH: ssh <user>@<tailscale-ip>",
      ];

      await display.panel({
        title: "Tailscale setup",
        tone: "info",
        lines,
      });
      return 0;
    },
  },
  {
    name: "status",
    summary: "Run tailscale status",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const check = await ensureTailscale();
      if (!check.ok) {
        ctx.logger.error({ message: check.error });
        return 1;
      }
      return await runTailscale({ args: ["status", ...args], inherit: true });
    },
  },
  {
    name: "inspect",
    summary: "Return parsed tailscale status for UI integrations",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ args }) => {
      const parsed = parseInspectArgs({ args });
      if (!parsed.ok) {
        process.stderr.write(`${parsed.error}\n`);
        return 1;
      }
      const payload = await inspectTailscaleStatus();
      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return payload.error ? 1 : 0;
      }

      const entries = [
        ["installed", payload.installed ? "yes" : "no"],
        ["connected", payload.connected ? "yes" : "no"],
        ["backend_state", payload.backendState ?? ""],
        ["tailnet", payload.tailnetName ?? ""],
        ["self", payload.self?.hostname ?? ""],
        ["self_ip", payload.self?.tailscaleIp ?? ""],
        ["peers", String(payload.peers.length)],
        ["online_peers", String(payload.onlinePeerCount)],
        ["exit_nodes", String(payload.exitNodes.length)],
      ] as const;
      await display.kv({
        title: "Tailscale inspect",
        entries,
      });
      if (payload.error) {
        process.stderr.write(`${payload.error}\n`);
        return 1;
      }
      return 0;
    },
  },
  {
    name: "oauth-status",
    summary: "Inspect stored Tailscale OAuth credentials",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      const parsed = parseTailscaleOauthStatusArgs({ args });
      if (!parsed.ok) {
        process.stderr.write(`${parsed.error}\n`);
        return 1;
      }

      const settings = resolveTailscaleOauthSettings({
        controlPlaneConfig: ctx.controlPlaneConfig,
      });
      let payload = buildTailscaleOauthStatusPayload({ settings });
      if (parsed.value.validate && payload.configured) {
        payload = await validateTailscaleOauthPayload({
          payload,
          settings,
        });
      }

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return payload.error ? 1 : 0;
      }

      let validatedValue = "";
      if (typeof payload.validated === "boolean") {
        validatedValue = payload.validated ? "yes" : "no";
      }
      const entries = [
        ["configured", payload.configured ? "yes" : "no"],
        ["client_id", payload.clientId ?? ""],
        ["auth_ref", payload.authRef ?? ""],
        ["tailnet", payload.tailnet ?? ""],
        [
          "key_expiry_seconds",
          typeof payload.keyExpirySeconds === "number"
            ? String(payload.keyExpirySeconds)
            : "",
        ],
        ["validated", validatedValue],
        ["checked_at", payload.checkedAt ?? ""],
        ["token_expires_at", payload.tokenExpiresAt ?? ""],
      ] as const;
      await display.kv({
        title: "Tailscale OAuth status",
        entries,
      });
      if (payload.error) {
        process.stderr.write(`${payload.error}\n`);
        return 1;
      }
      return 0;
    },
  },
  {
    name: "oauth-connect",
    summary: "Save Tailscale OAuth credentials for private node bootstrap",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ args }) => {
      const parsed = parseTailscaleOauthConnectArgs({ args });
      if (!parsed.ok) {
        process.stderr.write(`${parsed.error}\n`);
        return 1;
      }

      const clientId = parsed.value.clientId.trim();
      if (!clientId) {
        process.stderr.write("Missing --client-id <id>.\n");
        return 1;
      }

      const secret = await resolveOauthClientSecret({ parsed: parsed.value });
      if (!secret.ok) {
        process.stderr.write(`${secret.error}\n`);
        return 1;
      }

      const authRef =
        parsed.value.authRef?.trim() || DEFAULT_TAILSCALE_OAUTH_AUTH_REF;
      const tailnet = parsed.value.tailnet?.trim() || DEFAULT_TAILSCALE_TAILNET;
      const keyExpirySeconds = normalizePositiveInteger({
        value: parsed.value.keyExpirySeconds,
        fallback: DEFAULT_TAILSCALE_KEY_EXPIRY_SECONDS,
      });

      await secrets.set({
        service: TAILSCALE_OAUTH_SECRET_SERVICE,
        name: authRef,
        value: secret.clientSecret,
      });

      await persistTailscaleOauthSettings({
        clientId,
        authRef,
        tailnet,
        keyExpirySeconds,
      });

      const payload = await validateTailscaleOauthPayload({
        payload: {
          configured: true,
          clientId,
          authRef,
          tailnet,
          keyExpirySeconds,
        },
        settings: {
          clientId,
          authRef,
          tailnet,
          keyExpirySeconds,
        },
      });

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return payload.error ? 1 : 0;
      }

      const entries = [
        ["configured", payload.configured ? "yes" : "no"],
        ["client_id", payload.clientId ?? ""],
        ["auth_ref", payload.authRef ?? ""],
        ["tailnet", payload.tailnet ?? ""],
        ["key_expiry_seconds", String(payload.keyExpirySeconds ?? "")],
        ["validated", payload.validated === true ? "yes" : "no"],
        ["checked_at", payload.checkedAt ?? ""],
        ["token_expires_at", payload.tokenExpiresAt ?? ""],
      ] as const;
      await display.kv({
        title: "Tailscale OAuth saved",
        entries,
      });
      if (payload.error) {
        process.stderr.write(`${payload.error}\n`);
        return 1;
      }
      return 0;
    },
  },
  {
    name: "oauth-disconnect",
    summary: "Clear stored Tailscale OAuth credentials",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      const parsed = parseTailscaleOauthDisconnectArgs({ args });
      if (!parsed.ok) {
        process.stderr.write(`${parsed.error}\n`);
        return 1;
      }

      const settings = resolveTailscaleOauthSettings({
        controlPlaneConfig: ctx.controlPlaneConfig,
      });
      const authRef =
        parsed.value.authRef?.trim() ||
        settings.authRef ||
        DEFAULT_TAILSCALE_OAUTH_AUTH_REF;
      const deleted = await secrets.delete({
        service: TAILSCALE_OAUTH_SECRET_SERVICE,
        name: authRef,
      });

      await clearTailscaleOauthSettings();

      const payload: TailscaleOauthStatusPayload = {
        configured: false,
        authRef,
        deleted,
        checkedAt: new Date().toISOString(),
      };

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return 0;
      }

      const entries = [
        ["configured", "no"],
        ["auth_ref", authRef],
        ["deleted", deleted ? "yes" : "no"],
      ] as const;
      await display.kv({
        title: "Tailscale OAuth cleared",
        entries,
      });
      return 0;
    },
  },
  {
    name: "ip",
    summary: "Show tailscale IP addresses",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const check = await ensureTailscale();
      if (!check.ok) {
        ctx.logger.error({ message: check.error });
        return 1;
      }
      const cmdArgs = args.length > 0 ? ["ip", ...args] : ["ip", "-4"];
      return await runTailscale({ args: cmdArgs, inherit: true });
    },
  },
];

async function ensureTailscale(): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  const exitCode = await runTailscale({ args: ["--version"], inherit: false });
  if (exitCode !== 0) {
    return {
      ok: false,
      error: "tailscale not found. Install with: brew install tailscale",
    };
  }
  return { ok: true };
}

async function runTailscale(opts: {
  readonly args: readonly string[];
  readonly inherit: boolean;
}): Promise<number> {
  const proc = Bun.spawn(["tailscale", ...opts.args], {
    stdin: opts.inherit ? "inherit" : "ignore",
    stdout: opts.inherit ? "inherit" : "pipe",
    stderr: "inherit",
  });

  if (!opts.inherit) {
    await new Response(proc.stdout).text();
  }

  return await proc.exited;
}

type InspectArgs = {
  readonly json: boolean;
};

type InspectArgsParseResult =
  | { readonly ok: true; readonly value: InspectArgs }
  | { readonly ok: false; readonly error: string };

type TailscaleInspectPeer = {
  readonly id: string;
  readonly hostname: string;
  readonly dnsName?: string;
  readonly tailscaleIp?: string;
  readonly online: boolean;
  readonly os?: string;
  readonly tags: readonly string[];
  readonly isExitNode: boolean;
  readonly isExitNodeOption: boolean;
};

type TailscaleInspectSelf = {
  readonly id: string;
  readonly hostname: string;
  readonly dnsName?: string;
  readonly tailscaleIp?: string;
  readonly online: boolean;
  readonly os?: string;
  readonly tags: readonly string[];
  readonly isExitNode: boolean;
};

type TailscaleInspectPayload = {
  readonly installed: boolean;
  readonly binaryPath?: string;
  readonly connected: boolean;
  readonly backendState?: string;
  readonly tailnetName?: string;
  readonly magicDnsSuffix?: string;
  readonly authUrl?: string;
  readonly currentExitNodeId?: string;
  readonly currentExitNodeName?: string;
  readonly self?: TailscaleInspectSelf;
  readonly peers: readonly TailscaleInspectPeer[];
  readonly onlinePeerCount: number;
  readonly exitNodes: readonly TailscaleInspectPeer[];
  readonly health: readonly string[];
  readonly error?: string;
};

type TailscaleOauthStatusPayload = {
  readonly configured: boolean;
  readonly clientId?: string;
  readonly authRef?: string;
  readonly tailnet?: string;
  readonly keyExpirySeconds?: number;
  readonly validated?: boolean;
  readonly checkedAt?: string;
  readonly tokenExpiresAt?: string;
  readonly deleted?: boolean;
  readonly error?: string;
};

type TailscaleOauthSettings = {
  readonly clientId: string;
  readonly authRef: string;
  readonly tailnet: string;
  readonly keyExpirySeconds: number;
};

type TailscaleOauthStatusArgs = {
  readonly json: boolean;
  readonly validate: boolean;
};

type TailscaleOauthStatusArgsParseResult =
  | { readonly ok: true; readonly value: TailscaleOauthStatusArgs }
  | { readonly ok: false; readonly error: string };

type TailscaleOauthConnectArgs = {
  readonly json: boolean;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly clientSecretStdin: boolean;
  readonly authRef?: string;
  readonly tailnet?: string;
  readonly keyExpirySeconds?: number;
};

type TailscaleOauthConnectArgsParseResult =
  | { readonly ok: true; readonly value: TailscaleOauthConnectArgs }
  | { readonly ok: false; readonly error: string };

type TailscaleOauthDisconnectArgs = {
  readonly json: boolean;
  readonly authRef?: string;
};

type TailscaleOauthDisconnectArgsParseResult =
  | { readonly ok: true; readonly value: TailscaleOauthDisconnectArgs }
  | { readonly ok: false; readonly error: string };

function parseInspectArgs(opts: {
  readonly args: readonly string[];
}): InspectArgsParseResult {
  let json = false;
  for (const token of opts.args) {
    if (token === "--json") {
      json = true;
      continue;
    }
    return {
      ok: false,
      error: `Unknown option: ${token}. Usage: hack x tailscale inspect [--json]`,
    };
  }
  return {
    ok: true,
    value: {
      json,
    },
  };
}

export function parseTailscaleOauthStatusArgs(opts: {
  readonly args: readonly string[];
}): TailscaleOauthStatusArgsParseResult {
  let json = false;
  let validate = false;
  for (const token of opts.args) {
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--validate") {
      validate = true;
      continue;
    }
    return {
      ok: false,
      error: `Unknown option: ${token}. Usage: hack x tailscale oauth-status [--json] [--validate]`,
    };
  }
  return {
    ok: true,
    value: {
      json,
      validate,
    },
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Tailscale OAuth connect parsing models several optional flags, defaults, and validation branches in one parser.
export function parseTailscaleOauthConnectArgs(opts: {
  readonly args: readonly string[];
}): TailscaleOauthConnectArgsParseResult {
  let json = false;
  let clientId = "";
  let clientSecret = "";
  let clientSecretStdin = false;
  let authRef: string | undefined;
  let tailnet: string | undefined;
  let keyExpirySeconds: number | undefined;

  for (let i = 0; i < opts.args.length; i += 1) {
    const token = opts.args[i] ?? "";
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--client-secret-stdin") {
      clientSecretStdin = true;
      continue;
    }

    const next = opts.args[i + 1] ?? "";
    if (token === "--client-id") {
      if (!next) {
        return {
          ok: false,
          error: "Missing value for --client-id.",
        };
      }
      clientId = next;
      i += 1;
      continue;
    }
    if (token === "--client-secret") {
      if (!next) {
        return {
          ok: false,
          error: "Missing value for --client-secret.",
        };
      }
      clientSecret = next;
      i += 1;
      continue;
    }
    if (token === "--auth-ref") {
      if (!next) {
        return {
          ok: false,
          error: "Missing value for --auth-ref.",
        };
      }
      authRef = next;
      i += 1;
      continue;
    }
    if (token === "--tailnet") {
      if (!next) {
        return {
          ok: false,
          error: "Missing value for --tailnet.",
        };
      }
      tailnet = next;
      i += 1;
      continue;
    }
    if (token === "--key-expiry-seconds") {
      if (!next) {
        return {
          ok: false,
          error: "Missing value for --key-expiry-seconds.",
        };
      }
      const parsedValue = Number.parseInt(next, 10);
      if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
        return {
          ok: false,
          error:
            "Invalid value for --key-expiry-seconds (expected positive integer).",
        };
      }
      keyExpirySeconds = Math.trunc(parsedValue);
      i += 1;
      continue;
    }

    return {
      ok: false,
      error: `Unknown option: ${token}. Usage: hack x tailscale oauth-connect --client-id <id> [--client-secret <secret>|--client-secret-stdin] [--auth-ref <ref>] [--tailnet <tailnet>] [--key-expiry-seconds <seconds>] [--json]`,
    };
  }

  return {
    ok: true,
    value: {
      json,
      clientId,
      clientSecret,
      clientSecretStdin,
      ...(authRef ? { authRef } : {}),
      ...(tailnet ? { tailnet } : {}),
      ...(typeof keyExpirySeconds === "number" ? { keyExpirySeconds } : {}),
    },
  };
}

export function parseTailscaleOauthDisconnectArgs(opts: {
  readonly args: readonly string[];
}): TailscaleOauthDisconnectArgsParseResult {
  let json = false;
  let authRef: string | undefined;

  for (let i = 0; i < opts.args.length; i += 1) {
    const token = opts.args[i] ?? "";
    if (token === "--json") {
      json = true;
      continue;
    }
    if (token === "--auth-ref") {
      const next = opts.args[i + 1] ?? "";
      if (!next) {
        return {
          ok: false,
          error: "Missing value for --auth-ref.",
        };
      }
      authRef = next;
      i += 1;
      continue;
    }
    return {
      ok: false,
      error: `Unknown option: ${token}. Usage: hack x tailscale oauth-disconnect [--auth-ref <ref>] [--json]`,
    };
  }

  return {
    ok: true,
    value: {
      json,
      ...(authRef ? { authRef } : {}),
    },
  };
}

function buildMissingBinaryPayload(): TailscaleInspectPayload {
  return {
    installed: false,
    connected: false,
    peers: [],
    onlinePeerCount: 0,
    exitNodes: [],
    health: [],
    error: "tailscale not found. Install with: brew install tailscale",
  };
}

function buildFallbackPayload(opts: {
  readonly binaryPath: string;
}): Omit<TailscaleInspectPayload, "error"> {
  return {
    installed: true,
    binaryPath: opts.binaryPath,
    connected: false,
    peers: [],
    onlinePeerCount: 0,
    exitNodes: [],
    health: [],
  };
}

function parseTailscaleStatusPayload(opts: {
  readonly payload: Record<string, unknown>;
  readonly fallbackBase: Omit<TailscaleInspectPayload, "error">;
}): TailscaleInspectPayload {
  const backendState = getString(opts.payload, "BackendState");
  const connected = backendState === "Running";
  const currentTailnet = getRecord(opts.payload, "CurrentTailnet");
  const tailnetName = currentTailnet
    ? getString(currentTailnet, "Name")
    : undefined;
  const magicDnsSuffix = currentTailnet
    ? getString(currentTailnet, "MagicDNSSuffix")
    : undefined;
  const authUrl = getString(opts.payload, "AuthURL");
  const currentExitNodeId = getString(opts.payload, "ExitNodeID");
  const health = getStringArray(opts.payload, "Health") ?? [];

  const selfRaw = getRecord(opts.payload, "Self");
  const self = selfRaw
    ? parseSelfPeer({
        id: getString(selfRaw, "ID") ?? "self",
        value: selfRaw,
      })
    : undefined;

  const peerMap = getRecord(opts.payload, "Peer");
  const peers: TailscaleInspectPeer[] = [];
  if (peerMap) {
    for (const [id, value] of Object.entries(peerMap)) {
      if (!isRecord(value)) {
        continue;
      }
      peers.push(parsePeer({ id, value }));
    }
  }

  peers.sort((left, right) => {
    if (left.online !== right.online) {
      return left.online ? -1 : 1;
    }
    return left.hostname.localeCompare(right.hostname);
  });

  const exitNodes = peers.filter(
    (peer) => peer.isExitNodeOption || peer.isExitNode
  );
  const currentExitNodeName = currentExitNodeId
    ? peers.find((peer) => peer.id === currentExitNodeId)?.hostname
    : undefined;
  const onlinePeerCount = peers.filter((peer) => peer.online).length;

  return {
    ...opts.fallbackBase,
    connected,
    ...(backendState ? { backendState } : {}),
    ...(tailnetName ? { tailnetName } : {}),
    ...(magicDnsSuffix ? { magicDnsSuffix } : {}),
    ...(authUrl ? { authUrl } : {}),
    ...(currentExitNodeId ? { currentExitNodeId } : {}),
    ...(currentExitNodeName ? { currentExitNodeName } : {}),
    ...(self ? { self } : {}),
    peers,
    onlinePeerCount,
    exitNodes,
    health,
  };
}

function parseTailscaleStatusResult(opts: {
  readonly result: Awaited<ReturnType<typeof exec>>;
  readonly fallbackBase: Omit<TailscaleInspectPayload, "error">;
}): TailscaleInspectPayload {
  if (opts.result.exitCode !== 0) {
    const stderr = opts.result.stderr.trim();
    return {
      ...opts.fallbackBase,
      error: stderr.length > 0 ? stderr : "tailscale status failed",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.result.stdout);
  } catch {
    return {
      ...opts.fallbackBase,
      error: "tailscale status returned invalid JSON",
    };
  }
  if (!isRecord(parsed)) {
    return {
      ...opts.fallbackBase,
      error: "tailscale status returned invalid JSON",
    };
  }
  return parseTailscaleStatusPayload({
    payload: parsed,
    fallbackBase: opts.fallbackBase,
  });
}

async function inspectTailscaleStatus(): Promise<TailscaleInspectPayload> {
  const binaryPath = findExecutableInPath("tailscale") ?? undefined;
  if (!binaryPath) {
    return buildMissingBinaryPayload();
  }

  const result = await exec(["tailscale", "status", "--json"], {
    stdin: "ignore",
  });
  const fallbackBase = buildFallbackPayload({ binaryPath });
  return parseTailscaleStatusResult({
    result,
    fallbackBase,
  });
}

function parsePeer(opts: {
  readonly id: string;
  readonly value: Record<string, unknown>;
}): TailscaleInspectPeer {
  return {
    id: opts.id,
    hostname: getString(opts.value, "HostName") ?? opts.id,
    dnsName: normalizeDnsName(getString(opts.value, "DNSName")),
    tailscaleIp: firstTailscaleIp(opts.value),
    online: opts.value.Online === true,
    os: getString(opts.value, "OS"),
    tags: getStringArray(opts.value, "Tags") ?? [],
    isExitNode: opts.value.ExitNode === true,
    isExitNodeOption: opts.value.ExitNodeOption === true,
  };
}

function parseSelfPeer(opts: {
  readonly id: string;
  readonly value: Record<string, unknown>;
}): TailscaleInspectSelf {
  return {
    id: opts.id,
    hostname: getString(opts.value, "HostName") ?? "this-device",
    dnsName: normalizeDnsName(getString(opts.value, "DNSName")),
    tailscaleIp: firstTailscaleIp(opts.value),
    online: opts.value.Online === true,
    os: getString(opts.value, "OS"),
    tags: getStringArray(opts.value, "Tags") ?? [],
    isExitNode: opts.value.ExitNode === true,
  };
}

function firstTailscaleIp(record: Record<string, unknown>): string | undefined {
  const values = record.TailscaleIPs;
  if (!Array.isArray(values)) {
    return undefined;
  }
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function normalizeDnsName(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (!value.endsWith(".")) {
    return value;
  }
  return value.slice(0, -1);
}

function resolveTailscaleOauthSettings(opts: {
  readonly controlPlaneConfig: ControlPlaneConfig;
}): Partial<TailscaleOauthSettings> {
  const tailscaleConfig = readExtensionConfig({
    controlPlaneConfig: opts.controlPlaneConfig,
    extensionId: TAILSCALE_EXTENSION_ID,
  });
  const railwayConfig = readExtensionConfig({
    controlPlaneConfig: opts.controlPlaneConfig,
    extensionId: RAILWAY_EXTENSION_ID,
  });

  const clientId =
    normalizeOptionalString(tailscaleConfig.oauthClientId) ??
    normalizeOptionalString(railwayConfig.tailscaleOauthClientId) ??
    "";
  const authRef =
    normalizeOptionalString(tailscaleConfig.oauthClientSecretAuthRef) ??
    normalizeOptionalString(railwayConfig.tailscaleOauthClientSecretAuthRef) ??
    "";
  const tailnet =
    normalizeOptionalString(tailscaleConfig.tailnet) ??
    normalizeOptionalString(railwayConfig.tailscaleTailnet) ??
    DEFAULT_TAILSCALE_TAILNET;

  const keyExpirySeconds = normalizePositiveInteger({
    value:
      parseOptionalInteger(tailscaleConfig.keyExpirySeconds) ??
      parseOptionalInteger(railwayConfig.tailscaleKeyExpirySeconds),
    fallback: DEFAULT_TAILSCALE_KEY_EXPIRY_SECONDS,
  });

  return {
    ...(clientId.length > 0 ? { clientId } : {}),
    ...(authRef.length > 0 ? { authRef } : {}),
    tailnet,
    keyExpirySeconds,
  };
}

function buildTailscaleOauthStatusPayload(opts: {
  readonly settings: Partial<TailscaleOauthSettings>;
}): TailscaleOauthStatusPayload {
  const configured =
    (opts.settings.clientId ?? "").trim().length > 0 &&
    (opts.settings.authRef ?? "").trim().length > 0;

  return {
    configured,
    ...(opts.settings.clientId ? { clientId: opts.settings.clientId } : {}),
    ...(opts.settings.authRef ? { authRef: opts.settings.authRef } : {}),
    ...(opts.settings.tailnet ? { tailnet: opts.settings.tailnet } : {}),
    ...(typeof opts.settings.keyExpirySeconds === "number"
      ? { keyExpirySeconds: opts.settings.keyExpirySeconds }
      : {}),
  };
}

async function validateTailscaleOauthPayload(opts: {
  readonly payload: TailscaleOauthStatusPayload;
  readonly settings: Partial<TailscaleOauthSettings>;
}): Promise<TailscaleOauthStatusPayload> {
  const checkedAt = new Date().toISOString();
  const authRef = (opts.settings.authRef ?? "").trim();
  const clientId = (opts.settings.clientId ?? "").trim();
  if (!(authRef && clientId)) {
    return {
      ...opts.payload,
      validated: false,
      checkedAt,
      error:
        "Missing client id or auth ref. Run `hack x tailscale oauth-connect` to configure credentials.",
    };
  }

  const clientSecret = (
    (await secrets.get({
      service: TAILSCALE_OAUTH_SECRET_SERVICE,
      name: authRef,
    })) ?? ""
  ).trim();
  if (!clientSecret) {
    return {
      ...opts.payload,
      validated: false,
      checkedAt,
      error: `Missing keychain secret for auth ref ${authRef}.`,
    };
  }

  const tokenResult = await requestTailscaleOauthAccessToken({
    clientId,
    clientSecret,
  });
  if (!tokenResult.ok) {
    return {
      ...opts.payload,
      validated: false,
      checkedAt,
      error: tokenResult.error,
    };
  }

  return {
    ...opts.payload,
    validated: true,
    checkedAt,
    ...(tokenResult.tokenExpiresAt
      ? { tokenExpiresAt: tokenResult.tokenExpiresAt }
      : {}),
  };
}

async function resolveOauthClientSecret(opts: {
  readonly parsed: TailscaleOauthConnectArgs;
}): Promise<
  | { readonly ok: true; readonly clientSecret: string }
  | {
      readonly ok: false;
      readonly error: string;
    }
> {
  if (opts.parsed.clientSecretStdin) {
    const stdin = (await Bun.stdin.text()).trim();
    if (!stdin) {
      return {
        ok: false,
        error: "Expected client secret on stdin (--client-secret-stdin).",
      };
    }
    return {
      ok: true,
      clientSecret: stdin,
    };
  }

  const provided = opts.parsed.clientSecret.trim();
  if (!provided) {
    return {
      ok: false,
      error:
        "Missing Tailscale OAuth client secret. Pass --client-secret or --client-secret-stdin.",
    };
  }
  return {
    ok: true,
    clientSecret: provided,
  };
}

async function persistTailscaleOauthSettings(input: {
  readonly clientId: string;
  readonly authRef: string;
  readonly tailnet: string;
  readonly keyExpirySeconds: number;
}): Promise<void> {
  const writes: readonly [string, string | number][] = [
    [
      'controlPlane.extensions["dance.hack.tailscale"].config.oauthClientId',
      input.clientId,
    ],
    [
      'controlPlane.extensions["dance.hack.tailscale"].config.oauthClientSecretAuthRef',
      input.authRef,
    ],
    [
      'controlPlane.extensions["dance.hack.tailscale"].config.tailnet',
      input.tailnet,
    ],
    [
      'controlPlane.extensions["dance.hack.tailscale"].config.keyExpirySeconds',
      input.keyExpirySeconds,
    ],
    [
      'controlPlane.extensions["dance.hack.railway"].config.tailscaleOauthClientId',
      input.clientId,
    ],
    [
      'controlPlane.extensions["dance.hack.railway"].config.tailscaleOauthClientSecretAuthRef',
      input.authRef,
    ],
    [
      'controlPlane.extensions["dance.hack.railway"].config.tailscaleTailnet',
      input.tailnet,
    ],
    [
      'controlPlane.extensions["dance.hack.railway"].config.tailscaleKeyExpirySeconds',
      input.keyExpirySeconds,
    ],
  ];

  for (const [path, value] of writes) {
    await updateGlobalConfig({ path, value });
  }
}

async function clearTailscaleOauthSettings(): Promise<void> {
  const clears: readonly [string, string | number][] = [
    [
      'controlPlane.extensions["dance.hack.tailscale"].config.oauthClientId',
      "",
    ],
    [
      'controlPlane.extensions["dance.hack.tailscale"].config.oauthClientSecretAuthRef',
      "",
    ],
    ['controlPlane.extensions["dance.hack.tailscale"].config.tailnet', ""],
    [
      'controlPlane.extensions["dance.hack.tailscale"].config.keyExpirySeconds',
      DEFAULT_TAILSCALE_KEY_EXPIRY_SECONDS,
    ],
    [
      'controlPlane.extensions["dance.hack.railway"].config.tailscaleOauthClientId',
      "",
    ],
    [
      'controlPlane.extensions["dance.hack.railway"].config.tailscaleOauthClientSecretAuthRef',
      "",
    ],
    [
      'controlPlane.extensions["dance.hack.railway"].config.tailscaleTailnet',
      "",
    ],
    [
      'controlPlane.extensions["dance.hack.railway"].config.tailscaleKeyExpirySeconds',
      DEFAULT_TAILSCALE_KEY_EXPIRY_SECONDS,
    ],
  ];

  for (const [path, value] of clears) {
    await updateGlobalConfig({ path, value });
  }
}

async function requestTailscaleOauthAccessToken(input: {
  readonly clientId: string;
  readonly clientSecret: string;
}): Promise<
  | { readonly ok: true; readonly tokenExpiresAt?: string }
  | {
      readonly ok: false;
      readonly error: string;
    }
> {
  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", input.clientId);
  body.set("client_secret", input.clientSecret);
  body.set("scope", "auth_keys");

  const response = await fetch(TAILSCALE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const raw = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      error: extractTailscaleApiError({ status: response.status, raw }),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error: "Tailscale OAuth token endpoint returned invalid JSON.",
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      error: "Tailscale OAuth token endpoint returned invalid JSON.",
    };
  }

  const accessToken = getString(parsed, "access_token");
  if (!accessToken) {
    return {
      ok: false,
      error: "Tailscale OAuth token response did not include access_token.",
    };
  }

  const expiresIn = parseOptionalInteger(parsed.expires_in);
  if (typeof expiresIn === "number" && expiresIn > 0) {
    return {
      ok: true,
      tokenExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    };
  }

  return { ok: true };
}

function extractTailscaleApiError(input: {
  readonly status: number;
  readonly raw: string;
}): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.raw);
  } catch {
    const fallback = input.raw.trim();
    if (fallback) {
      return `Tailscale OAuth token request failed (${input.status}): ${fallback}`;
    }
    return `Tailscale OAuth token request failed (${input.status}).`;
  }

  if (!isRecord(parsed)) {
    return `Tailscale OAuth token request failed (${input.status}).`;
  }

  const message =
    getString(parsed, "message") ??
    getString(parsed, "error") ??
    getString(parsed, "error_description");
  if (message) {
    return `Tailscale OAuth token request failed (${input.status}): ${message}`;
  }

  return `Tailscale OAuth token request failed (${input.status}).`;
}

function readExtensionConfig(opts: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly extensionId: string;
}): Record<string, unknown> {
  const extensions = opts.controlPlaneConfig.extensions;
  const extension = extensions[opts.extensionId];
  if (!isRecord(extension)) {
    return {};
  }
  const config = extension.config;
  if (!isRecord(config)) {
    return {};
  }
  return config;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseOptionalInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function normalizePositiveInteger(input: {
  readonly value: number | undefined;
  readonly fallback: number;
}): number {
  if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
    return input.fallback;
  }
  return Math.max(1, Math.trunc(input.value));
}
