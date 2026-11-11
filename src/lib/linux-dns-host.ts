import { readdir } from "node:fs/promises";
import { readTextFile } from "./fs.ts";
import {
  type LinuxLinkRoute,
  parseLinkForAddress,
  parseResolvectlLinkValues,
  parseSystemdVersion,
} from "./linux-dns.ts";
import type { LinuxDnsHost } from "./linux-dns-setup.ts";
import { runTrustedSudo } from "./privileged-sudo.ts";
import { type ExecResult, exec } from "./shell.ts";

const PROBE_TIMEOUT_MS = 3000;
const UNAVAILABLE: ExecResult = { exitCode: 127, stdout: "", stderr: "" };
const NEED_DAEMON_RELOAD = /^NeedDaemonReload=(yes|no)$/m;

/**
 * Read-only probe. A missing executable (no systemctl on OpenRC hosts, no
 * resolvectl or ip) makes `Bun.spawn` throw; report it as a failed probe so
 * inspection degrades to a diagnostic instead of aborting the command.
 */
async function probe(cmd: readonly string[]): Promise<ExecResult> {
  try {
    return await exec(cmd, { stdin: "ignore", timeoutMs: PROBE_TIMEOUT_MS });
  } catch {
    return UNAVAILABLE;
  }
}

/** `NeedDaemonReload=` from `systemctl show`, or `null` when not reported. */
export function parseNeedDaemonReload(output: string): boolean | null {
  const value = NEED_DAEMON_RELOAD.exec(output)?.[1];
  return value === undefined ? null : value === "yes";
}

/**
 * Real host boundary. Reads `/etc`, `ip`, `systemctl` and `resolvectl`
 * output, writes nothing itself, and runs root steps as `sudo <argv>` with
 * the terminal attached so sudo can ask for a password; file content goes to
 * root on stdin.
 */
export function createLinuxDnsHost(): LinuxDnsHost {
  return {
    readFile: async (path) => {
      try {
        return await readTextFile(path);
      } catch {
        return null;
      }
    },
    listDir: async (path) => {
      try {
        return await readdir(path);
      } catch {
        return [];
      }
    },
    isResolvedActive: async () => {
      const res = await probe(["systemctl", "is-active", "systemd-resolved"]);
      return res.exitCode === 0 && res.stdout.trim() === "active";
    },
    systemdVersion: async () => {
      const res = await probe(["systemctl", "--version"]);
      return res.exitCode === 0 ? parseSystemdVersion(res.stdout) : null;
    },
    findLinkWithAddress: async (address) => {
      // JSON gives the exact ifname (the text form can append `@peer`).
      const res = await probe(["ip", "-j", "-4", "addr", "show"]);
      return res.exitCode === 0
        ? parseLinkForAddress({ ipJson: res.stdout, address })
        : null;
    },
    readLinkRoute: async (link) => await readResolvectlLinkRoute(link),
    unitNeedsReload: async (unit) => {
      const res = await probe([
        "systemctl",
        "show",
        "-p",
        "NeedDaemonReload",
        "--",
        unit,
      ]);
      return res.exitCode === 0 ? parseNeedDaemonReload(res.stdout) : null;
    },
    // Only a vetted system sudo, never one found on PATH (privileged-sudo.ts).
    runPrivileged: async (argv, runOpts) =>
      await runTrustedSudo(
        argv,
        runOpts?.input === undefined ? undefined : { input: runOpts.input }
      ),
  };
}

const LINK_VERBS = [
  "dns",
  "domain",
  "default-route",
  "dnssec",
  "dnsovertls",
] as const;

async function readResolvectlLinkRoute(
  link: string
): Promise<LinuxLinkRoute | null> {
  const [dns, domain, defaultRoute, dnssec, dnsOverTls] = await Promise.all(
    LINK_VERBS.map((verb) => probe(["resolvectl", verb, "--", link]))
  );
  if (!(dns && domain) || dns.exitCode !== 0 || domain.exitCode !== 0) {
    return null;
  }
  const single = (res: ExecResult | undefined): string | null =>
    res?.exitCode === 0
      ? (parseResolvectlLinkValues(res.stdout)[0] ?? null)
      : null;
  const routeValue = single(defaultRoute);
  return {
    dns: parseResolvectlLinkValues(dns.stdout),
    domains: parseResolvectlLinkValues(domain.stdout),
    defaultRoute: routeValue === null ? null : routeValue === "yes",
    dnssec: single(dnssec),
    dnsOverTls: single(dnsOverTls),
  };
}
