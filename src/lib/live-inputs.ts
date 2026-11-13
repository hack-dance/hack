import { realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { PROJECT_ENV_KEY_FILENAME } from "../constants.ts";
import { resolveGlobalHackDir } from "./config-paths.ts";
import {
  projectEnvLiveInputPaths,
  resolveProjectEnvSharedKeyPath,
} from "./project-env-config.ts";
import { resolveFileSecretStorePaths } from "./secret-store.ts";
import type { SecretsHygieneScope } from "./secrets-hygiene.ts";

/**
 * The files current configuration reads (HACK-2165, HACK-2181), shared by
 * every path that removes files on its own: `hack doctor --fix` and the
 * automatic sweep of stale terminal-session payloads. A removal goes ahead
 * only when none of these is its target or lies under it; a configuration
 * that cannot be read refuses every removal.
 */

/**
 * Every path current resolution reads: configured stores and keys, the
 * shared key, and the project's env inputs (its key, the primary worktree's
 * key, `hack.config.json` and every YAML layer; see
 * `projectEnvLiveInputPaths`), each as given and resolved. "unknown" when the
 * project's inputs cannot be inspected: then nothing counts as removable.
 */
export async function livePaths(
  scope: SecretsHygieneScope
): Promise<ReadonlySet<string> | "unknown"> {
  const paths = [
    ...scope.stores.flatMap((store) => [store.storePath, store.keyPath]),
    ...(scope.sharedKeyPath ? [scope.sharedKeyPath] : []),
  ];
  if (scope.project) {
    paths.push(join(scope.project.projectRoot, PROJECT_ENV_KEY_FILENAME));
    try {
      paths.push(...(await projectEnvLiveInputPaths(scope.project)));
    } catch {
      return "unknown";
    }
  }
  const live = new Set<string>();
  for (const path of paths) {
    live.add(resolve(path));
    const real = await realpath(path).catch(() => null);
    if (real) {
      live.add(real);
    }
  }
  return live;
}

/**
 * Whether resolution reads `path`, by its own spelling or resolved. A path,
 * not an inode: removing another link to a live file never removes the name
 * resolution reads.
 */
export async function isLive(opts: {
  readonly path: string;
  readonly live: ReadonlySet<string> | "unknown";
}): Promise<boolean> {
  if (opts.live === "unknown" || opts.live.has(resolve(opts.path))) {
    return true;
  }
  const real = await realpath(opts.path).catch(() => null);
  return real !== null && opts.live.has(real);
}

/**
 * Whether removing `target` (a file, or a directory with what is under it)
 * could remove a file resolution reads: the target itself or anything under
 * it, by its own spelling or resolved, is live. Always true when the live set
 * is unknown.
 */
export async function touchesLiveInput(opts: {
  readonly target: string;
  readonly live: ReadonlySet<string> | "unknown";
}): Promise<boolean> {
  if (opts.live === "unknown") {
    return true;
  }
  const roots = [resolve(opts.target)];
  const real = await realpath(opts.target).catch(() => null);
  if (real && real !== roots[0]) {
    roots.push(real);
  }
  for (const path of opts.live) {
    for (const root of roots) {
      if (path === root || path.startsWith(`${root}${sep}`)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The configuration a removal must respect, from `startDir`: the project
 * (found by `findProject`), its shared key, and the encrypted-file stores the
 * global and project configuration name. Reads configuration and git only.
 * A report tolerates what it cannot read; with `strict` (used to authorize a
 * removal) any discovery, read or parse failure rejects instead, so an
 * unknown configuration never looks like one that names nothing.
 */
export async function resolveLiveInputScope(opts: {
  readonly startDir: string;
  readonly strict?: boolean;
  readonly findProject: (startDir: string) => Promise<{
    readonly projectRoot: string;
    readonly projectDir: string;
  } | null>;
}): Promise<SecretsHygieneScope> {
  const strict = opts.strict === true;
  const tolerate = <T>(promise: Promise<T>): Promise<T | null> =>
    strict ? promise : promise.catch(() => null);
  const project = await tolerate(opts.findProject(opts.startDir));
  const stores = new Map<string, SecretsHygieneScope["stores"][number]>();
  for (const projectDir of [undefined, project?.projectDir]) {
    const paths = await tolerate(
      resolveFileSecretStorePaths({ projectDir, strict })
    );
    const key = paths ? `${paths.storePath}\0${paths.keyPath}` : null;
    if (!(paths && key) || stores.has(key)) {
      continue;
    }
    // Paths only a project's configuration chose (a cloned repository's
    // may name any file of the user's) are fixed only inside the checkout
    // or the Hack home.
    stores.set(
      key,
      projectDir && project
        ? { ...paths, fixRoots: [project.projectRoot, resolveGlobalHackDir()] }
        : paths
    );
  }
  return {
    project: project
      ? { projectRoot: project.projectRoot, projectDir: project.projectDir }
      : null,
    sharedKeyPath: project
      ? await tolerate(
          resolveProjectEnvSharedKeyPath({ projectRoot: project.projectRoot })
        )
      : null,
    stores: [...stores.values()],
    storeKeyFromEnvironment:
      (process.env.HACK_SECRETS_FILE_KEY ?? "").trim().length > 0,
  };
}
