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
        | "project_scope_forbidden"
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
        | "project_scope_forbidden"
        | "project_access_forbidden"
        | "project_access_target_not_visible"
        | "project_access_conflict"
        | "project_access_grant_not_found"
        | "project_access_local_mode";
    };

type ActiveProjectScopeInput = {
  readonly activeOrganizationId?: string | null;
  readonly activeTeamId?: string | null;
};

export type ProjectStore = {
  readonly registerProject: (
    input: {
      readonly slug: string;
      readonly name?: string;
      readonly mode: "local" | "organization" | "team";
      readonly orgKey?: string | null;
      readonly teamKey?: string | null;
      readonly actorUserId: string;
      readonly actorEmail: string | null;
    } & ActiveProjectScopeInput
  ) => Promise<RegisterProjectResult>;
  readonly listProjects: (
    input: {
      readonly actorUserId: string;
    } & ActiveProjectScopeInput
  ) => Promise<readonly ProjectRecord[]>;
  readonly getProject: (
    input: {
      readonly projectKey: string;
      readonly actorUserId: string;
    } & ActiveProjectScopeInput
  ) => Promise<ProjectRecord | null>;
  readonly getProjectVisibility: (
    input: {
      readonly projectKey: string;
      readonly actorUserId: string;
    } & ActiveProjectScopeInput
  ) => Promise<"visible" | "scope_forbidden" | "not_found">;
  readonly listAccess: (
    input: {
      readonly projectKey: string;
      readonly actorUserId: string;
    } & ActiveProjectScopeInput
  ) => Promise<readonly ProjectAccessGrantRecord[] | null>;
  readonly grantAccess: (
    input: {
      readonly projectKey: string;
      readonly actorUserId: string;
      readonly scope: ProjectAccessScope;
      readonly role: Exclude<ProjectAccessRole, "owner">;
      readonly orgKey?: string | null;
      readonly teamKey?: string | null;
    } & ActiveProjectScopeInput
  ) => Promise<ProjectAccessMutationResult>;
  readonly revokeAccess: (
    input: {
      readonly projectKey: string;
      readonly actorUserId: string;
      readonly grantId: string;
    } & ActiveProjectScopeInput
  ) => Promise<ProjectAccessMutationResult>;
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
  readonly scopedOrganizations: readonly OrganizationRecord[];
  readonly scopedTeams: readonly TeamRecord[];
  readonly organizationIds: ReadonlySet<string>;
  readonly teamIds: ReadonlySet<string>;
  readonly scopedOrganizationIds: ReadonlySet<string>;
  readonly scopedTeamIds: ReadonlySet<string>;
  readonly hasActiveScope: boolean;
};

type ProjectAccessState = {
  readonly project: StoredProject | null;
  readonly scopedRole: ProjectAccessRole | null;
  readonly broadRole: ProjectAccessRole | null;
  readonly visibility: VisibilityContext;
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
    readonly activeOrganizationId?: string | null;
    readonly activeTeamId?: string | null;
  }): Promise<RegisterProjectResult> {
    const slug = normalizeProjectSlug(input.slug);
    const name = normalizeProjectName({
      slug,
      value: input.name,
    });
    const actorUserId = normalizeRequiredText(input.actorUserId);
    const visibility = await this.resolveVisibilityContext({
      actorUserId,
      activeOrganizationId: input.activeOrganizationId,
      activeTeamId: input.activeTeamId,
    });
    const desiredOwnership = await resolveDesiredOwnership({
      mode: input.mode,
      orgKey: input.orgKey,
      teamKey: input.teamKey,
      visibility,
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
          visibility,
        }),
      };
    }

    const actorState = await this.resolveProjectAccessState({
      projectKey: existing.slug,
      actorUserId,
      activeOrganizationId: input.activeOrganizationId,
      activeTeamId: input.activeTeamId,
    });
    const actorRole = actorState.scopedRole;
    if (!(actorRole === "owner" || actorRole === "admin")) {
      if (actorState.broadRole) {
        return {
          ok: false,
          error: "project_scope_forbidden",
        };
      }
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
        visibility,
      }),
    };
  }

  async listProjects(input: {
    readonly actorUserId: string;
    readonly activeOrganizationId?: string | null;
    readonly activeTeamId?: string | null;
  }): Promise<readonly ProjectRecord[]> {
    const actorUserId = normalizeRequiredText(input.actorUserId);
    const visibility = await this.resolveVisibilityContext({
      actorUserId,
      activeOrganizationId: input.activeOrganizationId,
      activeTeamId: input.activeTeamId,
    });
    const visible = await Promise.all(
      [...this.projectsById.values()].map(async (project) => {
        const role = await this.resolveCurrentAccessRole({
          project,
          actorUserId,
          visibility,
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
    readonly activeOrganizationId?: string | null;
    readonly activeTeamId?: string | null;
  }): Promise<ProjectRecord | null> {
    const state = await this.resolveProjectAccessState(input);
    if (!(state.project && state.scopedRole)) {
      return null;
    }
    return toProjectRecord({
      project: state.project,
      currentAccessRole: state.scopedRole,
    });
  }

  async getProjectVisibility(input: {
    readonly projectKey: string;
    readonly actorUserId: string;
    readonly activeOrganizationId?: string | null;
    readonly activeTeamId?: string | null;
  }): Promise<"visible" | "scope_forbidden" | "not_found"> {
    const state = await this.resolveProjectAccessState(input);
    if (state.scopedRole) {
      return "visible";
    }
    if (state.broadRole) {
      return "scope_forbidden";
    }
    return "not_found";
  }

  async listAccess(input: {
    readonly projectKey: string;
    readonly actorUserId: string;
    readonly activeOrganizationId?: string | null;
    readonly activeTeamId?: string | null;
  }): Promise<readonly ProjectAccessGrantRecord[] | null> {
    const state = await this.resolveProjectAccessState(input);
    if (!(state.project && state.scopedRole)) {
      return null;
    }
    const grants = [
      ...(this.grantsByProjectId.get(state.project.id)?.values() ?? []),
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
    readonly activeOrganizationId?: string | null;
    readonly activeTeamId?: string | null;
  }): Promise<ProjectAccessMutationResult> {
    const actorUserId = normalizeRequiredText(input.actorUserId);
    const visibility = await this.resolveVisibilityContext({
      actorUserId,
      activeOrganizationId: input.activeOrganizationId,
      activeTeamId: input.activeTeamId,
    });
    const state = await this.resolveProjectAccessState({
      projectKey: input.projectKey,
      actorUserId,
      activeOrganizationId: input.activeOrganizationId,
      activeTeamId: input.activeTeamId,
    });
    if (!state.project) {
      return {
        ok: false,
        error: "project_not_found",
      };
    }
    const project = state.project;
    const actorRole = state.scopedRole;
    if (!actorRole && state.broadRole) {
      return {
        ok: false,
        error: "project_scope_forbidden",
      };
    }
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
      scope: input.scope,
      orgKey: input.orgKey,
      teamKey: input.teamKey,
      visibility,
    });
    if (!subject) {
      return {
        ok: false,
        error:
          resolveAccessSubjectVisibility({
            scope: input.scope,
            orgKey: input.orgKey,
            teamKey: input.teamKey,
            visibility,
          }) === "scope_forbidden"
            ? "project_scope_forbidden"
            : "project_access_target_not_visible",
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
    readonly activeOrganizationId?: string | null;
    readonly activeTeamId?: string | null;
  }): Promise<ProjectAccessMutationResult> {
    const actorUserId = normalizeRequiredText(input.actorUserId);
    const state = await this.resolveProjectAccessState({
      projectKey: input.projectKey,
      actorUserId,
      activeOrganizationId: input.activeOrganizationId,
      activeTeamId: input.activeTeamId,
    });
    if (!state.project) {
      return {
        ok: false,
        error: "project_not_found",
      };
    }
    const project = state.project;
    const actorRole = state.scopedRole;
    if (!actorRole && state.broadRole) {
      return {
        ok: false,
        error: "project_scope_forbidden",
      };
    }
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
    readonly visibility?: VisibilityContext;
  }): Promise<ProjectRecord> {
    const currentAccessRole =
      (await this.resolveCurrentAccessRole({
        project: input.project,
        actorUserId: input.actorUserId,
        ...(input.visibility ? { visibility: input.visibility } : {}),
      })) ?? "viewer";
    return toProjectRecord({
      project: input.project,
      currentAccessRole,
    });
  }

  private async resolveCurrentAccessRole(input: {
    readonly project: StoredProject;
    readonly actorUserId: string;
    readonly visibility?: VisibilityContext;
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

    const visibility =
      input.visibility ??
      (await this.resolveVisibilityContext({
        actorUserId,
      }));
    if (input.project.ownership.mode === "shared") {
      const ownerVisible =
        (input.project.ownership.ownerType === "organization" &&
          input.project.ownership.ownerId &&
          visibility.scopedOrganizationIds.has(
            input.project.ownership.ownerId
          )) ||
        (input.project.ownership.ownerType === "team" &&
          input.project.ownership.ownerId &&
          visibility.scopedTeamIds.has(input.project.ownership.ownerId));
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
          visibility.scopedOrganizationIds.has(grant.subjectId)) ||
        (grant.scope === "team" &&
          visibility.scopedTeamIds.has(grant.subjectId));
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
    readonly activeOrganizationId?: string | null;
    readonly activeTeamId?: string | null;
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
    const organizationIds = new Set(
      organizations.map((organization) => organization.id)
    );
    const teamIds = new Set(teams.map((team) => team.id));
    const activeTeamId = normalizeOptionalText(input.activeTeamId);
    const activeOrganizationId = normalizeOptionalText(
      input.activeOrganizationId
    );
    const activeTeam = activeTeamId
      ? (teams.find((team) => team.id === activeTeamId) ?? null)
      : null;
    const hasActiveScope = Boolean(activeTeam || activeOrganizationId);
    let scopedOrganizations = organizations;
    if (activeTeam) {
      scopedOrganizations = organizations.filter(
        (organization) => organization.id === activeTeam.organizationId
      );
    } else if (activeOrganizationId) {
      scopedOrganizations = organizations.filter(
        (organization) => organization.id === activeOrganizationId
      );
    }
    let scopedTeams = teams;
    if (activeTeam) {
      scopedTeams = [activeTeam];
    } else if (activeOrganizationId) {
      scopedTeams = teams.filter(
        (team) => team.organizationId === activeOrganizationId
      );
    }
    return {
      organizations,
      teams,
      scopedOrganizations,
      scopedTeams,
      organizationIds,
      teamIds,
      scopedOrganizationIds: new Set(
        scopedOrganizations.map((organization) => organization.id)
      ),
      scopedTeamIds: new Set(scopedTeams.map((team) => team.id)),
      hasActiveScope,
    };
  }

  private async resolveProjectAccessState(input: {
    readonly projectKey: string;
    readonly actorUserId: string;
    readonly activeOrganizationId?: string | null;
    readonly activeTeamId?: string | null;
  }): Promise<ProjectAccessState> {
    const actorUserId = normalizeRequiredText(input.actorUserId);
    const project = this.readProjectByKey(input.projectKey);
    const visibility = await this.resolveVisibilityContext({
      actorUserId,
      activeOrganizationId: input.activeOrganizationId,
      activeTeamId: input.activeTeamId,
    });
    if (!project) {
      return {
        project: null,
        scopedRole: null,
        broadRole: null,
        visibility,
      };
    }
    const scopedRole = await this.resolveCurrentAccessRole({
      project,
      actorUserId,
      visibility,
    });
    const broadRole = visibility.hasActiveScope
      ? await this.resolveCurrentAccessRole({
          project,
          actorUserId,
          visibility: {
            ...visibility,
            scopedOrganizations: visibility.organizations,
            scopedTeams: visibility.teams,
            scopedOrganizationIds: visibility.organizationIds,
            scopedTeamIds: visibility.teamIds,
            hasActiveScope: false,
          },
        })
      : scopedRole;
    return {
      project,
      scopedRole,
      broadRole,
      visibility,
    };
  }
}

function resolveDesiredOwnership(input: {
  readonly mode: "local" | "organization" | "team";
  readonly orgKey?: string | null;
  readonly teamKey?: string | null;
  readonly visibility: VisibilityContext;
}):
  | {
      readonly ok: true;
      readonly ownership: ProjectOwnershipRecord;
    }
  | {
      readonly ok: false;
      readonly error:
        | "project_owner_required"
        | "project_owner_not_visible"
        | "project_scope_forbidden";
    } {
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
    const organization = resolveOrganizationByKey({
      key: organizationKey,
      organizations: input.visibility.scopedOrganizations,
    });
    if (!organization) {
      return {
        ok: false,
        error:
          resolveOrganizationByKey({
            key: organizationKey,
            organizations: input.visibility.organizations,
          }) && input.visibility.hasActiveScope
            ? "project_scope_forbidden"
            : "project_owner_not_visible",
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
  const team = resolveTeamByKey({
    organizationKey: orgKey,
    teamKey,
    teams: input.visibility.scopedTeams,
    organizations: input.visibility.scopedOrganizations,
  });
  if (!team) {
    return {
      ok: false,
      error:
        resolveTeamByKey({
          organizationKey: orgKey,
          teamKey,
          teams: input.visibility.teams,
          organizations: input.visibility.organizations,
        }) && input.visibility.hasActiveScope
          ? "project_scope_forbidden"
          : "project_owner_not_visible",
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

function resolveAccessSubject(input: {
  readonly scope: ProjectAccessScope;
  readonly orgKey?: string | null;
  readonly teamKey?: string | null;
  readonly visibility: VisibilityContext;
}): {
  readonly scope: ProjectAccessScope;
  readonly subjectId: string;
  readonly subjectSlug: string;
  readonly subjectName: string;
  readonly organizationId: string;
  readonly teamId: string | null;
} | null {
  if (input.scope === "organization") {
    const organizationKey = normalizeOptionalText(input.orgKey);
    if (!organizationKey) {
      return null;
    }
    const organization = resolveOrganizationByKey({
      key: organizationKey,
      organizations: input.visibility.scopedOrganizations,
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
  const team = resolveTeamByKey({
    organizationKey,
    teamKey,
    teams: input.visibility.scopedTeams,
    organizations: input.visibility.scopedOrganizations,
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

function resolveAccessSubjectVisibility(input: {
  readonly scope: ProjectAccessScope;
  readonly orgKey?: string | null;
  readonly teamKey?: string | null;
  readonly visibility: VisibilityContext;
}): "not_visible" | "scope_forbidden" {
  if (!input.visibility.hasActiveScope) {
    return "not_visible";
  }
  if (input.scope === "organization") {
    const organizationKey = normalizeOptionalText(input.orgKey);
    if (!organizationKey) {
      return "not_visible";
    }
    return resolveOrganizationByKey({
      key: organizationKey,
      organizations: input.visibility.organizations,
    })
      ? "scope_forbidden"
      : "not_visible";
  }
  const organizationKey = normalizeOptionalText(input.orgKey);
  const teamKey = normalizeOptionalText(input.teamKey);
  if (!(organizationKey && teamKey)) {
    return "not_visible";
  }
  return resolveTeamByKey({
    organizationKey,
    teamKey,
    teams: input.visibility.teams,
    organizations: input.visibility.organizations,
  })
    ? "scope_forbidden"
    : "not_visible";
}

function resolveOrganizationByKey(input: {
  readonly key: string;
  readonly organizations: readonly OrganizationRecord[];
}): OrganizationRecord | null {
  return (
    input.organizations.find((organization) => {
      return organization.id === input.key || organization.slug === input.key;
    }) ?? null
  );
}

function resolveTeamByKey(input: {
  readonly organizationKey: string;
  readonly teamKey: string;
  readonly teams: readonly TeamRecord[];
  readonly organizations: readonly OrganizationRecord[];
}): TeamRecord | null {
  const organization = resolveOrganizationByKey({
    key: input.organizationKey,
    organizations: input.organizations,
  });
  if (!organization) {
    return null;
  }
  return (
    input.teams.find((team) => {
      return (
        team.organizationId === organization.id &&
        (team.id === input.teamKey || team.slug === input.teamKey)
      );
    }) ?? null
  );
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
