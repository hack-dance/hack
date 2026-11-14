/**
 * macOS host DNS checks for Hack's routed suffixes (read-only): the
 * `/etc/resolver/<tld>` files, the dnsmasq address lines, and a DNS answer
 * from 127.0.0.1:53. Shared by `hack doctor` and `hack global status
 * --observe`. They read files, run `brew --prefix` and send one DNS
 * query; nothing is started or changed.
 */
import { readFile } from "node:fs/promises";
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

/** An observe-only check: ok, confirmed missing or different, or could not look. */
export type ObservedCheck = {
  readonly name: string;
  readonly outcome: "ok" | "missing" | "unknown";
  readonly message: string;
};

/** Bound for `brew --prefix` in an observe-only read. */
export const BREW_PREFIX_TIMEOUT_MS = 3000;

/**
 * The same checks as `hack doctor` for `hack global status --observe`, but
 * keeping "could not look" apart from "not set up": only a missing file is
 * missing; a file that cannot be read, a Homebrew prefix that cannot be
 * found, or a Caddy address Docker could not give is unknown. Reads files,
 * runs `brew --prefix` (bounded) and sends one DNS question (AAAA, then A).
 */
export async function observeMacHostDns(opts: {
  readonly domains: readonly string[];
  /** Caddy's address, null when Docker confirms none, "unknown" otherwise. */
  readonly caddyIp: () => Promise<string | null | "unknown">;
}): Promise<readonly ObservedCheck[]> {
  const prefix = await observeBrewPrefix();
  const checks: ObservedCheck[] = [];
  for (const domain of opts.domains) {
    checks.push(await observeResolver(domain));
  }
  for (const domain of opts.domains) {
    checks.push(
      await observeDnsmasqLine({ domain, prefix, caddyIp: opts.caddyIp })
    );
  }
  const port53 = await checkMacDnsmasqPort53();
  checks.push({
    name: port53.name,
    // No answer from 127.0.0.1:53 is what a stopped dnsmasq looks like.
    outcome: port53.status === "ok" ? "ok" : "missing",
    message: port53.message,
  });
  return checks;
}

async function readOutcome(
  path: string
): Promise<{ readonly text: string } | "missing" | "unknown"> {
  try {
    return { text: await readFile(path, "utf8") };
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown";
  }
}

async function observeResolver(domain: string): Promise<ObservedCheck> {
  const name = `resolver:${domain}`;
  const path = `/etc/resolver/${domain}`;
  const read = await readOutcome(path);
  if (read === "missing") {
    return { name, outcome: "missing", message: `Missing ${path}` };
  }
  if (read === "unknown") {
    return { name, outcome: "unknown", message: `Could not read ${path}` };
  }
  return resolverHasNameserver({ text: read.text, nameserver: "127.0.0.1" })
    ? { name, outcome: "ok", message: path }
    : {
        name,
        outcome: "missing",
        message: `Unexpected contents in ${path} (expected "nameserver 127.0.0.1")`,
      };
}

async function observeBrewPrefix(): Promise<string | null> {
  if (!findExecutableInPath("brew")) {
    return null;
  }
  const res = await exec(["brew", "--prefix"], {
    stdin: "ignore",
    timeoutMs: BREW_PREFIX_TIMEOUT_MS,
  }).catch(() => null);
  const prefix = res?.exitCode === 0 ? res.stdout.trim() : "";
  return prefix.length > 0 ? prefix : null;
}

async function observeDnsmasqLine(opts: {
  readonly domain: string;
  readonly prefix: string | null;
  readonly caddyIp: () => Promise<string | null | "unknown">;
}): Promise<ObservedCheck> {
  const name = `dnsmasq.conf:${opts.domain}`;
  if (opts.prefix === null) {
    return {
      name,
      outcome: "unknown",
      message:
        "Homebrew's prefix could not be found, so dnsmasq.conf cannot be located",
    };
  }
  const path = resolve(opts.prefix, "etc", "dnsmasq.conf");
  const read = await readOutcome(path);
  if (read === "missing") {
    return { name, outcome: "missing", message: `Missing ${path}` };
  }
  if (read === "unknown") {
    return { name, outcome: "unknown", message: `Could not read ${path}` };
  }
  if (dnsmasqConfigHasDomain({ text: read.text, domain: opts.domain })) {
    return { name, outcome: "ok", message: path };
  }
  const prefixLine = `address=/.${opts.domain}/`;
  const lines = read.text.split("\n").map((line) => line.trim());
  if (!lines.some((line) => line.startsWith(prefixLine))) {
    return {
      name,
      outcome: "missing",
      message: `Missing .${opts.domain} dnsmasq address line in ${path}`,
    };
  }
  // A line exists for another address: only Caddy's current one can tell.
  const ip = await opts.caddyIp();
  if (ip === "unknown") {
    return {
      name,
      outcome: "unknown",
      message: `${path} routes .${opts.domain} to an address only Docker could confirm`,
    };
  }
  return ip !== null && lines.includes(`${prefixLine}${ip}`)
    ? { name, outcome: "ok", message: path }
    : {
        name,
        outcome: "missing",
        message: `The .${opts.domain} line in ${path} does not point at Caddy`,
      };
}
