import {
  getRecord,
  getString,
  getStringArray,
  isRecord,
} from "../../../lib/guards.ts";
import { exec, findExecutableInPath } from "../../../lib/shell.ts";
import { display } from "../../../ui/display.ts";

import type { ExtensionCommand } from "../types.ts";

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

async function inspectTailscaleStatus(): Promise<TailscaleInspectPayload> {
  const binaryPath = findExecutableInPath("tailscale") ?? undefined;
  if (!binaryPath) {
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

  const result = await exec(["tailscale", "status", "--json"], {
    stdin: "ignore",
  });
  const fallbackBase: Omit<TailscaleInspectPayload, "error"> = {
    installed: true,
    binaryPath,
    connected: false,
    peers: [],
    onlinePeerCount: 0,
    exitNodes: [],
    health: [],
  };
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    return {
      ...fallbackBase,
      error: stderr.length > 0 ? stderr : "tailscale status failed",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      ...fallbackBase,
      error: "tailscale status returned invalid JSON",
    };
  }
  if (!isRecord(parsed)) {
    return {
      ...fallbackBase,
      error: "tailscale status returned invalid JSON",
    };
  }

  const backendState = getString(parsed, "BackendState");
  const connected = backendState === "Running";
  const currentTailnet = getRecord(parsed, "CurrentTailnet");
  const tailnetName = currentTailnet
    ? getString(currentTailnet, "Name")
    : undefined;
  const magicDnsSuffix = currentTailnet
    ? getString(currentTailnet, "MagicDNSSuffix")
    : undefined;
  const authUrl = getString(parsed, "AuthURL");
  const currentExitNodeId = getString(parsed, "ExitNodeID");
  const health = getStringArray(parsed, "Health") ?? [];

  const selfRaw = getRecord(parsed, "Self");
  const self = selfRaw
    ? parseSelfPeer({
        id: getString(selfRaw, "ID") ?? "self",
        value: selfRaw,
      })
    : undefined;

  const peerMap = getRecord(parsed, "Peer");
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
    ...fallbackBase,
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
