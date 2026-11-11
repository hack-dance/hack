/**
 * Host address the global Caddy proxy publishes ports 80 and 443 on.
 *
 * Unset keeps Docker's default (every interface), which LAN and tunnel access
 * rely on. A user can pin it to one address, for example `127.0.0.1` when
 * another program (such as a VPN client) already listens on :443 on a
 * different address. `hack global install` and `hack doctor --fix` render
 * the proxy compose file from this setting, so neither reverts it.
 */
import { isIP } from "node:net";
import { readGlobalConfig } from "./config.ts";

export const PROXY_BIND_CONFIG_KEY = "proxy.bind_address" as const;
export const PROXY_PORTS = [80, 443] as const;

const WILDCARDS: ReadonlySet<string> = new Set(["0.0.0.0", "::", "*", "[::]"]);

/** An IPv4 or IPv6 literal, without brackets or a port. */
export function parseProxyBindAddress(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`${PROXY_BIND_CONFIG_KEY} must be an IP address string`);
  }
  const trimmed = value.trim();
  const unbracketed =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
  if (isIP(unbracketed) === 0) {
    throw new Error(
      `${PROXY_BIND_CONFIG_KEY} must be an IP address such as 127.0.0.1, 0.0.0.0 or ::1 (got ${JSON.stringify(value)})`
    );
  }
  return unbracketed.toLowerCase();
}

/** The configured address, or `null` for Docker's default (all interfaces). */
export async function resolveProxyBindAddress(): Promise<string | null> {
  const configured = await readGlobalConfig({ path: PROXY_BIND_CONFIG_KEY });
  return configured === undefined ? null : parseProxyBindAddress(configured);
}

/** A compose `ports:` entry, quoted for YAML. */
export function renderProxyPortMapping(opts: {
  readonly bindAddress: string | null;
  readonly port: number;
}): string {
  const { bindAddress, port } = opts;
  if (bindAddress === null) {
    return `"${port}:${port}"`;
  }
  const host = bindAddress.includes(":") ? `[${bindAddress}]` : bindAddress;
  return `"${host}:${port}:${port}"`;
}

const COMPOSE_443_MAPPING = /^\s*-\s*"(?:\[?([^\]"]+?)\]?:)?443:443"\s*$/m;

/**
 * The bind address in a rendered proxy compose file (`null` for all
 * interfaces). The file, not the config, is what Docker actually used.
 */
export function readProxyBindFromCompose(text: string): string | null {
  return COMPOSE_443_MAPPING.exec(text)?.[1] ?? null;
}

/** One TCP listener on the host, as reported by `ss` or `lsof`. */
export type HostListener = {
  readonly address: string;
  readonly port: number;
  /** Process name when the OS reported it (may need root for other users). */
  readonly process: string | null;
  readonly pid: number | null;
};

const SS_USERS = /users:\(\("([^"]+)",pid=(\d+)/;
const LSOF_NAME = /^(.*):(\d+)$/;
const WHITESPACE = /\s+/;

function splitHostPort(raw: string): { address: string; port: number } | null {
  const match = LSOF_NAME.exec(raw);
  if (!(match?.[1] && match[2])) {
    return null;
  }
  let address = match[1];
  if (address.startsWith("[") && address.endsWith("]")) {
    address = address.slice(1, -1);
  }
  // `ss` prints a scoped wildcard as `*` or `0.0.0.0%lo`; drop the scope.
  address = address.split("%")[0] ?? address;
  return { address, port: Number(match[2]) };
}

/** Parse `ss -Hltnp` output (Linux). */
export function parseSsListeners(output: string): readonly HostListener[] {
  const listeners: HostListener[] = [];
  for (const line of output.split("\n")) {
    const fields = line.trim().split(WHITESPACE);
    // State Recv-Q Send-Q Local Peer [Process]
    const local = fields[3];
    if (!local) {
      continue;
    }
    const hostPort = splitHostPort(local);
    if (!hostPort) {
      continue;
    }
    const users = SS_USERS.exec(line);
    listeners.push({
      ...hostPort,
      process: users?.[1] ?? null,
      pid: users?.[2] ? Number(users[2]) : null,
    });
  }
  return listeners;
}

/** Parse `lsof -nP -iTCP -sTCP:LISTEN` output (macOS). */
export function parseLsofListeners(output: string): readonly HostListener[] {
  const listeners: HostListener[] = [];
  for (const line of output.split("\n").slice(1)) {
    const fields = line.trim().split(WHITESPACE);
    // COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME (LISTEN)
    const name = fields.at(-2) === undefined ? undefined : fields.at(-2);
    const listening = fields.at(-1) === "(LISTEN)";
    if (!(listening && name)) {
      continue;
    }
    const hostPort = splitHostPort(name);
    if (!hostPort) {
      continue;
    }
    listeners.push({
      ...hostPort,
      process: fields[0] ?? null,
      pid: fields[1] ? Number(fields[1]) : null,
    });
  }
  return listeners;
}

function isWildcard(address: string): boolean {
  return WILDCARDS.has(address);
}

/**
 * Listeners that stop Docker from publishing the proxy ports on `bindAddress`.
 * With Docker's default (`null`) any listener on the port blocks it; a
 * specific address conflicts only with the same address or a wildcard.
 */
export function findProxyPortConflicts(opts: {
  readonly listeners: readonly HostListener[];
  readonly bindAddress: string | null;
  readonly ports?: readonly number[];
}): readonly HostListener[] {
  const ports = new Set(opts.ports ?? PROXY_PORTS);
  const bind = opts.bindAddress;
  return opts.listeners.filter((listener) => {
    if (!ports.has(listener.port)) {
      return false;
    }
    if (bind === null || isWildcard(bind) || isWildcard(listener.address)) {
      return true;
    }
    return listener.address === bind;
  });
}

/** Human message naming each conflicting listener and the setting to change. */
export function renderProxyPortConflictMessage(opts: {
  readonly conflicts: readonly HostListener[];
  readonly bindAddress: string | null;
}): string {
  const bindLabel =
    opts.bindAddress === null
      ? "all interfaces (Docker's default)"
      : opts.bindAddress;
  return [
    `The proxy cannot publish ports ${PROXY_PORTS.join(" and ")} on ${bindLabel}; already in use by:`,
    ...opts.conflicts.map((listener) => {
      const who =
        listener.process === null
          ? "an unknown process (run with sudo to see it)"
          : `${listener.process}${listener.pid === null ? "" : ` (pid ${listener.pid})`}`;
      const host = listener.address.includes(":")
        ? `[${listener.address}]`
        : listener.address;
      return `- ${host}:${listener.port} ${who}`;
    }),
    `Stop that listener, or publish the proxy on another address: hack config set --global ${PROXY_BIND_CONFIG_KEY} 127.0.0.1 && hack global install`,
  ].join("\n");
}
