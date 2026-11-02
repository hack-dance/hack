import type { Stats } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_ENV_KEY_FILENAME } from "../constants.ts";
import { resolveGitPrimaryWorktreeRoot } from "./git-worktree.ts";
import { isRecord } from "./guards.ts";
import { readBoundedPrivateFile } from "./private-file.ts";
import {
  isGitIgnoredProjectEnvPath,
  resolveProjectEnvKeyPath,
  resolveProjectEnvSharedKeyLocation,
} from "./project-env-config.ts";
import { exec } from "./shell.ts";

/**
 * Value-free strength and exposure audit of the project env secret key.
 *
 * Ownership: Doctor owns this read-only audit. It never writes, chmods,
 * untracks or rotates anything, and `hack doctor --fix` does not act on it;
 * every finding carries the exact command a person can run instead.
 *
 * Privacy invariant: key bytes are read only to classify their length and
 * entropy class and never leave this module. Findings carry closed codes,
 * fixed subject labels and project-relative paths only; absolute paths, key
 * contents and environment values are never included.
 */

/** Closed set of env key diagnostic codes. */
export type EnvKeyDiagnosticCode =
  | "env-key-ok"
  | "env-key-absent"
  | "env-key-symlink"
  | "env-key-not-regular"
  | "env-key-unreadable"
  | "env-key-weak-permissions"
  | "env-key-wrong-owner"
  | "env-key-tracked"
  | "env-key-unignored"
  | "env-key-public-path"
  | "env-key-wrong-length"
  | "env-key-low-entropy";

export type EnvKeyFindingStatus = "ok" | "warn" | "error";

export type EnvKeyFinding = {
  readonly code: EnvKeyDiagnosticCode;
  readonly status: EnvKeyFindingStatus;
  /** Fixed label or project-relative path; never absolute, never key bytes. */
  readonly subject: string;
  /** Exact suggested command or action, run from the project root; Doctor never runs it. */
  readonly remedy: string | null;
};

export type EnvKeyInspection = {
  readonly status: EnvKeyFindingStatus;
  /** Ordered most severe first; a clean result is one `env-key-ok` or `env-key-absent` finding. */
  readonly findings: readonly EnvKeyFinding[];
};

/** Where a candidate key file lives relative to the project. */
export type EnvKeyCandidateRole = "local" | "shared" | "primary";

export type EnvKeyCandidate = {
  readonly role: EnvKeyCandidateRole;
  /** Absolute path; used for filesystem reads only and never reported. */
  readonly path: string;
};

/** Lists project-relative paths of tracked files named like the key; null when unknown. */
export type ListTrackedKeyPaths = (opts: {
  readonly projectRoot: string;
}) => Promise<readonly string[] | null>;

/**
 * Whether git's ignore rules match the checkout-local key file; null when
 * unknown (git unavailable, or the project is not in a work tree).
 */
export type IsLocalKeyIgnored = (opts: {
  readonly projectRoot: string;
}) => Promise<boolean | null>;

export type InspectEnvKeyOptions = {
  readonly projectRoot: string;
  /** Candidate key files in resolution order (local, shared, primary). */
  readonly candidates: readonly EnvKeyCandidate[];
  /** Environment consulted for the `HACK_ENV_SECRET_KEY` fallback. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Current user id; null skips the ownership and permission checks (non-POSIX). */
  readonly uid: number | null;
  readonly listTrackedKeyPaths: ListTrackedKeyPaths;
  readonly isLocalKeyIgnored: IsLocalKeyIgnored;
};

/** Generated keys are 32 random bytes rendered as unpadded base64url. */
const GENERATED_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Shortest text that can carry the 256 bits AES-256-GCM expects in base64url. */
export const ENV_KEY_MIN_TEXT_LENGTH = 43;
/** Entropy floor for non-generated key text (empirical Shannon estimate). */
export const ENV_KEY_MIN_ESTIMATED_BITS = 128;
const ENV_KEY_MIN_DISTINCT_CHARACTERS = 8;
const ENV_KEY_MAX_BYTES = 1024 * 1024;
const ENV_KEY_ENV_NAME = "HACK_ENV_SECRET_KEY";

/**
 * Build-output and static-hosting directories whose contents are commonly
 * published. A key file directly inside one is reported as exposed, at the
 * project root and in nested packages (bounded walk; see below).
 */
export const ENV_KEY_PUBLIC_ARTIFACT_DIRS = [
  "public",
  "static",
  "dist",
  "build",
  "out",
  "www",
  "_site",
  ".next",
  ".output",
] as const;

/** Directory names the nested public-artifact walk never enters. */
const ENV_KEY_PUBLIC_WALK_SKIP: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
]);
/**
 * Bounds of the nested public-artifact walk: the deepest artifact directory
 * considered (the project root is depth 0), the most directories read, and the
 * most directory entries examined. Past a bound the walk stops; it never
 * reports a partial path or fails the check.
 */
export const ENV_KEY_PUBLIC_WALK_MAX_DEPTH = 6;
export const ENV_KEY_PUBLIC_WALK_MAX_DIRECTORIES = 4096;
export const ENV_KEY_PUBLIC_WALK_MAX_ENTRIES = 100_000;

const STATUS_RANK: Record<EnvKeyFindingStatus, number> = {
  ok: 0,
  warn: 1,
  error: 2,
};

const SUBJECT_LABEL: Record<EnvKeyCandidateRole, string> = {
  local: PROJECT_ENV_KEY_FILENAME,
  shared: `<git-common-dir>/${PROJECT_ENV_KEY_FILENAME}`,
  primary: `<primary-checkout>/${PROJECT_ENV_KEY_FILENAME}`,
};

const PRIMARY_REMEDY =
  "Run 'hack doctor' in the primary checkout and follow its env key guidance.";

/** Shell spelling of a candidate (plus optional suffix), run from the project root. */
function shellPathFor(
  role: Exclude<EnvKeyCandidateRole, "primary">,
  suffix = ""
): string {
  return role === "local"
    ? `${PROJECT_ENV_KEY_FILENAME}${suffix}`
    : `"$(git rev-parse --git-common-dir)/${PROJECT_ENV_KEY_FILENAME}${suffix}"`;
}

function remedyFor(
  role: EnvKeyCandidateRole,
  build: (path: (suffix?: string) => string) => string
): string {
  if (role === "primary") {
    return PRIMARY_REMEDY;
  }
  return build((suffix) => shellPathFor(role, suffix));
}

/**
 * Classifies key text into the AES-256-GCM key-material classes. The text is
 * hashed with SHA-256 into the cipher key, so its strength is the entropy of
 * the text itself. Returns null when the text is acceptable.
 */
export function classifyEnvKeyText(
  keyText: string
): "env-key-wrong-length" | "env-key-low-entropy" | null {
  if (GENERATED_KEY_PATTERN.test(keyText)) {
    return null;
  }
  const characters = Array.from(keyText);
  if (characters.length < ENV_KEY_MIN_TEXT_LENGTH) {
    return "env-key-wrong-length";
  }
  const counts = new Map<string, number>();
  for (const character of characters) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let bitsPerCharacter = 0;
  for (const count of counts.values()) {
    const probability = count / characters.length;
    bitsPerCharacter -= probability * Math.log2(probability);
  }
  if (
    counts.size < ENV_KEY_MIN_DISTINCT_CHARACTERS ||
    bitsPerCharacter * characters.length < ENV_KEY_MIN_ESTIMATED_BITS
  ) {
    return "env-key-low-entropy";
  }
  return null;
}

class EnvKeyUnreadableError extends Error {}

type EntryStats = Stats;

/** lstat that maps absence to null and any other failure to EnvKeyUnreadableError. */
async function lstatOrNull(path: string): Promise<EntryStats | null> {
  try {
    return await lstat(path);
  } catch (error: unknown) {
    if (
      isRecord(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return null;
    }
    throw new EnvKeyUnreadableError();
  }
}

function rotateRemedy(path: (suffix?: string) => string): string {
  return `mv ${path()} ${path(".old")}, then re-add each secret with 'hack env add --secret KEY VALUE' (Hack generates a new 256-bit key).`;
}

async function inspectCandidate(opts: {
  readonly candidate: EnvKeyCandidate;
  readonly uid: number | null;
}): Promise<{
  readonly present: boolean;
  readonly findings: readonly EnvKeyFinding[];
}> {
  const { role, path } = opts.candidate;
  const subject = SUBJECT_LABEL[role];
  const unreadable: EnvKeyFinding = {
    code: "env-key-unreadable",
    status: "error",
    subject,
    remedy: remedyFor(role, (p) => `ls -l ${p()}`),
  };
  let stats: EntryStats | null;
  try {
    stats = await lstatOrNull(path);
  } catch {
    return { present: true, findings: [unreadable] };
  }
  if (!stats) {
    return { present: false, findings: [] };
  }
  if (stats.isSymbolicLink()) {
    return {
      present: true,
      findings: [
        {
          code: "env-key-symlink",
          status: "error",
          subject,
          remedy: remedyFor(
            role,
            (p) =>
              `after confirming the link target is your key: cp -L ${p()} ${p(".new")} && mv -f ${p(".new")} ${p()} && chmod 600 ${p()}`
          ),
        },
      ],
    };
  }
  if (!stats.isFile()) {
    return {
      present: true,
      findings: [
        {
          code: "env-key-not-regular",
          status: "error",
          subject,
          remedy: remedyFor(role, (p) => `ls -ld ${p()}`),
        },
      ],
    };
  }

  const findings: EnvKeyFinding[] = [];
  if (opts.uid !== null && stats.uid !== opts.uid) {
    findings.push({
      code: "env-key-wrong-owner",
      status: "warn",
      subject,
      remedy: remedyFor(role, (p) => `sudo chown "$(id -u)" ${p()}`),
    });
  }
  if (opts.uid !== null && (stats.mode & 0o077) !== 0) {
    findings.push({
      code: "env-key-weak-permissions",
      status: "warn",
      subject,
      remedy: remedyFor(role, (p) => `chmod 600 ${p()}`),
    });
  }

  let keyText: string | null;
  try {
    keyText = await readBoundedPrivateFile({
      path,
      directories: [],
      canonical: false,
      maxBytes: ENV_KEY_MAX_BYTES,
      refusal: () => new EnvKeyUnreadableError(),
    });
  } catch {
    findings.push(unreadable);
    return { present: true, findings };
  }
  // Empty or whitespace-only files are skipped by key resolution.
  const strength =
    keyText === null ? "env-key-wrong-length" : classifyEnvKeyText(keyText);
  if (strength) {
    findings.push({
      code: strength,
      status: "warn",
      subject,
      remedy: remedyFor(role, rotateRemedy),
    });
  }
  return { present: true, findings };
}

const PORTABLE_RELATIVE_PATH = /^[A-Za-z0-9._/-]+$/;

/** Repo-relative path spelled only from portable characters, or null. */
function portableRelativePath(path: string): string | null {
  return PORTABLE_RELATIVE_PATH.test(path) &&
    !path.startsWith("/") &&
    !path.startsWith("-") &&
    !path.split("/").includes("..")
    ? path
    : null;
}

function publicPathFinding(relativeDir: string): EnvKeyFinding {
  const portable = portableRelativePath(relativeDir);
  if (portable === null) {
    return {
      code: "env-key-public-path",
      status: "error",
      subject: `<unprintable-path>/${PROJECT_ENV_KEY_FILENAME}`,
      remedy:
        "Remove the key copy from the public artifact directory, then rotate the key: a published copy is not secret.",
    };
  }
  const relative = `${portable}/${PROJECT_ENV_KEY_FILENAME}`;
  return {
    code: "env-key-public-path",
    status: "error",
    subject: relative,
    remedy: `rm -- ${relative}, then rotate the key: a published copy is not secret.`,
  };
}

/** Locale-independent order so the walk and its findings are stable. */
function compareNames(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

const PUBLIC_ARTIFACT_DIR_NAMES: ReadonlySet<string> = new Set(
  ENV_KEY_PUBLIC_ARTIFACT_DIRS
);

/**
 * Project-relative paths (with `/` separators) of public artifact directories
 * below the top level, such as `apps/web/public` in a monorepo. Bounded
 * breadth-first walk in name order: symlinked directories are not followed,
 * `node_modules` and `.git` are skipped, and unreadable directories are
 * passed over.
 */
export async function findNestedPublicArtifactDirs(opts: {
  readonly projectRoot: string;
  /** Test seam for the walk bounds; production uses the documented constants. */
  readonly limits?: {
    readonly maxDirectories?: number;
    readonly maxEntries?: number;
  };
}): Promise<readonly string[]> {
  const maxDirectories =
    opts.limits?.maxDirectories ?? ENV_KEY_PUBLIC_WALK_MAX_DIRECTORIES;
  const maxEntries = opts.limits?.maxEntries ?? ENV_KEY_PUBLIC_WALK_MAX_ENTRIES;
  const found: string[] = [];
  const queue: { readonly relative: string; readonly depth: number }[] = [
    { relative: "", depth: 0 },
  ];
  let index = 0;
  let entries = 0;
  while (
    index < queue.length &&
    index < maxDirectories &&
    entries < maxEntries
  ) {
    const current = queue[index++];
    if (!current) {
      break;
    }
    const children = await walkableChildDirectories(
      join(opts.projectRoot, current.relative)
    );
    entries += children.entries;
    const depth = current.depth + 1;
    for (const name of children.names) {
      const relative = current.relative ? `${current.relative}/${name}` : name;
      if (depth >= 2 && PUBLIC_ARTIFACT_DIR_NAMES.has(name)) {
        found.push(relative);
      }
      if (depth < ENV_KEY_PUBLIC_WALK_MAX_DEPTH) {
        queue.push({ relative, depth });
      }
    }
  }
  return found;
}

/**
 * Sorted names of the child directories the walk may enter (real directories,
 * not symlinks, outside the skip list) and the number of entries read; an
 * unreadable directory has none.
 */
async function walkableChildDirectories(path: string): Promise<{
  readonly names: readonly string[];
  readonly entries: number;
}> {
  try {
    const children = await readdir(path, { withFileTypes: true });
    return {
      entries: children.length,
      names: children
        .filter(
          (child) =>
            child.isDirectory() && !ENV_KEY_PUBLIC_WALK_SKIP.has(child.name)
        )
        .map((child) => child.name)
        .sort(compareNames),
    };
  } catch {
    return { names: [], entries: 0 };
  }
}

async function inspectPublicArtifactCopies(opts: {
  readonly projectRoot: string;
}): Promise<readonly EnvKeyFinding[]> {
  const findings: EnvKeyFinding[] = [];
  const present = async (relativeDir: string) =>
    // An entry that exists but cannot be inspected still counts as present.
    await lstatOrNull(
      join(opts.projectRoot, relativeDir, PROJECT_ENV_KEY_FILENAME)
    ).then(
      (stats) => stats !== null,
      () => true
    );
  for (const dir of ENV_KEY_PUBLIC_ARTIFACT_DIRS) {
    if (await present(dir)) {
      findings.push(publicPathFinding(dir));
    }
  }
  const nested = await findNestedPublicArtifactDirs({
    projectRoot: opts.projectRoot,
  }).catch(() => []);
  for (const dir of nested) {
    if (await present(dir)) {
      findings.push(publicPathFinding(dir));
    }
  }
  return findings;
}

type CandidatePresence = {
  readonly role: EnvKeyCandidateRole;
  readonly present: boolean;
};

/**
 * `env-key-unignored` when git positively does not ignore the present
 * checkout-local key. Only that key can be committed from this checkout: the
 * shared key lives in the git dir, and the primary's belongs to that checkout.
 * An absent local key or an unknown answer (no git, probe failure) reports
 * nothing.
 */
async function inspectLocalKeyIgnored(args: {
  readonly opts: InspectEnvKeyOptions;
  readonly presence: readonly CandidatePresence[];
}): Promise<readonly EnvKeyFinding[]> {
  const { opts } = args;
  if (
    !args.presence.some(
      (entry) => entry.role === "local" && entry.present === true
    )
  ) {
    return [];
  }
  const ignored = await opts
    .isLocalKeyIgnored({ projectRoot: opts.projectRoot })
    .catch(() => null);
  if (ignored !== false) {
    return [];
  }
  return [
    {
      code: "env-key-unignored",
      status: "warn",
      subject: PROJECT_ENV_KEY_FILENAME,
      remedy: `printf '\\n%s\\n' ${PROJECT_ENV_KEY_FILENAME} >> .gitignore, then confirm 'git status' no longer lists ${PROJECT_ENV_KEY_FILENAME}.`,
    },
  ];
}

function sortFindings(findings: readonly EnvKeyFinding[]): EnvKeyFinding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (left, right) =>
        STATUS_RANK[right.finding.status] - STATUS_RANK[left.finding.status] ||
        left.index - right.index
    )
    .map(({ finding }) => finding);
}

/**
 * Inspects every present candidate key file, any git-tracked or published
 * copy, and the `HACK_ENV_SECRET_KEY` fallback when no key file exists.
 */
export async function inspectProjectEnvKey(
  opts: InspectEnvKeyOptions
): Promise<EnvKeyInspection> {
  const findings: EnvKeyFinding[] = [];
  let anyPresent = false;
  const presence: CandidatePresence[] = [];
  const seen = new Set<string>();
  for (const candidate of opts.candidates) {
    if (seen.has(candidate.path)) {
      continue;
    }
    seen.add(candidate.path);
    const inspected = await inspectCandidate({ candidate, uid: opts.uid });
    anyPresent ||= inspected.present;
    presence.push({ role: candidate.role, present: inspected.present });
    findings.push(...inspected.findings);
  }

  findings.push(...(await inspectLocalKeyIgnored({ opts, presence })));

  const tracked = await opts
    .listTrackedKeyPaths({ projectRoot: opts.projectRoot })
    .catch(() => null);
  for (const relative of [...new Set(tracked ?? [])].sort()) {
    const portable = portableRelativePath(relative);
    findings.push({
      code: "env-key-tracked",
      status: "error",
      subject: portable ?? `<unprintable-path>/${PROJECT_ENV_KEY_FILENAME}`,
      remedy:
        portable === null
          ? "Untrack the committed key copy with 'git rm --cached', then rotate the key: a committed key is not secret."
          : `git rm --cached -- ${portable}, then rotate the key: a committed key is not secret.`,
    });
  }

  findings.push(
    ...(await inspectPublicArtifactCopies({ projectRoot: opts.projectRoot }))
  );

  if (!anyPresent) {
    const envKey = opts.env[ENV_KEY_ENV_NAME]?.trim() ?? "";
    if (envKey.length > 0) {
      anyPresent = true;
      const strength = classifyEnvKeyText(envKey);
      if (strength) {
        findings.push({
          code: strength,
          status: "warn",
          subject: `$${ENV_KEY_ENV_NAME}`,
          remedy: `set ${ENV_KEY_ENV_NAME} to a 256-bit key such as the output of 'openssl rand -base64 32', then re-add each secret with 'hack env add --secret KEY VALUE'.`,
        });
      }
    }
  }

  if (findings.length === 0) {
    return {
      status: "ok",
      findings: [
        {
          code: anyPresent ? "env-key-ok" : "env-key-absent",
          status: "ok",
          subject: PROJECT_ENV_KEY_FILENAME,
          remedy: null,
        },
      ],
    };
  }
  const sorted = sortFindings(findings);
  return { status: sorted[0]?.status ?? "ok", findings: sorted };
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Candidate key files in key-resolution order: checkout-local, shared under
 * the git common dir, then the primary checkout's key for a linked worktree.
 * Resolution never reads key contents.
 */
export async function resolveEnvKeyCandidates(opts: {
  readonly projectRoot: string;
}): Promise<readonly EnvKeyCandidate[]> {
  const candidates: EnvKeyCandidate[] = [
    { role: "local", path: resolveProjectEnvKeyPath(opts) },
  ];
  const shared = await resolveProjectEnvSharedKeyLocation(opts);
  if (shared) {
    candidates.push({ role: "shared", path: shared.path });
  }
  const primaryRoot = await resolveGitPrimaryWorktreeRoot({
    repoRoot: opts.projectRoot,
  });
  if (
    primaryRoot &&
    (await canonicalPath(primaryRoot)) !==
      (await canonicalPath(opts.projectRoot))
  ) {
    candidates.push({
      role: "primary",
      path: resolveProjectEnvKeyPath({ projectRoot: primaryRoot }),
    });
  }
  return candidates;
}

/**
 * Default tracked-key lister: `git ls-files` for every tracked file named like
 * the key anywhere in the checkout. Null when git is unavailable or the root
 * is not a work tree.
 */
export const gitListTrackedKeyPaths: ListTrackedKeyPaths = async (opts) => {
  let result: Awaited<ReturnType<typeof exec>>;
  try {
    result = await exec(
      [
        "git",
        "-C",
        opts.projectRoot,
        "ls-files",
        "-z",
        "--",
        `:(glob)**/${PROJECT_ENV_KEY_FILENAME}`,
      ],
      { stdin: "ignore", timeoutMs: 5000 }
    );
  } catch {
    return null;
  }
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout
    .split("\0")
    .filter(
      (path) =>
        path === PROJECT_ENV_KEY_FILENAME ||
        path.endsWith(`/${PROJECT_ENV_KEY_FILENAME}`)
    );
};

/**
 * Default ignore probe: `git check-ignore --no-index` for the checkout-local
 * key. Null when git is unavailable or the root is not a work tree.
 */
export const gitIsLocalKeyIgnored: IsLocalKeyIgnored = async (opts) =>
  await isGitIgnoredProjectEnvPath({
    projectRoot: opts.projectRoot,
    path: resolveProjectEnvKeyPath(opts),
  });

const SUMMARY: Record<EnvKeyDiagnosticCode, string> = {
  "env-key-ok": "key material is private and in the 256-bit class",
  "env-key-absent": "no project env key provisioned",
  "env-key-symlink": "is a symlink; Hack refuses symlinked keys",
  "env-key-not-regular": "is not a regular file",
  "env-key-unreadable": "is unreadable, oversized or not UTF-8",
  "env-key-weak-permissions": "is accessible by group or others (want 0600)",
  "env-key-wrong-owner": "is not owned by the current user",
  "env-key-tracked": "is tracked by git",
  "env-key-unignored": "is not ignored by git, so it could be committed",
  "env-key-public-path": "is present in a public artifact directory",
  "env-key-wrong-length": "is shorter than a 256-bit key",
  "env-key-low-entropy": "has too little entropy for a 256-bit key",
};

/** Value-free human summary of an inspection; Doctor never applies the suggestions. */
export function describeEnvKeyInspection(inspection: EnvKeyInspection): string {
  return inspection.findings
    .map((finding) => {
      const text =
        finding.code === "env-key-ok" || finding.code === "env-key-absent"
          ? `${finding.code}: ${SUMMARY[finding.code]}`
          : `${finding.code}: ${finding.subject} ${SUMMARY[finding.code]}`;
      return finding.remedy ? `${text}. Suggested: ${finding.remedy}` : text;
    })
    .join("; ");
}
