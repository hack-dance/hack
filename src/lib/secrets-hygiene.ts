import { constants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { PROJECT_ENV_KEY_FILENAME } from "../constants.ts";
import {
  findStaleMuxEnvironments,
  MUX_ENV_TTL_MS,
  removeStaleMuxEnvironment,
  type StaleMuxEnvironment,
} from "../mux/private-environment.ts";
import {
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
    }
  | { readonly kind: "remove_leftover"; readonly leftover: StagingLeftover }
  | { readonly kind: "remove_mux"; readonly stale: StaleMuxEnvironment };

export type SecretsHygieneFinding = {
  readonly status: "warn" | "error";
  readonly path: string;
  /** Value-free; names the file and what it holds. */
  readonly message: string;
  readonly fix: SecretsHygieneFix | null;
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

function octal(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

function shown(path: string, project: SecretsHygieneScope["project"]): string {
  if (!project) {
    return path;
  }
  const rel = relative(project.projectRoot, path);
  return rel.startsWith("..") ? path : rel;
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

async function projectCandidates(
  project: NonNullable<SecretsHygieneScope["project"]>
): Promise<Candidate[]> {
  const { projectRoot, projectDir } = project;
  const hackGitignore = resolve(projectDir, ".gitignore");
  const names = await readdir(projectDir).catch(() => [] as string[]);
  const candidates: Candidate[] = names.flatMap((name): Candidate[] => {
    const holds = holdsForProjectFile(name);
    return holds
      ? [
          {
            path: join(projectDir, name),
            holds,
            ignore: { projectRoot, gitignorePath: hackGitignore, entry: name },
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
      entry: PROJECT_ENV_KEY_FILENAME,
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
  const target = { projectRoot: ignore.projectRoot, path: candidate.path };
  if (await isGitTrackedOrUnknownProjectPath(target)) {
    return [
      {
        status: "error",
        path: candidate.path,
        message: `git tracks ${name} (or cannot say whether it does), and it holds ${candidate.holds}: untrack it with 'git rm --cached -- ${name}', then treat what it held as exposed.`,
        fix: null,
      },
    ];
  }
  if ((await isGitIgnoredProjectEnvPath(target)) === false) {
    const rel = relative(ignore.projectRoot, ignore.gitignorePath);
    return [
      {
        status: "warn",
        path: candidate.path,
        message: `git does not ignore ${name}, which holds ${candidate.holds}; --fix adds '${ignore.entry}' to ${rel}.`,
        fix: {
          kind: "ignore",
          gitignorePath: ignore.gitignorePath,
          entry: ignore.entry,
        },
      },
    ];
  }
  return [];
}

async function candidateFindings(opts: {
  readonly candidate: Candidate;
  readonly project: SecretsHygieneScope["project"];
}): Promise<SecretsHygieneFinding[]> {
  const stats = await lstat(opts.candidate.path).catch(() => null);
  if (!stats) {
    return [];
  }
  const name = shown(opts.candidate.path, opts.project);
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

async function storeFindings(opts: {
  readonly store: SecretsHygieneScope["stores"][number];
  readonly storeKeyFromEnvironment: boolean;
}): Promise<SecretsHygieneFinding[]> {
  const { storePath, keyPath } = opts.store;
  const findings: SecretsHygieneFinding[] = [];
  for (const candidate of [
    { path: storePath, holds: "an encrypted secret store", ignore: null },
    { path: keyPath, holds: "an encrypted store key", ignore: null },
  ] as const) {
    findings.push(...(await candidateFindings({ candidate, project: null })));
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
      message: `Encrypted secret store ${storePath}: store present, key missing, cannot be read (no key file at ${keyPath}; HACK_SECRETS_FILE_KEY is not set).${keychain} Restore the key file to read it. Hack never deletes a store or a key; remove the store yourself once you no longer need its values.`,
      fix: null,
    });
  }
  return findings;
}

/** All findings for a scope; reads metadata, listings and git only. */
export async function inspectSecretsHygiene(
  scope: SecretsHygieneScope
): Promise<readonly SecretsHygieneFinding[]> {
  const now = scope.now ?? Date.now();
  const findings: SecretsHygieneFinding[] = [];
  if (scope.project) {
    for (const candidate of await projectCandidates(scope.project)) {
      findings.push(
        ...(await candidateFindings({ candidate, project: scope.project }))
      );
    }
    findings.push(
      ...(await leftoverFindings({
        directory: scope.project.projectDir,
        names: [".env", "hack.env.local.yaml"],
        accept: HACK_DIR_STAGED,
        now,
        project: scope.project,
      })),
      ...(await leftoverFindings({
        directory: scope.project.projectRoot,
        names: [PROJECT_ENV_KEY_FILENAME],
        now,
        project: scope.project,
      }))
    );
  }
  if (scope.sharedKeyPath) {
    const candidate: Candidate = {
      path: scope.sharedKeyPath,
      holds: "the project env key",
      ignore: null,
    };
    findings.push(
      ...(await candidateFindings({ candidate, project: null })),
      ...(await leftoverFindings({
        directory: dirname(scope.sharedKeyPath),
        names: [basename(scope.sharedKeyPath)],
        now,
        project: null,
      }))
    );
  }
  const storeDirs = new Map<string, Set<string>>();
  for (const store of scope.stores) {
    findings.push(
      ...(await storeFindings({
        store,
        storeKeyFromEnvironment: scope.storeKeyFromEnvironment,
      }))
    );
    for (const path of [store.storePath, store.keyPath]) {
      const names = storeDirs.get(dirname(path)) ?? new Set<string>();
      names.add(basename(path));
      storeDirs.set(dirname(path), names);
    }
  }
  for (const [directory, names] of storeDirs) {
    findings.push(
      ...(await leftoverFindings({
        directory,
        names: [...names],
        now,
        project: null,
      }))
    );
  }
  for (const stale of await findStaleMuxEnvironments({
    ...(scope.tmpDir ? { tmpDir: scope.tmpDir } : {}),
    now,
  })) {
    findings.push({
      status: "warn",
      path: stale.root,
      message: `${stale.root} holds env values staged for a terminal session that never ran (older than ${MUX_ENV_TTL_MS / 60_000} minutes); --fix removes it.`,
      fix: { kind: "remove_mux", stale },
    });
  }
  return findings;
}

/** Tightens a file in place through a no-follow handle, if it is still the one found. */
async function tightenMode(
  fix: Extract<SecretsHygieneFix, { kind: "chmod" }>
): Promise<boolean> {
  const file = await open(fix.path, constants.O_RDONLY | constants.O_NOFOLLOW);
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
  return (
    await ensureGitignoreEntry({
      gitignorePath: fix.gitignorePath,
      entry: fix.entry,
      comment: "# machine-local secrets (hack doctor --fix)",
    })
  ).changed;
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
      if (fix.kind === "chmod") {
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
        `Left unchanged (it changed or could not be updated): ${finding.path}`
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
      return `Set mode ${octal(fix.mode)} on ${opts.path}`;
    case "ignore":
      return `Added '${fix.entry}' to ${fix.gitignorePath}`;
    case "remove_leftover":
      return `Removed leftover staging copy ${opts.path}`;
    default:
      return `Removed stale terminal-session env payload ${opts.path}`;
  }
}
