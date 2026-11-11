/**
 * Apply Caddy's local root CA to the Linux trust stores. All effects go
 * through {@link LinuxTrustHost}; root steps run only after `confirm()`.
 */
import { join } from "node:path";
import {
  bundleContainsCertificate,
  detectLinuxDistroFamily,
  type LinuxDistroFamily,
  linuxSystemBundlePath,
  linuxSystemTrustCommands,
  nssAddArgv,
  nssCreateArgv,
  nssDeleteArgv,
  nssListArgv,
  renderUnknownDistroTrustSteps,
} from "./linux-trust.ts";

export type LinuxTrustHost = {
  readonly homeDir: string;
  /** File text, or `null` when absent or unreadable. */
  readonly readFile: (path: string) => Promise<string | null>;
  /** Entry names in a directory, or `[]` when absent. */
  readonly listDir: (path: string) => Promise<readonly string[]>;
  readonly hasCommand: (name: string) => Promise<boolean>;
  /** Unprivileged command (certutil); output is bounded by the host. */
  readonly exec: (
    argv: readonly string[]
  ) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
  /** Run `sudo <argv>` with the terminal attached; returns the exit code. */
  readonly runPrivileged: (argv: readonly string[]) => Promise<number>;
};

export type LinuxTrustCode =
  | "linux_trust_system_pending"
  | "linux_trust_system_failed"
  | "linux_trust_distro_unknown"
  | "linux_trust_tool_missing"
  | "linux_trust_nss_certutil_missing";

export type LinuxSystemTrustOutcome =
  | {
      readonly status: "trusted";
      readonly family: LinuxDistroFamily;
    }
  | {
      /** Hack cannot run it; `steps` are for the user. */
      readonly status: "manual";
      readonly code: LinuxTrustCode;
      readonly family: LinuxDistroFamily | null;
      readonly steps: readonly string[];
    }
  | {
      /** No prompt was possible, or the user declined. Nothing ran. */
      readonly status: "pending";
      readonly code: "linux_trust_system_pending";
      readonly family: LinuxDistroFamily;
      readonly commands: readonly (readonly string[])[];
    }
  | {
      readonly status: "failed";
      readonly code: "linux_trust_system_failed";
      readonly family: LinuxDistroFamily;
      readonly failedCommand: readonly string[];
      readonly exitCode: number;
    }
  | {
      /** Commands ran but the system bundle still lacks the CA. */
      readonly status: "applied_unverified";
      readonly family: LinuxDistroFamily;
      readonly bundlePath: string;
    };

const REFRESH_TOOL: Readonly<Record<LinuxDistroFamily, string>> = {
  debian: "update-ca-certificates",
  fedora: "update-ca-trust",
  suse: "update-ca-certificates",
  arch: "trust",
};

const TOOL_PACKAGE: Readonly<Record<LinuxDistroFamily, string>> = {
  debian: "ca-certificates",
  fedora: "ca-certificates",
  suse: "ca-certificates",
  arch: "p11-kit",
};

export async function applyLinuxSystemTrust(opts: {
  readonly host: LinuxTrustHost;
  readonly certPath: string;
  readonly canPrompt: boolean;
  readonly show: (commands: readonly (readonly string[])[]) => void;
  readonly confirm: () => Promise<boolean>;
}): Promise<LinuxSystemTrustOutcome> {
  const { host, certPath } = opts;
  const family = detectLinuxDistroFamily(
    await host.readFile("/etc/os-release")
  );
  if (family === null) {
    return {
      status: "manual",
      code: "linux_trust_distro_unknown",
      family: null,
      steps: renderUnknownDistroTrustSteps(certPath),
    };
  }
  const certPem = (await host.readFile(certPath)) ?? "";
  const bundlePath = linuxSystemBundlePath(family);
  const isTrusted = async () =>
    bundleContainsCertificate({
      bundle: (await host.readFile(bundlePath)) ?? "",
      certPem,
    });
  if (await isTrusted()) {
    return { status: "trusted", family };
  }
  const tool = REFRESH_TOOL[family];
  if (!(await host.hasCommand(tool))) {
    return {
      status: "manual",
      code: "linux_trust_tool_missing",
      family,
      steps: [
        `${tool} is not installed. Install the ${TOOL_PACKAGE[family]} package, then rerun hack global trust.`,
      ],
    };
  }
  const commands = linuxSystemTrustCommands({ family, certPath });
  opts.show(commands);
  if (!(opts.canPrompt && (await opts.confirm()))) {
    return {
      status: "pending",
      code: "linux_trust_system_pending",
      family,
      commands,
    };
  }
  for (const command of commands) {
    const exitCode = await host.runPrivileged(command);
    if (exitCode !== 0) {
      return {
        status: "failed",
        code: "linux_trust_system_failed",
        family,
        failedCommand: command,
        exitCode,
      };
    }
  }
  return (await isTrusted())
    ? { status: "trusted", family }
    : { status: "applied_unverified", family, bundlePath };
}

export type NssDbOutcome = {
  readonly dbDir: string;
  readonly status: "trusted" | "added" | "replaced" | "failed";
};

export type LinuxNssTrustOutcome =
  | {
      readonly status: "certutil_missing";
      readonly code: "linux_trust_nss_certutil_missing";
      readonly hint: string;
    }
  | { readonly status: "done"; readonly databases: readonly NssDbOutcome[] };

const CERTUTIL_PACKAGE: Readonly<Record<LinuxDistroFamily, string>> = {
  debian: "libnss3-tools",
  fedora: "nss-tools",
  suse: "mozilla-nss-tools",
  arch: "nss",
};

/** NSS databases: the shared user db plus every Firefox profile found. */
export async function findNssDatabases(
  host: LinuxTrustHost
): Promise<readonly string[]> {
  const dirs = [join(host.homeDir, ".pki", "nssdb")];
  const firefoxRoots = [
    join(host.homeDir, ".mozilla", "firefox"),
    join(host.homeDir, "snap", "firefox", "common", ".mozilla", "firefox"),
  ];
  for (const root of firefoxRoots) {
    for (const name of [...(await host.listDir(root))].sort()) {
      const profile = join(root, name);
      if ((await host.listDir(profile)).includes("cert9.db")) {
        dirs.push(profile);
      }
    }
  }
  return dirs;
}

/**
 * Add the CA to each NSS db (no root). A db that holds an older certificate
 * under Hack's nickname gets it replaced. The shared user db is created
 * when missing so Chromium-family browsers pick the CA up on next start.
 */
export async function applyLinuxNssTrust(opts: {
  readonly host: LinuxTrustHost;
  readonly certPath: string;
}): Promise<LinuxNssTrustOutcome> {
  const { host, certPath } = opts;
  if (!(await host.hasCommand("certutil"))) {
    const family = detectLinuxDistroFamily(
      await host.readFile("/etc/os-release")
    );
    const pkg = family
      ? CERTUTIL_PACKAGE[family]
      : "your distribution's NSS tools";
    return {
      status: "certutil_missing",
      code: "linux_trust_nss_certutil_missing",
      hint: `certutil is not installed, so browsers that use NSS (Chrome, Chromium, Firefox) were not updated. Install ${pkg}, then rerun hack global trust.`,
    };
  }
  const certPem = (await host.readFile(certPath)) ?? "";
  const userDb = join(host.homeDir, ".pki", "nssdb");
  const databases: NssDbOutcome[] = [];
  for (const dbDir of await findNssDatabases(host)) {
    databases.push({
      dbDir,
      status: await trustOneNssDb({
        host,
        dbDir,
        certPath,
        certPem,
        createIfMissing: dbDir === userDb,
      }),
    });
  }
  return { status: "done", databases };
}

async function trustOneNssDb(opts: {
  readonly host: LinuxTrustHost;
  readonly dbDir: string;
  readonly certPath: string;
  readonly certPem: string;
  readonly createIfMissing: boolean;
}): Promise<NssDbOutcome["status"]> {
  const { host, dbDir } = opts;
  if (
    opts.createIfMissing &&
    !(await host.listDir(dbDir)).includes("cert9.db") &&
    (await host.exec(nssCreateArgv(dbDir))).exitCode !== 0
  ) {
    return "failed";
  }
  const listed = await host.exec(nssListArgv(dbDir));
  const present = listed.exitCode === 0;
  if (
    present &&
    bundleContainsCertificate({ bundle: listed.stdout, certPem: opts.certPem })
  ) {
    return "trusted";
  }
  if (present) {
    await host.exec(nssDeleteArgv(dbDir));
  }
  const added = await host.exec(nssAddArgv({ dbDir, certPath: opts.certPath }));
  if (added.exitCode !== 0) {
    return "failed";
  }
  return present ? "replaced" : "added";
}
