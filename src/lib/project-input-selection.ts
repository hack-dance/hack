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
import { assertLegacyComposeAdoptionSelectionStable } from "./native-compose-adoption-marker.ts";
import {
  attachValueFreeDiagnostic,
  readValueFreeDiagnostic,
  valueFreeErrorDiagnostic,
} from "./value-free-diagnostic.ts";

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

const DEFAULT_DIAGNOSTIC = "ProjectInputAccessError";

/**
 * Stable, value-free refusal when a project input's presence cannot be
 * checked (for example a file where `.dev` belongs, or a project directory the
 * caller cannot search). Only ENOENT means absence, so the guard refuses
 * rather than guessing. `access` classifies the fault without its OS message,
 * which carries the absolute path and is therefore never kept.
 *
 * The fault itself is kept only as a value-free diagnostic: the class name and
 * errno code of the underlying error (for example `Error:ENOTDIR`), never its
 * message or path. It is a non-enumerable own property rather than `cause`,
 * so envelopes, printed errors and serializers stay unchanged. Read it with
 * {@link projectInputAccessDiagnostic}.
 */
export class ProjectInputAccessError extends HackCliError {
  readonly access: "permission" | "unreadable";

  constructor(
    access: "permission" | "unreadable",
    diagnostic: string = DEFAULT_DIAGNOSTIC
  ) {
    super({
      code: "E_CONFIG_INVALID",
      message:
        "Cannot inspect Hack project inputs. Check filesystem permissions and paths before retrying. Values omitted.",
    });
    this.name = "ProjectInputAccessError";
    this.access = access;
    attachValueFreeDiagnostic({
      target: this,
      diagnostic,
      fallback: DEFAULT_DIAGNOSTIC,
    });
  }
}

/**
 * The value-free diagnostic of a {@link ProjectInputAccessError} (for example
 * `Error:EACCES`), for tests and debugging. Undefined for any other value.
 */
export function projectInputAccessDiagnostic(
  error: unknown
): string | undefined {
  return error instanceof ProjectInputAccessError
    ? readValueFreeDiagnostic(error)
    : undefined;
}

/**
 * The closed refusal for a fault other than ENOENT while checking whether a
 * project input exists: `permission` for `EACCES`/`EPERM`, `unreadable` for
 * any other fault, keeping only the fault's class/code diagnostic. Exported
 * as a seam so faults a fixture cannot produce (such as `EPERM`) stay tested.
 */
export function projectInputAccessFault(
  error: unknown
): ProjectInputAccessError {
  const code = isRecord(error) ? error.code : undefined;
  return new ProjectInputAccessError(
    code === "EACCES" || code === "EPERM" ? "permission" : "unreadable",
    valueFreeErrorDiagnostic(error)
  );
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
  const adoption = await assertLegacyComposeAdoptionSelectionStable({
    projectRoot,
  });
  const nativeFile = resolve(
    projectRoot,
    HACK_PROJECT_DIR_PRIMARY,
    NATIVE_PROJECT_FILENAME
  );
  const nativePresent =
    adoption === "active" || (await inputPresent(nativeFile));
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
  if ((await assertLegacyComposeAdoptionSelectionStable(opts)) === "active") {
    throw new ProjectInputSelectionError("native");
  }
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
    throw projectInputAccessFault(error);
  }
}
