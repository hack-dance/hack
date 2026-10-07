import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  HACK_PROJECT_DIR_LEGACY,
  HACK_PROJECT_DIR_PRIMARY,
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_LEGACY_FILENAME,
} from "../constants.ts";
import { HackCliError } from "./cli-result.ts";
import { pathExists } from "./fs.ts";
import { isRecord } from "./guards.ts";

export const NATIVE_PROJECT_FILENAME = "hack.project.json";
type ProjectDirName =
  | typeof HACK_PROJECT_DIR_PRIMARY
  | typeof HACK_PROJECT_DIR_LEGACY;
const PROJECT_DIRECTORIES = [
  HACK_PROJECT_DIR_PRIMARY,
  HACK_PROJECT_DIR_LEGACY,
] as const;
const LEGACY_FILES = [
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_LEGACY_FILENAME,
] as const;

export interface ProjectInputSelection {
  readonly kind: "none" | "legacy" | "native" | "conflict";
  readonly projectRoot: string;
  readonly nativeFile: string;
  readonly legacyFiles: readonly string[];
  readonly composeDirectories: readonly ProjectDirName[];
}

/** Stable refusal before native input can be interpreted by a legacy reader or writer. */
export class ProjectInputSelectionError extends HackCliError {
  override readonly code:
    | "E_NATIVE_PROJECT_CONFLICT"
    | "E_NATIVE_PROJECT_UNSUPPORTED";

  constructor(kind: "native" | "conflict") {
    const code =
      kind === "conflict"
        ? "E_NATIVE_PROJECT_CONFLICT"
        : "E_NATIVE_PROJECT_UNSUPPORTED";
    super({
      code,
      message:
        kind === "conflict"
          ? `${code}: Native hack.project.json and active legacy Hack inputs coexist. Reconcile them before using project commands; no input was changed.`
          : `${code}: Native hack.project.json marks this project. Runtime/adoption support is not available yet. Use explicit hack config validate --file for offline validation.`,
    });
    this.name = "ProjectInputSelectionError";
    this.code = code;
  }
}

/**
 * Inspect only the named root, without parsing, following authored-file links,
 * searching ancestors, touching registration, or normalizing configuration.
 * Any native marker is a boundary, including malformed/nonregular input. Only
 * ENOENT means absence; denied/invalid filesystem access cannot enable fallback.
 */
export async function inspectProjectInputsAtRoot(opts: {
  readonly projectRoot: string;
}): Promise<ProjectInputSelection> {
  const projectRoot = resolve(opts.projectRoot);
  const nativeFile = resolve(
    projectRoot,
    HACK_PROJECT_DIR_PRIMARY,
    NATIVE_PROJECT_FILENAME
  );
  const nativePresent = await inputPresent(nativeFile);
  const legacyFiles: string[] = [];
  const composeDirectories: ProjectDirName[] = [];
  for (const directory of PROJECT_DIRECTORIES) {
    for (const name of LEGACY_FILES) {
      const file = resolve(projectRoot, directory, name);
      if (await inputPresent(file)) {
        legacyFiles.push(file);
        // Presence still conflicts with native input, but legacy discovery keeps
        // its existing stat-based behavior for dangling Compose links.
        if (name === PROJECT_COMPOSE_FILENAME && (await pathExists(file))) {
          composeDirectories.push(directory);
        }
      }
    }
  }
  let kind: ProjectInputSelection["kind"] = "none";
  if (nativePresent) {
    kind = legacyFiles.length > 0 ? "conflict" : "native";
  } else if (legacyFiles.length > 0) {
    kind = "legacy";
  }
  return { kind, projectRoot, nativeFile, legacyFiles, composeDirectories };
}

/**
 * Preserve legacy .hack-before-.dev discovery, bounded by the first native
 * root. A nested legacy project may be selected below that boundary; discovery
 * never crosses it to select an ancestor Compose project instead.
 */
export async function discoverProjectInputs(opts: {
  readonly startDir: string;
}): Promise<ProjectInputSelection | null> {
  let current = resolve(opts.startDir);
  let nearestLegacy: ProjectInputSelection | null = null;
  while (true) {
    const selected = await inspectProjectInputsAtRoot({ projectRoot: current });
    if (selected.kind === "native" || selected.kind === "conflict") {
      return nearestLegacy ?? selected;
    }
    if (selected.composeDirectories.includes(HACK_PROJECT_DIR_PRIMARY)) {
      return selected;
    }
    if (
      !nearestLegacy &&
      selected.composeDirectories.includes(HACK_PROJECT_DIR_LEGACY)
    ) {
      nearestLegacy = selected;
    }
    const parent = dirname(current);
    if (parent === current) {
      return nearestLegacy;
    }
    current = parent;
  }
}

export function requireLegacyProjectInputs(
  selection: ProjectInputSelection
): void {
  if (selection.kind === "native" || selection.kind === "conflict") {
    throw new ProjectInputSelectionError(selection.kind);
  }
}

/** A read/write preflight, not an atomic fence against concurrent external edits. */
export async function assertLegacyProjectInputFamily(opts: {
  readonly projectRoot: string;
}): Promise<void> {
  // Legacy reads/writes need only one strict marker check on their common path.
  // Full authored-family classification is needed when the marker is present.
  if (
    !(await inputPresent(
      resolve(
        opts.projectRoot,
        HACK_PROJECT_DIR_PRIMARY,
        NATIVE_PROJECT_FILENAME
      )
    ))
  ) {
    return;
  }
  requireLegacyProjectInputs(await inspectProjectInputsAtRoot(opts));
}

/** Guard existing .hack/.dev directory-based owners without synthesizing native contexts. */
export async function assertLegacyProjectDirectory(opts: {
  readonly projectDir: string;
}): Promise<void> {
  await assertLegacyProjectInputFamily({
    projectRoot: dirname(resolve(opts.projectDir)),
  });
}

/** Stop init/discovery before it can choose an ancestor repository or start onboarding. */
export async function assertLegacyProjectDiscovery(opts: {
  readonly startDir: string;
}): Promise<void> {
  const selected = await discoverProjectInputs(opts);
  if (selected) {
    requireLegacyProjectInputs(selected);
  }
}

async function inputPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") {
      return false;
    }
    throw new Error(
      "Cannot inspect Hack project inputs. Check filesystem permissions and paths before retrying.",
      { cause: error }
    );
  }
}
