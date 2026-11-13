import { constants, type Stats } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { PROJECT_ENV_KEY_FILENAME } from "../constants.ts";
import {
  findStaleMuxEnvironments,
  MUX_ENV_TTL_MS,
  removeStaleMuxEnvironment,
  type StaleMuxEnvironment,
} from "../mux/private-environment.ts";
import {
  displayPath,
  MACHINE_LOCAL_LAYER_NAME,
  PLAINTEXT_DOTENV_NAME,
} from "./env-layer-modes.ts";
import { ensureGitignoreEntry } from "./fs.ts";
import { isKeychainDisabled } from "./keychain.ts";
import {
  findStagingLeftovers,
  legacyStagingTargetName,
  removeStagingLeftover,
  type StagingLeftover,
} from "./private-staging.ts";
import {
  isGitIgnoredProjectEnvPath,
  isGitTrackedOrUnknownProjectPath,
} from "./project-env-config.ts";

/**
 * `hack doctor`'s "secrets hygiene" section (HACK-2165): files at rest that
 * hold env values or keys, for a project and for the global Hack home.
 *
 * It reports loose permission modes, links, tracked or unignored
 * secret-bearing files, staging copies left by interrupted writes, payloads
 * staged for terminal sessions that never ran, and an encrypted store whose
 * key file is missing. Findings name files, never values; nothing is read
 * except directory listings, file metadata and git's answers.
 *
 * Ownership of fixes: `--fix` only tightens modes of this user's regular
 * files, adds missing ignore entries, and removes Hack's own leftovers (by
 * their staging names, old enough, still the file that was found). It never
 * deletes a store, a key or a file a user wrote.
 */

/** What a secret-bearing file holds, for messages. */
type Holds =
  | "machine-local env values"
  | "plaintext env values"
  | "the project env key"
  | "an encrypted secret store"
  | "an encrypted store key";

type Candidate = {
  readonly path: string;
  readonly holds: Holds;
  /**
   * Inside a checkout: the ignore file and entry that keep it out of git.
   * Null for files outside any project tree (git common dir, Hack home).
   */
  readonly ignore: {
    readonly projectRoot: string;
    readonly gitignorePath: string;
    readonly entry: string;
    /**
     * The path git is asked about, spelled relative to `projectRoot`, when it
     * differs from the candidate's (a resolved alias); defaults to it.
     */
    readonly gitPath?: string;
  } | null;
};

export type SecretsHygieneFix =
  | {
      readonly kind: "chmod";
      readonly path: string;
      readonly stats: Stats;
      readonly mode: number;
    }
  | {
      readonly kind: "ignore";
      readonly gitignorePath: string;
      readonly entry: string;
      /** Asked again after the entry is added: the fix counts only if git now ignores it. */
      readonly verify: { readonly projectRoot: string; readonly path: string };
    }
  | { readonly kind: "remove_leftover"; readonly leftover: StagingLeftover }
  | { readonly kind: "remove_mux"; readonly stale: StaleMuxEnvironment };

/** A directory's identity, captured at inspection and checked before a fix. */
export type DirectoryGuard = {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
};

export type SecretsHygieneFinding = {
  readonly status: "warn" | "error";
  readonly path: string;
  /** Value-free; names the file and what it holds. */
  readonly message: string;
  readonly fix: SecretsHygieneFix | null;
  /**
   * The directory `fix` changes, as inspected. A fix is skipped when that
   * path no longer names the same directory, so a directory replaced by a
   * link after inspection is never written through.
   */
  readonly guard?: DirectoryGuard;
};

/** One file or directory the inspection covers, labelled for messages. */
export type SecretsHygieneScope = {
  /** The project's root and its `.hack` directory, or null for none. */
  readonly project: {
    readonly projectRoot: string;
    readonly projectDir: string;
  } | null;
  /** The shared key in the git common directory, when there is one. */
  readonly sharedKeyPath: string | null;
  /** Configured encrypted-file stores (project and global), de-duplicated. */
  readonly stores: readonly {
    readonly storePath: string;
    readonly keyPath: string;
    /**
     * For paths a project's own configuration chose (it may come from a
     * cloned repository): fixes and leftover sweeps apply only to files
     * whose directory resolves inside one of these roots (the checkout and
     * the Hack home); elsewhere the finding is reported without a fix.
     * Absent for the user's global configuration.
     */
    readonly fixRoots?: readonly string[];
  }[];
  /** Parent of terminal-session payloads; the OS temporary directory. */
  readonly tmpDir?: string;
  /** Whether `HACK_SECRETS_FILE_KEY` supplies the store key. */
  readonly storeKeyFromEnvironment: boolean;
  readonly now?: number;
};

const LOCAL_LAYER = MACHINE_LOCAL_LAYER_NAME;
const PLAINTEXT_DOTENV = PLAINTEXT_DOTENV_NAME;
const HACK_DIR_STAGED =
  /^(\.env(\.[A-Za-z0-9_-]+)?|hack\.env\..*yaml|\.gitignore)$/;

/** Whether a `relative()` result leaves its base (`..` as a path segment). */
function isOutside(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Whether `path`'s directory resolves (links followed) inside one of
 * `roots`; with no roots, any path qualifies. A directory that can't be
 * resolved does not.
 */
async function fixAllowed(opts: {
  readonly path: string;
  readonly roots: readonly string[] | undefined;
}): Promise<boolean> {
  if (!opts.roots) {
    return true;
  }
  const dir = await realpath(dirname(opts.path)).catch(() => null);
  if (!dir) {
    return false;
  }
  for (const root of opts.roots) {
    const real = await realpath(root).catch(() => null);
    if (real && (dir === real || !isOutside(relative(real, dir)))) {
      return true;
    }
  }
  return false;
}

/**
 * A file or directory name as a literal `.gitignore` pattern: glob and
 * escape characters (`\\ * ? [ ]`) are escaped everywhere, a leading `#` or
 * `!` is escaped so the line is neither a comment nor a negation, and a
 * trailing space is escaped so git keeps it.
 */
export function gitignoreLiteral(name: string): string {
  return name
    .replace(GITIGNORE_GLOB, "\\$&")
    .replace(GITIGNORE_LEADING, "\\$&")
    .replace(GITIGNORE_TRAILING_SPACE, "\\ ");
}

const UNWRITABLE_IGNORE_ENTRY = /[\u0000-\u001f\u007f]/;
const GITIGNORE_GLOB = /[\\*?[\]]/g;
const GITIGNORE_LEADING = /^[#!]/;
const GITIGNORE_TRAILING_SPACE = / $/;

/** POSIX shell single-quoting. */
function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * How to untrack a file: a `git rm --cached` command with the name
 * shell-quoted, or, when the name holds characters no command should carry
 * to a terminal, the instruction without a command.
 */
function untrackAdvice(path: string, projectRoot: string): string {
  const rel = relative(projectRoot, path);
  return displayPath(rel) === rel
    ? `untrack it with git rm --cached -- ${shellQuote(rel)} (from the project root)`
    : "untrack it with git rm --cached (its name holds control characters, so no command is printed)";
}

function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

/** A path for messages: project-relative when inside, never with control characters. */
function shown(path: string, project: SecretsHygieneScope["project"]): string {
  return displayPath(rawShown(path, project));
}

function rawShown(
  path: string,
  project: SecretsHygieneScope["project"]
): string {
  if (!project) {
    return path;
  }
  const rel = relative(project.projectRoot, path);
  return isOutside(rel) ? path : rel;
}

/** What a file in `.hack` holds, or null when it holds no env values. */
function holdsForProjectFile(name: string): Holds | null {
  if (LOCAL_LAYER.test(name)) {
    return "machine-local env values";
  }
  if (PLAINTEXT_DOTENV.test(name)) {
    return "plaintext env values";
  }
  return null;
}

async function projectCandidates(opts: {
  readonly project: NonNullable<SecretsHygieneScope["project"]>;
  /** False when `.hack` is a link: its files are not listed. */
  readonly inspectProjectDir: boolean;
}): Promise<Candidate[]> {
  const { projectRoot, projectDir } = opts.project;
  const hackGitignore = resolve(projectDir, ".gitignore");
  const names = opts.inspectProjectDir
    ? await readdir(projectDir).catch(() => [] as string[])
    : [];
  const candidates: Candidate[] = names.flatMap((name): Candidate[] => {
    const holds = holdsForProjectFile(name);
    return holds
      ? [
          {
            path: join(projectDir, name),
            holds,
            ignore: {
              projectRoot,
              gitignorePath: hackGitignore,
              entry: gitignoreLiteral(name),
            },
          },
        ]
      : [];
  });
  candidates.push({
    path: join(projectRoot, PROJECT_ENV_KEY_FILENAME),
    holds: "the project env key",
    ignore: {
      projectRoot,
      gitignorePath: join(projectRoot, ".gitignore"),
      entry: gitignoreLiteral(PROJECT_ENV_KEY_FILENAME),
    },
  });
  return candidates;
}

/** Mode, link and ownership findings for one existing file. */
function fileFindings(opts: {
  readonly candidate: Candidate;
  readonly stats: Stats;
  readonly name: string;
}): SecretsHygieneFinding[] {
  const { candidate, stats, name } = opts;
  if (stats.isSymbolicLink()) {
    return [
      {
        status: "error",
        path: candidate.path,
        message: `${name} is a symbolic link; Hack refuses to read or write ${candidate.holds} through a link. Replace it with a regular file.`,
        fix: null,
      },
    ];
  }
  if (!stats.isFile()) {
    return [];
  }
  if (stats.uid !== process.getuid?.()) {
    return [
      {
        status: "warn",
        path: candidate.path,
        message: `${name} holds ${candidate.holds} but is owned by another user (uid ${stats.uid}); Hack leaves it unchanged.`,
        fix: null,
      },
    ];
  }
  if ((stats.mode & 0o077) === 0) {
    return [];
  }
  const mode = stats.mode & 0o7700;
  return [
    {
      status: "warn",
      path: candidate.path,
      message: `${name} holds ${candidate.holds} and is readable or writable by other users (mode ${octal(stats.mode)}); --fix sets ${octal(mode)}.`,
      fix: { kind: "chmod", path: candidate.path, stats, mode },
    },
  ];
}

/** Git findings for a secret-bearing file inside a checkout. */
async function gitFindings(opts: {
  readonly candidate: Candidate;
  readonly name: string;
}): Promise<SecretsHygieneFinding[]> {
  const { candidate, name } = opts;
  const ignore = candidate.ignore;
  if (!ignore) {
    return [];
  }
  const target = {
    projectRoot: ignore.projectRoot,
    path: ignore.gitPath ?? candidate.path,
  };
  if (await isGitTrackedOrUnknownProjectPath(target)) {
    return [
      {
        status: "error",
        path: candidate.path,
        message: `git tracks ${name} (or cannot say whether it does), and it holds ${candidate.holds}: ${untrackAdvice(ignore.gitPath ?? candidate.path, ignore.projectRoot)}, then treat what it held as exposed.`,
        fix: null,
      },
    ];
  }
  if ((await isGitIgnoredProjectEnvPath(target)) === false) {
    const rel = relative(ignore.projectRoot, ignore.gitignorePath);
    const where = isOutside(rel) ? ignore.gitignorePath : rel;
    // An entry must be exactly one literal pattern line. A name holding a
    // line break or other control character (a committed configuration can
    // choose one, to add a second, negating line) or ending in a space
    // (trimmed by the ignore-file writer) is left to the user.
    if (
      UNWRITABLE_IGNORE_ENTRY.test(ignore.entry) ||
      ignore.entry.endsWith("\\ ")
    ) {
      return [
        {
          status: "warn",
          path: candidate.path,
          message: `git does not ignore ${name}, which holds ${candidate.holds}; its name has a line break, a control character or a trailing space, so add an ignore entry for it to ${displayPath(where)} by hand.`,
          fix: null,
        },
      ];
    }
    return [
      {
        status: "warn",
        path: candidate.path,
        message: `git does not ignore ${name}, which holds ${candidate.holds}; --fix adds '${displayPath(ignore.entry)}' to ${displayPath(where)}.`,
        fix: {
          kind: "ignore",
          gitignorePath: ignore.gitignorePath,
          entry: ignore.entry,
          verify: target,
        },
      },
    ];
  }
  return [];
}

async function candidateFindings(opts: {
  readonly candidate: Candidate;
  readonly project: SecretsHygieneScope["project"];
  /**
   * The file is created later by its writer (a configured store or key):
   * when absent, git must already ignore where it will be created, so a
   * first write never produces a file git can collect.
   */
  readonly beforeCreation?: boolean;
}): Promise<SecretsHygieneFinding[]> {
  const stats = await lstat(opts.candidate.path).catch(() => null);
  const name = shown(opts.candidate.path, opts.project);
  if (!stats) {
    return opts.beforeCreation === true && opts.candidate.ignore
      ? await gitFindings({ candidate: opts.candidate, name })
      : [];
  }
  return [
    ...fileFindings({ candidate: opts.candidate, stats, name }),
    ...(stats.isSymbolicLink()
      ? []
      : await gitFindings({ candidate: opts.candidate, name })),
  ];
}

/** Target names whose staging leftovers to look for in `directory`. */
async function stagedNames(opts: {
  readonly directory: string;
  readonly names: readonly string[];
  readonly accept?: RegExp;
}): Promise<readonly string[]> {
  const found = new Set(opts.names);
  if (opts.accept) {
    for (const entry of await readdir(opts.directory).catch(() => [])) {
      const name = legacyStagingTargetName(entry);
      if (name && opts.accept.test(name)) {
        found.add(name);
      }
    }
  }
  return [...found];
}

async function leftoverFindings(opts: {
  readonly directory: string;
  readonly names: readonly string[];
  readonly accept?: RegExp;
  readonly now: number;
  readonly project: SecretsHygieneScope["project"];
}): Promise<SecretsHygieneFinding[]> {
  const leftovers = await findStagingLeftovers({
    directory: opts.directory,
    names: await stagedNames(opts),
    now: opts.now,
  });
  return leftovers.map((leftover) => ({
    status: "warn" as const,
    path: leftover.path,
    message: `${shown(leftover.path, opts.project)} is a staging copy left by an interrupted Hack write, and may hold secret values; --fix removes it.`,
    fix: { kind: "remove_leftover" as const, leftover },
  }));
}

/**
 * Git metadata for a configured store or key file: one inside the project
 * checkout must be untracked and ignored like the project's own secrets (an
 * anchored entry in the root `.gitignore`); one outside it is exempt.
 * Containment is decided on resolved paths (the root, and the file itself
 * when it is a regular file, else its directory; links followed and, where
 * the platform's realpath returns it, in their stored case), so an alias
 * spelling of an in-checkout path is still checked; git is then asked about
 * that resolved spelling.
 */
/**
 * `path` resolved through its nearest existing ancestor (links followed),
 * with the components that do not exist yet appended; null when nothing on
 * the way can be resolved.
 */
async function resolveExisting(path: string): Promise<string | null> {
  const missing: string[] = [];
  let current = path;
  while (true) {
    const real = await realpath(current).catch(() => null);
    if (real) {
      return join(real, ...missing.reverse());
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    missing.push(basename(current));
    current = parent;
  }
}

async function inProjectIgnore(opts: {
  readonly path: string;
  readonly project: SecretsHygieneScope["project"];
}): Promise<Candidate["ignore"]> {
  if (!opts.project) {
    return null;
  }
  const root = await realpath(opts.project.projectRoot).catch(() => null);
  const dir = await resolveExisting(dirname(opts.path));
  if (!(root && dir)) {
    return null;
  }
  // A regular file is resolved itself, so its name is in its stored case
  // too; a link at the final component is not followed (its own name is
  // what a commit would carry).
  const entry = await lstat(opts.path).catch(() => null);
  const resolved =
    entry?.isFile() === true
      ? await realpath(opts.path).catch(() => join(dir, basename(opts.path)))
      : join(dir, basename(opts.path));
  const rel = relative(root, resolved);
  if (rel === "" || isOutside(rel)) {
    return null;
  }
  return {
    projectRoot: root,
    gitPath: resolved,
    gitignorePath: join(opts.project.projectRoot, ".gitignore"),
    entry: `/${rel.split(sep).map(gitignoreLiteral).join("/")}`,
  };
}

async function storeFindings(opts: {
  readonly store: SecretsHygieneScope["stores"][number];
  readonly storeKeyFromEnvironment: boolean;
  readonly project: SecretsHygieneScope["project"];
}): Promise<SecretsHygieneFinding[]> {
  const { storePath, keyPath } = opts.store;
  const findings: SecretsHygieneFinding[] = [];
  for (const candidate of [
    { path: storePath, holds: "an encrypted secret store" },
    { path: keyPath, holds: "an encrypted store key" },
  ] as const) {
    const ignore = await inProjectIgnore({
      path: candidate.path,
      project: opts.project,
    });
    findings.push(
      ...(await candidateFindings({
        candidate: { ...candidate, ignore },
        project: opts.project,
        beforeCreation: true,
      }))
    );
  }
  const store = await lstat(storePath).catch(() => null);
  const key = await lstat(keyPath).catch(() => null);
  if (
    store?.isFile() &&
    store.size > 0 &&
    !key &&
    !opts.storeKeyFromEnvironment
  ) {
    const keychainMayHoldKey =
      process.platform === "darwin" && !isKeychainDisabled();
    const keychain = keychainMayHoldKey
      ? " Hack can read it only if the system keychain still holds its key."
      : "";
    findings.push({
      status: keychainMayHoldKey ? "warn" : "error",
      path: storePath,
      message: `Encrypted secret store ${displayPath(storePath)}: store present, key missing, cannot be read (no key file at ${displayPath(keyPath)}; HACK_SECRETS_FILE_KEY is not set).${keychain} Restore the key file to read it. Hack never deletes a store or a key; remove the store yourself once you no longer need its values.`,
      fix: null,
    });
  }
  return findings;
}

/** Findings for the project's `.hack`, its root key, and their leftovers. */
async function projectFindings(opts: {
  readonly project: NonNullable<SecretsHygieneScope["project"]>;
  readonly now: number;
}): Promise<SecretsHygieneFinding[]> {
  const { project, now } = opts;
  const findings: SecretsHygieneFinding[] = [];
  // Env writers refuse a linked `.hack`; so does this inspection, so no fix
  // can reach files outside the project through it.
  const projectDir = await lstat(project.projectDir).catch(() => null);
  const inspectProjectDir =
    projectDir?.isDirectory() === true && !projectDir.isSymbolicLink();
  if (projectDir && !inspectProjectDir) {
    findings.push({
      status: "error",
      path: project.projectDir,
      message: `${shown(project.projectDir, project)} is a symbolic link or not a directory; Hack does not read, write or fix env files through it. Replace it with a regular directory.`,
      fix: null,
    });
  }
  for (const candidate of await projectCandidates({
    project,
    inspectProjectDir,
  })) {
    findings.push(...(await candidateFindings({ candidate, project })));
  }
  if (inspectProjectDir) {
    findings.push(
      ...(await leftoverFindings({
        directory: project.projectDir,
        names: [".env", "hack.env.local.yaml"],
        accept: HACK_DIR_STAGED,
        now,
        project,
      }))
    );
  }
  findings.push(
    ...(await leftoverFindings({
      directory: project.projectRoot,
      names: [PROJECT_ENV_KEY_FILENAME],
      now,
      project,
    }))
  );
  return findings;
}

async function sharedKeyFindings(opts: {
  readonly path: string;
  readonly now: number;
}): Promise<SecretsHygieneFinding[]> {
  const candidate: Candidate = {
    path: opts.path,
    holds: "the project env key",
    ignore: null,
  };
  return [
    ...(await candidateFindings({ candidate, project: null })),
    ...(await leftoverFindings({
      directory: dirname(opts.path),
      names: [basename(opts.path)],
      now: opts.now,
      project: null,
    })),
  ];
}

/** A store finding, without its fix when its path is outside the store's fix roots. */
async function withinFixRoots(opts: {
  readonly finding: SecretsHygieneFinding;
  readonly roots: readonly string[] | undefined;
}): Promise<SecretsHygieneFinding> {
  const { finding } = opts;
  if (
    !finding.fix ||
    (await fixAllowed({ path: finding.path, roots: opts.roots }))
  ) {
    return finding;
  }
  return {
    ...finding,
    message: `${finding.message} --fix leaves it: the project's configuration names this path, which is outside the project and the Hack home.`,
    fix: null,
  };
}

async function allStoreFindings(opts: {
  readonly scope: SecretsHygieneScope;
  readonly now: number;
}): Promise<SecretsHygieneFinding[]> {
  const { scope } = opts;
  const findings: SecretsHygieneFinding[] = [];
  const storeDirs = new Map<string, Set<string>>();
  for (const store of scope.stores) {
    for (const finding of await storeFindings({
      store,
      storeKeyFromEnvironment: scope.storeKeyFromEnvironment,
      project: scope.project,
    })) {
      findings.push(await withinFixRoots({ finding, roots: store.fixRoots }));
    }
    for (const path of [store.storePath, store.keyPath]) {
      // Leftovers are swept only where a fix is allowed.
      if (await fixAllowed({ path, roots: store.fixRoots })) {
        const names = storeDirs.get(dirname(path)) ?? new Set<string>();
        names.add(basename(path));
        storeDirs.set(dirname(path), names);
      }
    }
  }
  for (const [directory, names] of storeDirs) {
    findings.push(
      ...(await leftoverFindings({
        directory,
        names: [...names],
        now: opts.now,
        project: null,
      }))
    );
  }
  return findings;
}

/** All findings for a scope; reads metadata, listings and git only. */
export async function inspectSecretsHygiene(
  scope: SecretsHygieneScope
): Promise<readonly SecretsHygieneFinding[]> {
  const now = scope.now ?? Date.now();
  const findings: SecretsHygieneFinding[] = [
    ...(scope.project
      ? await projectFindings({ project: scope.project, now })
      : []),
    ...(scope.sharedKeyPath
      ? await sharedKeyFindings({ path: scope.sharedKeyPath, now })
      : []),
    ...(await allStoreFindings({ scope, now })),
  ];
  for (const stale of await findStaleMuxEnvironments({
    ...(scope.tmpDir ? { tmpDir: scope.tmpDir } : {}),
    now,
  })) {
    findings.push({
      status: "warn",
      path: stale.root,
      message: `${displayPath(stale.root)} holds env values staged for a terminal session that never ran (older than ${MUX_ENV_TTL_MS / 60_000} minutes); --fix removes it.`,
      fix: { kind: "remove_mux", stale },
    });
  }
  return await Promise.all(findings.map(withGuard));
}

/** The directory a fix changes. */
function fixDirectory(fix: SecretsHygieneFix): string {
  switch (fix.kind) {
    case "chmod":
      return dirname(fix.path);
    case "ignore":
      return dirname(fix.gitignorePath);
    case "remove_leftover":
      return dirname(fix.leftover.path);
    default:
      return dirname(fix.stale.root);
  }
}

async function withGuard(
  finding: SecretsHygieneFinding
): Promise<SecretsHygieneFinding> {
  if (!finding.fix) {
    return finding;
  }
  const path = fixDirectory(finding.fix);
  const info = await stat(path).catch(() => null);
  // A directory that can't be identified gets no fix.
  return info?.isDirectory()
    ? { ...finding, guard: { path, dev: info.dev, ino: info.ino } }
    : { ...finding, fix: null };
}

async function guardHolds(guard: DirectoryGuard | undefined): Promise<boolean> {
  if (!guard) {
    return false;
  }
  const info = await stat(guard.path).catch(() => null);
  return (
    info?.isDirectory() === true &&
    info.dev === guard.dev &&
    info.ino === guard.ino
  );
}

/** Tightens a file in place through a no-follow handle, if it is still the one found. */
async function tightenMode(
  fix: Extract<SecretsHygieneFix, { kind: "chmod" }>
): Promise<boolean> {
  const file = await open(
    fix.path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const current = await file.stat();
    if (
      !current.isFile() ||
      current.dev !== fix.stats.dev ||
      current.ino !== fix.stats.ino
    ) {
      return false;
    }
    await file.chmod(fix.mode);
    return true;
  } finally {
    await file.close();
  }
}

async function addIgnoreEntry(
  fix: Extract<SecretsHygieneFix, { kind: "ignore" }>
): Promise<boolean> {
  // Never write through a linked ignore file.
  const existing = await lstat(fix.gitignorePath).catch(() => null);
  if (existing && !existing.isFile()) {
    return false;
  }
  await ensureGitignoreEntry({
    gitignorePath: fix.gitignorePath,
    entry: fix.entry,
    comment: "# machine-local secrets (hack doctor --fix)",
  });
  // Applied only when git now ignores the file (a later rule may re-include it).
  return (await isGitIgnoredProjectEnvPath(fix.verify)) === true;
}

/**
 * Applies every fixable finding and reports each change (or why one was
 * left) through `report`; no line holds a value. Returns the counts.
 */
export async function applySecretsHygieneFixes(opts: {
  readonly findings: readonly SecretsHygieneFinding[];
  readonly report: (line: string) => void;
}): Promise<{ readonly applied: number; readonly skipped: number }> {
  let applied = 0;
  let skipped = 0;
  const done = new Set<string>();
  for (const finding of opts.findings) {
    const fix = finding.fix;
    if (!fix) {
      continue;
    }
    const key =
      fix.kind === "ignore"
        ? `${fix.gitignorePath}\0${fix.entry}`
        : finding.path;
    if (done.has(key)) {
      continue;
    }
    done.add(key);
    let changed = false;
    try {
      if (!(await guardHolds(finding.guard))) {
        changed = false;
      } else if (fix.kind === "chmod") {
        changed = await tightenMode(fix);
      } else if (fix.kind === "ignore") {
        changed = await addIgnoreEntry(fix);
      } else if (fix.kind === "remove_leftover") {
        changed = await removeStagingLeftover(fix.leftover);
      } else {
        changed = await removeStaleMuxEnvironment(fix.stale);
      }
    } catch {
      changed = false;
    }
    if (changed) {
      applied += 1;
      opts.report(describeApplied({ fix, path: finding.path }));
    } else {
      skipped += 1;
      opts.report(
        `Left unchanged (it changed or could not be updated): ${displayPath(finding.path)}`
      );
    }
  }
  return { applied, skipped };
}

function describeApplied(opts: {
  readonly fix: SecretsHygieneFix;
  readonly path: string;
}): string {
  const { fix } = opts;
  switch (fix.kind) {
    case "chmod":
      return `Set mode ${octal(fix.mode)} on ${displayPath(opts.path)}`;
    case "ignore":
      return `Added '${displayPath(fix.entry)}' to ${displayPath(fix.gitignorePath)}`;
    case "remove_leftover":
      return `Removed leftover staging copy ${displayPath(opts.path)}`;
    default:
      return `Removed stale terminal-session env payload ${displayPath(opts.path)}`;
  }
}
