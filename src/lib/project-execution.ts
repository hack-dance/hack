import type {
  ControlPlaneConfig,
  ProjectExecutionMode,
} from "../control-plane/sdk/config.ts";

export type ProjectExecutionTargetPreference = "auto" | "local" | "remote";
export type ProjectExecutionTarget = "local" | "remote";

export interface ProjectExecutionResolution {
  readonly requestedTarget: ProjectExecutionTargetPreference;
  readonly mode: ProjectExecutionMode;
  readonly resolvedTarget: ProjectExecutionTarget;
  readonly reason: string;
  readonly nodeId?: string;
  readonly nodeSelector?: string;
}

/**
 * Resolve project execution target from explicit command intent, project mode,
 * and available node affinity/defaults.
 */
export function resolveProjectExecutionTarget(opts: {
  readonly requestedTarget: string | undefined;
  readonly controlPlane: Pick<ControlPlaneConfig, "nodeId" | "execution">;
  readonly defaultNodeId?: string;
}): ProjectExecutionResolution {
  const requestedTarget = parseRequestedTarget({ raw: opts.requestedTarget });
  const mode = normalizeProjectExecutionMode({
    raw: opts.controlPlane.execution?.mode,
  });
  const executionNodeId = normalizeNodeId({
    raw: opts.controlPlane.execution?.nodeId,
  });
  const legacyNodeId = normalizeNodeId({ raw: opts.controlPlane.nodeId });
  const defaultNodeId = normalizeNodeId({ raw: opts.defaultNodeId });
  const projectNodeId = executionNodeId ?? legacyNodeId;

  if (requestedTarget === "local") {
    return {
      requestedTarget,
      mode,
      resolvedTarget: "local",
      reason: "requested_local",
    };
  }

  if (requestedTarget === "remote") {
    return buildRemoteResolution({
      requestedTarget,
      mode,
      projectNodeId,
      defaultNodeId,
      reason: "requested_remote",
    });
  }

  const shouldAutoRemote =
    mode !== "local" || typeof projectNodeId === "string";
  if (!shouldAutoRemote) {
    return {
      requestedTarget,
      mode,
      resolvedTarget: "local",
      reason: "auto_local_mode",
    };
  }

  return buildRemoteResolution({
    requestedTarget,
    mode,
    projectNodeId,
    defaultNodeId,
    reason: mode === "local" ? "auto_project_node" : "auto_execution_mode",
  });
}

/**
 * Normalize execution mode with safe local fallback.
 */
export function normalizeProjectExecutionMode(opts: {
  readonly raw: string | undefined;
}): ProjectExecutionMode {
  if (opts.raw === "local_edit_remote_run") {
    return opts.raw;
  }
  if (opts.raw === "remote_devcontainer") {
    return opts.raw;
  }
  return "local";
}

function buildRemoteResolution(opts: {
  readonly requestedTarget: ProjectExecutionTargetPreference;
  readonly mode: ProjectExecutionMode;
  readonly projectNodeId?: string;
  readonly defaultNodeId?: string;
  readonly reason: string;
}): ProjectExecutionResolution {
  const selectedNodeId = opts.projectNodeId ?? opts.defaultNodeId;
  if (!selectedNodeId) {
    throw new Error(
      "Remote execution requires a project node or a global default node. Set one with `hack node use <id>` or `hack config set controlPlane.execution.nodeId <id>`."
    );
  }

  return {
    requestedTarget: opts.requestedTarget,
    mode: opts.mode,
    resolvedTarget: "remote",
    reason: opts.reason,
    nodeId: selectedNodeId,
    nodeSelector: opts.projectNodeId ? opts.projectNodeId : "default",
  };
}

function parseRequestedTarget(opts: {
  readonly raw: string | undefined;
}): ProjectExecutionTargetPreference {
  const normalized = (opts.raw ?? "auto").trim().toLowerCase();
  if (normalized === "" || normalized === "auto") {
    return "auto";
  }
  if (normalized === "local") {
    return "local";
  }
  if (normalized === "remote") {
    return "remote";
  }
  throw new Error(
    `Invalid --target value: ${opts.raw ?? ""}. Expected auto|local|remote.`
  );
}

function normalizeNodeId(opts: {
  readonly raw: string | undefined;
}): string | undefined {
  const trimmed = (opts.raw ?? "").trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed;
}
