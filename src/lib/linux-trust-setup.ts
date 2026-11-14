/**
 * Apply Caddy's local root CA to the Linux trust stores. All effects go
 * through {@link LinuxTrustHost}; root steps run only after `confirm()`.
 *
 * Every writer receives the validated certificate bytes on stdin. No writer
 * reopens the user export after validation or confirmation.
 */
import { dirname, join } from "node:path";
import {
  bundleContainsCertificate,
  detectLinuxDistroFamily,
  findOtherCaddyRoots,
  hasTlsIssuerTrust,
  type LinuxDistroFamily,
  type LinuxTrustToolPaths,
  linuxSystemBundlePath,
  linuxSystemTrustCommands,
  linuxSystemTrustInstallArgv,
  linuxSystemTrustRefreshArgv,
  nssAddArgv,
  nssCreateArgv,
  nssDeleteArgv,
  nssExportArgv,
  nssListTrustArgv,
  nssModifyTrustArgv,
  parseNssTrustFlags,
  pemCertificateBodies,
  renderUnknownDistroTrustSteps,
  requiredLinuxTrustTools,
  type ValidatedCa,
} from "./linux-trust.ts";

/** Ownership facts for a path after resolving every symlink. */
export type ResolvedPathInfo = {
  readonly realPath: string;
  readonly uid: number;
  readonly mode: number;
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly identity: string;
};

export type LinuxTrustHost = {
  readonly homeDir: string;
  /** `$XDG_CONFIG_HOME` when absolute, else `~/.config`. */
  readonly configHome: string;
  /** `$XDG_DATA_HOME` when absolute, else `~/.local/share`. */
  readonly dataHome: string;
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
  /** Vetted root-owned executable from fixed system bin/sbin paths, or `null`. */
  readonly resolveCommand: (name: string) => Promise<string | null>;
  /** The same vetted absolute sudo used by automatic execution. */
  readonly resolveSudo: () => Promise<string | null>;
  /**
   * Unprivileged command (certutil) by absolute path. A spawn failure is
   * returned as exit 127, never thrown.
   */
  readonly exec: (
    argv: readonly string[],
    input?: string
  ) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
  /** Run `sudo <argv>` with the terminal attached; returns the exit code. */
  readonly runPrivileged: (
    argv: readonly string[],
    input?: string
  ) => Promise<number>;
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

async function resolveTrustToolPaths(
  host: LinuxTrustHost
): Promise<LinuxTrustToolPaths> {
  const [trust, caTrust, certificates] = await Promise.all([
    host.resolveCommand("trust"),
    host.resolveCommand("update-ca-trust"),
    host.resolveCommand("update-ca-certificates"),
  ]);
  return {
    trust,
    "update-ca-trust": caTrust,
    "update-ca-certificates": certificates,
  };
}

const TOOL_PACKAGE: Readonly<Record<LinuxDistroFamily, string>> = {
  debian: "ca-certificates",
  fedora: "ca-certificates",
  suse: "ca-certificates",
  arch: "p11-kit",
};

function toolPackage(family: LinuxDistroFamily, tool: string): string {
  return family === "arch" && tool === "update-ca-trust"
    ? "ca-certificates-utils"
    : TOOL_PACKAGE[family];
}

/**
 * Everything `hack global trust` decides about the system trust store before
 * any root command, from one read-only look at the host (HACK-2218): either
 * a final outcome (already trusted, or manual steps), or the exact root
 * steps to run, with the CA bytes they take on stdin. `--plan` prints these;
 * {@link applyLinuxSystemTrust} runs these and nothing else.
 */
export type PreparedLinuxSystemTrust =
  | { readonly status: "done"; readonly outcome: LinuxSystemTrustOutcome }
  | {
      readonly status: "ready";
      readonly family: LinuxDistroFamily;
      readonly bundlePath: string;
      /** The vetted sudo every root step runs through. */
      readonly sudoPath: string;
      /** What is reported when the user does not (or cannot) confirm. */
      readonly pending: Extract<LinuxSystemTrustOutcome, { status: "pending" }>;
      /** Inner argv (run as `sudo env -i … <argv>`) and its stdin, in order. */
      readonly rootSteps: readonly {
        readonly argv: readonly string[];
        readonly input: string | undefined;
      }[];
    };

export async function prepareLinuxSystemTrust(opts: {
  readonly host: LinuxTrustHost;
  readonly ca: ValidatedCa;
  readonly manualCertPath: string;
}): Promise<PreparedLinuxSystemTrust> {
  const { host, ca } = opts;
  const done = (outcome: LinuxSystemTrustOutcome) =>
    ({ status: "done", outcome }) as const;
  const family = detectLinuxDistroFamily(
    await host.readFile("/etc/os-release")
  );
  const sudoPath = await host.resolveSudo();
  const tools = await resolveTrustToolPaths(host);
  const sudoUnavailable = {
    status: "manual",
    code: "linux_trust_tool_missing",
    family,
    steps: [
      "No root-owned, non-writable setuid sudo is available. Verify your distribution's sudo installation, then rerun hack global trust.",
    ],
  } as const;
  if (family === null) {
    if (sudoPath === null) {
      return done(sudoUnavailable);
    }
    return done({
      status: "manual",
      code: "linux_trust_distro_unknown",
      family: null,
      steps: renderUnknownDistroTrustSteps({
        certPath: opts.manualCertPath,
        sha256: ca.pemSha256,
        byteLength: Buffer.byteLength(ca.pem),
        sudoPath,
        tools,
      }),
    });
  }
  const bundlePath = linuxSystemBundlePath(family);
  const already = await systemTrustState({ host, ca, family, bundlePath });
  if (already) {
    return done(already);
  }
  if (sudoPath === null) {
    return done(sudoUnavailable);
  }
  for (const tool of requiredLinuxTrustTools(family)) {
    if (tools[tool] === null) {
      return done({
        status: "manual",
        code: "linux_trust_tool_missing",
        family,
        steps: [
          `${tool} is unavailable as a trusted system executable. Install or repair the ${toolPackage(family, tool)} package and system bin/sbin permissions, then rerun hack global trust.`,
        ],
      });
    }
  }
  return {
    status: "ready",
    family,
    bundlePath,
    sudoPath,
    pending: {
      status: "pending",
      code: "linux_trust_system_pending",
      family,
      commands: linuxSystemTrustCommands({
        family,
        certPath: opts.manualCertPath,
        sha256: ca.pemSha256,
        byteLength: Buffer.byteLength(ca.pem),
        sudoPath,
        tools,
      }),
    },
    rootSteps: [
      {
        argv: linuxSystemTrustInstallArgv({
          family,
          sha256: ca.pemSha256,
          byteLength: Buffer.byteLength(ca.pem),
          tools,
        }),
        input: ca.pem,
      },
      {
        argv: linuxSystemTrustRefreshArgv({ family, tools }),
        input: undefined,
      },
    ],
  };
}

/** The trusted outcome when the system bundle already holds the CA. */
async function systemTrustState(opts: {
  readonly host: LinuxTrustHost;
  readonly ca: ValidatedCa;
  readonly family: LinuxDistroFamily;
  readonly bundlePath: string;
}): Promise<LinuxSystemTrustOutcome | null> {
  const bundle = (await opts.host.readFile(opts.bundlePath)) ?? "";
  return bundleContainsCertificate({ bundle, certPem: opts.ca.pem })
    ? {
        status: "trusted",
        family: opts.family,
        otherCaddyRoots: findOtherCaddyRoots({
          bundle,
          current: opts.ca.certificate,
        }),
      }
    : null;
}

export async function applyLinuxSystemTrust(opts: {
  readonly host: LinuxTrustHost;
  readonly ca: ValidatedCa;
  /**
   * Persistent CA path for pending/manual commands. The user's shell opens
   * it before sudo; root accepts only bytes matching the approved digest.
   */
  readonly manualCertPath: string;
  readonly canPrompt: boolean;
  readonly show: (
    commands: readonly (readonly string[])[],
    fingerprint256: string
  ) => void;
  readonly confirm: () => Promise<boolean>;
  /** Default: prepared here; a caller that already prepared passes it. */
  readonly prepared?: PreparedLinuxSystemTrust;
}): Promise<LinuxSystemTrustOutcome> {
  const { host, ca } = opts;
  const prepared =
    opts.prepared ??
    (await prepareLinuxSystemTrust({
      host,
      ca,
      manualCertPath: opts.manualCertPath,
    }));
  if (prepared.status === "done") {
    return prepared.outcome;
  }
  // No root command runs without an interactive yes, and none at all when
  // prompting is unavailable (--no-interactive, HACK_NO_INTERACTIVE, no TTY).
  if (!opts.canPrompt) {
    return prepared.pending;
  }
  opts.show(prepared.pending.commands, ca.fingerprint256);
  if (!(await opts.confirm())) {
    return prepared.pending;
  }
  for (const step of prepared.rootSteps) {
    const exitCode = await host.runPrivileged(step.argv, step.input);
    if (exitCode !== 0) {
      return {
        status: "failed",
        code: "linux_trust_system_failed",
        family: prepared.family,
        failedCommand: step.argv,
        exitCode,
      };
    }
  }
  return (
    (await systemTrustState({
      host,
      ca,
      family: prepared.family,
      bundlePath: prepared.bundlePath,
    })) ?? {
      status: "applied_unverified",
      family: prepared.family,
      bundlePath: prepared.bundlePath,
    }
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

function legacyUserNssDb(host: LinuxTrustHost): string {
  return join(host.homeDir, ".pki", "nssdb");
}

/**
 * The shared user db Chromium actually uses. Chromium M146+ defaults to
 * `$XDG_DATA_HOME/pki/nssdb` but keeps using an existing legacy
 * `~/.pki/nssdb`. So: an existing legacy db wins, else an existing modern
 * db, else the legacy path (created later), which every Chromium version
 * reads once it exists.
 */
async function selectUserNssDb(host: LinuxTrustHost): Promise<string> {
  const legacy = legacyUserNssDb(host);
  if ((await host.listDir(legacy)).includes("cert9.db")) {
    return legacy;
  }
  const modern = join(host.dataHome, "pki", "nssdb");
  if ((await host.listDir(modern)).includes("cert9.db")) {
    return modern;
  }
  return legacy;
}

/** NSS databases: the shared user db plus every browser profile found. */
export async function findNssDatabases(
  host: LinuxTrustHost
): Promise<readonly string[]> {
  const home = host.homeDir;
  const dirs = [await selectUserNssDb(host)];
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

/**
 * Identities a database check observed: the database directory and its
 * resolved ancestors, and each NSS database file (`null` when absent).
 */
type NssDbSnapshot = {
  readonly dirs: string;
  readonly files: Readonly<Record<NssDbFile, string | null>>;
};

type OwnershipCheck =
  | { readonly ok: true; readonly snapshot: NssDbSnapshot }
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
 * to another user's or a shared database is refused. The snapshot carries
 * the identities of the directory, its ancestors and each database file, so
 * a caller can detect replacement between checks (see
 * {@link compareNssDbSnapshot}); it cannot detect a swap restored before the
 * next check.
 */
export async function checkNssDbOwnership(opts: {
  readonly host: LinuxTrustHost;
  readonly dbDir: string;
  readonly requireDb: boolean;
}): Promise<OwnershipCheck> {
  const { host, dbDir } = opts;
  const roots = (
    await Promise.all(
      [host.homeDir, host.configHome, host.dataHome].map((path) =>
        host.inspectPath(path)
      )
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
  const ancestors: string[] = [];
  for (let path = dir.realPath; ; path = dirname(path)) {
    const info = await host.inspectPath(path);
    if (
      !(info?.isDirectory && [host.uid, 0].includes(info.uid)) ||
      (info.mode & 0o022) !== 0
    ) {
      return {
        ok: false,
        reason: "database ancestor is missing or writable by another user",
      };
    }
    ancestors.push(`${path}:${info.identity}`);
    if (path === "/") {
      break;
    }
  }
  // The database files must live in that directory themselves: a cert9.db
  // or key4.db link that resolves elsewhere would let a write escape the
  // containment checked above.
  const files: Record<NssDbFile, string | null> = {
    "cert9.db": null,
    "key4.db": null,
  };
  for (const name of NSS_DB_FILES) {
    const expected = join(dir.realPath, name);
    const file = await host.inspectPath(expected);
    if (!file) {
      if (name === "cert9.db" && opts.requireDb) {
        return { ok: false, reason: "cert9.db is missing" };
      }
      continue;
    }
    if (
      file.realPath !== expected ||
      !file.isFile ||
      !ownedAndPrivate(file, host.uid)
    ) {
      return {
        ok: false,
        reason: `${name} resolves outside the database directory, is not owned by you, or is group/world-writable`,
      };
    }
    files[name] = file.identity;
  }
  return { ok: true, snapshot: { dirs: ancestors.join("\n"), files } };
}

/** NSS sql database files Hack writes through certutil. */
const NSS_DB_FILES = ["cert9.db", "key4.db"] as const;
type NssDbFile = (typeof NSS_DB_FILES)[number];

/**
 * Compare a check against the pinned identities. Directories must not change.
 * A database file that existed must keep its identity; one that was absent
 * must stay absent, except across a certutil call (`created`), which may
 * create it. Returns the identities to pin next, or a reason to stop.
 */
export function compareNssDbSnapshot(opts: {
  readonly pinned: NssDbSnapshot;
  readonly current: NssDbSnapshot;
  readonly created: boolean;
}):
  | { readonly ok: true; readonly pinned: NssDbSnapshot }
  | {
      readonly ok: false;
      readonly reason: string;
    } {
  const { pinned, current } = opts;
  if (current.dirs !== pinned.dirs) {
    return { ok: false, reason: "database directory or ancestor changed" };
  }
  for (const name of NSS_DB_FILES) {
    const before = pinned.files[name];
    const after = current.files[name];
    if (before === after || (before === null && opts.created)) {
      continue;
    }
    return {
      ok: false,
      reason:
        before === null
          ? `${name} appeared outside a certutil call`
          : `${name} was replaced or removed`,
    };
  }
  return { ok: true, pinned: current };
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
  const userDb = legacyUserNssDb(host);
  const databases: NssDbOutcome[] = [];
  for (const dbDir of await findNssDatabases(host)) {
    const outcome = await trustOneNssDb({
      host,
      db: { certutil, dbDir },
      ca: opts.ca,
      createIfMissing: dbDir === userDb,
    });
    databases.push(outcome);
    if (outcome.status === "failed") {
      break;
    }
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

async function prepareNssDirectory(opts: {
  readonly host: LinuxTrustHost;
  readonly dbDir: string;
}): Promise<NssDbOutcome | null> {
  const { host, dbDir } = opts;
  if (!(await host.inspectPath(dbDir))) {
    // Check the existing parent chain before recursive mkdir can follow it.
    let parent = dirname(dbDir);
    while (!(await host.inspectPath(parent)) && parent !== "/") {
      parent = dirname(parent);
    }
    for (let path = parent; ; path = dirname(path)) {
      const info = await host.inspectPath(path);
      if (
        !(info?.isDirectory && [host.uid, 0].includes(info.uid)) ||
        (info.mode & 0o022) !== 0
      ) {
        return { dbDir, status: "refused", reason: "unsafe database ancestor" };
      }
      if (path === "/") {
        break;
      }
    }
    if (!(await host.makeDir(dbDir))) {
      return {
        dbDir,
        status: "failed",
        reason: "could not create the directory",
      };
    }
  }
  return null;
}

async function trustOneNssDb(opts: {
  readonly host: LinuxTrustHost;
  readonly db: NssDb;
  readonly ca: ValidatedCa;
  readonly createIfMissing: boolean;
}): Promise<NssDbOutcome> {
  const { host, db } = opts;
  const { dbDir } = db;
  if (opts.createIfMissing) {
    const prepared = await prepareNssDirectory({ host, dbDir });
    if (prepared) {
      return prepared;
    }
  }
  const initial = await checkNssDbOwnership({ host, dbDir, requireDb: false });
  if (!initial.ok) {
    return { dbDir, status: "refused", reason: initial.reason };
  }
  // Identities pinned at the first check; a database file certutil creates
  // is pinned after the call that created it.
  let pinned = initial.snapshot;
  const check = async (opts: {
    readonly requireDb: boolean;
    readonly created: boolean;
  }) => {
    const current = await checkNssDbOwnership({
      host,
      dbDir,
      requireDb: opts.requireDb,
    });
    if (!current.ok) {
      throw new Error(current.reason);
    }
    const compared = compareNssDbSnapshot({
      pinned,
      current: current.snapshot,
      created: opts.created,
    });
    if (!compared.ok) {
      throw new Error(compared.reason);
    }
    pinned = compared.pinned;
  };
  const guardedHost: LinuxTrustHost = {
    ...host,
    exec: async (argv, input) => {
      const initializing = argv[3] === "-N";
      await check({ requireDb: !initializing, created: false });
      const result = await host.exec(argv, input);
      await check({
        requireDb: !initializing || result.exitCode === 0,
        created: true,
      });
      return result;
    },
  };
  try {
    return await trustCheckedNssDb({ ...opts, host: guardedHost });
  } catch (error) {
    return {
      dbDir,
      status: "failed",
      reason: error instanceof Error ? error.message : "database check failed",
    };
  }
}

/** Each certutil operation is checked immediately before and after execution. */
async function trustCheckedNssDb(opts: {
  readonly host: LinuxTrustHost;
  readonly db: NssDb;
  readonly ca: ValidatedCa;
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
    return await ensureTlsIssuerTrust({ host, db, ca: opts.ca });
  }
  if (present) {
    await deleteNicknameEntries({ host, db });
  }
  const added = await host.exec(nssAddArgv(db), opts.ca.pem);
  if (added.exitCode !== 0) {
    return { dbDir, status: "failed", reason: "certutil -A failed" };
  }
  if (!(await storedCertificateMatches({ host, db, ca: opts.ca }))) {
    return {
      dbDir,
      status: "failed",
      reason: "stored certificate differs from the validated CA",
    };
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
  readonly ca: ValidatedCa;
}): Promise<NssDbOutcome> {
  const { host, db } = opts;
  if (hasTlsIssuerTrust(await readTrustFlags({ host, db }))) {
    return (await storedCertificateMatches(opts))
      ? { dbDir: db.dbDir, status: "trusted" }
      : {
          dbDir: db.dbDir,
          status: "failed",
          reason: "stored certificate differs from the validated CA",
        };
  }
  const modified = await host.exec(nssModifyTrustArgv(db));
  if (!(await storedCertificateMatches(opts))) {
    return {
      dbDir: db.dbDir,
      status: "failed",
      reason: "stored certificate differs from the validated CA",
    };
  }
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

async function storedCertificateMatches(opts: {
  readonly host: LinuxTrustHost;
  readonly db: NssDb;
  readonly ca: ValidatedCa;
}): Promise<boolean> {
  const exported = await opts.host.exec(nssExportArgv(opts.db));
  return (
    exported.exitCode === 0 &&
    pemCertificateBodies(exported.stdout).length === 1 &&
    bundleContainsCertificate({ bundle: exported.stdout, certPem: opts.ca.pem })
  );
}
