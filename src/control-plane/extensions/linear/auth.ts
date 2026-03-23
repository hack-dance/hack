import { secrets } from "bun";

import { loadHackAuthSession } from "../../../lib/auth-session.ts";
import { isRecord } from "../../../lib/guards.ts";
import type { ControlPlaneConfig } from "../../sdk/config.ts";

const LINEAR_EXTENSION_ID = "dance.hack.linear";
const DEFAULT_LINEAR_PROFILE_ID = "default";
const DEFAULT_LINEAR_TOKEN_ENV = "HACK_LINEAR_API_TOKEN";
const DEFAULT_LINEAR_AUTH_REF = "linear.api.default";
const DEFAULT_LINEAR_SECRET_SERVICE = "hack-linear-auth";
const DEFAULT_LINEAR_API_URL = "https://api.linear.app/graphql";
const TRAILING_SLASH_REGEX = /\/+$/;

export type LinearProfileSelectionSource =
  | "command_flags"
  | "project_routing"
  | "global_default"
  | "implicit_default";

export type LinearAuthSettings = {
  readonly profileId: string;
  readonly profileSource: LinearProfileSelectionSource;
  readonly tokenEnv: string;
  readonly authRef: string;
  readonly service: string;
  readonly apiUrl: string;
  readonly accountId?: string;
  readonly accountName?: string;
  readonly accountEmail?: string;
};

export type LinearAuthProfileSummary = {
  readonly id: string;
  readonly isDefault: boolean;
  readonly authRef: string;
  readonly service: string;
  readonly tokenEnv: string;
  readonly apiUrl: string;
  readonly accountId?: string;
  readonly accountName?: string;
  readonly accountEmail?: string;
};

export type LinearAuthProfileCatalog = {
  readonly defaultProfileId: string;
  readonly selectedProfileId: string;
  readonly selectedProfileSource: LinearProfileSelectionSource;
  readonly selectedProfileMissing: boolean;
  readonly projectProfileOverride?: string;
  readonly profiles: readonly LinearAuthProfileSummary[];
};

export type LinearAuthSettingsResult =
  | {
      readonly ok: true;
      readonly settings: LinearAuthSettings;
      readonly availableProfileIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly selectedProfileId: string;
      readonly selectedProfileSource: LinearProfileSelectionSource;
      readonly availableProfileIds: readonly string[];
      readonly error: string;
    };

export type LinearTokenResolution =
  | {
      readonly ok: true;
      readonly token: string;
      readonly source: "keychain" | "env" | "refreshed";
      readonly tokenEnv: string;
      readonly authRef: string;
      readonly service: string;
      readonly profileId: string;
      readonly profileSource: LinearProfileSelectionSource;
      readonly expiresAt?: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly tokenEnv: string;
      readonly authRef: string;
      readonly service: string;
      readonly profileId: string;
      readonly profileSource: LinearProfileSelectionSource;
    };

export type LinearRefreshConfig = {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
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

type LinearProfileSettings = {
  readonly profileId: string;
  readonly tokenEnv: string;
  readonly authRef: string;
  readonly service: string;
  readonly apiUrl: string;
  readonly accountId?: string;
  readonly accountName?: string;
  readonly accountEmail?: string;
};

type LinearTokenEnvelope = {
  readonly token?: string;
  readonly expiresAt?: string;
  readonly refreshToken?: string;
  readonly refreshTokenExpiresAt?: string;
  readonly managementToken?: string;
  readonly managementTokenExpiresAt?: string;
};

export type LinearStoredTokenEnvelope = LinearTokenEnvelope;

type LinearProfileSelection = {
  readonly selectedProfileId: string;
  readonly selectedProfileSource: LinearProfileSelectionSource;
  readonly selectedProfileExists: boolean;
  readonly defaultProfileId: string;
  readonly sortedProfileIds: readonly string[];
  readonly profilesById: Readonly<Record<string, LinearProfileSettings>>;
  readonly projectProfileOverride?: string;
};

const DEFAULT_SECRET_STORE: SecretStore = {
  get: async (input) => await secrets.get(input),
  set: async (input) => {
    await secrets.set(input);
  },
  delete: async (input) => await secrets.delete(input),
};

const TOKEN_REFRESH_WINDOW_MS = 60_000;

/**
 * Resolve Linear profile catalog using command flags, project overrides, and global defaults.
 */
export function listLinearAuthProfiles(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly explicitProfileId?: string;
  readonly allowProjectOverride?: boolean;
}): LinearAuthProfileCatalog {
  const selected = resolveLinearProfileSelection({
    controlPlaneConfig: input.controlPlaneConfig,
    explicitProfileId: input.explicitProfileId,
    allowProjectOverride: input.allowProjectOverride,
  });
  const profiles: LinearAuthProfileSummary[] = [];
  for (const id of selected.sortedProfileIds) {
    const profile = selected.profilesById[id];
    if (!profile) {
      continue;
    }
    profiles.push({
      id: profile.profileId,
      isDefault: id === selected.defaultProfileId,
      authRef: profile.authRef,
      service: profile.service,
      tokenEnv: profile.tokenEnv,
      apiUrl: profile.apiUrl,
      ...(profile.accountId ? { accountId: profile.accountId } : {}),
      ...(profile.accountName ? { accountName: profile.accountName } : {}),
      ...(profile.accountEmail ? { accountEmail: profile.accountEmail } : {}),
    });
  }

  return {
    defaultProfileId: selected.defaultProfileId,
    selectedProfileId: selected.selectedProfileId,
    selectedProfileSource: selected.selectedProfileSource,
    selectedProfileMissing: !selected.selectedProfileExists,
    ...(selected.projectProfileOverride
      ? { projectProfileOverride: selected.projectProfileOverride }
      : {}),
    profiles,
  };
}

/**
 * Resolve Linear auth settings from extension config + profile selection.
 */
export function resolveLinearAuthSettings(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly profileId?: string;
  readonly allowProjectOverride?: boolean;
}): LinearAuthSettings {
  const selected = resolveLinearProfileSelection({
    controlPlaneConfig: input.controlPlaneConfig,
    explicitProfileId: input.profileId,
    allowProjectOverride: input.allowProjectOverride,
  });
  const profile = selected.profilesById[selected.selectedProfileId];
  if (profile) {
    return {
      ...profile,
      profileSource: selected.selectedProfileSource,
    };
  }

  const extensionConfig = getLinearExtensionConfig({
    controlPlaneConfig: input.controlPlaneConfig,
  });
  const fallback = buildLinearProfileSettings({
    profileId: selected.selectedProfileId,
    profileConfig: null,
    legacyConfig: extensionConfig,
    includeLegacyFallback: true,
  });
  return {
    ...fallback,
    profileSource: selected.selectedProfileSource,
  };
}

/**
 * Resolve Linear auth settings and fail when selected profile is missing.
 */
export function resolveLinearAuthSettingsResult(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly profileId?: string;
  readonly allowProjectOverride?: boolean;
}): LinearAuthSettingsResult {
  const selected = resolveLinearProfileSelection({
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
        return "controlPlane.routing.overrides.linear.profile";
      }
      if (selected.selectedProfileSource === "global_default") {
        return `controlPlane.extensions["${LINEAR_EXTENSION_ID}"].config.defaultProfile`;
      }
      return "implicit default";
    })();
    const availableLabel =
      availableProfileIds.length > 0
        ? availableProfileIds.join(", ")
        : "(none configured)";
    const fixLabel = (() => {
      if (selected.selectedProfileSource === "command_flags") {
        return `Use one of the available profiles with \`--profile <id>\`, or run \`hack linear connect --profile ${selected.selectedProfileId}\` to create it.`;
      }
      if (selected.selectedProfileSource === "project_routing") {
        return `Update the repo route with \`hack linear setup --profile <id>\` or connect the missing profile with \`hack linear connect --profile ${selected.selectedProfileId}\`.`;
      }
      if (selected.selectedProfileSource === "global_default") {
        return `Switch the global default with \`hack linear use --profile <id>\` or connect the missing profile with \`hack linear connect --profile ${selected.selectedProfileId}\`.`;
      }
      return `Connect a profile with \`hack linear connect --profile ${selected.selectedProfileId}\` or choose one with \`hack linear use --profile <id>\`.`;
    })();
    return {
      ok: false,
      selectedProfileId: selected.selectedProfileId,
      selectedProfileSource: selected.selectedProfileSource,
      availableProfileIds,
      error: `Linear profile "${selected.selectedProfileId}" (${sourceLabel}) was not found. Available profiles: ${availableLabel}. ${fixLabel}`,
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
 * Resolve a Linear API token using keychain first, then env fallback.
 */
export async function resolveLinearToken(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly profileId?: string;
  readonly allowProjectOverride?: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly store?: SecretStore;
  readonly refreshConfig?: LinearRefreshConfig;
  readonly nowMs?: number;
}): Promise<LinearTokenResolution> {
  const resolved = resolveLinearAuthSettingsResult({
    controlPlaneConfig: input.controlPlaneConfig,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    allowProjectOverride: input.allowProjectOverride,
  });

  if (!resolved.ok) {
    const fallback = resolveLinearAuthSettings({
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
  const env = input.env ?? process.env;
  const store = input.store ?? DEFAULT_SECRET_STORE;
  const nowMs = input.nowMs ?? Date.now();

  const stored = await store.get({
    service: settings.service,
    name: settings.authRef,
  });
  let storedEnvelope = parseStoredTokenEnvelope(stored);
  let refreshError: string | null = null;
  let refreshedToken = false;
  if (
    storedEnvelope &&
    shouldRefreshStoredToken({
      envelope: storedEnvelope,
      nowMs,
    }) &&
    input.refreshConfig
  ) {
    const refreshed = await refreshLinearAccessToken({
      refreshConfig: input.refreshConfig,
      refreshToken: storedEnvelope.refreshToken ?? "",
      currentRefreshTokenExpiresAt: storedEnvelope.refreshTokenExpiresAt,
    });
    if (refreshed.ok) {
      refreshedToken = true;
      const nextRefreshToken =
        refreshed.refreshToken ?? storedEnvelope.refreshToken;
      const nextRefreshTokenExpiresAt =
        refreshed.refreshTokenExpiresAt ?? storedEnvelope.refreshTokenExpiresAt;
      storedEnvelope = {
        token: refreshed.token,
        ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
        ...(nextRefreshToken ? { refreshToken: nextRefreshToken } : {}),
        ...(nextRefreshTokenExpiresAt
          ? { refreshTokenExpiresAt: nextRefreshTokenExpiresAt }
          : {}),
      };
      try {
        await store.set({
          service: settings.service,
          name: settings.authRef,
          value: serializeStoredToken(storedEnvelope),
        });
      } catch {
        // Best effort: use the fresh token for this command even if re-persist fails.
      }
    } else if (
      isUsableStoredAccessToken({
        envelope: storedEnvelope,
        nowMs,
      })
    ) {
      return {
        ok: true,
        token: storedEnvelope.token ?? "",
        source: "keychain",
        tokenEnv: settings.tokenEnv,
        authRef: settings.authRef,
        service: settings.service,
        profileId: settings.profileId,
        profileSource: settings.profileSource,
        ...(storedEnvelope.expiresAt
          ? { expiresAt: storedEnvelope.expiresAt }
          : {}),
      };
    } else {
      refreshError = refreshed.error;
    }
  }

  if (
    storedEnvelope?.token &&
    isUsableStoredAccessToken({ envelope: storedEnvelope, nowMs })
  ) {
    return {
      ok: true,
      token: storedEnvelope.token,
      source: refreshedToken ? "refreshed" : "keychain",
      tokenEnv: settings.tokenEnv,
      authRef: settings.authRef,
      service: settings.service,
      profileId: settings.profileId,
      profileSource: settings.profileSource,
      ...(storedEnvelope.expiresAt
        ? { expiresAt: storedEnvelope.expiresAt }
        : {}),
    };
  }

  const envToken = (env[settings.tokenEnv] ?? "").trim();
  if (envToken) {
    return {
      ok: true,
      token: envToken,
      source: "env",
      tokenEnv: settings.tokenEnv,
      authRef: settings.authRef,
      service: settings.service,
      profileId: settings.profileId,
      profileSource: settings.profileSource,
    };
  }

  return {
    ok: false,
    error:
      refreshError ??
      `Missing Linear token for profile "${settings.profileId}". Store one with \`hack x linear connect --profile ${settings.profileId}\`, or set ${settings.tokenEnv}.`,
    tokenEnv: settings.tokenEnv,
    authRef: settings.authRef,
    service: settings.service,
    profileId: settings.profileId,
    profileSource: settings.profileSource,
  };
}

/**
 * Persist a Linear token in keychain under the selected profile auth reference.
 */
export async function saveLinearToken(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly profileId?: string;
  readonly allowProjectOverride?: boolean;
  readonly token: string;
  readonly expiresAt?: string;
  readonly refreshToken?: string;
  readonly refreshTokenExpiresAt?: string;
  readonly managementToken?: string;
  readonly managementTokenExpiresAt?: string;
  readonly authRef?: string;
  readonly service?: string;
  readonly store?: SecretStore;
}): Promise<{
  readonly profileId: string;
  readonly authRef: string;
  readonly service: string;
}> {
  const settings = resolveLinearAuthSettings({
    controlPlaneConfig: input.controlPlaneConfig,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    allowProjectOverride: input.allowProjectOverride,
  });
  const authRef = (input.authRef ?? settings.authRef).trim();
  const service = (input.service ?? settings.service).trim();
  const token = input.token.trim();
  const store = input.store ?? DEFAULT_SECRET_STORE;

  if (!authRef) {
    throw new Error("Missing Linear authRef");
  }
  if (!service) {
    throw new Error("Missing Linear secret service");
  }
  if (!token) {
    throw new Error("Missing Linear token");
  }

  const serialized = serializeStoredToken({
    token,
    ...(input.expiresAt ? { expiresAt: input.expiresAt.trim() } : {}),
    ...(input.refreshToken ? { refreshToken: input.refreshToken.trim() } : {}),
    ...(input.refreshTokenExpiresAt
      ? { refreshTokenExpiresAt: input.refreshTokenExpiresAt.trim() }
      : {}),
    ...(input.managementToken
      ? { managementToken: input.managementToken.trim() }
      : {}),
    ...(input.managementTokenExpiresAt
      ? { managementTokenExpiresAt: input.managementTokenExpiresAt.trim() }
      : {}),
  });
  await store.set({
    service,
    name: authRef,
    value: serialized,
  });

  return {
    profileId: settings.profileId,
    authRef,
    service,
  };
}

/**
 * Resolve a stored broker management token for Linear protected broker routes.
 */
export async function resolveLinearBrokerManagementToken(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly profileId?: string;
  readonly allowProjectOverride?: boolean;
  readonly authRef?: string;
  readonly service?: string;
  readonly store?: SecretStore;
}): Promise<
  | {
      readonly ok: true;
      readonly managementToken: string;
      readonly managementTokenExpiresAt?: string;
      readonly profileId: string;
      readonly authRef: string;
      readonly service: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly profileId: string;
      readonly authRef: string;
      readonly service: string;
    }
> {
  const settings = resolveLinearAuthSettings({
    controlPlaneConfig: input.controlPlaneConfig,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    allowProjectOverride: input.allowProjectOverride,
  });
  const authRef = (input.authRef ?? settings.authRef).trim();
  const service = (input.service ?? settings.service).trim();
  const store = input.store ?? DEFAULT_SECRET_STORE;
  const stored = await store.get({
    service,
    name: authRef,
  });
  const envelope = parseStoredTokenEnvelope(stored);
  const managementToken = envelope?.managementToken?.trim() ?? "";
  if (!managementToken) {
    const genericHackSession = await loadHackAuthSession().catch(() => null);
    const genericManagementToken = genericHackSession?.token?.trim() ?? "";
    if (genericManagementToken) {
      return {
        ok: true,
        managementToken: genericManagementToken,
        ...(genericHackSession?.expiresAt
          ? { managementTokenExpiresAt: genericHackSession.expiresAt }
          : {}),
        profileId: settings.profileId,
        authRef,
        service,
      };
    }
    return {
      ok: false,
      error: `Linear broker management token is missing for profile "${settings.profileId}". Run \`hack auth login\` for broker-owned access, or reconnect this Linear profile if its saved broker token is stale.`,
      profileId: settings.profileId,
      authRef,
      service,
    };
  }
  const managementTokenExpiresAtMs = envelope?.managementTokenExpiresAt
    ? parseTimestampMs(envelope.managementTokenExpiresAt)
    : null;
  if (
    envelope?.managementTokenExpiresAt &&
    managementTokenExpiresAtMs !== null &&
    managementTokenExpiresAtMs <= Date.now()
  ) {
    const genericHackSession = await loadHackAuthSession().catch(() => null);
    const genericManagementToken = genericHackSession?.token?.trim() ?? "";
    if (genericManagementToken) {
      return {
        ok: true,
        managementToken: genericManagementToken,
        ...(genericHackSession?.expiresAt
          ? { managementTokenExpiresAt: genericHackSession.expiresAt }
          : {}),
        profileId: settings.profileId,
        authRef,
        service,
      };
    }
    return {
      ok: false,
      error: `Linear broker management token expired for profile "${settings.profileId}". Run \`hack auth login\` for broker-owned access, or reconnect this Linear profile to refresh its saved broker token.`,
      profileId: settings.profileId,
      authRef,
      service,
    };
  }
  return {
    ok: true,
    managementToken,
    ...(envelope?.managementTokenExpiresAt
      ? { managementTokenExpiresAt: envelope.managementTokenExpiresAt }
      : {}),
    profileId: settings.profileId,
    authRef,
    service,
  };
}

/**
 * Read the currently stored Linear token envelope for a selected profile.
 */
export async function readStoredLinearTokenEnvelope(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly profileId?: string;
  readonly allowProjectOverride?: boolean;
  readonly authRef?: string;
  readonly service?: string;
  readonly store?: SecretStore;
}): Promise<{
  readonly profileId: string;
  readonly authRef: string;
  readonly service: string;
  readonly envelope: LinearStoredTokenEnvelope | null;
}> {
  const settings = resolveLinearAuthSettings({
    controlPlaneConfig: input.controlPlaneConfig,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    allowProjectOverride: input.allowProjectOverride,
  });
  const authRef = (input.authRef ?? settings.authRef).trim();
  const service = (input.service ?? settings.service).trim();
  const store = input.store ?? DEFAULT_SECRET_STORE;
  const stored = await store.get({
    service,
    name: authRef,
  });
  return {
    profileId: settings.profileId,
    authRef,
    service,
    envelope: parseStoredTokenEnvelope(stored),
  };
}

/**
 * Delete a Linear token from keychain for the selected profile.
 */
export async function deleteLinearToken(input: {
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
  const settings = resolveLinearAuthSettings({
    controlPlaneConfig: input.controlPlaneConfig,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    allowProjectOverride: input.allowProjectOverride,
  });
  const authRef = (input.authRef ?? settings.authRef).trim();
  const service = (input.service ?? settings.service).trim();
  const store = input.store ?? DEFAULT_SECRET_STORE;

  if (!authRef) {
    throw new Error("Missing Linear authRef");
  }
  if (!service) {
    throw new Error("Missing Linear secret service");
  }

  const deleted = await store.delete({
    service,
    name: authRef,
  });

  return {
    profileId: settings.profileId,
    deleted,
    authRef,
    service,
  };
}

function getLinearExtensionConfig(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
}): Record<string, unknown> | null {
  const extension = input.controlPlaneConfig.extensions?.[LINEAR_EXTENSION_ID];
  if (!(isRecord(extension) && isRecord(extension.config))) {
    return null;
  }
  return extension.config;
}

function resolveProjectLinearProfileOverride(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
}): string | null {
  const routingOverrides = input.controlPlaneConfig.routing?.overrides;
  if (!isRecord(routingOverrides)) {
    return null;
  }
  const nested = routingOverrides.linear;
  if (isRecord(nested)) {
    const nestedProfile = normalizeConfigString(nested.profile);
    if (nestedProfile) {
      return nestedProfile;
    }
  }
  return normalizeConfigString(routingOverrides.linearProfile);
}

function resolveLinearProfileSelection(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly explicitProfileId?: string;
  readonly allowProjectOverride?: boolean;
}): LinearProfileSelection {
  const extensionConfig = getLinearExtensionConfig({
    controlPlaneConfig: input.controlPlaneConfig,
  });
  const profilesById: Record<string, LinearProfileSettings> = {};

  const profilesValue = extensionConfig?.profiles;
  if (isRecord(profilesValue)) {
    for (const [profileIdRaw, profileRaw] of Object.entries(profilesValue)) {
      const profileId = profileIdRaw.trim();
      if (!(profileId && isRecord(profileRaw))) {
        continue;
      }
      profilesById[profileId] = buildLinearProfileSettings({
        profileId,
        profileConfig: profileRaw,
        legacyConfig: extensionConfig,
        includeLegacyFallback: profileId === DEFAULT_LINEAR_PROFILE_ID,
      });
    }
  }

  if (Object.keys(profilesById).length === 0) {
    profilesById[DEFAULT_LINEAR_PROFILE_ID] = buildLinearProfileSettings({
      profileId: DEFAULT_LINEAR_PROFILE_ID,
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
    (Object.hasOwn(profilesById, DEFAULT_LINEAR_PROFILE_ID)
      ? DEFAULT_LINEAR_PROFILE_ID
      : null) ??
    sortedProfileIds[0] ??
    DEFAULT_LINEAR_PROFILE_ID;

  const explicitProfileId = normalizeConfigString(input.explicitProfileId);
  const projectProfileOverride =
    input.allowProjectOverride === false
      ? null
      : resolveProjectLinearProfileOverride({
          controlPlaneConfig: input.controlPlaneConfig,
        });

  const selectedProfile = explicitProfileId ?? projectProfileOverride;
  let selectedProfileId: string;
  let selectedProfileSource: LinearProfileSelectionSource;
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

function buildLinearProfileSettings(input: {
  readonly profileId: string;
  readonly profileConfig: Record<string, unknown> | null;
  readonly legacyConfig: Record<string, unknown> | null;
  readonly includeLegacyFallback: boolean;
}): LinearProfileSettings {
  const fallback = input.includeLegacyFallback ? input.legacyConfig : null;
  const tokenEnv =
    normalizeConfigString(input.profileConfig?.tokenEnv) ??
    normalizeConfigString(fallback?.tokenEnv) ??
    DEFAULT_LINEAR_TOKEN_ENV;
  const authRef =
    normalizeConfigString(input.profileConfig?.authRef) ??
    normalizeConfigString(fallback?.authRef) ??
    resolveDefaultAuthRefForProfile({ profileId: input.profileId });
  const service =
    normalizeConfigString(input.profileConfig?.service) ??
    normalizeConfigString(fallback?.service) ??
    DEFAULT_LINEAR_SECRET_SERVICE;
  const apiUrl = normalizeApiUrl({
    value:
      normalizeConfigString(input.profileConfig?.apiUrl) ??
      normalizeConfigString(fallback?.apiUrl) ??
      DEFAULT_LINEAR_API_URL,
  });
  const accountId =
    normalizeConfigString(input.profileConfig?.accountId) ??
    normalizeConfigString(fallback?.accountId);
  const accountName =
    normalizeConfigString(input.profileConfig?.accountName) ??
    normalizeConfigString(fallback?.accountName);
  const accountEmail =
    normalizeConfigString(input.profileConfig?.accountEmail) ??
    normalizeConfigString(fallback?.accountEmail);

  return {
    profileId: input.profileId,
    tokenEnv,
    authRef,
    service,
    apiUrl,
    ...(accountId ? { accountId } : {}),
    ...(accountName ? { accountName } : {}),
    ...(accountEmail ? { accountEmail } : {}),
  };
}

function serializeStoredToken(input: LinearTokenEnvelope): string {
  return JSON.stringify({
    ...(input.token ? { token: input.token } : {}),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    ...(input.refreshToken ? { refreshToken: input.refreshToken } : {}),
    ...(input.refreshTokenExpiresAt
      ? { refreshTokenExpiresAt: input.refreshTokenExpiresAt }
      : {}),
    ...(input.managementToken
      ? { managementToken: input.managementToken }
      : {}),
    ...(input.managementTokenExpiresAt
      ? { managementTokenExpiresAt: input.managementTokenExpiresAt }
      : {}),
  });
}

function parseStoredTokenEnvelope(
  value: string | null
): LinearTokenEnvelope | null {
  const text = value?.trim() ?? "";
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) {
      return { token: text };
    }
    const token =
      typeof parsed.token === "string" && parsed.token.trim().length > 0
        ? parsed.token.trim()
        : undefined;
    const refreshToken =
      typeof parsed.refreshToken === "string" &&
      parsed.refreshToken.trim().length > 0
        ? parsed.refreshToken.trim()
        : undefined;
    if (!(token || refreshToken)) {
      return null;
    }
    return {
      ...(token ? { token } : {}),
      ...(typeof parsed.expiresAt === "string"
        ? { expiresAt: parsed.expiresAt }
        : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(typeof parsed.refreshTokenExpiresAt === "string"
        ? { refreshTokenExpiresAt: parsed.refreshTokenExpiresAt }
        : {}),
      ...(typeof parsed.managementToken === "string" &&
      parsed.managementToken.trim().length > 0
        ? { managementToken: parsed.managementToken.trim() }
        : {}),
      ...(typeof parsed.managementTokenExpiresAt === "string"
        ? { managementTokenExpiresAt: parsed.managementTokenExpiresAt }
        : {}),
    };
  } catch {
    return { token: text };
  }
}

function shouldRefreshStoredToken(input: {
  readonly envelope: LinearTokenEnvelope;
  readonly nowMs: number;
}): boolean {
  if (!input.envelope.refreshToken) {
    return false;
  }
  if (!input.envelope.token) {
    return true;
  }
  const expiresAtMs = parseTimestampMs(input.envelope.expiresAt);
  if (expiresAtMs === null) {
    return false;
  }
  return expiresAtMs <= input.nowMs + TOKEN_REFRESH_WINDOW_MS;
}

function isUsableStoredAccessToken(input: {
  readonly envelope: LinearTokenEnvelope;
  readonly nowMs: number;
}): boolean {
  if (!input.envelope.token) {
    return false;
  }
  const expiresAtMs = parseTimestampMs(input.envelope.expiresAt);
  if (expiresAtMs === null) {
    return true;
  }
  return expiresAtMs > input.nowMs;
}

async function refreshLinearAccessToken(input: {
  readonly refreshConfig: LinearRefreshConfig;
  readonly refreshToken: string;
  readonly currentRefreshTokenExpiresAt?: string;
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
  const fetchImpl = input.refreshConfig.fetch ?? fetch;
  const endpoint = new URL(
    "/v1/auth/linear/refresh",
    `${trimTrailingSlash(input.refreshConfig.baseUrl)}/`
  ).toString();
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        refreshToken: input.refreshToken,
      }),
    });
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  if (!isRecord(payload)) {
    return {
      ok: false,
      error: `Linear refresh failed: invalid payload (${response.status})`,
    };
  }
  if (!response.ok || payload.ok === false) {
    const message =
      readOptionalString(payload.error) ??
      response.statusText ??
      "refresh_failed";
    return {
      ok: false,
      error: `Linear refresh failed: ${message}`,
    };
  }
  const token = readOptionalString(payload.token);
  if (!token) {
    return {
      ok: false,
      error: "Linear refresh failed: missing token",
    };
  }
  return {
    ok: true,
    token,
    ...((readOptionalString(payload.tokenExpiresAt) ??
    readOptionalString(payload.expiresAt))
      ? {
          expiresAt:
            readOptionalString(payload.tokenExpiresAt) ??
            readOptionalString(payload.expiresAt) ??
            undefined,
        }
      : {}),
    ...(readOptionalString(payload.refreshToken)
      ? { refreshToken: readOptionalString(payload.refreshToken) ?? undefined }
      : {}),
    ...resolveRefreshTokenExpiryOverride({
      payloadRefreshTokenExpiresAt: readOptionalString(
        payload.refreshTokenExpiresAt
      ),
      currentRefreshTokenExpiresAt: input.currentRefreshTokenExpiresAt,
    }),
  };
}

function parseTimestampMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function trimTrailingSlash(value: string): string {
  return value.replace(TRAILING_SLASH_REGEX, "");
}

function resolveRefreshTokenExpiryOverride(input: {
  readonly payloadRefreshTokenExpiresAt?: string | null;
  readonly currentRefreshTokenExpiresAt?: string;
}): { readonly refreshTokenExpiresAt?: string } {
  if (input.payloadRefreshTokenExpiresAt) {
    return {
      refreshTokenExpiresAt: input.payloadRefreshTokenExpiresAt,
    };
  }
  if (input.currentRefreshTokenExpiresAt) {
    return {
      refreshTokenExpiresAt: input.currentRefreshTokenExpiresAt,
    };
  }
  return {};
}

function normalizeConfigString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function resolveDefaultAuthRefForProfile(input: {
  readonly profileId: string;
}): string {
  if (input.profileId === DEFAULT_LINEAR_PROFILE_ID) {
    return DEFAULT_LINEAR_AUTH_REF;
  }
  return `linear.api.${input.profileId}`;
}

function normalizeApiUrl(input: { readonly value: string }): string {
  const trimmed = input.value.trim();
  if (!trimmed) {
    return DEFAULT_LINEAR_API_URL;
  }
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}
