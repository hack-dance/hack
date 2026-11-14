/**
 * macOS host DNS checks for Hack's routed suffixes (read-only): the
 * `/etc/resolver/<tld>` files, the dnsmasq address lines, and a DNS answer
 * from 127.0.0.1:53. Shared by `hack doctor` and `hack global status
 * --observe`. They read files, run `brew --prefix` and send one DNS
 * query; nothing is started or changed.
 */
import { resolve } from "node:path";
import { DEFAULT_CADDY_IP, LEGACY_GRAFANA_HOST } from "../constants.ts";
import { resolveGlobalCaddyIp } from "../lib/caddy-hosts.ts";
import { queryDnsARecord } from "../lib/dns-query.ts";
import { pathExists, readTextFile } from "../lib/fs.ts";
import { exec, findExecutableInPath } from "../lib/shell.ts";
import {
  dnsmasqConfigHasDomain,
  resolverHasNameserver,
} from "./doctor-utils.ts";

/** One check's outcome, in `hack doctor`'s shape. */
export type CheckResult = {
  readonly name: string;
  readonly status: "ok" | "warn" | "error";
  readonly message: string;
};

export async function checkMacResolverForDomain(
  domain: string
): Promise<CheckResult> {
  const resolverPath = `/etc/resolver/${domain}`;
  const exists = await pathExists(resolverPath);
  if (!exists) {
    return {
      name: `resolver:${domain}`,
      status: "warn",
      message: `Missing ${resolverPath} (run: hack global install)`,
    };
  }

  const text = (await readTextFile(resolverPath)) ?? "";
  const hasNameserver = resolverHasNameserver({
    text,
    nameserver: "127.0.0.1",
  });

  return {
    name: `resolver:${domain}`,
    status: hasNameserver ? "ok" : "warn",
    message: hasNameserver
      ? resolverPath
      : `Unexpected contents in ${resolverPath} (expected "nameserver 127.0.0.1")`,
  };
}

export async function checkMacDnsmasqConfigForDomain(
  domain: string,
  opts?: {
    /**
     * How to find Caddy's current address for a dynamic dnsmasq line;
     * `hack global status --observe` passes one that never asks Docker when
     * Docker was not found running. Default: ask Docker.
     */
    readonly caddyIp?: () => Promise<string | null>;
  }
): Promise<CheckResult> {
  const brew = await findExecutableInPath("brew");
  if (!brew) {
    return {
      name: `dnsmasq.conf:${domain}`,
      status: "warn",
      message: "Homebrew not found; cannot locate dnsmasq.conf",
    };
  }

  const prefixRes = await exec(["brew", "--prefix"], { stdin: "ignore" });
  const brewPrefix =
    prefixRes.exitCode === 0 ? prefixRes.stdout.trim() : "/opt/homebrew";
  const dnsmasqConf = resolve(brewPrefix, "etc", "dnsmasq.conf");
  const text = await readTextFile(dnsmasqConf);

  if (text === null) {
    return {
      name: `dnsmasq.conf:${domain}`,
      status: "warn",
      message: `Unable to read ${dnsmasqConf} (run: hack global install)`,
    };
  }

  let ok = dnsmasqConfigHasDomain({ text, domain });
  if (!ok) {
    const dynamicIp = await (opts?.caddyIp ?? resolveGlobalCaddyIp)();
    ok =
      dynamicIp !== null &&
      text
        .split("\n")
        .some((line) => line.trim() === `address=/.${domain}/${dynamicIp}`);
  }
  return {
    name: `dnsmasq.conf:${domain}`,
    status: ok ? "ok" : "warn",
    message: ok
      ? dnsmasqConf
      : `Missing .${domain} dnsmasq address line in ${dnsmasqConf} (run: hack global install)`,
  };
}

export async function checkMacDnsmasqPort53(): Promise<CheckResult> {
  const ip = await queryDnsARecord({
    hostname: LEGACY_GRAFANA_HOST,
    server: "127.0.0.1",
    port: 53,
    timeoutMs: 900,
  });

  if (!ip) {
    return {
      name: "dnsmasq:53",
      status: "warn",
      message:
        "No DNS response from 127.0.0.1:53 (run: sudo brew services restart dnsmasq)",
    };
  }

  const ok = ip === DEFAULT_CADDY_IP || ip === "::1" || ip === "127.0.0.1";
  return {
    name: "dnsmasq:53",
    status: ok ? "ok" : "warn",
    message: `${LEGACY_GRAFANA_HOST} → ${ip} (from 127.0.0.1:53)`,
  };
}
