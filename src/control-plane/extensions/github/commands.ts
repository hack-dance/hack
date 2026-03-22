import { isCancel, select } from "@clack/prompts";
import { secrets } from "bun";

import { updateGlobalConfig } from "../../../lib/config.ts";
import { isRecord } from "../../../lib/guards.ts";
import { exec, findExecutableInPath, run } from "../../../lib/shell.ts";
import { display } from "../../../ui/display.ts";
import type { ExtensionCommand } from "../types.ts";
import {
  deleteGitHubAppToken,
  exchangeGitHubAppInstallationToken,
  type GitHubAuthMode,
  listGitHubAuthProfiles,
  resolveGitHubAppToken,
  resolveGitHubAuthSettings,
  resolveGitHubAuthSettingsResult,
  saveGitHubAppToken,
} from "./auth.ts";
import {
  createGitHubAppClient,
  type GitHubRepoRef,
  parseGitHubRepoRef,
} from "./client.ts";

const EXTENSION_ID = "dance.hack.github";
const DIRECT_REPO_PATTERN = /^([^/\s]+)\/([^/\s]+)$/;
const DEFAULT_OAUTH_SCOPES = "repo,read:org";
const DEFAULT_GITHUB_HOSTNAME = "github.com";
const TRAILING_SLASH_PATTERN = /\/+$/;

type GitHubInstallationSummary = {
  readonly id: string;
  readonly accountLogin: string;
  readonly appSlug?: string;
};

type GitHubIdentityResult =
  | {
      readonly ok: true;
      readonly login: string;
      readonly accountId?: string;
      readonly accountName?: string;
      readonly installations: readonly GitHubInstallationSummary[];
      readonly installationWarning?: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

type GitHubAccountSnapshot = {
  readonly accountLogin?: string;
  readonly accountName?: string;
  readonly accountId?: string;
};

type GitHubStatusPayload = {
  readonly extensionId: string;
  readonly selectedProfile: string;
  readonly selectedSource: string;
  readonly defaultProfile: string;
  readonly authRef: string;
  readonly service: string;
  readonly tokenEnvFallback: string;
  readonly mode: string;
  readonly appId?: string;
  readonly installationId?: string;
  readonly privateKeyEnv: string;
  readonly privateKeyAuthRef?: string;
  readonly apiBaseUrl: string;
  readonly accountLogin?: string;
  readonly accountName?: string;
  readonly accountId?: string;
  readonly tokenResolved: boolean;
  readonly tokenSource?: string;
  readonly tokenExpiresAt?: string;
  readonly profileError?: string;
  readonly error?: string;
};

type GitHubProfilesPayload = {
  readonly selectedProfile: string;
  readonly selectedSource: string;
  readonly defaultProfile: string;
  readonly projectOverride?: string;
  readonly selectedMissing: boolean;
  readonly profiles: readonly {
    readonly id: string;
    readonly isDefault: boolean;
    readonly mode: string;
    readonly authRef: string;
    readonly service: string;
    readonly appId?: string;
    readonly installationId?: string;
    readonly accountLogin?: string;
    readonly accountName?: string;
    readonly accountId?: string;
  }[];
};

export const GITHUB_COMMANDS: readonly ExtensionCommand[] = [
  {
    name: "connect",
    summary:
      "Connect GitHub for PR automation or remote repo bootstrap (token or App)",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const parsed = parseConnectArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const defaults = resolveGitHubAuthSettings({
        controlPlaneConfig: ctx.controlPlaneConfig,
        ...(parsed.value.profile ? { profileId: parsed.value.profile } : {}),
        allowProjectOverride: false,
      });
      const resolved = resolveConnectDefaults({
        parsedValue: parsed.value,
        defaults,
      });
      const tokenResult = await resolveConnectTokenResult({
        parsedValue: parsed.value,
        resolved,
      });
      if (!tokenResult.ok) {
        ctx.logger.error({ message: tokenResult.error });
        return 1;
      }
      const accountSnapshot = await resolveGitHubAccountSnapshotFromToken({
        token: tokenResult.token,
        apiBaseUrl: resolved.apiBaseUrl,
      });

      await saveGitHubAppToken({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId: resolved.profileId,
        allowProjectOverride: false,
        token: tokenResult.token,
        ...(tokenResult.expiresAt ? { expiresAt: tokenResult.expiresAt } : {}),
        authRef: resolved.authRef,
        service: resolved.service,
      });

      const setAsDefault = shouldSetProfileAsDefault({
        controlPlaneConfig: ctx.controlPlaneConfig,
        profileId: resolved.profileId,
        setDefaultFlag: parsed.value.setDefault,
      });
      await persistGitHubProfileDefaults({
        profileId: resolved.profileId,
        tokenEnv: resolved.tokenEnv,
        authRef: resolved.authRef,
        service: resolved.service,
        appId: resolved.appId,
        installationId: resolved.installationId,
        privateKeyEnv: resolved.privateKeyEnv,
        privateKeyAuthRef:
          tokenResult.privateKeyAuthRef ?? resolved.privateKeyAuthRef,
        apiBaseUrl: resolved.apiBaseUrl,
        mode: resolved.appModeRequested ? "app" : "token",
        accountLogin: accountSnapshot.accountLogin,
        accountName: accountSnapshot.accountName,
        accountId: accountSnapshot.accountId,
        setAsDefault,
      });

      await display.kv({
        title: "GitHub auth connected",
        entries: buildConnectSummaryEntries({
          resolved,
          tokenResult,
          accountSnapshot,
          setAsDefault,
        }),
      });
      return 0;
    },
  },
  {
    name: "oauth-connect",
    summary:
      "Connect GitHub in a browser and import a profile for Hack workflows",
    scope: "global",
    handler: async ({ ctx, args }) =>
      await handleGitHubOAuthConnectCommand({
        controlPlaneConfig: ctx.controlPlaneConfig,
        logger: ctx.logger,
        args,
      }),
  },
  {
    name: "disconnect",
    summary: "Remove stored GitHub token from keychain",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const parsed = parseDisconnectArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const deleted = await deleteGitHubAppToken({
        controlPlaneConfig: ctx.controlPlaneConfig,
        ...(parsed.value.profileId
          ? { profileId: parsed.value.profileId }
          : {}),
        allowProjectOverride: false,
        ...(parsed.value.authRef ? { authRef: parsed.value.authRef } : {}),
        ...(parsed.value.service ? { service: parsed.value.service } : {}),
      });

      await display.kv({
        title: "GitHub auth disconnected",
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
    summary: "Show GitHub profile/config status",
    scope: "global",
    handler: async ({ ctx, args }) =>
      await handleGitHubStatusCommand({
        controlPlaneConfig: ctx.controlPlaneConfig,
        logger: ctx.logger,
        args,
      }),
  },
  {
    name: "profiles",
    summary: "List configured GitHub auth profiles",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const parsed = parseProfilesArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }
      const catalog = listGitHubAuthProfiles({
        controlPlaneConfig: ctx.controlPlaneConfig,
        allowProjectOverride: true,
      });
      const payload = buildGitHubProfilesPayload({ catalog });
      if (parsed.value.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      } else {
        await display.kv({
          title: "GitHub profile selection",
          entries: [
            ["selected_profile", catalog.selectedProfileId],
            ["selected_source", catalog.selectedProfileSource],
            ["default_profile", catalog.defaultProfileId],
            ["project_override", catalog.projectProfileOverride ?? ""],
            ["selected_missing", catalog.selectedProfileMissing ? "yes" : "no"],
          ],
        });
        await renderGitHubProfilesTable({ catalog });
      }
      return catalog.selectedProfileMissing ? 1 : 0;
    },
  },
  {
    name: "use",
    summary: "Set global default GitHub profile",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const parsed = parseProfileUseArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const settings = resolveGitHubAuthSettingsResult({
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
        title: "GitHub default profile updated",
        entries: [["profile", parsed.value.profileId]],
      });
      return 0;
    },
  },
  {
    name: "pr-upsert",
    summary: "Create or update a pull request via selected GitHub profile",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const parsed = parsePrUpsertArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const token = await resolveGitHubAppToken({
        controlPlaneConfig: ctx.controlPlaneConfig,
        ...(parsed.value.profileId
          ? { profileId: parsed.value.profileId }
          : {}),
        allowProjectOverride: !parsed.value.profileId,
      });
      if (!token.ok) {
        ctx.logger.error({
          message: token.error,
        });
        return 1;
      }

      const client = createGitHubAppClient({
        token: token.token,
        userAgent: "hack-cli",
      });
      const found = await client.findOpenPullRequest({
        repo: parsed.value.repo,
        headRef: parsed.value.headRef,
      });
      if (!found.ok) {
        ctx.logger.error({
          message: `GitHub lookup failed (${found.status}): ${found.error}`,
        });
        return 1;
      }

      const upserted = found.data
        ? await client.updatePullRequest({
            repo: parsed.value.repo,
            number: found.data.number,
            title: parsed.value.title,
            body: parsed.value.body,
          })
        : await client.createPullRequest({
            repo: parsed.value.repo,
            title: parsed.value.title,
            body: parsed.value.body,
            headRef: parsed.value.headRef,
            baseRef: parsed.value.baseRef,
          });
      if (!upserted.ok) {
        ctx.logger.error({
          message: `GitHub PR upsert failed (${upserted.status}): ${upserted.error}`,
        });
        return 1;
      }

      if (parsed.value.comment) {
        const commented = await client.createIssueComment({
          repo: parsed.value.repo,
          issueNumber: upserted.data.number,
          body: parsed.value.comment,
        });
        if (!commented.ok) {
          ctx.logger.warn({
            message: `PR created/updated, but comment failed (${commented.status}): ${commented.error}`,
          });
        }
      }

      await display.kv({
        title: "Pull request upserted",
        entries: [
          ["repo", `${parsed.value.repo.owner}/${parsed.value.repo.repo}`],
          ["profile", token.profileId],
          ["profile_source", token.profileSource],
          ["number", String(upserted.data.number)],
          ["state", upserted.data.state],
          ["head", upserted.data.headRef],
          ["base", upserted.data.baseRef],
          ["url", upserted.data.htmlUrl],
        ],
      });
      return 0;
    },
  },
];

type ConnectParseResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly profile?: string;
        readonly setDefault: boolean;
        readonly token?: string;
        readonly tokenEnv?: string;
        readonly authRef?: string;
        readonly service?: string;
        readonly appId?: string;
        readonly installationId?: string;
        readonly privateKey?: string;
        readonly privateKeyEnv?: string;
        readonly privateKeyAuthRef?: string;
        readonly apiBaseUrl?: string;
        readonly stdin: boolean;
        readonly privateKeyStdin: boolean;
      };
    }
  | { readonly ok: false; readonly error: string };

type ConnectParsedValue = Extract<
  ConnectParseResult,
  { readonly ok: true }
>["value"];
type MutableConnectParsedValues = {
  -readonly [K in keyof Omit<
    ConnectParsedValue,
    "stdin" | "privateKeyStdin" | "setDefault"
  >]?: Omit<ConnectParsedValue, "stdin" | "privateKeyStdin" | "setDefault">[K];
};

type ConnectResolvedDefaults = {
  readonly profileId: string;
  readonly tokenEnv: string;
  readonly authRef: string;
  readonly service: string;
  readonly appId?: string;
  readonly installationId?: string;
  readonly privateKeyEnv: string;
  readonly privateKeyAuthRef?: string;
  readonly apiBaseUrl: string;
  readonly appModeRequested: boolean;
};

type ConnectTokenResult =
  | {
      readonly ok: true;
      readonly token: string;
      readonly expiresAt?: string;
      readonly privateKeyAuthRef?: string;
    }
  | { readonly ok: false; readonly error: string };

type OAuthConnectParseResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly profile?: string;
        readonly setDefault: boolean;
        readonly scopes?: string;
        readonly hostname?: string;
        readonly ghPath?: string;
        readonly installationId?: string;
        readonly appId?: string;
        readonly tokenEnv?: string;
        readonly authRef?: string;
        readonly service?: string;
        readonly apiBaseUrl?: string;
      };
    }
  | { readonly ok: false; readonly error: string };

type OAuthConnectValue = Extract<
  OAuthConnectParseResult,
  { readonly ok: true }
>["value"];

type MutableOAuthConnectValues = {
  -readonly [K in keyof Omit<OAuthConnectValue, "setDefault">]?: Omit<
    OAuthConnectValue,
    "setDefault"
  >[K];
};

type GitHubCommandLogger = {
  readonly error: (input: { readonly message: string }) => void;
};

type DisconnectParseResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly profileId?: string;
        readonly authRef?: string;
        readonly service?: string;
      };
    }
  | { readonly ok: false; readonly error: string };

type StatusParseResult =
  | {
      readonly ok: true;
      readonly value: { readonly profileId?: string; readonly json: boolean };
    }
  | { readonly ok: false; readonly error: string };

type ProfileUseParseResult =
  | { readonly ok: true; readonly value: { readonly profileId: string } }
  | { readonly ok: false; readonly error: string };

type ProfilesParseResult =
  | { readonly ok: true; readonly value: { readonly json: boolean } }
  | { readonly ok: false; readonly error: string };

type PrUpsertParseResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly profileId?: string;
        readonly repo: GitHubRepoRef;
        readonly headRef: string;
        readonly baseRef: string;
        readonly title: string;
        readonly body: string;
        readonly comment?: string;
      };
    }
  | { readonly ok: false; readonly error: string };

const CONNECT_VALUE_KEYS = {
  profile: "profile",
  token: "token",
  "token-env": "tokenEnv",
  "auth-ref": "authRef",
  service: "service",
  "app-id": "appId",
  "installation-id": "installationId",
  "private-key": "privateKey",
  "private-key-env": "privateKeyEnv",
  "private-key-auth-ref": "privateKeyAuthRef",
  "api-base-url": "apiBaseUrl",
} as const satisfies Record<
  string,
  keyof Omit<ConnectParsedValue, "stdin" | "privateKeyStdin" | "setDefault">
>;

const OAUTH_VALUE_KEYS = {
  profile: "profile",
  scopes: "scopes",
  hostname: "hostname",
  "gh-path": "ghPath",
  "installation-id": "installationId",
  "app-id": "appId",
  "token-env": "tokenEnv",
  "auth-ref": "authRef",
  service: "service",
  "api-base-url": "apiBaseUrl",
} as const;

function parseConnectArgs(input: {
  readonly args: readonly string[];
}): ConnectParseResult {
  const values: MutableConnectParsedValues = {};
  let stdin = false;
  let privateKeyStdin = false;
  let setDefault = false;

  let i = 0;
  while (i < input.args.length) {
    const flag = input.args[i] ?? "";
    if (flag === "--stdin") {
      stdin = true;
      i += 1;
      continue;
    }
    if (flag === "--private-key-stdin") {
      privateKeyStdin = true;
      i += 1;
      continue;
    }
    if (flag === "--set-default") {
      setDefault = true;
      i += 1;
      continue;
    }
    if (!flag.startsWith("--")) {
      return { ok: false, error: `Unknown argument: ${flag}` };
    }
    const key = flag.slice(2) as keyof typeof CONNECT_VALUE_KEYS;
    const mappedKey = CONNECT_VALUE_KEYS[key];
    if (!mappedKey) {
      return { ok: false, error: `Unknown argument: ${flag}` };
    }
    const value = input.args[i + 1];
    if (!value || value.startsWith("--")) {
      return { ok: false, error: `Missing value for --${flag.slice(2)}` };
    }
    values[mappedKey] = value.trim();
    i += 2;
  }

  if (values.token && stdin) {
    return {
      ok: false,
      error: "Choose one token source: --token or --stdin (not both).",
    };
  }
  if (values.privateKey && privateKeyStdin) {
    return {
      ok: false,
      error:
        "Choose one private-key source: --private-key or --private-key-stdin (not both).",
    };
  }
  if (stdin && privateKeyStdin) {
    return {
      ok: false,
      error:
        "Cannot use both --stdin and --private-key-stdin in one command (shared stdin stream).",
    };
  }

  return {
    ok: true,
    value: {
      ...values,
      stdin,
      privateKeyStdin,
      setDefault,
    },
  };
}

function resolveConnectDefaults(input: {
  readonly parsedValue: ConnectParsedValue;
  readonly defaults: ReturnType<typeof resolveGitHubAuthSettings>;
}): ConnectResolvedDefaults {
  const appModeRequested =
    input.parsedValue.appId !== undefined ||
    input.parsedValue.installationId !== undefined ||
    input.parsedValue.privateKey !== undefined ||
    input.parsedValue.privateKeyStdin === true ||
    input.parsedValue.privateKeyEnv !== undefined ||
    input.parsedValue.privateKeyAuthRef !== undefined ||
    input.parsedValue.apiBaseUrl !== undefined;
  return {
    profileId: input.parsedValue.profile ?? input.defaults.profileId,
    tokenEnv: input.parsedValue.tokenEnv ?? input.defaults.tokenEnv,
    authRef: input.parsedValue.authRef ?? input.defaults.authRef,
    service: input.parsedValue.service ?? input.defaults.service,
    appId: input.parsedValue.appId ?? input.defaults.appId,
    installationId:
      input.parsedValue.installationId ?? input.defaults.installationId,
    privateKeyEnv:
      input.parsedValue.privateKeyEnv ?? input.defaults.privateKeyEnv,
    privateKeyAuthRef:
      input.parsedValue.privateKeyAuthRef ?? input.defaults.privateKeyAuthRef,
    apiBaseUrl: input.parsedValue.apiBaseUrl ?? input.defaults.apiBaseUrl,
    appModeRequested,
  };
}

async function resolveConnectTokenResult(input: {
  readonly parsedValue: ConnectParsedValue;
  readonly resolved: ConnectResolvedDefaults;
}): Promise<ConnectTokenResult> {
  if (!input.resolved.appModeRequested) {
    return await resolveConnectToken({
      tokenArg: input.parsedValue.token,
      stdin: input.parsedValue.stdin,
      tokenEnv: input.resolved.tokenEnv,
    });
  }
  if (!(input.resolved.appId && input.resolved.installationId)) {
    return {
      ok: false,
      error:
        "GitHub App mode requires --app-id and --installation-id (or configured defaults).",
    };
  }
  const privateKey = await resolveConnectPrivateKey({
    privateKeyArg: input.parsedValue.privateKey,
    privateKeyStdin: input.parsedValue.privateKeyStdin,
    privateKeyEnv: input.resolved.privateKeyEnv,
    privateKeyAuthRef: input.resolved.privateKeyAuthRef,
    authRef: input.resolved.authRef,
    service: input.resolved.service,
  });
  if (!privateKey.ok) {
    return { ok: false, error: privateKey.error };
  }
  const exchanged = await exchangeGitHubAppInstallationToken({
    appId: input.resolved.appId,
    installationId: input.resolved.installationId,
    privateKey: privateKey.privateKey,
    apiBaseUrl: input.resolved.apiBaseUrl,
  });
  if (!exchanged.ok) {
    return {
      ok: false,
      error: `GitHub App token exchange failed (${exchanged.status}): ${exchanged.error}`,
    };
  }
  return {
    ok: true,
    token: exchanged.token,
    ...(exchanged.expiresAt ? { expiresAt: exchanged.expiresAt } : {}),
    ...(privateKey.privateKeyAuthRef
      ? { privateKeyAuthRef: privateKey.privateKeyAuthRef }
      : {}),
  };
}

function shouldSetProfileAsDefault(input: {
  readonly controlPlaneConfig: Parameters<
    typeof listGitHubAuthProfiles
  >[0]["controlPlaneConfig"];
  readonly profileId: string;
  readonly setDefaultFlag: boolean;
}): boolean {
  if (input.setDefaultFlag) {
    return true;
  }
  return !hasConfiguredGitHubProfiles({
    controlPlaneConfig: input.controlPlaneConfig,
  });
}

function hasConfiguredGitHubProfiles(input: {
  readonly controlPlaneConfig: Parameters<
    typeof listGitHubAuthProfiles
  >[0]["controlPlaneConfig"];
}): boolean {
  const extension =
    input.controlPlaneConfig.extensions?.[
      EXTENSION_ID as keyof typeof input.controlPlaneConfig.extensions
    ];
  if (!extension || typeof extension !== "object" || !("config" in extension)) {
    return false;
  }
  const config = extension.config;
  if (!(config && typeof config === "object")) {
    return false;
  }
  const profiles = (config as Record<string, unknown>).profiles;
  return (
    profiles !== null &&
    typeof profiles === "object" &&
    Object.keys(profiles as Record<string, unknown>).length > 0
  );
}

async function persistGitHubProfileDefaults(input: {
  readonly profileId: string;
  readonly tokenEnv: string;
  readonly authRef: string;
  readonly service: string;
  readonly appId?: string;
  readonly installationId?: string;
  readonly privateKeyEnv: string;
  readonly privateKeyAuthRef?: string;
  readonly apiBaseUrl: string;
  readonly mode: GitHubAuthMode;
  readonly accountLogin?: string;
  readonly accountName?: string;
  readonly accountId?: string;
  readonly setAsDefault: boolean;
}): Promise<void> {
  const profilePath = getGitHubProfileConfigPath({
    profileId: input.profileId,
  });
  const updates: Promise<{ readonly changed: boolean }>[] = [
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
      path: `${profilePath}.appId`,
      value: input.appId ?? "",
    }),
    updateGlobalConfig({
      path: `${profilePath}.installationId`,
      value: input.installationId ?? "",
    }),
    updateGlobalConfig({
      path: `${profilePath}.privateKeyEnv`,
      value: input.privateKeyEnv,
    }),
    updateGlobalConfig({
      path: `${profilePath}.privateKeyAuthRef`,
      value: input.privateKeyAuthRef ?? "",
    }),
    updateGlobalConfig({
      path: `${profilePath}.apiBaseUrl`,
      value: input.apiBaseUrl,
    }),
    updateGlobalConfig({
      path: `${profilePath}.mode`,
      value: input.mode,
    }),
    updateGlobalConfig({
      path: `${profilePath}.accountLogin`,
      value: input.accountLogin ?? "",
    }),
    updateGlobalConfig({
      path: `${profilePath}.accountName`,
      value: input.accountName ?? "",
    }),
    updateGlobalConfig({
      path: `${profilePath}.accountId`,
      value: input.accountId ?? "",
    }),
  ];
  if (input.setAsDefault) {
    updates.push(
      updateGlobalConfig({
        path: `controlPlane.extensions["${EXTENSION_ID}"].config.defaultProfile`,
        value: input.profileId,
      })
    );
  }
  await Promise.all(updates);
}

function getGitHubProfileConfigPath(input: {
  readonly profileId: string;
}): string {
  const escapedProfileId = input.profileId
    .trim()
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
  return `controlPlane.extensions["${EXTENSION_ID}"].config.profiles["${escapedProfileId}"]`;
}

function buildConnectSummaryEntries(input: {
  readonly resolved: ConnectResolvedDefaults;
  readonly tokenResult: ConnectTokenResult;
  readonly accountSnapshot: GitHubAccountSnapshot;
  readonly setAsDefault: boolean;
}): readonly (readonly [string, string])[] {
  const entries: (readonly [string, string])[] = [
    ["extension_id", EXTENSION_ID],
    ["profile", input.resolved.profileId],
    ["set_default", input.setAsDefault ? "yes" : "no"],
    ["auth_ref", input.resolved.authRef],
    ["service", input.resolved.service],
    ["token_env_fallback", input.resolved.tokenEnv],
    ["mode", input.resolved.appModeRequested ? "app_exchange" : "direct_token"],
  ];
  if (input.resolved.appModeRequested && input.resolved.appId) {
    entries.push(["app_id", input.resolved.appId]);
  }
  if (input.resolved.appModeRequested && input.resolved.installationId) {
    entries.push(["installation_id", input.resolved.installationId]);
  }
  if (input.tokenResult.ok && input.tokenResult.expiresAt) {
    entries.push(["token_expires_at", input.tokenResult.expiresAt]);
  }
  if (input.accountSnapshot.accountLogin) {
    entries.push(["account_login", input.accountSnapshot.accountLogin]);
  }
  if (input.accountSnapshot.accountName) {
    entries.push(["account_name", input.accountSnapshot.accountName]);
  }
  if (input.accountSnapshot.accountId) {
    entries.push(["account_id", input.accountSnapshot.accountId]);
  }
  return entries;
}

type ConnectTokenResolution =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly error: string };

async function resolveConnectToken(input: {
  readonly tokenArg?: string;
  readonly stdin: boolean;
  readonly tokenEnv: string;
}): Promise<ConnectTokenResolution> {
  const tokenArg = input.tokenArg?.trim();
  if (tokenArg) {
    return { ok: true, token: tokenArg };
  }
  if (input.stdin) {
    const fromStdin = (await new Response(Bun.stdin.stream()).text()).trim();
    if (!fromStdin) {
      return { ok: false, error: "No token received from stdin." };
    }
    return { ok: true, token: fromStdin };
  }
  const fromEnv = (process.env[input.tokenEnv] ?? "").trim();
  if (!fromEnv) {
    return {
      ok: false,
      error: `Missing token. Pass --token, use --stdin, or set ${input.tokenEnv}.`,
    };
  }
  return { ok: true, token: fromEnv };
}

type ConnectPrivateKeyResolution =
  | {
      readonly ok: true;
      readonly privateKey: string;
      readonly privateKeyAuthRef?: string;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Resolve private key material for GitHub App token exchange.
 *
 * Resolution order:
 * 1. explicit `--private-key`
 * 2. stdin via `--private-key-stdin`
 * 3. keychain by `--private-key-auth-ref` (or configured default)
 * 4. environment variable (`--private-key-env` or configured default)
 *
 * When key material is provided directly (arg/stdin), we persist it in keychain
 * to support future token refresh without re-supplying the key.
 */
async function resolveConnectPrivateKey(input: {
  readonly privateKeyArg?: string;
  readonly privateKeyStdin: boolean;
  readonly privateKeyEnv: string;
  readonly privateKeyAuthRef?: string;
  readonly authRef: string;
  readonly service: string;
}): Promise<ConnectPrivateKeyResolution> {
  const direct = input.privateKeyArg?.trim();
  const persistedRef =
    input.privateKeyAuthRef?.trim() || `${input.authRef}.private_key`;
  if (direct) {
    await secrets.set({
      service: input.service,
      name: persistedRef,
      value: direct,
    });
    return {
      ok: true,
      privateKey: direct,
      privateKeyAuthRef: persistedRef,
    };
  }
  if (input.privateKeyStdin) {
    const stdinValue = (await new Response(Bun.stdin.stream()).text()).trim();
    if (!stdinValue) {
      return {
        ok: false,
        error: "No private key received from stdin.",
      };
    }
    await secrets.set({
      service: input.service,
      name: persistedRef,
      value: stdinValue,
    });
    return {
      ok: true,
      privateKey: stdinValue,
      privateKeyAuthRef: persistedRef,
    };
  }

  const keychainRef = input.privateKeyAuthRef?.trim();
  if (keychainRef) {
    const stored = (
      await secrets.get({
        service: input.service,
        name: keychainRef,
      })
    )?.trim();
    if (stored) {
      return {
        ok: true,
        privateKey: stored,
        privateKeyAuthRef: keychainRef,
      };
    }
  }

  const envPrivateKey = (process.env[input.privateKeyEnv] ?? "").trim();
  if (envPrivateKey) {
    return {
      ok: true,
      privateKey: envPrivateKey,
      ...(keychainRef ? { privateKeyAuthRef: keychainRef } : {}),
    };
  }

  return {
    ok: false,
    error: keychainRef
      ? `Missing private key. Provide --private-key, --private-key-stdin, store key at auth ref ${keychainRef}, or set ${input.privateKeyEnv}.`
      : `Missing private key. Provide --private-key, --private-key-stdin, or set ${input.privateKeyEnv}.`,
  };
}

function parseOAuthConnectArgs(input: {
  readonly args: readonly string[];
}): OAuthConnectParseResult {
  const values: MutableOAuthConnectValues = {};
  let setDefault = false;
  let i = 0;
  while (i < input.args.length) {
    const flag = input.args[i] ?? "";
    if (flag === "--set-default") {
      setDefault = true;
      i += 1;
      continue;
    }
    if (!flag.startsWith("--")) {
      return { ok: false, error: `Unknown argument: ${flag}` };
    }
    const key = flag.slice(2) as keyof typeof OAUTH_VALUE_KEYS;
    const mappedKey = OAUTH_VALUE_KEYS[key];
    if (!mappedKey) {
      return { ok: false, error: `Unknown argument: ${flag}` };
    }
    const value = input.args[i + 1];
    if (!value || value.startsWith("--")) {
      return { ok: false, error: `Missing value for --${flag.slice(2)}` };
    }
    values[mappedKey] = value.trim();
    i += 2;
  }
  return {
    ok: true,
    value: {
      ...values,
      setDefault,
    },
  };
}

async function handleGitHubOAuthConnectCommand(input: {
  readonly controlPlaneConfig: Parameters<
    typeof resolveGitHubAuthSettings
  >[0]["controlPlaneConfig"];
  readonly logger: GitHubCommandLogger;
  readonly args: readonly string[];
}): Promise<number> {
  const parsed = parseOAuthConnectArgs({ args: input.args });
  if (!parsed.ok) {
    input.logger.error({ message: parsed.error });
    return 1;
  }

  const defaults = resolveGitHubAuthSettings({
    controlPlaneConfig: input.controlPlaneConfig,
    ...(parsed.value.profile ? { profileId: parsed.value.profile } : {}),
    allowProjectOverride: false,
  });
  const profileId = parsed.value.profile ?? defaults.profileId;
  const ghPath = resolveGhExecutable({
    ghPathArg: parsed.value.ghPath,
  });
  if (!ghPath) {
    input.logger.error({
      message:
        "GitHub CLI `gh` not found. Install it first: https://cli.github.com/",
    });
    return 1;
  }

  const hostname = parsed.value.hostname ?? DEFAULT_GITHUB_HOSTNAME;
  const scopes = parsed.value.scopes ?? DEFAULT_OAUTH_SCOPES;
  const oauthToken = await resolveOAuthTokenFromGh({
    ghPath,
    hostname,
    scopes,
  });
  if (!oauthToken.ok) {
    input.logger.error({ message: oauthToken.error });
    return 1;
  }

  const apiBaseUrl = parsed.value.apiBaseUrl ?? defaults.apiBaseUrl;
  const identity = await inspectGitHubIdentity({
    token: oauthToken.token,
    apiBaseUrl,
  });
  if (!identity.ok) {
    input.logger.error({ message: identity.error });
    return 1;
  }

  const selectedInstallation = await selectGitHubInstallation({
    requestedInstallationId: parsed.value.installationId,
    installations: identity.installations,
  });
  if (!selectedInstallation.ok) {
    input.logger.error({ message: selectedInstallation.error });
    return 1;
  }

  const authRef = parsed.value.authRef ?? defaults.authRef;
  const service = parsed.value.service ?? defaults.service;
  const tokenEnv = parsed.value.tokenEnv ?? defaults.tokenEnv;
  await saveGitHubAppToken({
    controlPlaneConfig: input.controlPlaneConfig,
    profileId,
    allowProjectOverride: false,
    token: oauthToken.token,
    authRef,
    service,
  });

  const setAsDefault = shouldSetProfileAsDefault({
    controlPlaneConfig: input.controlPlaneConfig,
    profileId,
    setDefaultFlag: parsed.value.setDefault,
  });
  await persistGitHubProfileDefaults({
    profileId,
    tokenEnv,
    authRef,
    service,
    appId: parsed.value.appId ?? defaults.appId,
    installationId:
      selectedInstallation.installationId ?? defaults.installationId,
    privateKeyEnv: defaults.privateKeyEnv,
    privateKeyAuthRef: defaults.privateKeyAuthRef,
    apiBaseUrl,
    mode: "token",
    accountLogin: identity.login,
    accountName: identity.accountName,
    accountId: identity.accountId,
    setAsDefault,
  });

  await display.kv({
    title: "GitHub OAuth connected",
    entries: [
      ["profile", profileId],
      ["set_default", setAsDefault ? "yes" : "no"],
      ["auth_ref", authRef],
      ["service", service],
      ["token_env_fallback", tokenEnv],
      ["api_base_url", apiBaseUrl],
      ["account_login", identity.login],
      ["account_name", identity.accountName ?? ""],
      ["account_id", identity.accountId ?? ""],
      [
        "installation_id",
        selectedInstallation.installationId ?? defaults.installationId ?? "",
      ],
      ...(identity.installationWarning
        ? ([["installations_warning", identity.installationWarning]] as const)
        : []),
    ],
  });
  return 0;
}

type OAuthTokenResolution =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly error: string };

async function resolveOAuthTokenFromGh(input: {
  readonly ghPath: string;
  readonly hostname: string;
  readonly scopes: string;
}): Promise<OAuthTokenResolution> {
  const loginExit = await run(
    [
      input.ghPath,
      "auth",
      "login",
      "--hostname",
      input.hostname,
      "--web",
      "--scopes",
      input.scopes,
    ],
    { stdin: "inherit" }
  );
  if (loginExit !== 0) {
    return {
      ok: false,
      error: "`gh auth login` failed. Complete login and try again.",
    };
  }

  const tokenResult = await exec(
    [input.ghPath, "auth", "token", "--hostname", input.hostname],
    {
      stdin: "ignore",
    }
  );
  if (tokenResult.exitCode !== 0) {
    return {
      ok: false,
      error: tokenResult.stderr.trim() || "Failed to read token from gh.",
    };
  }
  const token = tokenResult.stdout.trim();
  if (!token) {
    return { ok: false, error: "GitHub token from gh is empty." };
  }
  return { ok: true, token };
}

async function resolveGitHubAccountSnapshot(input: {
  readonly token: Awaited<ReturnType<typeof resolveGitHubAppToken>>;
  readonly settings: ReturnType<typeof resolveGitHubAuthSettings>;
}): Promise<GitHubAccountSnapshot> {
  const fallback = {
    ...(input.settings.accountLogin
      ? { accountLogin: input.settings.accountLogin }
      : {}),
    ...(input.settings.accountName
      ? { accountName: input.settings.accountName }
      : {}),
    ...(input.settings.accountId
      ? { accountId: input.settings.accountId }
      : {}),
  };
  if (input.settings.accountLogin) {
    return fallback;
  }
  if (!input.token.ok) {
    return fallback;
  }
  const resolved = await resolveGitHubAccountSnapshotFromToken({
    token: input.token.token,
    apiBaseUrl: input.settings.apiBaseUrl,
  });
  if (resolved.accountLogin) {
    return resolved;
  }
  return fallback;
}

async function resolveGitHubAccountSnapshotFromToken(input: {
  readonly token: string;
  readonly apiBaseUrl: string;
}): Promise<GitHubAccountSnapshot> {
  const identity = await inspectGitHubIdentity({
    token: input.token,
    apiBaseUrl: input.apiBaseUrl,
  });
  if (!identity.ok) {
    return {};
  }
  return {
    accountLogin: identity.login,
    ...(identity.accountName ? { accountName: identity.accountName } : {}),
    ...(identity.accountId ? { accountId: identity.accountId } : {}),
  };
}

async function handleGitHubStatusCommand(input: {
  readonly controlPlaneConfig: Parameters<
    typeof resolveGitHubAuthSettings
  >[0]["controlPlaneConfig"];
  readonly logger: GitHubCommandLogger;
  readonly args: readonly string[];
}): Promise<number> {
  const parsed = parseStatusArgs({ args: input.args });
  if (!parsed.ok) {
    input.logger.error({ message: parsed.error });
    return 1;
  }
  const allowProjectOverride = !parsed.value.profileId;
  const profileFlags = parsed.value.profileId
    ? { profileId: parsed.value.profileId }
    : {};
  const settingsResult = resolveGitHubAuthSettingsResult({
    controlPlaneConfig: input.controlPlaneConfig,
    ...profileFlags,
    allowProjectOverride,
  });
  const settings = resolveGitHubAuthSettings({
    controlPlaneConfig: input.controlPlaneConfig,
    ...profileFlags,
    allowProjectOverride,
  });
  const token = await resolveGitHubAppToken({
    controlPlaneConfig: input.controlPlaneConfig,
    ...profileFlags,
    allowProjectOverride,
  });
  const resolvedAccountSnapshot = await resolveGitHubAccountSnapshot({
    token,
    settings,
  });
  const catalog = listGitHubAuthProfiles({
    controlPlaneConfig: input.controlPlaneConfig,
    ...(parsed.value.profileId
      ? { explicitProfileId: parsed.value.profileId }
      : {}),
    allowProjectOverride,
  });
  const payload = buildGitHubStatusPayload({
    settings,
    settingsResult,
    token,
    defaultProfileId: catalog.defaultProfileId,
    accountSnapshot: resolvedAccountSnapshot,
  });
  if (parsed.value.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    await renderGitHubStatusDisplay({ payload, catalog });
  }
  return settingsResult.ok && token.ok ? 0 : 1;
}

function resolveGhExecutable(input: {
  readonly ghPathArg?: string;
}): string | null {
  const explicit = input.ghPathArg?.trim();
  if (explicit) {
    return explicit;
  }
  return findExecutableInPath("gh");
}

async function inspectGitHubIdentity(input: {
  readonly token: string;
  readonly apiBaseUrl: string;
}): Promise<GitHubIdentityResult> {
  const base = input.apiBaseUrl.trim().replace(TRAILING_SLASH_PATTERN, "");
  const headers = {
    Authorization: `Bearer ${input.token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "hack-cli",
    "X-GitHub-Api-Version": "2022-11-28",
  } as const;

  const userRes = await fetch(`${base}/user`, {
    method: "GET",
    headers,
  });
  const userPayload = (await userRes.json().catch(() => null)) as unknown;
  if (!userRes.ok) {
    return {
      ok: false,
      error: `GitHub identity lookup failed (${userRes.status}): ${extractGitHubMessage(userPayload) ?? userRes.statusText}`,
    };
  }
  if (!(userPayload && typeof userPayload === "object")) {
    return {
      ok: false,
      error: "Invalid GitHub identity payload.",
    };
  }
  const userRecord = userPayload as Record<string, unknown>;
  const login =
    typeof userRecord.login === "string" ? userRecord.login.trim() : "";
  if (!login) {
    return {
      ok: false,
      error: "GitHub identity payload is missing login.",
    };
  }

  const accountId = normalizeGitHubId({ value: userRecord.id });
  const accountName =
    typeof userRecord.name === "string" && userRecord.name.trim()
      ? userRecord.name.trim()
      : undefined;

  const installationsRes = await fetch(
    `${base}/user/installations?per_page=100`,
    {
      method: "GET",
      headers,
    }
  );
  if (!installationsRes.ok) {
    return {
      ok: true,
      login,
      ...(accountId ? { accountId } : {}),
      ...(accountName ? { accountName } : {}),
      installations: [],
      installationWarning: `Installations endpoint unavailable (${installationsRes.status}). Grant read:org if you need installation discovery.`,
    };
  }

  const installationsPayload = (await installationsRes
    .json()
    .catch(() => null)) as unknown;
  if (!isRecord(installationsPayload)) {
    return {
      ok: true,
      login,
      ...(accountId ? { accountId } : {}),
      ...(accountName ? { accountName } : {}),
      installations: [],
      installationWarning: "Installations payload was invalid.",
    };
  }
  const rawInstallations = installationsPayload.installations;
  if (!Array.isArray(rawInstallations)) {
    return {
      ok: true,
      login,
      ...(accountId ? { accountId } : {}),
      ...(accountName ? { accountName } : {}),
      installations: [],
    };
  }
  const installations: GitHubInstallationSummary[] = [];
  for (const value of rawInstallations) {
    if (!isRecord(value)) {
      continue;
    }
    const id = normalizeGitHubId({ value: value.id }) ?? "";
    if (!id) {
      continue;
    }
    const account =
      isRecord(value.account) && typeof value.account.login === "string"
        ? value.account.login.trim()
        : "";
    if (!account) {
      continue;
    }
    const appSlug =
      typeof value.app_slug === "string" && value.app_slug.trim()
        ? value.app_slug.trim()
        : undefined;
    installations.push({
      id,
      accountLogin: account,
      ...(appSlug ? { appSlug } : {}),
    });
  }
  installations.sort((left, right) =>
    `${left.accountLogin}:${left.id}`.localeCompare(
      `${right.accountLogin}:${right.id}`
    )
  );
  return {
    ok: true,
    login,
    ...(accountId ? { accountId } : {}),
    ...(accountName ? { accountName } : {}),
    installations,
  };
}

type InstallationSelectionResult =
  | { readonly ok: true; readonly installationId?: string }
  | { readonly ok: false; readonly error: string };

async function selectGitHubInstallation(input: {
  readonly requestedInstallationId?: string;
  readonly installations: readonly GitHubInstallationSummary[];
}): Promise<InstallationSelectionResult> {
  const requested = input.requestedInstallationId?.trim();
  if (requested) {
    return { ok: true, installationId: requested };
  }
  if (input.installations.length === 0) {
    return { ok: true };
  }
  if (input.installations.length === 1) {
    return { ok: true, installationId: input.installations[0]?.id };
  }
  if (!(process.stdin.isTTY && process.stdout.isTTY)) {
    return {
      ok: false,
      error:
        "Multiple GitHub installations detected. Re-run with --installation-id <id> in non-interactive mode.",
    };
  }

  const selection = await select({
    message: "Select GitHub installation for this profile",
    options: input.installations.map((installation) => ({
      value: installation.id,
      label: `${installation.accountLogin} (${installation.id})`,
      hint: installation.appSlug ? `app: ${installation.appSlug}` : undefined,
    })),
  });
  if (isCancel(selection)) {
    return {
      ok: false,
      error: "Installation selection cancelled.",
    };
  }
  return { ok: true, installationId: `${selection}` };
}

function extractGitHubMessage(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const message =
    typeof payload.message === "string" ? payload.message.trim() : "";
  return message || null;
}

function normalizeGitHubId(input: {
  readonly value: unknown;
}): string | undefined {
  if (typeof input.value === "number" && Number.isFinite(input.value)) {
    return String(input.value);
  }
  if (typeof input.value === "string" && input.value.trim()) {
    return input.value.trim();
  }
  return undefined;
}

function parseDisconnectArgs(input: {
  readonly args: readonly string[];
}): DisconnectParseResult {
  let profileId: string | undefined;
  let authRef: string | undefined;
  let service: string | undefined;
  let i = 0;
  while (i < input.args.length) {
    const flag = input.args[i] ?? "";
    if (!flag.startsWith("--")) {
      return { ok: false, error: `Unknown argument: ${flag}` };
    }
    const key = flag.slice(2);
    const value = input.args[i + 1];
    if (!value || value.startsWith("--")) {
      return { ok: false, error: `Missing value for --${key}` };
    }
    if (key === "profile") {
      profileId = value.trim();
      i += 2;
      continue;
    }
    if (key === "auth-ref") {
      authRef = value.trim();
      i += 2;
      continue;
    }
    if (key === "service") {
      service = value.trim();
      i += 2;
      continue;
    }
    return { ok: false, error: `Unknown argument: ${flag}` };
  }

  return {
    ok: true,
    value: {
      ...(profileId ? { profileId } : {}),
      ...(authRef ? { authRef } : {}),
      ...(service ? { service } : {}),
    },
  };
}

function parseStatusArgs(input: {
  readonly args: readonly string[];
}): StatusParseResult {
  let profileId: string | undefined;
  let json = false;
  let i = 0;
  while (i < input.args.length) {
    const token = input.args[i] ?? "";
    if (token === "--json") {
      json = true;
      i += 1;
      continue;
    }
    if (token === "--profile") {
      const value = input.args[i + 1]?.trim() ?? "";
      if (!value) {
        return { ok: false, error: "Missing value for --profile" };
      }
      profileId = value;
      i += 2;
      continue;
    }
    return {
      ok: false,
      error: "Usage: hack x github status [--profile <id>] [--json]",
    };
  }
  return { ok: true, value: { ...(profileId ? { profileId } : {}), json } };
}

function parseProfilesArgs(input: {
  readonly args: readonly string[];
}): ProfilesParseResult {
  if (input.args.length === 0) {
    return { ok: true, value: { json: false } };
  }
  if (input.args.length === 1 && input.args[0] === "--json") {
    return { ok: true, value: { json: true } };
  }
  return {
    ok: false,
    error: "Usage: hack x github profiles [--json]",
  };
}

function parseProfileUseArgs(input: {
  readonly args: readonly string[];
}): ProfileUseParseResult {
  if (input.args.length !== 2 || input.args[0] !== "--profile") {
    return {
      ok: false,
      error: "Usage: hack x github use --profile <id>",
    };
  }
  const profileId = input.args[1]?.trim() ?? "";
  if (!profileId) {
    return {
      ok: false,
      error: "Missing profile id",
    };
  }
  return { ok: true, value: { profileId } };
}

async function renderGitHubProfilesTable(input: {
  readonly catalog: ReturnType<typeof listGitHubAuthProfiles>;
}): Promise<void> {
  await display.table({
    columns: [
      "profile",
      "default",
      "mode",
      "auth_ref",
      "app_id",
      "installation_id",
      "account",
    ],
    rows: input.catalog.profiles.map((profile) => [
      profile.id,
      profile.isDefault ? "yes" : "",
      profile.mode,
      profile.authRef,
      profile.appId ?? "",
      profile.installationId ?? "",
      profile.accountLogin ?? "",
    ]),
  });
}

async function renderGitHubStatusDisplay(input: {
  readonly payload: GitHubStatusPayload;
  readonly catalog: ReturnType<typeof listGitHubAuthProfiles>;
}): Promise<void> {
  await display.kv({
    title: "GitHub extension status",
    entries: [
      ["extension_id", input.payload.extensionId],
      ["selected_profile", input.payload.selectedProfile],
      ["selected_source", input.payload.selectedSource],
      ["default_profile", input.payload.defaultProfile],
      ["auth_ref", input.payload.authRef],
      ["service", input.payload.service],
      ["token_env_fallback", input.payload.tokenEnvFallback],
      ["mode", input.payload.mode],
      ["app_id", input.payload.appId ?? ""],
      ["installation_id", input.payload.installationId ?? ""],
      ["private_key_env", input.payload.privateKeyEnv],
      ["private_key_auth_ref", input.payload.privateKeyAuthRef ?? ""],
      ["api_base_url", input.payload.apiBaseUrl],
      ["account_login", input.payload.accountLogin ?? ""],
      ["account_name", input.payload.accountName ?? ""],
      ["account_id", input.payload.accountId ?? ""],
      ["token_resolved", input.payload.tokenResolved ? "yes" : "no"],
      ["token_source", input.payload.tokenSource ?? "none"],
      ...(input.payload.tokenExpiresAt
        ? ([["token_expires_at", input.payload.tokenExpiresAt]] as const)
        : []),
      ...(input.payload.profileError
        ? ([["profile_error", input.payload.profileError]] as const)
        : []),
      ...(input.payload.error
        ? ([["error", input.payload.error]] as const)
        : []),
    ],
  });
  await renderGitHubProfilesTable({ catalog: input.catalog });
}

function buildGitHubStatusPayload(input: {
  readonly settings: ReturnType<typeof resolveGitHubAuthSettings>;
  readonly settingsResult: ReturnType<typeof resolveGitHubAuthSettingsResult>;
  readonly token: Awaited<ReturnType<typeof resolveGitHubAppToken>>;
  readonly defaultProfileId: string;
  readonly accountSnapshot: GitHubAccountSnapshot;
}): GitHubStatusPayload {
  const accountLogin =
    input.accountSnapshot.accountLogin ?? input.settings.accountLogin;
  const accountName =
    input.accountSnapshot.accountName ?? input.settings.accountName;
  const accountId = input.accountSnapshot.accountId ?? input.settings.accountId;
  return {
    extensionId: EXTENSION_ID,
    selectedProfile: input.settings.profileId,
    selectedSource: input.settings.profileSource,
    defaultProfile: input.defaultProfileId,
    authRef: input.settings.authRef,
    service: input.settings.service,
    tokenEnvFallback: input.settings.tokenEnv,
    mode: input.settings.mode,
    ...(input.settings.appId ? { appId: input.settings.appId } : {}),
    ...(input.settings.installationId
      ? { installationId: input.settings.installationId }
      : {}),
    privateKeyEnv: input.settings.privateKeyEnv,
    ...(input.settings.privateKeyAuthRef
      ? { privateKeyAuthRef: input.settings.privateKeyAuthRef }
      : {}),
    apiBaseUrl: input.settings.apiBaseUrl,
    ...(accountLogin ? { accountLogin } : {}),
    ...(accountName ? { accountName } : {}),
    ...(accountId ? { accountId } : {}),
    tokenResolved: input.token.ok,
    ...(input.token.ok ? { tokenSource: input.token.source } : {}),
    ...(input.token.ok && input.token.expiresAt
      ? { tokenExpiresAt: input.token.expiresAt }
      : {}),
    ...(input.settingsResult.ok
      ? {}
      : { profileError: input.settingsResult.error }),
    ...(input.token.ok ? {} : { error: input.token.error }),
  };
}

function buildGitHubProfilesPayload(input: {
  readonly catalog: ReturnType<typeof listGitHubAuthProfiles>;
}): GitHubProfilesPayload {
  return {
    selectedProfile: input.catalog.selectedProfileId,
    selectedSource: input.catalog.selectedProfileSource,
    defaultProfile: input.catalog.defaultProfileId,
    ...(input.catalog.projectProfileOverride
      ? { projectOverride: input.catalog.projectProfileOverride }
      : {}),
    selectedMissing: input.catalog.selectedProfileMissing,
    profiles: input.catalog.profiles.map((profile) => ({
      id: profile.id,
      isDefault: profile.isDefault,
      mode: profile.mode,
      authRef: profile.authRef,
      service: profile.service,
      ...(profile.appId ? { appId: profile.appId } : {}),
      ...(profile.installationId
        ? { installationId: profile.installationId }
        : {}),
      ...(profile.accountLogin ? { accountLogin: profile.accountLogin } : {}),
      ...(profile.accountName ? { accountName: profile.accountName } : {}),
      ...(profile.accountId ? { accountId: profile.accountId } : {}),
    })),
  };
}

function parsePrUpsertArgs(input: {
  readonly args: readonly string[];
}): PrUpsertParseResult {
  const values = new Map<string, string>();
  let i = 0;
  while (i < input.args.length) {
    const flag = input.args[i];
    if (!flag?.startsWith("--")) {
      return { ok: false, error: `Unknown argument: ${flag}` };
    }
    const key = flag.slice(2);
    const value = input.args[i + 1];
    if (!value || value.startsWith("--")) {
      return { ok: false, error: `Missing value for --${key}` };
    }
    values.set(key, value);
    i += 2;
  }

  const profileId = (values.get("profile") ?? "").trim() || undefined;
  const repoRaw = (values.get("repo") ?? "").trim();
  const headRef = (values.get("head") ?? "").trim();
  const baseRef = (values.get("base") ?? "main").trim() || "main";
  const title = (values.get("title") ?? "").trim();
  const body = values.get("body") ?? "";
  const comment = values.get("comment")?.trim();

  if (!(repoRaw && headRef && title)) {
    return {
      ok: false,
      error:
        "Usage: hack x github pr-upsert --repo <owner/repo|git-url> --head <branch> --base <branch> --title <text> --body <text> [--comment <text>] [--profile <id>]",
    };
  }

  const repo = parseRepoArg({ raw: repoRaw });
  if (!repo) {
    return { ok: false, error: `Unable to parse --repo: ${repoRaw}` };
  }

  return {
    ok: true,
    value: {
      ...(profileId ? { profileId } : {}),
      repo,
      headRef,
      baseRef,
      title,
      body,
      ...(comment ? { comment } : {}),
    },
  };
}

function parseRepoArg(input: { readonly raw: string }): GitHubRepoRef | null {
  const raw = input.raw.trim();
  if (!raw) {
    return null;
  }
  if (raw.includes("/")) {
    const directMatch = raw.match(DIRECT_REPO_PATTERN);
    if (directMatch?.[1] && directMatch[2]) {
      return {
        owner: directMatch[1],
        repo: directMatch[2],
      };
    }
  }
  return parseGitHubRepoRef({ remoteUrl: raw });
}

export const __testOnly = {
  buildGitHubProfilesPayload,
  parseProfilesArgs,
  parseStatusArgs,
} as const;
