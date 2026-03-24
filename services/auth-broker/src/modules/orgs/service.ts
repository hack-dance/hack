import { randomUUID } from "node:crypto";

export type MembershipState = "pending" | "active" | "removed";

export type OrganizationRecord = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type TeamRecord = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly organizationId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type MembershipRecord = {
  readonly id: string;
  readonly scope: "organization" | "team";
  readonly state: MembershipState;
  readonly organizationId: string;
  readonly teamId: string | null;
  readonly userId: string | null;
  readonly email: string | null;
  readonly target: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type InvitationRecord = {
  readonly id: string;
  readonly scope: "organization" | "team";
  readonly organizationId: string;
  readonly teamId: string | null;
  readonly email: string;
  readonly status: "pending" | "accepted" | "removed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly teamTargets: readonly string[];
};

export type MaybePromise<T> = T | Promise<T>;

export type OrgTeamsStore = {
  readonly createOrganization: (input: {
    readonly slug: string;
    readonly name: string;
    readonly actorUserId: string;
    readonly actorEmail: string | null;
  }) => MaybePromise<{
    readonly organization: OrganizationRecord;
    readonly membership: MembershipRecord;
  }>;
  readonly listOrganizations: (input: {
    readonly actorUserId: string;
  }) => MaybePromise<readonly OrganizationRecord[]>;
  readonly getOrganization: (input: {
    readonly orgKey: string;
    readonly actorUserId: string;
  }) => MaybePromise<OrganizationRecord | null>;
  readonly createTeam: (input: {
    readonly slug: string;
    readonly name: string;
    readonly orgKey: string;
    readonly actorUserId: string;
    readonly actorEmail: string | null;
  }) => MaybePromise<{
    readonly team: TeamRecord;
    readonly membership: MembershipRecord;
  } | null>;
  readonly listTeams: (input: {
    readonly orgKey: string | null;
    readonly actorUserId: string;
  }) => MaybePromise<readonly TeamRecord[]>;
  readonly getTeam: (input: {
    readonly teamKey: string;
    readonly orgKey: string | null;
    readonly actorUserId: string;
  }) => MaybePromise<TeamRecord | null>;
  readonly listMembers: (input: {
    readonly scope: "organization" | "team";
    readonly orgKey: string;
    readonly teamKey?: string | null;
    readonly state: MembershipState | "all" | "actionable";
  }) => MaybePromise<readonly MembershipRecord[]>;
  readonly inviteMember: (input: {
    readonly scope: "organization" | "team";
    readonly orgKey: string;
    readonly teamKey?: string | null;
    readonly target: string;
    readonly teamTargets?: readonly string[];
  }) => MaybePromise<{
    readonly invitation: InvitationRecord;
    readonly membership: MembershipRecord;
  } | null>;
  readonly addMember: (input: {
    readonly scope: "organization" | "team";
    readonly orgKey: string;
    readonly teamKey?: string | null;
    readonly target: string;
  }) => MaybePromise<MembershipRecord | null>;
  readonly removeMember: (input: {
    readonly scope: "organization" | "team";
    readonly orgKey: string;
    readonly teamKey?: string | null;
    readonly target: string;
  }) => MaybePromise<MembershipRecord | null>;
  readonly listInvitationsForEmail: (input: {
    readonly email: string;
  }) => MaybePromise<readonly InvitationRecord[]>;
  readonly acceptInvitation: (input: {
    readonly inviteId: string;
    readonly userId: string;
    readonly email: string;
  }) => MaybePromise<MembershipRecord | null>;
  readonly declineInvitation: (input: {
    readonly inviteId: string;
    readonly email: string;
  }) => MaybePromise<MembershipRecord | null>;
};

export class InMemoryOrgTeamsStore implements OrgTeamsStore {
  private readonly organizations = new Map<string, OrganizationRecord>();
  private readonly teams = new Map<string, TeamRecord>();
  private readonly activeMemberships = new Map<string, MembershipRecord>();
  private readonly removedMemberships = new Map<string, MembershipRecord>();
  private readonly invitations = new Map<string, InvitationRecord>();

  createOrganization(input: {
    readonly slug: string;
    readonly name: string;
    readonly actorUserId: string;
    readonly actorEmail: string | null;
  }): MaybePromise<{
    readonly organization: OrganizationRecord;
    readonly membership: MembershipRecord;
  }> {
    const now = new Date().toISOString();
    const organization: OrganizationRecord = {
      id: randomUUID(),
      slug: input.slug.trim(),
      name: input.name.trim() || input.slug.trim(),
      createdAt: now,
      updatedAt: now,
    };
    this.organizations.set(organization.id, organization);
    const membership = this.createActiveMembership({
      scope: "organization",
      organizationId: organization.id,
      teamId: null,
      userId: input.actorUserId,
      email: input.actorEmail,
      target: input.actorUserId,
    });
    return { organization, membership };
  }

  listOrganizations(input: {
    readonly actorUserId: string;
  }): MaybePromise<readonly OrganizationRecord[]> {
    const allowedOrgIds = new Set(
      [...this.activeMemberships.values()]
        .filter(
          (membership) =>
            membership.scope === "organization" &&
            membership.userId === input.actorUserId
        )
        .map((membership) => membership.organizationId)
    );
    return [...this.organizations.values()].filter((organization) =>
      allowedOrgIds.has(organization.id)
    );
  }

  getOrganization(input: {
    readonly orgKey: string;
    readonly actorUserId: string;
  }): MaybePromise<OrganizationRecord | null> {
    const organization = this.findOrganization({ orgKey: input.orgKey });
    if (!organization) {
      return null;
    }
    const allowed = [...this.activeMemberships.values()].some(
      (membership) =>
        membership.scope === "organization" &&
        membership.organizationId === organization.id &&
        membership.userId === input.actorUserId
    );
    return allowed ? organization : null;
  }

  createTeam(input: {
    readonly slug: string;
    readonly name: string;
    readonly orgKey: string;
    readonly actorUserId: string;
    readonly actorEmail: string | null;
  }): MaybePromise<{
    readonly team: TeamRecord;
    readonly membership: MembershipRecord;
  } | null> {
    const organization = this.findOrganization({ orgKey: input.orgKey });
    if (!organization) {
      return null;
    }
    const now = new Date().toISOString();
    const team: TeamRecord = {
      id: randomUUID(),
      slug: input.slug.trim(),
      name: input.name.trim() || input.slug.trim(),
      organizationId: organization.id,
      createdAt: now,
      updatedAt: now,
    };
    this.teams.set(team.id, team);
    const membership = this.createActiveMembership({
      scope: "team",
      organizationId: organization.id,
      teamId: team.id,
      userId: input.actorUserId,
      email: input.actorEmail,
      target: input.actorUserId,
    });
    return { team, membership };
  }

  listTeams(input: {
    readonly orgKey: string | null;
    readonly actorUserId: string;
  }): MaybePromise<readonly TeamRecord[]> {
    const organization = input.orgKey
      ? this.findOrganization({ orgKey: input.orgKey })
      : null;
    return [...this.teams.values()].filter((team) => {
      if (organization && team.organizationId !== organization.id) {
        return false;
      }
      return [...this.activeMemberships.values()].some(
        (membership) =>
          membership.scope === "team" &&
          membership.teamId === team.id &&
          membership.userId === input.actorUserId
      );
    });
  }

  getTeam(input: {
    readonly teamKey: string;
    readonly orgKey: string | null;
    readonly actorUserId: string;
  }): MaybePromise<TeamRecord | null> {
    const team = this.findTeam({
      teamKey: input.teamKey,
      orgKey: input.orgKey,
    });
    if (!team) {
      return null;
    }
    const allowed = [...this.activeMemberships.values()].some(
      (membership) =>
        membership.scope === "team" &&
        membership.teamId === team.id &&
        membership.userId === input.actorUserId
    );
    return allowed ? team : null;
  }

  listMembers(input: {
    readonly scope: "organization" | "team";
    readonly orgKey: string;
    readonly teamKey?: string | null;
    readonly state: MembershipState | "all" | "actionable";
  }): MaybePromise<readonly MembershipRecord[]> {
    const organization = this.findOrganization({ orgKey: input.orgKey });
    if (!organization) {
      return [];
    }
    const team =
      input.scope === "team"
        ? this.findTeam({ teamKey: input.teamKey ?? "", orgKey: input.orgKey })
        : null;
    const pending = [...this.invitations.values()]
      .filter((invitation) => invitation.status === "pending")
      .filter(
        (invitation) =>
          invitation.scope === input.scope &&
          invitation.organizationId === organization.id &&
          invitation.teamId === (team?.id ?? null)
      )
      .map((invitation) => this.toPendingMembership({ invitation }));
    const active = [...this.activeMemberships.values()].filter(
      (membership) =>
        membership.scope === input.scope &&
        membership.organizationId === organization.id &&
        membership.teamId === (team?.id ?? null)
    );
    const removed = [...this.removedMemberships.values()].filter(
      (membership) =>
        membership.scope === input.scope &&
        membership.organizationId === organization.id &&
        membership.teamId === (team?.id ?? null)
    );
    if (input.state === "pending") {
      return pending;
    }
    if (input.state === "active") {
      return active;
    }
    if (input.state === "removed") {
      return removed;
    }
    if (input.state === "actionable") {
      return [...pending, ...active];
    }
    return [...pending, ...active, ...removed];
  }

  inviteMember(input: {
    readonly scope: "organization" | "team";
    readonly orgKey: string;
    readonly teamKey?: string | null;
    readonly target: string;
    readonly teamTargets?: readonly string[];
  }): MaybePromise<{
    readonly invitation: InvitationRecord;
    readonly membership: MembershipRecord;
  } | null> {
    const organization = this.findOrganization({ orgKey: input.orgKey });
    if (!organization) {
      return null;
    }
    const team =
      input.scope === "team"
        ? this.findTeam({ teamKey: input.teamKey ?? "", orgKey: input.orgKey })
        : null;
    if (input.scope === "team" && !team) {
      return null;
    }
    const now = new Date().toISOString();
    const invitation: InvitationRecord = {
      id: randomUUID(),
      scope: input.scope,
      organizationId: organization.id,
      teamId: team?.id ?? null,
      email: input.target.trim(),
      status: "pending",
      createdAt: now,
      updatedAt: now,
      teamTargets: [...(input.teamTargets ?? [])],
    };
    this.invitations.set(invitation.id, invitation);
    return {
      invitation,
      membership: this.toPendingMembership({ invitation }),
    };
  }

  addMember(input: {
    readonly scope: "organization" | "team";
    readonly orgKey: string;
    readonly teamKey?: string | null;
    readonly target: string;
  }): MaybePromise<MembershipRecord | null> {
    const organization = this.findOrganization({ orgKey: input.orgKey });
    if (!organization) {
      return null;
    }
    const team =
      input.scope === "team"
        ? this.findTeam({ teamKey: input.teamKey ?? "", orgKey: input.orgKey })
        : null;
    if (input.scope === "team" && !team) {
      return null;
    }
    return this.createActiveMembership({
      scope: input.scope,
      organizationId: organization.id,
      teamId: team?.id ?? null,
      userId: input.target.trim(),
      email: null,
      target: input.target.trim(),
    });
  }

  removeMember(input: {
    readonly scope: "organization" | "team";
    readonly orgKey: string;
    readonly teamKey?: string | null;
    readonly target: string;
  }): MaybePromise<MembershipRecord | null> {
    const organization = this.findOrganization({ orgKey: input.orgKey });
    if (!organization) {
      return null;
    }
    const team =
      input.scope === "team"
        ? this.findTeam({ teamKey: input.teamKey ?? "", orgKey: input.orgKey })
        : null;
    if (input.scope === "team" && !team) {
      return null;
    }
    const normalizedTarget = input.target.trim();
    const teamId = team?.id ?? null;
    const removedMembership =
      this.removePendingInvitationMembership({
        scope: input.scope,
        organizationId: organization.id,
        teamId,
        target: normalizedTarget,
      }) ??
      this.removeActiveMembership({
        scope: input.scope,
        organizationId: organization.id,
        teamId,
        target: normalizedTarget,
      });
    if (!removedMembership) {
      return null;
    }
    if (input.scope === "organization") {
      this.cascadeRemovedOrganizationTarget({
        organizationId: organization.id,
        target: normalizedTarget,
      });
    }
    return removedMembership;
  }

  listInvitationsForEmail(input: {
    readonly email: string;
  }): MaybePromise<readonly InvitationRecord[]> {
    const normalizedEmail = input.email.trim();
    return [...this.invitations.values()].filter(
      (invitation) =>
        invitation.status === "pending" && invitation.email === normalizedEmail
    );
  }

  acceptInvitation(input: {
    readonly inviteId: string;
    readonly userId: string;
    readonly email: string;
  }): MaybePromise<MembershipRecord | null> {
    const invitation = this.invitations.get(input.inviteId);
    if (
      !invitation ||
      invitation.status !== "pending" ||
      invitation.email !== input.email.trim()
    ) {
      return null;
    }
    this.invitations.set(invitation.id, {
      ...invitation,
      status: "accepted",
      updatedAt: new Date().toISOString(),
    });
    return this.createActiveMembership({
      scope: invitation.scope,
      organizationId: invitation.organizationId,
      teamId: invitation.teamId,
      userId: input.userId,
      email: input.email.trim(),
      target: input.userId,
    });
  }

  declineInvitation(input: {
    readonly inviteId: string;
    readonly email: string;
  }): MaybePromise<MembershipRecord | null> {
    const invitation = this.invitations.get(input.inviteId);
    if (
      !invitation ||
      invitation.status !== "pending" ||
      invitation.email !== input.email.trim()
    ) {
      return null;
    }
    this.invitations.set(invitation.id, {
      ...invitation,
      status: "removed",
      updatedAt: new Date().toISOString(),
    });
    const removed = this.toRemovedMembership({
      scope: invitation.scope,
      organizationId: invitation.organizationId,
      teamId: invitation.teamId,
      userId: null,
      email: invitation.email,
      target: invitation.email,
    });
    this.removedMemberships.set(removed.id, removed);
    return removed;
  }

  private findOrganization(input: {
    readonly orgKey: string;
  }): OrganizationRecord | null {
    const key = input.orgKey.trim();
    for (const organization of this.organizations.values()) {
      if (organization.id === key || organization.slug === key) {
        return organization;
      }
    }
    return null;
  }

  private findTeam(input: {
    readonly teamKey: string;
    readonly orgKey: string | null;
  }): TeamRecord | null {
    const key = input.teamKey.trim();
    const organization = input.orgKey
      ? this.findOrganization({ orgKey: input.orgKey })
      : null;
    for (const team of this.teams.values()) {
      if (!(team.id === key || team.slug === key)) {
        continue;
      }
      if (organization && team.organizationId !== organization.id) {
        continue;
      }
      return team;
    }
    return null;
  }

  private createActiveMembership(input: {
    readonly scope: "organization" | "team";
    readonly organizationId: string;
    readonly teamId: string | null;
    readonly userId: string | null;
    readonly email: string | null;
    readonly target: string;
  }): MembershipRecord {
    const now = new Date().toISOString();
    const membership: MembershipRecord = {
      id: randomUUID(),
      scope: input.scope,
      state: "active",
      organizationId: input.organizationId,
      teamId: input.teamId,
      userId: input.userId,
      email: input.email,
      target: input.target,
      createdAt: now,
      updatedAt: now,
    };
    this.activeMemberships.set(membership.id, membership);
    return membership;
  }

  private toPendingMembership(input: {
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

  private toRemovedMembership(input: {
    readonly scope: "organization" | "team";
    readonly organizationId: string;
    readonly teamId: string | null;
    readonly userId: string | null;
    readonly email: string | null;
    readonly target: string;
  }): MembershipRecord {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      scope: input.scope,
      state: "removed",
      organizationId: input.organizationId,
      teamId: input.teamId,
      userId: input.userId,
      email: input.email,
      target: input.target,
      createdAt: now,
      updatedAt: now,
    };
  }

  private removePendingInvitationMembership(input: {
    readonly scope: "organization" | "team";
    readonly organizationId: string;
    readonly teamId: string | null;
    readonly target: string;
  }): MembershipRecord | null {
    for (const invitation of this.invitations.values()) {
      if (
        invitation.status !== "pending" ||
        invitation.scope !== input.scope ||
        invitation.organizationId !== input.organizationId ||
        invitation.teamId !== input.teamId ||
        invitation.email !== input.target
      ) {
        continue;
      }
      const removed: InvitationRecord = {
        ...invitation,
        status: "removed",
        updatedAt: new Date().toISOString(),
      };
      this.invitations.set(invitation.id, removed);
      const membership = this.toRemovedMembership({
        scope: invitation.scope,
        organizationId: invitation.organizationId,
        teamId: invitation.teamId,
        userId: null,
        email: invitation.email,
        target: invitation.email,
      });
      this.removedMemberships.set(membership.id, membership);
      return membership;
    }
    return null;
  }

  private removeActiveMembership(input: {
    readonly scope: "organization" | "team";
    readonly organizationId: string;
    readonly teamId: string | null;
    readonly target: string;
  }): MembershipRecord | null {
    for (const [key, membership] of this.activeMemberships.entries()) {
      if (
        membership.scope !== input.scope ||
        membership.organizationId !== input.organizationId ||
        membership.teamId !== input.teamId ||
        membership.target !== input.target
      ) {
        continue;
      }
      this.activeMemberships.delete(key);
      const removed = this.toRemovedMembership({
        scope: membership.scope,
        organizationId: membership.organizationId,
        teamId: membership.teamId,
        userId: membership.userId,
        email: membership.email,
        target: membership.target,
      });
      this.removedMemberships.set(removed.id, removed);
      return removed;
    }
    return null;
  }

  private cascadeRemovedOrganizationTarget(input: {
    readonly organizationId: string;
    readonly target: string;
  }): void {
    const normalizedTarget = input.target.trim();

    for (const invitation of this.invitations.values()) {
      if (
        invitation.status !== "pending" ||
        invitation.scope !== "team" ||
        invitation.organizationId !== input.organizationId ||
        invitation.email !== normalizedTarget
      ) {
        continue;
      }

      this.invitations.set(invitation.id, {
        ...invitation,
        status: "removed",
        updatedAt: new Date().toISOString(),
      });
      const removed = this.toRemovedMembership({
        scope: invitation.scope,
        organizationId: invitation.organizationId,
        teamId: invitation.teamId,
        userId: null,
        email: invitation.email,
        target: invitation.email,
      });
      this.removedMemberships.set(removed.id, removed);
    }

    for (const [key, membership] of this.activeMemberships.entries()) {
      if (
        membership.scope !== "team" ||
        membership.organizationId !== input.organizationId
      ) {
        continue;
      }

      const membershipEmail = membership.email?.trim() ?? "";
      if (
        membership.target !== normalizedTarget &&
        membershipEmail !== normalizedTarget
      ) {
        continue;
      }

      this.activeMemberships.delete(key);
      const removed = this.toRemovedMembership({
        scope: membership.scope,
        organizationId: membership.organizationId,
        teamId: membership.teamId,
        userId: membership.userId,
        email: membership.email,
        target: membership.target,
      });
      this.removedMemberships.set(removed.id, removed);
    }
  }
}
