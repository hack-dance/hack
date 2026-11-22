/**
 * The Docker and network reads behind `hack global up`'s route probe
 * (src/lib/global-route-probe.ts decides what they mean). Kept apart so the
 * command can be tested with these replaced.
 */
import { isIP } from "node:net";
import { GLOBAL_CADDY_PROJECT_NAME } from "../constants.ts";
import { inspectCaddyCaIdentity } from "./caddy-ca-identity.ts";
import { resolveHackLocalCaCertPath } from "./local-ca.ts";
import { type ProxyHttpsState, probeProxyHttps } from "./proxy-loopback.ts";
import { exec } from "./shell.ts";

const WHITESPACE = /\s+/;
const READ_TIMEOUT_MS = 3000;

/** What the running proxy shows: its CA and its live loopback bindings. */
export type ProxyRuntime = {
  /** The running Caddy's root CA (PEM), or null while it cannot be read. */
  readonly caPem: string | null;
  /** Live port bindings Docker reports, or null when unreadable. */
  readonly loopbackPorts: Readonly<Record<80 | 443, readonly string[]>> | null;
};

/**
 * The running proxy's CA and published bindings, read the way doctor reads
 * them (the Compose-labelled Caddy container, never the Compose file).
 */
export async function readProxyRuntime(): Promise<ProxyRuntime> {
  const identity = await inspectCaddyCaIdentity({
    certPath: resolveHackLocalCaCertPath(),
    timeoutMs: READ_TIMEOUT_MS,
  }).catch(() => null);
  return {
    caPem: identity?.currentPem ?? null,
    loopbackPorts: identity?.loopbackPorts ?? null,
  };
}

/**
 * The Caddy container's addresses on its networks: what CoreDNS answers a
 * routed name with (a static `template` answer or a `rewrite` to `caddy`).
 * Null when the container or its networks cannot be read.
 */
export async function readCaddyAddresses(): Promise<string[] | null> {
  const selected = await exec(
    [
      "docker",
      "ps",
      "--quiet",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${GLOBAL_CADDY_PROJECT_NAME}`,
      "--filter",
      "label=com.docker.compose.service=caddy",
    ],
    { stdin: "ignore", timeoutMs: READ_TIMEOUT_MS }
  ).catch(() => null);
  const id = selected?.exitCode === 0 ? selected.stdout.trim() : "";
  if (id === "" || id.includes("\n")) {
    return null;
  }
  const inspected = await exec(
    [
      "docker",
      "inspect",
      "--type",
      "container",
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{.GlobalIPv6Address}} {{end}}",
      id,
    ],
    { stdin: "ignore", timeoutMs: READ_TIMEOUT_MS }
  ).catch(() => null);
  if (!inspected || inspected.exitCode !== 0) {
    return null;
  }
  const addresses = inspected.stdout
    .split(WHITESPACE)
    .filter((address) => isIP(address) !== 0);
  return addresses.length > 0 ? addresses : null;
}

/** One HTTPS look at each address, verified against the proxy's CA. */
export async function probeProxyHttpsAt(opts: {
  readonly addresses: readonly string[];
  readonly caPem: string;
}): Promise<{ readonly address: string; readonly state: ProxyHttpsState }[]> {
  return await Promise.all(
    opts.addresses.map(async (address) => ({
      address,
      state: await probeProxyHttps({
        address,
        port: 443,
        caPem: opts.caPem,
        timeoutMs: 2000,
      }),
    }))
  );
}
