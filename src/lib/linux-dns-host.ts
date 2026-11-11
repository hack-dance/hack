import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, readTextFile } from "./fs.ts";
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

/**
 * Real host boundary. Reads `/etc`, `ip` and `resolvectl` output, writes only
 * fresh private directories under `stageRoot`, and runs root steps as
 * `sudo <argv>` with the terminal attached so sudo can ask for a password.
 */
export function createLinuxDnsHost(opts: {
  readonly stageRoot: string;
}): LinuxDnsHost {
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
    stageFiles: async (files) => {
      await ensureDir(opts.stageRoot);
      // mkdtemp: a new directory with an unpredictable name, mode 0700.
      const dir = await mkdtemp(join(opts.stageRoot, "linux-dns-"));
      const cleanup = async () => {
        await rm(dir, { recursive: true, force: true });
      };
      try {
        const paths: string[] = [];
        for (const file of files) {
          const path = join(dir, file.name);
          // "wx": create exclusively; never follow or reuse an existing path.
          await writeFile(path, file.content, { flag: "wx", mode: 0o600 });
          paths.push(path);
        }
        return { paths, cleanup };
      } catch (error) {
        await cleanup();
        throw error;
      }
    },
    // Only a vetted system sudo, never one found on PATH (privileged-sudo.ts).
    runPrivileged: async (argv) => await runTrustedSudo(argv),
  };
}

async function readResolvectlLinkRoute(
  link: string
): Promise<LinuxLinkRoute | null> {
  const [dns, domain, defaultRoute] = await Promise.all(
    ["dns", "domain", "default-route"].map((verb) =>
      probe(["resolvectl", verb, "--", link])
    )
  );
  if (!(dns && domain) || dns.exitCode !== 0 || domain.exitCode !== 0) {
    return null;
  }
  const routeValue =
    defaultRoute?.exitCode === 0
      ? parseResolvectlLinkValues(defaultRoute.stdout)[0]
      : undefined;
  return {
    dns: parseResolvectlLinkValues(dns.stdout),
    domains: parseResolvectlLinkValues(domain.stdout),
    defaultRoute: routeValue === undefined ? null : routeValue === "yes",
  };
}
