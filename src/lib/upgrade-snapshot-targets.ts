import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";

import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_ENV_CONFIG_FILENAME_PREFIX,
  PROJECT_ENV_CONFIG_FILENAME_SUFFIX,
  PROJECT_ENV_CONTRACT_FILENAME,
  PROJECT_ENV_FILENAME,
} from "../constants.ts";
import { resolveGlobalConfigPath } from "./config-paths.ts";
import { resolveEnvKeyCandidates } from "./doctor-env-key.ts";
import { previewLegacyMigrationOverlayNames } from "./project-env-config.ts";
import {
  readProjectsRegistryStrict,
  resolveProjectsRegistryPath,
} from "./projects-registry.ts";
import {
  inspectStoreKeyState,
  resolveFileSecretStorePaths,
} from "./secret-store.ts";
import {
  classifyRegistryEntry,
  registeredCheckouts,
} from "./upgrade-check-project.ts";
import type { UpgradeSnapshotTarget } from "./upgrade-snapshot.ts";

/**
 * The files `hack upgrade snapshot` keeps (HACK-2189): what the upgrade
 * steps change. Global: the Hack config, the projects registry, and the
 * encrypted secret store and its key when a file store is in use. Per live
 * registered project: its `.hack/` config, env contract, dotenv files, YAML
 * env layers, `.hack/.gitignore`, and env key files inside the checkout.
 *
 * Existing regular files are kept; a path that does not exist yet (an env
 * layer the migration creates) is recorded as absent, so a rollback moves
 * aside what a step put there. A link or other entry at one of these paths
 * is reported in `skipped` and never followed. A step that writes other
 * files snapshots them itself, through the library.
 */
export async function collectUpgradeSnapshotTargets(): Promise<{
  readonly targets: readonly UpgradeSnapshotTarget[];
  readonly skipped: readonly {
    readonly path: string;
    readonly label: string;
    readonly reason: "symlink" | "not-a-file" | "unreadable";
  }[];
  /**
   * What the snapshot does not cover, so it is not a complete recovery
   * point: a registry that could not be read (no project is covered),
   * registry records that are not valid entries, live checkouts that
   * cannot be read, files that were skipped (a link or other entry), and
   * checkouts whose migration write set could not be fully known (overlays
   * only the secret store holds, when listing them would ask the keychain).
   * Dead registry entries are left out on purpose and are not gaps.
   */
  readonly gaps: readonly { readonly name: string; readonly reason: string }[];
}> {
  const gaps: { name: string; reason: string }[] = [];
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
  if (registry === null || registry.kind === "invalid") {
    gaps.push({
      name: "projects registry",
      reason:
        "it could not be read or is not valid, so no project's files are in this snapshot",
    });
  }
  if (registry?.kind === "valid") {
    if (registry.rejected > 0) {
      gaps.push({
        name: "projects registry",
        reason: `${registry.rejected} record(s) are not valid project entries, so those projects are not in this snapshot`,
      });
    }
    for (const project of registry.registry.projects.flatMap(
      registeredCheckouts
    )) {
      const state = await classifyRegistryEntry(project);
      if (state.state === "unreadable") {
        gaps.push({
          name: project.name,
          reason: `the checkout cannot be read (${state.reason}), so its files are not in this snapshot`,
        });
      }
      if (state.state !== "live") {
        continue;
      }
      const found = await projectCandidates({
        name: project.name,
        root: project.repoRoot,
        projectDir: project.projectDir,
      });
      candidates.push(...found.targets);
      if (found.gap !== null) {
        gaps.push({ name: project.name, reason: found.gap });
      }
    }
  }
  const { targets, skipped } = await classifyCandidates(candidates);
  for (const entry of skipped) {
    gaps.push({
      name: entry.label,
      reason: `${entry.path} was not kept (${entry.reason})`,
    });
  }
  return { targets, skipped, gaps };
}

type Skipped = {
  readonly path: string;
  readonly label: string;
  readonly reason: "symlink" | "not-a-file" | "unreadable";
};

/**
 * Regular files and absent paths become targets (absent ones recorded as
 * absent, so a rollback moves aside what a step creates there); links and
 * other entries are skipped, never followed.
 */
async function classifyCandidates(
  candidates: readonly UpgradeSnapshotTarget[]
): Promise<{
  readonly targets: UpgradeSnapshotTarget[];
  readonly skipped: Skipped[];
}> {
  const seen = new Set<string>();
  const targets: UpgradeSnapshotTarget[] = [];
  const skipped: Skipped[] = [];
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
      // Absent now: recorded as absent, so a rollback moves aside what a
      // step creates there.
      targets.push({ path, label: candidate.label });
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

const LEGACY_OVERLAY = /^\.env\.([A-Za-z0-9_-]+)$/u;

async function projectCandidates(opts: {
  readonly name: string;
  readonly root: string;
  readonly projectDir: string;
}): Promise<{
  readonly targets: UpgradeSnapshotTarget[];
  readonly gap: string | null;
}> {
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
  // What the env migration writes or creates: the YAML layers (base,
  // machine-local, and one pair per legacy overlay), the config, the
  // Compose file it repairs, and .hack/.gitignore; absent ones are recorded
  // as absent.
  const migration = await migrationOverlays({
    root: opts.root,
    projectDir: opts.projectDir,
    names,
  });
  const overlays = migration.overlays;
  const layers = [
    "hack.env.default.yaml",
    "hack.env.local.yaml",
    "hack.env.default.local.yaml",
    ...overlays.flatMap((overlay) => [
      `hack.env.${overlay}.yaml`,
      `hack.env.${overlay}.local.yaml`,
    ]),
  ];
  const files = [
    PROJECT_CONFIG_FILENAME,
    PROJECT_ENV_CONTRACT_FILENAME,
    PROJECT_COMPOSE_FILENAME,
    ".gitignore",
    ...envFiles,
    ...layers,
  ];
  const keys = await resolveEnvKeyCandidates({ projectRoot: opts.root }).catch(
    () => []
  );
  return {
    targets: [
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
    ],
    gap: migration.gap,
  };
}

/**
 * The overlays the env migration would turn into layers: from the files,
 * plus, when the project's secret store opens with this shell's key or its
 * key file (never the keychain), the overlays only the store holds, from
 * the migration's own selection. When the store can only be opened through
 * the keychain, those cannot be listed without a prompt: a gap.
 */
async function migrationOverlays(opts: {
  readonly root: string;
  readonly projectDir: string;
  readonly names: readonly string[];
}): Promise<{
  readonly overlays: readonly string[];
  readonly gap: string | null;
}> {
  const fromFiles = opts.names.flatMap((name) => {
    const match = LEGACY_OVERLAY.exec(name);
    return match?.[1] && match[1] !== "state" ? [match[1]] : [];
  });
  const location = await resolveFileSecretStorePaths({
    projectDir: opts.projectDir,
  }).catch(() => null);
  if (!location?.active) {
    return { overlays: fromFiles, gap: null };
  }
  const state = await inspectStoreKeyState({
    storePath: location.storePath,
    keyPath: location.keyPath,
    env: process.env,
  });
  if (state.kind === "key-uninspected") {
    return {
      overlays: fromFiles,
      gap: "its secret store's key is not in a key file or HACK_SECRETS_FILE_KEY, so overlays held only in the store could not be listed without asking the OS keychain",
    };
  }
  if (state.kind !== "opens") {
    // The migration cannot list the store either, so it adds no overlay
    // from it.
    return { overlays: fromFiles, gap: null };
  }
  const preview = await previewLegacyMigrationOverlayNames({
    projectDir: opts.projectDir,
    projectName: await projectName(opts),
  });
  return { overlays: [...new Set([...fromFiles, ...preview])], gap: null };
}

/** The name the migration scopes store entries by: the config name, else the checkout directory. */
async function projectName(opts: {
  readonly root: string;
  readonly projectDir: string;
}): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(resolve(opts.projectDir, PROJECT_CONFIG_FILENAME), "utf8")
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "name" in parsed &&
      typeof parsed.name === "string" &&
      parsed.name.trim() !== ""
    ) {
      return parsed.name.trim();
    }
  } catch {
    // Fall back to the directory name, as the migration does.
  }
  return basename(opts.root);
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
