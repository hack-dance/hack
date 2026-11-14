/** Shared argv preparation for install's macOS administrator operations. */
import { dirname } from "node:path";
import { run } from "../lib/shell.ts";

const WHITESPACE = /\s+/;

export function macPrivilegedAttempts(opts: {
  readonly command: readonly string[];
  readonly interactive: boolean;
}): readonly (readonly string[])[] {
  return [
    ["sudo", "-n", ...opts.command],
    ...(opts.interactive ? [["sudo", ...opts.command]] : []),
  ];
}

/** Try without a password first, then attach the terminal only when permitted. */
export async function executeMacPrivilegedCommand(opts: {
  readonly command: readonly string[];
  readonly interactive: boolean;
  readonly runner?: typeof run;
}): Promise<number> {
  let exit = 1;
  for (const [index, argv] of macPrivilegedAttempts(opts).entries()) {
    exit = await (opts.runner ?? run)(argv, {
      stdin: index === 0 ? "ignore" : "inherit",
    });
    if (exit === 0) {
      return 0;
    }
  }
  return exit;
}

export function macResolverArgv(domain: string): readonly string[] {
  return [
    "sudo",
    "sh",
    "-c",
    `mkdir -p /etc/resolver && printf '%s\\n' 'nameserver 127.0.0.1' > /etc/resolver/${domain}`,
  ];
}

export function macRestartCommands(opts: {
  readonly helperPath: string;
  readonly helperInstalled: boolean;
  readonly brew: string | null;
}): readonly (readonly string[])[] {
  return [
    ...(opts.helperInstalled ? [[opts.helperPath, "restart-dnsmasq"]] : []),
    ...(opts.brew ? [[opts.brew, "services", "restart", "dnsmasq"]] : []),
  ];
}

export function macFlushCommands(opts: {
  readonly helperPath: string;
  readonly helperInstalled: boolean;
}): readonly (readonly string[])[] {
  return opts.helperInstalled
    ? [[opts.helperPath, "flush-cache"]]
    : [
        ["/usr/bin/dscacheutil", "-flushcache"],
        ["/usr/bin/killall", "-HUP", "mDNSResponder"],
      ];
}

/** Ordered authorization argv; the caller retains all validation gates. */
export function macAuthorizationArgv(opts: {
  readonly helperPath: string;
  readonly helperTempPath: string;
  readonly sudoersPath: string;
  readonly sudoersTempPath: string;
  readonly visudo: string;
}): {
  readonly helperDirectory: readonly string[];
  readonly helper: readonly string[];
  readonly sudoersDirectory: readonly string[];
  readonly sudoers: readonly string[];
  readonly validate: readonly string[];
  readonly invalidate: readonly string[];
  readonly check: readonly string[];
} {
  return {
    helperDirectory: [
      "sudo",
      "install",
      "-d",
      "-o",
      "root",
      "-g",
      "wheel",
      "-m",
      "0755",
      dirname(opts.helperPath),
    ],
    helper: [
      "sudo",
      "install",
      "-o",
      "root",
      "-g",
      "wheel",
      "-m",
      "0755",
      opts.helperTempPath,
      opts.helperPath,
    ],
    sudoersDirectory: [
      "sudo",
      "install",
      "-d",
      "-o",
      "root",
      "-g",
      "wheel",
      "-m",
      "0755",
      "/etc/sudoers.d",
    ],
    sudoers: [
      "sudo",
      "install",
      "-o",
      "root",
      "-g",
      "wheel",
      "-m",
      "0440",
      opts.sudoersTempPath,
      opts.sudoersPath,
    ],
    validate: ["sudo", opts.visudo, "-cf", opts.sudoersPath],
    invalidate: ["sudo", "-k"],
    check: ["sudo", "-n", opts.helperPath, "check"],
  };
}

/** Same service-state predicate used before the global stack starts. */
export function macDnsmasqNeedsStart(services: string): boolean {
  const line = services
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.startsWith("dnsmasq"));
  const parts = line?.split(WHITESPACE) ?? [];
  return parts[1] !== "started" || parts[2] !== "root";
}
