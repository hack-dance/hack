import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, readTextFile, writeTextFile } from "./fs.ts";
import {
  type LinuxLinkRoute,
  parseLinkForAddress,
  parseResolvectlLinkValues,
} from "./linux-dns.ts";
import type { LinuxDnsHost } from "./linux-dns-setup.ts";
import { exec, run } from "./shell.ts";

const PROBE_TIMEOUT_MS = 3000;

/**
 * Real host boundary. Reads `/etc`, `ip` and `resolvectl` output, writes only
 * under `stageDir`, and runs root steps as `sudo <argv>` with the terminal
 * attached so sudo can ask for a password itself.
 */
export function createLinuxDnsHost(opts: {
  readonly stageDir: string;
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
      const res = await exec(["systemctl", "is-active", "systemd-resolved"], {
        stdin: "ignore",
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      return res.exitCode === 0 && res.stdout.trim() === "active";
    },
    findLinkWithAddress: async (address) => {
      const res = await exec(["ip", "-o", "-4", "addr", "show"], {
        stdin: "ignore",
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      return res.exitCode === 0
        ? parseLinkForAddress({ ipOutput: res.stdout, address })
        : null;
    },
    readLinkRoute: async (link) => await readResolvectlLinkRoute(link),
    stageFile: async ({ name, content }) => {
      await ensureDir(opts.stageDir);
      const path = join(opts.stageDir, name);
      await writeTextFile(path, content);
      return path;
    },
    runPrivileged: async (argv) =>
      await run(["sudo", ...argv], { stdin: "inherit" }),
  };
}

async function readResolvectlLinkRoute(
  link: string
): Promise<LinuxLinkRoute | null> {
  const [dns, domain, defaultRoute] = await Promise.all(
    ["dns", "domain", "default-route"].map((verb) =>
      exec(["resolvectl", verb, link], {
        stdin: "ignore",
        timeoutMs: PROBE_TIMEOUT_MS,
      })
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
