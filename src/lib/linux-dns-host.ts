import { readdir, readFile } from "node:fs/promises";
import { readTextFile } from "./fs.ts";
import {
  isResolvectlLinkAnswer,
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

function isMissing(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
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
export function createLinuxDnsHost(opts?: {
  /**
   * Observe-only callers (`hack global status --observe`) pass this to learn
   * when an answer rests on a failed read rather than on what is there: a
   * file or directory that exists but cannot be read, or a probe that failed
   * or timed out. Reads are then strict (only a missing path is absent).
   * Without it, behaviour is unchanged.
   */
  readonly onUnreadable?: (what: string) => void;
}): LinuxDnsHost {
  const unreadable = opts?.onUnreadable;
  const failed = (res: ExecResult) =>
    res.exitCode === 124 || res.exitCode === 127;
  return {
    readFile: async (path) => {
      if (unreadable) {
        try {
          return await readFile(path, "utf8");
        } catch (error: unknown) {
          if (!isMissing(error)) {
            unreadable(`read ${path}`);
          }
          return null;
        }
      }
      try {
        return await readTextFile(path);
      } catch {
        return null;
      }
    },
    listDir: async (path) => {
      try {
        return await readdir(path);
      } catch (error: unknown) {
        if (unreadable && !isMissing(error)) {
          unreadable(`list ${path}`);
        }
        return [];
      }
    },
    isResolvedActive: async () => {
      const res = await probe(["systemctl", "is-active", "systemd-resolved"]);
      if (unreadable && failed(res)) {
        unreadable("systemctl is-active systemd-resolved");
      }
      return res.exitCode === 0 && res.stdout.trim() === "active";
    },
    systemdVersion: async () => {
      const res = await probe(["systemctl", "--version"]);
      if (unreadable && res.exitCode !== 0) {
        unreadable("systemctl --version");
      }
      return res.exitCode === 0 ? parseSystemdVersion(res.stdout) : null;
    },
    findLinkWithAddress: async (address) => {
      // JSON gives the exact ifname (the text form can append `@peer`).
      const res = await probe(["ip", "-j", "-4", "addr", "show"]);
      if (unreadable && res.exitCode !== 0) {
        unreadable("ip -j -4 addr show");
      }
      return res.exitCode === 0
        ? parseLinkForAddress({ ipJson: res.stdout, address })
        : null;
    },
    readLinkRoute: async (link) => {
      const { route, failed } = await readResolvectlLinkRoute(link);
      if (unreadable) {
        for (const verb of failed) {
          unreadable(`resolvectl ${verb} -- ${link}`);
        }
      }
      return route;
    },
    unitNeedsReload: async (unit) => {
      const res = await probe([
        "systemctl",
        "show",
        "-p",
        "NeedDaemonReload",
        "--",
        unit,
      ]);
      const value =
        res.exitCode === 0 ? parseNeedDaemonReload(res.stdout) : null;
      if (unreadable && value === null) {
        unreadable(`systemctl show -p NeedDaemonReload -- ${unit}`);
      }
      return value;
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

/**
 * The link's resolved state from the five per-link queries, and the verbs
 * whose query failed (errored, timed out or answered nothing for a
 * single-value setting). `route` is null when dns or domain failed, as
 * before; a partial route carries null for a failed single value.
 */
async function readResolvectlLinkRoute(link: string): Promise<{
  readonly route: LinuxLinkRoute | null;
  readonly failed: readonly string[];
}> {
  const results = await Promise.all(
    LINK_VERBS.map((verb) => probe(["resolvectl", verb, "--", link]))
  );
  const [dns, domain, defaultRoute, dnssec, dnsOverTls] = results;
  const single = (res: ExecResult | undefined): string | null =>
    res?.exitCode === 0
      ? (parseResolvectlLinkValues(res.stdout)[0] ?? null)
      : null;
  const failed = LINK_VERBS.filter((_verb, index) => {
    const res = results[index];
    if (res === undefined || res.exitCode !== 0) {
      return true;
    }
    // Every answer must be recognizable; dns and domain may then be empty,
    // the single-value settings always carry a value.
    if (!isResolvectlLinkAnswer(res.stdout)) {
      return true;
    }
    return index >= 2 && single(res) === null;
  });
  if (!(dns && domain) || dns.exitCode !== 0 || domain.exitCode !== 0) {
    return { route: null, failed };
  }
  const routeValue = single(defaultRoute);
  return {
    route: {
      dns: parseResolvectlLinkValues(dns.stdout),
      domains: parseResolvectlLinkValues(domain.stdout),
      defaultRoute: routeValue === null ? null : routeValue === "yes",
      dnssec: single(dnssec),
      dnsOverTls: single(dnsOverTls),
    },
    failed,
  };
}
