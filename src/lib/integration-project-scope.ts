import { requestHackAuthBroker } from "./auth-broker-client.ts";
import {
  findProjectContext,
  readProjectConfig,
  sanitizeProjectSlug,
} from "./project.ts";

type BrokerFetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

type SharedProjectScopeState =
  | "local_only"
  | "shared_visible"
  | "shared_hidden"
  | "auth_required"
  | "broker_error"
  | "unregistered";

type SharedProjectAccessRole = "viewer" | "admin" | "owner";

export type SharedProjectScopeSummary = {
  readonly state: SharedProjectScopeState;
  readonly mutable: boolean;
  readonly summary: string;
  readonly detail: string;
  readonly projectSlug: string;
  readonly currentAccessRole: SharedProjectAccessRole | null;
  readonly ownerType: "user" | "organization" | "team" | null;
  readonly ownerId: string | null;
  readonly ownerSlug: string | null;
  readonly ownerName: string | null;
};

type ActiveScopeContext = {
  readonly accessControlMode: string | null;
  readonly organizationId: string | null;
  readonly organizationName: string | null;
  readonly teamId: string | null;
  readonly teamName: string | null;
};

type ParsedBrokerProject = {
  readonly slug: string;
  readonly currentAccessRole: SharedProjectAccessRole;
  readonly ownership: {
    readonly mode: "local" | "shared";
    readonly ownerType: "user" | "organization" | "team";
    readonly ownerId: string | null;
    readonly ownerSlug: string | null;
    readonly ownerName: string | null;
  };
};

export async function resolveSharedProjectScope(input: {
  readonly cwd: string;
  readonly fetchImpl?: BrokerFetchLike;
}): Promise<SharedProjectScopeSummary | null> {
  const project = await findProjectContext(input.cwd);
  if (!project) {
    return null;
  }

  const config = await readProjectConfig(project);
  const projectSlug = normalizeProjectSlug(config.name);
  if (!projectSlug) {
    return null;
  }

  const activeContext = await readActiveScopeContext({
    fetchImpl: input.fetchImpl,
  });
  const projectResult = await requestHackAuthBroker({
    path: `/v1/auth/projects/${encodeURIComponent(projectSlug)}`,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });

  if (projectResult.ok) {
    const parsedProject = parseBrokerProject(projectResult.value.project);
    if (!parsedProject) {
      return createSharedProjectScopeSummary({
        state: "broker_error",
        projectSlug,
        detail:
          "Hack returned an incomplete shared project payload while checking the current org/team scope.",
      });
    }
    if (parsedProject.ownership.mode === "local") {
      return createSharedProjectScopeSummary({
        state: "local_only",
        projectSlug,
        project: parsedProject,
      });
    }
    return createSharedProjectScopeSummary({
      state: "shared_visible",
      projectSlug,
      project: parsedProject,
      activeContext,
    });
  }

  const sharedLocallyConfigured = config.ownership.mode === "shared";
  if (projectResult.loginRequired) {
    if (!sharedLocallyConfigured) {
      return createSharedProjectScopeSummary({
        state: "local_only",
        projectSlug,
      });
    }
    return createSharedProjectScopeSummary({
      state: "auth_required",
      projectSlug,
      activeContext,
      detail:
        "Hack auth login is required before this machine can confirm the active shared org/team scope.",
    });
  }

  if (projectResult.error.includes("project_scope_forbidden")) {
    return createSharedProjectScopeSummary({
      state: "shared_hidden",
      projectSlug,
      activeContext,
      ownerType:
        config.ownership.mode === "shared" ? config.ownership.ownerType : null,
      ownerId:
        config.ownership.mode === "shared" ? config.ownership.ownerId : null,
    });
  }

  if (!sharedLocallyConfigured) {
    return createSharedProjectScopeSummary({
      state: "local_only",
      projectSlug,
    });
  }

  return createSharedProjectScopeSummary({
    state: "broker_error",
    projectSlug,
    activeContext,
    ownerType: config.ownership.ownerType,
    ownerId: config.ownership.ownerId,
    detail: projectResult.error,
  });
}

function createSharedProjectScopeSummary(input: {
  readonly state: SharedProjectScopeState;
  readonly projectSlug: string;
  readonly detail?: string;
  readonly activeContext?: ActiveScopeContext | null;
  readonly project?: ParsedBrokerProject;
  readonly ownerType?: "user" | "organization" | "team" | null;
  readonly ownerId?: string | null;
}): SharedProjectScopeSummary {
  const project = input.project;
  const ownerType = project?.ownership.ownerType ?? input.ownerType ?? null;
  const ownerId = project?.ownership.ownerId ?? input.ownerId ?? null;
  const ownerSlug = project?.ownership.ownerSlug ?? null;
  const ownerName = project?.ownership.ownerName ?? null;
  const currentAccessRole = project?.currentAccessRole ?? null;
  const contextLabel = formatActiveScopeContext({
    activeContext: input.activeContext ?? null,
  });

  if (input.state === "local_only") {
    return {
      state: input.state,
      mutable: true,
      summary: `This repo currently uses local project ownership for ${input.projectSlug}.`,
      detail:
        input.detail ??
        "GitHub and Linear readiness remain repo-local until this project is registered with a shared organization or team owner.",
      projectSlug: input.projectSlug,
      currentAccessRole,
      ownerType,
      ownerId,
      ownerSlug,
      ownerName,
    };
  }

  if (input.state === "shared_visible") {
    const mutable =
      currentAccessRole === "admin" || currentAccessRole === "owner";
    return {
      state: input.state,
      mutable,
      summary: mutable
        ? `Shared project scope is active for ${input.projectSlug}.`
        : `Shared project scope is read-only for ${input.projectSlug}.`,
      detail: mutable
        ? `${contextLabel} can manage shared integration resources for this repo.`
        : `${contextLabel} can inspect shared integration resources for this repo, but mutations stay blocked while the current role is viewer.`,
      projectSlug: input.projectSlug,
      currentAccessRole,
      ownerType,
      ownerId,
      ownerSlug,
      ownerName,
    };
  }

  if (input.state === "shared_hidden") {
    return {
      state: input.state,
      mutable: false,
      summary: `Shared project scope denied for ${input.projectSlug}.`,
      detail:
        input.detail ??
        "The current org/team context does not expose the shared project registration for this repo.",
      projectSlug: input.projectSlug,
      currentAccessRole,
      ownerType,
      ownerId,
      ownerSlug,
      ownerName,
    };
  }

  if (input.state === "auth_required") {
    return {
      state: input.state,
      mutable: false,
      summary: `Hack auth login is required to verify shared project scope for ${input.projectSlug}.`,
      detail:
        input.detail ??
        "Run `hack auth login` after switching to the intended shared org/team context.",
      projectSlug: input.projectSlug,
      currentAccessRole,
      ownerType,
      ownerId,
      ownerSlug,
      ownerName,
    };
  }

  if (input.state === "unregistered") {
    return {
      state: input.state,
      mutable: false,
      summary: `No shared project registration is visible for ${input.projectSlug}.`,
      detail:
        input.detail ??
        "Register the repo with a shared organization or team owner before expecting broker-managed integration scope.",
      projectSlug: input.projectSlug,
      currentAccessRole,
      ownerType,
      ownerId,
      ownerSlug,
      ownerName,
    };
  }

  return {
    state: "broker_error",
    mutable: false,
    summary: `Hack could not verify shared project scope for ${input.projectSlug}.`,
    detail:
      input.detail ??
      "Refresh Hack auth and retry the repo-bound status command.",
    projectSlug: input.projectSlug,
    currentAccessRole,
    ownerType,
    ownerId,
    ownerSlug,
    ownerName,
  };
}

async function readActiveScopeContext(input: {
  readonly fetchImpl?: BrokerFetchLike;
}): Promise<ActiveScopeContext | null> {
  const result = await requestHackAuthBroker({
    path: "/v1/auth/me",
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });
  if (!result.ok) {
    return null;
  }
  return {
    accessControlMode: readOptionalString(result.value.accessControlMode),
    organizationId: readOptionalString(
      readRecord(result.value.activeOrganization)?.id
    ),
    organizationName: readOptionalString(
      readRecord(result.value.activeOrganization)?.name
    ),
    teamId: readOptionalString(readRecord(result.value.activeTeam)?.id),
    teamName: readOptionalString(readRecord(result.value.activeTeam)?.name),
  };
}

function parseBrokerProject(value: unknown): ParsedBrokerProject | null {
  const record = readRecord(value);
  const slug = readOptionalString(record?.slug);
  const currentAccessRole = readAccessRole(record?.currentAccessRole);
  const ownership = parseBrokerProjectOwnership(record?.ownership);
  if (!(slug && currentAccessRole && ownership)) {
    return null;
  }
  return {
    slug,
    currentAccessRole,
    ownership,
  };
}

function parseBrokerProjectOwnership(
  value: unknown
): ParsedBrokerProject["ownership"] | null {
  const record = readRecord(value);
  const mode = readOwnershipMode(record?.mode);
  const ownerType = readOwnerType(record?.ownerType);
  if (!(mode && ownerType)) {
    return null;
  }
  return {
    mode,
    ownerType,
    ownerId: readOptionalString(record?.ownerId),
    ownerSlug: readOptionalString(record?.ownerSlug),
    ownerName: readOptionalString(record?.ownerName),
  };
}

function normalizeProjectSlug(value: string | undefined): string | null {
  const normalized = sanitizeProjectSlug(value?.trim() ?? "");
  return normalized.length > 0 ? normalized : null;
}

function formatActiveScopeContext(input: {
  readonly activeContext: ActiveScopeContext | null;
}): string {
  const activeContext = input.activeContext;
  if (activeContext?.teamName || activeContext?.teamId) {
    return `The active team ${activeContext.teamName ?? activeContext.teamId}`;
  }
  if (activeContext?.organizationName || activeContext?.organizationId) {
    return `The active organization ${
      activeContext.organizationName ?? activeContext.organizationId
    }`;
  }
  return "The current Hack account context";
}

function readOwnershipMode(value: unknown): "local" | "shared" | null {
  return value === "local" || value === "shared" ? value : null;
}

function readOwnerType(
  value: unknown
): "user" | "organization" | "team" | null {
  return value === "user" || value === "organization" || value === "team"
    ? value
    : null;
}

function readAccessRole(value: unknown): SharedProjectAccessRole | null {
  return value === "viewer" || value === "admin" || value === "owner"
    ? value
    : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}
