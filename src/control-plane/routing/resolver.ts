import { isRecord } from "../../lib/guards.ts";

import type {
  ControlPlaneConfig,
  ProviderProfileConfig,
  ProviderRoutingMode,
} from "../sdk/config.ts";

const PROVIDER_HARD_DEFAULT = "railway";

const PROVIDER_EXTENSION_ID_BY_NAME: Readonly<Record<string, string>> = {
  aws: "dance.hack.aws",
  gcp: "dance.hack.gcp",
  hetzner: "dance.hack.hetzner",
  railway: "dance.hack.railway",
};

export type DispatchRouteDiagnostic = {
  readonly code:
    | "profile_not_found"
    | "profile_disabled"
    | "provider_disabled"
    | "provider_profile_mismatch"
    | "missing_auth_source"
    | "invalid_oauth_auth_ref";
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly hint?: string;
};

export type DispatchNodeDirective =
  | {
      readonly source: "command_flags";
      readonly nodeId: string;
    }
  | {
      readonly source: "controlPlane.nodeId";
      readonly nodeId: string;
    }
  | null;

export type DispatchProviderRouteSource =
  | "command_flags"
  | "project_routing"
  | "global_defaults"
  | "provider_hard_default";

export type DispatchProfileRouteSource =
  | "command_flags"
  | "project_routing"
  | "global_defaults"
  | "none";

export type DispatchProviderRoute = {
  readonly provider: string;
  readonly profileId?: string;
  readonly profileSource: DispatchProfileRouteSource;
  readonly providerSource: DispatchProviderRouteSource;
  readonly mode: ProviderRoutingMode;
  readonly bootstrapEnabled: boolean;
  readonly setAsProjectNode: boolean;
  readonly privateNetworking: boolean;
  readonly effectiveConfig: Record<string, unknown>;
};

export type DispatchRouteResolution = {
  readonly nodeDirective: DispatchNodeDirective;
  readonly providerRoute: DispatchProviderRoute;
  readonly diagnostics: readonly DispatchRouteDiagnostic[];
  readonly hasErrors: boolean;
};

export type ResolveDispatchRouteInput = {
  readonly config: ControlPlaneConfig;
  readonly commandNode?: string;
  readonly commandProvider?: string;
  readonly commandProfile?: string;
  readonly commandBootstrapIfNeeded?: boolean;
};

/**
 * Resolve node/provider route intent with deterministic precedence:
 * 1) command flags
 * 2) controlPlane.nodeId
 * 3) project routing provider/profile
 * 4) global provider defaults
 * 5) provider hard defaults
 */
export function resolveDispatchRoute(
  input: ResolveDispatchRouteInput
): DispatchRouteResolution {
  const diagnostics: DispatchRouteDiagnostic[] = [];
  const nodeDirective = resolveNodeDirective({
    commandNode: input.commandNode,
    projectNodeId: input.config.nodeId,
  });

  const requestedProfile = pickRequestedProfile({
    commandProfile: input.commandProfile,
    projectProfile: input.config.routing?.profile,
    globalProfile: input.config.providers.defaultProfile,
  });
  const requestedProvider = pickRequestedProvider({
    commandProvider: input.commandProvider,
    projectProvider: input.config.routing?.provider,
    globalProvider: input.config.providers.defaultProvider,
  });

  const profileId = requestedProfile.value;
  const profile = profileId
    ? input.config.providers.profiles[profileId]
    : undefined;

  if (profileId && !profile) {
    diagnostics.push({
      code: "profile_not_found",
      severity: "error",
      message: `Provider profile "${profileId}" was not found.`,
      hint: "Create it under controlPlane.providers.profiles or select a valid profile.",
    });
  }

  if (profile?.enabled === false) {
    diagnostics.push({
      code: "profile_disabled",
      severity: "error",
      message: `Provider profile "${profileId}" is disabled.`,
      hint: "Enable the profile or choose a different one.",
    });
  }

  const resolvedProvider = resolveProvider({
    requestedProvider,
    profile,
    profileSource: requestedProfile.source,
    diagnostics,
  });
  const mode = input.config.routing?.mode ?? "existing_only";
  const bootstrapEnabled =
    mode === "bootstrap_only" ||
    (mode === "prefer_existing_then_bootstrap" &&
      (input.commandBootstrapIfNeeded === true ||
        input.config.routing?.bootstrap?.enabled === true));
  const setAsProjectNode =
    input.config.routing?.bootstrap?.setAsProjectNode === true;

  const effectiveConfig = mergeRecords({
    base: profile?.config ?? {},
    override: isRecord(input.config.routing?.overrides)
      ? input.config.routing?.overrides
      : {},
  });
  const privateNetworking = parsePrivateNetworking({
    config: effectiveConfig,
  });

  maybeAddProviderDisabledDiagnostic({
    config: input.config,
    provider: resolvedProvider.provider,
    diagnostics,
  });
  maybeAddRailwayAuthDiagnostic({
    provider: resolvedProvider.provider,
    privateNetworking,
    effectiveConfig,
    diagnostics,
  });

  return {
    nodeDirective,
    providerRoute: {
      provider: resolvedProvider.provider,
      ...(profileId ? { profileId } : {}),
      profileSource: requestedProfile.source,
      providerSource: resolvedProvider.source,
      mode,
      bootstrapEnabled,
      setAsProjectNode,
      privateNetworking,
      effectiveConfig,
    },
    diagnostics,
    hasErrors: diagnostics.some((entry) => entry.severity === "error"),
  };
}

function resolveNodeDirective(input: {
  readonly commandNode?: string;
  readonly projectNodeId?: string;
}): DispatchNodeDirective {
  const commandNode = normalizeOptionalString(input.commandNode);
  if (commandNode && commandNode !== "auto" && commandNode !== "default") {
    return {
      source: "command_flags",
      nodeId: commandNode,
    };
  }
  const projectNodeId = normalizeOptionalString(input.projectNodeId);
  if (projectNodeId) {
    return {
      source: "controlPlane.nodeId",
      nodeId: projectNodeId,
    };
  }
  return null;
}

function pickRequestedProfile(input: {
  readonly commandProfile?: string;
  readonly projectProfile?: string;
  readonly globalProfile?: string;
}): {
  readonly value?: string;
  readonly source: DispatchProfileRouteSource;
} {
  const command = normalizeOptionalString(input.commandProfile);
  if (command) {
    return { value: command, source: "command_flags" };
  }
  const project = normalizeOptionalString(input.projectProfile);
  if (project) {
    return { value: project, source: "project_routing" };
  }
  const global = normalizeOptionalString(input.globalProfile);
  if (global) {
    return { value: global, source: "global_defaults" };
  }
  return { source: "none" };
}

function pickRequestedProvider(input: {
  readonly commandProvider?: string;
  readonly projectProvider?: string;
  readonly globalProvider?: string;
}): {
  readonly value?: string;
  readonly source: DispatchProviderRouteSource;
} {
  const command = normalizeOptionalString(input.commandProvider);
  if (command) {
    return { value: command, source: "command_flags" };
  }
  const project = normalizeOptionalString(input.projectProvider);
  if (project) {
    return { value: project, source: "project_routing" };
  }
  const global = normalizeOptionalString(input.globalProvider);
  if (global) {
    return { value: global, source: "global_defaults" };
  }
  return { source: "provider_hard_default" };
}

function resolveProvider(input: {
  readonly requestedProvider: {
    readonly value?: string;
    readonly source: DispatchProviderRouteSource;
  };
  readonly profile?: ProviderProfileConfig;
  readonly profileSource: DispatchProfileRouteSource;
  readonly diagnostics: DispatchRouteDiagnostic[];
}): {
  readonly provider: string;
  readonly source: DispatchProviderRouteSource;
} {
  const profileProvider = normalizeOptionalString(input.profile?.provider);
  const requestedProvider = normalizeOptionalString(
    input.requestedProvider.value
  );

  if (profileProvider) {
    if (requestedProvider && requestedProvider !== profileProvider) {
      input.diagnostics.push({
        code: "provider_profile_mismatch",
        severity: "warning",
        message: `Requested provider "${requestedProvider}" does not match profile provider "${profileProvider}".`,
        hint: "Profile provider wins. Pick a profile from the same provider to remove this warning.",
      });
    }
    if (input.profileSource === "command_flags") {
      return { provider: profileProvider, source: "command_flags" };
    }
    if (input.profileSource === "project_routing") {
      return { provider: profileProvider, source: "project_routing" };
    }
    return { provider: profileProvider, source: "global_defaults" };
  }

  if (requestedProvider) {
    return {
      provider: requestedProvider,
      source: input.requestedProvider.source,
    };
  }

  return { provider: PROVIDER_HARD_DEFAULT, source: "provider_hard_default" };
}

function maybeAddProviderDisabledDiagnostic(input: {
  readonly config: ControlPlaneConfig;
  readonly provider: string;
  readonly diagnostics: DispatchRouteDiagnostic[];
}): void {
  const extensionId = PROVIDER_EXTENSION_ID_BY_NAME[input.provider];
  if (!extensionId) {
    return;
  }
  const extension = input.config.extensions[extensionId];
  if (!extension) {
    return;
  }
  if (extension.enabled === false) {
    input.diagnostics.push({
      code: "provider_disabled",
      severity: "error",
      message: `Provider "${input.provider}" is disabled (extension ${extensionId}).`,
      hint: `Enable with: hack config set --global 'controlPlane.extensions["${extensionId}"].enabled' true`,
    });
  }
}

function maybeAddRailwayAuthDiagnostic(input: {
  readonly provider: string;
  readonly privateNetworking: boolean;
  readonly effectiveConfig: Record<string, unknown>;
  readonly diagnostics: DispatchRouteDiagnostic[];
}): void {
  if (input.provider !== "railway" || !input.privateNetworking) {
    return;
  }

  const auth = isRecord(input.effectiveConfig.auth)
    ? input.effectiveConfig.auth
    : {};
  const tailscaleAuthKey = normalizeOptionalString(
    input.effectiveConfig.tailscaleAuthKey ?? auth.tailscaleAuthKey
  );
  const tailscaleAuthKeyFromEnv = normalizeOptionalString(
    process.env.HACK_TAILSCALE_AUTH_KEY
  );

  if (tailscaleAuthKey || tailscaleAuthKeyFromEnv) {
    return;
  }
  input.diagnostics.push({
    code: "missing_auth_source",
    severity: "error",
    message: "Railway private routing requires tailscaleAuthKey.",
    hint: "Set tailscaleAuthKey in the selected profile, routing override, or HACK_TAILSCALE_AUTH_KEY.",
  });
}

function parsePrivateNetworking(input: {
  readonly config: Record<string, unknown>;
}): boolean {
  const privateNetworking = parseBoolean(input.config.privateNetworking);
  if (typeof privateNetworking === "boolean") {
    return privateNetworking;
  }
  const privateMode = parseBoolean(input.config.private);
  return privateMode === true;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function mergeRecords(input: {
  readonly base: Record<string, unknown>;
  readonly override: Record<string, unknown>;
}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input.base };
  for (const [key, value] of Object.entries(input.override)) {
    if (value === undefined) {
      continue;
    }
    const existing = out[key];
    if (isRecord(existing) && isRecord(value)) {
      out[key] = mergeRecords({
        base: existing,
        override: value,
      });
      continue;
    }
    out[key] = value;
  }
  return out;
}
