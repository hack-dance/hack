import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import {
  orgAdminInvitations,
  orgAdminMemberships,
  orgAdminOrganizations,
  orgAdminTeams,
} from "../../db/schema.ts";
import { createDbClient } from "../../db.ts";
import type {
  InvitationRecord,
  MembershipRecord,
  OrganizationRecord,
  OrgTeamsStore,
  TeamRecord,
} from "./service.ts";

type DbClient = ReturnType<typeof createDbClient>;

export class DbOrgTeamsStore implements OrgTeamsStore {
  private readonly db: DbClient;
  private readonly ensureTables: () => Promise<void>;

  constructor(input: {
    readonly databaseUrl?: string;
    readonly db?: DbClient;
  }) {
    this.db =
      input.db ??
      createDbClient({
        databaseUrl: normalizeRequiredText(input.databaseUrl, "DATABASE_URL"),
      });
    this.ensureTables = createOrgAdminTablesEnsurer({
      db: this.db,
    });
  }

  async createOrganization(input: {
    readonly slug: string;
    readonly name: string;
    readonly actorUserId: string;
    readonly actorEmail: string | null;
  }): Promise<{
    readonly organization: OrganizationRecord;
    readonly membership: MembershipRecord;
  }> {
    await this.ensureTables();
    const organizationId = randomUUID();
    const slug = normalizeRequiredText(input.slug, "organization slug");
    const now = new Date();
    const inserted = await this.db
      .insert(orgAdminOrganizations)
      .values({
        id: organizationId,
        slug,
        name: normalizeOptionalText(input.name) ?? slug,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const organization = inserted[0];
    if (!organization) {
      throw new Error("Failed to persist organization.");
    }
    const membership = await this.insertMembership({
      scope: "organization",
      state: "active",
      organizationId,
      teamId: null,
      userId: normalizeOptionalText(input.actorUserId),
      email: normalizeOptionalText(input.actorEmail),
      target: normalizeRequiredText(input.actorUserId, "organization target"),
    });
    return {
      organization: toOrganizationRecord({ row: organization }),
      membership,
    };
  }

  async listOrganizations(input: {
    readonly actorUserId: string;
  }): Promise<readonly OrganizationRecord[]> {
    await this.ensureTables();
    const actorUserId = normalizeOptionalText(input.actorUserId);
    if (!actorUserId) {
      return [];
    }
    const memberships = await this.db
      .select({
        organizationId: orgAdminMemberships.organizationId,
      })
      .from(orgAdminMemberships)
      .where(
        and(
          eq(orgAdminMemberships.scope, "organization"),
          eq(orgAdminMemberships.state, "active"),
          eq(orgAdminMemberships.userId, actorUserId),
          isNull(orgAdminMemberships.teamId)
        )
      )
      .orderBy(asc(orgAdminMemberships.createdAt));
    const organizationIds = dedupe(
      memberships.map((membership) => membership.organizationId)
    );
    if (organizationIds.length === 0) {
      return [];
    }
    const organizations = await this.db
      .select()
      .from(orgAdminOrganizations)
      .where(inArray(orgAdminOrganizations.id, organizationIds))
      .orderBy(asc(orgAdminOrganizations.createdAt));
    return organizations.map((organization) =>
      toOrganizationRecord({ row: organization })
    );
  }

  async getOrganization(input: {
    readonly orgKey: string;
    readonly actorUserId: string;
  }): Promise<OrganizationRecord | null> {
    await this.ensureTables();
    const organization = await this.findOrganization({
      orgKey: input.orgKey,
    });
    if (!organization) {
      return null;
    }
    const actorUserId = normalizeOptionalText(input.actorUserId);
    if (!actorUserId) {
      return null;
    }
    const membership = await this.db
      .select({ id: orgAdminMemberships.id })
      .from(orgAdminMemberships)
      .where(
        and(
          eq(orgAdminMemberships.scope, "organization"),
          eq(orgAdminMemberships.state, "active"),
          eq(orgAdminMemberships.organizationId, organization.id),
          isNull(orgAdminMemberships.teamId),
          eq(orgAdminMemberships.userId, actorUserId)
        )
      )
      .limit(1);
    return membership[0] ? organization : null;
  }

  async createTeam(input: {
    readonly slug: string;
    readonly name: string;
    readonly orgKey: string;
    readonly actorUserId: string;
    readonly actorEmail: string | null;
  }): Promise<{
    readonly team: TeamRecord;
    readonly membership: MembershipRecord;
  } | null> {
    await this.ensureTables();
    const organization = await this.findOrganization({
      orgKey: input.orgKey,
    });
    if (!organization) {
      return null;
    }
    const teamId = randomUUID();
    const slug = normalizeRequiredText(input.slug, "team slug");
    const now = new Date();
    const inserted = await this.db
      .insert(orgAdminTeams)
      .values({
        id: teamId,
        slug,
        name: normalizeOptionalText(input.name) ?? slug,
        organizationId: organization.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const team = inserted[0];
    if (!team) {
      throw new Error("Failed to persist team.");
    }
    const membership = await this.insertMembership({
      scope: "team",
      state: "active",
      organizationId: organization.id,
      teamId,
      userId: normalizeOptionalText(input.actorUserId),
      email: normalizeOptionalText(input.actorEmail),
      target: normalizeRequiredText(input.actorUserId, "team target"),
    });
    return {
      team: toTeamRecord({ row: team }),
      membership,
    };
  }

  async listTeams(input: {
    readonly orgKey: string | null;
    readonly actorUserId: string;
  }): Promise<readonly TeamRecord[]> {
    await this.ensureTables();
    const actorUserId = normalizeOptionalText(input.actorUserId);
    if (!actorUserId) {
      return [];
    }
    const organization = input.orgKey
      ? await this.findOrganization({ orgKey: input.orgKey })
      : null;
    if (input.orgKey && !organization) {
      return [];
    }
    const membershipFilters = [
      eq(orgAdminMemberships.scope, "team"),
      eq(orgAdminMemberships.state, "active"),
      eq(orgAdminMemberships.userId, actorUserId),
    ] as const;
    const memberships = organization
      ? await this.db
          .select({
            teamId: orgAdminMemberships.teamId,
          })
          .from(orgAdminMemberships)
          .where(
            and(
              ...membershipFilters,
              eq(orgAdminMemberships.organizationId, organization.id)
            )
          )
          .orderBy(asc(orgAdminMemberships.createdAt))
      : await this.db
          .select({
            teamId: orgAdminMemberships.teamId,
          })
          .from(orgAdminMemberships)
          .where(and(...membershipFilters))
          .orderBy(asc(orgAdminMemberships.createdAt));
    const teamIds = dedupe(
      memberships
        .map((membership) => membership.teamId)
        .filter((teamId): teamId is string => typeof teamId === "string")
    );
    if (teamIds.length === 0) {
      return [];
    }
    const teams = await this.db
      .select()
      .from(orgAdminTeams)
      .where(inArray(orgAdminTeams.id, teamIds))
      .orderBy(asc(orgAdminTeams.createdAt));
    return teams.map((team) => toTeamRecord({ row: team }));
  }

  async getTeam(input: {
    readonly teamKey: string;
    readonly orgKey: string | null;
    readonly actorUserId: string;
  }): Promise<TeamRecord | null> {
    await this.ensureTables();
    const team = await this.findTeam({
      teamKey: input.teamKey,
      orgKey: input.orgKey,
    });
    if (!team) {
      return null;
    }
    const actorUserId = normalizeOptionalText(input.actorUserId);
    if (!actorUserId) {
      return null;
    }
    const membership = await this.db
      .select({ id: orgAdminMemberships.id })
      .from(orgAdminMemberships)
      .where(
        and(
          eq(orgAdminMemberships.scope, "team"),
          eq(orgAdminMemberships.state, "active"),
          eq(orgAdminMemberships.organizationId, team.organizationId),
          eq(orgAdminMemberships.teamId, team.id),
          eq(orgAdminMemberships.userId, actorUserId)
        )
      )
      .limit(1);
    return membership[0] ? team : null;
  }

  async listMembers(input: {
    readonly scope: "organization" | "team";
    readonly orgKey: string;
    readonly teamKey?: string | null;
    readonly state: "pending" | "active" | "removed" | "all" | "actionable";
  }): Promise<readonly MembershipRecord[]> {
    await this.ensureTables();
    const organization = await this.findOrganization({
      orgKey: input.orgKey,
    });
    if (!organization) {
      return [];
    }
    const team =
      input.scope === "team"
        ? await this.findTeam({
            teamKey: input.teamKey ?? "",
            orgKey: input.orgKey,
          })
        : null;
    if (input.scope === "team" && !team) {
      return [];
    }

    const pending =
      input.state === "active" || input.state === "removed"
        ? []
        : await this.listPendingMemberships({
            scope: input.scope,
            organizationId: organization.id,
            teamId: team?.id ?? null,
          });

    const memberships =
      input.state === "pending"
        ? []
        : await this.listStoredMemberships({
            scope: input.scope,
            organizationId: organization.id,
            teamId: team?.id ?? null,
            state: normalizeStoredMembershipState(input.state),
          });

    if (input.state === "pending") {
      return pending;
    }
    if (input.state === "actionable") {
      return [...pending, ...memberships];
    }
    if (input.state === "active" || input.state === "removed") {
      return memberships;
    }

    const active = memberships.filter(
      (membership) => membership.state === "active"
    );
    const removed = memberships.filter(
      (membership) => membership.state === "removed"
    );
    return [...pending, ...active, ...removed];
  }

  async inviteMember(input: {
    readonly scope: "organization" | "team";
    readonly orgKey: string;
    readonly teamKey?: string | null;
    readonly target: string;
    readonly teamTargets?: readonly string[];
  }): Promise<{
    readonly invitation: InvitationRecord;
    readonly membership: MembershipRecord;
  } | null> {
    await this.ensureTables();
    const organization = await this.findOrganization({
      orgKey: input.orgKey,
    });
    if (!organization) {
      return null;
    }
    const team =
      input.scope === "team"
        ? await this.findTeam({
            teamKey: input.teamKey ?? "",
            orgKey: input.orgKey,
          })
        : null;
    if (input.scope === "team" && !team) {
      return null;
    }
    const now = new Date();
    const inserted = await this.db
      .insert(orgAdminInvitations)
      .values({
        id: randomUUID(),
        scope: input.scope,
        organizationId: organization.id,
        teamId: team?.id ?? null,
        email: normalizeRequiredText(input.target, "invitation target"),
        status: "pending",
        teamTargetsJson: JSON.stringify(normalizeStringList(input.teamTargets)),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const invitation = inserted[0];
    if (!invitation) {
      throw new Error("Failed to persist invitation.");
    }
    const record = toInvitationRecord({ row: invitation });
    return {
      invitation: record,
      membership: toPendingMembership({ invitation: record }),
    };
  }

  async addMember(input: {
    readonly scope: "organization" | "team";
    readonly orgKey: string;
    readonly teamKey?: string | null;
    readonly target: string;
  }): Promise<MembershipRecord | null> {
    await this.ensureTables();
    const organization = await this.findOrganization({
      orgKey: input.orgKey,
    });
    if (!organization) {
      return null;
    }
    const team =
      input.scope === "team"
        ? await this.findTeam({
            teamKey: input.teamKey ?? "",
            orgKey: input.orgKey,
          })
        : null;
    if (input.scope === "team" && !team) {
      return null;
    }
    return await this.insertMembership({
      scope: input.scope,
      state: "active",
      organizationId: organization.id,
      teamId: team?.id ?? null,
      userId: normalizeOptionalText(input.target),
      email: null,
      target: normalizeRequiredText(input.target, "membership target"),
    });
  }

  async removeMember(input: {
    readonly scope: "organization" | "team";
    readonly orgKey: string;
    readonly teamKey?: string | null;
    readonly target: string;
  }): Promise<MembershipRecord | null> {
    await this.ensureTables();
    const organization = await this.findOrganization({
      orgKey: input.orgKey,
    });
    if (!organization) {
      return null;
    }
    const team =
      input.scope === "team"
        ? await this.findTeam({
            teamKey: input.teamKey ?? "",
            orgKey: input.orgKey,
          })
        : null;
    if (input.scope === "team" && !team) {
      return null;
    }
    const target = normalizeRequiredText(input.target, "removal target");
    const removedMembership =
      (await this.removePendingInvitationMembership({
        scope: input.scope,
        organizationId: organization.id,
        teamId: team?.id ?? null,
        target,
      })) ??
      (await this.removeActiveMembership({
        scope: input.scope,
        organizationId: organization.id,
        teamId: team?.id ?? null,
        target,
      }));
    if (!(removedMembership && input.scope === "organization")) {
      return removedMembership;
    }
    await this.cascadeRemovedOrganizationTarget({
      organizationId: organization.id,
      target,
    });
    return removedMembership;
  }

  async listInvitationsForEmail(input: {
    readonly email: string;
  }): Promise<readonly InvitationRecord[]> {
    await this.ensureTables();
    const email = normalizeRequiredText(input.email, "invitation email");
    const invitations = await this.db
      .select()
      .from(orgAdminInvitations)
      .where(
        and(
          eq(orgAdminInvitations.status, "pending"),
          eq(orgAdminInvitations.email, email)
        )
      )
      .orderBy(asc(orgAdminInvitations.createdAt));
    return invitations.map((invitation) =>
      toInvitationRecord({ row: invitation })
    );
  }

  async acceptInvitation(input: {
    readonly inviteId: string;
    readonly userId: string;
    readonly email: string;
  }): Promise<MembershipRecord | null> {
    await this.ensureTables();
    const invitation = await this.findInvitation({
      inviteId: input.inviteId,
    });
    const email = normalizeRequiredText(input.email, "invitation email");
    if (
      !(
        invitation &&
        invitation.status === "pending" &&
        invitation.email === email
      )
    ) {
      return null;
    }
    await this.db
      .update(orgAdminInvitations)
      .set({
        status: "accepted",
        updatedAt: new Date(),
      })
      .where(eq(orgAdminInvitations.id, invitation.id));
    return await this.insertMembership({
      scope: invitation.scope,
      state: "active",
      organizationId: invitation.organizationId,
      teamId: invitation.teamId,
      userId: normalizeOptionalText(input.userId),
      email,
      target: normalizeRequiredText(input.userId, "accepted invitation target"),
    });
  }

  async declineInvitation(input: {
    readonly inviteId: string;
    readonly email: string;
  }): Promise<MembershipRecord | null> {
    await this.ensureTables();
    const invitation = await this.findInvitation({
      inviteId: input.inviteId,
    });
    const email = normalizeRequiredText(input.email, "invitation email");
    if (
      !(
        invitation &&
        invitation.status === "pending" &&
        invitation.email === email
      )
    ) {
      return null;
    }
    await this.db
      .update(orgAdminInvitations)
      .set({
        status: "removed",
        updatedAt: new Date(),
      })
      .where(eq(orgAdminInvitations.id, invitation.id));
    return await this.insertMembership({
      scope: invitation.scope,
      state: "removed",
      organizationId: invitation.organizationId,
      teamId: invitation.teamId,
      userId: null,
      email,
      target: email,
    });
  }

  private async findOrganization(input: {
    readonly orgKey: string;
  }): Promise<OrganizationRecord | null> {
    const orgKey = normalizeOptionalText(input.orgKey);
    if (!orgKey) {
      return null;
    }
    const rows = await this.db
      .select()
      .from(orgAdminOrganizations)
      .where(
        or(
          eq(orgAdminOrganizations.id, orgKey),
          eq(orgAdminOrganizations.slug, orgKey)
        )
      )
      .orderBy(asc(orgAdminOrganizations.createdAt))
      .limit(1);
    return rows[0] ? toOrganizationRecord({ row: rows[0] }) : null;
  }

  private async findTeam(input: {
    readonly teamKey: string;
    readonly orgKey: string | null;
  }): Promise<TeamRecord | null> {
    const teamKey = normalizeOptionalText(input.teamKey);
    if (!teamKey) {
      return null;
    }
    const organization = input.orgKey
      ? await this.findOrganization({ orgKey: input.orgKey })
      : null;
    if (input.orgKey && !organization) {
      return null;
    }
    const rows = organization
      ? await this.db
          .select()
          .from(orgAdminTeams)
          .where(
            and(
              eq(orgAdminTeams.organizationId, organization.id),
              or(eq(orgAdminTeams.id, teamKey), eq(orgAdminTeams.slug, teamKey))
            )
          )
          .orderBy(asc(orgAdminTeams.createdAt))
          .limit(1)
      : await this.db
          .select()
          .from(orgAdminTeams)
          .where(
            or(eq(orgAdminTeams.id, teamKey), eq(orgAdminTeams.slug, teamKey))
          )
          .orderBy(asc(orgAdminTeams.createdAt))
          .limit(1);
    return rows[0] ? toTeamRecord({ row: rows[0] }) : null;
  }

  private async findInvitation(input: {
    readonly inviteId: string;
  }): Promise<InvitationRecord | null> {
    const inviteId = normalizeOptionalText(input.inviteId);
    if (!inviteId) {
      return null;
    }
    const rows = await this.db
      .select()
      .from(orgAdminInvitations)
      .where(eq(orgAdminInvitations.id, inviteId))
      .limit(1);
    return rows[0] ? toInvitationRecord({ row: rows[0] }) : null;
  }

  private async insertMembership(input: {
    readonly scope: "organization" | "team";
    readonly state: "active" | "removed";
    readonly organizationId: string;
    readonly teamId: string | null;
    readonly userId: string | null;
    readonly email: string | null;
    readonly target: string;
  }): Promise<MembershipRecord> {
    const now = new Date();
    const inserted = await this.db
      .insert(orgAdminMemberships)
      .values({
        id: randomUUID(),
        scope: input.scope,
        state: input.state,
        organizationId: input.organizationId,
        teamId: input.teamId,
        userId: input.userId,
        email: input.email,
        target: input.target,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const membership = inserted[0];
    if (!membership) {
      throw new Error("Failed to persist membership.");
    }
    return toMembershipRecord({ row: membership });
  }

  private async listPendingMemberships(input: {
    readonly scope: "organization" | "team";
    readonly organizationId: string;
    readonly teamId: string | null;
  }): Promise<readonly MembershipRecord[]> {
    const invitations = input.teamId
      ? await this.db
          .select()
          .from(orgAdminInvitations)
          .where(
            and(
              eq(orgAdminInvitations.scope, input.scope),
              eq(orgAdminInvitations.organizationId, input.organizationId),
              eq(orgAdminInvitations.status, "pending"),
              eq(orgAdminInvitations.teamId, input.teamId)
            )
          )
          .orderBy(asc(orgAdminInvitations.createdAt))
      : await this.db
          .select()
          .from(orgAdminInvitations)
          .where(
            and(
              eq(orgAdminInvitations.scope, input.scope),
              eq(orgAdminInvitations.organizationId, input.organizationId),
              eq(orgAdminInvitations.status, "pending"),
              isNull(orgAdminInvitations.teamId)
            )
          )
          .orderBy(asc(orgAdminInvitations.createdAt));
    return invitations.map((invitation) =>
      toPendingMembership({
        invitation: toInvitationRecord({ row: invitation }),
      })
    );
  }

  private async listStoredMemberships(input: {
    readonly scope: "organization" | "team";
    readonly organizationId: string;
    readonly teamId: string | null;
    readonly state: "active" | "removed" | null;
  }): Promise<readonly MembershipRecord[]> {
    const baseFilters = [
      eq(orgAdminMemberships.scope, input.scope),
      eq(orgAdminMemberships.organizationId, input.organizationId),
    ] as const;
    const rows = input.teamId
      ? await this.db
          .select()
          .from(orgAdminMemberships)
          .where(
            and(
              ...baseFilters,
              eq(orgAdminMemberships.teamId, input.teamId),
              ...(input.state
                ? [eq(orgAdminMemberships.state, input.state)]
                : [])
            )
          )
          .orderBy(asc(orgAdminMemberships.createdAt))
      : await this.db
          .select()
          .from(orgAdminMemberships)
          .where(
            and(
              ...baseFilters,
              isNull(orgAdminMemberships.teamId),
              ...(input.state
                ? [eq(orgAdminMemberships.state, input.state)]
                : [])
            )
          )
          .orderBy(asc(orgAdminMemberships.createdAt));
    return rows.map((membership) => toMembershipRecord({ row: membership }));
  }

  private async removePendingInvitationMembership(input: {
    readonly scope: "organization" | "team";
    readonly organizationId: string;
    readonly teamId: string | null;
    readonly target: string;
  }): Promise<MembershipRecord | null> {
    const invitations = input.teamId
      ? await this.db
          .select()
          .from(orgAdminInvitations)
          .where(
            and(
              eq(orgAdminInvitations.scope, input.scope),
              eq(orgAdminInvitations.organizationId, input.organizationId),
              eq(orgAdminInvitations.teamId, input.teamId),
              eq(orgAdminInvitations.status, "pending"),
              eq(orgAdminInvitations.email, input.target)
            )
          )
          .orderBy(asc(orgAdminInvitations.createdAt))
          .limit(1)
      : await this.db
          .select()
          .from(orgAdminInvitations)
          .where(
            and(
              eq(orgAdminInvitations.scope, input.scope),
              eq(orgAdminInvitations.organizationId, input.organizationId),
              isNull(orgAdminInvitations.teamId),
              eq(orgAdminInvitations.status, "pending"),
              eq(orgAdminInvitations.email, input.target)
            )
          )
          .orderBy(asc(orgAdminInvitations.createdAt))
          .limit(1);
    const invitation = invitations[0];
    if (!invitation) {
      return null;
    }
    await this.db
      .update(orgAdminInvitations)
      .set({
        status: "removed",
        updatedAt: new Date(),
      })
      .where(eq(orgAdminInvitations.id, invitation.id));
    return await this.insertMembership({
      scope: invitation.scope as "organization" | "team",
      state: "removed",
      organizationId: invitation.organizationId,
      teamId: invitation.teamId,
      userId: null,
      email: invitation.email,
      target: invitation.email,
    });
  }

  private async removeActiveMembership(input: {
    readonly scope: "organization" | "team";
    readonly organizationId: string;
    readonly teamId: string | null;
    readonly target: string;
  }): Promise<MembershipRecord | null> {
    const memberships = input.teamId
      ? await this.db
          .select()
          .from(orgAdminMemberships)
          .where(
            and(
              eq(orgAdminMemberships.scope, input.scope),
              eq(orgAdminMemberships.organizationId, input.organizationId),
              eq(orgAdminMemberships.teamId, input.teamId),
              eq(orgAdminMemberships.state, "active"),
              eq(orgAdminMemberships.target, input.target)
            )
          )
          .orderBy(asc(orgAdminMemberships.createdAt))
          .limit(1)
      : await this.db
          .select()
          .from(orgAdminMemberships)
          .where(
            and(
              eq(orgAdminMemberships.scope, input.scope),
              eq(orgAdminMemberships.organizationId, input.organizationId),
              isNull(orgAdminMemberships.teamId),
              eq(orgAdminMemberships.state, "active"),
              eq(orgAdminMemberships.target, input.target)
            )
          )
          .orderBy(asc(orgAdminMemberships.createdAt))
          .limit(1);
    const membership = memberships[0];
    if (!membership) {
      return null;
    }
    await this.db
      .delete(orgAdminMemberships)
      .where(eq(orgAdminMemberships.id, membership.id));
    return await this.insertMembership({
      scope: membership.scope as "organization" | "team",
      state: "removed",
      organizationId: membership.organizationId,
      teamId: membership.teamId,
      userId: membership.userId,
      email: membership.email,
      target: membership.target,
    });
  }

  private async cascadeRemovedOrganizationTarget(input: {
    readonly organizationId: string;
    readonly target: string;
  }): Promise<void> {
    const invitations = await this.db
      .select()
      .from(orgAdminInvitations)
      .where(
        and(
          eq(orgAdminInvitations.scope, "team"),
          eq(orgAdminInvitations.organizationId, input.organizationId),
          eq(orgAdminInvitations.status, "pending"),
          eq(orgAdminInvitations.email, input.target)
        )
      )
      .orderBy(asc(orgAdminInvitations.createdAt));

    for (const invitation of invitations) {
      await this.db
        .update(orgAdminInvitations)
        .set({
          status: "removed",
          updatedAt: new Date(),
        })
        .where(eq(orgAdminInvitations.id, invitation.id));
      await this.insertMembership({
        scope: "team",
        state: "removed",
        organizationId: invitation.organizationId,
        teamId: invitation.teamId,
        userId: null,
        email: invitation.email,
        target: invitation.email,
      });
    }

    const memberships = await this.db
      .select()
      .from(orgAdminMemberships)
      .where(
        and(
          eq(orgAdminMemberships.scope, "team"),
          eq(orgAdminMemberships.state, "active"),
          eq(orgAdminMemberships.organizationId, input.organizationId),
          or(
            eq(orgAdminMemberships.target, input.target),
            eq(orgAdminMemberships.email, input.target)
          )
        )
      )
      .orderBy(asc(orgAdminMemberships.createdAt));

    for (const membership of memberships) {
      await this.db
        .delete(orgAdminMemberships)
        .where(eq(orgAdminMemberships.id, membership.id));
      await this.insertMembership({
        scope: "team",
        state: "removed",
        organizationId: membership.organizationId,
        teamId: membership.teamId,
        userId: membership.userId,
        email: membership.email,
        target: membership.target,
      });
    }
  }
}

export function createOrgTeamsStoreFromDb(input: {
  readonly databaseUrl?: string;
  readonly db?: DbClient;
}): OrgTeamsStore {
  return new DbOrgTeamsStore(input);
}

function createOrgAdminTablesEnsurer(input: { readonly db: DbClient }) {
  let promise: Promise<void> | null = null;
  return async (): Promise<void> => {
    if (!promise) {
      promise = ensureOrgAdminTables({
        db: input.db,
      }).catch((error) => {
        promise = null;
        throw error;
      });
    }
    await promise;
  };
}

export async function ensureOrgAdminTables(input: {
  readonly db: DbClient;
}): Promise<void> {
  await input.db.execute(sql`
    CREATE TABLE IF NOT EXISTS org_admin_organizations (
      id text PRIMARY KEY,
      slug text NOT NULL,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await input.db.execute(sql`
    CREATE INDEX IF NOT EXISTS org_admin_organizations_slug_idx
    ON org_admin_organizations (slug)
  `);
  await input.db.execute(sql`
    CREATE TABLE IF NOT EXISTS org_admin_teams (
      id text PRIMARY KEY,
      slug text NOT NULL,
      name text NOT NULL,
      organization_id text NOT NULL REFERENCES org_admin_organizations(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await input.db.execute(sql`
    CREATE INDEX IF NOT EXISTS org_admin_teams_organization_id_idx
    ON org_admin_teams (organization_id)
  `);
  await input.db.execute(sql`
    CREATE INDEX IF NOT EXISTS org_admin_teams_slug_idx
    ON org_admin_teams (slug)
  `);
  await input.db.execute(sql`
    CREATE TABLE IF NOT EXISTS org_admin_memberships (
      id text PRIMARY KEY,
      scope text NOT NULL,
      state text NOT NULL,
      organization_id text NOT NULL REFERENCES org_admin_organizations(id) ON DELETE CASCADE,
      team_id text REFERENCES org_admin_teams(id) ON DELETE CASCADE,
      user_id text,
      email text,
      target text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await input.db.execute(sql`
    CREATE INDEX IF NOT EXISTS org_admin_memberships_organization_id_idx
    ON org_admin_memberships (organization_id)
  `);
  await input.db.execute(sql`
    CREATE INDEX IF NOT EXISTS org_admin_memberships_team_id_idx
    ON org_admin_memberships (team_id)
  `);
  await input.db.execute(sql`
    CREATE INDEX IF NOT EXISTS org_admin_memberships_user_id_idx
    ON org_admin_memberships (user_id)
  `);
  await input.db.execute(sql`
    CREATE INDEX IF NOT EXISTS org_admin_memberships_target_idx
    ON org_admin_memberships (target)
  `);
  await input.db.execute(sql`
    CREATE INDEX IF NOT EXISTS org_admin_memberships_state_idx
    ON org_admin_memberships (state)
  `);
  await input.db.execute(sql`
    CREATE TABLE IF NOT EXISTS org_admin_invitations (
      id text PRIMARY KEY,
      scope text NOT NULL,
      organization_id text NOT NULL REFERENCES org_admin_organizations(id) ON DELETE CASCADE,
      team_id text REFERENCES org_admin_teams(id) ON DELETE CASCADE,
      email text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      team_targets_json text NOT NULL DEFAULT '[]',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await input.db.execute(sql`
    CREATE INDEX IF NOT EXISTS org_admin_invitations_organization_id_idx
    ON org_admin_invitations (organization_id)
  `);
  await input.db.execute(sql`
    CREATE INDEX IF NOT EXISTS org_admin_invitations_team_id_idx
    ON org_admin_invitations (team_id)
  `);
  await input.db.execute(sql`
    CREATE INDEX IF NOT EXISTS org_admin_invitations_email_idx
    ON org_admin_invitations (email)
  `);
  await input.db.execute(sql`
    CREATE INDEX IF NOT EXISTS org_admin_invitations_status_idx
    ON org_admin_invitations (status)
  `);
}

function toOrganizationRecord(input: {
  readonly row: typeof orgAdminOrganizations.$inferSelect;
}): OrganizationRecord {
  return {
    id: input.row.id,
    slug: input.row.slug,
    name: input.row.name,
    createdAt: input.row.createdAt.toISOString(),
    updatedAt: input.row.updatedAt.toISOString(),
  };
}

function toTeamRecord(input: {
  readonly row: typeof orgAdminTeams.$inferSelect;
}): TeamRecord {
  return {
    id: input.row.id,
    slug: input.row.slug,
    name: input.row.name,
    organizationId: input.row.organizationId,
    createdAt: input.row.createdAt.toISOString(),
    updatedAt: input.row.updatedAt.toISOString(),
  };
}

function toMembershipRecord(input: {
  readonly row: typeof orgAdminMemberships.$inferSelect;
}): MembershipRecord {
  return {
    id: input.row.id,
    scope: normalizeScope(input.row.scope),
    state: normalizeMembershipState(input.row.state),
    organizationId: input.row.organizationId,
    teamId: input.row.teamId,
    userId: input.row.userId,
    email: input.row.email,
    target: input.row.target,
    createdAt: input.row.createdAt.toISOString(),
    updatedAt: input.row.updatedAt.toISOString(),
  };
}

function toInvitationRecord(input: {
  readonly row: typeof orgAdminInvitations.$inferSelect;
}): InvitationRecord {
  return {
    id: input.row.id,
    scope: normalizeScope(input.row.scope),
    organizationId: input.row.organizationId,
    teamId: input.row.teamId,
    email: input.row.email,
    status: normalizeInvitationStatus(input.row.status),
    createdAt: input.row.createdAt.toISOString(),
    updatedAt: input.row.updatedAt.toISOString(),
    teamTargets: parseStringList(input.row.teamTargetsJson),
  };
}

function toPendingMembership(input: {
  readonly invitation: InvitationRecord;
}): MembershipRecord {
  return {
    id: input.invitation.id,
    scope: input.invitation.scope,
    state: "pending",
    organizationId: input.invitation.organizationId,
    teamId: input.invitation.teamId,
    userId: null,
    email: input.invitation.email,
    target: input.invitation.email,
    createdAt: input.invitation.createdAt,
    updatedAt: input.invitation.updatedAt,
  };
}

function normalizeScope(value: string): "organization" | "team" {
  return value === "team" ? "team" : "organization";
}

function normalizeMembershipState(
  value: string
): "pending" | "active" | "removed" {
  if (value === "active" || value === "removed") {
    return value;
  }
  return "pending";
}

function normalizeInvitationStatus(
  value: string
): "pending" | "accepted" | "removed" {
  if (value === "accepted" || value === "removed") {
    return value;
  }
  return "pending";
}

function normalizeStoredMembershipState(
  value: "pending" | "active" | "removed" | "all" | "actionable"
): "active" | "removed" | null {
  if (value === "actionable") {
    return "active";
  }
  if (value === "all" || value === "pending") {
    return null;
  }
  return value;
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

function normalizeStringList(
  value: readonly string[] | undefined
): readonly string[] {
  const normalized = value
    ?.map((entry) => normalizeOptionalText(entry))
    .filter((entry): entry is string => typeof entry === "string");
  return dedupe(normalized ?? []);
}

function parseStringList(value: string): readonly string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return dedupe(
      parsed
        .map((entry) => normalizeOptionalText(entry))
        .filter((entry): entry is string => typeof entry === "string")
    );
  } catch {
    return [];
  }
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
