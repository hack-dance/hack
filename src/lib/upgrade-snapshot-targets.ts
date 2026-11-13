import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";

import {
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_CONFIG_FILENAME_PREFIX,
  PROJECT_ENV_CONFIG_FILENAME_SUFFIX,
  PROJECT_ENV_CONTRACT_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../constants.ts";
import { resolveGlobalConfigPath } from "./config-paths.ts";
import { resolveEnvKeyCandidates } from "./doctor-env-key.ts";
import {
  readProjectsRegistryStrict,
  resolveProjectsRegistryPath,
} from "./projects-registry.ts";
import { resolveFileSecretStorePaths } from "./secret-store.ts";
import { classifyRegistryEntry } from "./upgrade-check-project.ts";
import type { UpgradeSnapshotTarget } from "./upgrade-snapshot.ts";

/**
 * The files `hack upgrade snapshot` keeps (HACK-2189): what the upgrade
 * steps change. Global: the Hack config, the projects registry, and the
 * encrypted secret store and its key when a file store is in use. Per live
 * registered project: its `.hack/` config, env contract, dotenv files, YAML
 * env layers, `.hack/.gitignore`, and env key files inside the checkout.
 *
 * Only existing regular files are listed; a link or other entry at one of
 * these paths is reported in `skipped` and never followed. A step that
 * creates new files snapshots those paths itself, through the library.
 */
export async function collectUpgradeSnapshotTargets(): Promise<{
  readonly targets: readonly UpgradeSnapshotTarget[];
  readonly skipped: readonly {
    readonly path: string;
    readonly label: string;
    readonly reason: "symlink" | "not-a-file" | "unreadable";
  }[];
}> {
  const candidates: UpgradeSnapshotTarget[] = [
    { path: resolveGlobalConfigPath(), label: "global: hack.config.json" },
    { path: resolveProjectsRegistryPath(), label: "global: projects.json" },
  ];
  const store = await resolveFileSecretStorePaths({}).catch(() => null);
  if (store?.active) {
    candidates.push(
      { path: store.storePath, label: "global: secret store" },
      { path: store.keyPath, label: "global: secret store key" }
    );
  }
  const registry = await readProjectsRegistryStrict().catch(() => null);
  if (registry?.kind === "valid") {
    for (const project of registry.registry.projects) {
      if ((await classifyRegistryEntry(project)).state !== "live") {
        continue;
      }
      candidates.push(
        ...(await projectCandidates({
          name: project.name,
          root: project.repoRoot,
          projectDir: project.projectDir,
        }))
      );
    }
  }
  const seen = new Set<string>();
  const targets: UpgradeSnapshotTarget[] = [];
  const skipped: {
    path: string;
    label: string;
    reason: "symlink" | "not-a-file" | "unreadable";
  }[] = [];
  for (const candidate of candidates) {
    const path = resolve(candidate.path);
    if (seen.has(path)) {
      continue;
    }
    seen.add(path);
    const entry = await lstat(path).catch((error: unknown) =>
      errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR"
        ? null
        : ("error" as const)
    );
    if (entry === null) {
      continue;
    }
    if (entry === "error") {
      skipped.push({ path, label: candidate.label, reason: "unreadable" });
    } else if (entry.isSymbolicLink()) {
      skipped.push({ path, label: candidate.label, reason: "symlink" });
    } else if (entry.isFile()) {
      targets.push({ path, label: candidate.label });
    } else {
      skipped.push({ path, label: candidate.label, reason: "not-a-file" });
    }
  }
  return { targets, skipped };
}

async function projectCandidates(opts: {
  readonly name: string;
  readonly root: string;
  readonly projectDir: string;
}): Promise<UpgradeSnapshotTarget[]> {
  const dirName = basename(opts.projectDir);
  const label = (file: string) => `project ${opts.name}: ${dirName}/${file}`;
  const names = await readdir(opts.projectDir).catch(() => [] as string[]);
  const envFiles = names.filter(
    (name) =>
      name === PROJECT_ENV_FILENAME ||
      name.startsWith(`${PROJECT_ENV_FILENAME}.`) ||
      (name.startsWith(PROJECT_ENV_CONFIG_FILENAME_PREFIX) &&
        name.endsWith(PROJECT_ENV_CONFIG_FILENAME_SUFFIX))
  );
  const files = [
    PROJECT_CONFIG_FILENAME,
    PROJECT_ENV_CONTRACT_FILENAME,
    ".gitignore",
    ...envFiles,
  ];
  const keys = await resolveEnvKeyCandidates({ projectRoot: opts.root }).catch(
    () => []
  );
  return [
    ...files.map((file) => ({
      path: resolve(opts.projectDir, file),
      label: label(file),
    })),
    ...keys
      .filter((key) => isInside({ path: key.path, dir: opts.root }))
      .map((key) => ({
        path: key.path,
        label: `project ${opts.name}: ${relative(opts.root, key.path)} (env key)`,
      })),
  ];
}

function isInside(opts: { readonly path: string; readonly dir: string }) {
  const path = resolve(opts.path);
  const dir = resolve(opts.dir);
  return path.startsWith(`${dir}${sep}`) && dirname(path) !== "";
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return;
  }
  const { code } = error;
  return typeof code === "string" ? code : undefined;
}
