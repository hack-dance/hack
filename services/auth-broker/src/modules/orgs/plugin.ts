import { Elysia, t } from "elysia";

import type { BetterAuthRuntime } from "../../better-auth.ts";
import { resolveBetterAuthSession } from "../better-auth/session.ts";
import type { MembershipState, OrgTeamsStore } from "./service.ts";

export function createOrgsPlugin(input: {
  readonly store: OrgTeamsStore;
  readonly betterAuthRuntime: BetterAuthRuntime;
}) {
  return new Elysia({
    name: "hack-auth-broker.orgs",
  })
    .get("/v1/auth/orgs", async ({ request, set }) => {
      const session = await requireSession({
        runtime: input.betterAuthRuntime,
        request,
        set,
      });
      if (!session) {
        return;
      }
      const organizations = await input.store.listOrganizations({
        actorUserId: session.userId,
      });
      return { ok: true, organizations } as const;
    })
    .post(
      "/v1/auth/orgs",
      async ({ body, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        const created = await input.store.createOrganization({
          slug: body.slug,
          name: body.name ?? body.slug,
          actorUserId: session.userId,
          actorEmail: session.email,
        });
        return {
          ok: true,
          organization: created.organization,
          membership: created.membership,
        } as const;
      },
      {
        body: t.Object({
          slug: t.String(),
          name: t.Optional(t.String()),
        }),
      }
    )
    .get(
      "/v1/auth/orgs/:org",
      async ({ params, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        const organization = await input.store.getOrganization({
          orgKey: params.org,
          actorUserId: session.userId,
        });
        if (!organization) {
          set.status = 404;
          return { ok: false, error: "org_not_found" } as const;
        }
        return { ok: true, organization } as const;
      },
      { params: t.Object({ org: t.String() }) }
    )
    .get(
      "/v1/auth/orgs/:org/members",
      async ({ params, query, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        const organization = await input.store.getOrganization({
          orgKey: params.org,
          actorUserId: session.userId,
        });
        if (!organization) {
          set.status = 404;
          return { ok: false, error: "org_not_found" } as const;
        }
        const memberships = await input.store.listMembers({
          scope: "organization",
          orgKey: params.org,
          state: normalizeState({ value: query.state }),
        });
        return { ok: true, memberships } as const;
      },
      {
        params: t.Object({ org: t.String() }),
        query: t.Object({ state: t.Optional(t.String()) }),
      }
    )
    .post(
      "/v1/auth/orgs/:org/members/invite",
      async ({ params, body, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        const organization = await input.store.getOrganization({
          orgKey: params.org,
          actorUserId: session.userId,
        });
        if (!organization) {
          set.status = 404;
          return { ok: false, error: "org_not_found" } as const;
        }
        const invited = await input.store.inviteMember({
          scope: "organization",
          orgKey: params.org,
          target: body.target,
          teamTargets: body.teams ?? [],
        });
        if (!invited) {
          set.status = 404;
          return { ok: false, error: "org_not_found" } as const;
        }
        return {
          ok: true,
          invitation: invited.invitation,
          membership: invited.membership,
        } as const;
      },
      {
        params: t.Object({ org: t.String() }),
        body: t.Object({
          target: t.String(),
          teams: t.Optional(t.Array(t.String())),
        }),
      }
    )
    .post(
      "/v1/auth/orgs/:org/members/add",
      async ({ params, body, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        const organization = await input.store.getOrganization({
          orgKey: params.org,
          actorUserId: session.userId,
        });
        if (!organization) {
          set.status = 404;
          return { ok: false, error: "org_not_found" } as const;
        }
        const membership = await input.store.addMember({
          scope: "organization",
          orgKey: params.org,
          target: body.target,
        });
        if (!membership) {
          set.status = 404;
          return { ok: false, error: "org_not_found" } as const;
        }
        return { ok: true, membership } as const;
      },
      {
        params: t.Object({ org: t.String() }),
        body: t.Object({ target: t.String() }),
      }
    )
    .post(
      "/v1/auth/orgs/:org/members/remove",
      async ({ params, body, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        const organization = await input.store.getOrganization({
          orgKey: params.org,
          actorUserId: session.userId,
        });
        if (!organization) {
          set.status = 404;
          return { ok: false, error: "org_not_found" } as const;
        }
        const membership = await input.store.removeMember({
          scope: "organization",
          orgKey: params.org,
          target: body.target,
        });
        if (!membership) {
          set.status = 404;
          return { ok: false, error: "org_membership_not_found" } as const;
        }
        return { ok: true, membership } as const;
      },
      {
        params: t.Object({ org: t.String() }),
        body: t.Object({ target: t.String() }),
      }
    )
    .get(
      "/v1/auth/teams",
      async ({ query, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        const teams = await input.store.listTeams({
          orgKey: normalizeOptionalString(query.org),
          actorUserId: session.userId,
        });
        return { ok: true, teams } as const;
      },
      { query: t.Object({ org: t.Optional(t.String()) }) }
    )
    .post(
      "/v1/auth/teams",
      async ({ body, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        const organization = await input.store.getOrganization({
          orgKey: body.org,
          actorUserId: session.userId,
        });
        if (!organization) {
          set.status = 404;
          return { ok: false, error: "org_not_found" } as const;
        }
        const created = await input.store.createTeam({
          slug: body.slug,
          name: body.name ?? body.slug,
          orgKey: body.org,
          actorUserId: session.userId,
          actorEmail: session.email,
        });
        if (!created) {
          set.status = 404;
          return { ok: false, error: "org_not_found" } as const;
        }
        return {
          ok: true,
          team: created.team,
          membership: created.membership,
        } as const;
      },
      {
        body: t.Object({
          slug: t.String(),
          org: t.String(),
          name: t.Optional(t.String()),
        }),
      }
    )
    .get(
      "/v1/auth/teams/:team",
      async ({ params, query, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        const team = await input.store.getTeam({
          teamKey: params.team,
          orgKey: normalizeOptionalString(query.org),
          actorUserId: session.userId,
        });
        if (!team) {
          set.status = 404;
          return { ok: false, error: "team_not_found" } as const;
        }
        return { ok: true, team } as const;
      },
      {
        params: t.Object({ team: t.String() }),
        query: t.Object({ org: t.Optional(t.String()) }),
      }
    )
    .get(
      "/v1/auth/teams/:team/members",
      async ({ params, query, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        const orgKey = normalizeOptionalString(query.org);
        if (!orgKey) {
          set.status = 400;
          return { ok: false, error: "org_required" } as const;
        }
        const team = await input.store.getTeam({
          teamKey: params.team,
          orgKey,
          actorUserId: session.userId,
        });
        if (!team) {
          set.status = 404;
          return { ok: false, error: "team_not_found" } as const;
        }
        const memberships = await input.store.listMembers({
          scope: "team",
          orgKey,
          teamKey: params.team,
          state: normalizeState({ value: query.state }),
        });
        return { ok: true, memberships } as const;
      },
      {
        params: t.Object({ team: t.String() }),
        query: t.Object({
          org: t.Optional(t.String()),
          state: t.Optional(t.String()),
        }),
      }
    )
    .post(
      "/v1/auth/teams/:team/members/invite",
      async ({ params, body, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        const team = await input.store.getTeam({
          teamKey: params.team,
          orgKey: body.org,
          actorUserId: session.userId,
        });
        if (!team) {
          set.status = 404;
          return { ok: false, error: "team_not_found" } as const;
        }
        const hasParentOrgMembership = await hasActiveParentOrgMembership({
          store: input.store,
          orgKey: body.org,
          target: body.target,
        });
        if (!hasParentOrgMembership) {
          set.status = 409;
          return {
            ok: false,
            error: "team_member_requires_active_org_membership",
          } as const;
        }
        const invited = await input.store.inviteMember({
          scope: "team",
          orgKey: body.org,
          teamKey: params.team,
          target: body.target,
        });
        if (!invited) {
          set.status = 404;
          return { ok: false, error: "team_not_found" } as const;
        }
        return {
          ok: true,
          invitation: invited.invitation,
          membership: invited.membership,
        } as const;
      },
      {
        params: t.Object({ team: t.String() }),
        body: t.Object({
          org: t.String(),
          target: t.String(),
        }),
      }
    )
    .post(
      "/v1/auth/teams/:team/members/add",
      async ({ params, body, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        const team = await input.store.getTeam({
          teamKey: params.team,
          orgKey: body.org,
          actorUserId: session.userId,
        });
        if (!team) {
          set.status = 404;
          return { ok: false, error: "team_not_found" } as const;
        }
        const hasParentOrgMembership = await hasActiveParentOrgMembership({
          store: input.store,
          orgKey: body.org,
          target: body.target,
        });
        if (!hasParentOrgMembership) {
          set.status = 409;
          return {
            ok: false,
            error: "team_member_requires_active_org_membership",
          } as const;
        }
        const membership = await input.store.addMember({
          scope: "team",
          orgKey: body.org,
          teamKey: params.team,
          target: body.target,
        });
        if (!membership) {
          set.status = 404;
          return { ok: false, error: "team_not_found" } as const;
        }
        return { ok: true, membership } as const;
      },
      {
        params: t.Object({ team: t.String() }),
        body: t.Object({
          org: t.String(),
          target: t.String(),
        }),
      }
    )
    .post(
      "/v1/auth/teams/:team/members/remove",
      async ({ params, body, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        const team = await input.store.getTeam({
          teamKey: params.team,
          orgKey: body.org,
          actorUserId: session.userId,
        });
        if (!team) {
          set.status = 404;
          return { ok: false, error: "team_not_found" } as const;
        }
        const membership = await input.store.removeMember({
          scope: "team",
          orgKey: body.org,
          teamKey: params.team,
          target: body.target,
        });
        if (!membership) {
          set.status = 404;
          return { ok: false, error: "team_membership_not_found" } as const;
        }
        return { ok: true, membership } as const;
      },
      {
        params: t.Object({ team: t.String() }),
        body: t.Object({
          org: t.String(),
          target: t.String(),
        }),
      }
    )
    .get("/v1/auth/invitations", async ({ request, set }) => {
      const session = await requireSession({
        runtime: input.betterAuthRuntime,
        request,
        set,
      });
      if (!session) {
        return;
      }
      if (!session.email) {
        set.status = 400;
        return { ok: false, error: "better_auth_email_required" } as const;
      }
      const invitations = await input.store.listInvitationsForEmail({
        email: session.email,
      });
      return { ok: true, invitations } as const;
    })
    .post(
      "/v1/auth/invitations/:inviteId/accept",
      async ({ params, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        if (!session.email) {
          set.status = 400;
          return { ok: false, error: "better_auth_email_required" } as const;
        }
        const membership = await input.store.acceptInvitation({
          inviteId: params.inviteId,
          userId: session.userId,
          email: session.email,
        });
        if (!membership) {
          set.status = 404;
          return { ok: false, error: "invitation_not_found" } as const;
        }
        return { ok: true, membership } as const;
      },
      { params: t.Object({ inviteId: t.String() }) }
    )
    .post(
      "/v1/auth/invitations/:inviteId/decline",
      async ({ params, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        if (!session.email) {
          set.status = 400;
          return { ok: false, error: "better_auth_email_required" } as const;
        }
        const membership = await input.store.declineInvitation({
          inviteId: params.inviteId,
          email: session.email,
        });
        if (!membership) {
          set.status = 404;
          return { ok: false, error: "invitation_not_found" } as const;
        }
        return { ok: true, membership } as const;
      },
      { params: t.Object({ inviteId: t.String() }) }
    );
}

async function requireSession(input: {
  readonly runtime: BetterAuthRuntime;
  readonly request: Request;
  readonly set: { status?: number | string };
}) {
  const session = await resolveBetterAuthSession({
    runtime: input.runtime,
    request: input.request,
  });
  if (session.enabled && !session.session) {
    input.set.status = 401;
    return null;
  }
  return session.session;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeState(input: {
  readonly value: string | undefined;
}): MembershipState | "all" | "actionable" {
  const normalized = normalizeOptionalString(input.value);
  if (
    normalized === "pending" ||
    normalized === "active" ||
    normalized === "removed" ||
    normalized === "all"
  ) {
    return normalized;
  }
  return "actionable";
}

async function hasActiveParentOrgMembership(input: {
  readonly store: OrgTeamsStore;
  readonly orgKey: string;
  readonly target: string;
}): Promise<boolean> {
  const memberships = await input.store.listMembers({
    scope: "organization",
    orgKey: input.orgKey,
    state: "active",
  });
  const normalizedTarget = input.target.trim();
  return memberships.some((membership) => {
    const membershipTarget = membership.target.trim();
    const membershipEmail = membership.email?.trim() ?? "";
    return (
      membershipTarget === normalizedTarget ||
      membershipEmail === normalizedTarget
    );
  });
}
