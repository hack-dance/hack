/**
 * Apply Caddy's local root CA to the Linux trust stores. All effects go
 * through {@link LinuxTrustHost}; root steps run only after `confirm()`.
 *
 * Every writer receives a {@link ValidatedCa} plus the path of a private
 * copy of exactly those bytes (`stagedPath`), never the user-writable
 * export: what was validated and shown is what gets trusted.
 */
import { join } from "node:path";
import {
  bundleContainsCertificate,
  detectLinuxDistroFamily,
  findOtherCaddyRoots,
  hasTlsIssuerTrust,
  type LinuxDistroFamily,
  linuxSystemBundlePath,
  linuxSystemTrustCommands,
  nssAddArgv,
  nssCreateArgv,
  nssDeleteArgv,
  nssExportArgv,
  nssListTrustArgv,
  nssModifyTrustArgv,
  parseNssTrustFlags,
  renderUnknownDistroTrustSteps,
  type ValidatedCa,
} from "./linux-trust.ts";

/** Ownership facts for a path after resolving every symlink. */
export type ResolvedPathInfo = {
  readonly realPath: string;
  readonly uid: number;
  readonly mode: number;
  readonly isDirectory: boolean;
};

export type LinuxTrustHost = {
  readonly homeDir: string;
  /** `$XDG_CONFIG_HOME` when absolute, else `~/.config`. */
  readonly configHome: string;
  /** The current user's uid; NSS writes require databases it owns. */
  readonly uid: number;
  /** File text, or `null` when absent or unreadable. */
  readonly readFile: (path: string) => Promise<string | null>;
  /** Entry names in a directory, or `[]` when absent. */
  readonly listDir: (path: string) => Promise<readonly string[]>;
  /** realpath + stat, or `null` when the path does not exist. */
  readonly inspectPath: (path: string) => Promise<ResolvedPathInfo | null>;
  /** Create a directory and its parents (mode 0700); false on failure. */
  readonly makeDir: (path: string) => Promise<boolean>;
  /** Absolute path of an executable (PATH, then sbin/bin), or `null`. */
  readonly resolveCommand: (name: string) => Promise<string | null>;
  /**
   * Unprivileged command (certutil) by absolute path. A spawn failure is
   * returned as exit 127, never thrown.
   */
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
  | "linux_trust_ca_invalid"
  | "linux_trust_ca_unverified"
  | "linux_trust_tool_missing"
  | "linux_trust_nss_certutil_missing";

export type LinuxSystemTrustOutcome =
  | {
      readonly status: "trusted";
      readonly family: LinuxDistroFamily;
      /** Other Caddy roots still in the bundle (SHA-256), e.g. after rotation. */
      readonly otherCaddyRoots: readonly string[];
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

/**
 * Add the validated CA to the distribution trust store. `show` receives the
 * commands and the certificate's SHA-256 fingerprint before the prompt.
 */
export async function applyLinuxSystemTrust(opts: {
  readonly host: LinuxTrustHost;
  readonly ca: ValidatedCa;
  readonly stagedPath: string;
  readonly canPrompt: boolean;
  readonly show: (
    commands: readonly (readonly string[])[],
    fingerprint256: string
  ) => void;
  readonly confirm: () => Promise<boolean>;
}): Promise<LinuxSystemTrustOutcome> {
  const { host, ca, stagedPath } = opts;
  const family = detectLinuxDistroFamily(
    await host.readFile("/etc/os-release")
  );
  if (family === null) {
    return {
      status: "manual",
      code: "linux_trust_distro_unknown",
      family: null,
      steps: renderUnknownDistroTrustSteps({
        certPath: stagedPath,
        sha256: ca.pemSha256,
      }),
    };
  }
  const bundlePath = linuxSystemBundlePath(family);
  const trusted = async (): Promise<LinuxSystemTrustOutcome | null> => {
    const bundle = (await host.readFile(bundlePath)) ?? "";
    return bundleContainsCertificate({ bundle, certPem: ca.pem })
      ? {
          status: "trusted",
          family,
          otherCaddyRoots: findOtherCaddyRoots({
            bundle,
            current: ca.certificate,
          }),
        }
      : null;
  };
  const already = await trusted();
  if (already) {
    return already;
  }
  const tool = REFRESH_TOOL[family];
  if ((await host.resolveCommand(tool)) === null) {
    return {
      status: "manual",
      code: "linux_trust_tool_missing",
      family,
      steps: [
        `${tool} is not installed. Install the ${TOOL_PACKAGE[family]} package, then rerun hack global trust.`,
      ],
    };
  }
  const commands = linuxSystemTrustCommands({
    family,
    certPath: stagedPath,
    sha256: ca.pemSha256,
  });
  const pending = {
    status: "pending",
    code: "linux_trust_system_pending",
    family,
    commands,
  } as const;
  // No root command runs without an interactive yes, and none at all when
  // prompting is unavailable (--no-interactive, HACK_NO_INTERACTIVE, no TTY).
  if (!opts.canPrompt) {
    return pending;
  }
  opts.show(commands, ca.fingerprint256);
  if (!(await opts.confirm())) {
    return pending;
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
  return (
    (await trusted()) ?? { status: "applied_unverified", family, bundlePath }
  );
}

const MAX_NICKNAME_DELETES = 8;

export type NssDbOutcome = {
  readonly dbDir: string;
  readonly status:
    | "trusted"
    | "added"
    | "replaced"
    | "trust_set"
    | "refused"
    | "failed";
  /** Why a database was refused or failed (no file contents). */
  readonly reason?: string;
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

/** NSS databases: the shared user db plus every browser profile found. */
export async function findNssDatabases(
  host: LinuxTrustHost
): Promise<readonly string[]> {
  const home = host.homeDir;
  const dirs = [join(home, ".pki", "nssdb")];
  const hasDb = async (dir: string) =>
    (await host.listDir(dir)).includes("cert9.db");
  // Sandboxed Chromium keeps its own user db; use it only when it exists.
  const sandboxedUserDbs = [
    join(home, "snap", "chromium", "current", ".pki", "nssdb"),
    ...[...(await host.listDir(join(home, ".var", "app")))]
      .sort()
      .map((app) => join(home, ".var", "app", app, ".pki", "nssdb")),
  ];
  for (const dir of sandboxedUserDbs) {
    if (await hasDb(dir)) {
      dirs.push(dir);
    }
  }
  const firefoxRoots = [
    join(home, ".mozilla", "firefox"),
    // Newer Firefox releases create profiles under the XDG config dir.
    join(host.configHome, "mozilla", "firefox"),
    join(home, "snap", "firefox", "common", ".mozilla", "firefox"),
    join(home, ".var", "app", "org.mozilla.firefox", ".mozilla", "firefox"),
    join(
      home,
      ".var",
      "app",
      "org.mozilla.firefox",
      "config",
      "mozilla",
      "firefox"
    ),
  ];
  for (const root of firefoxRoots) {
    for (const name of [...(await host.listDir(root))].sort()) {
      const profile = join(root, name);
      if (await hasDb(profile)) {
        dirs.push(profile);
      }
    }
  }
  return dirs;
}

type OwnershipCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

function ownedAndPrivate(info: ResolvedPathInfo, uid: number): boolean {
  return info.uid === uid && (info.mode & 0o022) === 0;
}

/**
 * NSS write policy. A database is written only when, after resolving every
 * symlink, its directory lies inside the user's resolved home directory (or
 * resolved XDG config directory) and both the directory and its `cert9.db`
 * are owned by the current user and not group- or world-writable.
 * Symlinks are therefore allowed only when they stay inside those trees,
 * as snap's `current` revision link and Flatpak's per-app tree do; a link
 * to another user's or a shared database is refused.
 */
export async function checkNssDbOwnership(opts: {
  readonly host: LinuxTrustHost;
  readonly dbDir: string;
  readonly requireDb: boolean;
}): Promise<OwnershipCheck> {
  const { host, dbDir } = opts;
  const roots = (
    await Promise.all(
      [host.homeDir, host.configHome].map((path) => host.inspectPath(path))
    )
  )
    .filter((info): info is ResolvedPathInfo => info !== null)
    .map((info) => info.realPath);
  const dir = await host.inspectPath(dbDir);
  if (!dir?.isDirectory) {
    return { ok: false, reason: "not a directory" };
  }
  if (!roots.some((root) => dir.realPath.startsWith(`${root}/`))) {
    return {
      ok: false,
      reason: `resolves outside your home directory (${dir.realPath})`,
    };
  }
  if (!ownedAndPrivate(dir, host.uid)) {
    return {
      ok: false,
      reason: "directory is not owned by you or is group/world-writable",
    };
  }
  if (!opts.requireDb) {
    return { ok: true };
  }
  const db = await host.inspectPath(join(dir.realPath, "cert9.db"));
  if (!db || db.isDirectory || !ownedAndPrivate(db, host.uid)) {
    return {
      ok: false,
      reason: "cert9.db is missing, not owned by you, or group/world-writable",
    };
  }
  return { ok: true };
}

/**
 * Add the CA to each owned NSS db (no root). A db that holds another
 * certificate under Hack's nickname gets it replaced; one that holds this
 * CA without TLS issuer trust gets the trust set. The shared user db is
 * created (directory first, then `certutil -N`) when missing.
 */
export async function applyLinuxNssTrust(opts: {
  readonly host: LinuxTrustHost;
  readonly ca: ValidatedCa;
  readonly stagedPath: string;
}): Promise<LinuxNssTrustOutcome> {
  const { host } = opts;
  const certutil = await host.resolveCommand("certutil");
  if (certutil === null) {
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
  const userDb = join(host.homeDir, ".pki", "nssdb");
  const databases: NssDbOutcome[] = [];
  for (const dbDir of await findNssDatabases(host)) {
    databases.push(
      await trustOneNssDb({
        host,
        db: { certutil, dbDir },
        ca: opts.ca,
        stagedPath: opts.stagedPath,
        createIfMissing: dbDir === userDb,
      })
    );
  }
  return { status: "done", databases };
}

type NssDb = { readonly certutil: string; readonly dbDir: string };

/** Create the user db: directory first, check it is ours, then `certutil -N`. */
async function ensureUserDb(opts: {
  readonly host: LinuxTrustHost;
  readonly db: NssDb;
}): Promise<NssDbOutcome | null> {
  const { host, db } = opts;
  const { dbDir } = db;
  if ((await host.listDir(dbDir)).includes("cert9.db")) {
    return null;
  }
  if (!(await host.makeDir(dbDir))) {
    return {
      dbDir,
      status: "failed",
      reason: "could not create the directory",
    };
  }
  const owned = await checkNssDbOwnership({ host, dbDir, requireDb: false });
  if (!owned.ok) {
    return { dbDir, status: "refused", reason: owned.reason };
  }
  const created = await host.exec(nssCreateArgv(db));
  return created.exitCode === 0
    ? null
    : { dbDir, status: "failed", reason: "certutil -N failed" };
}

async function trustOneNssDb(opts: {
  readonly host: LinuxTrustHost;
  readonly db: NssDb;
  readonly ca: ValidatedCa;
  readonly stagedPath: string;
  readonly createIfMissing: boolean;
}): Promise<NssDbOutcome> {
  const { host, db } = opts;
  const { dbDir } = db;
  if (opts.createIfMissing) {
    const created = await ensureUserDb({ host, db });
    if (created) {
      return created;
    }
  }
  const owned = await checkNssDbOwnership({ host, dbDir, requireDb: true });
  if (!owned.ok) {
    return { dbDir, status: "refused", reason: owned.reason };
  }
  const exported = await host.exec(nssExportArgv(db));
  const present = exported.exitCode === 0;
  if (
    present &&
    bundleContainsCertificate({ bundle: exported.stdout, certPem: opts.ca.pem })
  ) {
    return await ensureTlsIssuerTrust({ host, db });
  }
  if (present) {
    await deleteNicknameEntries({ host, db });
  }
  const added = await host.exec(
    nssAddArgv({ ...db, certPath: opts.stagedPath })
  );
  if (added.exitCode !== 0) {
    return { dbDir, status: "failed", reason: "certutil -A failed" };
  }
  const flags = await readTrustFlags({ host, db });
  if (!hasTlsIssuerTrust(flags)) {
    return {
      dbDir,
      status: "failed",
      reason: `added, but trust attributes are ${flags ?? "unreadable"}`,
    };
  }
  return { dbDir, status: present ? "replaced" : "added" };
}

/** `certutil -D -n` removes one entry per call; clear them all (bounded). */
async function deleteNicknameEntries(opts: {
  readonly host: LinuxTrustHost;
  readonly db: NssDb;
}): Promise<void> {
  for (let attempt = 0; attempt < MAX_NICKNAME_DELETES; attempt += 1) {
    if ((await opts.host.exec(nssDeleteArgv(opts.db))).exitCode !== 0) {
      return;
    }
    if ((await opts.host.exec(nssExportArgv(opts.db))).exitCode !== 0) {
      return;
    }
  }
}

async function readTrustFlags(opts: {
  readonly host: LinuxTrustHost;
  readonly db: NssDb;
}): Promise<string | null> {
  const listed = await opts.host.exec(nssListTrustArgv(opts.db));
  return listed.exitCode === 0
    ? parseNssTrustFlags({ listing: listed.stdout })
    : null;
}

/** Same bytes are not enough: the entry must carry TLS issuer trust. */
async function ensureTlsIssuerTrust(opts: {
  readonly host: LinuxTrustHost;
  readonly db: NssDb;
}): Promise<NssDbOutcome> {
  const { host, db } = opts;
  if (hasTlsIssuerTrust(await readTrustFlags({ host, db }))) {
    return { dbDir: db.dbDir, status: "trusted" };
  }
  const modified = await host.exec(nssModifyTrustArgv(db));
  const after = await readTrustFlags({ host, db });
  if (modified.exitCode !== 0 || !hasTlsIssuerTrust(after)) {
    return {
      dbDir: db.dbDir,
      status: "failed",
      reason: `present without TLS issuer trust (${after ?? "unreadable"}); certutil -M failed`,
    };
  }
  return { dbDir: db.dbDir, status: "trust_set" };
}
