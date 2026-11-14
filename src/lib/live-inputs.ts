import { realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { PROJECT_ENV_KEY_FILENAME } from "../constants.ts";
import {
  resolveGlobalConfigPath,
  resolveGlobalHackDir,
} from "./config-paths.ts";
import {
  projectEnvLiveInputPaths,
  resolveProjectEnvSharedKeyPath,
} from "./project-env-config.ts";
import {
  RETIRED_STORE_INFIX,
  resolveFileSecretStorePaths,
} from "./secret-store.ts";
import type { SecretsHygieneScope } from "./secrets-hygiene.ts";

/**
 * The files current configuration reads (HACK-2165, HACK-2181), shared by
 * every path that removes files on its own: `hack doctor --fix` and the
 * automatic sweep of stale terminal-session payloads before each staging.
 * Both decide through {@link removalAllowed}; a configuration that cannot
 * be read refuses every removal.
 */

/**
 * `path` resolved, null when it (or a directory on the way) does not exist,
 * or "unknown" for any other failure: only confirmed absence lets a caller
 * look at the parent instead (HACK-2165).
 */
export async function realpathOrMissing(
  path: string
): Promise<string | null | "unknown"> {
  try {
    return await realpath(path);
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    return code === "ENOENT" || code === "ENOTDIR" ? null : "unknown";
  }
}

/** Whether a path component is a retired-store name (`<store>.retired-…`). */
export function inRetiredStore(path: string): boolean {
  return path.split(sep).some((part) => part.includes(RETIRED_STORE_INFIX));
}

/**
 * Every path current resolution reads (HACK-2165): the global configuration,
 * configured stores and
 * keys, the shared key, and the project's env inputs (its key, the primary
 * worktree's key, `hack.config.json` and every YAML layer; see
 * `projectEnvLiveInputPaths`), each as given and resolved. "unknown" when the
 * project's inputs cannot be inspected: then nothing counts as removable.
 */
export async function livePaths(
  scope: SecretsHygieneScope
): Promise<ReadonlySet<string> | "unknown"> {
  const paths = [
    ...(scope.globalConfigPath ? [scope.globalConfigPath] : []),
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
    // A missing input has no resolved spelling; one that cannot be resolved
    // for another reason leaves the set unknown, never smaller.
    const real = await realpathOrMissing(path);
    if (real === "unknown") {
      return "unknown";
    }
    if (real !== null) {
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
  // Only a missing target has no resolved spelling; one that cannot be
  // resolved for another reason might be live (or retired), so it is.
  const real = await realpathOrMissing(opts.path);
  if (real === "unknown") {
    return true;
  }
  if (real !== null && opts.live.has(real)) {
    return true;
  }
  // A retired store (HACK-2177) is kept on purpose: it may hold the only
  // copy of values its key still opens. Nothing in or under one is removed.
  return [resolve(opts.path), real].some(
    (spelling) => spelling !== null && inRetiredStore(spelling)
  );
}

/**
 * What removing a stale terminal-session payload can remove: its `env.json`
 * and then, only when empty, its directory.
 */
export function muxRemovalTargets(root: string): readonly string[] {
  return [join(root, "env.json"), root];
}

/**
 * The one decision every automatic or `--fix` removal makes just before it
 * acts: each target is live in none of `scopes` (current configuration,
 * plus the inspected one for `--fix`), is not in a retired store, and has a
 * resolved path that is known. Any failure to resolve a scope refuses.
 */
export async function removalAllowed(opts: {
  readonly targets: readonly string[];
  readonly scopes: readonly (() => Promise<SecretsHygieneScope>)[];
}): Promise<boolean> {
  const live: (ReadonlySet<string> | "unknown")[] = [];
  for (const scope of opts.scopes) {
    const resolved = await scope().catch(() => null);
    if (resolved === null) {
      return false;
    }
    live.push(await livePaths(resolved).catch(() => "unknown" as const));
  }
  for (const path of opts.targets) {
    // Whatever the scopes say, a retired store is never removed, and neither
    // is a target whose resolved path (so its membership) is unknown.
    const real = await realpathOrMissing(path);
    if (
      real === "unknown" ||
      inRetiredStore(resolve(path)) ||
      (real !== null && inRetiredStore(real))
    ) {
      return false;
    }
    for (const set of live) {
      if (await isLive({ path, live: set })) {
        return false;
      }
    }
  }
  return true;
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
    const resolved = await tolerate(
      resolveFileSecretStorePaths({ projectDir, strict })
    );
    const paths = resolved
      ? { storePath: resolved.storePath, keyPath: resolved.keyPath }
      : null;
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
    globalConfigPath: resolve(resolveGlobalConfigPath()),
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
