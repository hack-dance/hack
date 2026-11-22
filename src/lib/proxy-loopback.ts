import { stat } from "node:fs/promises";
import { createConnection, isIP } from "node:net";
import { resolve as resolvePath } from "node:path";
import { connect } from "node:tls";
import {
  DEFAULT_NEW_PROJECT_TLD,
  DEFAULT_OAUTH_ALIAS_ROOT,
  DEFAULT_PROJECT_TLD,
  GLOBAL_CADDY_COMPOSE_FILENAME,
  GLOBAL_CADDY_DIR_NAME,
  LEGACY_SCHEMAS_HOST,
} from "../constants.ts";
import {
  type CaddyCaIdentity,
  inspectCaddyCaIdentity,
} from "./caddy-ca-identity.ts";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { readTextFile } from "./fs.ts";
import { resolveHackLocalCaCertPath } from "./local-ca.ts";
import {
  type ProxyBindScope,
  readProxyBindScope,
} from "./managed-proxy-compose.ts";
import { findProxyPortConflicts, type HostListener } from "./proxy-bind.ts";
import { listHostTcpListeners } from "./proxy-port-listeners.ts";
import { exec } from "./shell.ts";

const PROBE_TIMEOUT_MS = 1000;
const MAPPED_LOOPBACK = /^::ffff:(7f[\da-f]{2}):([\da-f]{1,4})$/i;
const WHITESPACE = /\s+/;
type ProbeState = "ok" | "timeout" | "unreachable" | "tls-error";
export type Endpoint = { readonly address: string; readonly port: number };
type ProbeOptions = Endpoint & {
  readonly caPem: string;
  readonly timeoutMs?: number;
  readonly protocol?: "http" | "https";
};
type Observation = Endpoint & { readonly state: ProbeState };

export type ProxyLoopbackReport = {
  readonly name: "proxy ports";
  readonly status: "ok" | "warn";
  readonly message: string;
  /** Only a verified running proxy root permits an interception diagnosis. */
  readonly verified: boolean;
  /** At least one selected endpoint passed; doctor still reports any other failed endpoint. */
  readonly reachable: boolean;
};

/**
 * HTTPS is authenticated against only the running proxy's root, using its own
 * schemas route for SNI/hostname verification. A TCP listener alone cannot pass.
 * The wall-clock timer covers the entire handshake, including a silent peer;
 * all outcomes destroy this probe's socket. HTTP only checks TCP reachability.
 */
export async function probeProxyLoopback(
  opts: ProbeOptions
): Promise<ProbeState> {
  return (await probeEndpoint(opts)).state;
}

/**
 * Certificate verification failures: a server answered TLS with a
 * certificate that the running proxy's CA did not issue for the schemas
 * name. Something other than this home's proxy is answering there.
 */
const UNTRUSTED_CERTIFICATE_CODES: ReadonlySet<string> = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** HTTPS to the proxy, as `hack global up` reads it. */
export type ProxyHttpsState = ProbeState | "untrusted";

/**
 * Doctor's HTTPS check, with one more distinction for `hack global up`:
 * `untrusted` when the handshake completed with a certificate that is not
 * the running proxy's (another server answers on that address), separate
 * from `tls-error`, a handshake that did not complete (a container runtime
 * that does not forward the port cleanly), which doctor tolerates.
 */
export async function probeProxyHttps(
  opts: Omit<ProbeOptions, "protocol">
): Promise<ProxyHttpsState> {
  const result = await probeEndpoint({ ...opts, protocol: "https" });
  if (
    result.state === "tls-error" &&
    result.code !== undefined &&
    UNTRUSTED_CERTIFICATE_CODES.has(result.code)
  ) {
    return "untrusted";
  }
  return result.state;
}

function probeEndpoint(
  opts: ProbeOptions
): Promise<{ readonly state: ProbeState; readonly code?: string }> {
  const https =
    (opts.protocol ?? (opts.port === 443 ? "https" : "http")) === "https";
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    const done = (state: ProbeState, code?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(code === undefined ? { state } : { state, code });
    };
    const socket = https
      ? connect({
          host: opts.address,
          port: opts.port,
          servername: LEGACY_SCHEMAS_HOST,
          ca: opts.caPem,
          rejectUnauthorized: true,
        })
      : createConnection({ host: opts.address, port: opts.port });
    const timer = setTimeout(
      () => done("timeout"),
      opts.timeoutMs ?? PROBE_TIMEOUT_MS
    );
    socket.once("connect", () => {
      connected = true;
    });
    if ("authorized" in socket) {
      socket.once("secureConnect", () =>
        done(socket.authorized ? "ok" : "tls-error")
      );
    } else {
      socket.once("connect", () => done("ok"));
    }
    socket.once("error", (error: NodeJS.ErrnoException) => {
      done(connected && https ? "tls-error" : "unreachable", error.code);
    });
  });
}

function hostPort(endpoint: Endpoint): string {
  const host = endpoint.address.includes(":")
    ? `[${endpoint.address}]`
    : endpoint.address;
  return `${host}:${endpoint.port}`;
}

function failureMessage(
  failed: readonly Observation[],
  listeners: readonly HostListener[]
): string {
  const ports = [...new Set(failed.map((endpoint) => endpoint.port))];
  const who = new Set<string>();
  for (const endpoint of failed) {
    for (const listener of findProxyPortConflicts({
      listeners,
      bindAddress: endpoint.address,
      ports: [endpoint.port],
    })) {
      if (listener.process) {
        who.add(
          `${listener.process.replace(/[^\w. -]/g, "").slice(0, 64)} (${hostPort(listener)})`
        );
      }
    }
  }
  return [
    ...ports.map(
      (port) => `port ${port} on loopback is not reaching the Hack proxy`
    ),
    ...failed.map(
      (endpoint) =>
        `${hostPort(endpoint)}: ${endpoint.state === "tls-error" ? "certificate or TLS verification failed" : endpoint.state}`
    ),
    ...(who.size ? [`Visible listeners: ${[...who].join(", ")}.`] : []),
    "Affected hostnames: those resolving to these loopback addresses; names resolving directly to the proxy container address use a different path.",
    "Check another listener, a VPN client's serve feature, or the container runtime's own HTTPS setting. Review proxy.bind_address and local DNS overrides. No automatic fix is applied.",
  ].join("; ");
}

/** Read-only diagnostics; neither a reachable container IP nor the other family hides a failure. */
export async function inspectProxyLoopback(
  opts: {
    readonly addresses?: readonly string[];
    readonly ports?: readonly number[];
    readonly loadCa?: () => Promise<CaddyCaIdentity>;
    readonly probe?: (opts: ProbeOptions) => Promise<ProbeState>;
    readonly listListeners?: () => Promise<readonly HostListener[] | null>;
  } = {}
): Promise<ProxyLoopbackReport> {
  const identity = await (
    opts.loadCa ??
    (() =>
      inspectCaddyCaIdentity({
        certPath: resolveHackLocalCaCertPath(),
        timeoutMs: PROBE_TIMEOUT_MS,
      }))
  )();
  if (!identity.currentPem) {
    return {
      name: "proxy ports",
      status: "warn",
      verified: false,
      reachable: false,
      message:
        "Cannot verify loopback forwarding: the running Hack proxy's internal CA is unavailable. Check global proxy status and the caddy local ca diagnostic.",
    };
  }
  const caPem = identity.currentPem;
  if (!identity.loopbackPorts) {
    return {
      name: "proxy ports",
      status: "warn",
      verified: false,
      reachable: false,
      message:
        "Cannot verify loopback forwarding: the running proxy's published port bindings are unavailable.",
    };
  }
  const endpoints = proxyLoopbackEndpoints({
    loopbackPorts: identity.loopbackPorts,
    ports: opts.ports ?? [80, 443],
    addresses: opts.addresses,
  });
  if (!endpoints.length) {
    return {
      name: "proxy ports",
      status: "ok",
      verified: false,
      reachable: false,
      message:
        "Loopback check skipped: the proxy does not publish the selected ports on these loopback addresses. Review proxy.bind_address and local DNS overrides if loopback access is needed.",
    };
  }
  const observations = await Promise.all(
    endpoints.map(
      async ({ address, port }): Promise<Observation> => ({
        address,
        port,
        state: await (opts.probe ?? probeProxyLoopback)({
          address,
          port,
          caPem,
        }),
      })
    )
  );
  const failed = observations.filter(
    (observation) => observation.state !== "ok"
  );
  const listeners = failed.length
    ? await (opts.listListeners ?? listHostTcpListeners)()
    : [];
  return {
    name: "proxy ports",
    status: failed.length ? "warn" : "ok",
    verified: true,
    reachable: observations.some((observation) => observation.state === "ok"),
    message: failed.length
      ? failureMessage(failed, listeners ?? [])
      : `Loopback ports reachable (${observations.map(hostPort).join(", ")}); HTTPS verifies against the running Hack proxy's internal CA.`,
  };
}

/**
 * The loopback endpoints to check, from the running proxy's live published
 * bindings (not the Compose file or the setting): each published loopback
 * binding's default address (`0.0.0.0` → `127.0.0.1`, `::` → `::1`), or the
 * given `addresses` that a binding covers. Shared by doctor and `hack global
 * up`, so both look at the same endpoints. An unpublished port has none.
 */
export function proxyLoopbackEndpoints(opts: {
  readonly loopbackPorts: Readonly<Record<80 | 443, readonly string[]>>;
  readonly ports: readonly number[];
  readonly addresses?: readonly string[];
}): Endpoint[] {
  return opts.ports.flatMap((port) => {
    const published =
      port === 80 || port === 443 ? (opts.loopbackPorts[port] ?? []) : [];
    const candidates = opts.addresses ?? published.map(defaultLoopbackAddress);
    return [...new Set(candidates)]
      .filter((address) =>
        published.some((binding) => sameLoopbackAddress(address, binding))
      )
      .map((address) => ({ address, port }));
  });
}

function defaultLoopbackAddress(binding: string): string {
  if (binding === "0.0.0.0") {
    return "127.0.0.1";
  }
  return binding === "::" ? "::1" : binding;
}

function loopbackV4(address: string): string | null {
  if (isIP(address) === 4 && address.startsWith("127.")) {
    return address;
  }
  if (address.startsWith("::ffff:127.")) {
    return address.slice(7);
  }
  const mapped = MAPPED_LOOPBACK.exec(address);
  if (!(mapped?.[1] && mapped[2])) {
    return null;
  }
  const upper = Number.parseInt(mapped[1], 16);
  const lower = Number.parseInt(mapped[2], 16);
  return [upper >> 8, upper & 255, lower >> 8, lower & 255].join(".");
}

function sameLoopbackAddress(address: string, binding: string): boolean {
  if (binding === "::") {
    return address === "::1";
  }
  const v4 = loopbackV4(address);
  return binding === "0.0.0.0"
    ? v4 !== null
    : address === binding || v4 === binding;
}

function isLoopback(address: string): boolean {
  return (
    address === "::1" ||
    address.startsWith("::ffff:127.") ||
    MAPPED_LOOPBACK.test(address) ||
    (isIP(address) === 4 && address.startsWith("127."))
  );
}

/**
 * Query the system resolver (including local overrides) in an owned child.
 * A raced node:dns lookup can keep a short-lived CLI alive after its timeout.
 * Failure or unavailable tooling means unknown, never a foreign-listener claim.
 */
export async function resolveProxyLoopbackAddresses(opts: {
  readonly hostname: string;
  readonly platform?: NodeJS.Platform;
  readonly execute?: typeof exec;
}): Promise<readonly string[]> {
  const mac = (opts.platform ?? process.platform) === "darwin";
  try {
    const result = await (opts.execute ?? exec)(
      mac
        ? ["/usr/bin/dscacheutil", "-q", "host", "-a", "name", opts.hostname]
        : ["getent", "ahosts", opts.hostname],
      { timeoutMs: 500, stdin: "ignore", maxStdoutBytes: 16_384 }
    );
    if (result.exitCode !== 0) {
      return [];
    }
    const addresses = [
      ...new Set(
        result.stdout.split("\n").flatMap((line) => {
          const fields = line.trim().split(WHITESPACE);
          if (
            mac &&
            !["ip_address:", "ipv6_address:"].includes(fields[0] ?? "")
          ) {
            return [];
          }
          const address = fields[mac ? 1 : 0];
          return address && isIP(address) ? [address] : [];
        })
      ),
    ];
    // Truncation could hide a working fallback after failed loopback answers.
    return addresses.length > 16 ? [] : addresses;
  } catch {
    return [];
  }
}

/** Whether the system resolver has any address for a hostname. */
export type HostResolution = "resolves" | "no-answer" | "unknown";

/**
 * Ask the system resolver (hosts file and local overrides included) whether a
 * hostname has any address. "no-answer" is a definite miss; a failed or
 * unavailable lookup is "unknown" and must never be reported as a miss.
 */
export async function hostResolution(opts: {
  readonly hostname: string;
  readonly platform?: NodeJS.Platform;
  readonly execute?: typeof exec;
}): Promise<HostResolution> {
  const mac = (opts.platform ?? process.platform) === "darwin";
  try {
    const result = await (opts.execute ?? exec)(
      mac
        ? ["/usr/bin/dscacheutil", "-q", "host", "-a", "name", opts.hostname]
        : ["getent", "ahosts", opts.hostname],
      { timeoutMs: 500, stdin: "ignore", maxStdoutBytes: 16_384 }
    );
    // getent exits 2 when the name is not found; dscacheutil exits 0 with no
    // records. Any other failure says nothing about the name.
    if (result.exitCode !== 0) {
      return !mac && result.exitCode === 2 ? "no-answer" : "unknown";
    }
    const found = result.stdout.split("\n").some((line) => {
      const fields = line.trim().split(WHITESPACE);
      if (mac && !["ip_address:", "ipv6_address:"].includes(fields[0] ?? "")) {
        return false;
      }
      const address = fields[mac ? 1 : 0];
      return Boolean(address) && isIP(address ?? "") !== 0;
    });
    return found ? "resolves" : "no-answer";
  } catch {
    return "unknown";
  }
}

/** Whether a macOS resolver file exists for a domain; "unknown" when that cannot be observed. */
export type ResolverFileState = "present" | "absent" | "unknown";

async function macResolverFileState(
  domain: string
): Promise<ResolverFileState> {
  try {
    return (await stat(`/etc/resolver/${domain}`)).isFile()
      ? "present"
      : "unknown";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unknown";
  }
}

/** Suffixes whose DNS Hack itself installs (`hack global install`). */
const HACK_MANAGED_SUFFIXES: readonly string[] = [
  DEFAULT_NEW_PROJECT_TLD,
  DEFAULT_PROJECT_TLD,
  DEFAULT_OAUTH_ALIAS_ROOT,
];

/** What `hack open` could tell about the selected host's DNS, when it is not fine. */
export type OpenDnsNotice = {
  /**
   * "unresolved": the system resolver definitely has no address.
   * "unconfigured": the lookup did not answer in time and Hack's own DNS for
   * this suffix is not installed on this Mac, so the URL may not open.
   */
  readonly dns: "unresolved" | "unconfigured";
  readonly hint: string;
};

const DNS_FIX =
  "hack doctor shows the DNS checks, and hack global install sets up Hack's domains (it asks for sudo once). A machine set up by an earlier Hack version may only resolve the older suffix: either run hack global install, or give the project a host under a suffix that already resolves here with hack config set dev_host <name>.<suffix>.";

/** Hack's proxy publishes only these ports (see proxy-bind.ts). */
const PROXY_DEFAULT_PORT: Readonly<Record<string, string>> = {
  "http:": "80",
  "https:": "443",
};

const LINUX_DNS_REASON =
  "hack doctor's \"linux dns route\" check says whether this host can use Hack's names: on Linux they need systemd-resolved, which most containers and cloud sandboxes do not run. Where it runs, hack global install sets them up (it asks for sudo once).";

/** Single-quote a value for a POSIX shell. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The address curl should send the request to, from the proxy Compose file
 * Docker was given (not the setting, which may not be applied yet): loopback
 * of the published family, or the one published address. Null when the file
 * is missing or its publication cannot be read, so no address is invented.
 */
export function proxyConnectAddress(
  scope: ProxyBindScope | null
): string | null {
  if (scope === null || scope.kind === "unknown") {
    return null;
  }
  if (scope.kind === "all" || scope.address === "0.0.0.0") {
    return "127.0.0.1";
  }
  if (scope.address === "::") {
    return "[::1]";
  }
  return scope.address.includes(":") ? `[${scope.address}]` : scope.address;
}

/**
 * The Linux fix for a name with no address. Hack's names need
 * systemd-resolved there, which containers and cloud sandboxes usually do
 * not run. For a URL on the proxy's own port (80 for http, 443 for https)
 * the hint also gives a way in that needs no DNS: curl's --resolve to the
 * address the proxy publishes on, with the full URL, bypassing any inherited
 * HTTPS proxy (sandboxes often set one) (HACK-2356). Other ports
 * are not the proxy's, so they get the DNS reason only.
 */
export function linuxDnsFix(opts: {
  readonly url: URL;
  readonly proxyBind: ProxyBindScope | null;
}): string {
  const { url } = opts;
  const proxyPort = PROXY_DEFAULT_PORT[url.protocol];
  if (proxyPort === undefined || (url.port !== "" && url.port !== proxyPort)) {
    return LINUX_DNS_REASON;
  }
  const address = proxyConnectAddress(opts.proxyBind);
  if (address === null) {
    return `${LINUX_DNS_REASON} Without it, send the request to the address Hack's proxy publishes port ${proxyPort} on, for example with curl --noproxy ${shellQuote(url.hostname)} --resolve ${shellQuote(`${url.hostname}:${proxyPort}:<address>`)} ${shellQuote(url.href)}.`;
  }
  const trust =
    url.protocol === "https:"
      ? " (for https, run hack global trust once and load the host trust env file it prints; that part needs no sudo)"
      : "";
  return `${LINUX_DNS_REASON} Without it, reach the app through Hack's proxy on this machine with: curl --noproxy ${shellQuote(url.hostname)} --resolve ${shellQuote(`${url.hostname}:${proxyPort}:${address}`)} ${shellQuote(url.href)}${trust}`;
}

/** How the rendered proxy Compose file publishes ports, or null when absent. */
async function renderedProxyBind(): Promise<ProxyBindScope | null> {
  const text = await readTextFile(
    resolvePath(
      resolveGlobalHackDir(),
      GLOBAL_CADDY_DIR_NAME,
      GLOBAL_CADDY_COMPOSE_FILENAME
    )
  );
  return text === null ? null : readProxyBindScope(text);
}

/**
 * A notice for a URL whose host has no address, or whose Hack-managed suffix
 * has no DNS installed on this Mac; null when there is nothing to say. IP
 * literals, localhost names and non-HTTP schemes are not checked. A lookup
 * that fails or times out is never reported as "unresolved".
 */
export async function openUnresolvedHostWarning(opts: {
  readonly url: string;
  readonly resolve?: (hostname: string) => Promise<HostResolution>;
  readonly platform?: NodeJS.Platform;
  readonly resolverFile?: (domain: string) => Promise<ResolverFileState>;
  /** How the proxy publishes its ports; defaults to the rendered Compose file. */
  readonly proxyBind?: () => Promise<ProxyBindScope | null>;
}): Promise<OpenDnsNotice | null> {
  const url = new URL(opts.url);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    isIP(hostname) !== 0 ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  ) {
    return null;
  }
  const resolution = await (
    opts.resolve ?? ((name) => hostResolution({ hostname: name }))
  )(hostname);
  if (resolution === "resolves") {
    return null;
  }
  if (resolution === "no-answer") {
    const platform = opts.platform ?? process.platform;
    return {
      dns: "unresolved",
      hint: `${hostname} has no address on this machine, so the URL will not open. ${
        platform === "linux"
          ? linuxDnsFix({
              url,
              proxyBind: await (opts.proxyBind ?? renderedProxyBind)(),
            })
          : DNS_FIX
      }`,
    };
  }
  // Unknown stays unknown. The one thing still worth saying: on macOS a name
  // under a suffix Hack manages, with no resolver file for that suffix, is
  // asked over multicast DNS and takes about ten seconds to give up, which is
  // why the bounded lookup did not answer. That is a missing Hack setup, not
  // proof that the name has no address, and it is said as such. Other .local
  // names (a printer, a hosts-file entry) are left alone.
  if ((opts.platform ?? process.platform) !== "darwin") {
    return null;
  }
  const suffix = HACK_MANAGED_SUFFIXES.find((managed) =>
    hostname.endsWith(`.${managed}`)
  );
  if (
    !suffix ||
    (await (opts.resolverFile ?? macResolverFileState)(suffix)) !== "absent"
  ) {
    return null;
  }
  return {
    dns: "unconfigured",
    hint: `Hack's DNS for the ${suffix} suffix is not set up on this Mac (no /etc/resolver/${suffix}), and the lookup for ${hostname} did not answer in time, so the URL may not open. ${DNS_FIX}`,
  };
}

/**
 * Check only the selected URL's loopback path before printing or opening it.
 * Container-address routes, custom ports and non-HTTP schemes retain their
 * behavior. An unavailable runtime witness is diagnosed by doctor, not treated
 * as proof that a listener is foreign.
 */
export async function openProxyLoopbackWarning(opts: {
  readonly url: string;
  readonly lookup?: (hostname: string) => Promise<readonly string[]>;
  readonly inspect?: typeof inspectProxyLoopback;
}): Promise<string | null> {
  const url = new URL(opts.url);
  if (!["http:", "https:"].includes(url.protocol) || url.port) {
    return null;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const resolved = isIP(hostname)
    ? [hostname]
    : await (
        opts.lookup ??
        ((name) => resolveProxyLoopbackAddresses({ hostname: name }))
      )(hostname);
  // A browser may fall back to another DNS path. This guard only proves a
  // complete failure when every candidate uses the inspected loopback path.
  if (resolved.some((address) => !isLoopback(address))) {
    return null;
  }
  const addresses = [...new Set(resolved.filter(isLoopback))];
  if (!addresses.length) {
    return null;
  }
  const report = await (opts.inspect ?? inspectProxyLoopback)({
    addresses,
    ports: [url.protocol === "https:" ? 443 : 80],
  });
  return report.verified && !report.reachable && report.status === "warn"
    ? report.message
    : null;
}
