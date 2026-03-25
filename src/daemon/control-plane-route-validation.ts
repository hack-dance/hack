const PROJECT_ID_PATTERN = /^[a-f0-9]{12}$/;
const RUNTIME_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ControlPlaneRouteTarget = {
  readonly projectId: string | null;
  readonly jobId?: string;
  readonly shellId?: string;
  readonly shellStream: boolean;
};

export type ControlPlaneRouteValidationResult =
  | { readonly ok: true; readonly target: ControlPlaneRouteTarget }
  | {
      readonly ok: false;
      readonly status: 400;
      readonly error:
        | "invalid_project_id"
        | "invalid_job_id"
        | "invalid_shell_id";
    };

export type GatewayRouteAccessResult =
  | { readonly ok: true; readonly projectId: string | null }
  | {
      readonly ok: false;
      readonly status: 400 | 403;
      readonly error:
        | "invalid_project_id"
        | "invalid_job_id"
        | "invalid_shell_id"
        | "project_disabled"
        | "writes_disabled"
        | "write_scope_required";
    };

export function validateControlPlaneRouteTarget(opts: {
  readonly url: URL;
}): ControlPlaneRouteValidationResult {
  const segments = opts.url.pathname.split("/").filter(Boolean);
  if (segments[0] !== "control-plane" || segments[1] !== "projects") {
    return {
      ok: true,
      target: {
        projectId: null,
        shellStream: false,
      },
    };
  }

  const projectId = segments[2] ?? null;
  if (!projectId) {
    return {
      ok: true,
      target: {
        projectId: null,
        shellStream: false,
      },
    };
  }
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    return { ok: false, status: 400, error: "invalid_project_id" };
  }

  const resource = segments[3];
  const resourceId = segments[4];
  if (
    resource === "jobs" &&
    resourceId &&
    !RUNTIME_ID_PATTERN.test(resourceId)
  ) {
    return { ok: false, status: 400, error: "invalid_job_id" };
  }
  if (
    resource === "shells" &&
    resourceId &&
    !RUNTIME_ID_PATTERN.test(resourceId)
  ) {
    return { ok: false, status: 400, error: "invalid_shell_id" };
  }

  return {
    ok: true,
    target: {
      projectId,
      ...(resource === "jobs" && resourceId ? { jobId: resourceId } : {}),
      ...(resource === "shells" && resourceId ? { shellId: resourceId } : {}),
      shellStream:
        resource === "shells" &&
        typeof resourceId === "string" &&
        segments[5] === "stream",
    },
  };
}

export function evaluateGatewayRouteAccess(opts: {
  readonly method: string;
  readonly url: URL;
  readonly allowWrites: boolean;
  readonly enabledProjectIds: ReadonlySet<string>;
  readonly scope: "read" | "write";
}): GatewayRouteAccessResult {
  const validation = validateControlPlaneRouteTarget({ url: opts.url });
  if (!validation.ok) {
    return validation;
  }

  const { projectId, shellStream } = validation.target;
  if (projectId && !opts.enabledProjectIds.has(projectId)) {
    return { ok: false, status: 403, error: "project_disabled" };
  }

  const requiresWriteAccess =
    shellStream || !isGatewayReadOnlyMethod({ method: opts.method });
  if (!requiresWriteAccess) {
    return { ok: true, projectId };
  }
  if (!opts.allowWrites) {
    return { ok: false, status: 403, error: "writes_disabled" };
  }
  if (opts.scope !== "write") {
    return { ok: false, status: 403, error: "write_scope_required" };
  }

  return { ok: true, projectId };
}

function isGatewayReadOnlyMethod(opts: { readonly method: string }): boolean {
  const method = opts.method.toUpperCase();
  return method === "GET" || method === "HEAD";
}
