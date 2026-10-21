import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { YAML } from "bun";
import { PROJECT_COMPOSE_FILENAME } from "../constants.ts";
import { HACK_ERROR_CODES, type HackErrorCode } from "./cli-result.ts";
import { isRecord } from "./guards.ts";
import { exec } from "./shell.ts";
import {
  inspectTarget,
  parseTargetInspectEnvelope,
  TARGET_REFUSALS,
  type TargetInspectData,
  type TargetInspectEnvelope,
  type TargetSelector,
  targetRefusalEnvelope,
} from "./target-inspect.ts";
import {
  argvStrings,
  claimedProvenanceSource,
  isInlineCommandArgv,
  isKnownCapability,
  isSafeInputPath,
  missingCapabilities,
  parseTaskId,
  parseTaskRecipe,
  type ReviewedTaskRecipe,
  TASK_CATALOG_FILE_SCHEMA,
  TASK_ID_PATTERN,
  type TaskCapability,
  TRUSTED_PROVENANCE,
} from "./task-catalog-recipe.ts";

/**
 * Read-only task catalog shared by `hack project task list|inspect` and the
 * MCP `hack.project.task.list|inspect` tools (HACK-1157, WU26-CATALOG).
 *
 * The catalog lists a small set of reviewed recipes for existing repository
 * scripts, declared in `<project dir>/tasks.json`, against one exact target
 * resolved by the WU31 target inspector. For each recipe it reports either
 * the reviewed recipe (exact argv, service, workdir, env scope, required
 * capabilities, effects, prerequisites, checks, cleanup and pinned
 * provenance) or one closed refusal.
 *
 * Invariants:
 * - Reading or registering a recipe runs nothing. The only child processes
 *   are read-only Git queries: the target inspector's, and one
 *   `git ls-files` per pinned recipe to prove its pins are tracked files.
 *   There is no execution path and no shell endpoint: results say
 *   `execution: "unavailable"`.
 * - Results carry `authority: "none"`. Repository text (this file) and log
 *   text never grant execution authority; `reviewed` means the recipe's pins
 *   still match what a reviewer approved, not that anything may run.
 * - A refused recipe is reported by index, id and reason only. Its argv and
 *   text are never echoed, so an injected command is not handed back to a
 *   caller as runnable text.
 * - Ambiguous, stale, untrusted or out-of-scope recipes are refused; there is
 *   no fallback to a broader runner or scope.
 *
 * Contract status: PROVISIONAL until the AX compatibility review. See
 * docs/reference/ax-task-catalog.md.
 */

/** Catalog file name inside the project directory (usually `.hack`). */
export const TASK_CATALOG_FILENAME = "tasks.json" as const;

/** Provisional result schemas. */
export const TASK_LIST_SCHEMA = "hack.task.list.v0" as const;
export const TASK_INSPECT_SCHEMA = "hack.task.inspect.v0" as const;

/** Bounds; a larger catalog or input is refused, never truncated. */
const CATALOG_MAX_BYTES = 256 * 1024;
const MAX_TASKS = 64;
const INPUT_MAX_BYTES = 1024 * 1024;
const COMPOSE_MAX_BYTES = 4 * 1024 * 1024;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/** RFC 6901 array index token: `0` or a number without leading zeros. */
const ARRAY_INDEX_TOKEN = /^(0|[1-9][0-9]*)$/;

/** What a caller should do next. Advice only; it grants no authority. */
export type TaskRetry = "fix_selector" | "fix_catalog" | "review" | "reinspect";

type RefusalSpec = {
  readonly code: HackErrorCode;
  readonly retry: TaskRetry;
  readonly message: string;
};

/**
 * Whole-catalog refusals. Messages are fixed, value-free text: they never
 * repeat a task id, path, argv or catalog value.
 */
export const TASK_CATALOG_REFUSALS = Object.freeze({
  invalid_task_id: {
    code: "E_USAGE",
    retry: "fix_selector",
    message:
      "Invalid task id. Use lowercase letters, digits, '.', '_' or '-', starting with a letter or digit.",
  },
  task_not_found: {
    code: "E_USAGE",
    retry: "fix_selector",
    message:
      "No recipe with that id in the project's task catalog. Run 'hack project task list' to see recipes.",
  },
  catalog_parse_failed: {
    code: "E_CONFIG_PARSE",
    retry: "fix_catalog",
    message: "The project's task catalog is not valid JSON.",
  },
  catalog_invalid: {
    code: "E_CONFIG_INVALID",
    retry: "fix_catalog",
    message:
      "The project's task catalog does not match the provisional catalog schema.",
  },
  catalog_too_large: {
    code: "E_CONFIG_INVALID",
    retry: "fix_catalog",
    message: "The project's task catalog exceeds the catalog size bound.",
  },
  catalog_changed_during_read: {
    code: "E_USAGE",
    retry: "reinspect",
    message:
      "The task catalog changed while it was being read. List the tasks again.",
  },
} as const satisfies Record<string, RefusalSpec>);

export type TaskCatalogRefusalReason = keyof typeof TASK_CATALOG_REFUSALS;

/**
 * Per-recipe refusals, in the order they are checked. A refused recipe can
 * never be executed through the catalog.
 */
export const TASK_RECIPE_REFUSALS = Object.freeze({
  recipe_invalid: {
    code: "E_CONFIG_INVALID",
    retry: "fix_catalog",
    message:
      "The task recipe does not match the provisional recipe schema or declares inconsistent effects.",
  },
  ambiguous_task: {
    code: "E_CONFIG_INVALID",
    retry: "fix_catalog",
    message:
      "More than one recipe in the catalog uses this task id. No recipe with this id is reviewed.",
  },
  untrusted_provenance: {
    code: "E_CONFIG_INVALID",
    retry: "fix_catalog",
    message:
      "The task recipe does not come from a reviewed repository script. Log, suggested or generated commands are never catalog tasks.",
  },
  inline_command: {
    code: "E_CONFIG_INVALID",
    retry: "fix_catalog",
    message:
      "The task argv evaluates inline code or shell syntax. Recipes must run a reviewed script with exact arguments.",
  },
  unapproved_host_profile: {
    code: "E_CONFIG_INVALID",
    retry: "fix_catalog",
    message:
      "The task recipe needs a host profile that is not approved. No host profile can be enforced in this release.",
  },
  missing_capability: {
    code: "E_CONFIG_INVALID",
    retry: "fix_catalog",
    message:
      "The task recipe requires a capability its runner does not grant. There is no fallback to a broader runner.",
  },
  env_scope_mismatch: {
    code: "E_USAGE",
    retry: "fix_selector",
    message:
      "The selected env overlay differs from the env scope the recipe was reviewed for. Select the recipe's env scope explicitly.",
  },
  service_not_found: {
    code: "E_SERVICE_NOT_FOUND",
    retry: "fix_catalog",
    message:
      "The task recipe names a service that is not declared in the target's Compose file.",
  },
  input_path_invalid: {
    code: "E_CONFIG_INVALID",
    retry: "fix_catalog",
    message:
      "A pinned task input is not a Git-tracked regular file inside the checkout, or exceeds the input size bound.",
  },
  input_missing: {
    code: "E_CONFIG_INVALID",
    retry: "review",
    message:
      "A pinned task input is absent from the checkout, or its pinned JSON value no longer exists.",
  },
  stale_recipe: {
    code: "E_CONFIG_INVALID",
    retry: "review",
    message:
      "The script or service definition behind this recipe changed since review. Review the change and update the recipe's pins.",
  },
} as const satisfies Record<string, RefusalSpec>);

export type TaskRecipeRefusalReason = keyof typeof TASK_RECIPE_REFUSALS;

/** Observed digests for a stale recipe; digests only, never content. */
export type TaskStaleDetail = {
  /** Mismatched inputs, by their index in `provenance.inputs`. */
  readonly inputs: readonly {
    readonly index: number;
    readonly observed_sha256: string;
  }[];
  /** Observed service definition digest when it no longer matches. */
  readonly definition_sha256: string | null;
};

export type TaskRecipeRefusalDetail = {
  readonly reason: TaskRecipeRefusalReason;
  readonly stage: "recipe";
  readonly retry: TaskRetry;
  readonly provisional: true;
  /** Present only for `missing_capability`. */
  readonly missing_capabilities?: readonly TaskCapability[];
  /** Present only for `missing_capability`: unknown tokens, counted. */
  readonly unknown_capabilities?: number;
  /** Present only for `stale_recipe`. */
  readonly stale?: TaskStaleDetail;
};

export type TaskCatalogRefusalDetail = {
  readonly reason: TaskCatalogRefusalReason;
  readonly stage: "catalog";
  readonly retry: TaskRetry;
  readonly provisional: true;
};

export type TaskCatalogInfo = {
  readonly file: typeof TASK_CATALOG_FILENAME;
  readonly present: boolean;
  /** Digest of the catalog bytes that were read; null when absent. */
  readonly sha256: string | null;
};

export type TaskEntry =
  | {
      readonly index: number;
      readonly id: string;
      readonly status: "reviewed";
      readonly recipe: ReviewedTaskRecipe;
    }
  | {
      readonly index: number;
      /** null when the entry has no valid id. */
      readonly id: string | null;
      readonly status: "refused";
      readonly refusal: TaskRecipeRefusalDetail;
    };

type TaskResultBase = {
  readonly provisional: true;
  readonly observed_at: string;
  /** The catalog identifies reviewed scope only; it never authorizes a run. */
  readonly authority: "none";
  /** No execution path exists in this release (WU26 owns execution). */
  readonly execution: "unavailable";
  readonly target: TargetInspectData;
  readonly catalog: TaskCatalogInfo;
};

export type TaskListData = TaskResultBase & {
  readonly schema: typeof TASK_LIST_SCHEMA;
  readonly tasks: readonly TaskEntry[];
};

export type TaskInspectData = TaskResultBase & {
  readonly schema: typeof TASK_INSPECT_SCHEMA;
  readonly task: ReviewedTaskRecipe;
};

type TaskErrorEnvelope = {
  readonly ok: false;
  readonly error: {
    readonly code: HackErrorCode;
    readonly message: string;
    readonly detail?: unknown;
  };
};

export type TaskListEnvelope =
  | { readonly ok: true; readonly data: TaskListData }
  | TaskErrorEnvelope;

export type TaskInspectEnvelope =
  | { readonly ok: true; readonly data: TaskInspectData }
  | TaskErrorEnvelope;

/** Target selection for the catalog: the target inspector's, minus service. */
export type TaskTargetSelector = Omit<TargetSelector, "service">;

class CatalogRefusal extends Error {
  readonly reason: TaskCatalogRefusalReason;

  constructor(reason: TaskCatalogRefusalReason) {
    super(TASK_CATALOG_REFUSALS[reason].message);
    this.reason = reason;
  }
}

/** Closed envelope for one whole-catalog refusal. */
export function taskCatalogRefusalEnvelope(
  reason: TaskCatalogRefusalReason
): TaskErrorEnvelope {
  const spec = TASK_CATALOG_REFUSALS[reason];
  return {
    ok: false,
    error: {
      code: spec.code,
      message: spec.message,
      detail: {
        reason,
        stage: "catalog",
        retry: spec.retry,
        provisional: true,
      } satisfies TaskCatalogRefusalDetail,
    },
  };
}

/** Closed envelope for inspecting one refused recipe. */
export function taskRecipeRefusalEnvelope(
  detail: TaskRecipeRefusalDetail
): TaskErrorEnvelope {
  const spec = TASK_RECIPE_REFUSALS[detail.reason];
  return {
    ok: false,
    error: { code: spec.code, message: spec.message, detail },
  };
}

function recipeRefusal(
  reason: TaskRecipeRefusalReason,
  extra: Partial<
    Pick<
      TaskRecipeRefusalDetail,
      "missing_capabilities" | "unknown_capabilities" | "stale"
    >
  > = {}
): TaskRecipeRefusalDetail {
  return {
    reason,
    stage: "recipe",
    retry: TASK_RECIPE_REFUSALS[reason].retry,
    provisional: true,
    ...extra,
  };
}

type CatalogSnapshot = {
  readonly target: TargetInspectData;
  readonly catalog: TaskCatalogInfo;
  readonly tasks: readonly TaskEntry[];
};

type CatalogOptions = {
  readonly cwd: string;
  readonly selector: TaskTargetSelector;
  readonly registryPath?: string;
  readonly now?: () => Date;
  /**
   * Test seam: runs after every recipe was evaluated and before the catalog
   * and target generation are re-read. Production callers never pass it.
   */
  readonly afterEvaluate?: () => Promise<void>;
};

/** List every recipe in the selected target's catalog with its status. */
export async function listTasks(
  opts: CatalogOptions
): Promise<TaskListEnvelope> {
  const snapshot = await readCatalogSnapshot(opts);
  if (!snapshot.ok) {
    return snapshot.envelope;
  }
  const { target, catalog, tasks } = snapshot.value;
  return {
    ok: true,
    data: {
      schema: TASK_LIST_SCHEMA,
      ...resultBase({ opts, target, catalog }),
      tasks,
    },
  };
}

/**
 * Inspect one recipe. A reviewed recipe is returned in full; a refused one
 * is the closed refusal for its reason (its argv is never echoed).
 */
export async function inspectTask(
  opts: CatalogOptions & { readonly taskId: string }
): Promise<TaskInspectEnvelope> {
  if (!TASK_ID_PATTERN.test(opts.taskId)) {
    return taskCatalogRefusalEnvelope("invalid_task_id");
  }
  const snapshot = await readCatalogSnapshot(opts);
  if (!snapshot.ok) {
    return snapshot.envelope;
  }
  const { target, catalog, tasks } = snapshot.value;
  const matches = tasks.filter((entry) => entry.id === opts.taskId);
  const [entry] = matches;
  if (entry === undefined) {
    return taskCatalogRefusalEnvelope("task_not_found");
  }
  if (entry.status === "refused") {
    return taskRecipeRefusalEnvelope(entry.refusal);
  }
  return {
    ok: true,
    data: {
      schema: TASK_INSPECT_SCHEMA,
      ...resultBase({ opts, target, catalog }),
      task: entry.recipe,
    },
  };
}

function resultBase(input: {
  readonly opts: CatalogOptions;
  readonly target: TargetInspectData;
  readonly catalog: TaskCatalogInfo;
}): TaskResultBase {
  const now = input.opts.now ?? (() => new Date());
  return {
    provisional: true,
    observed_at: now().toISOString(),
    authority: "none",
    execution: "unavailable",
    target: input.target,
    catalog: input.catalog,
  };
}

type SnapshotResult =
  | { readonly ok: true; readonly value: CatalogSnapshot }
  | { readonly ok: false; readonly envelope: TaskErrorEnvelope };

async function readCatalogSnapshot(
  opts: CatalogOptions
): Promise<SnapshotResult> {
  const selector = withoutService(opts.selector);
  const resolved = await inspectTarget({
    cwd: opts.cwd,
    selector,
    ...(opts.registryPath === undefined
      ? {}
      : { registryPath: opts.registryPath }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  if (!resolved.ok) {
    return { ok: false, envelope: resolved };
  }
  const target = resolved.data;
  try {
    const before = await readCatalogBytes(target.project.project_dir);
    const catalog = catalogInfo(before);
    const tasks =
      before === null ? [] : await evaluateCatalog({ bytes: before, target });
    await opts.afterEvaluate?.();
    const after = await readCatalogBytes(target.project.project_dir);
    if (catalogInfo(after).sha256 !== catalog.sha256) {
      throw new CatalogRefusal("catalog_changed_during_read");
    }
    // The recipes were judged against this generation's Compose services
    // and env selection; refuse a result that straddles a config change.
    const recheck = await inspectTarget({
      cwd: opts.cwd,
      selector: { ...selector, expectGeneration: target.generation.id },
      ...(opts.registryPath === undefined
        ? {}
        : { registryPath: opts.registryPath }),
    });
    if (!recheck.ok) {
      return {
        ok: false,
        envelope: generationChangedEnvelope(),
      };
    }
    return { ok: true, value: { target, catalog, tasks } };
  } catch (error: unknown) {
    if (error instanceof CatalogRefusal) {
      return { ok: false, envelope: taskCatalogRefusalEnvelope(error.reason) };
    }
    throw error;
  }
}

/**
 * The target contract's refusal for a target that moved mid-read: any
 * failure of the post-evaluation recheck means the recipes were judged
 * against a generation that no longer holds.
 */
function generationChangedEnvelope(): TaskErrorEnvelope {
  const envelope = targetRefusalEnvelope({
    reason: "generation_changed_during_read",
  });
  if (envelope.ok) {
    throw new Error("A target refusal envelope must not be ok.");
  }
  return envelope;
}

function withoutService(selector: TaskTargetSelector): TargetSelector {
  return {
    ...(selector.project === undefined ? {} : { project: selector.project }),
    ...(selector.path === undefined ? {} : { path: selector.path }),
    ...(selector.branch === undefined ? {} : { branch: selector.branch }),
    ...(selector.env === undefined ? {} : { env: selector.env }),
    ...(selector.expectGeneration === undefined
      ? {}
      : { expectGeneration: selector.expectGeneration }),
  };
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function catalogInfo(bytes: Uint8Array | null): TaskCatalogInfo {
  return {
    file: TASK_CATALOG_FILENAME,
    present: bytes !== null,
    sha256: bytes === null ? null : sha256Hex(bytes),
  };
}

async function readCatalogBytes(
  projectDir: string
): Promise<Uint8Array | null> {
  const path = resolve(projectDir, TASK_CATALOG_FILENAME);
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error: unknown) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  if (!info.isFile()) {
    // A symlinked or special catalog is not repository text we can bind.
    throw new CatalogRefusal("catalog_invalid");
  }
  if (info.size > CATALOG_MAX_BYTES) {
    throw new CatalogRefusal("catalog_too_large");
  }
  const bytes = await readFile(path);
  if (bytes.byteLength > CATALOG_MAX_BYTES) {
    throw new CatalogRefusal("catalog_too_large");
  }
  return bytes;
}

function parseCatalogEntries(bytes: Uint8Array): readonly unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
  } catch {
    throw new CatalogRefusal("catalog_parse_failed");
  }
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).some((key) => key !== "schema" && key !== "tasks") ||
    parsed.schema !== TASK_CATALOG_FILE_SCHEMA ||
    !Array.isArray(parsed.tasks) ||
    parsed.tasks.length > MAX_TASKS
  ) {
    throw new CatalogRefusal("catalog_invalid");
  }
  return parsed.tasks;
}

async function evaluateCatalog(input: {
  readonly bytes: Uint8Array;
  readonly target: TargetInspectData;
}): Promise<TaskEntry[]> {
  const entries = parseCatalogEntries(input.bytes);
  const ids = entries.map((entry) =>
    isRecord(entry) ? parseTaskId(entry.id) : null
  );
  const duplicates = new Set(
    ids.filter(
      (id, index): id is string => id !== null && ids.indexOf(id) !== index
    )
  );
  const definitions = await readServiceDefinitions(input.target);
  const root = await realpath(input.target.checkout.root);
  const out: TaskEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    const id = ids[index] ?? null;
    if (id === null || duplicates.has(id)) {
      const reason = id === null ? "recipe_invalid" : "ambiguous_task";
      out.push({
        index,
        id,
        status: "refused",
        refusal: recipeRefusal(reason),
      });
      continue;
    }
    const verdict = await evaluateRecipe({
      entry,
      target: input.target,
      definitions,
      root,
    });
    out.push(
      "recipe" in verdict
        ? {
            index,
            id: verdict.recipe.id,
            status: "reviewed",
            recipe: verdict.recipe,
          }
        : { index, id, status: "refused", refusal: verdict.refusal }
    );
  }
  return out;
}

type Verdict =
  | { readonly recipe: ReviewedTaskRecipe }
  | { readonly refusal: TaskRecipeRefusalDetail };

async function evaluateRecipe(input: {
  readonly entry: unknown;
  readonly target: TargetInspectData;
  readonly definitions: Readonly<Record<string, unknown>>;
  readonly root: string;
}): Promise<Verdict> {
  const classified = classifyRecipe(input.entry);
  if (!("recipe" in classified)) {
    return classified;
  }
  const recipe = classified.recipe;
  if (recipe.env.overlay !== input.target.env.overlay) {
    return { refusal: recipeRefusal("env_scope_mismatch") };
  }
  const definition = input.definitions[recipe.runner.service];
  if (definition === undefined) {
    return { refusal: recipeRefusal("service_not_found") };
  }
  const pins = await checkPins({ recipe, definition, root: input.root });
  return pins === null ? { recipe } : { refusal: pins };
}

/**
 * Target-independent checks, in refusal order: claimed provenance, inline
 * code in argv, recipe shape, runner kind, then capabilities. Shared with
 * the adapters' result validation, so a result can never carry a recipe
 * these checks would refuse.
 */
function classifyRecipe(entry: unknown): Verdict {
  const claimed = claimedProvenanceSource(entry);
  if (claimed !== null && claimed !== TRUSTED_PROVENANCE) {
    return { refusal: recipeRefusal("untrusted_provenance") };
  }
  const argv = argvStrings(entry);
  if (argv !== null && isInlineCommandArgv(argv)) {
    return { refusal: recipeRefusal("inline_command") };
  }
  const recipe = parseTaskRecipe(entry);
  if (recipe === null) {
    return { refusal: recipeRefusal("recipe_invalid") };
  }
  if (recipe.runner.kind === "host") {
    // No host profile is approved in this release: Hack cannot enforce a
    // host boundary yet, so a host recipe never falls back to running
    // unconfined. Refused before any capability check.
    return { refusal: recipeRefusal("unapproved_host_profile") };
  }
  const missing = missingCapabilities(recipe.requires);
  if (missing.known.length > 0 || missing.unknown > 0) {
    return {
      refusal: recipeRefusal("missing_capability", {
        missing_capabilities: missing.known,
        unknown_capabilities: missing.unknown,
      }),
    };
  }
  return { recipe: { ...recipe, runner: recipe.runner } };
}

/**
 * Compare every pinned input and the service definition with the checkout.
 * Returns null when all pins match, else the first path/missing refusal or
 * a `stale_recipe` refusal listing every mismatched digest.
 */
async function checkPins(input: {
  readonly recipe: ReviewedTaskRecipe;
  readonly definition: unknown;
  readonly root: string;
}): Promise<TaskRecipeRefusalDetail | null> {
  const files: PinnedFile[] = [];
  for (const pin of input.recipe.provenance.inputs) {
    const file = await resolvePinnedFile({ root: input.root, path: pin.path });
    if (file === "invalid") {
      return recipeRefusal("input_path_invalid");
    }
    if (file === "missing") {
      return recipeRefusal("input_missing");
    }
    files.push(file);
  }
  // Checked before any pinned byte is read: an untracked file (a gitignored
  // secrets file, a local credential) is never hashed.
  if (
    !(await allTrackedByGit({
      root: input.root,
      paths: files.map((file) => file.relative),
    }))
  ) {
    return recipeRefusal("input_path_invalid");
  }
  const observedInputs: { index: number; observed_sha256: string }[] = [];
  for (const [index, pin] of input.recipe.provenance.inputs.entries()) {
    const file = files[index];
    const observed =
      file === undefined
        ? "invalid"
        : await readPinnedDigest({ file, pointer: pin.pointer });
    if (observed === "invalid") {
      return recipeRefusal("input_path_invalid");
    }
    if (observed === "missing") {
      return recipeRefusal("input_missing");
    }
    if (observed !== pin.sha256) {
      observedInputs.push({ index, observed_sha256: observed });
    }
  }
  const observedDefinition = serviceDefinitionDigest(input.definition);
  const definitionStale =
    observedDefinition !== input.recipe.runner.definition_sha256;
  if (observedInputs.length === 0 && !definitionStale) {
    return null;
  }
  return recipeRefusal("stale_recipe", {
    stale: {
      inputs: observedInputs,
      definition_sha256: definitionStale ? observedDefinition : null,
    },
  });
}

/**
 * Service definitions from the target's Compose file. The target inspector
 * already refused a Compose file that is not a YAML mapping with a mapping
 * of services, and bounded its size; the generation recheck after
 * evaluation refuses a file that changed in between.
 */
async function readServiceDefinitions(
  target: TargetInspectData
): Promise<Readonly<Record<string, unknown>>> {
  const path = resolve(target.project.project_dir, PROJECT_COMPOSE_FILENAME);
  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > COMPOSE_MAX_BYTES) {
      return {};
    }
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isMissing(error)) {
      return {};
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    return {};
  }
  if (!(isRecord(parsed) && isRecord(parsed.services))) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(parsed.services)) {
    out[name] = definition ?? null;
  }
  return out;
}

/** A pinned input that passed the path checks. */
type PinnedFile = {
  /** Absolute path as the pin names it. */
  readonly absolute: string;
  /** Checkout-relative POSIX path with directory symlinks resolved. */
  readonly relative: string;
};

/**
 * Resolve one pin without reading its content. The file must be a regular
 * file (not a symlink) within the input size bound, and its path with every
 * directory symlink resolved must itself be a safe input path: inside the
 * checkout (`root` is already real), and not an alias for `.git`, Hack's
 * machine-local state or a secret file reached through a symlinked
 * directory.
 */
async function resolvePinnedFile(input: {
  readonly root: string;
  readonly path: string;
}): Promise<PinnedFile | "invalid" | "missing"> {
  const path = resolve(input.root, input.path);
  let parent: string;
  try {
    parent = await realpath(dirname(path));
  } catch (error: unknown) {
    if (isMissing(error)) {
      return "missing";
    }
    throw error;
  }
  const resolved = relative(input.root, join(parent, basename(path)));
  const posix = resolved.split(sep).join("/");
  if (isAbsolute(resolved) || !isSafeInputPath(posix)) {
    return "invalid";
  }
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(path);
  } catch (error: unknown) {
    if (isMissing(error)) {
      return "missing";
    }
    throw error;
  }
  if (!info.isFile() || info.size > INPUT_MAX_BYTES) {
    return "invalid";
  }
  return { absolute: path, relative: posix };
}

/**
 * True when every path (checkout-relative, POSIX, case as given) is tracked
 * in the Git index of the checkout at `root`. A checkout without Git, a
 * failed query or any untracked path gives false, so the caller refuses.
 *
 * Why: a stale refusal reports each pin's observed digest, and the lexical
 * path rules cannot name every local secret file (`.npmrc`, `.netrc`,
 * `secrets.json`, ...). A tracked file's content is already shared with
 * everyone who has the repository. One read-only `git ls-files` with literal
 * pathspecs runs per recipe; fsmonitor is disabled so no repository-
 * configured hook can run.
 */
async function allTrackedByGit(input: {
  readonly root: string;
  readonly paths: readonly string[];
}): Promise<boolean> {
  if (input.paths.length === 0) {
    return true;
  }
  let result: Awaited<ReturnType<typeof exec>>;
  try {
    result = await exec(
      [
        "git",
        "--literal-pathspecs",
        "-C",
        input.root,
        "-c",
        "core.fsmonitor=false",
        "ls-files",
        "-z",
        "--cached",
        "--",
        ...input.paths,
      ],
      { stdin: "ignore" }
    );
  } catch {
    return false;
  }
  if (result.exitCode !== 0) {
    return false;
  }
  const tracked = new Set(result.stdout.split("\0"));
  return input.paths.every((path) => tracked.has(path));
}

/**
 * Digest of one resolved pin: the whole file's bytes, or the canonical JSON
 * of the value an RFC 6901 pointer selects.
 */
async function readPinnedDigest(input: {
  readonly file: PinnedFile;
  readonly pointer: string | null;
}): Promise<string | "invalid" | "missing"> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(input.file.absolute);
  } catch (error: unknown) {
    if (isMissing(error)) {
      return "missing";
    }
    throw error;
  }
  if (bytes.byteLength > INPUT_MAX_BYTES) {
    return "invalid";
  }
  if (input.pointer === null) {
    return sha256Hex(bytes);
  }
  let document: unknown;
  try {
    document = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
  } catch {
    return "missing";
  }
  const selected = resolvePointer(document, input.pointer);
  return selected === undefined
    ? "missing"
    : sha256Hex(canonicalJson(selected));
}

/** RFC 6901 lookup; undefined when any token does not resolve. */
export function resolvePointer(document: unknown, pointer: string): unknown {
  if (pointer === "") {
    return document;
  }
  let current: unknown = document;
  for (const raw of pointer.slice(1).split("/")) {
    const token = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX_TOKEN.test(token)) {
        return undefined;
      }
      current = current[Number(token)];
    } else if (isRecord(current) && Object.hasOwn(current, token)) {
      current = current[token];
    } else {
      return undefined;
    }
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

/**
 * Canonical JSON: object keys sorted by code unit, no whitespace. Used for
 * service-definition and pointer digests so formatting and key order in the
 * source file do not change a pin.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  if (value === undefined) {
    return "null";
  }
  return JSON.stringify(value) ?? "null";
}

/** Digest a reviewer pins for a Compose service definition. */
export function serviceDefinitionDigest(definition: unknown): string {
  return sha256Hex(canonicalJson(definition ?? null));
}

function isMissing(error: unknown): boolean {
  return (
    isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

// ---------------------------------------------------------------------------
// Envelope validation shared by adapters. The MCP tools re-validate the CLI's
// stdout through these, so a drifted or foreign payload is never passed on.
// ---------------------------------------------------------------------------

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(HACK_ERROR_CODES);

/** Parse a `hack project task list --json` envelope, or null off contract. */
export function parseTaskListEnvelope(value: unknown): TaskListEnvelope | null {
  if (isRecord(value) && value.ok === true) {
    const base = parseResultBase(value.data, TASK_LIST_SCHEMA);
    if (base === null || !isRecord(value.data)) {
      return null;
    }
    const tasks = parseEntries(value.data.tasks);
    return tasks === null
      ? null
      : { ok: true, data: { ...base, schema: TASK_LIST_SCHEMA, tasks } };
  }
  return parseErrorEnvelope(value);
}

/** Parse a `hack project task inspect --json` envelope, or null. */
export function parseTaskInspectEnvelope(
  value: unknown
): TaskInspectEnvelope | null {
  if (isRecord(value) && value.ok === true) {
    const base = parseResultBase(value.data, TASK_INSPECT_SCHEMA);
    if (base === null || !isRecord(value.data)) {
      return null;
    }
    const task = parseReviewedRecipe(value.data.task);
    return task === null
      ? null
      : { ok: true, data: { ...base, schema: TASK_INSPECT_SCHEMA, task } };
  }
  return parseErrorEnvelope(value);
}

function parseResultBase(
  value: unknown,
  schema: string
): TaskResultBase | null {
  if (
    !isRecord(value) ||
    value.schema !== schema ||
    value.provisional !== true ||
    value.authority !== "none" ||
    value.execution !== "unavailable" ||
    typeof value.observed_at !== "string"
  ) {
    return null;
  }
  const target = parseTargetInspectEnvelope({ ok: true, data: value.target });
  const catalog = parseCatalogInfo(value.catalog);
  if (target === null || !target.ok || catalog === null) {
    return null;
  }
  return {
    provisional: true,
    observed_at: value.observed_at,
    authority: "none",
    execution: "unavailable",
    target: target.data,
    catalog,
  };
}

function parseCatalogInfo(value: unknown): TaskCatalogInfo | null {
  if (
    !isRecord(value) ||
    value.file !== TASK_CATALOG_FILENAME ||
    typeof value.present !== "boolean"
  ) {
    return null;
  }
  const digest = value.sha256;
  const valid = value.present
    ? typeof digest === "string" && SHA256_PATTERN.test(digest)
    : digest === null;
  if (!valid) {
    return null;
  }
  return {
    file: TASK_CATALOG_FILENAME,
    present: value.present,
    sha256: digest as string | null,
  };
}

/**
 * A reviewed recipe in a result: the catalog grammar, plus the rule that
 * only compose-service runners are ever reviewed.
 */
function parseReviewedRecipe(value: unknown): ReviewedTaskRecipe | null {
  const verdict = classifyRecipe(value);
  return "recipe" in verdict ? verdict.recipe : null;
}

function parseEntries(value: unknown): TaskEntry[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: TaskEntry[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      typeof entry.index !== "number" ||
      !Number.isInteger(entry.index) ||
      entry.index < 0
    ) {
      return null;
    }
    if (entry.status === "reviewed") {
      const recipe = parseReviewedRecipe(entry.recipe);
      if (recipe === null || entry.id !== recipe.id) {
        return null;
      }
      out.push({
        index: entry.index,
        id: recipe.id,
        status: "reviewed",
        recipe,
      });
      continue;
    }
    const id = entry.id === null ? null : parseTaskId(entry.id);
    const refusal = parseRecipeRefusalDetail(entry.refusal);
    if (
      entry.status !== "refused" ||
      (entry.id !== null && id === null) ||
      refusal === null
    ) {
      return null;
    }
    out.push({ index: entry.index, id, status: "refused", refusal });
  }
  return out;
}

function parseRecipeRefusalDetail(
  value: unknown
): TaskRecipeRefusalDetail | null {
  if (
    !isRecord(value) ||
    value.provisional !== true ||
    value.stage !== "recipe" ||
    typeof value.reason !== "string" ||
    !Object.hasOwn(TASK_RECIPE_REFUSALS, value.reason)
  ) {
    return null;
  }
  const reason = value.reason as TaskRecipeRefusalReason;
  if (value.retry !== TASK_RECIPE_REFUSALS[reason].retry) {
    return null;
  }
  const allowed = new Set(["reason", "stage", "retry", "provisional"]);
  if (reason === "missing_capability") {
    allowed.add("missing_capabilities");
    allowed.add("unknown_capabilities");
  }
  if (reason === "stale_recipe") {
    allowed.add("stale");
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return null;
  }
  if (reason === "missing_capability") {
    const known = value.missing_capabilities;
    const unknown = value.unknown_capabilities;
    if (
      !(
        Array.isArray(known) &&
        known.every(
          (token): token is TaskCapability =>
            typeof token === "string" && isKnownCapability(token)
        )
      ) ||
      typeof unknown !== "number" ||
      !Number.isInteger(unknown) ||
      unknown < 0
    ) {
      return null;
    }
    return recipeRefusal(reason, {
      missing_capabilities: known,
      unknown_capabilities: unknown,
    });
  }
  if (reason === "stale_recipe") {
    const stale = parseStaleDetail(value.stale);
    return stale === null ? null : recipeRefusal(reason, { stale });
  }
  return recipeRefusal(reason);
}

function parseStaleDetail(value: unknown): TaskStaleDetail | null {
  if (!(isRecord(value) && Array.isArray(value.inputs))) {
    return null;
  }
  const definition = value.definition_sha256;
  if (
    !(
      definition === null ||
      (typeof definition === "string" && SHA256_PATTERN.test(definition))
    )
  ) {
    return null;
  }
  const inputs: { index: number; observed_sha256: string }[] = [];
  for (const entry of value.inputs) {
    if (
      !isRecord(entry) ||
      typeof entry.index !== "number" ||
      !Number.isInteger(entry.index) ||
      entry.index < 0 ||
      typeof entry.observed_sha256 !== "string" ||
      !SHA256_PATTERN.test(entry.observed_sha256)
    ) {
      return null;
    }
    inputs.push({ index: entry.index, observed_sha256: entry.observed_sha256 });
  }
  return { inputs, definition_sha256: definition };
}

/**
 * Error envelopes: a target refusal (validated by the target contract), a
 * catalog or recipe refusal (validated here), or a known code without detail
 * (the CLI's shared option-grammar refusals).
 */
function parseErrorEnvelope(value: unknown): TaskErrorEnvelope | null {
  if (!isRecord(value) || value.ok !== false || !isRecord(value.error)) {
    return null;
  }
  const { code, message, detail } = value.error;
  if (
    typeof code !== "string" ||
    !KNOWN_ERROR_CODES.has(code) ||
    typeof message !== "string"
  ) {
    return null;
  }
  const errorCode = code as HackErrorCode;
  if (detail === undefined) {
    return { ok: false, error: { code: errorCode, message } };
  }
  if (!isRecord(detail) || typeof detail.reason !== "string") {
    return null;
  }
  let expected: TaskErrorEnvelope | null = null;
  if (detail.stage === "catalog") {
    expected = parseCatalogRefusalDetail(detail);
  } else if (detail.stage === "recipe") {
    const parsed = parseRecipeRefusalDetail(detail);
    expected = parsed === null ? null : taskRecipeRefusalEnvelope(parsed);
  } else if (Object.hasOwn(TARGET_REFUSALS, detail.reason)) {
    const target: TargetInspectEnvelope | null =
      parseTargetInspectEnvelope(value);
    expected = target !== null && !target.ok ? target : null;
  }
  return expected !== null &&
    expected.error.code === errorCode &&
    expected.error.message === message
    ? expected
    : null;
}

/** The closed envelope a catalog-stage detail must belong to, or null. */
function parseCatalogRefusalDetail(
  detail: Record<string, unknown>
): TaskErrorEnvelope | null {
  const reason = detail.reason;
  if (
    typeof reason !== "string" ||
    !Object.hasOwn(TASK_CATALOG_REFUSALS, reason) ||
    detail.provisional !== true ||
    Object.keys(detail).some(
      (key) => !["reason", "stage", "retry", "provisional"].includes(key)
    )
  ) {
    return null;
  }
  const typed = reason as TaskCatalogRefusalReason;
  return detail.retry === TASK_CATALOG_REFUSALS[typed].retry
    ? taskCatalogRefusalEnvelope(typed)
    : null;
}
