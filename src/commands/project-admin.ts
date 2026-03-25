import { resolve } from "node:path";
import type { CommandHandlerFor } from "../cli/command.ts";
import { CliUsageError, defineCommand, withHandler } from "../cli/command.ts";
import { optJson, optPath, optProject } from "../cli/options.ts";
import { HACK_PROJECT_DIR_PRIMARY } from "../constants.ts";
import { requestHackAuthBroker } from "../lib/auth-broker-client.ts";
import {
  findProjectContext,
  readProjectConfig,
  sanitizeProjectSlug,
} from "../lib/project.ts";
import { resolveRegisteredProjectByName } from "../lib/projects-registry.ts";
import { display } from "../ui/display.ts";

const ownerShowOptions = [optPath, optProject, optJson] as const;

const ownerShowSpec = defineCommand({
  name: "show",
  summary: "Show the explicit ownership for the current project",
  group: "Project",
  options: ownerShowOptions,
  positionals: [],
  subcommands: [],
} as const);

const ownerSpec = defineCommand({
  name: "owner",
  summary: "Inspect or manage project ownership",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: [ownerShowSpec],
} as const);

const projectSpec = defineCommand({
  name: "project",
  summary: "Inspect or manage project metadata",
  group: "Project",
  options: [],
  positionals: [],
  subcommands: [ownerSpec],
} as const);

const handleOwnerShow: CommandHandlerFor<typeof ownerShowSpec> = async ({
  ctx,
  args,
}): Promise<number> => {
  const project = await resolveProjectTarget({
    cwd: ctx.cwd,
    pathOpt: args.options.path,
    projectOpt: args.options.project,
  });
  const config = await readProjectConfig(project);
  if (config.parseError) {
    const configPath = config.configPath ?? project.configFile;
    throw new Error(`Failed to parse ${configPath}: ${config.parseError}`);
  }
  const payload = {
    project_root: project.projectRoot,
    ownership: {
      mode: config.ownership.mode,
      owner_type: config.ownership.ownerType,
      owner_id: config.ownership.ownerId,
      managed_by: config.ownership.managedBy,
    },
    ...(await resolveBrokerOwnershipView({
      projectSlug: resolveProjectSlug(config.name),
      ownership: config.ownership,
    })),
  };

  if (args.options.json === true) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  await display.kv({
    entries: [
      ["Project root", payload.project_root],
      ["Ownership mode", payload.ownership.mode],
      ["Owner type", payload.ownership.owner_type],
      ["Owner id", payload.ownership.owner_id ?? ""],
      ["Managed by", payload.ownership.managed_by],
      [
        "Broker registration",
        payload.broker_registration ? payload.broker_registration.slug : "",
      ],
      ["Conflict", payload.conflict?.message ?? ""],
    ],
  });
  return 0;
};

const ownerCommand = {
  ...ownerSpec,
  subcommands: [withHandler(ownerShowSpec, handleOwnerShow)],
} as const;

export const projectCommand = {
  ...projectSpec,
  subcommands: [ownerCommand],
} as const;

async function resolveProjectTarget(input: {
  readonly cwd: string;
  readonly pathOpt: string | undefined;
  readonly projectOpt: string | undefined;
}) {
  if (input.pathOpt && input.projectOpt) {
    throw new CliUsageError("Use either --path or --project (not both).");
  }

  if (input.projectOpt) {
    const name = sanitizeProjectSlug(input.projectOpt);
    if (name.length === 0) {
      throw new CliUsageError("Invalid --project value.");
    }
    const project = await resolveRegisteredProjectByName({ name });
    if (!project) {
      throw new CliUsageError(
        `Unknown project "${name}". Run 'hack init' in that repo (or run 'hack projects' to see registered projects).`
      );
    }
    return project;
  }

  const startDir = input.pathOpt
    ? resolve(input.cwd, input.pathOpt)
    : input.cwd;
  const project = await findProjectContext(startDir);
  if (!project) {
    throw new Error(
      `No ${HACK_PROJECT_DIR_PRIMARY}/ (or legacy .dev/) found. Run: hack init`
    );
  }
  return project;
}

async function resolveBrokerOwnershipView(input: {
  readonly projectSlug: string | null;
  readonly ownership: {
    readonly mode: "local" | "shared";
    readonly ownerType: "user" | "team" | "organization";
    readonly ownerId: string | null;
    readonly managedBy: "local" | "broker";
  };
}) {
  if (!input.projectSlug) {
    return {};
  }

  const response = await requestHackAuthBroker({
    path: `/v1/auth/projects/${encodeURIComponent(input.projectSlug)}`,
  });
  if (!response.ok) {
    return {};
  }

  const project = normalizeBrokerProject(response.value.project);
  if (!project) {
    return {};
  }

  const access = normalizeBrokerAccessList(response.value.access);
  const brokerRegistration = {
    id: project.id,
    slug: project.slug,
    name: project.name,
    current_access_role: project.currentAccessRole,
    ownership: {
      mode: project.ownership.mode,
      owner_type: project.ownership.ownerType,
      owner_id: project.ownership.ownerId,
      owner_slug: project.ownership.ownerSlug,
      owner_name: project.ownership.ownerName,
      managed_by: project.ownership.managedBy,
    },
    access,
  };

  const conflict =
    input.ownership.ownerType !== project.ownership.ownerType ||
    input.ownership.ownerId !== project.ownership.ownerId ||
    input.ownership.mode !== project.ownership.mode
      ? {
          kind: "ownership_mismatch",
          message:
            "The local project ownership does not match the broker registration for this project.",
        }
      : undefined;

  return {
    broker_registration: brokerRegistration,
    ...(conflict ? { conflict } : {}),
  };
}

function resolveProjectSlug(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  return sanitizeProjectSlug(trimmed);
}

function normalizeBrokerProject(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value.id);
  const slug = readString(value.slug);
  const name = readString(value.name);
  const currentAccessRole = readRole(value.currentAccessRole);
  const ownership = normalizeBrokerOwnership(value.ownership);
  if (!(id && slug && name && currentAccessRole && ownership)) {
    return null;
  }
  return {
    id,
    slug,
    name,
    currentAccessRole,
    ownership,
  };
}

function normalizeBrokerOwnership(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  const mode = readOwnershipMode(value.mode);
  const ownerType = readOwnerType(value.ownerType);
  const managedBy = readManagedBy(value.managedBy);
  if (!(mode && ownerType && managedBy)) {
    return null;
  }
  return {
    mode,
    ownerType,
    ownerId: readNullableString(value.ownerId),
    ownerSlug: readNullableString(value.ownerSlug),
    ownerName: readNullableString(value.ownerName),
    managedBy,
  };
}

function normalizeBrokerAccessList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeBrokerAccess(entry))
    .filter(
      (entry): entry is NonNullable<ReturnType<typeof normalizeBrokerAccess>> =>
        Boolean(entry)
    );
}

function normalizeBrokerAccess(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value.id);
  const scope =
    value.scope === "organization" || value.scope === "team"
      ? value.scope
      : null;
  const role =
    value.role === "viewer" || value.role === "admin" ? value.role : null;
  const subjectId = readString(value.subjectId);
  const subjectSlug = readString(value.subjectSlug);
  const subjectName = readString(value.subjectName);
  const organizationId = readString(value.organizationId);
  const createdAt = readString(value.createdAt);
  const updatedAt = readString(value.updatedAt);
  if (
    !(
      id &&
      scope &&
      role &&
      subjectId &&
      subjectSlug &&
      subjectName &&
      organizationId &&
      createdAt &&
      updatedAt
    )
  ) {
    return null;
  }
  return {
    id,
    scope,
    role,
    subject_id: subjectId,
    subject_slug: subjectSlug,
    subject_name: subjectName,
    organization_id: organizationId,
    team_id: readNullableString(value.teamId),
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNullableString(value: unknown): string | null {
  return readString(value);
}

function readOwnershipMode(value: unknown): "local" | "shared" | null {
  return value === "local" || value === "shared" ? value : null;
}

function readOwnerType(
  value: unknown
): "user" | "team" | "organization" | null {
  return value === "user" || value === "team" || value === "organization"
    ? value
    : null;
}

function readManagedBy(value: unknown): "local" | "broker" | null {
  return value === "local" || value === "broker" ? value : null;
}

function readRole(value: unknown): "viewer" | "admin" | "owner" | null {
  return value === "viewer" || value === "admin" || value === "owner"
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
