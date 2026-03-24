import { createPrivateKey, createSign } from "node:crypto";

import { secrets } from "bun";

import { isRecord } from "../../../lib/guards.ts";
import type { ControlPlaneConfig } from "../../sdk/config.ts";

const GITHUB_EXTENSION_ID = "dance.hack.github";
const DEFAULT_GITHUB_PROFILE_ID = "default";
const DEFAULT_GITHUB_TOKEN_ENV = "HACK_GITHUB_APP_TOKEN";
const DEFAULT_GITHUB_PREFER_ENV_TOKEN_ONLY_ENV =
  "HACK_GITHUB_PREFER_ENV_TOKEN_ONLY";
const DEFAULT_GITHUB_PRIVATE_KEY_ENV = "HACK_GITHUB_APP_PRIVATE_KEY";
const DEFAULT_GITHUB_AUTH_REF = "github.app.default";
const GITHUB_SECRET_SERVICE = "hack-github-auth";
const DEFAULT_GITHUB_API_BASE = "https://api.github.com";
const TOKEN_REFRESH_SKEW_MS = 60_000;

export type GitHubProfileSelectionSource =
  | "command_flags"
  | "project_routing"
  | "global_default"
  | "implicit_default";

export type GitHubAuthMode = "app" | "token";

export type GitHubAuthSettings = {
  readonly profileId: string;
  readonly profileSource: GitHubProfileSelectionSource;
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
};

export type GitHubAuthProfileSummary = {
  readonly id: string;
  readonly isDefault: boolean;
  readonly mode: GitHubAuthMode;
  readonly authRef: string;
  readonly service: string;
  readonly appId?: string;
  readonly installationId?: string;
  readonly accountLogin?: string;
  readonly accountName?: string;
  readonly accountId?: string;
};

export type GitHubAuthProfileCatalog = {
  readonly defaultProfileId: string;
  readonly selectedProfileId: string;
  readonly selectedProfileSource: GitHubProfileSelectionSource;
  readonly selectedProfileMissing: boolean;
  readonly projectProfileOverride?: string;
  readonly profiles: readonly GitHubAuthProfileSummary[];
};

export type GitHubAuthSettingsResult =
  | {
      readonly ok: true;
      readonly settings: GitHubAuthSettings;
      readonly availableProfileIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly selectedProfileId: string;
      readonly selectedProfileSource: GitHubProfileSelectionSource;
      readonly availableProfileIds: readonly string[];
      readonly error: string;
    };

type GitHubProfileSettings = {
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
};

export type GitHubTokenResolution =
  | {
      readonly ok: true;
      readonly token: string;
      readonly source: "keychain" | "env" | "refreshed";
      readonly tokenEnv: string;
      readonly authRef: string;
      readonly service: string;
      readonly profileId: string;
      readonly profileSource: GitHubProfileSelectionSource;
      readonly expiresAt?: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly tokenEnv: string;
      readonly authRef: string;
      readonly service: string;
      readonly profileId: string;
      readonly profileSource: GitHubProfileSelectionSource;
    };

export type SecretStore = {
  readonly get: (input: {
    readonly service: string;
    readonly name: string;
  }) => Promise<string | null>;
  readonly set: (input: {
    readonly service: string;
    readonly name: string;
    readonly value: string;
  }) => Promise<void>;
  readonly delete: (input: {
    readonly service: string;
    readonly name: string;
  }) => Promise<boolean>;
};

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

type GitHubTokenEnvelope = {
  readonly token: string;
  readonly expiresAt?: string;
};

type GitHubInstallationTokenResult =
  | {
      readonly ok: true;
      readonly token: string;
      readonly expiresAt?: string;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
    };

type GitHubProfileSelection = {
  readonly selectedProfileId: string;
  readonly selectedProfileSource: GitHubProfileSelectionSource;
  readonly selectedProfileExists: boolean;
  readonly defaultProfileId: string;
  readonly sortedProfileIds: readonly string[];
  readonly profilesById: Readonly<Record<string, GitHubProfileSettings>>;
  readonly projectProfileOverride?: string;
};

const DEFAULT_SECRET_STORE: SecretStore = {
  get: async (input) => await secrets.get(input),
  set: async (input) => {
    await secrets.set(input);
  },
  delete: async (input) => await secrets.delete(input),
};

/**
 * Resolve profile catalog for GitHub auth settings.
 *
 * Profile selection precedence:
 * 1) explicit command profile
 * 2) project routing override (`controlPlane.routing.overrides.github.profile`)
 * 3) extension global default profile
 * 4) implicit default profile
 */
export function listGitHubAuthProfiles(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly explicitProfileId?: string;
  readonly allowProjectOverride?: boolean;
}): GitHubAuthProfileCatalog {
  const selected = resolveGitHubProfileSelection({
    controlPlaneConfig: input.controlPlaneConfig,
    explicitProfileId: input.explicitProfileId,
    allowProjectOverride: input.allowProjectOverride,
  });
  const summaries: GitHubAuthProfileSummary[] = [];
  for (const id of selected.sortedProfileIds) {
    const profile = selected.profilesById[id];
    if (!profile) {
      continue;
    }
    summaries.push(
      toGitHubProfileSummary({
        profile,
        isDefault: id === selected.defaultProfileId,
      })
    );
  }

  return {
    defaultProfileId: selected.defaultProfileId,
    selectedProfileId: selected.selectedProfileId,
    selectedProfileSource: selected.selectedProfileSource,
    selectedProfileMissing: !selected.selectedProfileExists,
    ...(selected.projectProfileOverride
      ? { projectProfileOverride: selected.projectProfileOverride }
      : {}),
    profiles: summaries,
  };
}

/**
 * Resolve GitHub auth settings from control-plane extension config.
 *
 * The extension supports:
 * - Profile-based config at:
 *   `controlPlane.extensions["dance.hack.github"].config.profiles.<id>.*`
 * - Default profile:
 *   `controlPlane.extensions["dance.hack.github"].config.defaultProfile`
 * - Project override:
 *   `controlPlane.routing.overrides.github.profile`
 * - Legacy top-level keys (backward compatibility):
 *   `controlPlane.extensions["dance.hack.github"].config.*`
 */
export function resolveGitHubAuthSettings(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly profileId?: string;
  readonly allowProjectOverride?: boolean;
}): GitHubAuthSettings {
  const selected = resolveGitHubProfileSelection({
    controlPlaneConfig: input.controlPlaneConfig,
    explicitProfileId: input.profileId,
    allowProjectOverride: input.allowProjectOverride,
  });
  const selectedProfile = selected.profilesById[selected.selectedProfileId];
  if (selectedProfile) {
    return {
      ...selectedProfile,
      profileSource: selected.selectedProfileSource,
    };
  }

  const extensionConfig = getGitHubExtensionConfig({
    controlPlaneConfig: input.controlPlaneConfig,
  });
  const fallbackProfile = buildGitHubProfileSettings({
    profileId: selected.selectedProfileId,
    profileConfig: null,
    legacyConfig: extensionConfig,
    includeLegacyFallback: true,
  });
  return {
    ...fallbackProfile,
    profileSource: selected.selectedProfileSource,
  };
}

/**
 * Resolve GitHub auth settings and fail when selected profile does not exist.
 */
export function resolveGitHubAuthSettingsResult(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly profileId?: string;
  readonly allowProjectOverride?: boolean;
}): GitHubAuthSettingsResult {
  const selected = resolveGitHubProfileSelection({
    controlPlaneConfig: input.controlPlaneConfig,
    explicitProfileId: input.profileId,
    allowProjectOverride: input.allowProjectOverride,
  });
  const availableProfileIds = selected.sortedProfileIds;
  const selectedProfile = selected.profilesById[selected.selectedProfileId];
  if (!selectedProfile) {
    const sourceLabel = (() => {
      if (selected.selectedProfileSource === "command_flags") {
        return "--profile";
      }
      if (selected.selectedProfileSource === "project_routing") {
        return "controlPlane.routing.overrides.github.profile";
      }
      if (selected.selectedProfileSource === "global_default") {
        return `controlPlane.extensions["${GITHUB_EXTENSION_ID}"].config.defaultProfile`;
      }
      return "implicit default";
    })();
    const availableLabel =
      availableProfileIds.length > 0
        ? availableProfileIds.join(", ")
        : "(none configured)";
    return {
      ok: false,
      selectedProfileId: selected.selectedProfileId,
      selectedProfileSource: selected.selectedProfileSource,
      availableProfileIds,
      error: `GitHub profile "${selected.selectedProfileId}" (${sourceLabel}) was not found. Available profiles: ${availableLabel}.`,
    };
  }
  return {
    ok: true,
    settings: {
      ...selectedProfile,
      profileSource: selected.selectedProfileSource,
    },
    availableProfileIds,
  };
}

/**
 * Resolve a GitHub token using keychain first, then environment fallback.
 */
export async function resolveGitHubAppToken(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly profileId?: string;
  readonly allowProjectOverride?: boolean;
  /**
   * When enabled, skip keychain/secret-store reads and resolve from env fallback only.
   * This avoids interactive keychain prompts in unattended bootstrap/probe paths.
   */
  readonly preferEnvTokenOnly?: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly store?: SecretStore;
  readonly fetcher?: FetchLike;
  readonly nowMs?: number;
}): Promise<GitHubTokenResolution> {
  const resolved = resolveGitHubAuthSettingsResult({
    controlPlaneConfig: input.controlPlaneConfig,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    allowProjectOverride: input.allowProjectOverride,
  });
  if (!resolved.ok) {
    const fallback = resolveGitHubAuthSettings({
      controlPlaneConfig: input.controlPlaneConfig,
      ...(input.profileId ? { profileId: input.profileId } : {}),
      allowProjectOverride: input.allowProjectOverride,
    });
    return {
      ok: false,
      error: resolved.error,
      tokenEnv: fallback.tokenEnv,
      authRef: fallback.authRef,
      service: fallback.service,
      profileId: fallback.profileId,
      profileSource: fallback.profileSource,
    };
  }

  const settings = resolved.settings;
  const allowProjectOverride = input.allowProjectOverride ?? true;
  const profileId = settings.profileId;
  const env = input.env ?? process.env;
  const store = input.store ?? DEFAULT_SECRET_STORE;
  const nowMs = input.nowMs ?? Date.now();
  const envToken = (env[settings.tokenEnv] ?? "").trim();
  const preferEnvTokenOnly =
    input.preferEnvTokenOnly ??
    parseOptionalBooleanFlag(env[DEFAULT_GITHUB_PREFER_ENV_TOKEN_ONLY_ENV]);

  if (preferEnvTokenOnly) {
    if (envToken.length > 0) {
      return {
        ok: true,
        token: envToken,
        source: "env",
        tokenEnv: settings.tokenEnv,
        authRef: settings.authRef,
        service: settings.service,
        profileId,
        profileSource: settings.profileSource,
      };
    }
    return {
      ok: false,
      error: `Missing GitHub token for profile "${profileId}" while ${DEFAULT_GITHUB_PREFER_ENV_TOKEN_ONLY_ENV}=true. Set ${settings.tokenEnv}, or unset ${DEFAULT_GITHUB_PREFER_ENV_TOKEN_ONLY_ENV} to allow saved local access.`,
      tokenEnv: settings.tokenEnv,
      authRef: settings.authRef,
      service: settings.service,
      profileId,
      profileSource: settings.profileSource,
    };
  }

  const stored = await store.get({
    service: settings.service,
    name: settings.authRef,
  });
  const storedEnvelope = parseStoredTokenEnvelope(stored);
  if (storedEnvelope?.token) {
    const stale =
      !!storedEnvelope.expiresAt &&
      isTokenExpiredSoon({ expiresAt: storedEnvelope.expiresAt, nowMs });
    if (!stale) {
      return {
        ok: true,
        token: storedEnvelope.token,
        source: "keychain",
        tokenEnv: settings.tokenEnv,
        authRef: settings.authRef,
        service: settings.service,
        profileId,
        profileSource: settings.profileSource,
        ...(storedEnvelope.expiresAt
          ? { expiresAt: storedEnvelope.expiresAt }
          : {}),
      };
    }
    const refreshed = await refreshGitHubInstallationToken({
      controlPlaneConfig: input.controlPlaneConfig,
      profileId,
      allowProjectOverride,
      env,
      store,
      fetcher: input.fetcher,
      nowMs,
    });
    if (refreshed.ok) {
      return {
        ok: true,
        token: refreshed.token,
        source: "refreshed",
        tokenEnv: settings.tokenEnv,
        authRef: settings.authRef,
        service: settings.service,
        profileId,
        profileSource: settings.profileSource,
        ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
      };
    }
    if (envToken.length > 0) {
      return {
        ok: true,
        token: envToken,
        source: "env",
        tokenEnv: settings.tokenEnv,
        authRef: settings.authRef,
        service: settings.service,
        profileId,
        profileSource: settings.profileSource,
      };
    }
    return {
      ok: false,
      error: `Stored GitHub token for profile "${profileId}" is expired and refresh failed: ${refreshed.error}`,
      tokenEnv: settings.tokenEnv,
      authRef: settings.authRef,
      service: settings.service,
      profileId,
      profileSource: settings.profileSource,
    };
  }

  if (envToken.length > 0) {
    return {
      ok: true,
      token: envToken,
      source: "env",
      tokenEnv: settings.tokenEnv,
      authRef: settings.authRef,
      service: settings.service,
      profileId,
      profileSource: settings.profileSource,
    };
  }

  return {
    ok: false,
    error: `Missing GitHub token for profile "${profileId}". Store one with \`hack x github connect --profile ${profileId}\`, or set ${settings.tokenEnv}.`,
    tokenEnv: settings.tokenEnv,
    authRef: settings.authRef,
    service: settings.service,
    profileId,
    profileSource: settings.profileSource,
  };
}

/**
 * Exchange a GitHub App JWT for an installation access token.
 */
export async function exchangeGitHubAppInstallationToken(input: {
  readonly appId: string;
  readonly installationId: string;
  readonly privateKey: string;
  readonly apiBaseUrl?: string;
  readonly fetcher?: FetchLike;
  readonly nowMs?: number;
}): Promise<GitHubInstallationTokenResult> {
  const appId = input.appId.trim();
  const installationId = input.installationId.trim();
  const privateKey = input.privateKey.trim();
  if (!(appId && installationId && privateKey)) {
    return {
      ok: false,
      status: 400,
      error:
        "GitHub App exchange requires appId, installationId, and privateKey.",
    };
  }

  let jwt: string;
  try {
    jwt = createGitHubAppJwt({
      appId,
      privateKeyPem: privateKey,
      nowMs: input.nowMs ?? Date.now(),
    });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "jwt_signing_failed";
    return {
      ok: false,
      status: 400,
      error: `GitHub App JWT signing failed: ${message}`,
    };
  }

  const fetcher = input.fetcher ?? fetch;
  const apiBase = normalizeApiBaseUrl({
    value: input.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE,
  });
  const url = `${apiBase}/app/installations/${installationId}/access_tokens`;
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "hack-cli",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error:
        parseGitHubApiError({ payload }) ??
        `${response.status} ${response.statusText}`,
    };
  }
  if (!(isRecord(payload) && typeof payload.token === "string")) {
    return {
      ok: false,
      status: 500,
      error: "Invalid GitHub installation token payload.",
    };
  }
  return {
    ok: true,
    token: payload.token,
    ...(typeof payload.expires_at === "string"
      ? { expiresAt: payload.expires_at }
      : {}),
  };
}

/**
 * Refresh and persist the GitHub installation token using configured App credentials.
 */
export async function refreshGitHubInstallationToken(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly profileId?: string;
  readonly allowProjectOverride?: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly store?: SecretStore;
  readonly fetcher?: FetchLike;
  readonly nowMs?: number;
}): Promise<
  | { readonly ok: true; readonly token: string; readonly expiresAt?: string }
  | { readonly ok: false; readonly error: string }
> {
  const resolved = resolveGitHubAuthSettingsResult({
    controlPlaneConfig: input.controlPlaneConfig,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    allowProjectOverride: input.allowProjectOverride,
  });
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.error,
    };
  }

  const settings = resolved.settings;
  const allowProjectOverride = input.allowProjectOverride ?? true;
  if (!(settings.appId && settings.installationId)) {
    return {
      ok: false,
      error: `GitHub App refresh is not configured for profile "${settings.profileId}". Set appId and installationId with \`hack x github connect --profile ${settings.profileId} --app-id ... --installation-id ...\`.`,
    };
  }

  const env = input.env ?? process.env;
  const store = input.store ?? DEFAULT_SECRET_STORE;
  const privateKey = await resolveGitHubPrivateKey({
    settings,
    env,
    store,
  });
  if (!privateKey.ok) {
    return privateKey;
  }

  const exchanged = await exchangeGitHubAppInstallationToken({
    appId: settings.appId,
    installationId: settings.installationId,
    privateKey: privateKey.privateKey,
    apiBaseUrl: settings.apiBaseUrl,
    fetcher: input.fetcher,
    nowMs: input.nowMs,
  });
  if (!exchanged.ok) {
    return { ok: false, error: exchanged.error };
  }

  await saveGitHubAppToken({
    controlPlaneConfig: input.controlPlaneConfig,
    profileId: settings.profileId,
    allowProjectOverride,
    token: exchanged.token,
    ...(exchanged.expiresAt ? { expiresAt: exchanged.expiresAt } : {}),
    store,
  });
  return {
    ok: true,
    token: exchanged.token,
    ...(exchanged.expiresAt ? { expiresAt: exchanged.expiresAt } : {}),
  };
}

/**
 * Persist GitHub token into secret storage under the configured `authRef`.
 */
export async function saveGitHubAppToken(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly profileId?: string;
  readonly allowProjectOverride?: boolean;
  readonly token: string;
  readonly expiresAt?: string;
  readonly authRef?: string;
  readonly service?: string;
  readonly store?: SecretStore;
}): Promise<{
  readonly profileId: string;
  readonly authRef: string;
  readonly service: string;
}> {
  const settings = resolveGitHubAuthSettings({
    controlPlaneConfig: input.controlPlaneConfig,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    allowProjectOverride: input.allowProjectOverride,
  });
  const authRef = (input.authRef ?? settings.authRef).trim();
  const service = (input.service ?? settings.service).trim();
  const token = input.token.trim();
  const store = input.store ?? DEFAULT_SECRET_STORE;

  if (!authRef) {
    throw new Error("Missing GitHub authRef");
  }
  if (!service) {
    throw new Error("Missing GitHub auth service");
  }
  if (!token) {
    throw new Error("Missing GitHub token");
  }

  const serialized = serializeStoredToken({
    token,
    ...(input.expiresAt ? { expiresAt: input.expiresAt.trim() } : {}),
  });

  await store.set({
    service,
    name: authRef,
    value: serialized,
  });
  return { profileId: settings.profileId, authRef, service };
}

/**
 * Remove a stored GitHub token by auth reference.
 */
export async function deleteGitHubAppToken(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly profileId?: string;
  readonly allowProjectOverride?: boolean;
  readonly authRef?: string;
  readonly service?: string;
  readonly store?: SecretStore;
}): Promise<{
  readonly profileId: string;
  readonly deleted: boolean;
  readonly authRef: string;
  readonly service: string;
}> {
  const settings = resolveGitHubAuthSettings({
    controlPlaneConfig: input.controlPlaneConfig,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    allowProjectOverride: input.allowProjectOverride,
  });
  const authRef = (input.authRef ?? settings.authRef).trim();
  const service = (input.service ?? settings.service).trim();
  const store = input.store ?? DEFAULT_SECRET_STORE;

  if (!authRef) {
    throw new Error("Missing GitHub authRef");
  }
  if (!service) {
    throw new Error("Missing GitHub auth service");
  }

  const deleted = await store.delete({ service, name: authRef });
  return { profileId: settings.profileId, deleted, authRef, service };
}

function normalizeConfigString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function normalizeConfigNumberishString(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function normalizeGitHubAuthMode(value: unknown): GitHubAuthMode | null {
  const normalized = normalizeConfigString(value)?.toLowerCase();
  if (normalized === "app" || normalized === "token") {
    return normalized;
  }
  return null;
}

function resolveDefaultAuthRefForProfile(input: {
  readonly profileId: string;
}): string {
  if (input.profileId === DEFAULT_GITHUB_PROFILE_ID) {
    return DEFAULT_GITHUB_AUTH_REF;
  }
  return `github.app.${input.profileId}`;
}

function getGitHubExtensionConfig(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
}): Record<string, unknown> | null {
  const extension = input.controlPlaneConfig.extensions?.[GITHUB_EXTENSION_ID];
  if (!(isRecord(extension) && isRecord(extension.config))) {
    return null;
  }
  return extension.config;
}

function buildGitHubProfileSettings(input: {
  readonly profileId: string;
  readonly profileConfig: Record<string, unknown> | null;
  readonly legacyConfig: Record<string, unknown> | null;
  readonly includeLegacyFallback: boolean;
}): GitHubProfileSettings {
  const fallback = input.includeLegacyFallback ? input.legacyConfig : null;
  const tokenEnv =
    normalizeConfigString(input.profileConfig?.tokenEnv) ??
    normalizeConfigString(fallback?.tokenEnv) ??
    DEFAULT_GITHUB_TOKEN_ENV;
  const authRef =
    normalizeConfigString(input.profileConfig?.authRef) ??
    normalizeConfigString(fallback?.authRef) ??
    resolveDefaultAuthRefForProfile({ profileId: input.profileId });
  const service =
    normalizeConfigString(input.profileConfig?.service) ??
    normalizeConfigString(fallback?.service) ??
    GITHUB_SECRET_SERVICE;
  const appId =
    normalizeConfigString(input.profileConfig?.appId) ??
    normalizeConfigString(fallback?.appId);
  const installationId =
    normalizeConfigString(input.profileConfig?.installationId) ??
    normalizeConfigString(fallback?.installationId);
  const privateKeyEnv =
    normalizeConfigString(input.profileConfig?.privateKeyEnv) ??
    normalizeConfigString(fallback?.privateKeyEnv) ??
    DEFAULT_GITHUB_PRIVATE_KEY_ENV;
  const privateKeyAuthRef =
    normalizeConfigString(input.profileConfig?.privateKeyAuthRef) ??
    normalizeConfigString(fallback?.privateKeyAuthRef);
  const apiBaseUrl = normalizeApiBaseUrl({
    value:
      normalizeConfigString(input.profileConfig?.apiBaseUrl) ??
      normalizeConfigString(fallback?.apiBaseUrl) ??
      DEFAULT_GITHUB_API_BASE,
  });
  const accountLogin =
    normalizeConfigString(input.profileConfig?.accountLogin) ??
    normalizeConfigString(fallback?.accountLogin);
  const accountName =
    normalizeConfigString(input.profileConfig?.accountName) ??
    normalizeConfigString(fallback?.accountName);
  const accountId =
    normalizeConfigNumberishString(input.profileConfig?.accountId) ??
    normalizeConfigNumberishString(fallback?.accountId);

  const mode =
    normalizeGitHubAuthMode(input.profileConfig?.mode) ??
    normalizeGitHubAuthMode(fallback?.mode) ??
    (appId && installationId ? "app" : "token");

  return {
    profileId: input.profileId,
    tokenEnv,
    authRef,
    service,
    ...(appId ? { appId } : {}),
    ...(installationId ? { installationId } : {}),
    privateKeyEnv,
    ...(privateKeyAuthRef ? { privateKeyAuthRef } : {}),
    apiBaseUrl,
    mode,
    ...(accountLogin ? { accountLogin } : {}),
    ...(accountName ? { accountName } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

function resolveProjectGitHubProfileOverride(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
}): string | null {
  const routingOverrides = input.controlPlaneConfig.routing?.overrides;
  if (!isRecord(routingOverrides)) {
    return null;
  }
  const nestedGitHub = routingOverrides.github;
  if (isRecord(nestedGitHub)) {
    const nestedProfile = normalizeConfigString(nestedGitHub.profile);
    if (nestedProfile) {
      return nestedProfile;
    }
  }
  return normalizeConfigString(routingOverrides.githubProfile);
}

function resolveGitHubProfileSelection(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly explicitProfileId?: string;
  readonly allowProjectOverride?: boolean;
}): GitHubProfileSelection {
  const extensionConfig = getGitHubExtensionConfig({
    controlPlaneConfig: input.controlPlaneConfig,
  });

  const profilesById: Record<string, GitHubProfileSettings> = {};
  const profilesValue = extensionConfig?.profiles;
  if (isRecord(profilesValue)) {
    for (const [profileIdRaw, profileRaw] of Object.entries(profilesValue)) {
      const profileId = profileIdRaw.trim();
      if (!profileId) {
        continue;
      }
      if (!isRecord(profileRaw)) {
        continue;
      }
      profilesById[profileId] = buildGitHubProfileSettings({
        profileId,
        profileConfig: profileRaw,
        legacyConfig: extensionConfig,
        includeLegacyFallback: profileId === DEFAULT_GITHUB_PROFILE_ID,
      });
    }
  }

  if (Object.keys(profilesById).length === 0) {
    profilesById[DEFAULT_GITHUB_PROFILE_ID] = buildGitHubProfileSettings({
      profileId: DEFAULT_GITHUB_PROFILE_ID,
      profileConfig: null,
      legacyConfig: extensionConfig,
      includeLegacyFallback: true,
    });
  }

  const sortedProfileIds = Object.keys(profilesById).sort((left, right) =>
    left.localeCompare(right)
  );
  const defaultProfileFromConfig = normalizeConfigString(
    extensionConfig?.defaultProfile
  );
  const defaultProfileId =
    (defaultProfileFromConfig &&
    Object.hasOwn(profilesById, defaultProfileFromConfig)
      ? defaultProfileFromConfig
      : null) ??
    (Object.hasOwn(profilesById, DEFAULT_GITHUB_PROFILE_ID)
      ? DEFAULT_GITHUB_PROFILE_ID
      : null) ??
    sortedProfileIds[0] ??
    DEFAULT_GITHUB_PROFILE_ID;

  const explicitProfileId = normalizeConfigString(input.explicitProfileId);
  const projectProfileOverride =
    input.allowProjectOverride === false
      ? null
      : resolveProjectGitHubProfileOverride({
          controlPlaneConfig: input.controlPlaneConfig,
        });

  const selectedProfile = explicitProfileId ?? projectProfileOverride;
  let selectedProfileId: string;
  let selectedProfileSource: GitHubProfileSelectionSource;
  if (selectedProfile) {
    selectedProfileId = selectedProfile;
    selectedProfileSource = explicitProfileId
      ? "command_flags"
      : "project_routing";
  } else if (defaultProfileFromConfig) {
    selectedProfileId = defaultProfileId;
    selectedProfileSource = "global_default";
  } else {
    selectedProfileId = defaultProfileId;
    selectedProfileSource = "implicit_default";
  }

  const selectedProfileExists = Object.hasOwn(profilesById, selectedProfileId);
  return {
    selectedProfileId,
    selectedProfileSource,
    selectedProfileExists,
    defaultProfileId,
    sortedProfileIds,
    profilesById,
    ...(projectProfileOverride ? { projectProfileOverride } : {}),
  };
}

function toGitHubProfileSummary(input: {
  readonly profile: GitHubProfileSettings;
  readonly isDefault: boolean;
}): GitHubAuthProfileSummary {
  return {
    id: input.profile.profileId,
    isDefault: input.isDefault,
    mode: input.profile.mode,
    authRef: input.profile.authRef,
    service: input.profile.service,
    ...(input.profile.appId ? { appId: input.profile.appId } : {}),
    ...(input.profile.installationId
      ? { installationId: input.profile.installationId }
      : {}),
    ...(input.profile.accountLogin
      ? { accountLogin: input.profile.accountLogin }
      : {}),
    ...(input.profile.accountName
      ? { accountName: input.profile.accountName }
      : {}),
    ...(input.profile.accountId ? { accountId: input.profile.accountId } : {}),
  };
}

function serializeStoredToken(input: GitHubTokenEnvelope): string {
  return JSON.stringify({
    token: input.token,
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  });
}

function parseStoredTokenEnvelope(
  value: string | null
): GitHubTokenEnvelope | null {
  const text = value?.trim() ?? "";
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!(isRecord(parsed) && typeof parsed.token === "string")) {
      return { token: text };
    }
    const token = parsed.token.trim();
    if (!token) {
      return null;
    }
    return {
      token,
      ...(typeof parsed.expiresAt === "string"
        ? { expiresAt: parsed.expiresAt }
        : {}),
    };
  } catch {
    return { token: text };
  }
}

function isTokenExpiredSoon(input: {
  readonly expiresAt: string;
  readonly nowMs: number;
}): boolean {
  const expiresMs = Date.parse(input.expiresAt);
  if (!Number.isFinite(expiresMs)) {
    return false;
  }
  return expiresMs - input.nowMs <= TOKEN_REFRESH_SKEW_MS;
}

async function resolveGitHubPrivateKey(input: {
  readonly settings: GitHubAuthSettings;
  readonly env: Record<string, string | undefined>;
  readonly store: SecretStore;
}): Promise<
  | { readonly ok: true; readonly privateKey: string }
  | { readonly ok: false; readonly error: string }
> {
  if (input.settings.privateKeyAuthRef) {
    const stored = await input.store.get({
      service: input.settings.service,
      name: input.settings.privateKeyAuthRef,
    });
    const privateKey = stored?.trim() ?? "";
    if (privateKey) {
      return { ok: true, privateKey };
    }
  }

  const envKey = (input.env[input.settings.privateKeyEnv] ?? "").trim();
  if (envKey) {
    return { ok: true, privateKey: envKey };
  }

  return {
    ok: false,
    error: input.settings.privateKeyAuthRef
      ? `Missing GitHub App private key for profile "${input.settings.profileId}" in keychain ref ${input.settings.privateKeyAuthRef} and env ${input.settings.privateKeyEnv}.`
      : `Missing GitHub App private key for profile "${input.settings.profileId}" in ${input.settings.privateKeyEnv}.`,
  };
}

function createGitHubAppJwt(input: {
  readonly appId: string;
  readonly privateKeyPem: string;
  readonly nowMs: number;
}): string {
  const issuedAt = Math.floor(input.nowMs / 1000) - 60;
  const expiresAt = issuedAt + 9 * 60;
  const header = toBase64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = toBase64UrlJson({
    iat: issuedAt,
    exp: expiresAt,
    iss: input.appId,
  });
  const message = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(message);
  signer.end();
  const signature = signer.sign(createPrivateKey(input.privateKeyPem));
  return `${message}.${toBase64UrlBytes(signature)}`;
}

function toBase64UrlJson(value: Record<string, unknown>): string {
  return toBase64UrlBytes(Buffer.from(JSON.stringify(value), "utf8"));
}

function toBase64UrlBytes(value: Uint8Array): string {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function normalizeApiBaseUrl(input: { readonly value: string }): string {
  const trimmed = input.value.trim();
  if (!trimmed) {
    return DEFAULT_GITHUB_API_BASE;
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function parseGitHubApiError(input: {
  readonly payload: unknown;
}): string | null {
  if (!(isRecord(input.payload) && typeof input.payload.message === "string")) {
    return null;
  }
  return input.payload.message;
}

function parseOptionalBooleanFlag(
  value: string | undefined
): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  ) {
    return true;
  }
  if (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  ) {
    return false;
  }
  return undefined;
}
