import { basename, dirname, resolve } from "node:path";

import { PROJECT_ENV_KEY_FILENAME } from "../constants.ts";
import {
  type HackDirGitignoreState,
  inspectHackDirGitignore,
  isExcludedLegacyDotenvName,
} from "./project-env-config.ts";
import { exec } from "./shell.ts";

export type TrackedGeneratedFilesInspection = {
  /** Repo-relative paths of generated files currently tracked by git. */
  readonly trackedPaths: readonly string[];
  /** True when the project env secret key itself is tracked (committed secret). */
  readonly secretKeyTracked: boolean;
  /** Legacy plaintext overlay files git currently offers for addition. */
  readonly unignoredOverlayPaths: readonly string[];
  /** Shared legacy overlays require migration, never automatic index removal. */
  readonly trackedOverlayPaths: readonly string[];
};

/**
 * Git pathspecs covering generated files and legacy dotenv copies. Overlays
 * are reported separately for migration; templates/backups are excluded from
 * automatic untracking. Patterns are repo-relative; `projectDirName` is usually
 * `.hack`.
 *
 * Intentionally excluded: `<dir>/hack.env.local.yaml` — older repos may track
 * it on purpose as the shared `--env local` overlay (legacy compatibility in
 * `project-env-config.ts`), so a tracked copy is not treated as a leak.
 */
export function buildGeneratedFilePathspecs(opts: {
  readonly projectDirName: string;
}): readonly string[] {
  const dir = opts.projectDirName;
  return [
    `${dir}/.internal`,
    `${dir}/.branch`,
    `${dir}/.env`,
    `${dir}/.env.*`,
    `${dir}/.env.state.json`,
    `${dir}/tickets`,
    `${dir}/hack.env.*.local.yaml`,
    `${dir}/.hack.env*.tmp`,
    PROJECT_ENV_KEY_FILENAME,
  ];
}

/**
 * Lists hack-generated machine-local files that are tracked in git via
 * `git ls-files`. Returns null when git is unavailable or the project root is
 * not a git checkout.
 */
export async function inspectTrackedGeneratedFiles(opts: {
  readonly projectRoot: string;
  readonly projectDirName: string;
  /** Bound on each git call (default 10 s); a slower git reads as null. */
  readonly timeoutMs?: number;
}): Promise<TrackedGeneratedFilesInspection | null> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const pathspecs = buildGeneratedFilePathspecs({
    projectDirName: opts.projectDirName,
  });
  let result: Awaited<ReturnType<typeof exec>>;
  try {
    result = await exec(
      ["git", "-C", opts.projectRoot, "ls-files", "-z", "--", ...pathspecs],
      { stdin: "ignore", timeoutMs }
    );
  } catch {
    return null;
  }
  if (result.exitCode !== 0) {
    return null;
  }

  const allTrackedPaths = result.stdout
    .split("\0")
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .sort((a, b) => a.localeCompare(b));
  const trackedOverlayPaths = allTrackedPaths.filter(isLegacyOverlayPath);
  const trackedPaths = allTrackedPaths.filter(
    (path) => !isLegacyDotenvCopy(path)
  );

  let unignored: Awaited<ReturnType<typeof exec>>;
  try {
    unignored = await exec(
      [
        "git",
        "-C",
        opts.projectRoot,
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        `${opts.projectDirName}/.env.*`,
      ],
      { stdin: "ignore", timeoutMs }
    );
  } catch {
    return null;
  }
  if (unignored.exitCode !== 0) {
    return null;
  }

  return {
    trackedPaths,
    secretKeyTracked: trackedPaths.includes(PROJECT_ENV_KEY_FILENAME),
    trackedOverlayPaths,
    unignoredOverlayPaths: unignored.stdout
      .split("\0")
      .filter(isLegacyOverlayPath)
      .sort(),
  };
}

/** State remains generated; templates/backups and overlays are not autofix targets. */
function isLegacyDotenvCopy(path: string): boolean {
  const name = basename(path);
  return name.startsWith(".env.") && name !== ".env.state.json";
}

function isLegacyOverlayPath(path: string): boolean {
  return (
    isLegacyDotenvCopy(path) &&
    !isExcludedLegacyDotenvName(basename(path).slice(".env.".length))
  );
}

/**
 * Removes the given paths from the git index only (`git rm --cached`), leaving
 * the files on disk. `--force` skips git's staged-content safety check, which
 * is safe here because the working-tree files are never touched.
 */
export async function untrackGeneratedFiles(opts: {
  readonly projectRoot: string;
  readonly paths: readonly string[];
}): Promise<{ readonly ok: boolean; readonly error: string | null }> {
  if (opts.paths.length === 0) {
    return { ok: true, error: null };
  }
  if (opts.paths.some(isLegacyDotenvCopy)) {
    return {
      ok: false,
      error:
        "Legacy dotenv overlays, templates and backups are not automatic untracking targets. Migrate shared overlays with hack doctor --migrate-env-config before considering removal.",
    };
  }
  let result: Awaited<ReturnType<typeof exec>>;
  try {
    result = await exec(
      [
        "git",
        "-C",
        opts.projectRoot,
        "rm",
        "--cached",
        "-r",
        "-q",
        "--force",
        "--",
        ...opts.paths,
      ],
      { stdin: "ignore" }
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `exit ${result.exitCode}`;
    return { ok: false, error: detail };
  }
  return { ok: true, error: null };
}

/**
 * State of the committed `<projectDir>/.gitignore` for the doctor check and
 * its `--fix` step, or null when the project root is not inside a git work
 * tree (the file only matters to git). Read-only.
 *
 * The git probe runs in the project dir's parent (the project root), not in
 * the project dir: git follows a symlinked project dir, so a `.hack` that
 * links outside the repository would look like "not a git checkout" and hide
 * the `unsafe` state.
 *
 * The converse is intended: when the project root is not in a git work tree,
 * the result is null even if `.hack` links into another repository, because
 * the root's git (which has none) is the one the file would serve. Doctor
 * then reports "Skipped (not a git checkout)"; writes through that link are
 * still refused by `ensureHackDirGitignore`.
 */
export async function inspectHackDirGitignoreForDoctor(opts: {
  readonly projectDir: string;
}): Promise<HackDirGitignoreState | null> {
  const projectRoot = dirname(resolve(opts.projectDir));
  let probe: Awaited<ReturnType<typeof exec>>;
  try {
    probe = await exec(
      ["git", "-C", projectRoot, "rev-parse", "--is-inside-work-tree"],
      { stdin: "ignore", timeoutMs: 5000 }
    );
  } catch {
    return null;
  }
  if (probe.exitCode !== 0 || probe.stdout.trim() !== "true") {
    return null;
  }
  return await inspectHackDirGitignore({ projectDir: opts.projectDir });
}
