import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { YAML } from "bun";
import {
  PROJECT_COMPOSE_FILENAME,
  PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_LEGACY_FILENAME,
} from "../constants.ts";
import { resolveEffectiveBranch } from "./branches.ts";
import { HACK_ERROR_CODES, type HackErrorCode } from "./cli-result.ts";
import {
  branchComposeProjectName,
  resolveComposeProjectName,
} from "./compose-project-name.ts";
import {
  isLinkedGitWorktree,
  resolveGitCurrentBranch,
} from "./git-worktree.ts";
import { isRecord } from "./guards.ts";
import { LegacyComposeAdoptionSelectionError } from "./native-compose-adoption-marker.ts";
import {
  defaultProjectSlugFromPath,
  findProjectContext,
  findProjectContextAtRoot,
  type ProjectContext,
  parseEnvConfigSelection,
  readProjectConfig,
  readProjectDefaultEnvConfig,
  resolveWorktreeAutoBranch,
  sanitizeBranchSlug,
  sanitizeProjectSlug,
} from "./project.ts";
import {
  ProjectInputAccessError,
  ProjectInputSelectionError,
} from "./project-input-selection.ts";
import {
  AmbiguousProjectNameError,
  normalizeProjectName,
  PROJECT_SELECTOR_PATTERN,
} from "./project-name.ts";
import {
  AmbiguousProjectIdError,
  type RegisteredProject,
  readProjectsRegistry,
  selectRegisteredProjectByName,
} from "./projects-registry.ts";

/**
 * Read-only target inspector shared by `hack project target` and the MCP
 * `hack.project.target` tool (HACK-1144 / WU31).
 *
 * The inspector resolves one exact target (project, checkout, runtime
 * instance, optional service, env overlay selection and a config generation)
 * from local files only. It never starts, repairs, registers or touches
 * anything: no registry write, no Docker/engine call, no Git mutation. The
 * only child processes are read-only `git rev-parse`/`git branch
 * --show-current` lookups that existing project commands already run.
 *
 * Contract status: every schema name, field, reason and retry value here is
 * PROVISIONAL until the AX compatibility review. See
 * docs/reference/ax-target-result-contract.md.
 *
 * A resolved target is a reference: it identifies scope and grants no
 * authority. Callers that act on it must revalidate at their own effect
 * boundary (for example by passing `expectGeneration`).
 */

/** Provisional schema id carried by every successful result. */
export const TARGET_INSPECT_SCHEMA = "hack.target.v0" as const;

/** Prefix of a provisional config generation id. */
const GENERATION_PREFIX = "cfg-v0:" as const;

/** Exact grammar of a generation id accepted as an expectation. */
export const TARGET_GENERATION_PATTERN = /^cfg-v0:[0-9a-f]{32}$/;

/**
 * Runtime instance selector grammar. Identical to the MCP branch identifier
 * rule, so no value can start with `-` or carry `=`.
 */
export const TARGET_BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/;

/** Compose service grammar, identical to the MCP service identifier rule. */
export const TARGET_SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Longest accepted identifier (branch, service). */
export const TARGET_IDENTIFIER_MAX_LENGTH = 253;

/** Hack config files a generation covers, in hashing order. */
const GENERATION_INPUTS = [
  PROJECT_CONFIG_FILENAME,
  PROJECT_CONFIG_LEGACY_FILENAME,
  PROJECT_COMPOSE_FILENAME,
] as const;

/** Bound on one generation input; a larger file is refused, not truncated. */
const GENERATION_INPUT_MAX_BYTES = 4 * 1024 * 1024;

/** Which resolution stage refused. Provisional. */
export type TargetStage =
  | "selector"
  | "project"
  | "instance"
  | "service"
  | "generation";

/** What a caller should do next. Provisional; carries no execution authority. */
export type TargetRetry = "fix_selector" | "fix_project" | "reinspect";

type RefusalSpec = {
  readonly code: HackErrorCode;
  readonly stage: TargetStage;
  readonly retry: TargetRetry;
  readonly message: string;
};

/**
 * Closed catalogue of inspector refusals. Messages are fixed, value-free text:
 * they never repeat selectors, paths, names or registry values. Codes reuse
 * existing CLI error codes; the `reason` is the stable discriminator.
 */
export const TARGET_REFUSALS = Object.freeze({
  conflicting_selectors: {
    code: "E_USAGE",
    stage: "selector",
    retry: "fix_selector",
    message: "Use only one of --project or --path.",
  },
  invalid_selector: {
    code: "E_USAGE",
    stage: "selector",
    retry: "fix_selector",
    message:
      "Invalid target selector. Check the project, branch, service and expected generation values.",
  },
  project_not_found: {
    code: "E_PROJECT_NOT_FOUND",
    stage: "project",
    retry: "fix_selector",
    message: "Unknown project. Run 'hack projects' to see registered projects.",
  },
  ambiguous_project: {
    code: "E_USAGE",
    stage: "project",
    retry: "fix_selector",
    message:
      "Ambiguous project selection: multiple registrations match. Select by path and inspect 'hack projects' before renaming or pruning an entry.",
  },
  registered_root_missing: {
    code: "E_PROJECT_NOT_FOUND",
    stage: "project",
    retry: "fix_project",
    message:
      "The registered project root no longer exists. Select the checkout by path or run 'hack projects' to inspect the registration.",
  },
  path_not_found: {
    code: "E_PROJECT_NOT_FOUND",
    stage: "project",
    retry: "fix_selector",
    message: "Path not found.",
  },
  no_project_context: {
    code: "E_PROJECT_NOT_FOUND",
    stage: "project",
    retry: "fix_selector",
    message: "No hack project found at the selected location.",
  },
  project_inputs_unsupported: {
    code: "E_CONFIG_INVALID",
    stage: "project",
    retry: "fix_project",
    message:
      "The selected project's inputs are not supported by this inspector (native or conflicting project files).",
  },
  adoption_state_unsafe: {
    code: "E_CONFIG_INVALID",
    stage: "project",
    retry: "fix_project",
    message:
      "The project's legacy adoption state is unreadable, interrupted or unsafe. Use explicit adoption recovery.",
  },
  config_parse_failed: {
    code: "E_CONFIG_PARSE",
    stage: "project",
    retry: "fix_project",
    message: "The project config could not be parsed.",
  },
  compose_parse_failed: {
    code: "E_CONFIG_PARSE",
    stage: "project",
    retry: "fix_project",
    message: "The project's Compose file could not be parsed.",
  },
  detached_checkout: {
    code: "E_USAGE",
    stage: "instance",
    retry: "fix_selector",
    message:
      "Detached linked worktree cannot select an instance implicitly. Pass a branch, or set worktree.auto_branch=false to target the base instance.",
  },
  service_not_found: {
    code: "E_SERVICE_NOT_FOUND",
    stage: "service",
    retry: "fix_selector",
    message:
      "The selected service is not declared in the project's Compose file.",
  },
  stale_generation: {
    code: "E_USAGE",
    stage: "generation",
    retry: "reinspect",
    message:
      "The project config generation differs from the expected generation. Inspect the target again before acting.",
  },
  generation_changed_during_read: {
    code: "E_USAGE",
    stage: "generation",
    retry: "reinspect",
    message:
      "The project config changed while the target was being read. Inspect the target again.",
  },
  generation_input_too_large: {
    code: "E_CONFIG_INVALID",
    stage: "generation",
    retry: "fix_project",
    message: "A project config input exceeds the inspector size bound.",
  },
  input_permission_denied: {
    code: "E_PERMISSION",
    stage: "project",
    retry: "fix_project",
    message: "A project input could not be read: permission denied.",
  },
  input_unreadable: {
    code: "E_CONFIG_INVALID",
    stage: "project",
    retry: "fix_project",
    message: "A project input could not be read.",
  },
} as const satisfies Record<string, RefusalSpec>);

export type TargetRefusalReason = keyof typeof TARGET_REFUSALS;

export const TARGET_REFUSAL_REASONS = Object.keys(TARGET_REFUSALS) as [
  TargetRefusalReason,
  ...TargetRefusalReason[],
];

/** Caller selectors. All optional; `project` and `path` are exclusive. */
export type TargetSelector = {
  readonly project?: string;
  readonly path?: string;
  readonly branch?: string;
  readonly service?: string;
  readonly env?: string;
  readonly expectGeneration?: string;
};

export type TargetInspectData = {
  readonly schema: typeof TARGET_INSPECT_SCHEMA;
  readonly provisional: true;
  readonly observed_at: string;
  /** References identify scope only; they never authorize an action. */
  readonly authority: "none";
  readonly selector: {
    readonly kind: "project" | "path" | "cwd";
    readonly branch_explicit: boolean;
    readonly env_explicit: boolean;
    readonly expected_generation: string | null;
  };
  readonly project: {
    readonly name: string;
    readonly registration: {
      readonly id: string;
      readonly name: string;
      readonly match: "root" | "worktree";
    } | null;
    readonly project_dir: string;
  };
  readonly checkout: {
    readonly root: string;
    readonly kind: "primary" | "linked" | "not_git";
    /** Git branch is reported, never used as runtime identity by itself. */
    readonly git_branch: string | null;
  };
  readonly instance: {
    readonly branch: string | null;
    readonly source: "explicit" | "worktree" | "default";
    readonly compose_project: string;
  };
  readonly service: { readonly name: string } | null;
  readonly services: readonly string[];
  readonly env: {
    readonly overlay: string | null;
    readonly source: "explicit" | "project_default" | "base";
  };
  readonly generation: {
    readonly id: string;
    readonly scope: "hack_config";
    readonly inputs: readonly {
      readonly file: string;
      readonly present: boolean;
    }[];
  };
  /** The snapshot never probes the engine; readiness is not claimed. */
  readonly runtime: { readonly observed: false; readonly reason: "not_probed" };
};

export type TargetRefusalDetail = {
  readonly reason: TargetRefusalReason;
  readonly stage: TargetStage;
  readonly retry: TargetRetry;
  readonly provisional: true;
  /** Present only for `stale_generation`: the generation actually observed. */
  readonly observed_generation?: string;
};

export type TargetInspectEnvelope =
  | { readonly ok: true; readonly data: TargetInspectData }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: HackErrorCode;
        readonly message: string;
        readonly detail?: TargetRefusalDetail;
      };
    };

class TargetRefusal extends Error {
  readonly reason: TargetRefusalReason;
  readonly observedGeneration: string | undefined;

  constructor(reason: TargetRefusalReason, observedGeneration?: string) {
    super(TARGET_REFUSALS[reason].message);
    this.reason = reason;
    this.observedGeneration = observedGeneration;
  }
}

/** Build the closed refusal envelope for one reason. */
export function targetRefusalEnvelope(opts: {
  readonly reason: TargetRefusalReason;
  readonly observedGeneration?: string;
}): TargetInspectEnvelope {
  const spec = TARGET_REFUSALS[opts.reason];
  return {
    ok: false,
    error: {
      code: spec.code,
      message: spec.message,
      detail: {
        reason: opts.reason,
        stage: spec.stage,
        retry: spec.retry,
        provisional: true,
        ...(opts.observedGeneration === undefined
          ? {}
          : { observed_generation: opts.observedGeneration }),
      },
    },
  };
}

/**
 * Inspect one target. Returns a refusal envelope for every closed failure.
 * A filesystem fault while reading inputs (for example a permission-denied
 * Compose file, or a directory where a config file belongs) is mapped to the
 * closed `input_permission_denied` / `input_unreadable` refusals, so the OS
 * message and its absolute path never reach the caller. The shared project
 * input guards' own refusals (native or conflicting inputs, an unsafe or
 * unreadable legacy adoption state, an input whose presence cannot be checked)
 * are mapped too, wherever they are raised.
 * Only other faults (programming errors) still throw.
 *
 * `afterResolve` is a test seam that runs after the target is resolved and
 * before the generation is re-read; production callers never pass it.
 */
export async function inspectTarget(opts: {
  readonly cwd: string;
  readonly selector: TargetSelector;
  readonly registryPath?: string;
  readonly now?: () => Date;
  readonly afterResolve?: () => Promise<void>;
}): Promise<TargetInspectEnvelope> {
  try {
    const data = await resolveTarget(opts);
    return { ok: true, data };
  } catch (error: unknown) {
    if (error instanceof TargetRefusal) {
      return targetRefusalEnvelope({
        reason: error.reason,
        ...(error.observedGeneration === undefined
          ? {}
          : { observedGeneration: error.observedGeneration }),
      });
    }
    const guarded = projectInputGuardReason(error);
    if (guarded !== null) {
      return targetRefusalEnvelope({ reason: guarded });
    }
    const fault = filesystemFaultCode(error);
    if (fault !== null) {
      return targetRefusalEnvelope({
        reason:
          fault === "EACCES" || fault === "EPERM"
            ? "input_permission_denied"
            : "input_unreadable",
      });
    }
    throw error;
  }
}

/**
 * Closed reason for a refusal raised by the shared project input guards. Those
 * guards run during discovery and again inside every config read, so they are
 * classified here rather than at one call site. Their messages are value-free
 * but are not catalogue text, so they are never passed through.
 */
function projectInputGuardReason(error: unknown): TargetRefusalReason | null {
  if (error instanceof ProjectInputSelectionError) {
    return "project_inputs_unsupported";
  }
  if (error instanceof ProjectInputAccessError) {
    return error.access === "permission"
      ? "input_permission_denied"
      : "input_unreadable";
  }
  if (error instanceof LegacyComposeAdoptionSelectionError) {
    return error.kind === "input-access"
      ? "input_unreadable"
      : "adoption_state_unsafe";
  }
  return null;
}

/** Shape of an errno code such as `EACCES` or `EISDIR`. */
const ERRNO_CODE_PATTERN = /^E[A-Z0-9]+$/;

/**
 * The errno code of a Node/Bun filesystem or syscall error, or null for any
 * other value. Such errors carry a string `code` and `syscall`; their
 * `message` includes the absolute path, which is why it is never surfaced.
 */
function filesystemFaultCode(error: unknown): string | null {
  if (
    isRecord(error) &&
    typeof error.code === "string" &&
    ERRNO_CODE_PATTERN.test(error.code) &&
    typeof error.syscall === "string"
  ) {
    return error.code;
  }
  return null;
}

type ValidatedSelector = {
  readonly project: string | null;
  readonly path: string | null;
  readonly branch: string | null;
  readonly service: string | null;
  /** undefined: use the project default; null: base layers only. */
  readonly env: string | null | undefined;
  readonly expectGeneration: string | null;
};

function validateSelector(selector: TargetSelector): ValidatedSelector {
  if (selector.project !== undefined && selector.path !== undefined) {
    throw new TargetRefusal("conflicting_selectors");
  }
  let project: string | null = null;
  if (selector.project !== undefined) {
    const trimmed = selector.project.trim();
    project = PROJECT_SELECTOR_PATTERN.test(trimmed)
      ? normalizeProjectName(trimmed)
      : null;
    if (!project) {
      throw new TargetRefusal("invalid_selector");
    }
  }
  let path: string | null = null;
  if (selector.path !== undefined) {
    if (selector.path.trim().length === 0) {
      throw new TargetRefusal("invalid_selector");
    }
    path = selector.path;
  }
  const branch = validateIdentifier(selector.branch, TARGET_BRANCH_PATTERN);
  const service = validateIdentifier(selector.service, TARGET_SERVICE_PATTERN);
  let env: string | null | undefined;
  if (selector.env !== undefined) {
    env = parseEnvConfigSelection(selector.env);
    if (env === undefined) {
      throw new TargetRefusal("invalid_selector");
    }
  }
  let expectGeneration: string | null = null;
  if (selector.expectGeneration !== undefined) {
    if (!TARGET_GENERATION_PATTERN.test(selector.expectGeneration)) {
      throw new TargetRefusal("invalid_selector");
    }
    expectGeneration = selector.expectGeneration;
  }
  return { project, path, branch, service, env, expectGeneration };
}

function validateIdentifier(
  value: string | undefined,
  pattern: RegExp
): string | null {
  if (value === undefined) {
    return null;
  }
  if (value.length > TARGET_IDENTIFIER_MAX_LENGTH || !pattern.test(value)) {
    throw new TargetRefusal("invalid_selector");
  }
  return value;
}

type SelectedProject = {
  readonly context: ProjectContext;
  readonly kind: TargetInspectData["selector"]["kind"];
};

async function resolveTarget(opts: {
  readonly cwd: string;
  readonly selector: TargetSelector;
  readonly registryPath?: string;
  readonly now?: () => Date;
  readonly afterResolve?: () => Promise<void>;
}): Promise<TargetInspectData> {
  const selector = validateSelector(opts.selector);
  const registry = await readProjectsRegistry({
    registryPath: opts.registryPath,
  });
  const selected = await selectProject({
    cwd: opts.cwd,
    selector,
    projects: registry.projects,
  });
  const context = selected.context;

  const before = await readGeneration(context);
  const cfg = await readProjectConfig(context);
  if (cfg.parseError) {
    throw new TargetRefusal("config_parse_failed");
  }
  const services = await readComposeServiceNames(context.composeFile);

  const root = await canonicalPath(context.projectRoot);
  const registration = await findRegistrationForRoot({
    projects: registry.projects,
    root,
  });

  const linked = await isLinkedGitWorktree({ repoRoot: context.projectRoot });
  const gitBranch =
    linked === null
      ? null
      : await resolveGitCurrentBranch({ repoRoot: context.projectRoot });

  const explicitBranch = selector.branch
    ? sanitizeBranchSlug(selector.branch) || "branch"
    : null;
  const effective = await resolveEffectiveBranch({
    explicitBranch,
    projectRoot: context.projectRoot,
    autoBranchEnabled: resolveWorktreeAutoBranch(cfg),
  });
  if (effective.source === "detached-worktree") {
    throw new TargetRefusal("detached_checkout");
  }
  const baseCompose = await resolveComposeProjectName({
    project: context,
    cfg,
  });
  const instanceBranch = effective.branch;

  if (selector.service !== null && !services.includes(selector.service)) {
    throw new TargetRefusal("service_not_found");
  }

  const env = await resolveEnvSelection({ context, requested: selector.env });

  await opts.afterResolve?.();
  const after = await readGeneration(context);
  if (after.id !== before.id) {
    throw new TargetRefusal("generation_changed_during_read");
  }
  if (
    selector.expectGeneration !== null &&
    selector.expectGeneration !== after.id
  ) {
    throw new TargetRefusal("stale_generation", after.id);
  }

  const now = opts.now ?? (() => new Date());
  return {
    schema: TARGET_INSPECT_SCHEMA,
    provisional: true,
    observed_at: now().toISOString(),
    authority: "none",
    selector: {
      kind: selected.kind,
      branch_explicit: selector.branch !== null,
      env_explicit: selector.env !== undefined,
      expected_generation: selector.expectGeneration,
    },
    project: {
      name: projectSlug({ cfgName: cfg.name, root: context.projectRoot }),
      registration,
      project_dir: context.projectDir,
    },
    checkout: {
      root: context.projectRoot,
      kind: checkoutKind(linked),
      git_branch: gitBranch,
    },
    instance: {
      branch: instanceBranch,
      source: instanceSource(effective.source),
      compose_project: instanceBranch
        ? branchComposeProjectName({
            base: baseCompose,
            branch: instanceBranch,
          })
        : baseCompose,
    },
    service: selector.service === null ? null : { name: selector.service },
    services,
    env,
    generation: {
      id: after.id,
      scope: "hack_config",
      inputs: after.inputs,
    },
    runtime: { observed: false, reason: "not_probed" },
  };
}

/** Project slug: config `name`, else the slug of the checkout directory. */
function projectSlug(opts: {
  readonly cfgName: string | undefined;
  readonly root: string;
}): string {
  const configured = opts.cfgName?.trim() ?? "";
  return configured.length > 0
    ? sanitizeProjectSlug(configured)
    : defaultProjectSlugFromPath(opts.root);
}

function checkoutKind(
  linked: boolean | null
): TargetInspectData["checkout"]["kind"] {
  if (linked === null) {
    return "not_git";
  }
  return linked ? "linked" : "primary";
}

function instanceSource(
  source: "explicit" | "worktree" | "none"
): TargetInspectData["instance"]["source"] {
  return source === "none" ? "default" : source;
}

async function selectProject(opts: {
  readonly cwd: string;
  readonly selector: ValidatedSelector;
  readonly projects: readonly RegisteredProject[];
}): Promise<SelectedProject> {
  if (opts.selector.project !== null) {
    let match: RegisteredProject | null;
    try {
      match = selectRegisteredProjectByName({
        projects: opts.projects,
        name: opts.selector.project,
      });
    } catch (error: unknown) {
      if (
        error instanceof AmbiguousProjectNameError ||
        error instanceof AmbiguousProjectIdError
      ) {
        throw new TargetRefusal("ambiguous_project");
      }
      throw error;
    }
    if (!match) {
      throw new TargetRefusal("project_not_found");
    }
    if (!(await isDirectory(match.repoRoot))) {
      throw new TargetRefusal("registered_root_missing");
    }
    const context = await findProjectContextAtRoot({
      projectRoot: match.repoRoot,
      projectDirName: match.projectDirName,
    });
    if (!context) {
      throw new TargetRefusal("no_project_context");
    }
    return { context, kind: "project" };
  }

  const startDir =
    opts.selector.path === null
      ? opts.cwd
      : resolve(opts.cwd, opts.selector.path);
  if (opts.selector.path !== null && !(await isDirectory(startDir))) {
    throw new TargetRefusal("path_not_found");
  }
  const context = await findProjectContext(startDir);
  if (!context) {
    throw new TargetRefusal("no_project_context");
  }
  return { context, kind: opts.selector.path === null ? "cwd" : "path" };
}

/**
 * Registration that owns this exact checkout root: its primary root, or one of
 * its recorded linked worktrees. Name equality never matches, so independent
 * checkouts that share a name stay separate. Two owners refuse as ambiguous.
 */
async function findRegistrationForRoot(opts: {
  readonly projects: readonly RegisteredProject[];
  readonly root: string;
}): Promise<TargetInspectData["project"]["registration"]> {
  const byRoot: RegisteredProject[] = [];
  const byWorktree: RegisteredProject[] = [];
  for (const project of opts.projects) {
    if ((await canonicalPath(project.repoRoot)) === opts.root) {
      byRoot.push(project);
      continue;
    }
    for (const worktree of project.worktrees ?? []) {
      if ((await canonicalPath(worktree.path)) === opts.root) {
        byWorktree.push(project);
        break;
      }
    }
  }
  const candidates = byRoot.length > 0 ? byRoot : byWorktree;
  if (candidates.length > 1) {
    throw new TargetRefusal("ambiguous_project");
  }
  const match = candidates[0];
  if (!match) {
    return null;
  }
  return {
    id: match.id,
    name: match.name,
    match: byRoot.length > 0 ? "root" : "worktree",
  };
}

async function resolveEnvSelection(opts: {
  readonly context: ProjectContext;
  readonly requested: string | null | undefined;
}): Promise<TargetInspectData["env"]> {
  if (opts.requested === null) {
    return { overlay: null, source: "base" };
  }
  if (opts.requested !== undefined) {
    return { overlay: opts.requested, source: "explicit" };
  }
  const configured = await readProjectDefaultEnvConfig({
    projectDir: opts.context.projectDir,
  });
  return configured
    ? { overlay: configured, source: "project_default" }
    : { overlay: null, source: "base" };
}

/**
 * Service names declared in the Compose file, sorted. An absent file declares
 * none, as does an empty `services:` key. A file that is present but is not YAML, whose top level is not a
 * mapping, or whose `services` is not a mapping is refused as
 * `compose_parse_failed`: lifecycle commands would fail on it, so it must not
 * be reported as a target with no services. The generation read has already
 * bounded the file's size.
 */
async function readComposeServiceNames(
  composeFile: string
): Promise<readonly string[]> {
  let text: string;
  try {
    text = await readFile(composeFile, "utf8");
  } catch (error: unknown) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch {
    throw new TargetRefusal("compose_parse_failed");
  }
  if (!isRecord(parsed)) {
    throw new TargetRefusal("compose_parse_failed");
  }
  const services = parsed.services;
  if (services === undefined || services === null) {
    return [];
  }
  if (!isRecord(services)) {
    throw new TargetRefusal("compose_parse_failed");
  }
  return Object.keys(services).sort((left, right) => left.localeCompare(right));
}

type Generation = {
  readonly id: string;
  readonly inputs: TargetInspectData["generation"]["inputs"];
};

/**
 * Fingerprint of the Hack config inputs only. Ordinary source edits do not
 * change it; editing hack.config.json, hack.toml or docker-compose.yml does.
 * Absence is hashed distinctly from an empty file.
 */
async function readGeneration(context: ProjectContext): Promise<Generation> {
  const hash = createHash("sha256");
  const inputs: { file: string; present: boolean }[] = [];
  for (const file of GENERATION_INPUTS) {
    const bytes = await readBoundedInput(resolve(context.projectDir, file));
    hash.update(`${file}\n`);
    if (bytes === null) {
      hash.update("0\n");
      inputs.push({ file, present: false });
      continue;
    }
    hash.update(`1\n${bytes.byteLength}\n`);
    hash.update(bytes);
    inputs.push({ file, present: true });
  }
  return {
    id: `${GENERATION_PREFIX}${hash.digest("hex").slice(0, 32)}`,
    inputs,
  };
}

async function readBoundedInput(path: string): Promise<Uint8Array | null> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return null;
    }
    size = info.size;
  } catch (error: unknown) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
  if (size > GENERATION_INPUT_MAX_BYTES) {
    throw new TargetRefusal("generation_input_too_large");
  }
  try {
    const bytes = await readFile(path);
    if (bytes.byteLength > GENERATION_INPUT_MAX_BYTES) {
      throw new TargetRefusal("generation_input_too_large");
    }
    return bytes;
  } catch (error: unknown) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (
    isRecord(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error: unknown) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

// ---------------------------------------------------------------------------
// Envelope validation shared by adapters (the MCP tool re-validates the CLI's
// stdout through this, so a drifted or foreign payload is never passed on).
// ---------------------------------------------------------------------------

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(HACK_ERROR_CODES);

/**
 * Parse a `hack project target --json` envelope. Returns a rebuilt envelope
 * containing only contract fields, or null when the value does not match the
 * provisional contract. The only error envelope accepted without a `detail`
 * is an `E_USAGE` refusal (the CLI's shared option-grammar refusals, raised
 * before the inspector runs). Any other detail-less error, such as an
 * `E_UNEXPECTED` fault whose message is free OS text, is off contract and
 * becomes null, so it is never passed on.
 */
export function parseTargetInspectEnvelope(
  value: unknown
): TargetInspectEnvelope | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.ok === true) {
    const data = parseData(value.data);
    return data ? { ok: true, data } : null;
  }
  if (value.ok !== false || !isRecord(value.error)) {
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
    return errorCode === "E_USAGE"
      ? { ok: false, error: { code: errorCode, message } }
      : null;
  }
  const parsedDetail = parseRefusalDetail(detail);
  if (!parsedDetail) {
    return null;
  }
  const spec = TARGET_REFUSALS[parsedDetail.reason];
  if (spec.code !== errorCode || spec.message !== message) {
    return null;
  }
  return {
    ok: false,
    error: { code: errorCode, message, detail: parsedDetail },
  };
}

function parseRefusalDetail(value: unknown): TargetRefusalDetail | null {
  if (!isRecord(value) || value.provisional !== true) {
    return null;
  }
  const reason = value.reason;
  if (typeof reason !== "string" || !Object.hasOwn(TARGET_REFUSALS, reason)) {
    return null;
  }
  const typedReason = reason as TargetRefusalReason;
  const spec = TARGET_REFUSALS[typedReason];
  if (value.stage !== spec.stage || value.retry !== spec.retry) {
    return null;
  }
  const observed = value.observed_generation;
  if (
    observed !== undefined &&
    (typedReason !== "stale_generation" ||
      typeof observed !== "string" ||
      !TARGET_GENERATION_PATTERN.test(observed))
  ) {
    return null;
  }
  return {
    reason: typedReason,
    stage: spec.stage,
    retry: spec.retry,
    provisional: true,
    ...(observed === undefined ? {} : { observed_generation: observed }),
  };
}

function parseData(value: unknown): TargetInspectData | null {
  if (
    !isRecord(value) ||
    value.schema !== TARGET_INSPECT_SCHEMA ||
    value.provisional !== true ||
    value.authority !== "none" ||
    typeof value.observed_at !== "string"
  ) {
    return null;
  }
  const selector = parseSelectorEcho(value.selector);
  const project = parseProject(value.project);
  const checkout = parseCheckout(value.checkout);
  const instance = parseInstance(value.instance);
  const service = parseService(value.service);
  const services = parseStringList(value.services);
  const env = parseEnv(value.env);
  const generation = parseGeneration(value.generation);
  const runtime = value.runtime;
  if (
    !(
      selector &&
      project &&
      checkout &&
      instance &&
      service !== undefined &&
      services &&
      env &&
      generation &&
      isRecord(runtime) &&
      runtime.observed === false &&
      runtime.reason === "not_probed"
    )
  ) {
    return null;
  }
  return {
    schema: TARGET_INSPECT_SCHEMA,
    provisional: true,
    observed_at: value.observed_at,
    authority: "none",
    selector,
    project,
    checkout,
    instance,
    service,
    services,
    env,
    generation,
    runtime: { observed: false, reason: "not_probed" },
  };
}

function parseSelectorEcho(
  value: unknown
): TargetInspectData["selector"] | null {
  if (
    !isRecord(value) ||
    (value.kind !== "project" &&
      value.kind !== "path" &&
      value.kind !== "cwd") ||
    typeof value.branch_explicit !== "boolean" ||
    typeof value.env_explicit !== "boolean"
  ) {
    return null;
  }
  const expected = value.expected_generation;
  if (
    expected !== null &&
    !(typeof expected === "string" && TARGET_GENERATION_PATTERN.test(expected))
  ) {
    return null;
  }
  return {
    kind: value.kind,
    branch_explicit: value.branch_explicit,
    env_explicit: value.env_explicit,
    expected_generation: expected,
  };
}

function parseProject(value: unknown): TargetInspectData["project"] | null {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.project_dir !== "string"
  ) {
    return null;
  }
  const registration = value.registration;
  if (registration === null) {
    return {
      name: value.name,
      registration: null,
      project_dir: value.project_dir,
    };
  }
  if (
    !isRecord(registration) ||
    typeof registration.id !== "string" ||
    typeof registration.name !== "string" ||
    (registration.match !== "root" && registration.match !== "worktree")
  ) {
    return null;
  }
  return {
    name: value.name,
    registration: {
      id: registration.id,
      name: registration.name,
      match: registration.match,
    },
    project_dir: value.project_dir,
  };
}

function parseCheckout(value: unknown): TargetInspectData["checkout"] | null {
  if (
    !isRecord(value) ||
    typeof value.root !== "string" ||
    (value.kind !== "primary" &&
      value.kind !== "linked" &&
      value.kind !== "not_git") ||
    !(value.git_branch === null || typeof value.git_branch === "string")
  ) {
    return null;
  }
  return { root: value.root, kind: value.kind, git_branch: value.git_branch };
}

function parseInstance(value: unknown): TargetInspectData["instance"] | null {
  if (
    !isRecord(value) ||
    typeof value.compose_project !== "string" ||
    (value.source !== "explicit" &&
      value.source !== "worktree" &&
      value.source !== "default") ||
    !(value.branch === null || typeof value.branch === "string")
  ) {
    return null;
  }
  return {
    branch: value.branch,
    source: value.source,
    compose_project: value.compose_project,
  };
}

/** undefined means invalid; null is a valid "no service selected". */
function parseService(
  value: unknown
): TargetInspectData["service"] | undefined {
  if (value === null) {
    return null;
  }
  if (!isRecord(value) || typeof value.name !== "string") {
    return undefined;
  }
  return { name: value.name };
}

function parseStringList(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }
    out.push(entry);
  }
  return out;
}

function parseEnv(value: unknown): TargetInspectData["env"] | null {
  if (
    !isRecord(value) ||
    (value.source !== "explicit" &&
      value.source !== "project_default" &&
      value.source !== "base") ||
    !(value.overlay === null || typeof value.overlay === "string")
  ) {
    return null;
  }
  return { overlay: value.overlay, source: value.source };
}

function parseGeneration(
  value: unknown
): TargetInspectData["generation"] | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !TARGET_GENERATION_PATTERN.test(value.id) ||
    value.scope !== "hack_config" ||
    !Array.isArray(value.inputs)
  ) {
    return null;
  }
  const inputs: { file: string; present: boolean }[] = [];
  for (const entry of value.inputs) {
    if (
      !isRecord(entry) ||
      typeof entry.file !== "string" ||
      typeof entry.present !== "boolean"
    ) {
      return null;
    }
    inputs.push({ file: entry.file, present: entry.present });
  }
  return { id: value.id, scope: "hack_config", inputs };
}
