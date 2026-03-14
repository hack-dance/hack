import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { secrets } from "bun";

import {
  updateGlobalConfig,
  updateProjectConfig,
  updateProjectConfigBatch,
} from "../../../lib/config.ts";
import { isRecord } from "../../../lib/guards.ts";
import { openUrl } from "../../../lib/os.ts";
import { display } from "../../../ui/display.ts";
import {
  findTicketRemoteLink,
  projectRemoteLinkToCompatibilityFields,
} from "../tickets/provenance.ts";
import {
  createTicketsStore,
  type TicketComment,
  type TicketMetadataValue,
  type TicketStatus,
  type TicketSummary,
} from "../tickets/store.ts";
import { normalizeTicketRef } from "../tickets/util.ts";
import type { ExtensionCommand, ExtensionCommandContext } from "../types.ts";
import {
  deleteLinearToken,
  listLinearAuthProfiles,
  readStoredLinearTokenEnvelope,
  resolveLinearAuthSettings,
  resolveLinearAuthSettingsResult,
  resolveLinearBrokerManagementToken,
  resolveLinearToken,
  saveLinearToken,
} from "./auth.ts";
import {
  createLinearClient,
  type LinearComment,
  type LinearIssue,
  type LinearUser,
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
const DEFAULT_DELIVERY_LIST_LIMIT = 50;
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
    name: "connections",
    summary:
      "List broker-owned Linear connections for the current Hack account",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      const parsed = parseConnectionsArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const connections = await listLinearConnections({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId: parsed.value.profileId,
        organizationId: parsed.value.organizationId,
      });
      if (!connections.ok) {
        ctx.logger.error({ message: connections.error });
        return 1;
      }

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(connections.data, null, 2)}\n`);
        return 0;
      }

      await display.kv({
        title: "Linear broker connections",
        entries: [
          ["access_control_mode", connections.data.accessControlMode ?? ""],
          ["connections", String(connections.data.connections.length)],
        ],
      });
      if (connections.data.connections.length === 0) {
        await display.panel({
          title: "No broker-owned Linear connections",
          lines: [
            "No Linear accounts are persisted on this Hack account yet, or this account does not have access to them.",
          ],
          tone: "info",
        });
        return 0;
      }

      await display.table({
        columns: ["Profile", "Account", "Email", "Local", "Owner", "Updated"],
        rows: connections.data.connections.map((connection) => [
          connection.profileId ?? "",
          connection.accountName ?? connection.accountId ?? "",
          connection.accountEmail ?? "",
          connection.localAccessAvailable ? "ready" : "missing",
          describeLinearConnectionOwner(connection),
          connection.updatedAt,
        ]),
      });
      return 0;
    },
  },
  {
    name: "seed-local-access",
    summary:
      "Seed this Mac with local Linear access from a Hack-owned remote connection",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      const parsed = parseSeedLocalAccessArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const seeded = await seedLinearLocalAccessFromBroker({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId: parsed.value.profileId,
        setDefault: parsed.value.setDefault,
      });
      if (!seeded.ok) {
        ctx.logger.error({ message: seeded.error });
        return 1;
      }

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(seeded.data, null, 2)}\n`);
        return 0;
      }

      await display.kv({
        title: "Linear local access seeded",
        entries: [
          ["profile", seeded.data.profileId],
          [
            "account",
            seeded.data.accountName ?? seeded.data.accountEmail ?? "",
          ],
          ["refreshed", seeded.data.refreshed ? "yes" : "no"],
          ["set_default", seeded.data.setDefault ? "yes" : "no"],
        ],
      });
      return 0;
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
    name: "assignee-mappings",
    summary: "List explicit local assignee to Linear user mappings",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      const parsed = parseAssigneeMappingsArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const profileId = resolveSelectedLinearProfileId({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId: parsed.value.profileId,
      });
      const mappings = listLinearAssigneeMappings({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId,
        teamId: parsed.value.teamId,
      });

      const payload = {
        profileId,
        ...(parsed.value.teamId ? { teamId: parsed.value.teamId } : {}),
        mappings,
      };
      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return 0;
      }

      await display.kv({
        title: "Linear assignee mappings",
        entries: [
          ["profile", profileId],
          ["team_id", parsed.value.teamId ?? ""],
          ["count", String(mappings.length)],
        ],
      });
      await display.table({
        columns: [
          "Local Assignee",
          "Team ID",
          "Linear User ID",
          "Linear User",
          "Linear Email",
        ],
        rows: mappings.map((mapping) => [
          mapping.localAssignee,
          mapping.teamId ?? "",
          mapping.linearUserId ?? "",
          mapping.linearUserName ?? "",
          mapping.linearUserEmail ?? "",
        ]),
      });
      return 0;
    },
  },
  {
    name: "set-assignee-mapping",
    summary:
      "Create or replace an explicit local assignee to Linear user mapping",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      const parsed = parseUpsertAssigneeMappingArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const profileId = resolveSelectedLinearProfileId({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId: parsed.value.profileId,
      });
      const nextMapping = createLinearAssigneeMapping({
        profileId,
        teamId: parsed.value.teamId,
        localAssignee: parsed.value.localAssignee,
        linearUserId: parsed.value.linearUserId,
        linearUserName: parsed.value.linearUserName,
        linearUserEmail: parsed.value.linearUserEmail,
      });
      if (!nextMapping) {
        ctx.logger.error({
          message:
            "Missing --local-assignee or Linear user details. Pass --linear-user-id, --linear-user-name, or --linear-user-email.",
        });
        return 1;
      }

      const currentMappings = listLinearAssigneeMappings({
        controlPlaneConfig: ctx.controlPlaneConfig,
      });
      const nextMappings = upsertLinearAssigneeMapping({
        mappings: currentMappings,
        mapping: nextMapping,
      });
      await updateGlobalConfig({
        path: `controlPlane.extensions["${EXTENSION_ID}"].config.assigneeMappings`,
        value: nextMappings,
      });

      const payload = {
        upserted: true,
        replacedExisting: hasLinearAssigneeMapping({
          mappings: currentMappings,
          mapping: nextMapping,
        }),
        mapping: nextMapping,
      };
      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return 0;
      }

      await display.kv({
        title: "Linear assignee mapping saved",
        entries: [
          ["profile", nextMapping.profileId],
          ["team_id", nextMapping.teamId ?? ""],
          ["local_assignee", nextMapping.localAssignee],
          ["linear_user_id", nextMapping.linearUserId ?? ""],
          ["linear_user_name", nextMapping.linearUserName ?? ""],
          ["linear_user_email", nextMapping.linearUserEmail ?? ""],
        ],
      });
      return 0;
    },
  },
  {
    name: "remove-assignee-mapping",
    summary: "Remove an explicit local assignee to Linear user mapping",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      const parsed = parseRemoveAssigneeMappingArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const profileId = resolveSelectedLinearProfileId({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId: parsed.value.profileId,
      });
      const localAssignee = readOptionalString(parsed.value.localAssignee);
      if (!localAssignee) {
        ctx.logger.error({ message: "Missing --local-assignee <value>." });
        return 1;
      }

      const currentMappings = listLinearAssigneeMappings({
        controlPlaneConfig: ctx.controlPlaneConfig,
      });
      const removed = removeLinearAssigneeMapping({
        mappings: currentMappings,
        profileId,
        teamId: parsed.value.teamId,
        localAssignee,
      });
      await updateGlobalConfig({
        path: `controlPlane.extensions["${EXTENSION_ID}"].config.assigneeMappings`,
        value: removed.mappings,
      });

      const payload = {
        removed: removed.removed,
        profileId,
        ...(parsed.value.teamId ? { teamId: parsed.value.teamId } : {}),
        localAssignee,
      };
      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return removed.removed ? 0 : 1;
      }

      await display.kv({
        title: "Linear assignee mapping removed",
        entries: [
          ["profile", profileId],
          ["team_id", parsed.value.teamId ?? ""],
          ["local_assignee", localAssignee],
          ["removed", removed.removed ? "yes" : "no"],
        ],
      });
      return removed.removed ? 0 : 1;
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

      const existingBinding = resolveProjectLinearBinding({
        controlPlaneConfig: ctx.controlPlaneConfig,
      });

      if (
        !(
          parsed.value.clear ||
          parsed.value.projectId ||
          parsed.value.projectName ||
          parsed.value.profileId ||
          parsed.value.teamId
        )
      ) {
        const payload = buildProjectBindingPayload({
          binding: existingBinding,
        });
        if (parsed.value.json) {
          process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        } else {
          await display.kv({
            title: "Linear project binding",
            entries: [
              ["profile", payload.profileId ?? ""],
              ["project_id", payload.projectId ?? ""],
              ["project_name", payload.projectName ?? ""],
              ["team_id", payload.teamId ?? ""],
              [
                "additional_projects",
                payload.additionalProjects
                  .map((project) => project.projectId)
                  .join(", "),
              ],
            ],
          });
        }
        return 0;
      }

      if (parsed.value.clear) {
        await updateProjectConfigBatch({
          projectDir: ctx.project.projectDir,
          values: [
            {
              path: "controlPlane.routing.overrides.linear.profile",
              value: "",
            },
            {
              path: "controlPlane.routing.overrides.linear.projectId",
              value: "",
            },
            {
              path: "controlPlane.routing.overrides.linear.projectName",
              value: "",
            },
            {
              path: "controlPlane.routing.overrides.linear.teamId",
              value: "",
            },
            {
              path: "controlPlane.routing.overrides.linear.additionalProjects",
              value: [],
            },
          ],
        });

        const payload = buildProjectBindingPayload({
          binding: { additionalProjects: [] },
          cleared: true,
        });
        if (parsed.value.json) {
          process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        } else {
          await display.panel({
            title: "Linear project binding",
            tone: "success",
            lines: [
              "Cleared project-level Linear routing overrides, including additional synced projects.",
            ],
          });
        }
        return 0;
      }

      const boundProfile = parsed.value.profileId ?? existingBinding.profileId;

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

      await updateProjectConfigBatch({
        projectDir: ctx.project.projectDir,
        values: [
          {
            path: "controlPlane.routing.overrides.linear.projectId",
            value: projectId,
          },
          {
            path: "controlPlane.routing.overrides.linear.projectName",
            value: resolvedTeamAndName.projectName,
          },
          {
            path: "controlPlane.routing.overrides.linear.teamId",
            value: resolvedTeamAndName.teamId,
          },
          {
            path: "controlPlane.routing.overrides.linear.additionalProjects",
            value: removeAdditionalProjectBinding({
              existing: existingBinding.additionalProjects,
              projectId,
            }),
          },
        ],
      });

      const payload = buildProjectBindingPayload({
        binding: {
          ...(boundProfile ? { profileId: boundProfile } : {}),
          projectId,
          projectName: resolvedTeamAndName.projectName,
          teamId: resolvedTeamAndName.teamId,
          additionalProjects: removeAdditionalProjectBinding({
            existing: existingBinding.additionalProjects,
            projectId,
          }),
        },
      });

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
            [
              "additional_projects",
              payload.additionalProjects
                .map((project) => project.projectId)
                .join(", "),
            ],
          ],
        });
      }
      return 0;
    },
  },
  {
    name: "project-link",
    summary:
      "Add an additional Linear project to the current hack project sync scope",
    scope: "project",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." });
        return 1;
      }
      const parsed = parseProjectLinkArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      await enableLinearProjectExtension({
        projectDir: ctx.project.projectDir,
      });

      const projectId = parsed.value.projectId;
      if (!projectId) {
        ctx.logger.error({
          message:
            "Missing --project-id. Pass a Linear project id to add to the additional sync scope.",
        });
        return 1;
      }

      const binding = resolveProjectLinearBinding({
        controlPlaneConfig: ctx.controlPlaneConfig,
      });
      const targetProfile = parsed.value.profileId ?? binding.profileId;
      const resolvedTeamAndName = await resolveProjectBindingDetails({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId: targetProfile,
        projectId,
        projectName: parsed.value.projectName,
        teamId: parsed.value.teamId,
      });
      if (!resolvedTeamAndName.ok) {
        ctx.logger.error({ message: resolvedTeamAndName.error });
        return 1;
      }

      const additionalProjects = upsertAdditionalProjectBinding({
        existing: binding.additionalProjects,
        target: {
          projectId,
          projectName: resolvedTeamAndName.projectName,
          teamId: resolvedTeamAndName.teamId,
          ...(targetProfile ? { profileId: targetProfile } : {}),
        },
        defaultProjectId: binding.projectId,
      });
      await updateProjectConfigBatch({
        projectDir: ctx.project.projectDir,
        values: [
          {
            path: "controlPlane.routing.overrides.linear.additionalProjects",
            value: additionalProjects,
          },
          ...(!binding.profileId && targetProfile
            ? [
                {
                  path: "controlPlane.routing.overrides.linear.profile",
                  value: targetProfile,
                },
              ]
            : []),
        ],
      });

      const payload = buildProjectBindingPayload({
        binding: {
          ...((binding.profileId ?? targetProfile)
            ? { profileId: binding.profileId ?? targetProfile }
            : {}),
          ...(binding.projectId ? { projectId: binding.projectId } : {}),
          ...(binding.projectName ? { projectName: binding.projectName } : {}),
          ...(binding.teamId ? { teamId: binding.teamId } : {}),
          additionalProjects,
        },
        additionalProjectChanged: true,
      });

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        await display.kv({
          title: "Linear additional project linked",
          entries: [
            ["profile", payload.profileId ?? ""],
            ["project_id", projectId],
            ["project_name", resolvedTeamAndName.projectName],
            ["team_id", resolvedTeamAndName.teamId],
            [
              "additional_projects",
              payload.additionalProjects
                .map((project) => project.projectId)
                .join(", "),
            ],
          ],
        });
      }
      return 0;
    },
  },
  {
    name: "project-unlink",
    summary:
      "Remove an additional Linear project from the current hack project sync scope",
    scope: "project",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." });
        return 1;
      }
      const parsed = parseProjectLinkArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const projectId = parsed.value.projectId;
      if (!projectId) {
        ctx.logger.error({
          message:
            "Missing --project-id. Pass a Linear project id to remove from the additional sync scope.",
        });
        return 1;
      }

      const binding = resolveProjectLinearBinding({
        controlPlaneConfig: ctx.controlPlaneConfig,
      });
      if (
        binding.projectId &&
        binding.projectId.toLowerCase() === projectId.toLowerCase()
      ) {
        ctx.logger.error({
          message:
            "Cannot unlink the default Linear project with `project-unlink`. Use `project-bind --clear` or bind a different default project instead.",
        });
        return 1;
      }

      const additionalProjects = removeAdditionalProjectBinding({
        existing: binding.additionalProjects,
        projectId,
      });
      const removed =
        additionalProjects.length !== binding.additionalProjects.length;
      await updateProjectConfig({
        projectDir: ctx.project.projectDir,
        path: "controlPlane.routing.overrides.linear.additionalProjects",
        value: additionalProjects,
      });

      const payload = buildProjectBindingPayload({
        binding: {
          ...(binding.profileId ? { profileId: binding.profileId } : {}),
          ...(binding.projectId ? { projectId: binding.projectId } : {}),
          ...(binding.projectName ? { projectName: binding.projectName } : {}),
          ...(binding.teamId ? { teamId: binding.teamId } : {}),
          additionalProjects,
        },
        additionalProjectChanged: removed,
        removedProjectId: removed ? projectId : null,
      });

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        await display.kv({
          title: "Linear additional project unlinked",
          entries: [
            ["removed", removed ? "yes" : "no"],
            ["project_id", projectId],
            [
              "additional_projects",
              payload.additionalProjects
                .map((project) => project.projectId)
                .join(", "),
            ],
          ],
        });
      }
      return removed ? 0 : 1;
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

      const toggles = resolveSyncToggles({
        controlPlaneConfig: ctx.controlPlaneConfig,
        labelsOverride: parsed.value.syncLabels,
      });

      if (parsed.value.from === "linear") {
        const runtime = await createSyncRuntime({
          ctx,
          profileId: parsed.value.profileId,
        });
        if (!runtime.ok) {
          ctx.logger.error({ message: runtime.error });
          return 1;
        }

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

      const binding = resolveProjectLinearBinding({
        controlPlaneConfig: ctx.controlPlaneConfig,
      });
      const selectedTarget =
        (parsed.value.projectId
          ? findProjectBindingTarget({
              binding,
              projectId: parsed.value.projectId,
            })
          : null) ??
        (binding.projectId
          ? {
              projectId: binding.projectId,
              ...(binding.projectName
                ? { projectName: binding.projectName }
                : {}),
              ...(binding.teamId ? { teamId: binding.teamId } : {}),
              ...(binding.profileId ? { profileId: binding.profileId } : {}),
            }
          : null);
      const runtime = await createSyncRuntime({
        ctx,
        profileId: parsed.value.profileId ?? selectedTarget?.profileId,
      });
      if (!runtime.ok) {
        ctx.logger.error({ message: runtime.error });
        return 1;
      }

      const synced = await syncTicketToLinearIssue({
        runtime: runtime.value,
        ticketId: normalizedTicketId,
        explicitProjectId: parsed.value.projectId ?? selectedTarget?.projectId,
        explicitTeamId: parsed.value.teamId ?? selectedTarget?.teamId,
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

      const toggles = resolveSyncToggles({
        controlPlaneConfig: ctx.controlPlaneConfig,
        labelsOverride: parsed.value.syncLabels,
      });
      const binding = resolveProjectLinearBinding({
        controlPlaneConfig: ctx.controlPlaneConfig,
      });

      if (parsed.value.from === "linear") {
        const projectTargets = resolveProjectPullTargets({
          binding,
          explicitProjectId: parsed.value.projectId,
        });
        if (projectTargets.length === 0) {
          ctx.logger.error({
            message:
              "Missing project id. Pass --project-id, bind a default project, or add additional linked projects first.",
          });
          return 1;
        }

        const targetsByProfile = new Map<
          string,
          LinearProjectBindingTarget[]
        >();
        for (const target of projectTargets) {
          const key = (
            parsed.value.profileId ??
            target.profileId ??
            binding.profileId ??
            ""
          ).trim();
          const existingTargets = targetsByProfile.get(key) ?? [];
          existingTargets.push(target);
          targetsByProfile.set(key, existingTargets);
        }

        let processed = 0;
        let created = 0;
        let updated = 0;
        let commentsPulled = 0;
        let conflictsRecorded = 0;
        let checkpointsRecorded = 0;
        const syncedProjectIds: string[] = [];

        for (const [profileId, targets] of targetsByProfile.entries()) {
          const runtime = await createSyncRuntime({
            ctx,
            profileId: profileId || undefined,
          });
          if (!runtime.ok) {
            ctx.logger.error({ message: runtime.error });
            return 1;
          }

          const syncResult = await syncProjectFromLinearProjectsToTickets({
            runtime: runtime.value,
            projectIds: targets.map((target) => target.projectId),
            limit: parsed.value.limit,
            syncToggles: toggles,
          });
          if (!syncResult.ok) {
            ctx.logger.error({ message: syncResult.error });
            return 1;
          }

          processed += syncResult.processed;
          created += syncResult.created;
          updated += syncResult.updated;
          commentsPulled += syncResult.commentsPulled;
          conflictsRecorded += syncResult.conflictsRecorded;
          checkpointsRecorded += syncResult.checkpointsRecorded;
          syncedProjectIds.push(...syncResult.projectIds);
        }

        const syncResult = {
          ok: true as const,
          projectIds: [...new Set(syncedProjectIds)],
          processed,
          created,
          updated,
          commentsPulled,
          conflictsRecorded,
          checkpointsRecorded,
        };

        if (parsed.value.json) {
          process.stdout.write(`${JSON.stringify(syncResult, null, 2)}\n`);
        } else {
          await display.kv({
            title: "Linear project -> tickets sync",
            entries: [
              ["linear_project_ids", syncResult.projectIds.join(", ")],
              ["processed", String(syncResult.processed)],
              ["created", String(syncResult.created)],
              ["updated", String(syncResult.updated)],
            ],
          });
        }
        return 0;
      }

      const selectedTarget =
        (parsed.value.projectId
          ? findProjectBindingTarget({
              binding,
              projectId: parsed.value.projectId,
            })
          : null) ??
        (binding.projectId
          ? {
              projectId: binding.projectId,
              ...(binding.projectName
                ? { projectName: binding.projectName }
                : {}),
              ...(binding.teamId ? { teamId: binding.teamId } : {}),
              ...(binding.profileId ? { profileId: binding.profileId } : {}),
            }
          : null);
      const projectId = parsed.value.projectId ?? selectedTarget?.projectId;
      const runtime = await createSyncRuntime({
        ctx,
        profileId: parsed.value.profileId ?? selectedTarget?.profileId,
      });
      if (!runtime.ok) {
        ctx.logger.error({ message: runtime.error });
        return 1;
      }
      const syncResult = await syncProjectFromTicketsToLinear({
        runtime: runtime.value,
        projectId,
        explicitTeamId: parsed.value.teamId ?? selectedTarget?.teamId,
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
  {
    name: "run-autosync",
    summary:
      "Consume subscribed pending Linear deliveries for the current project and apply them after local sync",
    scope: "project",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      if (!ctx.project) {
        ctx.logger.error({ message: "No project found. Run inside a repo." });
        return 1;
      }

      const parsed = parseRunAutosyncArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const result = await runProjectLinearAutosync({
        binding: resolveProjectLinearBinding({
          controlPlaneConfig: ctx.controlPlaneConfig,
        }),
        profileId: parsed.value.profileId,
        projectId: parsed.value.projectId,
        teamId: parsed.value.teamId,
        limit: parsed.value.limit,
        syncToggles: resolveSyncToggles({
          controlPlaneConfig: ctx.controlPlaneConfig,
          labelsOverride: parsed.value.syncLabels,
        }),
        deps: {
          createRuntime: async ({ profileId }) =>
            await createSyncRuntime({
              ctx,
              profileId,
            }),
          listSubscriptions: async ({ profileId, projectId, teamId }) =>
            await listLinearAutosyncSubscriptions({
              controlPlaneConfig: ctx.controlPlaneConfig,
              profileId,
              projectId,
              teamId,
            }),
          listDeliveries: async ({
            profileId,
            status,
            projectId,
            teamId,
            limit,
          }) =>
            await listLinearDeliveries({
              controlPlaneConfig: ctx.controlPlaneConfig,
              profileId,
              status,
              projectId,
              teamId,
              limit,
            }),
          syncIssue: async ({ runtime, delivery, syncToggles }) =>
            await syncLinearDeliveryToTicket({
              runtime: runtime as LinearToHackRuntime,
              delivery,
              syncToggles,
            }),
          syncProject: async ({ runtime, projectIds, limit, syncToggles }) =>
            await syncProjectFromLinearProjectsToTickets({
              runtime: runtime as SyncRuntime,
              projectIds,
              limit,
              syncToggles,
            }),
          applyDelivery: async ({ profileId, deliveryId, claimedBy }) =>
            await applyLinearDelivery({
              controlPlaneConfig: ctx.controlPlaneConfig,
              profileId,
              deliveryId,
              claimedBy,
            }),
          claimedBy: buildLinearAutosyncClaimedBy(),
        },
      });
      if (!result.ok) {
        ctx.logger.error({ message: result.error });
        return 1;
      }

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        await display.kv({
          title: "Linear autosync run",
          entries: [
            ["subscribed_routes", String(result.subscribedRoutes)],
            ["processed_deliveries", String(result.processedDeliveries)],
            ["applied_deliveries", String(result.appliedDeliveries)],
            ["failed_deliveries", String(result.failedDeliveries)],
            ["updated", String(result.updated)],
          ],
        });
      }
      return 0;
    },
  },
  {
    name: "deliveries",
    summary:
      "List pending/applied Linear webhook deliveries from the auth broker",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      const parsed = parseDeliveriesArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const deliveries = await listLinearDeliveries({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId: parsed.value.profileId,
        status: parsed.value.status,
        limit: parsed.value.limit,
      });
      if (!deliveries.ok) {
        ctx.logger.error({ message: deliveries.error });
        return 1;
      }

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(deliveries.data, null, 2)}\n`);
        return 0;
      }

      await display.kv({
        title: "Linear deliveries",
        entries: [
          ["profile", deliveries.data.profileId ?? ""],
          ["status", deliveries.data.status ?? "all"],
          ["count", String(deliveries.data.deliveries.length)],
        ],
      });
      await display.table({
        columns: ["Delivery ID", "Status", "Event", "Action", "Received At"],
        rows: deliveries.data.deliveries.map((delivery) => [
          delivery.id,
          delivery.status,
          delivery.eventType ?? "",
          delivery.action ?? "",
          delivery.receivedAt ?? "",
        ]),
      });
      return 0;
    },
  },
  {
    name: "apply-delivery",
    summary:
      "Mark a pending Linear webhook delivery as applied after manual review",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      const parsed = parseApplyDeliveryArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const applied = await applyLinearDelivery({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId: parsed.value.profileId,
        deliveryId: parsed.value.deliveryId,
      });
      if (!applied.ok) {
        ctx.logger.error({ message: applied.error });
        return 1;
      }

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(applied.data, null, 2)}\n`);
        return 0;
      }

      await display.kv({
        title: "Linear delivery applied",
        entries: [
          ["profile", applied.data.profileId ?? ""],
          ["delivery_id", applied.data.deliveryId],
          ["status", applied.data.status],
        ],
      });
      return 0;
    },
  },
  {
    name: "subscriptions",
    summary: "List Linear autosync subscriptions from the auth broker",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      const parsed = parseAutosyncSubscriptionsArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const profileId = resolveSelectedLinearProfileId({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId: parsed.value.profileId,
      });
      const subscriptions = await listLinearAutosyncSubscriptions({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId,
        projectId: parsed.value.projectId,
        teamId: parsed.value.teamId,
      });
      if (!subscriptions.ok) {
        ctx.logger.error({ message: subscriptions.error });
        return 1;
      }

      if (parsed.value.json) {
        process.stdout.write(
          `${JSON.stringify(subscriptions.data, null, 2)}\n`
        );
        return 0;
      }

      await display.kv({
        title: "Linear autosync subscriptions",
        entries: [
          ["profile", subscriptions.data.profileId],
          ["project_id", parsed.value.projectId ?? ""],
          ["team_id", parsed.value.teamId ?? ""],
          ["count", String(subscriptions.data.subscriptions.length)],
        ],
      });
      await display.table({
        columns: ["Project ID", "Team ID", "Mode", "Status", "Updated At"],
        rows: subscriptions.data.subscriptions.map((subscription) => [
          subscription.projectId ?? "",
          subscription.teamId ?? "",
          subscription.mode,
          subscription.status,
          subscription.updatedAt ?? "",
        ]),
      });
      return 0;
    },
  },
  {
    name: "set-subscription",
    summary: "Create or update a Linear autosync subscription",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      const parsed = parseUpsertAutosyncSubscriptionArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const profileId = resolveSelectedLinearProfileId({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId: parsed.value.profileId,
      });
      const saved = await upsertLinearAutosyncSubscription({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId,
        projectId: parsed.value.projectId,
        teamId: parsed.value.teamId,
        mode: parsed.value.mode,
        status: parsed.value.status,
      });
      if (!saved.ok) {
        ctx.logger.error({ message: saved.error });
        return 1;
      }

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(saved.data, null, 2)}\n`);
        return 0;
      }

      await display.kv({
        title: "Linear autosync subscription saved",
        entries: [
          ["profile", saved.data.profileId],
          ["project_id", saved.data.subscription.projectId ?? ""],
          ["team_id", saved.data.subscription.teamId ?? ""],
          ["mode", saved.data.subscription.mode],
          ["status", saved.data.subscription.status],
        ],
      });
      return 0;
    },
  },
  {
    name: "remove-subscription",
    summary: "Remove a Linear autosync subscription",
    scope: "global",
    allowWhenDisabled: true,
    handler: async ({ ctx, args }) => {
      const parsed = parseRemoveAutosyncSubscriptionArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const profileId = resolveSelectedLinearProfileId({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId: parsed.value.profileId,
      });
      const removed = await removeLinearAutosyncSubscription({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId,
        projectId: parsed.value.projectId,
        teamId: parsed.value.teamId,
      });
      if (!removed.ok) {
        ctx.logger.error({ message: removed.error });
        return 1;
      }

      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(removed.data, null, 2)}\n`);
        return 0;
      }

      await display.kv({
        title: "Linear autosync subscription removed",
        entries: [
          ["profile", removed.data.profileId],
          ["project_id", removed.data.subscription.projectId ?? ""],
          ["team_id", removed.data.subscription.teamId ?? ""],
          ["mode", removed.data.subscription.mode],
          ["status", removed.data.subscription.status],
        ],
      });
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
          readonly managementToken?: string;
          readonly managementTokenExpiresAt?: string;
        };
      }
    | { readonly ok: false; readonly error: string };

  if (shouldUseBrokerOAuthFlow({ parsed: parsed.value })) {
    const brokerFlow = await startLinearBrokerOAuthFlow({
      controlPlaneConfig: input.ctx.controlPlaneConfig,
      parsed: parsed.value,
      brokerConfig: resolveOAuthBrokerRuntimeConfig({
        controlPlaneConfig: input.ctx.controlPlaneConfig,
      }),
      profileId: resolved.profileId,
    });
    if (parsed.value.startOnly) {
      if (!brokerFlow.ok) {
        input.ctx.logger.error({ message: brokerFlow.error });
        return 1;
      }
      if (parsed.value.json) {
        process.stdout.write(
          `${JSON.stringify(buildLinearOAuthStartPayload({ flow: brokerFlow.flow }), null, 2)}\n`
        );
      } else {
        await display.panel({
          title: "Linear OAuth",
          tone: "info",
          lines: [
            "Open this URL in your browser to continue:",
            brokerFlow.flow.authorizeUrl,
            "",
            `Status URL: ${buildLinearOAuthStatusUrl({ pollUrl: brokerFlow.flow.pollUrl, deviceCode: brokerFlow.flow.deviceCode })}`,
          ],
        });
      }
      return 0;
    }

    oauthFlow = await runLinearBrokerOAuthFlow({
      controlPlaneConfig: input.ctx.controlPlaneConfig,
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
    ...(oauthFlow.tokenExchange.managementToken
      ? { managementToken: oauthFlow.tokenExchange.managementToken }
      : {}),
    ...(oauthFlow.tokenExchange.managementTokenExpiresAt
      ? {
          managementTokenExpiresAt:
            oauthFlow.tokenExchange.managementTokenExpiresAt,
        }
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
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
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
        readonly managementToken?: string;
        readonly managementTokenExpiresAt?: string;
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

async function startLinearBrokerOAuthFlow(
  input: OAuthBrokerConnectRuntime
): Promise<
  | {
      readonly ok: true;
      readonly flow: BrokerStartFlowPayload;
    }
  | { readonly ok: false; readonly error: string }
> {
  const brokerAuth = await resolveLinearBrokerAuthorization({
    controlPlaneConfig: input.controlPlaneConfig,
    profileId: input.profileId,
  });
  if (!brokerAuth.ok) {
    return {
      ok: false,
      error: brokerAuth.error,
    };
  }
  const startUrl = new URL(
    "/v1/auth/linear/start",
    `${input.brokerConfig.baseUrl}/`
  );
  startUrl.searchParams.set("profile", input.profileId);
  startUrl.searchParams.set("setDefault", input.parsed.setDefault ? "1" : "0");
  if (input.parsed.desktopRedirectUrl) {
    startUrl.searchParams.set(
      "desktopRedirectUrl",
      input.parsed.desktopRedirectUrl
    );
  }

  const start = await fetchJson<BrokerStartFlowEnvelope>({
    url: startUrl.toString(),
    init: {
      headers: brokerAuth.headers,
    },
  });
  if (!start.ok) {
    return {
      ok: false,
      error: normalizeBrokerProtectedLinearError({
        error: start.error,
        profileId: brokerAuth.profileId,
      }),
    };
  }

  return {
    ok: true,
    flow: start.value.flow,
  };
}

function buildLinearOAuthStatusUrl(input: {
  readonly pollUrl: string;
  readonly deviceCode: string;
}): string {
  const statusUrl = new URL(input.pollUrl);
  statusUrl.searchParams.set("deviceCode", input.deviceCode);
  statusUrl.searchParams.set("claim", "1");
  return statusUrl.toString();
}

function buildLinearOAuthStartPayload(input: {
  readonly flow: BrokerStartFlowPayload;
}): {
  readonly ok: true;
  readonly flowId: string;
  readonly profileId: string;
  readonly setDefault: boolean;
  readonly authorizeUrl: string;
  readonly statusUrl: string;
  readonly expiresAt: string;
} {
  return {
    ok: true,
    flowId: input.flow.flowId,
    profileId: input.flow.profileId,
    setDefault: input.flow.setDefault,
    authorizeUrl: input.flow.authorizeUrl,
    statusUrl: buildLinearOAuthStatusUrl({
      pollUrl: input.flow.pollUrl,
      deviceCode: input.flow.deviceCode,
    }),
    expiresAt: input.flow.expiresAt,
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
        readonly managementToken?: string;
        readonly managementTokenExpiresAt?: string;
      };
    }
  | { readonly ok: false; readonly error: string }
> {
  const start = await startLinearBrokerOAuthFlow(input);
  if (!start.ok) {
    return start;
  }

  const launch = await launchLinearOAuthBrowser({
    parsed: input.parsed,
    authorizeUrl: start.flow.authorizeUrl,
    pollUrl: start.flow.pollUrl,
  });
  if (!launch.ok) {
    return launch;
  }

  const expiresAtMs = Date.parse(start.flow.expiresAt);
  const statusUrl = new URL(start.flow.pollUrl);
  statusUrl.searchParams.set("deviceCode", start.flow.deviceCode);
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
          ...(flowStatus.managementToken
            ? { managementToken: flowStatus.managementToken }
            : {}),
          ...(flowStatus.managementTokenExpiresAt
            ? {
                managementTokenExpiresAt: flowStatus.managementTokenExpiresAt,
              }
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

type TicketSyncStore = Pick<
  ReturnType<typeof createTicketsStore>,
  | "appendComment"
  | "createTicket"
  | "getTicket"
  | "getTicketDetail"
  | "linkCommentExternalId"
  | "listTickets"
  | "recordSyncCheckpoint"
  | "recordSyncConflict"
  | "setStatus"
  | "updateTicket"
>;

type LinearSyncClient = Pick<
  ReturnType<typeof createLinearClient>,
  | "createComment"
  | "createIssue"
  | "getIssueById"
  | "getIssueByIdentifier"
  | "getProject"
  | "listIssueComments"
  | "listProjectIssuesPage"
  | "listTeamLabels"
  | "listTeamStates"
  | "listTeamUsers"
  | "updateIssue"
>;

type SyncRuntime = {
  readonly tickets: TicketSyncStore;
  readonly linear: LinearSyncClient;
  readonly profileId: string;
  readonly apiUrl: string;
  readonly projectBinding: ReturnType<typeof resolveProjectLinearBinding>;
  readonly assigneeMappings: readonly LinearAssigneeMapping[];
};

type SyncToggles = {
  readonly labels: boolean;
  readonly statuses: boolean;
  readonly dependencies: boolean;
  readonly projects: boolean;
};

type LinearDeliveryStatus = "pending" | "applied" | "ignored";
type LinearAutosyncMode = "manual" | "auto_apply";
type LinearAutosyncStatus = "active" | "paused";

type DeliveriesArgs = {
  profileId?: string;
  status?: LinearDeliveryStatus;
  limit?: number;
  json: boolean;
};

type RunAutosyncArgs = {
  profileId?: string;
  projectId?: string;
  teamId?: string;
  limit?: number;
  syncLabels?: boolean;
  json: boolean;
};

type ApplyDeliveryArgs = {
  profileId?: string;
  deliveryId: string;
  json: boolean;
};

type AutosyncSubscriptionsArgs = {
  profileId?: string;
  projectId?: string;
  teamId?: string;
  json: boolean;
};

type UpsertAutosyncSubscriptionArgs = {
  profileId?: string;
  projectId?: string;
  teamId?: string;
  mode: LinearAutosyncMode;
  status: LinearAutosyncStatus;
  json: boolean;
};

type RemoveAutosyncSubscriptionArgs = {
  profileId?: string;
  projectId?: string;
  teamId?: string;
  json: boolean;
};

type AssigneeMappingsArgs = {
  profileId?: string;
  teamId?: string;
  json: boolean;
};

type UpsertAssigneeMappingArgs = {
  profileId?: string;
  teamId?: string;
  localAssignee?: string;
  linearUserId?: string;
  linearUserName?: string;
  linearUserEmail?: string;
  json: boolean;
};

type RemoveAssigneeMappingArgs = {
  profileId?: string;
  teamId?: string;
  localAssignee?: string;
  json: boolean;
};

type SyncAssigneeResolution = {
  readonly requestedAssignee?: string;
  readonly matchedUserId?: string;
  readonly matchedUserDisplayName?: string;
  readonly applied: boolean;
};

type LinearAssigneeMapping = {
  readonly profileId: string;
  readonly localAssignee: string;
  readonly teamId?: string;
  readonly linearUserId?: string;
  readonly linearUserName?: string;
  readonly linearUserEmail?: string;
};

type LinearToHackRuntime = {
  readonly tickets: Pick<
    TicketSyncStore,
    | "appendComment"
    | "createTicket"
    | "getTicketDetail"
    | "listTickets"
    | "recordSyncCheckpoint"
    | "recordSyncConflict"
    | "setStatus"
    | "updateTicket"
  >;
  readonly linear: Pick<
    LinearSyncClient,
    "getIssueById" | "getIssueByIdentifier" | "listIssueComments"
  >;
  readonly profileId: string;
};

type HackToLinearRuntime = {
  readonly tickets: Pick<
    TicketSyncStore,
    | "getTicket"
    | "getTicketDetail"
    | "linkCommentExternalId"
    | "recordSyncCheckpoint"
    | "recordSyncConflict"
    | "updateTicket"
  >;
  readonly linear: Pick<
    LinearSyncClient,
    | "createComment"
    | "createIssue"
    | "getIssueById"
    | "getIssueByIdentifier"
    | "getProject"
    | "listIssueComments"
    | "listTeamLabels"
    | "listTeamStates"
    | "listTeamUsers"
    | "updateIssue"
  >;
  readonly assigneeMappings: readonly LinearAssigneeMapping[];
  readonly profileId: string;
  readonly apiUrl: string;
  readonly projectBinding: ReturnType<typeof resolveProjectLinearBinding>;
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
      assigneeMappings: listLinearAssigneeMappings({
        controlPlaneConfig: input.ctx.controlPlaneConfig,
        profileId: token.profileId,
      }),
    },
  };
}

function resolveSelectedLinearProfileId(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
  readonly profileId?: string;
}): string {
  return resolveLinearAuthSettings({
    controlPlaneConfig: input.controlPlaneConfig,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    allowProjectOverride: false,
  }).profileId;
}

function listLinearAssigneeMappings(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
  readonly profileId?: string;
  readonly teamId?: string;
}): readonly LinearAssigneeMapping[] {
  const extension = input.controlPlaneConfig.extensions?.[EXTENSION_ID];
  const config =
    isRecord(extension) && isRecord(extension.config) ? extension.config : null;
  const rawMappings = config?.assigneeMappings;
  const parsedMappings = parseStoredLinearAssigneeMappings({
    value: rawMappings,
  });

  return parsedMappings.filter((mapping) => {
    if (input.profileId && mapping.profileId !== input.profileId) {
      return false;
    }
    if (input.teamId && mapping.teamId !== input.teamId) {
      return false;
    }
    return true;
  });
}

function parseStoredLinearAssigneeMappings(input: {
  readonly value: unknown;
}): readonly LinearAssigneeMapping[] {
  let rawItems: readonly unknown[] = [];
  if (Array.isArray(input.value)) {
    rawItems = input.value;
  } else if (isRecord(input.value) && Array.isArray(input.value.items)) {
    rawItems = input.value.items;
  }
  const deduped = new Map<string, LinearAssigneeMapping>();
  for (const item of rawItems) {
    const mapping = parseLinearAssigneeMapping({ value: item });
    if (!mapping) {
      continue;
    }
    deduped.set(buildLinearAssigneeMappingKey({ mapping }), mapping);
  }
  return [...deduped.values()].sort((left, right) => {
    const leftKey = buildLinearAssigneeMappingKey({ mapping: left });
    const rightKey = buildLinearAssigneeMappingKey({ mapping: right });
    return leftKey.localeCompare(rightKey);
  });
}

function parseLinearAssigneeMapping(input: {
  readonly value: unknown;
}): LinearAssigneeMapping | null {
  if (!isRecord(input.value)) {
    return null;
  }
  return createLinearAssigneeMapping({
    profileId: input.value.profileId,
    teamId: input.value.teamId,
    localAssignee: input.value.localAssignee,
    linearUserId: input.value.linearUserId,
    linearUserName: input.value.linearUserName,
    linearUserEmail: input.value.linearUserEmail,
  });
}

function createLinearAssigneeMapping(input: {
  readonly profileId: unknown;
  readonly teamId?: unknown;
  readonly localAssignee?: unknown;
  readonly linearUserId?: unknown;
  readonly linearUserName?: unknown;
  readonly linearUserEmail?: unknown;
}): LinearAssigneeMapping | null {
  const profileId = readOptionalString(input.profileId);
  const localAssignee = readOptionalString(input.localAssignee);
  const linearUserId = readOptionalString(input.linearUserId);
  const linearUserName = readOptionalString(input.linearUserName);
  const linearUserEmail = readOptionalString(input.linearUserEmail);
  if (!(profileId && localAssignee)) {
    return null;
  }
  if (!(linearUserId || linearUserName || linearUserEmail)) {
    return null;
  }
  const teamId = readOptionalString(input.teamId);
  return {
    profileId,
    localAssignee,
    ...(teamId ? { teamId } : {}),
    ...(linearUserId ? { linearUserId } : {}),
    ...(linearUserName ? { linearUserName } : {}),
    ...(linearUserEmail ? { linearUserEmail } : {}),
  };
}

function buildLinearAssigneeMappingKey(input: {
  readonly mapping: Pick<
    LinearAssigneeMapping,
    "profileId" | "teamId" | "localAssignee"
  >;
}): string {
  return [
    input.mapping.profileId.trim().toLowerCase(),
    readOptionalString(input.mapping.teamId)?.toLowerCase() ?? "*",
    input.mapping.localAssignee.trim().toLowerCase(),
  ].join("|");
}

function hasLinearAssigneeMapping(input: {
  readonly mappings: readonly LinearAssigneeMapping[];
  readonly mapping: LinearAssigneeMapping;
}): boolean {
  const targetKey = buildLinearAssigneeMappingKey({
    mapping: input.mapping,
  });
  return input.mappings.some(
    (mapping) =>
      buildLinearAssigneeMappingKey({
        mapping,
      }) === targetKey
  );
}

function upsertLinearAssigneeMapping(input: {
  readonly mappings: readonly LinearAssigneeMapping[];
  readonly mapping: LinearAssigneeMapping;
}): readonly LinearAssigneeMapping[] {
  const targetKey = buildLinearAssigneeMappingKey({
    mapping: input.mapping,
  });
  const next: LinearAssigneeMapping[] = [];
  for (const mapping of input.mappings) {
    if (
      buildLinearAssigneeMappingKey({
        mapping,
      }) === targetKey
    ) {
      continue;
    }
    next.push(mapping);
  }
  next.push(input.mapping);
  return next.sort((left, right) => {
    const leftKey = buildLinearAssigneeMappingKey({ mapping: left });
    const rightKey = buildLinearAssigneeMappingKey({ mapping: right });
    return leftKey.localeCompare(rightKey);
  });
}

function removeLinearAssigneeMapping(input: {
  readonly mappings: readonly LinearAssigneeMapping[];
  readonly profileId: string;
  readonly teamId?: string;
  readonly localAssignee: string;
}): {
  readonly removed: boolean;
  readonly mappings: readonly LinearAssigneeMapping[];
} {
  const targetKey = buildLinearAssigneeMappingKey({
    mapping: {
      profileId: input.profileId,
      ...(input.teamId ? { teamId: input.teamId } : {}),
      localAssignee: input.localAssignee,
    },
  });
  let removed = false;
  const next = input.mappings.filter((mapping) => {
    const isTarget =
      buildLinearAssigneeMappingKey({
        mapping,
      }) === targetKey;
    if (isTarget) {
      removed = true;
    }
    return !isTarget;
  });
  return { removed, mappings: next };
}

type RecordedSyncConflict = {
  readonly field: string;
  readonly authority: "hack" | "linear";
  readonly summary: string;
  readonly localValue?: TicketMetadataValue;
  readonly remoteValue?: TicketMetadataValue;
};

type SyncTicketFromLinearSuccess = {
  readonly ok: true;
  readonly operation: "created" | "updated";
  readonly ticketId: string;
  readonly issueIdentifier: string;
  readonly commentsPulled: number;
  readonly conflictsRecorded: number;
  readonly checkpointRecorded: boolean;
};

type SyncTicketToLinearSuccess = {
  readonly ok: true;
  readonly operation: "created" | "updated";
  readonly ticketId: string;
  readonly issueIdentifier: string;
  readonly issueId: string;
  readonly commentsPushed: number;
  readonly conflictsRecorded: number;
  readonly checkpointRecorded: boolean;
  readonly assignee: SyncAssigneeResolution;
};

type LinearDeliverySummary = {
  readonly id: string;
  readonly status: string;
  readonly profileId?: string;
  readonly projectId?: string;
  readonly teamId?: string;
  readonly issueId?: string;
  readonly issueIdentifier?: string;
  readonly claimedBy?: string;
  readonly eventType?: string;
  readonly action?: string;
  readonly receivedAt?: string;
  readonly updatedAt?: string;
  readonly payload?: unknown;
};

function resolveTicketAuthority(input: {
  readonly ticket: TicketSummary;
}): "hack" | "linear" | "review_required" {
  const owner = input.ticket.owner.trim().toLowerCase();
  const source = input.ticket.source.trim().toLowerCase();
  if (
    (owner === "linear" && source !== "linear") ||
    (source === "linear" && owner !== "linear")
  ) {
    return "review_required";
  }
  if (owner === "linear" || source === "linear") {
    return "linear";
  }
  return "hack";
}

function normalizeBodyForConflictComparison(input: {
  readonly body?: string;
}): string {
  const body = (input.body ?? "").trim();
  const markerIndex = body.indexOf("\n\n---\n\nLinear Issue:");
  if (markerIndex !== -1) {
    return body.slice(0, markerIndex).trim();
  }
  return body;
}

function normalizeCommentBody(input: { readonly body: string }): string {
  return input.body.trim().replaceAll("\r\n", "\n");
}

function normalizeProjectValue(input: {
  readonly projectId?: string;
  readonly projectName?: string;
}): TicketMetadataValue | undefined {
  const projectId = readOptionalString(input.projectId);
  const projectName = readOptionalString(input.projectName);
  if (!(projectId || projectName)) {
    return undefined;
  }
  return {
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
  };
}

function detectAuthoritativeFieldConflicts(input: {
  readonly authority: "hack" | "linear" | "review_required";
  readonly ticket: TicketSummary;
  readonly issue: LinearIssue;
  readonly remoteProjection: Pick<
    TicketProjectionFromLinearIssue,
    "body" | "status"
  >;
}): readonly RecordedSyncConflict[] {
  const conflicts: RecordedSyncConflict[] = [];
  const authorityLabel =
    input.authority === "review_required" ? "review-required" : input.authority;
  const localTitle = input.ticket.title.trim();
  const remoteTitle = input.issue.title.trim();
  if (localTitle !== remoteTitle) {
    conflicts.push({
      field: "title",
      authority: input.authority,
      summary: `Authoritative ${authorityLabel} title diverged from the other side.`,
      localValue: localTitle,
      remoteValue: remoteTitle,
    });
  }

  const localBody = normalizeBodyForConflictComparison({
    body: input.ticket.body,
  });
  const remoteBody = normalizeBodyForConflictComparison({
    body: input.remoteProjection.body,
  });
  if (localBody !== remoteBody) {
    conflicts.push({
      field: "body",
      authority: input.authority,
      summary: `Authoritative ${authorityLabel} body diverged from the other side.`,
      localValue: localBody,
      remoteValue: remoteBody,
    });
  }

  if (input.ticket.status !== input.remoteProjection.status) {
    conflicts.push({
      field: "status",
      authority: input.authority,
      summary: `Authoritative ${authorityLabel} status diverged from the other side.`,
      localValue: input.ticket.status,
      remoteValue: input.remoteProjection.status,
    });
  }

  const localProject = normalizeProjectValue({
    projectId: input.ticket.projectId,
    projectName: input.ticket.projectName,
  });
  const remoteProject = normalizeProjectValue({
    projectId: input.issue.projectId,
    projectName: input.issue.projectName,
  });
  if (
    JSON.stringify(localProject ?? null) !==
    JSON.stringify(remoteProject ?? null)
  ) {
    conflicts.push({
      field: "project",
      authority: input.authority,
      summary: `Authoritative ${authorityLabel} project routing diverged from the other side.`,
      ...(localProject !== undefined ? { localValue: localProject } : {}),
      ...(remoteProject !== undefined ? { remoteValue: remoteProject } : {}),
    });
  }

  return conflicts;
}

function selectLinearCommentsToAppend(input: {
  readonly localComments: readonly TicketComment[];
  readonly remoteComments: readonly LinearComment[];
}): readonly LinearComment[] {
  const existingExternalIds = new Set(
    input.localComments
      .map((comment) => readOptionalString(comment.externalId))
      .filter((value): value is string => value !== undefined)
  );
  const existingBodies = new Set(
    input.localComments
      .map((comment) => normalizeCommentBody({ body: comment.body }))
      .filter((value) => value.length > 0)
  );

  return input.remoteComments.filter((comment) => {
    if (existingExternalIds.has(comment.id)) {
      return false;
    }
    const normalizedBody = normalizeCommentBody({ body: comment.body });
    if (!normalizedBody) {
      return false;
    }
    return !existingBodies.has(normalizedBody);
  });
}

function selectTicketCommentsToPush(input: {
  readonly localComments: readonly TicketComment[];
  readonly remoteComments: readonly LinearComment[];
}): readonly TicketComment[] {
  const remoteBodies = new Set(
    input.remoteComments
      .map((comment) => normalizeCommentBody({ body: comment.body }))
      .filter((value) => value.length > 0)
  );

  return input.localComments.filter((comment) => {
    const source = comment.source.trim().toLowerCase();
    if (source === "linear") {
      return false;
    }
    if (readOptionalString(comment.externalId)) {
      return false;
    }
    const normalizedBody = normalizeCommentBody({ body: comment.body });
    if (!normalizedBody) {
      return false;
    }
    return !remoteBodies.has(normalizedBody);
  });
}

function deriveTicketAssigneeFromLinearIssue(input: {
  readonly issue: LinearIssue;
}): string | undefined {
  return (
    readOptionalString(input.issue.assigneeDisplayName) ??
    readOptionalString(input.issue.assigneeEmail) ??
    readOptionalString(input.issue.assigneeName)
  );
}

function resolveLinearAssigneeMatch(input: {
  readonly assignee?: string;
  readonly users: readonly LinearUser[];
}): LinearUser | null {
  const requested = readOptionalString(input.assignee)?.toLowerCase();
  if (!requested) {
    return null;
  }

  const match =
    input.users.find(
      (user) => readOptionalString(user.email)?.toLowerCase() === requested
    ) ??
    input.users.find(
      (user) =>
        readOptionalString(user.displayName)?.toLowerCase() === requested
    ) ??
    input.users.find(
      (user) => readOptionalString(user.name)?.toLowerCase() === requested
    );

  return match ?? null;
}

function resolveExplicitLinearAssigneeMapping(input: {
  readonly assigneeMappings: readonly LinearAssigneeMapping[];
  readonly profileId: string;
  readonly teamId: string;
  readonly localAssignee: string;
}): LinearAssigneeMapping | null {
  const targetAssignee = input.localAssignee.trim().toLowerCase();
  const exactMatch =
    input.assigneeMappings.find(
      (mapping) =>
        mapping.profileId === input.profileId &&
        mapping.teamId === input.teamId &&
        mapping.localAssignee.trim().toLowerCase() === targetAssignee
    ) ?? null;
  if (exactMatch) {
    return exactMatch;
  }
  return (
    input.assigneeMappings.find(
      (mapping) =>
        mapping.profileId === input.profileId &&
        !readOptionalString(mapping.teamId) &&
        mapping.localAssignee.trim().toLowerCase() === targetAssignee
    ) ?? null
  );
}

function resolveLinearAssigneeFromMapping(input: {
  readonly mapping: LinearAssigneeMapping;
  readonly users: readonly LinearUser[];
}): LinearUser | null {
  if (input.mapping.linearUserId) {
    const byId =
      input.users.find((user) => user.id === input.mapping.linearUserId) ??
      null;
    if (byId) {
      return byId;
    }
  }
  const email = readOptionalString(
    input.mapping.linearUserEmail
  )?.toLowerCase();
  if (email) {
    const byEmail =
      input.users.find(
        (user) => readOptionalString(user.email)?.toLowerCase() === email
      ) ?? null;
    if (byEmail) {
      return byEmail;
    }
  }
  const displayName = readOptionalString(
    input.mapping.linearUserName
  )?.toLowerCase();
  if (displayName) {
    const byName =
      input.users.find((user) => {
        const userDisplayName = readOptionalString(
          user.displayName ?? user.name
        )?.toLowerCase();
        return userDisplayName === displayName;
      }) ?? null;
    if (byName) {
      return byName;
    }
  }
  return null;
}

function buildConflictDedupKey(input: {
  readonly field: string;
  readonly localValue?: TicketMetadataValue;
  readonly remoteValue?: TicketMetadataValue;
}): string {
  return [
    input.field,
    JSON.stringify(input.localValue ?? null),
    JSON.stringify(input.remoteValue ?? null),
  ].join("|");
}

function buildLinearCheckpointIdempotencyKey(input: {
  readonly ticketId: string;
  readonly profileId: string;
  readonly direction: string;
  readonly issue: LinearIssue;
}): string {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        issueId: input.issue.id,
        identifier: input.issue.identifier,
        title: input.issue.title,
        description: input.issue.description ?? null,
        stateId: input.issue.state.id,
        teamId: input.issue.teamId,
        projectId: input.issue.projectId ?? null,
        assigneeId: input.issue.assigneeId ?? null,
        labels: input.issue.labels.map((label) => label.id).sort(),
      })
    )
    .digest("hex")
    .slice(0, 16);

  return `linear:checkpoint:${input.ticketId}:${input.profileId}:${input.direction}:${fingerprint}`;
}

function buildLinearConflictIdempotencyKey(input: {
  readonly ticketId: string;
  readonly conflict: RecordedSyncConflict;
}): string {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        field: input.conflict.field,
        authority: input.conflict.authority ?? null,
        summary: input.conflict.summary ?? null,
        localValue: input.conflict.localValue ?? null,
        remoteValue: input.conflict.remoteValue ?? null,
      })
    )
    .digest("hex")
    .slice(0, 16);

  return `linear:conflict:${input.ticketId}:${fingerprint}`;
}

async function recordAuthoritativeConflicts(input: {
  readonly tickets: Pick<
    TicketSyncStore,
    "getTicketDetail" | "recordSyncConflict"
  >;
  readonly ticketId: string;
  readonly conflicts: readonly RecordedSyncConflict[];
}): Promise<
  | { readonly ok: true; readonly recorded: number }
  | { readonly ok: false; readonly error: string }
> {
  if (input.conflicts.length === 0) {
    return { ok: true, recorded: 0 };
  }

  const detail = await input.tickets.getTicketDetail({
    ticketId: input.ticketId,
  });
  const existing = new Set(
    detail.conflicts
      .filter((conflict) => conflict.status === "open")
      .map((conflict) =>
        buildConflictDedupKey({
          field: conflict.field,
          localValue: conflict.localValue,
          remoteValue: conflict.remoteValue,
        })
      )
  );

  let recorded = 0;
  for (const conflict of input.conflicts) {
    const key = buildConflictDedupKey(conflict);
    if (existing.has(key)) {
      continue;
    }
    const result = await input.tickets.recordSyncConflict({
      ticketId: input.ticketId,
      provider: "linear",
      field: conflict.field,
      authority: conflict.authority,
      summary: conflict.summary,
      idempotencyKey: buildLinearConflictIdempotencyKey({
        ticketId: input.ticketId,
        conflict,
      }),
      ...(conflict.localValue !== undefined
        ? { localValue: conflict.localValue }
        : {}),
      ...(conflict.remoteValue !== undefined
        ? { remoteValue: conflict.remoteValue }
        : {}),
    });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    existing.add(key);
    recorded += 1;
  }

  return { ok: true, recorded };
}

async function pullLinearCommentsToTicket(input: {
  readonly runtime: Pick<LinearToHackRuntime, "tickets" | "linear">;
  readonly ticketId: string;
  readonly issue: LinearIssue;
}): Promise<
  | { readonly ok: true; readonly commentsPulled: number }
  | { readonly ok: false; readonly error: string }
> {
  const detail = await input.runtime.tickets.getTicketDetail({
    ticketId: input.ticketId,
  });
  const commentsResult = await input.runtime.linear.listIssueComments({
    issueId: input.issue.id,
  });
  if (!commentsResult.ok) {
    return { ok: false, error: commentsResult.error };
  }

  const selected = selectLinearCommentsToAppend({
    localComments: detail.comments,
    remoteComments: commentsResult.data,
  });

  for (const comment of selected) {
    const appended = await input.runtime.tickets.appendComment({
      ticketId: input.ticketId,
      body: comment.body,
      source: "linear",
      actor:
        readOptionalString(comment.userDisplayName) ??
        readOptionalString(comment.userName) ??
        readOptionalString(comment.userEmail) ??
        "linear",
      externalId: comment.id,
    });
    if (!appended.ok) {
      return { ok: false, error: appended.error };
    }
  }

  return { ok: true, commentsPulled: selected.length };
}

async function pushTicketCommentsToLinear(input: {
  readonly runtime: Pick<HackToLinearRuntime, "tickets" | "linear">;
  readonly ticketId: string;
  readonly issueId: string;
}): Promise<
  | { readonly ok: true; readonly commentsPushed: number }
  | { readonly ok: false; readonly error: string }
> {
  const detail = await input.runtime.tickets.getTicketDetail({
    ticketId: input.ticketId,
  });
  const remoteComments = await input.runtime.linear.listIssueComments({
    issueId: input.issueId,
  });
  if (!remoteComments.ok) {
    return { ok: false, error: remoteComments.error };
  }

  const selected = selectTicketCommentsToPush({
    localComments: detail.comments,
    remoteComments: remoteComments.data,
  });

  for (const comment of selected) {
    const created = await input.runtime.linear.createComment({
      issueId: input.issueId,
      body: comment.body,
    });
    if (!created.ok) {
      return { ok: false, error: created.error };
    }
    const linked = await input.runtime.tickets.linkCommentExternalId({
      ticketId: input.ticketId,
      commentId: comment.commentId,
      externalId: created.data.id,
    });
    if (!linked.ok) {
      return { ok: false, error: linked.error };
    }
  }

  return { ok: true, commentsPushed: selected.length };
}

async function recordLinearSyncCheckpoint(input: {
  readonly tickets: Pick<TicketSyncStore, "recordSyncCheckpoint">;
  readonly ticketId: string;
  readonly profileId: string;
  readonly direction: string;
  readonly issue: LinearIssue;
}): Promise<
  | { readonly ok: true; readonly checkpointRecorded: boolean }
  | { readonly ok: false; readonly error: string }
> {
  const checkpoint = await input.tickets.recordSyncCheckpoint({
    ticketId: input.ticketId,
    provider: "linear",
    profileId: input.profileId,
    direction: input.direction,
    remoteCursor: input.issue.identifier,
    localUpdatedAt: new Date().toISOString(),
    idempotencyKey: buildLinearCheckpointIdempotencyKey({
      ticketId: input.ticketId,
      profileId: input.profileId,
      direction: input.direction,
      issue: input.issue,
    }),
  });
  if (!checkpoint.ok) {
    return { ok: false, error: checkpoint.error };
  }
  return { ok: true, checkpointRecorded: true };
}

async function resolveTicketAssigneeForLinear(input: {
  readonly runtime: {
    readonly assigneeMappings: readonly LinearAssigneeMapping[];
    readonly linear: Pick<LinearSyncClient, "listTeamUsers">;
    readonly profileId: string;
  };
  readonly ticket: TicketSummary;
  readonly teamId: string;
}): Promise<SyncAssigneeResolution> {
  const requestedAssignee = readOptionalString(input.ticket.assignee);
  if (!requestedAssignee) {
    return { applied: false };
  }

  const explicitMapping = resolveExplicitLinearAssigneeMapping({
    assigneeMappings: input.runtime.assigneeMappings,
    profileId: input.runtime.profileId,
    teamId: input.teamId,
    localAssignee: requestedAssignee,
  });
  if (explicitMapping?.linearUserId) {
    return {
      requestedAssignee,
      matchedUserId: explicitMapping.linearUserId,
      ...(readOptionalString(
        explicitMapping.linearUserName ?? explicitMapping.linearUserEmail
      )
        ? {
            matchedUserDisplayName:
              readOptionalString(
                explicitMapping.linearUserName ??
                  explicitMapping.linearUserEmail
              ) ?? undefined,
          }
        : {}),
      applied: true,
    };
  }

  const users = await input.runtime.linear.listTeamUsers({
    teamId: input.teamId,
  });
  if (!users.ok) {
    return {
      requestedAssignee,
      applied: false,
    };
  }
  const match =
    (explicitMapping
      ? resolveLinearAssigneeFromMapping({
          mapping: explicitMapping,
          users: users.data,
        })
      : null) ??
    resolveLinearAssigneeMatch({
      assignee: requestedAssignee,
      users: users.data,
    });
  return {
    requestedAssignee,
    ...(match?.id ? { matchedUserId: match.id } : {}),
    ...(readOptionalString(match?.displayName ?? match?.name)
      ? {
          matchedUserDisplayName:
            readOptionalString(match?.displayName ?? match?.name) ?? undefined,
        }
      : {}),
    applied: Boolean(match?.id),
  };
}

type BrokerListDeliveriesPayload = {
  readonly profileId?: string;
  readonly status?: string;
  readonly limit?: number;
  readonly deliveries: readonly LinearDeliverySummary[];
};

type LinearConnectionSummary = {
  readonly id: string;
  readonly profileId: string | null;
  readonly accountId: string | null;
  readonly accountName: string | null;
  readonly accountEmail: string | null;
  readonly authRef: string | null;
  readonly betterAuthUserId: string | null;
  readonly betterAuthOrganizationId: string | null;
  readonly betterAuthTeamId: string | null;
  readonly organizationId: string | null;
  readonly teamId: string | null;
  readonly localAccessAvailable: boolean;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type BrokerListConnectionsPayload = {
  readonly accessControlMode?: string;
  readonly connections: readonly LinearConnectionSummary[];
};

type BrokerSeedLocalAccessPayload = {
  readonly seed: {
    readonly profileId: string;
    readonly accountName: string | null;
    readonly accountEmail: string | null;
    readonly token: string;
    readonly tokenExpiresAt?: string;
    readonly refreshToken?: string;
    readonly refreshTokenExpiresAt?: string;
    readonly refreshed: boolean;
  };
};

type SeededLinearLocalAccessResult = {
  readonly profileId: string;
  readonly accountName: string | null;
  readonly accountEmail: string | null;
  readonly refreshed: boolean;
  readonly setDefault: boolean;
};

type BrokerApplyDeliveryPayload = {
  readonly profileId?: string;
  readonly deliveryId: string;
  readonly status: string;
};

type LinearAutosyncRunDeliveryOutcome = {
  readonly deliveryId: string;
  readonly profileId: string;
  readonly projectId?: string;
  readonly teamId?: string;
  readonly issueId?: string;
  readonly issueIdentifier?: string;
  readonly mode: "issue" | "project";
  readonly status: "applied" | "skipped" | "failed";
  readonly ticketId?: string;
  readonly reason?: string;
};

type LinearAutosyncRunSuccess = {
  readonly ok: true;
  readonly subscribedRoutes: number;
  readonly processedDeliveries: number;
  readonly appliedDeliveries: number;
  readonly skippedDeliveries: number;
  readonly failedDeliveries: number;
  readonly created: number;
  readonly updated: number;
  readonly commentsPulled: number;
  readonly conflictsRecorded: number;
  readonly checkpointsRecorded: number;
  readonly projectIds: readonly string[];
  readonly deliveries: readonly LinearAutosyncRunDeliveryOutcome[];
};

type LinearAutosyncSubscriptionSummary = {
  readonly id: string;
  readonly profileId: string;
  readonly projectId?: string;
  readonly teamId?: string;
  readonly mode: LinearAutosyncMode;
  readonly status: LinearAutosyncStatus;
  readonly updatedAt?: string;
};

type BrokerListAutosyncSubscriptionsPayload = {
  readonly profileId: string;
  readonly subscriptions: readonly LinearAutosyncSubscriptionSummary[];
};

type BrokerAutosyncSubscriptionMutationPayload = {
  readonly profileId: string;
  readonly subscription: LinearAutosyncSubscriptionSummary;
};

type ProjectLinearAutosyncDeps<TRuntime> = {
  readonly createRuntime: (input: {
    readonly profileId?: string;
  }) => Promise<
    | { readonly ok: true; readonly value: TRuntime }
    | { readonly ok: false; readonly error: string }
  >;
  readonly listSubscriptions: (input: {
    readonly profileId: string;
    readonly projectId?: string;
    readonly teamId?: string;
  }) => Promise<
    | {
        readonly ok: true;
        readonly data: BrokerListAutosyncSubscriptionsPayload;
      }
    | { readonly ok: false; readonly error: string }
  >;
  readonly listDeliveries: (input: {
    readonly profileId: string;
    readonly status?: LinearDeliveryStatus;
    readonly projectId?: string;
    readonly teamId?: string;
    readonly limit?: number;
  }) => Promise<
    | { readonly ok: true; readonly data: BrokerListDeliveriesPayload }
    | { readonly ok: false; readonly error: string }
  >;
  readonly syncIssue: (input: {
    readonly runtime: TRuntime;
    readonly delivery: LinearDeliverySummary;
    readonly syncToggles: SyncToggles;
  }) => Promise<
    SyncTicketFromLinearSuccess | { readonly ok: false; readonly error: string }
  >;
  readonly syncProject: (input: {
    readonly runtime: TRuntime;
    readonly projectIds: readonly string[];
    readonly limit?: number;
    readonly syncToggles: SyncToggles;
  }) => Promise<
    | {
        readonly ok: true;
        readonly projectIds: readonly string[];
        readonly processed: number;
        readonly created: number;
        readonly updated: number;
        readonly commentsPulled: number;
        readonly conflictsRecorded: number;
        readonly checkpointsRecorded: number;
      }
    | { readonly ok: false; readonly error: string }
  >;
  readonly applyDelivery: (input: {
    readonly profileId: string;
    readonly deliveryId: string;
    readonly claimedBy?: string;
  }) => Promise<
    | { readonly ok: true; readonly data: BrokerApplyDeliveryPayload }
    | { readonly ok: false; readonly error: string }
  >;
  readonly claimedBy?: string;
};

async function syncLinearDeliveryToTicket(input: {
  readonly runtime: LinearToHackRuntime;
  readonly delivery: Pick<LinearDeliverySummary, "issueIdentifier" | "issueId">;
  readonly syncToggles: SyncToggles;
}): Promise<
  SyncTicketFromLinearSuccess | { readonly ok: false; readonly error: string }
> {
  const issueIdentifier = readOptionalString(input.delivery.issueIdentifier);
  const issueId = readOptionalString(input.delivery.issueId);
  let issueResult: Awaited<
    ReturnType<LinearToHackRuntime["linear"]["getIssueByIdentifier"]>
  > | null = null;
  if (issueIdentifier) {
    issueResult = await input.runtime.linear.getIssueByIdentifier({
      identifier: issueIdentifier,
    });
  } else if (issueId) {
    issueResult = await input.runtime.linear.getIssueById({
      issueId,
    });
  }

  if (!issueResult) {
    return {
      ok: false,
      error:
        "Linear delivery does not include an issue identifier or issue id.",
    };
  }
  if (!issueResult.ok) {
    return { ok: false, error: issueResult.error };
  }
  if (!issueResult.data) {
    return {
      ok: false,
      error: issueIdentifier
        ? `Linear issue not found: ${issueIdentifier}`
        : `Linear issue not found: ${issueId}`,
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

async function syncIssueFromLinearToTicket(input: {
  readonly runtime: LinearToHackRuntime;
  readonly issueIdentifier: string;
  readonly syncToggles: SyncToggles;
}): Promise<
  SyncTicketFromLinearSuccess | { readonly ok: false; readonly error: string }
> {
  return await syncLinearDeliveryToTicket({
    runtime: input.runtime,
    delivery: {
      issueIdentifier: input.issueIdentifier,
    },
    syncToggles: input.syncToggles,
  });
}

async function syncTicketToLinearIssue(input: {
  readonly runtime: HackToLinearRuntime;
  readonly ticketId: string;
  readonly explicitProjectId?: string;
  readonly explicitTeamId?: string;
  readonly syncToggles: SyncToggles;
}): Promise<
  SyncTicketToLinearSuccess | { readonly ok: false; readonly error: string }
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

  const authority = existingIssue.issue
    ? resolveTicketAuthority({ ticket })
    : "hack";

  const assignee = await resolveTicketAssigneeForLinear({
    runtime: input.runtime,
    ticket,
    teamId: target.value.teamId,
  });

  const conflicts = existingIssue.issue
    ? detectAuthoritativeFieldConflicts({
        authority,
        ticket,
        issue: existingIssue.issue,
        remoteProjection: buildTicketProjectionFromLinearIssue({
          issue: existingIssue.issue,
          existingTicket: ticket,
          syncToggles: input.syncToggles,
          dependencyIndex: {
            byLinearId: new Map<string, string>(),
            byLinearIdentifier: new Map<string, string>(),
          },
        }),
      })
    : [];

  const recordedConflicts = existingIssue.issue
    ? await recordAuthoritativeConflicts({
        tickets: input.runtime.tickets,
        ticketId: ticket.ticketId,
        conflicts,
      })
    : { ok: true as const, recorded: 0 };
  if (!recordedConflicts.ok) {
    return { ok: false, error: recordedConflicts.error };
  }

  const effectiveFields =
    authority === "linear" && existingIssue.issue
      ? {
          ...fields.value,
          title: existingIssue.issue.title,
          description: existingIssue.issue.description ?? "",
          ...(existingIssue.issue.assigneeId
            ? { assigneeId: existingIssue.issue.assigneeId }
            : {}),
          ...(input.syncToggles.statuses
            ? { stateId: existingIssue.issue.state.id }
            : {}),
        }
      : fields.value;

  const effectiveProjectId =
    authority === "linear" && existingIssue.issue
      ? existingIssue.issue.projectId
      : target.value.projectId;

  const syncedIssue = await upsertLinearIssueForTicketSync({
    runtime: input.runtime,
    ticket,
    existingIssue: existingIssue.issue,
    fields: effectiveFields,
    teamId: target.value.teamId,
    projectId: effectiveProjectId,
    syncToggles: input.syncToggles,
  });

  if (!syncedIssue.ok) {
    return { ok: false, error: syncedIssue.error };
  }

  const updated = await input.runtime.tickets.updateTicket({
    ticketId: ticket.ticketId,
    ...projectRemoteLinkToCompatibilityFields({
      remote: {
        provider: "linear",
        remoteId: syncedIssue.data.id,
        remoteKey: syncedIssue.data.identifier,
        remoteUrl: syncedIssue.data.url,
        projectId: syncedIssue.data.projectId,
        projectName: syncedIssue.data.projectName,
        teamId: syncedIssue.data.teamId,
      },
    }),
  });
  if (!updated.ok) {
    return { ok: false, error: updated.error };
  }

  const pushedComments = await pushTicketCommentsToLinear({
    runtime: input.runtime,
    ticketId: ticket.ticketId,
    issueId: syncedIssue.data.id,
  });
  if (!pushedComments.ok) {
    return { ok: false, error: pushedComments.error };
  }

  const checkpoint = await recordLinearSyncCheckpoint({
    tickets: input.runtime.tickets,
    ticketId: ticket.ticketId,
    profileId: input.runtime.profileId,
    direction: "hack_to_linear",
    issue: syncedIssue.data,
  });
  if (!checkpoint.ok) {
    return { ok: false, error: checkpoint.error };
  }

  return {
    ok: true,
    operation: existingIssue.issue ? "updated" : "created",
    ticketId: ticket.ticketId,
    issueIdentifier: syncedIssue.data.identifier,
    issueId: syncedIssue.data.id,
    commentsPushed: pushedComments.commentsPushed,
    conflictsRecorded: recordedConflicts.recorded,
    checkpointRecorded: checkpoint.checkpointRecorded,
    assignee,
  };
}

async function resolveLinearTargetForTicketSync(input: {
  readonly runtime: {
    readonly linear: Pick<LinearSyncClient, "getProject">;
    readonly projectBinding: ReturnType<typeof resolveProjectLinearBinding>;
  };
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
  const linearRemote = findTicketRemoteLink({
    ticket: input.ticket,
    provider: "linear",
  });
  let projectId =
    input.explicitProjectId ??
    input.existingIssue?.projectId ??
    linearRemote?.projectId ??
    input.runtime.projectBinding.projectId;
  let teamId =
    input.explicitTeamId ??
    input.existingIssue?.teamId ??
    linearRemote?.teamId ??
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
  readonly assigneeId?: string;
  readonly labelIds?: readonly string[];
  readonly parentId?: string;
};

async function resolveLinearMutationFieldsForTicketSync(input: {
  readonly runtime: {
    readonly linear: Pick<
      LinearSyncClient,
      "listTeamLabels" | "listTeamStates" | "listTeamUsers"
    >;
    readonly tickets: Pick<TicketSyncStore, "getTicket">;
    readonly profileId: string;
    readonly assigneeMappings: readonly LinearAssigneeMapping[];
  };
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

  const assignee = await resolveTicketAssigneeForLinear({
    runtime: input.runtime,
    ticket: input.ticket,
    teamId: input.teamId,
  });

  return {
    ok: true,
    value: {
      title,
      description: input.ticket.body ?? "",
      ...(stateId.value ? { stateId: stateId.value } : {}),
      ...(assignee.matchedUserId ? { assigneeId: assignee.matchedUserId } : {}),
      ...(labelIds.value ? { labelIds: labelIds.value } : {}),
      ...(parentId.value !== undefined ? { parentId: parentId.value } : {}),
    },
  };
}

async function upsertLinearIssueForTicketSync(input: {
  readonly runtime: {
    readonly linear: Pick<LinearSyncClient, "createIssue" | "updateIssue">;
  };
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
      ...(input.fields.assigneeId
        ? { assigneeId: input.fields.assigneeId }
        : {}),
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
    ...(input.fields.assigneeId ? { assigneeId: input.fields.assigneeId } : {}),
    ...(input.fields.labelIds ? { labelIds: input.fields.labelIds } : {}),
    ...(input.fields.parentId !== undefined
      ? { parentId: input.fields.parentId }
      : {}),
  });
}

async function syncProjectFromLinearProjectsToTickets(input: {
  readonly runtime: SyncRuntime;
  readonly projectIds: readonly string[];
  readonly limit?: number;
  readonly syncToggles: SyncToggles;
}): Promise<
  | {
      readonly ok: true;
      readonly projectIds: readonly string[];
      readonly processed: number;
      readonly created: number;
      readonly updated: number;
      readonly commentsPulled: number;
      readonly conflictsRecorded: number;
      readonly checkpointsRecorded: number;
    }
  | { readonly ok: false; readonly error: string }
> {
  const limit = normalizePositiveInteger({
    value: input.limit,
    fallback: DEFAULT_PROJECT_SYNC_LIMIT,
  });

  const issuesResult = await collectLinearProjectIssuesForSync({
    runtime: input.runtime,
    projectIds: input.projectIds,
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
    projectIds: issuesResult.projectIds,
    processed: issuesResult.processed,
    created: upserted.created,
    updated: upserted.updated,
    commentsPulled: upserted.commentsPulled,
    conflictsRecorded: upserted.conflictsRecorded,
    checkpointsRecorded: upserted.checkpointsRecorded,
  };
}

function buildLinearAutosyncClaimedBy(): string {
  const user =
    readOptionalString(process.env.USER) ??
    readOptionalString(process.env.LOGNAME) ??
    "hack";
  const host = readOptionalString(hostname());
  return host ? `${user}@${host}` : user;
}

function hasActiveAutosyncSubscription(input: {
  readonly subscriptions: readonly LinearAutosyncSubscriptionSummary[];
  readonly projectId: string;
  readonly teamId?: string;
}): boolean {
  const normalizedTeamId = readOptionalString(input.teamId) ?? undefined;
  return input.subscriptions.some(
    (subscription) =>
      subscription.mode === "auto_apply" &&
      subscription.status === "active" &&
      subscription.projectId === input.projectId &&
      (subscription.teamId ?? undefined) === normalizedTeamId
  );
}

async function runProjectLinearAutosync<TRuntime>(input: {
  readonly binding: ResolvedLinearProjectBinding;
  readonly profileId?: string;
  readonly projectId?: string;
  readonly teamId?: string;
  readonly limit?: number;
  readonly syncToggles: SyncToggles;
  readonly deps: ProjectLinearAutosyncDeps<TRuntime>;
}): Promise<
  LinearAutosyncRunSuccess | { readonly ok: false; readonly error: string }
> {
  const targets = resolveProjectPullTargets({
    binding: input.binding,
    explicitProjectId: input.projectId,
  });
  if (targets.length === 0) {
    return {
      ok: false,
      error:
        "Missing project id. Pass --project-id, bind a default project, or add additional linked projects first.",
    };
  }

  let subscribedRoutes = 0;
  let processedDeliveries = 0;
  let appliedDeliveries = 0;
  const skippedDeliveries = 0;
  let failedDeliveries = 0;
  let created = 0;
  let updated = 0;
  let commentsPulled = 0;
  let conflictsRecorded = 0;
  let checkpointsRecorded = 0;
  const syncedProjectIds = new Set<string>();
  const deliveries: LinearAutosyncRunDeliveryOutcome[] = [];

  for (const target of targets) {
    const profileId =
      readOptionalString(input.profileId) ??
      readOptionalString(target.profileId) ??
      readOptionalString(input.binding.profileId);
    if (!profileId) {
      return {
        ok: false,
        error: `No Linear profile configured for project route ${target.projectId}.`,
      };
    }

    const effectiveTeamId =
      readOptionalString(input.teamId) ?? readOptionalString(target.teamId);
    const subscriptions = await input.deps.listSubscriptions({
      profileId,
      projectId: target.projectId,
      ...(effectiveTeamId ? { teamId: effectiveTeamId } : {}),
    });
    if (!subscriptions.ok) {
      return { ok: false, error: subscriptions.error };
    }
    if (
      !hasActiveAutosyncSubscription({
        subscriptions: subscriptions.data.subscriptions,
        projectId: target.projectId,
        ...(effectiveTeamId ? { teamId: effectiveTeamId } : {}),
      })
    ) {
      continue;
    }
    subscribedRoutes += 1;

    const listedDeliveries = await input.deps.listDeliveries({
      profileId,
      status: "pending",
      projectId: target.projectId,
      ...(effectiveTeamId ? { teamId: effectiveTeamId } : {}),
      ...(input.limit ? { limit: input.limit } : {}),
    });
    if (!listedDeliveries.ok) {
      return { ok: false, error: listedDeliveries.error };
    }
    if (listedDeliveries.data.deliveries.length === 0) {
      continue;
    }

    const runtime = await input.deps.createRuntime({ profileId });
    if (!runtime.ok) {
      return { ok: false, error: runtime.error };
    }

    const issueDeliveryGroups = new Map<string, LinearDeliverySummary[]>();
    const projectDeliveries: LinearDeliverySummary[] = [];
    for (const delivery of listedDeliveries.data.deliveries) {
      const issueIdentifier = readOptionalString(delivery.issueIdentifier);
      const issueId = readOptionalString(delivery.issueId);
      if (issueIdentifier || issueId) {
        const key = issueIdentifier
          ? `identifier:${issueIdentifier}`
          : `id:${issueId}`;
        const existing = issueDeliveryGroups.get(key) ?? [];
        existing.push(delivery);
        issueDeliveryGroups.set(key, existing);
        continue;
      }
      projectDeliveries.push(delivery);
    }

    for (const groupedDeliveries of issueDeliveryGroups.values()) {
      processedDeliveries += groupedDeliveries.length;
      const delivery = groupedDeliveries[0];
      if (!delivery) {
        continue;
      }
      const synced = await input.deps.syncIssue({
        runtime: runtime.value,
        delivery,
        syncToggles: input.syncToggles,
      });
      if (!synced.ok) {
        failedDeliveries += groupedDeliveries.length;
        deliveries.push(
          ...groupedDeliveries.map((groupedDelivery) => ({
            deliveryId: groupedDelivery.id,
            profileId,
            ...(groupedDelivery.projectId
              ? { projectId: groupedDelivery.projectId }
              : {}),
            ...(groupedDelivery.teamId
              ? { teamId: groupedDelivery.teamId }
              : {}),
            ...(groupedDelivery.issueId
              ? { issueId: groupedDelivery.issueId }
              : {}),
            ...(groupedDelivery.issueIdentifier
              ? { issueIdentifier: groupedDelivery.issueIdentifier }
              : {}),
            mode: "issue" as const,
            status: "failed" as const,
            reason: synced.error,
          }))
        );
        continue;
      }

      if (synced.operation === "created") {
        created += 1;
      } else {
        updated += 1;
      }
      commentsPulled += synced.commentsPulled;
      conflictsRecorded += synced.conflictsRecorded;
      checkpointsRecorded += synced.checkpointRecorded ? 1 : 0;
      syncedProjectIds.add(target.projectId);

      for (const groupedDelivery of groupedDeliveries) {
        const applied = await input.deps.applyDelivery({
          profileId,
          deliveryId: groupedDelivery.id,
          ...(input.deps.claimedBy ? { claimedBy: input.deps.claimedBy } : {}),
        });
        if (!applied.ok) {
          failedDeliveries += 1;
          deliveries.push({
            deliveryId: groupedDelivery.id,
            profileId,
            ...(groupedDelivery.projectId
              ? { projectId: groupedDelivery.projectId }
              : {}),
            ...(groupedDelivery.teamId
              ? { teamId: groupedDelivery.teamId }
              : {}),
            ...(groupedDelivery.issueId
              ? { issueId: groupedDelivery.issueId }
              : {}),
            ...(groupedDelivery.issueIdentifier
              ? { issueIdentifier: groupedDelivery.issueIdentifier }
              : {}),
            mode: "issue",
            status: "failed",
            ticketId: synced.ticketId,
            reason: applied.error,
          });
          continue;
        }
        appliedDeliveries += 1;
        deliveries.push({
          deliveryId: groupedDelivery.id,
          profileId,
          ...(groupedDelivery.projectId
            ? { projectId: groupedDelivery.projectId }
            : {}),
          ...(groupedDelivery.teamId ? { teamId: groupedDelivery.teamId } : {}),
          ...(groupedDelivery.issueId
            ? { issueId: groupedDelivery.issueId }
            : {}),
          ...(groupedDelivery.issueIdentifier
            ? { issueIdentifier: groupedDelivery.issueIdentifier }
            : {}),
          mode: "issue",
          status: "applied",
          ticketId: synced.ticketId,
        });
      }
    }

    if (projectDeliveries.length > 0) {
      processedDeliveries += projectDeliveries.length;
      const synced = await input.deps.syncProject({
        runtime: runtime.value,
        projectIds: [target.projectId],
        ...(input.limit ? { limit: input.limit } : {}),
        syncToggles: input.syncToggles,
      });
      if (synced.ok) {
        created += synced.created;
        updated += synced.updated;
        commentsPulled += synced.commentsPulled;
        conflictsRecorded += synced.conflictsRecorded;
        checkpointsRecorded += synced.checkpointsRecorded;
        for (const projectId of synced.projectIds) {
          syncedProjectIds.add(projectId);
        }
        for (const delivery of projectDeliveries) {
          const applied = await input.deps.applyDelivery({
            profileId,
            deliveryId: delivery.id,
            ...(input.deps.claimedBy
              ? { claimedBy: input.deps.claimedBy }
              : {}),
          });
          if (!applied.ok) {
            failedDeliveries += 1;
            deliveries.push({
              deliveryId: delivery.id,
              profileId,
              ...(delivery.projectId ? { projectId: delivery.projectId } : {}),
              ...(delivery.teamId ? { teamId: delivery.teamId } : {}),
              mode: "project",
              status: "failed",
              reason: applied.error,
            });
            continue;
          }
          appliedDeliveries += 1;
          deliveries.push({
            deliveryId: delivery.id,
            profileId,
            ...(delivery.projectId ? { projectId: delivery.projectId } : {}),
            ...(delivery.teamId ? { teamId: delivery.teamId } : {}),
            mode: "project",
            status: "applied",
          });
        }
      } else {
        failedDeliveries += projectDeliveries.length;
        deliveries.push(
          ...projectDeliveries.map((delivery) => ({
            deliveryId: delivery.id,
            profileId,
            ...(delivery.projectId ? { projectId: delivery.projectId } : {}),
            ...(delivery.teamId ? { teamId: delivery.teamId } : {}),
            mode: "project" as const,
            status: "failed" as const,
            reason: synced.error,
          }))
        );
      }
    }
  }

  return {
    ok: true,
    subscribedRoutes,
    processedDeliveries,
    appliedDeliveries,
    skippedDeliveries,
    failedDeliveries,
    created,
    updated,
    commentsPulled,
    conflictsRecorded,
    checkpointsRecorded,
    projectIds: [...syncedProjectIds],
    deliveries,
  };
}

async function collectLinearProjectIssuesForSync(input: {
  readonly runtime: SyncRuntime;
  readonly projectIds: readonly string[];
  readonly limit: number;
}): Promise<
  | {
      readonly ok: true;
      readonly projectIds: readonly string[];
      readonly issues: readonly LinearIssue[];
      readonly processed: number;
    }
  | { readonly ok: false; readonly error: string }
> {
  const normalizedProjectIds = [
    ...new Set(input.projectIds.map((value) => value.trim())),
  ].filter((value) => value.length > 0);
  const issuesById = new Map<string, LinearIssue>();

  for (const projectId of normalizedProjectIds) {
    let cursor: string | undefined;
    while (issuesById.size < input.limit) {
      const page = await input.runtime.linear.listProjectIssuesPage({
        projectId,
        first: Math.min(50, input.limit - issuesById.size),
        ...(cursor ? { after: cursor } : {}),
      });
      if (!page.ok) {
        return { ok: false, error: page.error };
      }

      for (const issue of page.data.issues) {
        issuesById.set(issue.id, issue);
        if (issuesById.size >= input.limit) {
          break;
        }
      }
      if (
        !(
          page.data.hasNextPage &&
          page.data.endCursor &&
          issuesById.size < input.limit
        )
      ) {
        break;
      }
      cursor = page.data.endCursor;
    }
    if (issuesById.size >= input.limit) {
      break;
    }
  }

  return {
    ok: true,
    projectIds: normalizedProjectIds,
    issues: [...issuesById.values()],
    processed: issuesById.size,
  };
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
  | {
      readonly ok: true;
      readonly created: number;
      readonly updated: number;
      readonly commentsPulled: number;
      readonly conflictsRecorded: number;
      readonly checkpointsRecorded: number;
    }
  | { readonly ok: false; readonly error: string }
> {
  let created = 0;
  let updated = 0;
  let commentsPulled = 0;
  let conflictsRecorded = 0;
  let checkpointsRecorded = 0;

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
    commentsPulled += synced.commentsPulled;
    conflictsRecorded += synced.conflictsRecorded;
    checkpointsRecorded += synced.checkpointRecorded ? 1 : 0;
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
    commentsPulled,
    conflictsRecorded,
    checkpointsRecorded,
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
      readonly commentsPushed: number;
      readonly conflictsRecorded: number;
      readonly checkpointsRecorded: number;
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
  let commentsPushed = 0;
  let conflictsRecorded = 0;
  let checkpointsRecorded = 0;

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
    commentsPushed += synced.commentsPushed;
    conflictsRecorded += synced.conflictsRecorded;
    checkpointsRecorded += synced.checkpointRecorded ? 1 : 0;
  }

  return {
    ok: true,
    processed: candidates.length,
    created,
    updated,
    commentsPushed,
    conflictsRecorded,
    checkpointsRecorded,
  };
}

async function upsertTicketFromLinearIssue(input: {
  readonly runtime: LinearToHackRuntime;
  readonly issue: LinearIssue;
  readonly syncToggles: SyncToggles;
  readonly dependencyIndex: {
    readonly byLinearId: Map<string, string>;
    readonly byLinearIdentifier: Map<string, string>;
  };
}): Promise<
  SyncTicketFromLinearSuccess | { readonly ok: false; readonly error: string }
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

  if (existing) {
    const authority = resolveTicketAuthority({ ticket: existing });
    const recordedConflicts = await recordAuthoritativeConflicts({
      tickets: input.runtime.tickets,
      ticketId: existing.ticketId,
      conflicts: detectAuthoritativeFieldConflicts({
        authority,
        ticket: existing,
        issue: input.issue,
        remoteProjection: projection,
      }),
    });
    if (!recordedConflicts.ok) {
      return { ok: false, error: recordedConflicts.error };
    }

    return await applyLinearIssueToExistingTicket({
      runtime: input.runtime,
      issue: input.issue,
      existingTicket: existing,
      projection,
      syncToggles: input.syncToggles,
      authority,
      conflictsRecorded: recordedConflicts.recorded,
    });
  }

  return await createTicketFromLinearIssueProjection({
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
  readonly runtime: LinearToHackRuntime;
  readonly issue: LinearIssue;
  readonly existingTicket: TicketSummary;
  readonly projection: TicketProjectionFromLinearIssue;
  readonly syncToggles: SyncToggles;
  readonly authority: "hack" | "linear" | "review_required";
  readonly conflictsRecorded: number;
}): Promise<
  SyncTicketFromLinearSuccess | { readonly ok: false; readonly error: string }
> {
  const resolvedAssignee = deriveTicketAssigneeFromLinearIssue({
    issue: input.issue,
  });
  const updated = await input.runtime.tickets.updateTicket({
    ticketId: input.existingTicket.ticketId,
    ...(input.authority === "linear" ? { title: input.issue.title } : {}),
    ...(input.authority === "linear" ? { body: input.projection.body } : {}),
    ...(input.authority === "linear" ? { owner: "linear" as const } : {}),
    ...(input.authority === "linear" ? { source: "linear" as const } : {}),
    ...(resolvedAssignee ? { assignee: resolvedAssignee } : {}),
    tags: input.projection.tags,
    ...(input.projection.dependsOn !== undefined
      ? { dependsOn: input.projection.dependsOn }
      : {}),
    ...projectRemoteLinkToCompatibilityFields({
      remote: {
        provider: "linear",
        remoteId: input.issue.id,
        remoteKey: input.issue.identifier,
        remoteUrl: input.issue.url,
        projectId: input.issue.projectId,
        projectName: input.issue.projectName,
        teamId: input.issue.teamId,
      },
    }),
  });
  if (!updated.ok) {
    return { ok: false, error: updated.error };
  }

  if (input.authority === "linear" && input.syncToggles.statuses) {
    const setStatus = await input.runtime.tickets.setStatus({
      ticketId: input.existingTicket.ticketId,
      status: input.projection.status,
    });
    if (!setStatus.ok) {
      return { ok: false, error: setStatus.error };
    }
  }

  const pulledComments = await pullLinearCommentsToTicket({
    runtime: input.runtime,
    ticketId: input.existingTicket.ticketId,
    issue: input.issue,
  });
  if (!pulledComments.ok) {
    return { ok: false, error: pulledComments.error };
  }

  const checkpoint = await recordLinearSyncCheckpoint({
    tickets: input.runtime.tickets,
    ticketId: input.existingTicket.ticketId,
    profileId: input.runtime.profileId,
    direction: "linear_to_hack",
    issue: input.issue,
  });
  if (!checkpoint.ok) {
    return { ok: false, error: checkpoint.error };
  }

  return {
    ok: true,
    operation: "updated",
    ticketId: input.existingTicket.ticketId,
    issueIdentifier: input.issue.identifier,
    commentsPulled: pulledComments.commentsPulled,
    conflictsRecorded: input.conflictsRecorded,
    checkpointRecorded: checkpoint.checkpointRecorded,
  };
}

async function createTicketFromLinearIssueProjection(input: {
  readonly runtime: LinearToHackRuntime;
  readonly issue: LinearIssue;
  readonly projection: TicketProjectionFromLinearIssue;
  readonly syncToggles: SyncToggles;
}): Promise<
  SyncTicketFromLinearSuccess | { readonly ok: false; readonly error: string }
> {
  const resolvedAssignee = deriveTicketAssigneeFromLinearIssue({
    issue: input.issue,
  });
  const created = await input.runtime.tickets.createTicket({
    title: input.issue.title,
    body: input.projection.body,
    owner: "linear",
    source: "linear",
    ...(resolvedAssignee ? { assignee: resolvedAssignee } : {}),
    tags: input.projection.tags,
    ...(input.projection.dependsOn !== undefined
      ? { dependsOn: input.projection.dependsOn }
      : {}),
    ...projectRemoteLinkToCompatibilityFields({
      remote: {
        provider: "linear",
        remoteId: input.issue.id,
        remoteKey: input.issue.identifier,
        remoteUrl: input.issue.url,
        projectId: input.issue.projectId,
        projectName: input.issue.projectName,
        teamId: input.issue.teamId,
      },
    }),
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

  const pulledComments = await pullLinearCommentsToTicket({
    runtime: input.runtime,
    ticketId: created.ticket.ticketId,
    issue: input.issue,
  });
  if (!pulledComments.ok) {
    return { ok: false, error: pulledComments.error };
  }

  const checkpoint = await recordLinearSyncCheckpoint({
    tickets: input.runtime.tickets,
    ticketId: created.ticket.ticketId,
    profileId: input.runtime.profileId,
    direction: "linear_to_hack",
    issue: input.issue,
  });
  if (!checkpoint.ok) {
    return { ok: false, error: checkpoint.error };
  }

  return {
    ok: true,
    operation: "created",
    ticketId: created.ticket.ticketId,
    issueIdentifier: input.issue.identifier,
    commentsPulled: pulledComments.commentsPulled,
    conflictsRecorded: 0,
    checkpointRecorded: checkpoint.checkpointRecorded,
  };
}

async function buildLinearDependencyIndex(input: {
  readonly tickets: Pick<TicketSyncStore, "listTickets">;
}): Promise<{
  readonly byLinearId: Map<string, string>;
  readonly byLinearIdentifier: Map<string, string>;
}> {
  const tickets = await input.tickets.listTickets();
  const byLinearId = new Map<string, string>();
  const byLinearIdentifier = new Map<string, string>();
  for (const ticket of tickets) {
    const linearRemote = findTicketRemoteLink({
      ticket,
      provider: "linear",
    });
    if (!linearRemote) {
      continue;
    }
    if (linearRemote.remoteId) {
      byLinearId.set(linearRemote.remoteId, ticket.ticketId);
    }
    if (linearRemote.remoteKey) {
      byLinearIdentifier.set(linearRemote.remoteKey, ticket.ticketId);
    }
  }
  return {
    byLinearId,
    byLinearIdentifier,
  };
}

async function resolveLinkedLinearIssue(input: {
  readonly runtime: {
    readonly linear: Pick<
      LinearSyncClient,
      "getIssueById" | "getIssueByIdentifier"
    >;
  };
  readonly ticket: TicketSummary;
}): Promise<
  | { readonly ok: true; readonly issue: LinearIssue | null }
  | { readonly ok: false; readonly error: string }
> {
  const linearRemote = findTicketRemoteLink({
    ticket: input.ticket,
    provider: "linear",
  });
  if (!linearRemote) {
    return { ok: true, issue: null };
  }
  if (linearRemote.remoteId) {
    const byId = await input.runtime.linear.getIssueById({
      issueId: linearRemote.remoteId,
    });
    if (!byId.ok) {
      return { ok: false, error: byId.error };
    }
    if (byId.data) {
      return { ok: true, issue: byId.data };
    }
  }
  if (linearRemote.remoteKey) {
    const byKey = await input.runtime.linear.getIssueByIdentifier({
      identifier: linearRemote.remoteKey,
    });
    if (!byKey.ok) {
      return { ok: false, error: byKey.error };
    }
    return { ok: true, issue: byKey.data };
  }
  return { ok: true, issue: null };
}

async function resolveLinearStateIdForTicketStatus(input: {
  readonly runtime: {
    readonly linear: Pick<LinearSyncClient, "listTeamStates">;
  };
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
  readonly runtime: {
    readonly linear: Pick<LinearSyncClient, "listTeamLabels">;
  };
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
  readonly runtime: {
    readonly tickets: Pick<TicketSyncStore, "getTicket">;
  };
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
  const linearRemote = findTicketRemoteLink({
    ticket: parentTicket,
    provider: "linear",
  });
  if (linearRemote?.remoteId) {
    return { ok: true, value: linearRemote.remoteId };
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
  const linearRemote = findTicketRemoteLink({
    ticket: input.ticket,
    provider: "linear",
  });
  if (!linearRemote) {
    return false;
  }
  if (linearRemote.remoteId && linearRemote.remoteId === input.issue.id) {
    return true;
  }
  if (
    linearRemote.remoteKey &&
    linearRemote.remoteKey === input.issue.identifier
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

type LinearProjectBindingTarget = {
  readonly projectId: string;
  readonly projectName?: string;
  readonly teamId?: string;
  readonly profileId?: string;
};

type ResolvedLinearProjectBinding = {
  readonly profileId?: string;
  readonly projectId?: string;
  readonly projectName?: string;
  readonly teamId?: string;
  readonly additionalProjects: readonly LinearProjectBindingTarget[];
};

function resolveProjectLinearBinding(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
}): ResolvedLinearProjectBinding {
  const overrides = input.controlPlaneConfig.routing?.overrides;
  if (!isRecord(overrides)) {
    return { additionalProjects: [] };
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
  const additionalProjects = parseAdditionalProjectBindings({
    value: nested?.additionalProjects,
    defaultProjectId: projectId,
    defaultProfileId: profileId,
  });

  return {
    ...(profileId ? { profileId } : {}),
    ...(projectId ? { projectId } : {}),
    ...(projectName ? { projectName } : {}),
    ...(teamId ? { teamId } : {}),
    additionalProjects,
  };
}

function parseAdditionalProjectBindings(input: {
  readonly value: unknown;
  readonly defaultProjectId?: string;
  readonly defaultProfileId?: string;
}): readonly LinearProjectBindingTarget[] {
  if (!Array.isArray(input.value)) {
    return [];
  }
  const targets: LinearProjectBindingTarget[] = [];
  for (const item of input.value) {
    if (!isRecord(item)) {
      continue;
    }
    const target = normalizeProjectBindingTarget({
      projectId: item.projectId,
      projectName: item.projectName,
      teamId: item.teamId,
      profileId: item.profileId ?? input.defaultProfileId,
    });
    if (!target) {
      continue;
    }
    if (
      input.defaultProjectId &&
      target.projectId.toLowerCase() === input.defaultProjectId.toLowerCase()
    ) {
      continue;
    }
    targets.push(target);
  }
  return dedupeProjectBindingTargets({ targets });
}

function normalizeProjectBindingTarget(input: {
  readonly projectId: unknown;
  readonly projectName?: unknown;
  readonly teamId?: unknown;
  readonly profileId?: unknown;
}): LinearProjectBindingTarget | null {
  const projectId = readOptionalString(input.projectId);
  if (!projectId) {
    return null;
  }
  const projectName = readOptionalString(input.projectName);
  const teamId = readOptionalString(input.teamId);
  const profileId = readOptionalString(input.profileId);
  return {
    projectId,
    ...(projectName ? { projectName } : {}),
    ...(teamId ? { teamId } : {}),
    ...(profileId ? { profileId } : {}),
  };
}

function dedupeProjectBindingTargets(input: {
  readonly targets: readonly LinearProjectBindingTarget[];
}): readonly LinearProjectBindingTarget[] {
  const byProjectId = new Map<string, LinearProjectBindingTarget>();
  for (const target of input.targets) {
    const key = `${(target.profileId ?? "").toLowerCase()}::${target.projectId.toLowerCase()}`;
    byProjectId.set(key, target);
  }
  return [...byProjectId.values()].sort((left, right) =>
    `${left.profileId ?? ""}:${left.projectId}`.localeCompare(
      `${right.profileId ?? ""}:${right.projectId}`
    )
  );
}

function upsertAdditionalProjectBinding(input: {
  readonly existing: readonly LinearProjectBindingTarget[];
  readonly target: LinearProjectBindingTarget;
  readonly defaultProjectId?: string;
}): readonly LinearProjectBindingTarget[] {
  if (
    input.defaultProjectId &&
    input.target.projectId.toLowerCase() ===
      input.defaultProjectId.toLowerCase()
  ) {
    return dedupeProjectBindingTargets({ targets: input.existing });
  }
  return dedupeProjectBindingTargets({
    targets: [...input.existing, input.target],
  });
}

function removeAdditionalProjectBinding(input: {
  readonly existing: readonly LinearProjectBindingTarget[];
  readonly projectId: string;
}): readonly LinearProjectBindingTarget[] {
  const normalizedProjectId = input.projectId.toLowerCase();
  return input.existing.filter(
    (target) => target.projectId.toLowerCase() !== normalizedProjectId
  );
}

function buildProjectBindingPayload(input: {
  readonly binding: ResolvedLinearProjectBinding;
  readonly cleared?: boolean;
  readonly additionalProjectChanged?: boolean;
  readonly removedProjectId?: string | null;
}): {
  readonly ok: true;
  readonly cleared?: boolean;
  readonly profileId: string | null;
  readonly projectId: string | null;
  readonly projectName: string | null;
  readonly teamId: string | null;
  readonly additionalProjects: readonly LinearProjectBindingTarget[];
  readonly additionalProjectChanged?: boolean;
  readonly removedProjectId?: string | null;
} {
  return {
    ok: true,
    ...(input.cleared ? { cleared: true } : {}),
    profileId: input.binding.profileId ?? null,
    projectId: input.binding.projectId ?? null,
    projectName: input.binding.projectName ?? null,
    teamId: input.binding.teamId ?? null,
    additionalProjects: input.binding.additionalProjects,
    ...(input.additionalProjectChanged !== undefined
      ? { additionalProjectChanged: input.additionalProjectChanged }
      : {}),
    ...(input.removedProjectId !== undefined
      ? { removedProjectId: input.removedProjectId }
      : {}),
  };
}

function resolveProjectPullTargets(input: {
  readonly binding: ResolvedLinearProjectBinding;
  readonly explicitProjectId?: string;
}): readonly LinearProjectBindingTarget[] {
  if (input.explicitProjectId) {
    const matchedTarget = findProjectBindingTarget({
      binding: input.binding,
      projectId: input.explicitProjectId,
    });
    return [
      matchedTarget ?? {
        projectId: input.explicitProjectId,
        ...(input.binding.profileId
          ? { profileId: input.binding.profileId }
          : {}),
      },
    ];
  }
  return [
    ...(input.binding.projectId
      ? [
          {
            projectId: input.binding.projectId,
            ...(input.binding.projectName
              ? { projectName: input.binding.projectName }
              : {}),
            ...(input.binding.teamId ? { teamId: input.binding.teamId } : {}),
            ...(input.binding.profileId
              ? { profileId: input.binding.profileId }
              : {}),
          },
        ]
      : []),
    ...input.binding.additionalProjects,
  ];
}

function findProjectBindingTarget(input: {
  readonly binding: ResolvedLinearProjectBinding;
  readonly projectId: string;
}): LinearProjectBindingTarget | null {
  const normalizedProjectId = input.projectId.toLowerCase();
  if (
    input.binding.projectId &&
    input.binding.projectId.toLowerCase() === normalizedProjectId
  ) {
    return {
      projectId: input.binding.projectId,
      ...(input.binding.projectName
        ? { projectName: input.binding.projectName }
        : {}),
      ...(input.binding.teamId ? { teamId: input.binding.teamId } : {}),
      ...(input.binding.profileId
        ? { profileId: input.binding.profileId }
        : {}),
    };
  }
  return (
    input.binding.additionalProjects.find(
      (target) => target.projectId.toLowerCase() === normalizedProjectId
    ) ?? null
  );
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
  readonly managementToken?: string;
  readonly managementTokenExpiresAt?: string;
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
  const resolved = await resolveLinearToken({
    controlPlaneConfig: input.controlPlaneConfig,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    allowProjectOverride: input.allowProjectOverride,
    refreshConfig: {
      baseUrl: brokerConfig.baseUrl,
    },
  });
  if (resolved.ok) {
    if (resolved.source === "refreshed") {
      await syncLinearLocalAccessToBroker({
        controlPlaneConfig: input.controlPlaneConfig,
        profileId: resolved.profileId,
      });
    }
    return resolved;
  }

  if (
    !shouldAttemptLinearBrokerLocalAccessSeed({
      error: resolved.error,
    })
  ) {
    return resolved;
  }

  const seeded = await seedLinearLocalAccessFromBroker({
    controlPlaneConfig: input.controlPlaneConfig,
    ...(input.profileId ? { profileId: input.profileId } : {}),
  });
  if (!seeded.ok) {
    return resolved;
  }

  return await resolveLinearToken({
    controlPlaneConfig: input.controlPlaneConfig,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    allowProjectOverride: input.allowProjectOverride,
    refreshConfig: {
      baseUrl: brokerConfig.baseUrl,
    },
  });
}

function shouldAttemptLinearBrokerLocalAccessSeed(input: {
  readonly error: string;
}): boolean {
  const error = input.error.trim();
  return (
    error.startsWith("Missing Linear token") ||
    error.includes("linear_local_access_unavailable") ||
    error.includes("linear_local_access_refresh_required")
  );
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
  readonly init?: RequestInit;
}): Promise<
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string }
> {
  try {
    const response = await fetch(input.url, {
      method: input.init?.method,
      headers: {
        accept: "application/json",
        "user-agent": "hack-cli",
        ...(input.init?.headers ?? {}),
      },
      body: input.init?.body,
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

async function listLinearConnections(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
  readonly profileId?: string;
  readonly organizationId?: string;
}): Promise<
  | { readonly ok: true; readonly data: BrokerListConnectionsPayload }
  | { readonly ok: false; readonly error: string }
> {
  const brokerAuth = await resolveLinearBrokerAuthorization({
    controlPlaneConfig: input.controlPlaneConfig,
    profileId: input.profileId,
  });
  if (!brokerAuth.ok) {
    return brokerAuth;
  }
  const brokerConfig = resolveOAuthBrokerRuntimeConfig({
    controlPlaneConfig: input.controlPlaneConfig,
  });
  const url = new URL(
    "/v1/auth/linear/connections",
    `${brokerConfig.baseUrl}/`
  );
  if (input.profileId) {
    url.searchParams.set("profileId", input.profileId);
  }
  if (input.organizationId) {
    url.searchParams.set("organizationId", input.organizationId);
  }
  const response = await fetchJson<unknown>({
    url: url.toString(),
    init: {
      headers: brokerAuth.headers,
    },
  });
  if (!response.ok) {
    return {
      ok: false,
      error: normalizeBrokerProtectedLinearError({
        error: response.error,
        profileId: brokerAuth.profileId,
      }),
    };
  }
  const payload = parseLinearConnectionsPayload({
    payload: response.value,
  });
  if (!payload) {
    return {
      ok: false,
      error: "Linear connection payload was invalid.",
    };
  }
  return { ok: true, data: payload };
}

async function seedLinearLocalAccessFromBroker(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
  readonly profileId?: string;
  readonly setDefault?: boolean;
}): Promise<
  | { readonly ok: true; readonly data: SeededLinearLocalAccessResult }
  | { readonly ok: false; readonly error: string }
> {
  const profileId = resolveSelectedLinearProfileId({
    controlPlaneConfig: input.controlPlaneConfig,
    profileId: input.profileId,
  });
  const brokerAuth = await resolveLinearBrokerAuthorization({
    controlPlaneConfig: input.controlPlaneConfig,
    profileId,
  });
  if (!brokerAuth.ok) {
    return brokerAuth;
  }
  const brokerConfig = resolveOAuthBrokerRuntimeConfig({
    controlPlaneConfig: input.controlPlaneConfig,
  });
  const response = await fetchJson<unknown>({
    url: new URL(
      "/v1/auth/linear/connections/seed",
      `${brokerConfig.baseUrl}/`
    ).toString(),
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...brokerAuth.headers,
      },
      body: JSON.stringify({
        profileId: brokerAuth.profileId,
      }),
    },
  });
  if (!response.ok) {
    return {
      ok: false,
      error: normalizeBrokerProtectedLinearError({
        error: response.error,
        profileId: brokerAuth.profileId,
      }),
    };
  }
  const payload = parseLinearSeedLocalAccessPayload({
    payload: response.value,
  });
  if (!payload) {
    return {
      ok: false,
      error: "Linear local access seed payload was invalid.",
    };
  }

  const settings = resolveLinearAuthSettings({
    controlPlaneConfig: input.controlPlaneConfig,
    profileId: payload.seed.profileId,
    allowProjectOverride: false,
  });
  await saveLinearToken({
    controlPlaneConfig: input.controlPlaneConfig,
    profileId: payload.seed.profileId,
    allowProjectOverride: false,
    token: payload.seed.token,
    ...(payload.seed.tokenExpiresAt
      ? { expiresAt: payload.seed.tokenExpiresAt }
      : {}),
    ...(payload.seed.refreshToken
      ? { refreshToken: payload.seed.refreshToken }
      : {}),
    ...(payload.seed.refreshTokenExpiresAt
      ? { refreshTokenExpiresAt: payload.seed.refreshTokenExpiresAt }
      : {}),
  });
  await persistLinearProfileDefaults({
    profileId: payload.seed.profileId,
    tokenEnv: settings.tokenEnv,
    authRef: settings.authRef,
    service: settings.service,
    apiUrl: settings.apiUrl,
    accountName: payload.seed.accountName ?? undefined,
    accountEmail: payload.seed.accountEmail ?? undefined,
    setAsDefault: input.setDefault ?? false,
  });

  return {
    ok: true,
    data: {
      profileId: payload.seed.profileId,
      accountName: payload.seed.accountName,
      accountEmail: payload.seed.accountEmail,
      refreshed: payload.seed.refreshed,
      setDefault: input.setDefault ?? false,
    },
  };
}

async function syncLinearLocalAccessToBroker(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
  readonly profileId: string;
}): Promise<void> {
  const stored = await readStoredLinearTokenEnvelope({
    controlPlaneConfig: input.controlPlaneConfig,
    profileId: input.profileId,
    allowProjectOverride: false,
  });
  if (!stored.envelope) {
    return;
  }
  const brokerAuth = await resolveLinearBrokerAuthorization({
    controlPlaneConfig: input.controlPlaneConfig,
    profileId: input.profileId,
  });
  if (!brokerAuth.ok) {
    return;
  }
  const brokerConfig = resolveOAuthBrokerRuntimeConfig({
    controlPlaneConfig: input.controlPlaneConfig,
  });
  await fetchJson<unknown>({
    url: new URL(
      "/v1/auth/linear/connections/update-local-access",
      `${brokerConfig.baseUrl}/`
    ).toString(),
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...brokerAuth.headers,
      },
      body: JSON.stringify({
        profileId: brokerAuth.profileId,
        token: stored.envelope.token,
        tokenExpiresAt: stored.envelope.expiresAt,
        refreshToken: stored.envelope.refreshToken,
        refreshTokenExpiresAt: stored.envelope.refreshTokenExpiresAt,
      }),
    },
  }).catch(() => null);
}

async function listLinearDeliveries(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
  readonly profileId?: string;
  readonly status?: LinearDeliveryStatus;
  readonly projectId?: string;
  readonly teamId?: string;
  readonly limit?: number;
}): Promise<
  | { readonly ok: true; readonly data: BrokerListDeliveriesPayload }
  | { readonly ok: false; readonly error: string }
> {
  const brokerAuth = await resolveLinearBrokerAuthorization({
    controlPlaneConfig: input.controlPlaneConfig,
    profileId: input.profileId,
  });
  if (!brokerAuth.ok) {
    return brokerAuth;
  }
  const brokerConfig = resolveOAuthBrokerRuntimeConfig({
    controlPlaneConfig: input.controlPlaneConfig,
  });
  const normalizedLimit = normalizePositiveInteger({
    value: input.limit,
    fallback: DEFAULT_DELIVERY_LIST_LIMIT,
  });
  const query = new URLSearchParams();
  if (input.status) {
    query.set("status", input.status);
  }
  if (input.projectId) {
    query.set("projectId", input.projectId);
  }
  if (input.teamId) {
    query.set("teamId", input.teamId);
  }
  if (normalizedLimit > 0) {
    query.set("limit", String(normalizedLimit));
  }

  const candidatePaths = [
    "/v1/linear/deliveries",
    "/v1/linear/webhook-deliveries",
    "/v1/auth/linear/deliveries",
  ];

  let lastError = "Unable to list Linear deliveries.";
  for (const path of candidatePaths) {
    const url = new URL(path, `${brokerConfig.baseUrl}/`);
    if (query.size > 0) {
      url.search = query.toString();
    }
    const response = await fetchJson<unknown>({
      url: url.toString(),
      init: {
        headers: brokerAuth.headers,
      },
    });
    if (!response.ok) {
      lastError = normalizeBrokerProtectedLinearError({
        error: response.error,
        profileId: brokerAuth.profileId,
      });
      if (
        shouldStopLinearBrokerPathFallback({
          error: response.error,
        })
      ) {
        return { ok: false, error: lastError };
      }
      continue;
    }

    const payload = parseLinearDeliveriesListPayload({
      payload: response.value,
      profileId: brokerAuth.profileId,
      requestedStatus: input.status,
      requestedLimit: normalizedLimit,
    });
    if (payload) {
      return { ok: true, data: payload };
    }
    lastError = "Linear delivery payload was invalid.";
  }

  return { ok: false, error: lastError };
}

async function applyLinearDelivery(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
  readonly profileId?: string;
  readonly deliveryId: string;
  readonly claimedBy?: string;
}): Promise<
  | { readonly ok: true; readonly data: BrokerApplyDeliveryPayload }
  | { readonly ok: false; readonly error: string }
> {
  const brokerAuth = await resolveLinearBrokerAuthorization({
    controlPlaneConfig: input.controlPlaneConfig,
    profileId: input.profileId,
  });
  if (!brokerAuth.ok) {
    return brokerAuth;
  }
  const brokerConfig = resolveOAuthBrokerRuntimeConfig({
    controlPlaneConfig: input.controlPlaneConfig,
  });
  const candidatePaths = [
    `/v1/linear/deliveries/${encodeURIComponent(input.deliveryId)}/apply`,
    `/v1/linear/webhook-deliveries/${encodeURIComponent(input.deliveryId)}/apply`,
    `/v1/auth/linear/deliveries/${encodeURIComponent(input.deliveryId)}/apply`,
  ];

  let lastError = "Unable to apply Linear delivery.";
  for (const path of candidatePaths) {
    const url = new URL(path, `${brokerConfig.baseUrl}/`);
    const response = await fetchJson<unknown>({
      url: url.toString(),
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...brokerAuth.headers,
        },
        ...(input.claimedBy
          ? {
              body: JSON.stringify({
                claimedBy: input.claimedBy,
              }),
            }
          : {}),
      },
    });
    if (!response.ok) {
      lastError = normalizeBrokerProtectedLinearError({
        error: response.error,
        profileId: brokerAuth.profileId,
      });
      if (
        shouldStopLinearBrokerPathFallback({
          error: response.error,
        })
      ) {
        return { ok: false, error: lastError };
      }
      continue;
    }
    const payload = parseLinearDeliveryApplyPayload({
      payload: response.value,
      profileId: brokerAuth.profileId,
      deliveryId: input.deliveryId,
    });
    if (payload) {
      return { ok: true, data: payload };
    }
    lastError = "Linear delivery apply payload was invalid.";
  }

  return { ok: false, error: lastError };
}

async function listLinearAutosyncSubscriptions(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
  readonly profileId: string;
  readonly projectId?: string;
  readonly teamId?: string;
}): Promise<
  | { readonly ok: true; readonly data: BrokerListAutosyncSubscriptionsPayload }
  | { readonly ok: false; readonly error: string }
> {
  const brokerAuth = await resolveLinearBrokerAuthorization({
    controlPlaneConfig: input.controlPlaneConfig,
    profileId: input.profileId,
  });
  if (!brokerAuth.ok) {
    return brokerAuth;
  }
  const brokerConfig = resolveOAuthBrokerRuntimeConfig({
    controlPlaneConfig: input.controlPlaneConfig,
  });
  const url = new URL(
    "/v1/auth/linear/subscriptions",
    `${brokerConfig.baseUrl}/`
  );
  if (input.projectId) {
    url.searchParams.set("projectId", input.projectId);
  }
  if (input.teamId) {
    url.searchParams.set("teamId", input.teamId);
  }
  const response = await fetchJson<unknown>({
    url: url.toString(),
    init: {
      headers: brokerAuth.headers,
    },
  });
  if (!response.ok) {
    return {
      ok: false,
      error: normalizeBrokerProtectedLinearError({
        error: response.error,
        profileId: brokerAuth.profileId,
      }),
    };
  }
  const payload = parseLinearAutosyncSubscriptionsPayload({
    payload: response.value,
    profileId: brokerAuth.profileId,
  });
  if (!payload) {
    return {
      ok: false,
      error: "Linear autosync subscriptions payload was invalid.",
    };
  }
  return { ok: true, data: payload };
}

async function upsertLinearAutosyncSubscription(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
  readonly profileId: string;
  readonly projectId?: string;
  readonly teamId?: string;
  readonly mode: LinearAutosyncMode;
  readonly status: LinearAutosyncStatus;
}): Promise<
  | {
      readonly ok: true;
      readonly data: BrokerAutosyncSubscriptionMutationPayload;
    }
  | { readonly ok: false; readonly error: string }
> {
  const brokerAuth = await resolveLinearBrokerAuthorization({
    controlPlaneConfig: input.controlPlaneConfig,
    profileId: input.profileId,
  });
  if (!brokerAuth.ok) {
    return brokerAuth;
  }
  const brokerConfig = resolveOAuthBrokerRuntimeConfig({
    controlPlaneConfig: input.controlPlaneConfig,
  });
  const response = await fetchJson<unknown>({
    url: new URL(
      "/v1/auth/linear/subscriptions",
      `${brokerConfig.baseUrl}/`
    ).toString(),
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...brokerAuth.headers,
      },
      body: JSON.stringify({
        profileId: brokerAuth.profileId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.teamId ? { teamId: input.teamId } : {}),
        mode: input.mode,
        status: input.status,
      }),
    },
  });
  if (!response.ok) {
    return {
      ok: false,
      error: normalizeBrokerProtectedLinearError({
        error: response.error,
        profileId: brokerAuth.profileId,
      }),
    };
  }
  const payload = parseLinearAutosyncSubscriptionMutationPayload({
    payload: response.value,
    profileId: brokerAuth.profileId,
  });
  if (!payload) {
    return {
      ok: false,
      error: "Linear autosync subscription payload was invalid.",
    };
  }
  return { ok: true, data: payload };
}

async function removeLinearAutosyncSubscription(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
  readonly profileId: string;
  readonly projectId?: string;
  readonly teamId?: string;
}): Promise<
  | {
      readonly ok: true;
      readonly data: BrokerAutosyncSubscriptionMutationPayload;
    }
  | { readonly ok: false; readonly error: string }
> {
  const brokerAuth = await resolveLinearBrokerAuthorization({
    controlPlaneConfig: input.controlPlaneConfig,
    profileId: input.profileId,
  });
  if (!brokerAuth.ok) {
    return brokerAuth;
  }
  const brokerConfig = resolveOAuthBrokerRuntimeConfig({
    controlPlaneConfig: input.controlPlaneConfig,
  });
  const response = await fetchJson<unknown>({
    url: new URL(
      "/v1/auth/linear/subscriptions/remove",
      `${brokerConfig.baseUrl}/`
    ).toString(),
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...brokerAuth.headers,
      },
      body: JSON.stringify({
        profileId: brokerAuth.profileId,
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.teamId ? { teamId: input.teamId } : {}),
      }),
    },
  });
  if (!response.ok) {
    return {
      ok: false,
      error: normalizeBrokerProtectedLinearError({
        error: response.error,
        profileId: brokerAuth.profileId,
      }),
    };
  }
  const payload = parseLinearAutosyncSubscriptionMutationPayload({
    payload: response.value,
    profileId: brokerAuth.profileId,
  });
  if (!payload) {
    return {
      ok: false,
      error: "Linear autosync subscription payload was invalid.",
    };
  }
  return { ok: true, data: payload };
}

async function resolveLinearBrokerAuthorization(input: {
  readonly controlPlaneConfig: ExtensionCommandContext["controlPlaneConfig"];
  readonly profileId?: string;
}): Promise<
  | {
      readonly ok: true;
      readonly profileId: string;
      readonly headers: Record<string, string>;
    }
  | { readonly ok: false; readonly error: string }
> {
  const profileId = resolveSelectedLinearProfileId({
    controlPlaneConfig: input.controlPlaneConfig,
    profileId: input.profileId,
  });
  const management = await resolveLinearBrokerManagementToken({
    controlPlaneConfig: input.controlPlaneConfig,
    profileId,
    allowProjectOverride: false,
  });
  if (!management.ok) {
    return {
      ok: false,
      error: management.error,
    };
  }
  return {
    ok: true,
    profileId,
    headers: {
      authorization: `Bearer ${management.managementToken}`,
    },
  };
}

function shouldStopLinearBrokerPathFallback(input: {
  readonly error: string;
}): boolean {
  return isLinearBrokerProtectedAuthError({
    error: input.error,
  });
}

function normalizeBrokerProtectedLinearError(input: {
  readonly error: string;
  readonly profileId: string;
}): string {
  const error = input.error.trim();
  if (!error) {
    return error;
  }
  if (error.includes("hack auth login")) {
    return error;
  }
  if (error === "better_auth_session_required") {
    return `Linear broker access for profile "${input.profileId}" requires Hack account login. Run \`hack auth login\` and retry.`;
  }
  if (
    error === "management_token_missing" ||
    error === "management_token_invalid" ||
    error === "management_token_expired"
  ) {
    return `Linear broker access for profile "${input.profileId}" needs a fresh Hack account session. Run \`hack auth login\` and retry.`;
  }
  if (error === "better_auth_profile_forbidden") {
    return `The current Hack account does not have access to Linear profile "${input.profileId}". Run \`hack auth login\` with the correct account, or choose a permitted profile.`;
  }
  return error;
}

function parseLinearConnectionsPayload(input: {
  readonly payload: unknown;
}): BrokerListConnectionsPayload | null {
  if (!isRecord(input.payload)) {
    return null;
  }
  if (!Array.isArray(input.payload.connections)) {
    return null;
  }
  const connections = input.payload.connections
    .map((value) => parseLinearConnectionSummary({ value }))
    .filter((value): value is LinearConnectionSummary => value !== null);
  return {
    ...(typeof input.payload.accessControlMode === "string"
      ? { accessControlMode: input.payload.accessControlMode }
      : {}),
    connections,
  };
}

function parseLinearSeedLocalAccessPayload(input: {
  readonly payload: unknown;
}): BrokerSeedLocalAccessPayload | null {
  if (!(isRecord(input.payload) && isRecord(input.payload.seed))) {
    return null;
  }
  const profileId = readOptionalString(input.payload.seed.profileId);
  const token = readOptionalString(input.payload.seed.token);
  if (!(profileId && token)) {
    return null;
  }
  return {
    seed: {
      profileId,
      accountName: readOptionalString(input.payload.seed.accountName) ?? null,
      accountEmail: readOptionalString(input.payload.seed.accountEmail) ?? null,
      token,
      ...(readOptionalString(input.payload.seed.tokenExpiresAt)
        ? {
            tokenExpiresAt: readOptionalString(
              input.payload.seed.tokenExpiresAt
            ),
          }
        : {}),
      ...(readOptionalString(input.payload.seed.refreshToken)
        ? { refreshToken: readOptionalString(input.payload.seed.refreshToken) }
        : {}),
      ...(readOptionalString(input.payload.seed.refreshTokenExpiresAt)
        ? {
            refreshTokenExpiresAt: readOptionalString(
              input.payload.seed.refreshTokenExpiresAt
            ),
          }
        : {}),
      refreshed: input.payload.seed.refreshed === true,
    },
  };
}

function parseLinearConnectionSummary(input: {
  readonly value: unknown;
}): LinearConnectionSummary | null {
  if (!isRecord(input.value)) {
    return null;
  }
  const id = readOptionalString(input.value.id);
  const createdAt = readOptionalString(input.value.createdAt);
  const updatedAt = readOptionalString(input.value.updatedAt);
  if (!(id && createdAt && updatedAt)) {
    return null;
  }
  return {
    id,
    profileId: readOptionalString(input.value.profileId) ?? null,
    accountId: readOptionalString(input.value.accountId) ?? null,
    accountName: readOptionalString(input.value.accountName) ?? null,
    accountEmail: readOptionalString(input.value.accountEmail) ?? null,
    authRef: readOptionalString(input.value.authRef) ?? null,
    betterAuthUserId: readOptionalString(input.value.betterAuthUserId) ?? null,
    betterAuthOrganizationId:
      readOptionalString(input.value.betterAuthOrganizationId) ?? null,
    betterAuthTeamId: readOptionalString(input.value.betterAuthTeamId) ?? null,
    organizationId: readOptionalString(input.value.organizationId) ?? null,
    teamId: readOptionalString(input.value.teamId) ?? null,
    localAccessAvailable: input.value.localAccessAvailable === true,
    metadata: isRecord(input.value.metadata)
      ? input.value.metadata
      : ({} as Record<string, unknown>),
    createdAt,
    updatedAt,
  };
}

function isLinearBrokerProtectedAuthError(input: {
  readonly error: string;
}): boolean {
  const error = input.error.trim();
  return (
    error === "better_auth_session_required" ||
    error === "better_auth_profile_forbidden" ||
    error === "management_token_missing" ||
    error === "management_token_invalid" ||
    error === "management_token_expired"
  );
}

function describeLinearConnectionOwner(input: LinearConnectionSummary): string {
  if (input.betterAuthTeamId) {
    return `team:${input.betterAuthTeamId}`;
  }
  if (input.betterAuthOrganizationId) {
    return `org:${input.betterAuthOrganizationId}`;
  }
  if (input.betterAuthUserId) {
    return `user:${input.betterAuthUserId}`;
  }
  return "legacy";
}

function parseLinearDeliveriesListPayload(input: {
  readonly payload: unknown;
  readonly profileId?: string;
  readonly requestedStatus?: LinearDeliveryStatus;
  readonly requestedLimit: number;
}): BrokerListDeliveriesPayload | null {
  if (!isRecord(input.payload)) {
    return null;
  }
  let deliveriesRaw: unknown[] | null = null;
  if (Array.isArray(input.payload.deliveries)) {
    deliveriesRaw = input.payload.deliveries;
  } else if (Array.isArray(input.payload.items)) {
    deliveriesRaw = input.payload.items;
  }
  if (!deliveriesRaw) {
    return null;
  }
  const deliveries = deliveriesRaw
    .map((value) => parseLinearDeliverySummary({ value }))
    .filter((value): value is LinearDeliverySummary => value !== null)
    .slice(0, input.requestedLimit);
  return {
    ...(input.profileId ? { profileId: input.profileId } : {}),
    status:
      readOptionalString(input.payload.status) ??
      input.requestedStatus ??
      undefined,
    limit:
      typeof input.payload.limit === "number" &&
      Number.isFinite(input.payload.limit)
        ? input.payload.limit
        : input.requestedLimit,
    deliveries,
  };
}

function parseLinearDeliverySummary(input: {
  readonly value: unknown;
}): LinearDeliverySummary | null {
  if (!isRecord(input.value)) {
    return null;
  }
  const id = readOptionalString(input.value.id);
  const status = readOptionalString(input.value.status);
  if (!(id && status)) {
    return null;
  }
  return {
    id,
    status,
    ...(readOptionalString(input.value.profileId)
      ? { profileId: readOptionalString(input.value.profileId) }
      : {}),
    ...(readOptionalString(input.value.projectId)
      ? { projectId: readOptionalString(input.value.projectId) }
      : {}),
    ...(readOptionalString(input.value.teamId)
      ? { teamId: readOptionalString(input.value.teamId) }
      : {}),
    ...(readOptionalString(input.value.issueId)
      ? { issueId: readOptionalString(input.value.issueId) }
      : {}),
    ...(readOptionalString(input.value.issueIdentifier)
      ? { issueIdentifier: readOptionalString(input.value.issueIdentifier) }
      : {}),
    ...(readOptionalString(input.value.claimedBy)
      ? { claimedBy: readOptionalString(input.value.claimedBy) }
      : {}),
    ...(readOptionalString(input.value.eventType)
      ? { eventType: readOptionalString(input.value.eventType) }
      : {}),
    ...(readOptionalString(input.value.action)
      ? { action: readOptionalString(input.value.action) }
      : {}),
    ...(readOptionalString(input.value.receivedAt)
      ? { receivedAt: readOptionalString(input.value.receivedAt) }
      : {}),
    ...(readOptionalString(input.value.updatedAt)
      ? { updatedAt: readOptionalString(input.value.updatedAt) }
      : {}),
    ...(input.value.payload !== undefined
      ? { payload: input.value.payload }
      : {}),
  };
}

function parseLinearDeliveryApplyPayload(input: {
  readonly payload: unknown;
  readonly profileId?: string;
  readonly deliveryId: string;
}): BrokerApplyDeliveryPayload | null {
  if (!isRecord(input.payload)) {
    return null;
  }
  const deliveryRecord = isRecord(input.payload.delivery)
    ? input.payload.delivery
    : input.payload;
  const deliveryId =
    readOptionalString(input.payload.deliveryId) ??
    readOptionalString(deliveryRecord.deliveryId) ??
    readOptionalString(deliveryRecord.id) ??
    input.deliveryId;
  const status =
    readOptionalString(input.payload.status) ??
    readOptionalString(deliveryRecord.status);
  if (!status) {
    return null;
  }
  return {
    ...(input.profileId ? { profileId: input.profileId } : {}),
    deliveryId,
    status,
  };
}

function parseLinearAutosyncSubscriptionsPayload(input: {
  readonly payload: unknown;
  readonly profileId: string;
}): BrokerListAutosyncSubscriptionsPayload | null {
  if (
    !(isRecord(input.payload) && Array.isArray(input.payload.subscriptions))
  ) {
    return null;
  }
  const subscriptions = input.payload.subscriptions
    .map((value) => parseLinearAutosyncSubscriptionSummary({ value }))
    .filter(
      (value): value is LinearAutosyncSubscriptionSummary => value !== null
    );
  return {
    profileId: input.profileId,
    subscriptions,
  };
}

function parseLinearAutosyncSubscriptionMutationPayload(input: {
  readonly payload: unknown;
  readonly profileId: string;
}): BrokerAutosyncSubscriptionMutationPayload | null {
  if (!isRecord(input.payload)) {
    return null;
  }
  const subscription = parseLinearAutosyncSubscriptionSummary({
    value: input.payload.subscription,
  });
  if (!subscription) {
    return null;
  }
  return {
    profileId: input.profileId,
    subscription,
  };
}

function parseLinearAutosyncSubscriptionSummary(input: {
  readonly value: unknown;
}): LinearAutosyncSubscriptionSummary | null {
  if (!isRecord(input.value)) {
    return null;
  }
  const id = readOptionalString(input.value.id);
  const profileId = readOptionalString(input.value.profileId);
  const mode = readOptionalString(input.value.mode);
  const status = readOptionalString(input.value.status);
  if (!(id && profileId && (mode === "manual" || mode === "auto_apply"))) {
    return null;
  }
  if (!(status === "active" || status === "paused")) {
    return null;
  }
  const projectId = readOptionalString(input.value.projectId) ?? undefined;
  const teamId = readOptionalString(input.value.teamId) ?? undefined;
  const updatedAt = readOptionalString(input.value.updatedAt) ?? undefined;
  return {
    id,
    profileId,
    ...(projectId ? { projectId } : {}),
    ...(teamId ? { teamId } : {}),
    mode,
    status,
    ...(updatedAt ? { updatedAt } : {}),
  };
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
  startOnly: boolean;
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
  desktopRedirectUrl?: string;
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

type ConnectionsArgs = {
  profileId?: string;
  organizationId?: string;
  json: boolean;
};

type SeedLocalAccessArgs = {
  profileId?: string;
  setDefault: boolean;
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

type ProjectLinkArgs = {
  profileId?: string;
  projectId?: string;
  projectName?: string;
  teamId?: string;
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

function parseDeliveriesArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: DeliveriesArgs }
  | { readonly ok: false; readonly error: string } {
  const value: DeliveriesArgs = {
    status: "pending",
    json: false,
  };

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
        status: "status",
      },
    });
    if (!handled.ok) {
      return { ok: false, error: handled.error };
    }
    i = handled.nextIndex;
  }

  if (
    !(
      value.status === "pending" ||
      value.status === "applied" ||
      value.status === "ignored"
    )
  ) {
    return {
      ok: false,
      error: `Invalid --status value: ${String(value.status)}. Expected pending|applied|ignored.`,
    };
  }

  return { ok: true, value };
}

function parseApplyDeliveryArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: ApplyDeliveryArgs }
  | { readonly ok: false; readonly error: string } {
  const value: Partial<ApplyDeliveryArgs> & { json: boolean } = {
    json: false,
  };

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
        "delivery-id": "deliveryId",
      },
    });
    if (!handled.ok) {
      return { ok: false, error: handled.error };
    }
    i = handled.nextIndex;
  }

  if (!value.deliveryId) {
    return {
      ok: false,
      error: "Missing --delivery-id <ID>.",
    };
  }

  return {
    ok: true,
    value: {
      deliveryId: value.deliveryId,
      json: value.json,
    },
  };
}

function parseAutosyncSubscriptionsArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: AutosyncSubscriptionsArgs }
  | { readonly ok: false; readonly error: string } {
  const value: AutosyncSubscriptionsArgs = { json: false };
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

function parseUpsertAutosyncSubscriptionArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: UpsertAutosyncSubscriptionArgs }
  | { readonly ok: false; readonly error: string } {
  const value: UpsertAutosyncSubscriptionArgs = {
    mode: "auto_apply",
    status: "active",
    json: false,
  };
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
        "team-id": "teamId",
        mode: "mode",
        status: "status",
      },
    });
    if (!handled.ok) {
      return { ok: false, error: handled.error };
    }
    i = handled.nextIndex;
  }
  if (!(value.mode === "manual" || value.mode === "auto_apply")) {
    return {
      ok: false,
      error: `Invalid --mode value: ${String(value.mode)}. Expected manual|auto_apply.`,
    };
  }
  if (!(value.status === "active" || value.status === "paused")) {
    return {
      ok: false,
      error: `Invalid --status value: ${String(value.status)}. Expected active|paused.`,
    };
  }
  return { ok: true, value };
}

function parseRemoveAutosyncSubscriptionArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: RemoveAutosyncSubscriptionArgs }
  | { readonly ok: false; readonly error: string } {
  const value: RemoveAutosyncSubscriptionArgs = { json: false };
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

function parseAssigneeMappingsArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: AssigneeMappingsArgs }
  | { readonly ok: false; readonly error: string } {
  const value: AssigneeMappingsArgs = { json: false };
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

function parseUpsertAssigneeMappingArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: UpsertAssigneeMappingArgs }
  | { readonly ok: false; readonly error: string } {
  const value: UpsertAssigneeMappingArgs = { json: false };
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
        "team-id": "teamId",
        "local-assignee": "localAssignee",
        "linear-user-id": "linearUserId",
        "linear-user-name": "linearUserName",
        "linear-user-email": "linearUserEmail",
      },
    });
    if (!handled.ok) {
      return { ok: false, error: handled.error };
    }
    i = handled.nextIndex;
  }

  if (!readOptionalString(value.localAssignee)) {
    return {
      ok: false,
      error: "Missing --local-assignee <value>.",
    };
  }
  if (
    !(
      readOptionalString(value.linearUserId) ||
      readOptionalString(value.linearUserName) ||
      readOptionalString(value.linearUserEmail)
    )
  ) {
    return {
      ok: false,
      error:
        "Missing Linear user target. Pass --linear-user-id, --linear-user-name, or --linear-user-email.",
    };
  }

  return { ok: true, value };
}

function parseRemoveAssigneeMappingArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: RemoveAssigneeMappingArgs }
  | { readonly ok: false; readonly error: string } {
  const value: RemoveAssigneeMappingArgs = { json: false };
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
        "team-id": "teamId",
        "local-assignee": "localAssignee",
      },
    });
    if (!handled.ok) {
      return { ok: false, error: handled.error };
    }
    i = handled.nextIndex;
  }

  if (!readOptionalString(value.localAssignee)) {
    return {
      ok: false,
      error: "Missing --local-assignee <value>.",
    };
  }

  return { ok: true, value };
}

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
    startOnly: false,
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
    if (token === "--start-only") {
      value.startOnly = true;
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
        "desktop-redirect-url": "desktopRedirectUrl",
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

function parseConnectionsArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: ConnectionsArgs }
  | { readonly ok: false; readonly error: string } {
  const value: ConnectionsArgs = { json: false };
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
        "organization-id": "organizationId",
      },
    });
    if (!handled.ok) {
      return { ok: false, error: handled.error };
    }
    i = handled.nextIndex;
  }
  return { ok: true, value };
}

function parseSeedLocalAccessArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: SeedLocalAccessArgs }
  | { readonly ok: false; readonly error: string } {
  const value: SeedLocalAccessArgs = {
    setDefault: false,
    json: false,
  };
  for (let i = 0; i < input.args.length; i += 1) {
    const token = input.args[i] ?? "";
    if (token === "--set-default") {
      value.setDefault = true;
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
      },
    });
    if (!handled.ok) {
      return { ok: false, error: handled.error };
    }
    i = handled.nextIndex;
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

function parseProjectLinkArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: ProjectLinkArgs }
  | { readonly ok: false; readonly error: string } {
  const value: ProjectLinkArgs = {
    json: false,
  };
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

function parseRunAutosyncArgs(input: {
  readonly args: readonly string[];
}):
  | { readonly ok: true; readonly value: RunAutosyncArgs }
  | { readonly ok: false; readonly error: string } {
  const value: RunAutosyncArgs = {
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
  detectAuthoritativeFieldConflicts,
  findProjectBindingTarget,
  normalizeBrokerProtectedLinearError,
  parseApplyDeliveryArgs,
  parseAutosyncSubscriptionsArgs,
  parseAssigneeMappingsArgs,
  parseConnectArgs,
  parseConnectionsArgs,
  parseDeliveriesArgs,
  parseOAuthConnectArgs,
  parseSeedLocalAccessArgs,
  parseRunAutosyncArgs,
  parseProjectBindArgs,
  parseProjectLinkArgs,
  parseProjectsArgs,
  parseRemoveAssigneeMappingArgs,
  parseRemoveAutosyncSubscriptionArgs,
  resolveProjectLinearBinding,
  resolveProjectPullTargets,
  resolveOAuthBrokerRuntimeConfig,
  resolveTicketAssigneeForLinear,
  parseSetupArgs,
  parseStatusArgs,
  parseSyncIssueArgs,
  parseSyncProjectArgs,
  parseUpsertAssigneeMappingArgs,
  parseUpsertAutosyncSubscriptionArgs,
  selectLinearCommentsToAppend,
  selectTicketCommentsToPush,
  shouldFallbackConnectToOAuth,
  shouldUseBrokerOAuthFlow,
  runProjectLinearAutosync,
  syncIssueFromLinearToTicket,
  syncTicketToLinearIssue,
} as const;
