import { PROJECT_ENV_KEY_FILENAME } from "../constants.ts";
import { exec } from "./shell.ts";

export type TrackedGeneratedFilesInspection = {
  /** Repo-relative paths of generated files currently tracked by git. */
  readonly trackedPaths: readonly string[];
  /** True when the project env secret key itself is tracked (committed secret). */
  readonly secretKeyTracked: boolean;
};

/**
 * Git pathspecs covering hack-generated, machine-local files that must never
 * be tracked. Patterns are repo-relative; `projectDirName` is usually
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
    `${dir}/.env.state.json`,
    `${dir}/hack.env.*.local.yaml`,
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
}): Promise<TrackedGeneratedFilesInspection | null> {
  const pathspecs = buildGeneratedFilePathspecs({
    projectDirName: opts.projectDirName,
  });
  let result: Awaited<ReturnType<typeof exec>>;
  try {
    result = await exec(
      ["git", "-C", opts.projectRoot, "ls-files", "-z", "--", ...pathspecs],
      { stdin: "ignore" }
    );
  } catch {
    return null;
  }
  if (result.exitCode !== 0) {
    return null;
  }

  const trackedPaths = result.stdout
    .split("\0")
    .map((path) => path.trim())
    .filter((path) => path.length > 0)
    .sort((a, b) => a.localeCompare(b));

  return {
    trackedPaths,
    secretKeyTracked: trackedPaths.includes(PROJECT_ENV_KEY_FILENAME),
  };
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
