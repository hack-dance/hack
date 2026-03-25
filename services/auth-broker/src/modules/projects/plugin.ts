import { Elysia, t } from "elysia";

import type { BetterAuthRuntime } from "../../better-auth.ts";
import { resolveBetterAuthSession } from "../better-auth/session.ts";
import type { ProjectStore } from "./service.ts";

export function createProjectsPlugin(input: {
  readonly projectStore: ProjectStore;
  readonly betterAuthRuntime: BetterAuthRuntime;
}) {
  return new Elysia({
    name: "hack-auth-broker.projects",
  })
    .get("/v1/auth/projects", async ({ request, set }) => {
      const session = await requireSession({
        runtime: input.betterAuthRuntime,
        request,
        set,
      });
      if (!session) {
        return;
      }
      const projects = await input.projectStore.listProjects({
        actorUserId: session.userId,
      });
      return { ok: true, projects } as const;
    })
    .post(
      "/v1/auth/projects",
      async ({ body, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        const result = await input.projectStore.registerProject({
          slug: body.slug,
          name: body.name,
          mode: body.mode,
          orgKey: normalizeOptionalString(body.org),
          teamKey: normalizeOptionalString(body.team),
          actorUserId: session.userId,
          actorEmail: session.email,
        });
        if (result.ok) {
          return {
            ok: true,
            status: result.status,
            project: result.project,
          } as const;
        }
        set.status =
          result.error === "project_registration_conflict" ? 409 : 400;
        return {
          ok: false,
          error: result.error,
          ...(result.existing ? { existing: result.existing } : {}),
          ...(result.incoming ? { incoming: result.incoming } : {}),
        } as const;
      },
      {
        body: t.Object({
          slug: t.String(),
          name: t.Optional(t.String()),
          mode: t.Union([
            t.Literal("local"),
            t.Literal("organization"),
            t.Literal("team"),
          ]),
          org: t.Optional(t.String()),
          team: t.Optional(t.String()),
        }),
      }
    )
    .get(
      "/v1/auth/projects/:project",
      async ({ params, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        const [project, access] = await Promise.all([
          input.projectStore.getProject({
            projectKey: params.project,
            actorUserId: session.userId,
          }),
          input.projectStore.listAccess({
            projectKey: params.project,
            actorUserId: session.userId,
          }),
        ]);
        if (!(project && access)) {
          set.status = 404;
          return {
            ok: false,
            error: "project_not_found",
          } as const;
        }
        return { ok: true, project, access } as const;
      },
      {
        params: t.Object({
          project: t.String(),
        }),
      }
    )
    .get(
      "/v1/auth/projects/:project/access",
      async ({ params, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        const access = await input.projectStore.listAccess({
          projectKey: params.project,
          actorUserId: session.userId,
        });
        if (!access) {
          set.status = 404;
          return {
            ok: false,
            error: "project_not_found",
          } as const;
        }
        return { ok: true, access } as const;
      },
      {
        params: t.Object({
          project: t.String(),
        }),
      }
    )
    .post(
      "/v1/auth/projects/:project/access/grant",
      async ({ body, params, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        const result = await input.projectStore.grantAccess({
          projectKey: params.project,
          actorUserId: session.userId,
          scope: body.scope,
          role: body.role,
          orgKey: normalizeOptionalString(body.org),
          teamKey: normalizeOptionalString(body.team),
        });
        if (result.ok) {
          return {
            ok: true,
            status: result.status,
            access: result.access,
          } as const;
        }
        set.status = resolveProjectMutationStatus({
          error: result.error,
        });
        return {
          ok: false,
          error: result.error,
        } as const;
      },
      {
        params: t.Object({
          project: t.String(),
        }),
        body: t.Object({
          scope: t.Union([t.Literal("organization"), t.Literal("team")]),
          role: t.Union([t.Literal("viewer"), t.Literal("admin")]),
          org: t.Optional(t.String()),
          team: t.Optional(t.String()),
        }),
      }
    )
    .post(
      "/v1/auth/projects/:project/access/revoke",
      async ({ body, params, request, set }) => {
        const session = await requireSession({
          runtime: input.betterAuthRuntime,
          request,
          set,
        });
        if (!session) {
          return;
        }
        const result = await input.projectStore.revokeAccess({
          projectKey: params.project,
          actorUserId: session.userId,
          grantId: body.grantId,
        });
        if (result.ok) {
          return {
            ok: true,
            status: result.status,
            access: result.access,
          } as const;
        }
        set.status = resolveProjectMutationStatus({
          error: result.error,
        });
        return {
          ok: false,
          error: result.error,
        } as const;
      },
      {
        params: t.Object({
          project: t.String(),
        }),
        body: t.Object({
          grantId: t.String(),
        }),
      }
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

function resolveProjectMutationStatus(input: { readonly error: string }) {
  switch (input.error) {
    case "project_not_found":
    case "project_access_grant_not_found":
      return 404;
    case "project_access_forbidden":
      return 403;
    case "project_access_target_not_visible":
    case "project_access_conflict":
    case "project_access_local_mode":
      return 409;
    default:
      return 400;
  }
}

function normalizeOptionalString(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
