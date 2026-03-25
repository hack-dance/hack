import { randomUUID } from "node:crypto";

import { asc, eq, sql } from "drizzle-orm";
import {
  projectAdminAccessGrants,
  projectAdminProjects,
} from "../../db/schema.ts";
import { createDbClient } from "../../db.ts";
import type { OrgTeamsStore } from "../orgs/service.ts";
import type {
  ProjectAccessGrantRecord,
  ProjectAccessMutationResult,
  ProjectAccessRole,
  ProjectAccessScope,
  ProjectOwnershipRecord,
  ProjectRecord,
  ProjectStore,
  RegisterProjectResult,
} from "./service.ts";

type DbClient = ReturnType<typeof createDbClient>;

export class DbProjectStore implements ProjectStore {
  private readonly db: DbClient;
  private readonly orgStore: OrgTeamsStore;
  private readonly ensureTables: () => Promise<void>;

  constructor(input: {
    readonly databaseUrl?: string;
    readonly orgStore: OrgTeamsStore;
    readonly db?: DbClient;
  }) {
    this.db =
      input.db ??
      createDbClient({
        databaseUrl: normalizeRequiredText(input.databaseUrl, "DATABASE_URL"),
      });
    this.orgStore = input.orgStore;
    this.ensureTables = createProjectAdminTablesEnsurer({
      db: this.db,
    });
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
    await this.ensureTables();
    const slug = normalizeProjectSlug(input.slug);
    const name = normalizeProjectName({
      slug,
      value: input.name,
    });
    const actorUserId = normalizeRequiredText(
      input.actorUserId,
      "actor user id"
    );
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

    const existing = await this.readProjectByKey(slug);
    if (!existing) {
      const now = new Date();
      const inserted = await this.db
        .insert(projectAdminProjects)
        .values({
          id: randomUUID(),
          slug,
          name,
          ownershipMode: desiredOwnership.ownership.mode,
          ownerType: desiredOwnership.ownership.ownerType,
          ownerId: desiredOwnership.ownership.ownerId,
          ownerSlug: desiredOwnership.ownership.ownerSlug,
          ownerName: desiredOwnership.ownership.ownerName,
          managedBy: desiredOwnership.ownership.managedBy,
          createdByUserId: actorUserId,
          createdByEmail: normalizeOptionalText(input.actorEmail),
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const created = inserted[0];
      if (!created) {
        throw new Error("Failed to persist project registration.");
      }
      return {
        ok: true,
        status: "created",
        project: await this.toProjectRecord({
          project: created,
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
      left: toProjectOwnershipRecord({ row: existing }),
      right: desiredOwnership.ownership,
    });
    const updatedRows = await this.db
      .update(projectAdminProjects)
      .set({
        name,
        ownershipMode: desiredOwnership.ownership.mode,
        ownerType: desiredOwnership.ownership.ownerType,
        ownerId: desiredOwnership.ownership.ownerId,
        ownerSlug: desiredOwnership.ownership.ownerSlug,
        ownerName: desiredOwnership.ownership.ownerName,
        managedBy: desiredOwnership.ownership.managedBy,
        updatedAt: new Date(),
      })
      .where(eq(projectAdminProjects.id, existing.id))
      .returning();
    const updated = updatedRows[0];
    if (!updated) {
      throw new Error("Failed to update project registration.");
    }
    if (ownershipChanged) {
      await this.db
        .delete(projectAdminAccessGrants)
        .where(eq(projectAdminAccessGrants.projectId, updated.id));
    }
    return {
      ok: true,
      status: "updated",
      project: await this.toProjectRecord({
        project: updated,
        actorUserId,
      }),
    };
  }

  async listProjects(input: {
    readonly actorUserId: string;
  }): Promise<readonly ProjectRecord[]> {
    await this.ensureTables();
    const actorUserId = normalizeRequiredText(
      input.actorUserId,
      "actor user id"
    );
    const rows = await this.db
      .select()
      .from(projectAdminProjects)
      .orderBy(asc(projectAdminProjects.slug));
    const visible = await Promise.all(
      rows.map(async (row) => {
        const role = await this.resolveCurrentAccessRole({
          project: row,
          actorUserId,
        });
        if (!role) {
          return null;
        }
        return toProjectRecord({
          project: row,
          currentAccessRole: role,
        });
      })
    );
    return visible.filter((project): project is ProjectRecord =>
      Boolean(project)
    );
  }

  async getProject(input: {
    readonly projectKey: string;
    readonly actorUserId: string;
  }): Promise<ProjectRecord | null> {
    await this.ensureTables();
    const actorUserId = normalizeRequiredText(
      input.actorUserId,
      "actor user id"
    );
    const project = await this.readProjectByKey(input.projectKey);
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
    await this.ensureTables();
    const actorUserId = normalizeRequiredText(
      input.actorUserId,
      "actor user id"
    );
    const project = await this.readProjectByKey(input.projectKey);
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
    const rows = await this.db
      .select()
      .from(projectAdminAccessGrants)
      .where(eq(projectAdminAccessGrants.projectId, project.id))
      .orderBy(asc(projectAdminAccessGrants.subjectSlug));
    return rows.map((row) => toProjectAccessGrantRecord({ row }));
  }

  async grantAccess(input: {
    readonly projectKey: string;
    readonly actorUserId: string;
    readonly scope: ProjectAccessScope;
    readonly role: Exclude<ProjectAccessRole, "owner">;
    readonly orgKey?: string | null;
    readonly teamKey?: string | null;
  }): Promise<ProjectAccessMutationResult> {
    await this.ensureTables();
    const actorUserId = normalizeRequiredText(
      input.actorUserId,
      "actor user id"
    );
    const project = await this.readProjectByKey(input.projectKey);
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
    if (project.ownershipMode === "local") {
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
      project.ownerType === subject.scope &&
      project.ownerId === subject.subjectId
    ) {
      return {
        ok: false,
        error: "project_access_conflict",
      };
    }

    const existingRows = await this.db
      .select()
      .from(projectAdminAccessGrants)
      .where(eq(projectAdminAccessGrants.projectId, project.id));
    const existing =
      existingRows.find((row) => {
        return (
          row.scope === subject.scope && row.subjectId === subject.subjectId
        );
      }) ?? null;
    const now = new Date();
    if (!existing) {
      const inserted = await this.db
        .insert(projectAdminAccessGrants)
        .values({
          id: randomUUID(),
          projectId: project.id,
          scope: subject.scope,
          role: input.role,
          subjectId: subject.subjectId,
          subjectSlug: subject.subjectSlug,
          subjectName: subject.subjectName,
          organizationId: subject.organizationId,
          teamId: subject.teamId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const access = inserted[0];
      if (!access) {
        throw new Error("Failed to persist project access grant.");
      }
      return {
        ok: true,
        status: "created",
        access: toProjectAccessGrantRecord({ row: access }),
      };
    }

    const updatedRows = await this.db
      .update(projectAdminAccessGrants)
      .set({
        role: input.role,
        subjectSlug: subject.subjectSlug,
        subjectName: subject.subjectName,
        organizationId: subject.organizationId,
        teamId: subject.teamId,
        updatedAt: now,
      })
      .where(eq(projectAdminAccessGrants.id, existing.id))
      .returning();
    const access = updatedRows[0];
    if (!access) {
      throw new Error("Failed to update project access grant.");
    }
    return {
      ok: true,
      status: "updated",
      access: toProjectAccessGrantRecord({ row: access }),
    };
  }

  async revokeAccess(input: {
    readonly projectKey: string;
    readonly actorUserId: string;
    readonly grantId: string;
  }): Promise<ProjectAccessMutationResult> {
    await this.ensureTables();
    const actorUserId = normalizeRequiredText(
      input.actorUserId,
      "actor user id"
    );
    const project = await this.readProjectByKey(input.projectKey);
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

    const grantId = normalizeRequiredText(input.grantId, "grant id");
    const existingRows = await this.db
      .select()
      .from(projectAdminAccessGrants)
      .where(eq(projectAdminAccessGrants.id, grantId))
      .limit(1);
    const existing = existingRows[0];
    if (!(existing && existing.projectId === project.id)) {
      return {
        ok: false,
        error: "project_access_grant_not_found",
      };
    }
    await this.db
      .delete(projectAdminAccessGrants)
      .where(eq(projectAdminAccessGrants.id, existing.id));
    return {
      ok: true,
      status: "removed",
      access: toProjectAccessGrantRecord({ row: existing }),
    };
  }

  private async readProjectByKey(projectKey: string) {
    const key = normalizeOptionalText(projectKey);
    if (!key) {
      return null;
    }
    const normalizedSlug = normalizeProjectSlug(key);
    const rows = await this.db
      .select()
      .from(projectAdminProjects)
      .where(eq(projectAdminProjects.slug, normalizedSlug))
      .limit(1);
    if (rows[0]) {
      return rows[0];
    }
    const byId = await this.db
      .select()
      .from(projectAdminProjects)
      .where(eq(projectAdminProjects.id, key))
      .limit(1);
    return byId[0] ?? null;
  }

  private async toProjectRecord(input: {
    readonly project: typeof projectAdminProjects.$inferSelect;
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
    readonly project: typeof projectAdminProjects.$inferSelect;
    readonly actorUserId: string;
  }): Promise<ProjectAccessRole | null> {
    const actorUserId = normalizeOptionalText(input.actorUserId);
    if (!actorUserId) {
      return null;
    }
    if (
      input.project.ownershipMode === "local" &&
      input.project.createdByUserId === actorUserId
    ) {
      return "owner";
    }

    const visibility = await resolveVisibilityContext({
      actorUserId,
      orgStore: this.orgStore,
    });
    if (input.project.ownershipMode === "shared") {
      const ownerVisible =
        (input.project.ownerType === "organization" &&
          input.project.ownerId &&
          visibility.organizationIds.has(input.project.ownerId)) ||
        (input.project.ownerType === "team" &&
          input.project.ownerId &&
          visibility.teamIds.has(input.project.ownerId));
      if (ownerVisible) {
        return "owner";
      }
    }

    const grants = await this.db
      .select()
      .from(projectAdminAccessGrants)
      .where(eq(projectAdminAccessGrants.projectId, input.project.id));
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
        bestRole = grant.role as Exclude<ProjectAccessRole, "owner">;
      }
    }
    return bestRole;
  }
}

export function createProjectStoreFromDb(input: {
  readonly databaseUrl?: string;
  readonly orgStore: OrgTeamsStore;
  readonly db?: DbClient;
}): ProjectStore {
  return new DbProjectStore(input);
}

function createProjectAdminTablesEnsurer(input: { readonly db: DbClient }) {
  let promise: Promise<void> | null = null;
  return async (): Promise<void> => {
    if (!promise) {
      promise = ensureProjectAdminTables({
        db: input.db,
      }).catch((error) => {
        promise = null;
        throw error;
      });
    }
    await promise;
  };
}

export async function ensureProjectAdminTables(input: {
  readonly db: DbClient;
}): Promise<void> {
  await input.db.execute(sql`
    CREATE TABLE IF NOT EXISTS project_admin_projects (
      id text PRIMARY KEY,
      slug text NOT NULL,
      name text NOT NULL,
      ownership_mode text NOT NULL,
      owner_type text NOT NULL,
      owner_id text,
      owner_slug text,
      owner_name text,
      managed_by text NOT NULL,
      created_by_user_id text NOT NULL,
      created_by_email text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await input.db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS project_admin_projects_slug_idx
    ON project_admin_projects (slug)
  `);
  await input.db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS project_admin_projects_slug_idx
    ON project_admin_projects (slug)
  `);

  await input.db.execute(sql`
    CREATE INDEX IF NOT EXISTS project_admin_projects_owner_id_idx
    ON project_admin_projects (owner_id)
  `);
  await input.db.execute(sql`
    CREATE INDEX IF NOT EXISTS project_admin_projects_created_by_user_id_idx
    ON project_admin_projects (created_by_user_id)
  `);
  await input.db.execute(sql`
    CREATE TABLE IF NOT EXISTS project_admin_access_grants (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES project_admin_projects(id) ON DELETE CASCADE,
      scope text NOT NULL,
      role text NOT NULL,
      subject_id text NOT NULL,
      subject_slug text NOT NULL,
      subject_name text NOT NULL,
      organization_id text NOT NULL,
      team_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await input.db.execute(sql`
    CREATE INDEX IF NOT EXISTS project_admin_access_grants_project_id_idx
    ON project_admin_access_grants (project_id)
  `);
  await input.db.execute(sql`
    CREATE INDEX IF NOT EXISTS project_admin_access_grants_subject_id_idx
    ON project_admin_access_grants (subject_id)
  `);
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

async function resolveVisibilityContext(input: {
  readonly actorUserId: string;
  readonly orgStore: OrgTeamsStore;
}) {
  const [organizations, teams] = await Promise.all([
    input.orgStore.listOrganizations({
      actorUserId: input.actorUserId,
    }),
    input.orgStore.listTeams({
      actorUserId: input.actorUserId,
      orgKey: null,
    }),
  ]);
  return {
    organizationIds: new Set(
      organizations.map((organization) => organization.id)
    ),
    teamIds: new Set(teams.map((team) => team.id)),
  };
}

function toProjectRecord(input: {
  readonly project: typeof projectAdminProjects.$inferSelect;
  readonly currentAccessRole: ProjectAccessRole;
}): ProjectRecord {
  return {
    id: input.project.id,
    slug: input.project.slug,
    name: input.project.name,
    ownership: toProjectOwnershipRecord({
      row: input.project,
    }),
    currentAccessRole: input.currentAccessRole,
    createdAt: input.project.createdAt.toISOString(),
    updatedAt: input.project.updatedAt.toISOString(),
  };
}

function toProjectAccessGrantRecord(input: {
  readonly row: typeof projectAdminAccessGrants.$inferSelect;
}): ProjectAccessGrantRecord {
  return {
    id: input.row.id,
    scope: input.row.scope as ProjectAccessScope,
    role: input.row.role as Exclude<ProjectAccessRole, "owner">,
    subjectId: input.row.subjectId,
    subjectSlug: input.row.subjectSlug,
    subjectName: input.row.subjectName,
    organizationId: input.row.organizationId,
    teamId: input.row.teamId,
    createdAt: input.row.createdAt.toISOString(),
    updatedAt: input.row.updatedAt.toISOString(),
  };
}

function toProjectOwnershipRecord(input: {
  readonly row: typeof projectAdminProjects.$inferSelect;
}): ProjectOwnershipRecord {
  return {
    mode: input.row.ownershipMode as ProjectOwnershipRecord["mode"],
    ownerType: input.row.ownerType as ProjectOwnershipRecord["ownerType"],
    ownerId: input.row.ownerId,
    ownerSlug: input.row.ownerSlug,
    ownerName: input.row.ownerName,
    managedBy: input.row.managedBy as ProjectOwnershipRecord["managedBy"],
  };
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
  return normalizeOptionalText(input.value) ?? input.slug;
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRequiredText(value: unknown, label: string): string {
  const normalized = normalizeOptionalText(value);
  if (!normalized) {
    throw new Error(`Missing ${label}.`);
  }
  return normalized;
}

function compareProjectAccessRole(input: {
  readonly left: string;
  readonly right: string;
}) {
  const rank = {
    viewer: 1,
    admin: 2,
  } as const;
  return (
    (rank[input.left as keyof typeof rank] ?? 0) -
    (rank[input.right as keyof typeof rank] ?? 0)
  );
}

function projectOwnershipEquals(input: {
  readonly left: ProjectOwnershipRecord;
  readonly right: ProjectOwnershipRecord;
}) {
  return (
    input.left.mode === input.right.mode &&
    input.left.ownerType === input.right.ownerType &&
    input.left.ownerId === input.right.ownerId &&
    input.left.ownerSlug === input.right.ownerSlug &&
    input.left.ownerName === input.right.ownerName &&
    input.left.managedBy === input.right.managedBy
  );
}
