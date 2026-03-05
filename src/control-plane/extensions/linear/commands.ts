import { createHash, randomBytes, randomUUID } from "node:crypto";

import { secrets } from "bun";

import {
  updateGlobalConfig,
  updateProjectConfig,
} from "../../../lib/config.ts";
import { isRecord } from "../../../lib/guards.ts";
import { openUrl } from "../../../lib/os.ts";
import { display } from "../../../ui/display.ts";
import {
  createTicketsStore,
  type TicketStatus,
  type TicketSummary,
} from "../tickets/store.ts";
import { normalizeTicketRef } from "../tickets/util.ts";
import type { ExtensionCommand, ExtensionCommandContext } from "../types.ts";
import {
  deleteLinearToken,
  listLinearAuthProfiles,
  resolveLinearAuthSettings,
  resolveLinearAuthSettingsResult,
  resolveLinearToken,
  saveLinearToken,
} from "./auth.ts";
import {
  createLinearClient,
  type LinearIssue,
  type LinearWorkflowState,
  type LinearWorkflowStateType,
} from "./client.ts";

const EXTENSION_ID = "dance.hack.linear";
const DEFAULT_OAUTH_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const DEFAULT_OAUTH_TOKEN_URL = "https://api.linear.app/oauth/token";
const DEFAULT_OAUTH_SCOPES = "read,write,app:mentionable,app:assignable";
const DEFAULT_OAUTH_ACTOR = "app";
const DEFAULT_OAUTH_BROKER_URL = "https://auth.hack.broker";
const DEFAULT_OAUTH_BROKER_URL_ENV = "HACK_AUTH_BROKER_URL";
const DEFAULT_OAUTH_BROKER_URL_ENV_FALLBACK = "HACK_LINEAR_OAUTH_BROKER_URL";
const DEFAULT_OAUTH_CLIENT_ID_ENV = "HACK_LINEAR_OAUTH_CLIENT_ID";
const DEFAULT_OAUTH_CLIENT_ID_ENV_FALLBACK = "HACK_LINEAR_CLIENT_ID";
const DEFAULT_OAUTH_CLIENT_SECRET_ENV = "HACK_LINEAR_SECRET";
const DEFAULT_OAUTH_CLIENT_SECRET_ENV_FALLBACK = "LINEAR_CLIENT_SECRET";
const DEFAULT_OAUTH_CLIENT_SECRET_AUTH_REF = "linear.oauth.client_secret";
const DEFAULT_OAUTH_SECRET_SERVICE = "hack-linear-auth";
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const OAUTH_POLL_INTERVAL_MS = 1000;
const DEFAULT_PROJECT_SYNC_LIMIT = 100;
const TRAILING_SLASH_REGEX = /\/+$/;

export const LINEAR_COMMANDS: readonly ExtensionCommand[] = [
  {
    name: "setup",
    summary: "Enable Linear extension and wire project defaults",
    scope: "project",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." });
        return 1;
      }
      const parsed = parseSetupArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      await enableLinearProjectExtension({
        projectDir: ctx.project.projectDir,
      });

      if (parsed.value.profileId) {
        await updateProjectConfig({
          projectDir: ctx.project.projectDir,
          path: "controlPlane.routing.overrides.linear.profile",
          value: parsed.value.profileId,
        });
      }
      if (parsed.value.projectId) {
        await updateProjectConfig({
          projectDir: ctx.project.projectDir,
          path: "controlPlane.routing.overrides.linear.projectId",
          value: parsed.value.projectId,
        });
      }
      if (parsed.value.projectName !== undefined) {
        await updateProjectConfig({
          projectDir: ctx.project.projectDir,
          path: "controlPlane.routing.overrides.linear.projectName",
          value: parsed.value.projectName,
        });
      }
      if (parsed.value.teamId !== undefined) {
        await updateProjectConfig({
          projectDir: ctx.project.projectDir,
          path: "controlPlane.routing.overrides.linear.teamId",
          value: parsed.value.teamId,
        });
      }

      const payload = {
        ok: true,
        extension: EXTENSION_ID,
        projectProfile: parsed.value.profileId ?? null,
        projectId: parsed.value.projectId ?? null,
        projectName: parsed.value.projectName ?? null,
        teamId: parsed.value.teamId ?? null,
      };

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return 0;
      }

      await display.kv({
        title: "Linear setup",
        entries: [
          ["extension", EXTENSION_ID],
          ["project_profile", parsed.value.profileId ?? ""],
          ["linear_project_id", parsed.value.projectId ?? ""],
          ["linear_project_name", parsed.value.projectName ?? ""],
          ["linear_team_id", parsed.value.teamId ?? ""],
        ],
      });
      return 0;
    },
  },
  {
    name: "connect",
    summary:
      "Connect Linear profile (token mode, or browser OAuth fallback when no token is provided)",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      const parsed = parseConnectArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const defaults = resolveLinearAuthSettings({
        controlPlaneConfig: ctx.controlPlaneConfig,
        ...(parsed.value.profileId
          ? { profileId: parsed.value.profileId }
          : {}),
        allowProjectOverride: false,
      });

      const profileId = parsed.value.profileId ?? defaults.profileId;
      const tokenEnv = parsed.value.tokenEnv ?? defaults.tokenEnv;
      const authRef = parsed.value.authRef ?? defaults.authRef;
      const service = parsed.value.service ?? defaults.service;
      const apiUrl = parsed.value.apiUrl ?? defaults.apiUrl;

      const tokenResolution = await resolveConnectToken({
        token: parsed.value.token,
        stdin: parsed.value.stdin,
        tokenEnv,
        expiresAt: parsed.value.tokenExpiresAt,
        refreshToken: parsed.value.refreshToken,
        refreshTokenExpiresAt: parsed.value.refreshTokenExpiresAt,
      });
      if (!tokenResolution.ok) {
        const fallbackToOauth = shouldFallbackConnectToOAuth({
          parsed: parsed.value,
          tokenEnv,
        });
        if (!fallbackToOauth) {
          ctx.logger.error({ message: tokenResolution.error });
          return 1;
        }

        return await handleLinearOAuthConnectCommand({
          ctx,
          args: buildOAuthArgsFromConnectArgs({
            parsed: parsed.value,
            profileId,
          }),
        });
      }

      const client = createLinearClient({
        token: tokenResolution.token,
        apiUrl,
      });
      const viewer = await client.getViewer();
      if (!viewer.ok) {
        ctx.logger.error({
          message: `Failed to validate Linear token: ${viewer.error}`,
        });
        return 1;
      }

      await saveLinearToken({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId,
        allowProjectOverride: false,
        token: tokenResolution.token,
        ...(tokenResolution.expiresAt
          ? { expiresAt: tokenResolution.expiresAt }
          : {}),
        ...(tokenResolution.refreshToken
          ? { refreshToken: tokenResolution.refreshToken }
          : {}),
        ...(tokenResolution.refreshTokenExpiresAt
          ? { refreshTokenExpiresAt: tokenResolution.refreshTokenExpiresAt }
          : {}),
        authRef,
        service,
      });

      const setAsDefault = shouldSetProfileAsDefault({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId,
        setDefaultFlag: parsed.value.setDefault,
      });

      await persistLinearProfileDefaults({
        profileId,
        tokenEnv,
        authRef,
        service,
        apiUrl,
        accountId: viewer.data.id,
        accountName: viewer.data.displayName ?? viewer.data.name,
        accountEmail: viewer.data.email,
        setAsDefault,
      });

      await display.kv({
        title: "Linear connected",
        entries: [
          ["profile", profileId],
          ["set_default", setAsDefault ? "yes" : "no"],
          ["auth_ref", authRef],
          ["service", service],
          ["token_env_fallback", tokenEnv],
          ["api_url", apiUrl],
          ["account_id", viewer.data.id],
          ["account_name", viewer.data.displayName ?? viewer.data.name ?? ""],
          ["account_email", viewer.data.email ?? ""],
        ],
      });

      return 0;
    },
  },
  {
    name: "oauth-connect",
    summary: "Run browser OAuth flow and bind token to a Linear profile",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) =>
      await handleLinearOAuthConnectCommand({
        ctx,
        args,
      }),
  },
  {
    name: "disconnect",
    summary: "Delete a stored Linear token for a profile",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      const parsed = parseDisconnectArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }
      const deleted = await deleteLinearToken({
        controlPlaneConfig: ctx.controlPlaneConfig,
        ...(parsed.value.profileId
          ? { profileId: parsed.value.profileId }
          : {}),
        allowProjectOverride: false,
        ...(parsed.value.authRef ? { authRef: parsed.value.authRef } : {}),
        ...(parsed.value.service ? { service: parsed.value.service } : {}),
      });

      await display.kv({
        title: "Linear disconnected",
        entries: [
          ["profile", deleted.profileId],
          ["auth_ref", deleted.authRef],
          ["service", deleted.service],
          ["deleted", deleted.deleted ? "yes" : "no"],
        ],
      });
      return deleted.deleted ? 0 : 1;
    },
  },
  {
    name: "status",
    summary: "Show Linear profile/config resolution and token status",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) =>
      await handleLinearStatusCommand({
        ctx,
        args,
      }),
  },
  {
    name: "profiles",
    summary: "List configured Linear auth profiles",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      const parsed = parseProfilesArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }
      const catalog = listLinearAuthProfiles({
        controlPlaneConfig: ctx.controlPlaneConfig,
        allowProjectOverride: true,
      });
      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
      } else {
        await display.kv({
          title: "Linear profile selection",
          entries: [
            ["selected_profile", catalog.selectedProfileId],
            ["selected_source", catalog.selectedProfileSource],
            ["default_profile", catalog.defaultProfileId],
            ["project_override", catalog.projectProfileOverride ?? ""],
            ["selected_missing", catalog.selectedProfileMissing ? "yes" : "no"],
          ],
        });
        await display.table({
          columns: [
            "Profile",
            "Default",
            "Auth Ref",
            "Service",
            "Token Env",
            "Account",
          ],
          rows: catalog.profiles.map((profile) => [
            profile.id,
            profile.isDefault ? "yes" : "",
            profile.authRef,
            profile.service,
            profile.tokenEnv,
            profile.accountName ??
              profile.accountEmail ??
              profile.accountId ??
              "",
          ]),
        });
      }
      return catalog.selectedProfileMissing ? 1 : 0;
    },
  },
  {
    name: "use",
    summary: "Set global default Linear profile",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      const parsed = parseUseArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }
      const settings = resolveLinearAuthSettingsResult({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId: parsed.value.profileId,
        allowProjectOverride: false,
      });
      if (!settings.ok) {
        ctx.logger.error({ message: settings.error });
        return 1;
      }
      await updateGlobalConfig({
        path: `controlPlane.extensions["${EXTENSION_ID}"].config.defaultProfile`,
        value: parsed.value.profileId,
      });
      await display.kv({
        title: "Linear default profile updated",
        entries: [["profile", parsed.value.profileId]],
      });
      return 0;
    },
  },
  {
    name: "projects",
    summary: "List projects available to the selected Linear profile",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      const parsed = parseProjectsArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }
      const token = await resolveLinearTokenWithBrokerRefresh({
        controlPlaneConfig: ctx.controlPlaneConfig,
        ...(parsed.value.profileId
          ? { profileId: parsed.value.profileId }
          : {}),
        allowProjectOverride: !parsed.value.profileId,
      });
      if (!token.ok) {
        ctx.logger.error({ message: token.error });
        return 1;
      }
      const settings = resolveLinearAuthSettings({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId: token.profileId,
        allowProjectOverride: false,
      });
      const client = createLinearClient({
        token: token.token,
        apiUrl: settings.apiUrl,
      });
      const projects = await client.listProjects({
        ...(parsed.value.limit ? { first: parsed.value.limit } : {}),
      });
      if (!projects.ok) {
        ctx.logger.error({ message: projects.error });
        return 1;
      }

      const payload = {
        profile: token.profileId,
        projects: projects.data,
      };
      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return 0;
      }

      await display.table({
        columns: ["Project ID", "Project", "Team", "Team ID"],
        rows: projects.data.map((project) => [
          project.id,
          project.name,
          project.teamKey ?? project.teamName ?? "",
          project.teamId,
        ]),
      });
      return 0;
    },
  },
  {
    name: "project-bind",
    summary: "Bind current hack project to a default Linear profile/project",
    scope: "project",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." });
        return 1;
      }
      const parsed = parseProjectBindArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      await enableLinearProjectExtension({
        projectDir: ctx.project.projectDir,
      });

      if (parsed.value.clear) {
        await Promise.all([
          updateProjectConfig({
            projectDir: ctx.project.projectDir,
            path: "controlPlane.routing.overrides.linear.profile",
            value: "",
          }),
          updateProjectConfig({
            projectDir: ctx.project.projectDir,
            path: "controlPlane.routing.overrides.linear.projectId",
            value: "",
          }),
          updateProjectConfig({
            projectDir: ctx.project.projectDir,
            path: "controlPlane.routing.overrides.linear.projectName",
            value: "",
          }),
          updateProjectConfig({
            projectDir: ctx.project.projectDir,
            path: "controlPlane.routing.overrides.linear.teamId",
            value: "",
          }),
        ]);

        if (parsed.value.json) {
          process.stdout.write(
            `${JSON.stringify({ ok: true, cleared: true }, null, 2)}\n`
          );
        } else {
          await display.panel({
            title: "Linear project binding",
            tone: "success",
            lines: ["Cleared project-level Linear routing overrides."],
          });
        }
        return 0;
      }

      const boundProfile =
        parsed.value.profileId ??
        resolveProjectLinearBinding({
          controlPlaneConfig: ctx.controlPlaneConfig,
        }).profileId;

      if (boundProfile) {
        await updateProjectConfig({
          projectDir: ctx.project.projectDir,
          path: "controlPlane.routing.overrides.linear.profile",
          value: boundProfile,
        });
      }

      const projectId = parsed.value.projectId;
      if (!projectId) {
        ctx.logger.error({
          message:
            "Missing --project-id. Use --clear to remove mapping or pass a Linear project id to bind.",
        });
        return 1;
      }

      const resolvedTeamAndName = await resolveProjectBindingDetails({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId: parsed.value.profileId,
        projectId,
        projectName: parsed.value.projectName,
        teamId: parsed.value.teamId,
      });
      if (!resolvedTeamAndName.ok) {
        ctx.logger.error({ message: resolvedTeamAndName.error });
        return 1;
      }

      await Promise.all([
        updateProjectConfig({
          projectDir: ctx.project.projectDir,
          path: "controlPlane.routing.overrides.linear.projectId",
          value: projectId,
        }),
        updateProjectConfig({
          projectDir: ctx.project.projectDir,
          path: "controlPlane.routing.overrides.linear.projectName",
          value: resolvedTeamAndName.projectName,
        }),
        updateProjectConfig({
          projectDir: ctx.project.projectDir,
          path: "controlPlane.routing.overrides.linear.teamId",
          value: resolvedTeamAndName.teamId,
        }),
      ]);

      const payload = {
        ok: true,
        profileId: boundProfile ?? null,
        projectId,
        projectName: resolvedTeamAndName.projectName,
        teamId: resolvedTeamAndName.teamId,
      };

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        await display.kv({
          title: "Linear project binding",
          entries: [
            ["profile", payload.profileId ?? ""],
            ["project_id", payload.projectId],
            ["project_name", payload.projectName],
            ["team_id", payload.teamId],
          ],
        });
      }
      return 0;
    },
  },
  {
    name: "sync-issue",
    summary:
      "One-off manual sync for a single issue/ticket in either direction",
    scope: "project",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." });
        return 1;
      }
      const parsed = parseSyncIssueArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const runtime = await createSyncRuntime({
        ctx,
        profileId: parsed.value.profileId,
      });
      if (!runtime.ok) {
        ctx.logger.error({ message: runtime.error });
        return 1;
      }

      const toggles = resolveSyncToggles({
        controlPlaneConfig: ctx.controlPlaneConfig,
        labelsOverride: parsed.value.syncLabels,
      });

      if (parsed.value.from === "linear") {
        const issueIdentifier = parsed.value.issueIdentifier;
        if (!issueIdentifier) {
          ctx.logger.error({
            message: "Missing --issue <IDENTIFIER> for --from linear.",
          });
          return 1;
        }
        const synced = await syncIssueFromLinearToTicket({
          runtime: runtime.value,
          issueIdentifier,
          syncToggles: toggles,
        });
        if (!synced.ok) {
          ctx.logger.error({ message: synced.error });
          return 1;
        }

        if (parsed.value.json) {
          process.stdout.write(`${JSON.stringify(synced, null, 2)}\n`);
        } else {
          await display.kv({
            title: "Linear -> ticket sync",
            entries: [
              ["ticket_id", synced.ticketId],
              ["linear_issue", synced.issueIdentifier],
              ["operation", synced.operation],
            ],
          });
        }
        return 0;
      }

      const ticketInput = parsed.value.ticketId;
      if (!ticketInput) {
        ctx.logger.error({
          message: "Missing --ticket <T-00001> for --from hack.",
        });
        return 1;
      }
      const normalizedTicketId = normalizeTicketRef(ticketInput);
      if (!normalizedTicketId) {
        ctx.logger.error({ message: `Invalid ticket id: ${ticketInput}` });
        return 1;
      }

      const synced = await syncTicketToLinearIssue({
        runtime: runtime.value,
        ticketId: normalizedTicketId,
        explicitProjectId: parsed.value.projectId,
        explicitTeamId: parsed.value.teamId,
        syncToggles: toggles,
      });
      if (!synced.ok) {
        ctx.logger.error({ message: synced.error });
        return 1;
      }

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(synced, null, 2)}\n`);
      } else {
        await display.kv({
          title: "Ticket -> Linear sync",
          entries: [
            ["ticket_id", synced.ticketId],
            ["linear_issue", synced.issueIdentifier],
            ["operation", synced.operation],
          ],
        });
      }
      return 0;
    },
  },
  {
    name: "sync-project",
    summary:
      "Manual bulk sync for a bound/selected project in either direction",
    scope: "project",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." });
        return 1;
      }
      const parsed = parseSyncProjectArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const runtime = await createSyncRuntime({
        ctx,
        profileId: parsed.value.profileId,
      });
      if (!runtime.ok) {
        ctx.logger.error({ message: runtime.error });
        return 1;
      }

      const toggles = resolveSyncToggles({
        controlPlaneConfig: ctx.controlPlaneConfig,
        labelsOverride: parsed.value.syncLabels,
      });

      if (parsed.value.from === "linear") {
        const bound = resolveProjectLinearBinding({
          controlPlaneConfig: ctx.controlPlaneConfig,
        });
        const projectId = parsed.value.projectId ?? bound.projectId;
        if (!projectId) {
          ctx.logger.error({
            message:
              "Missing project id. Pass --project-id or run `hack x linear project-bind --project-id ...` first.",
          });
          return 1;
        }

        const syncResult = await syncProjectFromLinearToTickets({
          runtime: runtime.value,
          projectId,
          limit: parsed.value.limit,
          syncToggles: toggles,
        });
        if (!syncResult.ok) {
          ctx.logger.error({ message: syncResult.error });
          return 1;
        }

        if (parsed.value.json) {
          process.stdout.write(`${JSON.stringify(syncResult, null, 2)}\n`);
        } else {
          await display.kv({
            title: "Linear project -> tickets sync",
            entries: [
              ["linear_project_id", projectId],
              ["processed", String(syncResult.processed)],
              ["created", String(syncResult.created)],
              ["updated", String(syncResult.updated)],
            ],
          });
        }
        return 0;
      }

      const bound = resolveProjectLinearBinding({
        controlPlaneConfig: ctx.controlPlaneConfig,
      });
      const projectId = parsed.value.projectId ?? bound.projectId;
      const syncResult = await syncProjectFromTicketsToLinear({
        runtime: runtime.value,
        projectId,
        explicitTeamId: parsed.value.teamId ?? bound.teamId,
        limit: parsed.value.limit,
        ownerMode: parsed.value.ownerMode,
        syncToggles: toggles,
      });
      if (!syncResult.ok) {
        ctx.logger.error({ message: syncResult.error });
        return 1;
      }

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(syncResult, null, 2)}\n`);
      } else {
        await display.kv({
          title: "Tickets -> Linear project sync",
          entries: [
            ["linear_project_id", projectId ?? ""],
            ["processed", String(syncResult.processed)],
            ["created", String(syncResult.created)],
            ["updated", String(syncResult.updated)],
          ],
        });
      }
      return 0;
    },
  },
];

type LinearCommandContext = ExtensionCommandContext;

async function handleLinearOAuthConnectCommand(input: {
  readonly ctx: LinearCommandContext;
  readonly args: readonly string[];
}): Promise<number> {
  const parsed = parseOAuthConnectArgs({ args: input.args });
  if (!parsed.ok) {
    input.ctx.logger.error({ message: parsed.error });
    return 1;
  }

  const defaults = resolveLinearAuthSettings({
    controlPlaneConfig: input.ctx.controlPlaneConfig,
    ...(parsed.value.profileId ? { profileId: parsed.value.profileId } : {}),
    allowProjectOverride: false,
  });
  const resolved = {
    profileId: parsed.value.profileId ?? defaults.profileId,
    apiUrl: parsed.value.apiUrl ?? defaults.apiUrl,
    tokenEnv: parsed.value.tokenEnv ?? defaults.tokenEnv,
    authRef: parsed.value.authRef ?? defaults.authRef,
    service: parsed.value.service ?? defaults.service,
  };

  let oauthFlow:
    | {
        readonly ok: true;
        readonly tokenExchange: {
          readonly token: string;
          readonly expiresAt?: string;
          readonly refreshToken?: string;
          readonly refreshTokenExpiresAt?: string;
        };
      }
    | { readonly ok: false; readonly error: string };

  if (shouldUseBrokerOAuthFlow({ parsed: parsed.value })) {
    oauthFlow = await runLinearBrokerOAuthFlow({
      parsed: parsed.value,
      brokerConfig: resolveOAuthBrokerRuntimeConfig({
        controlPlaneConfig: input.ctx.controlPlaneConfig,
      }),
      profileId: resolved.profileId,
    });
    if (!oauthFlow.ok) {
      const oauthConfig = await resolveOAuthRuntimeConfig({
        controlPlaneConfig: input.ctx.controlPlaneConfig,
        parsed: parsed.value,
      });
      if (!oauthConfig.ok) {
        input.ctx.logger.error({
          message: `${oauthFlow.error} Local fallback also is not configured: ${oauthConfig.error}`,
        });
        return 1;
      }
      oauthFlow = await runLinearOAuthFlow({
        parsed: parsed.value,
        oauthConfig: oauthConfig.value,
      });
    }
  } else {
    const oauthConfig = await resolveOAuthRuntimeConfig({
      controlPlaneConfig: input.ctx.controlPlaneConfig,
      parsed: parsed.value,
    });
    if (!oauthConfig.ok) {
      input.ctx.logger.error({ message: oauthConfig.error });
      return 1;
    }

    oauthFlow = await runLinearOAuthFlow({
      parsed: parsed.value,
      oauthConfig: oauthConfig.value,
    });
  }
  if (!oauthFlow.ok) {
    input.ctx.logger.error({ message: oauthFlow.error });
    return 1;
  }

  const client = createLinearClient({
    token: oauthFlow.tokenExchange.token,
    apiUrl: resolved.apiUrl,
  });
  const viewer = await client.getViewer();
  if (!viewer.ok) {
    input.ctx.logger.error({
      message: `OAuth succeeded but token verification failed: ${viewer.error}`,
    });
    return 1;
  }

  await saveLinearToken({
    controlPlaneConfig: input.ctx.controlPlaneConfig,
    profileId: resolved.profileId,
    allowProjectOverride: false,
    token: oauthFlow.tokenExchange.token,
    ...(oauthFlow.tokenExchange.expiresAt
      ? { expiresAt: oauthFlow.tokenExchange.expiresAt }
      : {}),
    ...(oauthFlow.tokenExchange.refreshToken
      ? { refreshToken: oauthFlow.tokenExchange.refreshToken }
      : {}),
    ...(oauthFlow.tokenExchange.refreshTokenExpiresAt
      ? { refreshTokenExpiresAt: oauthFlow.tokenExchange.refreshTokenExpiresAt }
      : {}),
    authRef: resolved.authRef,
    service: resolved.service,
  });

  const setAsDefault = shouldSetProfileAsDefault({
    controlPlaneConfig: input.ctx.controlPlaneConfig,
    profileId: resolved.profileId,
    setDefaultFlag: parsed.value.setDefault,
  });

  await persistLinearProfileDefaults({
    profileId: resolved.profileId,
    tokenEnv: resolved.tokenEnv,
    authRef: resolved.authRef,
    service: resolved.service,
    apiUrl: resolved.apiUrl,
    accountId: viewer.data.id,
    accountName: viewer.data.displayName ?? viewer.data.name,
    accountEmail: viewer.data.email,
    setAsDefault,
  });

  await display.kv({
    title: "Linear OAuth connected",
    entries: [
      ["profile", resolved.profileId],
      ["set_default", setAsDefault ? "yes" : "no"],
      ["auth_ref", resolved.authRef],
      ["service", resolved.service],
      ["token_env_fallback", resolved.tokenEnv],
      ["api_url", resolved.apiUrl],
      ["account_id", viewer.data.id],
      ["account_name", viewer.data.displayName ?? viewer.data.name ?? ""],
      ["account_email", viewer.data.email ?? ""],
    ],
  });
  return 0;
}

async function handleLinearStatusCommand(input: {
  readonly ctx: LinearCommandContext;
  readonly args: readonly string[];
}): Promise<number> {
  const parsed = parseStatusArgs({ args: input.args });
  if (!parsed.ok) {
    input.ctx.logger.error({ message: parsed.error });
    return 1;
  }

  const payload = await resolveLinearStatusPayload({
    controlPlaneConfig: input.ctx.controlPlaneConfig,
    profileId: parsed.value.profileId,
  });

  if (parsed.value.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    await renderLinearStatusPayload({
      payload,
      logger: input.ctx.logger,
    });
  }

  return payload.ok ? 0 : 1;
}

type LinearStatusPayload = {
  readonly extensionId: string;
  readonly selectedProfile: string;
  readonly selectedSource: string;
  readonly defaultProfile: string;
  readonly selectedMissing: boolean;
  readonly authRef: string;
  readonly service: string;
  readonly tokenEnvFallback: string;
  readonly apiUrl: string;
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly accountEmail: string | null;
  readonly tokenResolved: boolean;
  readonly tokenSource: string | null;
  readonly tokenExpiresAt: string | null;
  readonly error: string | null;
  readonly profileError: string | null;
  readonly ok: boolean;
};

async function resolveLinearStatusPayload(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
  readonly profileId?: string;
}): Promise<LinearStatusPayload> {
  const allowProjectOverride = !input.profileId;
  const profileFlags = input.profileId ? { profileId: input.profileId } : {};

  const settingsResult = resolveLinearAuthSettingsResult({
    controlPlaneConfig: input.controlPlaneConfig,
    ...profileFlags,
    allowProjectOverride,
  });
  const settings = resolveLinearAuthSettings({
    controlPlaneConfig: input.controlPlaneConfig,
    ...profileFlags,
    allowProjectOverride,
  });
  const token = await resolveLinearTokenWithBrokerRefresh({
    controlPlaneConfig: input.controlPlaneConfig,
    ...profileFlags,
    allowProjectOverride,
  });
  const catalog = listLinearAuthProfiles({
    controlPlaneConfig: input.controlPlaneConfig,
    ...(input.profileId ? { explicitProfileId: input.profileId } : {}),
    allowProjectOverride,
  });

  return {
    extensionId: EXTENSION_ID,
    selectedProfile: settings.profileId,
    selectedSource: settings.profileSource,
    defaultProfile: catalog.defaultProfileId,
    selectedMissing: catalog.selectedProfileMissing,
    authRef: settings.authRef,
    service: settings.service,
    tokenEnvFallback: settings.tokenEnv,
    apiUrl: settings.apiUrl,
    accountId: settings.accountId ?? null,
    accountName: settings.accountName ?? null,
    accountEmail: settings.accountEmail ?? null,
    tokenResolved: token.ok,
    tokenSource: token.ok ? token.source : null,
    tokenExpiresAt: token.ok ? (token.expiresAt ?? null) : null,
    error: token.ok ? null : token.error,
    profileError: settingsResult.ok ? null : settingsResult.error,
    ok: settingsResult.ok && token.ok,
  };
}

async function renderLinearStatusPayload(input: {
  readonly payload: LinearStatusPayload;
  readonly logger: ExtensionCommandContext["logger"];
}): Promise<void> {
  await display.kv({
    title: "Linear status",
    entries: [
      ["selected_profile", input.payload.selectedProfile],
      ["selected_source", input.payload.selectedSource],
      ["default_profile", input.payload.defaultProfile],
      ["selected_missing", input.payload.selectedMissing ? "yes" : "no"],
      ["auth_ref", input.payload.authRef],
      ["service", input.payload.service],
      ["token_env_fallback", input.payload.tokenEnvFallback],
      ["api_url", input.payload.apiUrl],
      ["account_id", input.payload.accountId ?? ""],
      ["account_name", input.payload.accountName ?? ""],
      ["account_email", input.payload.accountEmail ?? ""],
      ["token_resolved", input.payload.tokenResolved ? "yes" : "no"],
      ["token_source", input.payload.tokenSource ?? ""],
      ["token_expires_at", input.payload.tokenExpiresAt ?? ""],
    ],
  });
  if (input.payload.profileError) {
    input.logger.warn({ message: input.payload.profileError });
  }
  if (input.payload.error) {
    input.logger.warn({ message: input.payload.error });
  }
}

type OAuthConnectRuntime = {
  readonly parsed: OAuthConnectArgs;
  readonly oauthConfig: OAuthRuntimeConfig;
};

type OAuthBrokerConnectRuntime = {
  readonly parsed: OAuthConnectArgs;
  readonly brokerConfig: OAuthBrokerRuntimeConfig;
  readonly profileId: string;
};

async function runLinearOAuthFlow(input: OAuthConnectRuntime): Promise<
  | {
      readonly ok: true;
      readonly tokenExchange: {
        readonly token: string;
        readonly expiresAt?: string;
        readonly refreshToken?: string;
        readonly refreshTokenExpiresAt?: string;
      };
    }
  | { readonly ok: false; readonly error: string }
> {
  const pkce = createLinearPkcePair();
  const callbackServer = startLinearOAuthCallbackServer({
    timeoutMs: OAUTH_TIMEOUT_MS,
  });
  const state = randomUUID();
  const authorizeUrl = buildAuthorizeUrl({
    authorizeUrl: input.oauthConfig.authorizeUrl,
    clientId: input.oauthConfig.clientId,
    redirectUri: callbackServer.redirectUri,
    actor: input.oauthConfig.actor,
    scopes: input.oauthConfig.scopes,
    state,
    codeChallenge: pkce.codeChallenge,
    codeChallengeMethod: "S256",
  });

  const launch = await launchLinearOAuthBrowser({
    parsed: input.parsed,
    authorizeUrl,
    redirectUri: callbackServer.redirectUri,
  });
  if (!launch.ok) {
    callbackServer.stop();
    return launch;
  }

  const callback = await callbackServer.waitForCallback({
    expectedState: state,
  });
  callbackServer.stop();
  if (!callback.ok) {
    return callback;
  }

  const tokenExchange = await exchangeLinearOAuthCode({
    tokenUrl: input.oauthConfig.tokenUrl,
    clientId: input.oauthConfig.clientId,
    ...(input.oauthConfig.clientSecret
      ? { clientSecret: input.oauthConfig.clientSecret }
      : {}),
    code: callback.code,
    redirectUri: callbackServer.redirectUri,
    codeVerifier: pkce.codeVerifier,
  });
  if (!tokenExchange.ok) {
    return { ok: false, error: tokenExchange.error };
  }

  return {
    ok: true,
    tokenExchange,
  };
}

async function runLinearBrokerOAuthFlow(
  input: OAuthBrokerConnectRuntime
): Promise<
  | {
      readonly ok: true;
      readonly tokenExchange: {
        readonly token: string;
        readonly expiresAt?: string;
        readonly refreshToken?: string;
        readonly refreshTokenExpiresAt?: string;
      };
    }
  | { readonly ok: false; readonly error: string }
> {
  const startUrl = new URL(
    "/v1/auth/linear/start",
    `${input.brokerConfig.baseUrl}/`
  );
  startUrl.searchParams.set("profile", input.profileId);
  startUrl.searchParams.set("setDefault", input.parsed.setDefault ? "1" : "0");

  const start = await fetchJson<BrokerStartFlowEnvelope>({
    url: startUrl.toString(),
  });
  if (!start.ok) {
    return {
      ok: false,
      error: `Auth broker Linear start failed: ${start.error}`,
    };
  }

  const launch = await launchLinearOAuthBrowser({
    parsed: input.parsed,
    authorizeUrl: start.value.flow.authorizeUrl,
    pollUrl: start.value.flow.pollUrl,
  });
  if (!launch.ok) {
    return launch;
  }

  const expiresAtMs = Date.parse(start.value.flow.expiresAt);
  const statusUrl = new URL(start.value.flow.pollUrl);
  statusUrl.searchParams.set("deviceCode", start.value.flow.deviceCode);
  statusUrl.searchParams.set("claim", "1");

  while (true) {
    if (Number.isFinite(expiresAtMs) && Date.now() >= expiresAtMs) {
      return {
        ok: false,
        error: "OAuth callback timed out. Retry the flow.",
      };
    }

    const status = await fetchJson<BrokerFlowStatusEnvelope>({
      url: statusUrl.toString(),
    });
    if (!status.ok) {
      return {
        ok: false,
        error: `Auth broker Linear status failed: ${status.error}`,
      };
    }
    if (!status.value.ok) {
      return {
        ok: false,
        error: status.value.error,
      };
    }

    const flowStatus = status.value.status;
    if (flowStatus.status === "pending" || flowStatus.status === "complete") {
      await Bun.sleep(OAUTH_POLL_INTERVAL_MS);
      continue;
    }
    if (flowStatus.status === "claimed") {
      const token = readOptionalString(flowStatus.token);
      if (!token) {
        return {
          ok: false,
          error:
            "Linear OAuth completed remotely, but the broker did not return a token.",
        };
      }
      return {
        ok: true,
        tokenExchange: {
          token,
          ...(flowStatus.tokenExpiresAt
            ? { expiresAt: flowStatus.tokenExpiresAt }
            : {}),
          ...(flowStatus.refreshToken
            ? { refreshToken: flowStatus.refreshToken }
            : {}),
          ...(flowStatus.refreshTokenExpiresAt
            ? { refreshTokenExpiresAt: flowStatus.refreshTokenExpiresAt }
            : {}),
        },
      };
    }
    if (flowStatus.status === "error") {
      return {
        ok: false,
        error: flowStatus.error ?? "Linear OAuth failed.",
      };
    }
    if (flowStatus.status === "expired") {
      return {
        ok: false,
        error: "OAuth callback timed out. Retry the flow.",
      };
    }

    await Bun.sleep(OAUTH_POLL_INTERVAL_MS);
  }
}

async function launchLinearOAuthBrowser(input: {
  readonly parsed: OAuthConnectArgs;
  readonly authorizeUrl: string;
  readonly redirectUri?: string;
  readonly pollUrl?: string;
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  if (!input.parsed.noOpen) {
    const openExitCode = await openUrl(input.authorizeUrl);
    if (openExitCode !== 0) {
      return {
        ok: false,
        error:
          "Failed to open browser for OAuth flow. Re-run with --no-open and open the URL manually.",
      };
    }
  }

  if (input.parsed.json) {
    const payload = {
      authorizeUrl: input.authorizeUrl,
      ...(input.redirectUri ? { redirectUri: input.redirectUri } : {}),
      ...(input.pollUrl ? { pollUrl: input.pollUrl } : {}),
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return { ok: true };
  }

  if (input.parsed.noOpen) {
    await display.panel({
      title: "Linear OAuth",
      tone: "info",
      lines: [
        "Open this URL in your browser to continue:",
        input.authorizeUrl,
        "",
        ...(input.redirectUri ? [`Redirect URI: ${input.redirectUri}`] : []),
        ...(input.pollUrl ? [`Status URL: ${input.pollUrl}`] : []),
      ],
    });
  }

  return { ok: true };
}

type SyncRuntime = {
  readonly tickets: ReturnType<typeof createTicketsStore>;
  readonly linear: ReturnType<typeof createLinearClient>;
  readonly profileId: string;
  readonly apiUrl: string;
  readonly projectBinding: ReturnType<typeof resolveProjectLinearBinding>;
};

type SyncToggles = {
  readonly labels: boolean;
  readonly statuses: boolean;
  readonly dependencies: boolean;
  readonly projects: boolean;
};

async function createSyncRuntime(input: {
  readonly ctx: ExtensionCommandContext;
  readonly profileId?: string;
}): Promise<
  | { readonly ok: true; readonly value: SyncRuntime }
  | { readonly ok: false; readonly error: string }
> {
  if (!input.ctx.project) {
    return { ok: false, error: "No project found. Run inside a repo." };
  }
  const token = await resolveLinearTokenWithBrokerRefresh({
    controlPlaneConfig: input.ctx.controlPlaneConfig,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    allowProjectOverride: !input.profileId,
  });
  if (!token.ok) {
    return { ok: false, error: token.error };
  }
  const settings = resolveLinearAuthSettings({
    controlPlaneConfig: input.ctx.controlPlaneConfig,
    profileId: token.profileId,
    allowProjectOverride: false,
  });

  const tickets = createTicketsStore({
    projectRoot: input.ctx.project.projectRoot,
    projectId: input.ctx.projectId,
    projectName: input.ctx.projectName,
    controlPlaneConfig: input.ctx.controlPlaneConfig,
    logger: input.ctx.logger,
  });
  const linear = createLinearClient({
    token: token.token,
    apiUrl: settings.apiUrl,
  });
  return {
    ok: true,
    value: {
      tickets,
      linear,
      profileId: token.profileId,
      apiUrl: settings.apiUrl,
      projectBinding: resolveProjectLinearBinding({
        controlPlaneConfig: input.ctx.controlPlaneConfig,
      }),
    },
  };
}

async function syncIssueFromLinearToTicket(input: {
  readonly runtime: SyncRuntime;
  readonly issueIdentifier: string;
  readonly syncToggles: SyncToggles;
}): Promise<
  | {
      readonly ok: true;
      readonly operation: "created" | "updated";
      readonly ticketId: string;
      readonly issueIdentifier: string;
    }
  | { readonly ok: false; readonly error: string }
> {
  const issueResult = await input.runtime.linear.getIssueByIdentifier({
    identifier: input.issueIdentifier,
  });
  if (!issueResult.ok) {
    return { ok: false, error: issueResult.error };
  }
  if (!issueResult.data) {
    return {
      ok: false,
      error: `Linear issue not found: ${input.issueIdentifier}`,
    };
  }

  return await upsertTicketFromLinearIssue({
    runtime: input.runtime,
    issue: issueResult.data,
    syncToggles: input.syncToggles,
    dependencyIndex: await buildLinearDependencyIndex({
      tickets: input.runtime.tickets,
    }),
  });
}

async function syncTicketToLinearIssue(input: {
  readonly runtime: SyncRuntime;
  readonly ticketId: string;
  readonly explicitProjectId?: string;
  readonly explicitTeamId?: string;
  readonly syncToggles: SyncToggles;
}): Promise<
  | {
      readonly ok: true;
      readonly operation: "created" | "updated";
      readonly ticketId: string;
      readonly issueIdentifier: string;
      readonly issueId: string;
    }
  | { readonly ok: false; readonly error: string }
> {
  const ticket = await input.runtime.tickets.getTicket({
    ticketId: input.ticketId,
  });
  if (!ticket) {
    return { ok: false, error: `Ticket not found: ${input.ticketId}` };
  }

  const existingIssue = await resolveLinkedLinearIssue({
    runtime: input.runtime,
    ticket,
  });
  if (!existingIssue.ok) {
    return existingIssue;
  }

  const target = await resolveLinearTargetForTicketSync({
    runtime: input.runtime,
    ticket,
    existingIssue: existingIssue.issue,
    explicitProjectId: input.explicitProjectId,
    explicitTeamId: input.explicitTeamId,
  });
  if (!target.ok) {
    return target;
  }

  const fields = await resolveLinearMutationFieldsForTicketSync({
    runtime: input.runtime,
    ticket,
    teamId: target.value.teamId,
    syncToggles: input.syncToggles,
  });
  if (!fields.ok) {
    return fields;
  }

  const syncedIssue = await upsertLinearIssueForTicketSync({
    runtime: input.runtime,
    ticket,
    existingIssue: existingIssue.issue,
    fields: fields.value,
    teamId: target.value.teamId,
    projectId: target.value.projectId,
    syncToggles: input.syncToggles,
  });

  if (!syncedIssue.ok) {
    return { ok: false, error: syncedIssue.error };
  }

  const updated = await input.runtime.tickets.updateTicket({
    ticketId: ticket.ticketId,
    externalSystem: "linear",
    externalId: syncedIssue.data.id,
    externalKey: syncedIssue.data.identifier,
    externalUrl: syncedIssue.data.url,
    externalProjectId: syncedIssue.data.projectId,
    externalProjectName: syncedIssue.data.projectName,
    externalTeamId: syncedIssue.data.teamId,
  });
  if (!updated.ok) {
    return { ok: false, error: updated.error };
  }

  return {
    ok: true,
    operation: existingIssue.issue ? "updated" : "created",
    ticketId: ticket.ticketId,
    issueIdentifier: syncedIssue.data.identifier,
    issueId: syncedIssue.data.id,
  };
}

async function resolveLinearTargetForTicketSync(input: {
  readonly runtime: SyncRuntime;
  readonly ticket: TicketSummary;
  readonly existingIssue: LinearIssue | null;
  readonly explicitProjectId?: string;
  readonly explicitTeamId?: string;
}): Promise<
  | {
      readonly ok: true;
      readonly value: { readonly teamId: string; readonly projectId?: string };
    }
  | { readonly ok: false; readonly error: string }
> {
  let projectId =
    input.explicitProjectId ??
    input.existingIssue?.projectId ??
    input.ticket.externalProjectId ??
    input.runtime.projectBinding.projectId;
  let teamId =
    input.explicitTeamId ??
    input.existingIssue?.teamId ??
    input.ticket.externalTeamId ??
    input.runtime.projectBinding.teamId;

  if (!(teamId || !projectId)) {
    const projectResult = await input.runtime.linear.getProject({ projectId });
    if (!projectResult.ok) {
      return { ok: false, error: projectResult.error };
    }
    if (!projectResult.data) {
      return { ok: false, error: `Linear project not found: ${projectId}` };
    }
    teamId = projectResult.data.teamId;
    projectId = projectResult.data.id;
  }

  if (!teamId) {
    return {
      ok: false,
      error:
        "Cannot resolve Linear team for ticket sync. Pass --team-id or bind a project with `hack x linear project-bind`.",
    };
  }

  return {
    ok: true,
    value: { teamId, ...(projectId ? { projectId } : {}) },
  };
}

type LinearTicketMutationFields = {
  readonly title: string;
  readonly description: string;
  readonly stateId?: string;
  readonly labelIds?: readonly string[];
  readonly parentId?: string;
};

async function resolveLinearMutationFieldsForTicketSync(input: {
  readonly runtime: SyncRuntime;
  readonly ticket: TicketSummary;
  readonly teamId: string;
  readonly syncToggles: SyncToggles;
}): Promise<
  | { readonly ok: true; readonly value: LinearTicketMutationFields }
  | { readonly ok: false; readonly error: string }
> {
  const stateId = await resolveLinearStateIdForTicketStatus({
    runtime: input.runtime,
    teamId: input.teamId,
    status: input.ticket.status,
    enabled: input.syncToggles.statuses,
  });
  if (!stateId.ok) {
    return { ok: false, error: stateId.error };
  }

  const labelIds = await resolveLinearLabelIds({
    runtime: input.runtime,
    teamId: input.teamId,
    tags: input.ticket.tags,
    enabled: input.syncToggles.labels,
  });
  if (!labelIds.ok) {
    return { ok: false, error: labelIds.error };
  }

  const parentId = await resolveLinearParentIssueId({
    runtime: input.runtime,
    ticket: input.ticket,
    enabled: input.syncToggles.dependencies,
  });
  if (!parentId.ok) {
    return { ok: false, error: parentId.error };
  }

  const title = input.ticket.title.trim();
  if (!title) {
    return {
      ok: false,
      error: `Ticket ${input.ticket.ticketId} has an empty title and cannot be synced.`,
    };
  }

  return {
    ok: true,
    value: {
      title,
      description: input.ticket.body ?? "",
      ...(stateId.value ? { stateId: stateId.value } : {}),
      ...(labelIds.value ? { labelIds: labelIds.value } : {}),
      ...(parentId.value !== undefined ? { parentId: parentId.value } : {}),
    },
  };
}

async function upsertLinearIssueForTicketSync(input: {
  readonly runtime: SyncRuntime;
  readonly ticket: TicketSummary;
  readonly existingIssue: LinearIssue | null;
  readonly fields: LinearTicketMutationFields;
  readonly teamId: string;
  readonly projectId?: string;
  readonly syncToggles: SyncToggles;
}) {
  if (input.existingIssue) {
    return await input.runtime.linear.updateIssue({
      issueId: input.existingIssue.id,
      title: input.fields.title,
      description: input.fields.description,
      ...(input.syncToggles.projects ? { projectId: input.projectId } : {}),
      ...(input.fields.stateId ? { stateId: input.fields.stateId } : {}),
      ...(input.fields.labelIds ? { labelIds: input.fields.labelIds } : {}),
      ...(input.fields.parentId !== undefined
        ? { parentId: input.fields.parentId }
        : {}),
    });
  }

  return await input.runtime.linear.createIssue({
    teamId: input.teamId,
    title: input.fields.title,
    description: input.fields.description,
    ...(input.syncToggles.projects ? { projectId: input.projectId } : {}),
    ...(input.fields.stateId ? { stateId: input.fields.stateId } : {}),
    ...(input.fields.labelIds ? { labelIds: input.fields.labelIds } : {}),
    ...(input.fields.parentId !== undefined
      ? { parentId: input.fields.parentId }
      : {}),
  });
}

async function syncProjectFromLinearToTickets(input: {
  readonly runtime: SyncRuntime;
  readonly projectId: string;
  readonly limit?: number;
  readonly syncToggles: SyncToggles;
}): Promise<
  | {
      readonly ok: true;
      readonly processed: number;
      readonly created: number;
      readonly updated: number;
    }
  | { readonly ok: false; readonly error: string }
> {
  const limit = normalizePositiveInteger({
    value: input.limit,
    fallback: DEFAULT_PROJECT_SYNC_LIMIT,
  });

  const issuesResult = await collectLinearProjectIssuesForSync({
    runtime: input.runtime,
    projectId: input.projectId,
    limit,
  });
  if (!issuesResult.ok) {
    return issuesResult;
  }

  const dependencyIndex = await buildLinearDependencyIndex({
    tickets: input.runtime.tickets,
  });

  const upserted = await upsertLinearProjectIssuesToTickets({
    runtime: input.runtime,
    issues: issuesResult.issues,
    syncToggles: input.syncToggles,
    dependencyIndex,
  });
  if (!upserted.ok) {
    return upserted;
  }

  if (input.syncToggles.dependencies) {
    const dependencies = await applyLinearProjectDependenciesToTickets({
      runtime: input.runtime,
      issues: issuesResult.issues,
      dependencyIndex,
    });
    if (!dependencies.ok) {
      return dependencies;
    }
  }

  return {
    ok: true,
    processed: issuesResult.processed,
    created: upserted.created,
    updated: upserted.updated,
  };
}

async function collectLinearProjectIssuesForSync(input: {
  readonly runtime: SyncRuntime;
  readonly projectId: string;
  readonly limit: number;
}): Promise<
  | {
      readonly ok: true;
      readonly issues: readonly LinearIssue[];
      readonly processed: number;
    }
  | { readonly ok: false; readonly error: string }
> {
  let cursor: string | undefined;
  let processed = 0;
  const issues: LinearIssue[] = [];

  while (processed < input.limit) {
    const page = await input.runtime.linear.listProjectIssuesPage({
      projectId: input.projectId,
      first: Math.min(50, input.limit - processed),
      ...(cursor ? { after: cursor } : {}),
    });
    if (!page.ok) {
      return { ok: false, error: page.error };
    }

    issues.push(...page.data.issues);
    processed += page.data.issues.length;
    if (
      !(page.data.hasNextPage && page.data.endCursor && processed < input.limit)
    ) {
      break;
    }
    cursor = page.data.endCursor;
  }

  return { ok: true, issues, processed };
}

async function upsertLinearProjectIssuesToTickets(input: {
  readonly runtime: SyncRuntime;
  readonly issues: readonly LinearIssue[];
  readonly syncToggles: SyncToggles;
  readonly dependencyIndex: {
    readonly byLinearId: Map<string, string>;
    readonly byLinearIdentifier: Map<string, string>;
  };
}): Promise<
  | { readonly ok: true; readonly created: number; readonly updated: number }
  | { readonly ok: false; readonly error: string }
> {
  let created = 0;
  let updated = 0;

  for (const issue of input.issues) {
    const synced = await upsertTicketFromLinearIssue({
      runtime: input.runtime,
      issue,
      syncToggles: input.syncToggles,
      dependencyIndex: input.dependencyIndex,
    });
    if (!synced.ok) {
      return synced;
    }
    if (synced.operation === "created") {
      created += 1;
    } else {
      updated += 1;
    }
    input.dependencyIndex.byLinearId.set(issue.id, synced.ticketId);
    input.dependencyIndex.byLinearIdentifier.set(
      issue.identifier,
      synced.ticketId
    );
  }

  return {
    ok: true,
    created,
    updated,
  };
}

async function applyLinearProjectDependenciesToTickets(input: {
  readonly runtime: SyncRuntime;
  readonly issues: readonly LinearIssue[];
  readonly dependencyIndex: {
    readonly byLinearId: Map<string, string>;
    readonly byLinearIdentifier: Map<string, string>;
  };
}): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  for (const issue of input.issues) {
    if (!issue.parentId) {
      continue;
    }
    const childTicketId = input.dependencyIndex.byLinearId.get(issue.id);
    const parentTicketId = input.dependencyIndex.byLinearId.get(issue.parentId);
    if (!(childTicketId && parentTicketId)) {
      continue;
    }
    const updatedDependency = await input.runtime.tickets.updateTicket({
      ticketId: childTicketId,
      dependsOn: [parentTicketId],
    });
    if (!updatedDependency.ok) {
      return { ok: false, error: updatedDependency.error };
    }
  }

  return { ok: true };
}

async function syncProjectFromTicketsToLinear(input: {
  readonly runtime: SyncRuntime;
  readonly projectId?: string;
  readonly explicitTeamId?: string;
  readonly ownerMode: "hack" | "linear" | "both";
  readonly limit?: number;
  readonly syncToggles: SyncToggles;
}): Promise<
  | {
      readonly ok: true;
      readonly processed: number;
      readonly created: number;
      readonly updated: number;
    }
  | { readonly ok: false; readonly error: string }
> {
  const limit = normalizePositiveInteger({
    value: input.limit,
    fallback: DEFAULT_PROJECT_SYNC_LIMIT,
  });
  const allTickets = await input.runtime.tickets.listTickets();
  const candidates = allTickets
    .filter((ticket) => {
      if (input.ownerMode === "both") {
        return true;
      }
      return ticket.owner.toLowerCase() === input.ownerMode;
    })
    .slice(0, limit);

  let created = 0;
  let updated = 0;

  for (const ticket of candidates) {
    const synced = await syncTicketToLinearIssue({
      runtime: input.runtime,
      ticketId: ticket.ticketId,
      explicitProjectId: input.projectId,
      explicitTeamId: input.explicitTeamId,
      syncToggles: input.syncToggles,
    });
    if (!synced.ok) {
      return synced;
    }
    if (synced.operation === "created") {
      created += 1;
    } else {
      updated += 1;
    }
  }

  return {
    ok: true,
    processed: candidates.length,
    created,
    updated,
  };
}

async function upsertTicketFromLinearIssue(input: {
  readonly runtime: SyncRuntime;
  readonly issue: LinearIssue;
  readonly syncToggles: SyncToggles;
  readonly dependencyIndex: {
    readonly byLinearId: Map<string, string>;
    readonly byLinearIdentifier: Map<string, string>;
  };
}): Promise<
  | {
      readonly ok: true;
      readonly operation: "created" | "updated";
      readonly ticketId: string;
      readonly issueIdentifier: string;
    }
  | { readonly ok: false; readonly error: string }
> {
  const snapshot = await input.runtime.tickets.listTickets();
  const existing = snapshot.find((ticket) =>
    isLinearLinkedTicket({ ticket, issue: input.issue })
  );

  const projection = buildTicketProjectionFromLinearIssue({
    issue: input.issue,
    existingTicket: existing,
    syncToggles: input.syncToggles,
    dependencyIndex: input.dependencyIndex,
  });

  return existing
    ? await applyLinearIssueToExistingTicket({
        runtime: input.runtime,
        issue: input.issue,
        existingTicket: existing,
        projection,
        syncToggles: input.syncToggles,
      })
    : await createTicketFromLinearIssueProjection({
        runtime: input.runtime,
        issue: input.issue,
        projection,
        syncToggles: input.syncToggles,
      });
}

type TicketProjectionFromLinearIssue = {
  readonly body: string;
  readonly tags: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly status: TicketStatus;
};

function buildTicketProjectionFromLinearIssue(input: {
  readonly issue: LinearIssue;
  readonly existingTicket?: TicketSummary;
  readonly syncToggles: SyncToggles;
  readonly dependencyIndex: {
    readonly byLinearId: Map<string, string>;
    readonly byLinearIdentifier: Map<string, string>;
  };
}): TicketProjectionFromLinearIssue {
  const mappedParentTicketId = resolveLinearParentTicketId({
    issue: input.issue,
    dependencyIndex: input.dependencyIndex,
  });
  const body = renderTicketBodyFromLinearIssue({ issue: input.issue });
  const tags = input.syncToggles.labels
    ? input.issue.labels.map((label) => label.name)
    : (input.existingTicket?.tags ?? []);

  let dependsOn: readonly string[] | undefined;
  if (input.syncToggles.dependencies) {
    dependsOn = mappedParentTicketId ? [mappedParentTicketId] : [];
  } else {
    dependsOn = input.existingTicket?.dependsOn;
  }

  return {
    body,
    tags,
    ...(dependsOn !== undefined ? { dependsOn } : {}),
    status: mapLinearStateToTicketStatus({ state: input.issue.state }),
  };
}

function resolveLinearParentTicketId(input: {
  readonly issue: LinearIssue;
  readonly dependencyIndex: {
    readonly byLinearId: Map<string, string>;
    readonly byLinearIdentifier: Map<string, string>;
  };
}): string | undefined {
  if (input.issue.parentId) {
    return input.dependencyIndex.byLinearId.get(input.issue.parentId);
  }
  if (input.issue.parentIdentifier) {
    return input.dependencyIndex.byLinearIdentifier.get(
      input.issue.parentIdentifier
    );
  }
  return undefined;
}

async function applyLinearIssueToExistingTicket(input: {
  readonly runtime: SyncRuntime;
  readonly issue: LinearIssue;
  readonly existingTicket: TicketSummary;
  readonly projection: TicketProjectionFromLinearIssue;
  readonly syncToggles: SyncToggles;
}): Promise<
  | {
      readonly ok: true;
      readonly operation: "updated";
      readonly ticketId: string;
      readonly issueIdentifier: string;
    }
  | { readonly ok: false; readonly error: string }
> {
  const updated = await input.runtime.tickets.updateTicket({
    ticketId: input.existingTicket.ticketId,
    title: input.issue.title,
    body: input.projection.body,
    owner: "linear",
    source: "linear",
    tags: input.projection.tags,
    ...(input.projection.dependsOn !== undefined
      ? { dependsOn: input.projection.dependsOn }
      : {}),
    externalSystem: "linear",
    externalId: input.issue.id,
    externalKey: input.issue.identifier,
    externalUrl: input.issue.url,
    externalProjectId: input.issue.projectId,
    externalProjectName: input.issue.projectName,
    externalTeamId: input.issue.teamId,
  });
  if (!updated.ok) {
    return { ok: false, error: updated.error };
  }

  if (input.syncToggles.statuses) {
    const setStatus = await input.runtime.tickets.setStatus({
      ticketId: input.existingTicket.ticketId,
      status: input.projection.status,
    });
    if (!setStatus.ok) {
      return { ok: false, error: setStatus.error };
    }
  }

  return {
    ok: true,
    operation: "updated",
    ticketId: input.existingTicket.ticketId,
    issueIdentifier: input.issue.identifier,
  };
}

async function createTicketFromLinearIssueProjection(input: {
  readonly runtime: SyncRuntime;
  readonly issue: LinearIssue;
  readonly projection: TicketProjectionFromLinearIssue;
  readonly syncToggles: SyncToggles;
}): Promise<
  | {
      readonly ok: true;
      readonly operation: "created";
      readonly ticketId: string;
      readonly issueIdentifier: string;
    }
  | { readonly ok: false; readonly error: string }
> {
  const created = await input.runtime.tickets.createTicket({
    title: input.issue.title,
    body: input.projection.body,
    owner: "linear",
    source: "linear",
    tags: input.projection.tags,
    ...(input.projection.dependsOn !== undefined
      ? { dependsOn: input.projection.dependsOn }
      : {}),
    externalSystem: "linear",
    externalId: input.issue.id,
    externalKey: input.issue.identifier,
    externalUrl: input.issue.url,
    externalProjectId: input.issue.projectId,
    externalProjectName: input.issue.projectName,
    externalTeamId: input.issue.teamId,
  });
  if (!created.ok) {
    return created;
  }

  if (input.syncToggles.statuses && input.projection.status !== "open") {
    const statusResult = await input.runtime.tickets.setStatus({
      ticketId: created.ticket.ticketId,
      status: input.projection.status,
    });
    if (!statusResult.ok) {
      return { ok: false, error: statusResult.error };
    }
  }

  return {
    ok: true,
    operation: "created",
    ticketId: created.ticket.ticketId,
    issueIdentifier: input.issue.identifier,
  };
}

async function buildLinearDependencyIndex(input: {
  readonly tickets: ReturnType<typeof createTicketsStore>;
}): Promise<{
  readonly byLinearId: Map<string, string>;
  readonly byLinearIdentifier: Map<string, string>;
}> {
  const tickets = await input.tickets.listTickets();
  const byLinearId = new Map<string, string>();
  const byLinearIdentifier = new Map<string, string>();
  for (const ticket of tickets) {
    if (ticket.externalSystem !== "linear") {
      continue;
    }
    if (ticket.externalId) {
      byLinearId.set(ticket.externalId, ticket.ticketId);
    }
    if (ticket.externalKey) {
      byLinearIdentifier.set(ticket.externalKey, ticket.ticketId);
    }
  }
  return {
    byLinearId,
    byLinearIdentifier,
  };
}

async function resolveLinkedLinearIssue(input: {
  readonly runtime: SyncRuntime;
  readonly ticket: TicketSummary;
}): Promise<
  | { readonly ok: true; readonly issue: LinearIssue | null }
  | { readonly ok: false; readonly error: string }
> {
  if (input.ticket.externalSystem !== "linear") {
    return { ok: true, issue: null };
  }
  if (input.ticket.externalId) {
    const byId = await input.runtime.linear.getIssueById({
      issueId: input.ticket.externalId,
    });
    if (!byId.ok) {
      return { ok: false, error: byId.error };
    }
    if (byId.data) {
      return { ok: true, issue: byId.data };
    }
  }
  if (input.ticket.externalKey) {
    const byKey = await input.runtime.linear.getIssueByIdentifier({
      identifier: input.ticket.externalKey,
    });
    if (!byKey.ok) {
      return { ok: false, error: byKey.error };
    }
    return { ok: true, issue: byKey.data };
  }
  return { ok: true, issue: null };
}

async function resolveLinearStateIdForTicketStatus(input: {
  readonly runtime: SyncRuntime;
  readonly teamId: string;
  readonly status: TicketStatus;
  readonly enabled: boolean;
}): Promise<
  | { readonly ok: true; readonly value?: string }
  | { readonly ok: false; readonly error: string }
> {
  if (!input.enabled) {
    return { ok: true };
  }

  const states = await input.runtime.linear.listTeamStates({
    teamId: input.teamId,
  });
  if (!states.ok) {
    return { ok: false, error: states.error };
  }
  const desiredType = mapTicketStatusToLinearStateType({
    status: input.status,
  });
  const selected =
    states.data.find((state) => state.type === desiredType) ??
    pickFallbackState({ states: states.data, desiredType });
  return { ok: true, ...(selected ? { value: selected.id } : {}) };
}

async function resolveLinearLabelIds(input: {
  readonly runtime: SyncRuntime;
  readonly teamId: string;
  readonly tags: readonly string[];
  readonly enabled: boolean;
}): Promise<
  | { readonly ok: true; readonly value?: readonly string[] }
  | { readonly ok: false; readonly error: string }
> {
  if (!input.enabled) {
    return { ok: true };
  }
  if (input.tags.length === 0) {
    return { ok: true, value: [] };
  }

  const labels = await input.runtime.linear.listTeamLabels({
    teamId: input.teamId,
  });
  if (!labels.ok) {
    return { ok: false, error: labels.error };
  }

  const labelByName = new Map<string, string>();
  for (const label of labels.data) {
    labelByName.set(label.name.toLowerCase(), label.id);
  }

  const resolved: string[] = [];
  for (const tag of input.tags) {
    const match = labelByName.get(tag.toLowerCase());
    if (match) {
      resolved.push(match);
    }
  }

  const deduped = [...new Set(resolved)];
  return { ok: true, value: deduped };
}

async function resolveLinearParentIssueId(input: {
  readonly runtime: SyncRuntime;
  readonly ticket: TicketSummary;
  readonly enabled: boolean;
}): Promise<
  | { readonly ok: true; readonly value?: string }
  | { readonly ok: false; readonly error: string }
> {
  if (!input.enabled) {
    return { ok: true };
  }
  const parentTicketRef = input.ticket.dependsOn[0];
  if (!parentTicketRef) {
    return { ok: true, value: undefined };
  }
  const parentTicket = await input.runtime.tickets.getTicket({
    ticketId: parentTicketRef,
  });
  if (!parentTicket) {
    return { ok: true };
  }
  if (parentTicket.externalSystem === "linear" && parentTicket.externalId) {
    return { ok: true, value: parentTicket.externalId };
  }
  return { ok: true };
}

function renderTicketBodyFromLinearIssue(input: {
  readonly issue: LinearIssue;
}): string {
  const chunks: string[] = [];
  const description = (input.issue.description ?? "").trim();
  if (description) {
    chunks.push(description);
  }
  const metadataLines = [
    `Linear Issue: ${input.issue.identifier}`,
    ...(input.issue.url ? [`Linear URL: ${input.issue.url}`] : []),
  ];
  if (chunks.length > 0) {
    chunks.push("---");
  }
  chunks.push(...metadataLines);
  return chunks.join("\n\n").trim();
}

function isLinearLinkedTicket(input: {
  readonly ticket: TicketSummary;
  readonly issue: LinearIssue;
}): boolean {
  if (input.ticket.externalSystem !== "linear") {
    return false;
  }
  if (input.ticket.externalId && input.ticket.externalId === input.issue.id) {
    return true;
  }
  if (
    input.ticket.externalKey &&
    input.ticket.externalKey === input.issue.identifier
  ) {
    return true;
  }
  return false;
}

function mapLinearStateToTicketStatus(input: {
  readonly state: LinearWorkflowState;
}): TicketStatus {
  if (input.state.type === "completed" || input.state.type === "canceled") {
    return "done";
  }
  if (input.state.type === "started") {
    return "in_progress";
  }
  return "open";
}

function mapTicketStatusToLinearStateType(input: {
  readonly status: TicketStatus;
}): LinearWorkflowStateType {
  if (input.status === "done") {
    return "completed";
  }
  if (input.status === "in_progress" || input.status === "blocked") {
    return "started";
  }
  return "unstarted";
}

function pickFallbackState(input: {
  readonly states: readonly LinearWorkflowState[];
  readonly desiredType: LinearWorkflowStateType;
}): LinearWorkflowState | undefined {
  return (
    input.states.find((state) => state.type === input.desiredType) ??
    input.states.find((state) => state.type === "started") ??
    input.states.find((state) => state.type === "unstarted") ??
    input.states.find((state) => state.type === "completed") ??
    input.states[0]
  );
}

function resolveSyncToggles(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
  readonly labelsOverride?: boolean;
}): SyncToggles {
  const extension = input.controlPlaneConfig.extensions?.[EXTENSION_ID];
  const config =
    isRecord(extension) && isRecord(extension.config) ? extension.config : null;
  const sync = isRecord(config?.sync) ? config.sync : null;

  const labelsFromConfig =
    typeof sync?.labels === "boolean" ? sync.labels : false;
  const statuses = typeof sync?.statuses === "boolean" ? sync.statuses : true;
  const dependencies =
    typeof sync?.dependencies === "boolean" ? sync.dependencies : true;
  const projects = typeof sync?.projects === "boolean" ? sync.projects : true;

  return {
    labels:
      typeof input.labelsOverride === "boolean"
        ? input.labelsOverride
        : labelsFromConfig,
    statuses,
    dependencies,
    projects,
  };
}

function shouldSetProfileAsDefault(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
  readonly profileId: string;
  readonly setDefaultFlag?: boolean;
}): boolean {
  if (input.setDefaultFlag === true) {
    return true;
  }
  const catalog = listLinearAuthProfiles({
    controlPlaneConfig: input.controlPlaneConfig,
    allowProjectOverride: false,
  });
  if (catalog.profiles.length === 0) {
    return true;
  }
  return (
    catalog.profiles.length === 1 && catalog.profiles[0]?.id === input.profileId
  );
}

async function persistLinearProfileDefaults(input: {
  readonly profileId: string;
  readonly tokenEnv: string;
  readonly authRef: string;
  readonly service: string;
  readonly apiUrl: string;
  readonly accountId?: string;
  readonly accountName?: string;
  readonly accountEmail?: string;
  readonly setAsDefault: boolean;
}): Promise<void> {
  const profilePath = linearProfilePath({
    profileId: input.profileId,
  });
  await Promise.all([
    updateGlobalConfig({
      path: `controlPlane.extensions["${EXTENSION_ID}"].enabled`,
      value: true,
    }),
    updateGlobalConfig({
      path: `${profilePath}.tokenEnv`,
      value: input.tokenEnv,
    }),
    updateGlobalConfig({
      path: `${profilePath}.authRef`,
      value: input.authRef,
    }),
    updateGlobalConfig({
      path: `${profilePath}.service`,
      value: input.service,
    }),
    updateGlobalConfig({
      path: `${profilePath}.apiUrl`,
      value: input.apiUrl,
    }),
    updateGlobalConfig({
      path: `${profilePath}.accountId`,
      value: input.accountId ?? "",
    }),
    updateGlobalConfig({
      path: `${profilePath}.accountName`,
      value: input.accountName ?? "",
    }),
    updateGlobalConfig({
      path: `${profilePath}.accountEmail`,
      value: input.accountEmail ?? "",
    }),
    ...(input.setAsDefault
      ? [
          updateGlobalConfig({
            path: `controlPlane.extensions["${EXTENSION_ID}"].config.defaultProfile`,
            value: input.profileId,
          }),
        ]
      : []),
  ]);
}

function linearProfilePath(input: { readonly profileId: string }): string {
  const escapedProfileId = input.profileId
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  return `controlPlane.extensions["${EXTENSION_ID}"].config.profiles["${escapedProfileId}"]`;
}

function resolveProjectLinearBinding(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
}): {
  readonly profileId?: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly teamId?: string;
} {
  const overrides = input.controlPlaneConfig.routing?.overrides;
  if (!isRecord(overrides)) {
    return {};
  }
  const nested = isRecord(overrides.linear) ? overrides.linear : null;

  const profileId =
    readOptionalString(nested?.profile) ??
    readOptionalString(overrides.linearProfile);
  const projectId =
    readOptionalString(nested?.projectId) ??
    readOptionalString(overrides.linearProjectId);
  const projectName =
    readOptionalString(nested?.projectName) ??
    readOptionalString(overrides.linearProjectName);
  const teamId =
    readOptionalString(nested?.teamId) ??
    readOptionalString(overrides.linearTeamId);

  return {
    ...(profileId ? { profileId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    ...(teamId ? { teamId } : {}),
  };
}

async function resolveProjectBindingDetails(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
  readonly profileId?: string;
  readonly projectId: string;
  readonly projectName?: string;
  readonly teamId?: string;
}): Promise<
  | {
      readonly ok: true;
      readonly projectName: string;
      readonly teamId: string;
    }
  | { readonly ok: false; readonly error: string }
> {
  const providedProjectName = (input.projectName ?? "").trim();
  const providedTeamId = (input.teamId ?? "").trim();
  if (providedProjectName && providedTeamId) {
    return {
      ok: true,
      projectName: providedProjectName,
      teamId: providedTeamId,
    };
  }

  const token = await resolveLinearTokenWithBrokerRefresh({
    controlPlaneConfig: input.controlPlaneConfig,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    allowProjectOverride: !input.profileId,
  });
  if (!token.ok) {
    return { ok: false, error: token.error };
  }
  const settings = resolveLinearAuthSettings({
    controlPlaneConfig: input.controlPlaneConfig,
    profileId: token.profileId,
    allowProjectOverride: false,
  });
  const client = createLinearClient({
    token: token.token,
    apiUrl: settings.apiUrl,
  });
  const project = await client.getProject({ projectId: input.projectId });
  if (!project.ok) {
    return { ok: false, error: project.error };
  }
  if (!project.data) {
    return {
      ok: false,
      error: `Linear project not found: ${input.projectId}`,
    };
  }
  return {
    ok: true,
    projectName: providedProjectName || project.data.name,
    teamId: providedTeamId || project.data.teamId,
  };
}

async function enableLinearProjectExtension(input: {
  readonly projectDir: string;
}): Promise<void> {
  await updateProjectConfig({
    projectDir: input.projectDir,
    path: `controlPlane.extensions["${EXTENSION_ID}"].enabled`,
    value: true,
  });
}

type OAuthRuntimeConfig = {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly actor?: "user" | "app";
  readonly scopes: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
};

type OAuthBrokerRuntimeConfig = {
  readonly baseUrl: string;
};

type BrokerStartFlowPayload = {
  readonly flowId: string;
  readonly profileId: string;
  readonly setDefault: boolean;
  readonly authorizeUrl: string;
  readonly deviceCode: string;
  readonly pollUrl: string;
  readonly expiresAt: string;
};

type BrokerStartFlowEnvelope = {
  readonly ok: true;
  readonly flow: BrokerStartFlowPayload;
};

type BrokerFlowStatusPayload = {
  readonly id: string;
  readonly status: string;
  readonly profileId: string;
  readonly setDefault: boolean;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly completedAt?: string;
  readonly claimedAt?: string;
  readonly accountHandle?: string;
  readonly accountLogin?: string;
  readonly accountName?: string;
  readonly accountId?: string;
  readonly accountEmail?: string;
  readonly token?: string;
  readonly tokenExpiresAt?: string;
  readonly refreshToken?: string;
  readonly refreshTokenExpiresAt?: string;
  readonly error?: string;
};

type BrokerFlowStatusEnvelope =
  | {
      readonly ok: true;
      readonly status: BrokerFlowStatusPayload;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

async function resolveOAuthRuntimeConfig(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
  readonly parsed: OAuthConnectArgs;
}): Promise<
  | { readonly ok: true; readonly value: OAuthRuntimeConfig }
  | { readonly ok: false; readonly error: string }
> {
  const extension = input.controlPlaneConfig.extensions?.[EXTENSION_ID];
  const config =
    isRecord(extension) && isRecord(extension.config) ? extension.config : null;

  const clientId =
    input.parsed.clientId ??
    readOptionalString(config?.oauthClientId) ??
    readOptionalString(process.env[DEFAULT_OAUTH_CLIENT_ID_ENV]) ??
    readOptionalString(process.env[DEFAULT_OAUTH_CLIENT_ID_ENV_FALLBACK]);
  if (!clientId) {
    return {
      ok: false,
      error: `Missing Linear OAuth client id. Set \`controlPlane.extensions["${EXTENSION_ID}"].config.oauthClientId\`, set ${DEFAULT_OAUTH_CLIENT_ID_ENV} or ${DEFAULT_OAUTH_CLIENT_ID_ENV_FALLBACK}, or pass --client-id.`,
    };
  }

  const secretAuthRef =
    input.parsed.clientSecretAuthRef ??
    readOptionalString(config?.oauthClientSecretAuthRef) ??
    DEFAULT_OAUTH_CLIENT_SECRET_AUTH_REF;
  const secretService =
    input.parsed.clientSecretService ??
    readOptionalString(config?.oauthClientSecretService) ??
    DEFAULT_OAUTH_SECRET_SERVICE;

  const secretResolution = await resolveOptionalOAuthClientSecret({
    parsed: input.parsed,
    authRef: secretAuthRef,
    service: secretService,
  });
  if (!secretResolution.ok) {
    return secretResolution;
  }

  if (secretResolution.shouldPersist && secretResolution.clientSecret) {
    await secrets.set({
      service: secretService,
      name: secretAuthRef,
      value: secretResolution.clientSecret,
    });
  }

  const scopes =
    input.parsed.scopes ??
    readOptionalString(config?.oauthScopes) ??
    DEFAULT_OAUTH_SCOPES;
  const actor = normalizeOAuthActor(
    readOptionalString(config?.oauthActor) ?? DEFAULT_OAUTH_ACTOR
  );
  const authorizeUrl =
    input.parsed.authorizeUrl ??
    readOptionalString(config?.oauthAuthorizeUrl) ??
    DEFAULT_OAUTH_AUTHORIZE_URL;
  const tokenUrl =
    input.parsed.tokenUrl ??
    readOptionalString(config?.oauthTokenUrl) ??
    DEFAULT_OAUTH_TOKEN_URL;

  return {
    ok: true,
    value: {
      clientId,
      ...(secretResolution.clientSecret
        ? { clientSecret: secretResolution.clientSecret }
        : {}),
      ...(actor ? { actor } : {}),
      scopes,
      authorizeUrl,
      tokenUrl,
    },
  };
}

function resolveOAuthBrokerRuntimeConfig(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
}): OAuthBrokerRuntimeConfig {
  const extension = input.controlPlaneConfig.extensions?.[EXTENSION_ID];
  const config =
    isRecord(extension) && isRecord(extension.config) ? extension.config : null;
  const baseUrl =
    readOptionalString(config?.oauthBrokerUrl) ??
    readOptionalString(process.env[DEFAULT_OAUTH_BROKER_URL_ENV]) ??
    readOptionalString(process.env[DEFAULT_OAUTH_BROKER_URL_ENV_FALLBACK]) ??
    DEFAULT_OAUTH_BROKER_URL;
  return {
    baseUrl: trimTrailingSlash({ value: baseUrl }),
  };
}

async function resolveLinearTokenWithBrokerRefresh(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
  readonly profileId?: string;
  readonly allowProjectOverride?: boolean;
}): Promise<Awaited<ReturnType<typeof resolveLinearToken>>> {
  const brokerConfig = resolveOAuthBrokerRuntimeConfig({
    controlPlaneConfig: input.controlPlaneConfig,
  });
  return await resolveLinearToken({
    controlPlaneConfig: input.controlPlaneConfig,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    allowProjectOverride: input.allowProjectOverride,
    refreshConfig: {
      baseUrl: brokerConfig.baseUrl,
    },
  });
}

function shouldUseBrokerOAuthFlow(input: {
  readonly parsed: OAuthConnectArgs;
}): boolean {
  return !(
    input.parsed.clientId ||
    input.parsed.clientSecret ||
    input.parsed.clientSecretStdin ||
    input.parsed.clientSecretAuthRef ||
    input.parsed.clientSecretService ||
    input.parsed.scopes ||
    input.parsed.authorizeUrl ||
    input.parsed.tokenUrl
  );
}

async function resolveOptionalOAuthClientSecret(input: {
  readonly parsed: OAuthConnectArgs;
  readonly authRef: string;
  readonly service: string;
}): Promise<
  | {
      readonly ok: true;
      readonly clientSecret?: string;
      readonly shouldPersist: boolean;
    }
  | { readonly ok: false; readonly error: string }
> {
  const direct = (input.parsed.clientSecret ?? "").trim();
  if (direct) {
    return { ok: true, clientSecret: direct, shouldPersist: true };
  }

  if (input.parsed.clientSecretStdin) {
    const text = (await Bun.stdin.text()).trim();
    if (!text) {
      return { ok: false, error: "Missing client secret from stdin." };
    }
    return { ok: true, clientSecret: text, shouldPersist: true };
  }

  const fromEnv =
    readOptionalString(process.env[DEFAULT_OAUTH_CLIENT_SECRET_ENV]) ??
    readOptionalString(process.env[DEFAULT_OAUTH_CLIENT_SECRET_ENV_FALLBACK]);
  if (fromEnv) {
    return { ok: true, clientSecret: fromEnv, shouldPersist: false };
  }

  const stored = await secrets.get({
    service: input.service,
    name: input.authRef,
  });
  if (stored?.trim()) {
    return { ok: true, clientSecret: stored.trim(), shouldPersist: false };
  }

  return { ok: true, shouldPersist: false };
}

type LinearOAuthCallbackOutcome =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly error: string };

type LinearOAuthCallbackServer = {
  readonly redirectUri: string;
  readonly waitForCallback: (input: {
    readonly expectedState: string;
  }) => Promise<LinearOAuthCallbackOutcome>;
  readonly stop: () => void;
};

function startLinearOAuthCallbackServer(input: {
  readonly timeoutMs: number;
}): LinearOAuthCallbackServer {
  let resolver: ((result: LinearOAuthCallbackOutcome) => void) | null = null;
  let receivedState: string | undefined;
  const outcome = new Promise<LinearOAuthCallbackOutcome>((resolve) => {
    resolver = resolve;
  });

  const timeout = setTimeout(() => {
    resolver?.({
      ok: false,
      error: "OAuth callback timed out. Retry the flow.",
    });
  }, input.timeoutMs);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/linear/callback") {
        return new Response("Not found", { status: 404 });
      }

      const code = readOptionalString(url.searchParams.get("code"));
      const state = readOptionalString(url.searchParams.get("state"));
      const error = readOptionalString(url.searchParams.get("error"));
      const errorDescription = readOptionalString(
        url.searchParams.get("error_description")
      );

      if (error) {
        resolver?.({
          ok: false,
          error: errorDescription ?? error,
        });
        return renderOAuthCallbackHtml({
          title: "Linear auth denied",
          body: errorDescription ?? error,
        });
      }
      if (!(state && code)) {
        resolver?.({
          ok: false,
          error: "Missing OAuth code/state in callback.",
        });
        return renderOAuthCallbackHtml({
          title: "Linear auth failed",
          body: "Missing OAuth code/state in callback.",
        });
      }

      receivedState = state;
      resolver?.({ ok: true, code });
      return renderOAuthCallbackHtml({
        title: "Linear account connected",
        body: "You can close this tab and return to hack.",
      });
    },
  });

  const redirectUri = `http://127.0.0.1:${server.port}/linear/callback`;

  return {
    redirectUri,
    waitForCallback: async (input) => {
      const result = await outcome;
      clearTimeout(timeout);
      if (!result.ok) {
        return result;
      }
      if (receivedState !== input.expectedState) {
        return {
          ok: false,
          error: "OAuth callback state mismatch.",
        };
      }
      return result;
    },
    stop: () => {
      clearTimeout(timeout);
      server.stop();
    },
  };
}

function renderOAuthCallbackHtml(input: {
  readonly title: string;
  readonly body: string;
}): Response {
  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8" />',
    `  <title>${escapeHtml({ text: input.title })}</title>`,
    "  <style>",
    "    body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; margin: 0; padding: 24px; background: #0b0f14; color: #f5f7fa; }",
    "    .card { max-width: 680px; margin: 0 auto; border: 1px solid #2b3440; border-radius: 12px; padding: 18px 20px; background: #151b22; }",
    "    h1 { font-size: 18px; margin: 0 0 10px; }",
    "    p { margin: 0; line-height: 1.5; white-space: pre-wrap; }",
    "  </style>",
    "</head>",
    "<body>",
    '  <div class="card">',
    `    <h1>${escapeHtml({ text: input.title })}</h1>`,
    `    <p>${escapeHtml({ text: input.body })}</p>`,
    "  </div>",
    "</body>",
    "</html>",
  ].join("\n");

  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function buildAuthorizeUrl(input: {
  readonly authorizeUrl: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly actor?: "user" | "app";
  readonly scopes: string;
  readonly state: string;
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: string;
}): string {
  const url = new URL(input.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  if (input.actor) {
    url.searchParams.set("actor", input.actor);
  }
  url.searchParams.set("scope", input.scopes);
  url.searchParams.set("state", input.state);
  url.searchParams.set("prompt", "consent");
  if (input.codeChallenge) {
    url.searchParams.set("code_challenge", input.codeChallenge);
    url.searchParams.set(
      "code_challenge_method",
      input.codeChallengeMethod ?? "S256"
    );
  }
  return url.toString();
}

async function fetchJson<T>(input: {
  readonly url: string;
}): Promise<
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }
> {
  try {
    const response = await fetch(input.url, {
      headers: {
        accept: "application/json",
        "user-agent": "hack-cli",
      },
    });
    const bodyText = await response.text();
    const payload = bodyText ? (JSON.parse(bodyText) as unknown) : null;
    if (!response.ok) {
      const error =
        isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : bodyText.trim() || `HTTP ${response.status}`;
      return { ok: false, error };
    }
    return {
      ok: true,
      value: payload as T,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function exchangeLinearOAuthCode(input: {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier?: string;
}): Promise<
  | {
      readonly ok: true;
      readonly token: string;
      readonly expiresAt?: string;
      readonly refreshToken?: string;
      readonly refreshTokenExpiresAt?: string;
    }
  | { readonly ok: false; readonly error: string }
> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    code: input.code,
    redirect_uri: input.redirectUri,
    ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
    ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
  });
  const response = await fetch(input.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": "hack-cli",
    },
    body: body.toString(),
  });

  const payload = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(payload)) {
    return {
      ok: false,
      error: `Linear token exchange failed (${response.status}): invalid payload.`,
    };
  }

  if (!response.ok) {
    const message =
      readOptionalString(payload.error_description) ??
      readOptionalString(payload.error) ??
      response.statusText;
    return {
      ok: false,
      error: `Linear token exchange failed (${response.status}): ${message}`,
    };
  }

  const token = readOptionalString(payload.access_token);
  if (!token) {
    return {
      ok: false,
      error: "Linear token exchange failed: missing access_token.",
    };
  }

  const expiresIn =
    typeof payload.expires_in === "number" &&
    Number.isFinite(payload.expires_in)
      ? Math.max(0, Math.floor(payload.expires_in))
      : null;
  const refreshToken = readOptionalString(payload.refresh_token);
  const refreshTokenExpiresIn =
    typeof payload.refresh_token_expires_in === "number" &&
    Number.isFinite(payload.refresh_token_expires_in)
      ? Math.max(0, Math.floor(payload.refresh_token_expires_in))
      : null;
  const expiresAt =
    expiresIn === null
      ? undefined
      : new Date(Date.now() + expiresIn * 1000).toISOString();
  const refreshTokenExpiresAt =
    refreshTokenExpiresIn === null
      ? undefined
      : new Date(Date.now() + refreshTokenExpiresIn * 1000).toISOString();

  return {
    ok: true,
    token,
    ...(expiresAt ? { expiresAt } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(refreshTokenExpiresAt ? { refreshTokenExpiresAt } : {}),
  };
}

function createLinearPkcePair(): {
  readonly codeVerifier: string;
  readonly codeChallenge: string;
} {
  const codeVerifier = randomBytes(64).toString("base64url");
  const codeChallenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return { codeVerifier, codeChallenge };
}

function escapeHtml(input: { readonly text: string }): string {
  return input.text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function resolveConnectToken(input: {
  readonly token?: string;
  readonly stdin: boolean;
  readonly tokenEnv: string;
  readonly expiresAt?: string;
  readonly refreshToken?: string;
  readonly refreshTokenExpiresAt?: string;
}): Promise<
  | {
      readonly ok: true;
      readonly token: string;
      readonly expiresAt?: string;
      readonly refreshToken?: string;
      readonly refreshTokenExpiresAt?: string;
    }
  | { readonly ok: false; readonly error: string }
> {
  const direct = (input.token ?? "").trim();
  if (direct) {
    return {
      ok: true,
      token: direct,
      ...(readOptionalString(input.expiresAt)
        ? { expiresAt: readOptionalString(input.expiresAt) }
        : {}),
      ...(readOptionalString(input.refreshToken)
        ? { refreshToken: readOptionalString(input.refreshToken) }
        : {}),
      ...(readOptionalString(input.refreshTokenExpiresAt)
        ? {
            refreshTokenExpiresAt: readOptionalString(
              input.refreshTokenExpiresAt
            ),
          }
        : {}),
    };
  }
  if (input.stdin) {
    const text = (await Bun.stdin.text()).trim();
    if (!text) {
      return { ok: false, error: "Missing token from stdin." };
    }
    const envelope = parseLinearTokenEnvelope(text);
    if (!envelope?.token) {
      return { ok: false, error: "Missing token from stdin." };
    }
    return {
      ok: true,
      token: envelope.token,
      ...(envelope.expiresAt ? { expiresAt: envelope.expiresAt } : {}),
      ...(envelope.refreshToken ? { refreshToken: envelope.refreshToken } : {}),
      ...(envelope.refreshTokenExpiresAt
        ? { refreshTokenExpiresAt: envelope.refreshTokenExpiresAt }
        : {}),
    };
  }
  const envToken = (process.env[input.tokenEnv] ?? "").trim();
  if (!envToken) {
    return {
      ok: false,
      error: `Missing token. Provide --token, --stdin, or set ${input.tokenEnv}.`,
    };
  }
  return { ok: true, token: envToken };
}

function parseLinearTokenEnvelope(value: string): {
  readonly token?: string;
  readonly expiresAt?: string;
  readonly refreshToken?: string;
  readonly refreshTokenExpiresAt?: string;
} | null {
  const text = value.trim();
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return { token: text };
    }
    const token = readOptionalString(parsed.token) ?? undefined;
    const refreshToken = readOptionalString(parsed.refreshToken) ?? undefined;
    if (!(token || refreshToken)) {
      return null;
    }
    return {
      ...(token ? { token } : {}),
      ...(readOptionalString(parsed.expiresAt)
        ? { expiresAt: readOptionalString(parsed.expiresAt) ?? undefined }
        : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(readOptionalString(parsed.refreshTokenExpiresAt)
        ? {
            refreshTokenExpiresAt:
              readOptionalString(parsed.refreshTokenExpiresAt) ?? undefined,
          }
        : {}),
    };
  } catch {
    return { token: text };
  }
}

function shouldFallbackConnectToOAuth(input: {
  readonly parsed: ConnectArgs;
  readonly tokenEnv: string;
}): boolean {
  if (input.parsed.token || input.parsed.stdin) {
    return false;
  }
  const envToken = (process.env[input.tokenEnv] ?? "").trim();
  return envToken.length === 0;
}

function buildOAuthArgsFromConnectArgs(input: {
  readonly parsed: ConnectArgs;
  readonly profileId: string;
}): string[] {
  return [
    "--profile",
    input.profileId,
    ...(input.parsed.setDefault ? ["--set-default"] : []),
    ...(input.parsed.apiUrl ? ["--api-url", input.parsed.apiUrl] : []),
    ...(input.parsed.tokenEnv ? ["--token-env", input.parsed.tokenEnv] : []),
    ...(input.parsed.authRef ? ["--auth-ref", input.parsed.authRef] : []),
    ...(input.parsed.service ? ["--service", input.parsed.service] : []),
  ];
}

function normalizePositiveInteger(input: {
  readonly value: number | undefined;
  readonly fallback: number;
}): number {
  if (
    typeof input.value === "number" &&
    Number.isFinite(input.value) &&
    input.value > 0
  ) {
    return Math.floor(input.value);
  }
  return input.fallback;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

type SetupArgs = {
  profileId?: string;
  projectId?: string;
  projectName?: string;
  teamId?: string;
  json: boolean;
};

type ConnectArgs = {
  profileId?: string;
  token?: string;
  stdin: boolean;
  tokenEnv?: string;
  authRef?: string;
  service?: string;
  apiUrl?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  setDefault: boolean;
};

type OAuthConnectArgs = {
  profileId?: string;
  setDefault: boolean;
  clientId?: string;
  clientSecret?: string;
  clientSecretStdin: boolean;
  clientSecretAuthRef?: string;
  clientSecretService?: string;
  scopes?: string;
  authorizeUrl?: string;
  tokenUrl?: string;
  apiUrl?: string;
  tokenEnv?: string;
  authRef?: string;
  service?: string;
  noOpen: boolean;
  json: boolean;
};

type DisconnectArgs = {
  profileId?: string;
  authRef?: string;
  service?: string;
};

type StatusArgs = {
  profileId?: string;
  json: boolean;
};

type ProfilesArgs = {
  json: boolean;
};

type UseArgs = {
  profileId: string;
};

type ProjectsArgs = {
  profileId?: string;
  limit?: number;
  json: boolean;
};

type ProjectBindArgs = {
  profileId?: string;
  projectId?: string;
  projectName?: string;
  teamId?: string;
  clear: boolean;
  json: boolean;
};

type SyncIssueArgs = {
  from: "linear" | "hack";
  issueIdentifier?: string;
  ticketId?: string;
  profileId?: string;
  projectId?: string;
  teamId?: string;
  syncLabels?: boolean;
  json: boolean;
};

type SyncProjectArgs = {
  from: "linear" | "hack";
  profileId?: string;
  projectId?: string;
  teamId?: string;
  ownerMode: "hack" | "linear" | "both";
  limit?: number;
  syncLabels?: boolean;
  json: boolean;
};

function parseSetupArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: SetupArgs }
  | { readonly ok: false; readonly error: string } {
  const value: SetupArgs = { json: false };

  for (let i = 0; i < input.args.length; i += 1) {
    const token = input.args[i] ?? "";
    if (token === "--json") {
      value.json = true;
      continue;
    }
    const handled = assignKeyValueFlag({
      token,
      args: input.args,
      index: i,
      out: value,
      keys: {
        profile: "profileId",
        "project-id": "projectId",
        "project-name": "projectName",
        "team-id": "teamId",
      },
    });
    if (!handled.ok) {
      return { ok: false, error: handled.error };
    }
    i = handled.nextIndex;
  }

  return { ok: true, value };
}

function parseConnectArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: ConnectArgs }
  | { readonly ok: false; readonly error: string } {
  const value: ConnectArgs = {
    stdin: false,
    setDefault: false,
  };

  for (let i = 0; i < input.args.length; i += 1) {
    const token = input.args[i] ?? "";
    if (token === "--stdin") {
      value.stdin = true;
      continue;
    }
    if (token === "--set-default") {
      value.setDefault = true;
      continue;
    }
    const handled = assignKeyValueFlag({
      token,
      args: input.args,
      index: i,
      out: value,
      keys: {
        profile: "profileId",
        token: "token",
        "token-env": "tokenEnv",
        "auth-ref": "authRef",
        service: "service",
        "api-url": "apiUrl",
        "refresh-token": "refreshToken",
        "token-expires-at": "tokenExpiresAt",
        "refresh-token-expires-at": "refreshTokenExpiresAt",
      },
    });
    if (!handled.ok) {
      return { ok: false, error: handled.error };
    }
    i = handled.nextIndex;
  }

  return { ok: true, value };
}

function parseOAuthConnectArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: OAuthConnectArgs }
  | { readonly ok: false; readonly error: string } {
  const value: OAuthConnectArgs = {
    setDefault: false,
    clientSecretStdin: false,
    noOpen: false,
    json: false,
  };

  for (let i = 0; i < input.args.length; i += 1) {
    const token = input.args[i] ?? "";
    if (token === "--set-default") {
      value.setDefault = true;
      continue;
    }
    if (token === "--client-secret-stdin") {
      value.clientSecretStdin = true;
      continue;
    }
    if (token === "--no-open") {
      value.noOpen = true;
      continue;
    }
    if (token === "--json") {
      value.json = true;
      continue;
    }

    const handled = assignKeyValueFlag({
      token,
      args: input.args,
      index: i,
      out: value,
      keys: {
        profile: "profileId",
        "client-id": "clientId",
        "client-secret": "clientSecret",
        "client-secret-auth-ref": "clientSecretAuthRef",
        "client-secret-service": "clientSecretService",
        scopes: "scopes",
        "authorize-url": "authorizeUrl",
        "token-url": "tokenUrl",
        "api-url": "apiUrl",
        "token-env": "tokenEnv",
        "auth-ref": "authRef",
        service: "service",
      },
    });
    if (handled.ok) {
      i = handled.nextIndex;
      continue;
    }
    return { ok: false, error: handled.error };
  }

  return { ok: true, value };
}

function parseDisconnectArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: DisconnectArgs }
  | { readonly ok: false; readonly error: string } {
  const value: DisconnectArgs = {};
  for (let i = 0; i < input.args.length; i += 1) {
    const token = input.args[i] ?? "";
    const handled = assignKeyValueFlag({
      token,
      args: input.args,
      index: i,
      out: value,
      keys: {
        profile: "profileId",
        "auth-ref": "authRef",
        service: "service",
      },
    });
    if (!handled.ok) {
      return { ok: false, error: handled.error };
    }
    i = handled.nextIndex;
  }
  return { ok: true, value };
}

function parseStatusArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: StatusArgs }
  | { readonly ok: false; readonly error: string } {
  const value: StatusArgs = { json: false };
  for (let i = 0; i < input.args.length; i += 1) {
    const token = input.args[i] ?? "";
    if (token === "--json") {
      value.json = true;
      continue;
    }
    const handled = assignKeyValueFlag({
      token,
      args: input.args,
      index: i,
      out: value,
      keys: {
        profile: "profileId",
      },
    });
    if (!handled.ok) {
      return { ok: false, error: handled.error };
    }
    i = handled.nextIndex;
  }
  return { ok: true, value };
}

function parseProfilesArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: ProfilesArgs }
  | { readonly ok: false; readonly error: string } {
  const value: ProfilesArgs = { json: false };
  for (const token of input.args) {
    if (token === "--json") {
      value.json = true;
      continue;
    }
    return { ok: false, error: `Unknown option: ${token}` };
  }
  return { ok: true, value };
}

function parseUseArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: UseArgs }
  | { readonly ok: false; readonly error: string } {
  let profileId: string | undefined;
  for (let i = 0; i < input.args.length; i += 1) {
    const token = input.args[i] ?? "";
    const handled = assignKeyValueFlag({
      token,
      args: input.args,
      index: i,
      out: { profileId },
      keys: {
        profile: "profileId",
      },
    });
    if (!handled.ok) {
      return { ok: false, error: handled.error };
    }
    profileId = (handled.out as { profileId?: string }).profileId;
    i = handled.nextIndex;
  }

  if (!profileId) {
    return { ok: false, error: "Usage: hack x linear use --profile <id>" };
  }
  return {
    ok: true,
    value: { profileId },
  };
}

function parseProjectsArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: ProjectsArgs }
  | { readonly ok: false; readonly error: string } {
  const value: ProjectsArgs = { json: false };
  for (let i = 0; i < input.args.length; i += 1) {
    const token = input.args[i] ?? "";
    if (token === "--json") {
      value.json = true;
      continue;
    }
    if (token.startsWith("--limit=")) {
      value.limit = Number.parseInt(token.slice("--limit=".length), 10);
      continue;
    }
    if (token === "--limit") {
      const next = input.args[i + 1];
      if (!next || next.startsWith("-")) {
        return { ok: false, error: "--limit requires a value." };
      }
      value.limit = Number.parseInt(next, 10);
      i += 1;
      continue;
    }
    const handled = assignKeyValueFlag({
      token,
      args: input.args,
      index: i,
      out: value,
      keys: {
        profile: "profileId",
      },
    });
    if (!handled.ok) {
      return { ok: false, error: handled.error };
    }
    i = handled.nextIndex;
  }
  return { ok: true, value };
}

function parseProjectBindArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: ProjectBindArgs }
  | { readonly ok: false; readonly error: string } {
  const value: ProjectBindArgs = {
    clear: false,
    json: false,
  };
  for (let i = 0; i < input.args.length; i += 1) {
    const token = input.args[i] ?? "";
    if (token === "--clear") {
      value.clear = true;
      continue;
    }
    if (token === "--json") {
      value.json = true;
      continue;
    }
    const handled = assignKeyValueFlag({
      token,
      args: input.args,
      index: i,
      out: value,
      keys: {
        profile: "profileId",
        "project-id": "projectId",
        "project-name": "projectName",
        "team-id": "teamId",
      },
    });
    if (!handled.ok) {
      return { ok: false, error: handled.error };
    }
    i = handled.nextIndex;
  }
  return { ok: true, value };
}

function parseSyncIssueArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: SyncIssueArgs }
  | { readonly ok: false; readonly error: string } {
  const value: SyncIssueArgs = {
    from: "linear",
    json: false,
  };
  for (let i = 0; i < input.args.length; i += 1) {
    const token = input.args[i] ?? "";
    if (token === "--json") {
      value.json = true;
      continue;
    }
    if (token === "--sync-labels") {
      value.syncLabels = true;
      continue;
    }
    const handled = assignKeyValueFlag({
      token,
      args: input.args,
      index: i,
      out: value,
      keys: {
        from: "from",
        issue: "issueIdentifier",
        ticket: "ticketId",
        profile: "profileId",
        "project-id": "projectId",
        "team-id": "teamId",
      },
    });
    if (!handled.ok) {
      return { ok: false, error: handled.error };
    }
    i = handled.nextIndex;
  }

  if (!(value.from === "linear" || value.from === "hack")) {
    return {
      ok: false,
      error: `Invalid --from value: ${String(value.from)}. Expected linear|hack.`,
    };
  }
  return { ok: true, value };
}

function parseSyncProjectArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: SyncProjectArgs }
  | { readonly ok: false; readonly error: string } {
  const value: SyncProjectArgs = {
    from: "linear",
    ownerMode: "hack",
    json: false,
  };
  for (let i = 0; i < input.args.length; i += 1) {
    const token = input.args[i] ?? "";
    if (token === "--json") {
      value.json = true;
      continue;
    }
    if (token === "--sync-labels") {
      value.syncLabels = true;
      continue;
    }
    if (token.startsWith("--limit=")) {
      value.limit = Number.parseInt(token.slice("--limit=".length), 10);
      continue;
    }
    if (token === "--limit") {
      const next = input.args[i + 1];
      if (!next || next.startsWith("-")) {
        return { ok: false, error: "--limit requires a value." };
      }
      value.limit = Number.parseInt(next, 10);
      i += 1;
      continue;
    }
    const handled = assignKeyValueFlag({
      token,
      args: input.args,
      index: i,
      out: value,
      keys: {
        from: "from",
        profile: "profileId",
        "project-id": "projectId",
        "team-id": "teamId",
        owner: "ownerMode",
      },
    });
    if (!handled.ok) {
      return { ok: false, error: handled.error };
    }
    i = handled.nextIndex;
  }
  if (!(value.from === "linear" || value.from === "hack")) {
    return {
      ok: false,
      error: `Invalid --from value: ${String(value.from)}. Expected linear|hack.`,
    };
  }
  if (
    !(
      value.ownerMode === "hack" ||
      value.ownerMode === "linear" ||
      value.ownerMode === "both"
    )
  ) {
    return {
      ok: false,
      error: `Invalid --owner value: ${String(value.ownerMode)}. Expected hack|linear|both.`,
    };
  }
  return { ok: true, value };
}

function assignKeyValueFlag<T extends Record<string, unknown>>(input: {
  readonly token: string;
  readonly args: readonly string[];
  readonly index: number;
  readonly out: T;
  readonly keys: Record<string, keyof T>;
}):
  | { readonly ok: true; readonly nextIndex: number; readonly out: T }
  | { readonly ok: false; readonly error: string } {
  if (!input.token.startsWith("--")) {
    return { ok: false, error: `Unknown argument: ${input.token}` };
  }
  const equalsIndex = input.token.indexOf("=");
  if (equalsIndex !== -1) {
    const rawKey = input.token.slice(2, equalsIndex);
    const key = input.keys[rawKey];
    if (!key) {
      return { ok: false, error: `Unknown option: --${rawKey}` };
    }
    input.out[key] = input.token.slice(equalsIndex + 1) as T[keyof T];
    return { ok: true, nextIndex: input.index, out: input.out };
  }

  const rawKey = input.token.slice(2);
  const key = input.keys[rawKey];
  if (!key) {
    return { ok: false, error: `Unknown option: ${input.token}` };
  }
  const next = input.args[input.index + 1];
  if (!next || next.startsWith("-")) {
    return { ok: false, error: `${input.token} requires a value.` };
  }
  input.out[key] = next as T[keyof T];
  return { ok: true, nextIndex: input.index + 1, out: input.out };
}

function trimTrailingSlash(input: { readonly value: string }): string {
  return input.value.replace(TRAILING_SLASH_REGEX, "");
}

function normalizeOAuthActor(value: string | undefined): "user" | "app" | null {
  const normalized = readOptionalString(value)?.toLowerCase();
  if (normalized === "user" || normalized === "app") {
    return normalized;
  }
  return null;
}

export const __testOnly = {
  buildOAuthArgsFromConnectArgs,
  parseConnectArgs,
  parseProjectBindArgs,
  parseProjectsArgs,
  resolveOAuthBrokerRuntimeConfig,
  parseSetupArgs,
  parseStatusArgs,
  parseSyncIssueArgs,
  parseSyncProjectArgs,
  shouldFallbackConnectToOAuth,
  shouldUseBrokerOAuthFlow,
} as const;
