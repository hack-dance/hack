import { randomUUID } from "node:crypto";

import type {
  OrganizationRecord,
  OrgTeamsStore,
  TeamRecord,
} from "../orgs/service.ts";

export type ProjectOwnershipMode = "local" | "shared";
export type ProjectOwnerType = "user" | "organization" | "team";
export type ProjectOwnershipManager = "local" | "broker";
export type ProjectAccessRole = "viewer" | "admin" | "owner";
export type ProjectAccessScope = "organization" | "team";

export type ProjectOwnershipRecord = {
  readonly mode: ProjectOwnershipMode;
  readonly ownerType: ProjectOwnerType;
  readonly ownerId: string | null;
  readonly ownerSlug: string | null;
  readonly ownerName: string | null;
  readonly managedBy: ProjectOwnershipManager;
};

export type ProjectRecord = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly ownership: ProjectOwnershipRecord;
  readonly currentAccessRole: ProjectAccessRole;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ProjectAccessGrantRecord = {
  readonly id: string;
  readonly scope: ProjectAccessScope;
  readonly role: Exclude<ProjectAccessRole, "owner">;
  readonly subjectId: string;
  readonly subjectSlug: string;
  readonly subjectName: string;
  readonly organizationId: string;
  readonly teamId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type RegisterProjectResult =
  | {
      readonly ok: true;
      readonly status: "created" | "updated";
      readonly project: ProjectRecord;
    }
  | {
      readonly ok: false;
      readonly error:
        | "project_owner_required"
        | "project_owner_not_visible"
        | "project_registration_conflict";
      readonly existing?: ProjectRecord;
      readonly incoming?: {
        readonly slug: string;
        readonly name: string;
        readonly ownership: ProjectOwnershipRecord;
      };
    };

export type ProjectAccessMutationResult =
  | {
      readonly ok: true;
      readonly status: "created" | "updated" | "removed";
      readonly access: ProjectAccessGrantRecord;
    }
  | {
      readonly ok: false;
      readonly error:
        | "project_not_found"
        | "project_access_forbidden"
        | "project_access_target_not_visible"
        | "project_access_conflict"
        | "project_access_grant_not_found"
        | "project_access_local_mode";
    };

export type ProjectStore = {
  readonly registerProject: (input: {
    readonly slug: string;
    readonly name?: string;
    readonly mode: "local" | "organization" | "team";
    readonly orgKey?: string | null;
    readonly teamKey?: string | null;
    readonly actorUserId: string;
    readonly actorEmail: string | null;
  }) => Promise<RegisterProjectResult>;
  readonly listProjects: (input: {
    readonly actorUserId: string;
  }) => Promise<readonly ProjectRecord[]>;
  readonly getProject: (input: {
    readonly projectKey: string;
    readonly actorUserId: string;
  }) => Promise<ProjectRecord | null>;
  readonly listAccess: (input: {
    readonly projectKey: string;
    readonly actorUserId: string;
  }) => Promise<readonly ProjectAccessGrantRecord[] | null>;
  readonly grantAccess: (input: {
    readonly projectKey: string;
    readonly actorUserId: string;
    readonly scope: ProjectAccessScope;
    readonly role: Exclude<ProjectAccessRole, "owner">;
    readonly orgKey?: string | null;
    readonly teamKey?: string | null;
  }) => Promise<ProjectAccessMutationResult>;
  readonly revokeAccess: (input: {
    readonly projectKey: string;
    readonly actorUserId: string;
    readonly grantId: string;
  }) => Promise<ProjectAccessMutationResult>;
};

type StoredProject = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly ownership: ProjectOwnershipRecord;
  readonly createdByUserId: string;
  readonly createdByEmail: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type StoredAccessGrant = {
  readonly id: string;
  readonly projectId: string;
  readonly scope: ProjectAccessScope;
  readonly role: Exclude<ProjectAccessRole, "owner">;
  readonly subjectId: string;
  readonly subjectSlug: string;
  readonly subjectName: string;
  readonly organizationId: string;
  readonly teamId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type VisibilityContext = {
  readonly organizations: readonly OrganizationRecord[];
  readonly teams: readonly TeamRecord[];
  readonly organizationIds: ReadonlySet<string>;
  readonly teamIds: ReadonlySet<string>;
};

export class InMemoryProjectStore implements ProjectStore {
  private readonly orgStore: OrgTeamsStore;
  private readonly projectsById = new Map<string, StoredProject>();
  private readonly projectIdBySlug = new Map<string, string>();
  private readonly grantsByProjectId = new Map<
    string,
    Map<string, StoredAccessGrant>
  >();

  constructor(input: {
    readonly orgStore: OrgTeamsStore;
  }) {
    this.orgStore = input.orgStore;
  }

  async registerProject(input: {
    readonly slug: string;
    readonly name?: string;
    readonly mode: "local" | "organization" | "team";
    readonly orgKey?: string | null;
    readonly teamKey?: string | null;
    readonly actorUserId: string;
    readonly actorEmail: string | null;
  }): Promise<RegisterProjectResult> {
    const slug = normalizeProjectSlug(input.slug);
    const name = normalizeProjectName({
      slug,
      value: input.name,
    });
    const actorUserId = normalizeRequiredText(input.actorUserId);
    const desiredOwnership = await resolveDesiredOwnership({
      actorUserId,
      mode: input.mode,
      orgKey: input.orgKey,
      teamKey: input.teamKey,
      orgStore: this.orgStore,
    });
    if (!desiredOwnership.ok) {
      return desiredOwnership;
    }

    const existing = this.readProjectByKey(slug);
    if (!existing) {
      const now = new Date().toISOString();
      const project: StoredProject = {
        id: randomUUID(),
        slug,
        name,
        ownership: desiredOwnership.ownership,
        createdByUserId: actorUserId,
        createdByEmail: normalizeOptionalText(input.actorEmail),
        createdAt: now,
        updatedAt: now,
      };
      this.projectsById.set(project.id, project);
      this.projectIdBySlug.set(project.slug, project.id);
      return {
        ok: true,
        status: "created",
        project: await this.toProjectRecord({
          project,
          actorUserId,
        }),
      };
    }

    const actorRole = await this.resolveCurrentAccessRole({
      project: existing,
      actorUserId,
    });
    if (!(actorRole === "owner" || actorRole === "admin")) {
      return {
        ok: false,
        error: "project_registration_conflict",
        existing: await this.toProjectRecord({
          project: existing,
          actorUserId: existing.createdByUserId,
        }),
        incoming: {
          slug,
          name,
          ownership: desiredOwnership.ownership,
        },
      };
    }

    const ownershipChanged = !projectOwnershipEquals({
      left: existing.ownership,
      right: desiredOwnership.ownership,
    });
    const nextProject: StoredProject = {
      ...existing,
      name,
      ownership: desiredOwnership.ownership,
      updatedAt: new Date().toISOString(),
    };
    this.projectsById.set(existing.id, nextProject);
    if (ownershipChanged) {
      this.grantsByProjectId.delete(existing.id);
    }

    return {
      ok: true,
      status: "updated",
      project: await this.toProjectRecord({
        project: nextProject,
        actorUserId,
      }),
    };
  }

  async listProjects(input: {
    readonly actorUserId: string;
  }): Promise<readonly ProjectRecord[]> {
    const actorUserId = normalizeRequiredText(input.actorUserId);
    const visible = await Promise.all(
      [...this.projectsById.values()].map(async (project) => {
        const role = await this.resolveCurrentAccessRole({
          project,
          actorUserId,
        });
        if (!role) {
          return null;
        }
        return toProjectRecord({
          project,
          currentAccessRole: role,
        });
      })
    );
    return visible
      .filter((project): project is ProjectRecord => Boolean(project))
      .sort((left, right) => left.slug.localeCompare(right.slug));
  }

  async getProject(input: {
    readonly projectKey: string;
    readonly actorUserId: string;
  }): Promise<ProjectRecord | null> {
    const actorUserId = normalizeRequiredText(input.actorUserId);
    const project = this.readProjectByKey(input.projectKey);
    if (!project) {
      return null;
    }
    const role = await this.resolveCurrentAccessRole({
      project,
      actorUserId,
    });
    if (!role) {
      return null;
    }
    return toProjectRecord({
      project,
      currentAccessRole: role,
    });
  }

  async listAccess(input: {
    readonly projectKey: string;
    readonly actorUserId: string;
  }): Promise<readonly ProjectAccessGrantRecord[] | null> {
    const actorUserId = normalizeRequiredText(input.actorUserId);
    const project = this.readProjectByKey(input.projectKey);
    if (!project) {
      return null;
    }
    const role = await this.resolveCurrentAccessRole({
      project,
      actorUserId,
    });
    if (!role) {
      return null;
    }
    const grants = [
      ...(this.grantsByProjectId.get(project.id)?.values() ?? []),
    ];
    return grants
      .map((grant) => toProjectAccessGrantRecord({ grant }))
      .sort((left, right) => left.subjectSlug.localeCompare(right.subjectSlug));
  }

  async grantAccess(input: {
    readonly projectKey: string;
    readonly actorUserId: string;
    readonly scope: ProjectAccessScope;
    readonly role: Exclude<ProjectAccessRole, "owner">;
    readonly orgKey?: string | null;
    readonly teamKey?: string | null;
  }): Promise<ProjectAccessMutationResult> {
    const actorUserId = normalizeRequiredText(input.actorUserId);
    const project = this.readProjectByKey(input.projectKey);
    if (!project) {
      return {
        ok: false,
        error: "project_not_found",
      };
    }
    const actorRole = await this.resolveCurrentAccessRole({
      project,
      actorUserId,
    });
    if (!(actorRole === "owner" || actorRole === "admin")) {
      return {
        ok: false,
        error: "project_access_forbidden",
      };
    }
    if (project.ownership.mode === "local") {
      return {
        ok: false,
        error: "project_access_local_mode",
      };
    }

    const subject = await resolveAccessSubject({
      actorUserId,
      scope: input.scope,
      orgKey: input.orgKey,
      teamKey: input.teamKey,
      orgStore: this.orgStore,
    });
    if (!subject) {
      return {
        ok: false,
        error: "project_access_target_not_visible",
      };
    }
    if (
      project.ownership.ownerType === subject.scope &&
      project.ownership.ownerId === subject.subjectId
    ) {
      return {
        ok: false,
        error: "project_access_conflict",
      };
    }

    const projectGrants =
      this.grantsByProjectId.get(project.id) ??
      new Map<string, StoredAccessGrant>();
    const existing = [...projectGrants.values()].find((grant) => {
      return (
        grant.scope === subject.scope && grant.subjectId === subject.subjectId
      );
    });
    const now = new Date().toISOString();
    const nextGrant: StoredAccessGrant = {
      id: existing?.id ?? randomUUID(),
      projectId: project.id,
      scope: subject.scope,
      role: input.role,
      subjectId: subject.subjectId,
      subjectSlug: subject.subjectSlug,
      subjectName: subject.subjectName,
      organizationId: subject.organizationId,
      teamId: subject.teamId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    projectGrants.set(nextGrant.id, nextGrant);
    this.grantsByProjectId.set(project.id, projectGrants);
    return {
      ok: true,
      status: existing ? "updated" : "created",
      access: toProjectAccessGrantRecord({
        grant: nextGrant,
      }),
    };
  }

  async revokeAccess(input: {
    readonly projectKey: string;
    readonly actorUserId: string;
    readonly grantId: string;
  }): Promise<ProjectAccessMutationResult> {
    const actorUserId = normalizeRequiredText(input.actorUserId);
    const project = this.readProjectByKey(input.projectKey);
    if (!project) {
      return {
        ok: false,
        error: "project_not_found",
      };
    }
    const actorRole = await this.resolveCurrentAccessRole({
      project,
      actorUserId,
    });
    if (!(actorRole === "owner" || actorRole === "admin")) {
      return {
        ok: false,
        error: "project_access_forbidden",
      };
    }

    const projectGrants = this.grantsByProjectId.get(project.id);
    const grantId = normalizeRequiredText(input.grantId);
    const existing = projectGrants?.get(grantId) ?? null;
    if (!existing) {
      return {
        ok: false,
        error: "project_access_grant_not_found",
      };
    }
    projectGrants?.delete(grantId);
    return {
      ok: true,
      status: "removed",
      access: toProjectAccessGrantRecord({
        grant: existing,
      }),
    };
  }

  private readProjectByKey(projectKey: string): StoredProject | null {
    const key = normalizeOptionalText(projectKey);
    if (!key) {
      return null;
    }
    const byId = this.projectsById.get(key);
    if (byId) {
      return byId;
    }
    const bySlugId = this.projectIdBySlug.get(normalizeProjectSlug(key));
    return bySlugId ? (this.projectsById.get(bySlugId) ?? null) : null;
  }

  private async toProjectRecord(input: {
    readonly project: StoredProject;
    readonly actorUserId: string;
  }): Promise<ProjectRecord> {
    const currentAccessRole =
      (await this.resolveCurrentAccessRole({
        project: input.project,
        actorUserId: input.actorUserId,
      })) ?? "viewer";
    return toProjectRecord({
      project: input.project,
      currentAccessRole,
    });
  }

  private async resolveCurrentAccessRole(input: {
    readonly project: StoredProject;
    readonly actorUserId: string;
  }): Promise<ProjectAccessRole | null> {
    const actorUserId = normalizeOptionalText(input.actorUserId);
    if (!actorUserId) {
      return null;
    }
    if (
      input.project.ownership.mode === "local" &&
      input.project.createdByUserId === actorUserId
    ) {
      return "owner";
    }

    const visibility = await this.resolveVisibilityContext({
      actorUserId,
    });
    if (input.project.ownership.mode === "shared") {
      const ownerVisible =
        (input.project.ownership.ownerType === "organization" &&
          input.project.ownership.ownerId &&
          visibility.organizationIds.has(input.project.ownership.ownerId)) ||
        (input.project.ownership.ownerType === "team" &&
          input.project.ownership.ownerId &&
          visibility.teamIds.has(input.project.ownership.ownerId));
      if (ownerVisible) {
        return "owner";
      }
    }

    const grants = [
      ...(this.grantsByProjectId.get(input.project.id)?.values() ?? []),
    ];
    let bestRole: Exclude<ProjectAccessRole, "owner"> | null = null;
    for (const grant of grants) {
      const visible =
        (grant.scope === "organization" &&
          visibility.organizationIds.has(grant.subjectId)) ||
        (grant.scope === "team" && visibility.teamIds.has(grant.subjectId));
      if (!visible) {
        continue;
      }
      if (
        !bestRole ||
        compareProjectAccessRole({ left: grant.role, right: bestRole }) > 0
      ) {
        bestRole = grant.role;
      }
    }
    return bestRole;
  }

  private async resolveVisibilityContext(input: {
    readonly actorUserId: string;
  }): Promise<VisibilityContext> {
    const [organizations, teams] = await Promise.all([
      this.orgStore.listOrganizations({
        actorUserId: input.actorUserId,
      }),
      this.orgStore.listTeams({
        actorUserId: input.actorUserId,
        orgKey: null,
      }),
    ]);
    return {
      organizations,
      teams,
      organizationIds: new Set(
        organizations.map((organization) => organization.id)
      ),
      teamIds: new Set(teams.map((team) => team.id)),
    };
  }
}

async function resolveDesiredOwnership(input: {
  readonly actorUserId: string;
  readonly mode: "local" | "organization" | "team";
  readonly orgKey?: string | null;
  readonly teamKey?: string | null;
  readonly orgStore: OrgTeamsStore;
}): Promise<
  | {
      readonly ok: true;
      readonly ownership: ProjectOwnershipRecord;
    }
  | {
      readonly ok: false;
      readonly error: "project_owner_required" | "project_owner_not_visible";
    }
> {
  if (input.mode === "local") {
    return {
      ok: true,
      ownership: defaultLocalProjectOwnership(),
    };
  }
  if (input.mode === "organization") {
    const organizationKey = normalizeOptionalText(input.orgKey);
    if (!organizationKey) {
      return {
        ok: false,
        error: "project_owner_required",
      };
    }
    const organization = await input.orgStore.getOrganization({
      orgKey: organizationKey,
      actorUserId: input.actorUserId,
    });
    if (!organization) {
      return {
        ok: false,
        error: "project_owner_not_visible",
      };
    }
    return {
      ok: true,
      ownership: {
        mode: "shared",
        ownerType: "organization",
        ownerId: organization.id,
        ownerSlug: organization.slug,
        ownerName: organization.name,
        managedBy: "broker",
      },
    };
  }

  const orgKey = normalizeOptionalText(input.orgKey);
  const teamKey = normalizeOptionalText(input.teamKey);
  if (!(orgKey && teamKey)) {
    return {
      ok: false,
      error: "project_owner_required",
    };
  }
  const team = await input.orgStore.getTeam({
    teamKey,
    orgKey,
    actorUserId: input.actorUserId,
  });
  if (!team) {
    return {
      ok: false,
      error: "project_owner_not_visible",
    };
  }
  return {
    ok: true,
    ownership: {
      mode: "shared",
      ownerType: "team",
      ownerId: team.id,
      ownerSlug: team.slug,
      ownerName: team.name,
      managedBy: "broker",
    },
  };
}

async function resolveAccessSubject(input: {
  readonly actorUserId: string;
  readonly scope: ProjectAccessScope;
  readonly orgKey?: string | null;
  readonly teamKey?: string | null;
  readonly orgStore: OrgTeamsStore;
}): Promise<{
  readonly scope: ProjectAccessScope;
  readonly subjectId: string;
  readonly subjectSlug: string;
  readonly subjectName: string;
  readonly organizationId: string;
  readonly teamId: string | null;
} | null> {
  if (input.scope === "organization") {
    const organizationKey = normalizeOptionalText(input.orgKey);
    if (!organizationKey) {
      return null;
    }
    const organization = await input.orgStore.getOrganization({
      orgKey: organizationKey,
      actorUserId: input.actorUserId,
    });
    if (!organization) {
      return null;
    }
    return {
      scope: "organization",
      subjectId: organization.id,
      subjectSlug: organization.slug,
      subjectName: organization.name,
      organizationId: organization.id,
      teamId: null,
    };
  }

  const organizationKey = normalizeOptionalText(input.orgKey);
  const teamKey = normalizeOptionalText(input.teamKey);
  if (!(organizationKey && teamKey)) {
    return null;
  }
  const team = await input.orgStore.getTeam({
    teamKey,
    orgKey: organizationKey,
    actorUserId: input.actorUserId,
  });
  if (!team) {
    return null;
  }
  return {
    scope: "team",
    subjectId: team.id,
    subjectSlug: team.slug,
    subjectName: team.name,
    organizationId: team.organizationId,
    teamId: team.id,
  };
}

function toProjectRecord(input: {
  readonly project: StoredProject;
  readonly currentAccessRole: ProjectAccessRole;
}): ProjectRecord {
  return {
    id: input.project.id,
    slug: input.project.slug,
    name: input.project.name,
    ownership: input.project.ownership,
    currentAccessRole: input.currentAccessRole,
    createdAt: input.project.createdAt,
    updatedAt: input.project.updatedAt,
  };
}

function toProjectAccessGrantRecord(input: {
  readonly grant: StoredAccessGrant;
}): ProjectAccessGrantRecord {
  return {
    id: input.grant.id,
    scope: input.grant.scope,
    role: input.grant.role,
    subjectId: input.grant.subjectId,
    subjectSlug: input.grant.subjectSlug,
    subjectName: input.grant.subjectName,
    organizationId: input.grant.organizationId,
    teamId: input.grant.teamId,
    createdAt: input.grant.createdAt,
    updatedAt: input.grant.updatedAt,
  };
}

function normalizeProjectSlug(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const normalized = trimmed
    .replaceAll(/[^a-z0-9-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "");
  return normalized.length > 0 ? normalized : "project";
}

function normalizeProjectName(input: {
  readonly slug: string;
  readonly value?: string;
}): string {
  const normalized = normalizeOptionalText(input.value);
  return normalized ?? input.slug;
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRequiredText(value: unknown): string {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new Error("Missing required text value.");
  }
  return normalized;
}

function defaultLocalProjectOwnership(): ProjectOwnershipRecord {
  return {
    mode: "local",
    ownerType: "user",
    ownerId: null,
    ownerSlug: null,
    ownerName: null,
    managedBy: "local",
  };
}

function compareProjectAccessRole(input: {
  readonly left: Exclude<ProjectAccessRole, "owner">;
  readonly right: Exclude<ProjectAccessRole, "owner">;
}): number {
  const rank = {
    viewer: 1,
    admin: 2,
  } as const;
  return rank[input.left] - rank[input.right];
}

function projectOwnershipEquals(input: {
  readonly left: ProjectOwnershipRecord;
  readonly right: ProjectOwnershipRecord;
}): boolean {
  return (
    input.left.mode === input.right.mode &&
    input.left.ownerType === input.right.ownerType &&
    input.left.ownerId === input.right.ownerId &&
    input.left.ownerSlug === input.right.ownerSlug &&
    input.left.ownerName === input.right.ownerName &&
    input.left.managedBy === input.right.managedBy
  );
}
