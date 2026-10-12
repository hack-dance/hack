/**
 * Value-free projections for the MCP inspection tools (HACK-1133).
 *
 * `hack.project.env.explain` and `hack.project.env.keys` run `hack env explain
 * --json` and `hack env list --json`. The CLI payloads are not guaranteed to be
 * value-free (`env list --json` carries plaintext values), so the MCP server
 * never forwards their raw stdout or stderr. Each projection below copies only
 * an allowlisted set of metadata fields with narrowed types; a field that is
 * missing, unexpected or of the wrong type is dropped, never passed through.
 *
 * `hack.project.instances` projects one project's runtime instances out of
 * `hack projects --json`. It is not a secret boundary, but it keeps the result
 * small: container inspect data (labels, mounts, networks) is not returned.
 */
import { isRecord } from "../lib/guards.ts";
import { normalizeProjectName } from "../lib/project-name.ts";

/**
 * Env key accepted by the env tools. It starts with a letter or underscore, so
 * it can never be read as an option, and it carries no scope separator. The
 * CLI applies its own stricter key rule after this.
 */
export const MCP_ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Fixed stderr text for a failed env tool call; child output is withheld. */
export const MCP_ENV_OUTPUT_WITHHELD_MESSAGE =
  "hack env command failed. Its output is withheld because it may contain env values; run the same hack env command in a terminal for details.";

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function envKeyOrNull(value: unknown): string | null {
  return typeof value === "string" && MCP_ENV_KEY_PATTERN.test(value)
    ? value
    : null;
}

/** Env explain metadata: where a key comes from, never its value. */
export type McpEnvExplainData = {
  readonly key: string | null;
  readonly available: boolean | null;
  readonly secret: boolean | null;
  readonly format: string | null;
  readonly environment: string | null;
  readonly requested_scope: string | null;
  readonly effective_scope: string | null;
  readonly target: string | null;
  readonly delivered_to: readonly string[] | null;
  readonly source: string | null;
  readonly precedence: readonly string[] | null;
};

/** Project `hack env explain --json` stdout onto {@link McpEnvExplainData}. */
export function projectEnvExplain(payload: unknown): McpEnvExplainData | null {
  if (!isRecord(payload)) {
    return null;
  }
  return {
    key: envKeyOrNull(payload.key),
    available: optionalBoolean(payload.available),
    secret: optionalBoolean(payload.secret),
    format: optionalString(payload.format),
    environment: optionalString(payload.environment),
    requested_scope: optionalString(payload.requested_scope),
    effective_scope: optionalString(payload.effective_scope),
    target: optionalString(payload.target),
    delivered_to: stringList(payload.delivered_to),
    source: optionalString(payload.source),
    precedence: stringList(payload.precedence),
  };
}

/** One inventory row: key metadata only. */
export type McpEnvKeyEntry = {
  readonly key: string;
  readonly secret: boolean;
  readonly required: boolean | null;
  readonly source: string | null;
  readonly resolved_from: string | null;
  readonly services: readonly string[] | null;
};

export type McpEnvKeysData = {
  readonly format: string | null;
  readonly environment: string | null;
  readonly selected_scope: string | null;
  readonly scopes: readonly string[] | null;
  readonly keys: readonly McpEnvKeyEntry[];
  readonly missing_required: readonly string[];
};

/**
 * Project `hack env list --json` stdout onto a key inventory. Row `value`,
 * `materialized`, `storage`, `warnings` and every other field are dropped. A
 * row whose key does not match {@link MCP_ENV_KEY_PATTERN} is dropped whole.
 */
export function projectEnvKeys(payload: unknown): McpEnvKeysData | null {
  if (!isRecord(payload)) {
    return null;
  }
  const vars = Array.isArray(payload.vars) ? payload.vars : [];
  const keys: McpEnvKeyEntry[] = [];
  for (const row of vars) {
    if (!isRecord(row)) {
      continue;
    }
    const key = envKeyOrNull(row.key);
    if (key === null) {
      continue;
    }
    const source = optionalString(row.source);
    keys.push({
      key,
      secret: source === "keychain",
      required: optionalBoolean(row.required),
      source,
      resolved_from: optionalString(row.resolved_from),
      services: stringList(row.services),
    });
  }
  const selection = isRecord(payload.env_selection)
    ? payload.env_selection
    : {};
  return {
    format: optionalString(payload.format),
    environment: optionalString(selection.effective),
    selected_scope: optionalString(payload.selected_scope),
    scopes: stringList(payload.scopes),
    keys,
    missing_required: (stringList(payload.missing_required) ?? []).filter(
      (key) => MCP_ENV_KEY_PATTERN.test(key)
    ),
  };
}

export type McpInstanceService = {
  readonly service: string;
  readonly containers: number;
  readonly running: number;
};

/** One runtime instance: the default instance (`branch: null`) or a branch. */
export type McpProjectInstance = {
  readonly branch: string | null;
  readonly compose_project: string | null;
  readonly working_dir: string | null;
  readonly services: readonly McpInstanceService[];
};

export type McpInstancesData = {
  readonly project: string;
  readonly found: boolean;
  readonly runtime_ok: boolean | null;
  readonly instances: readonly McpProjectInstance[];
};

function projectRuntime(opts: {
  readonly branch: string | null;
  readonly runtime: unknown;
}): McpProjectInstance | null {
  if (!isRecord(opts.runtime)) {
    return null;
  }
  const services: McpInstanceService[] = [];
  for (const entry of Array.isArray(opts.runtime.services)
    ? opts.runtime.services
    : []) {
    if (!(isRecord(entry) && typeof entry.service === "string")) {
      continue;
    }
    const containers = Array.isArray(entry.containers)
      ? entry.containers.filter(isRecord)
      : [];
    services.push({
      service: entry.service,
      containers: containers.length,
      running: containers.filter((container) => container.state === "running")
        .length,
    });
  }
  return {
    branch: opts.branch,
    compose_project: optionalString(opts.runtime.project),
    working_dir: optionalString(opts.runtime.working_dir),
    services,
  };
}

/**
 * Select `project` from a `hack projects --json` payload and list its runtime
 * instances: the default instance first (when running), then each branch
 * instance in the order the CLI reported them.
 */
export function projectInstances(opts: {
  readonly payload: unknown;
  readonly project: string;
}): McpInstancesData {
  const payload = isRecord(opts.payload) ? opts.payload : {};
  const projects = Array.isArray(payload.projects) ? payload.projects : [];
  const view = projects.find(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) &&
      typeof entry.name === "string" &&
      normalizeProjectName(entry.name) === opts.project
  );
  const runtimeOk = optionalBoolean(payload.runtime_ok);
  if (!view) {
    return {
      project: opts.project,
      found: false,
      runtime_ok: runtimeOk,
      instances: [],
    };
  }
  const instances: McpProjectInstance[] = [];
  const base = projectRuntime({ branch: null, runtime: view.runtime });
  if (base) {
    instances.push(base);
  }
  for (const entry of Array.isArray(view.branch_runtime)
    ? view.branch_runtime
    : []) {
    if (!(isRecord(entry) && typeof entry.branch === "string")) {
      continue;
    }
    const instance = projectRuntime({
      branch: entry.branch,
      runtime: entry.runtime,
    });
    if (instance) {
      instances.push(instance);
    }
  }
  return {
    project: opts.project,
    found: true,
    runtime_ok: runtimeOk,
    instances,
  };
}
