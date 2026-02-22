import { createPrivateKey, createSign } from "node:crypto";
import { secrets } from "bun";
import { isRecord } from "../../../lib/guards.ts";
import type { ControlPlaneConfig } from "../../sdk/config.ts";

const GITHUB_EXTENSION_ID = "dance.hack.github";
const DEFAULT_GITHUB_TOKEN_ENV = "HACK_GITHUB_APP_TOKEN";
const DEFAULT_GITHUB_PRIVATE_KEY_ENV = "HACK_GITHUB_APP_PRIVATE_KEY";
const DEFAULT_GITHUB_AUTH_REF = "github.app.default";
const GITHUB_SECRET_SERVICE = "hack-github-auth";
const DEFAULT_GITHUB_API_BASE = "https://api.github.com";
const TOKEN_REFRESH_SKEW_MS = 60_000;

export type GitHubAuthSettings = {
  readonly tokenEnv: string;
  readonly authRef: string;
  readonly service: string;
  readonly appId?: string;
  readonly installationId?: string;
  readonly privateKeyEnv: string;
  readonly privateKeyAuthRef?: string;
  readonly apiBaseUrl: string;
};

export type GitHubTokenResolution =
  | {
      readonly ok: true;
      readonly token: string;
      readonly source: "keychain" | "env" | "refreshed";
      readonly tokenEnv: string;
      readonly authRef: string;
      readonly service: string;
      readonly expiresAt?: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly tokenEnv: string;
      readonly authRef: string;
      readonly service: string;
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

const DEFAULT_SECRET_STORE: SecretStore = {
  get: async (input) => await secrets.get(input),
  set: async (input) => {
    await secrets.set(input);
  },
  delete: async (input) => await secrets.delete(input),
};

/**
 * Resolve GitHub auth settings from control-plane extension config.
 *
 * The extension supports:
 * - `controlPlane.extensions["dance.hack.github"].config.tokenEnv`
 * - `controlPlane.extensions["dance.hack.github"].config.authRef`
 * - `controlPlane.extensions["dance.hack.github"].config.service`
 * - `controlPlane.extensions["dance.hack.github"].config.appId`
 * - `controlPlane.extensions["dance.hack.github"].config.installationId`
 * - `controlPlane.extensions["dance.hack.github"].config.privateKeyEnv`
 * - `controlPlane.extensions["dance.hack.github"].config.privateKeyAuthRef`
 * - `controlPlane.extensions["dance.hack.github"].config.apiBaseUrl`
 */
export function resolveGitHubAuthSettings(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
}): GitHubAuthSettings {
  const extension = input.controlPlaneConfig.extensions?.[GITHUB_EXTENSION_ID];
  const config =
    isRecord(extension) && isRecord(extension.config) ? extension.config : null;

  const tokenEnv = normalizeConfigString(config?.tokenEnv);
  const authRef = normalizeConfigString(config?.authRef);
  const service = normalizeConfigString(config?.service);
  const appId = normalizeConfigString(config?.appId);
  const installationId = normalizeConfigString(config?.installationId);
  const privateKeyEnv = normalizeConfigString(config?.privateKeyEnv);
  const privateKeyAuthRef = normalizeConfigString(config?.privateKeyAuthRef);
  const apiBaseUrl = normalizeConfigString(config?.apiBaseUrl);

  return {
    tokenEnv: tokenEnv ?? DEFAULT_GITHUB_TOKEN_ENV,
    authRef: authRef ?? DEFAULT_GITHUB_AUTH_REF,
    service: service ?? GITHUB_SECRET_SERVICE,
    ...(appId ? { appId } : {}),
    ...(installationId ? { installationId } : {}),
    privateKeyEnv: privateKeyEnv ?? DEFAULT_GITHUB_PRIVATE_KEY_ENV,
    ...(privateKeyAuthRef ? { privateKeyAuthRef } : {}),
    apiBaseUrl: apiBaseUrl ?? DEFAULT_GITHUB_API_BASE,
  };
}

/**
 * Resolve a GitHub App token using keychain first, then environment fallback.
 */
export async function resolveGitHubAppToken(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly env?: Record<string, string | undefined>;
  readonly store?: SecretStore;
  readonly fetcher?: FetchLike;
  readonly nowMs?: number;
}): Promise<GitHubTokenResolution> {
  const settings = resolveGitHubAuthSettings({
    controlPlaneConfig: input.controlPlaneConfig,
  });
  const env = input.env ?? process.env;
  const store = input.store ?? DEFAULT_SECRET_STORE;
  const nowMs = input.nowMs ?? Date.now();

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
        ...(storedEnvelope.expiresAt
          ? { expiresAt: storedEnvelope.expiresAt }
          : {}),
      };
    }
    const refreshed = await refreshGitHubInstallationToken({
      controlPlaneConfig: input.controlPlaneConfig,
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
        ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
      };
    }
    const envToken = (env[settings.tokenEnv] ?? "").trim();
    if (envToken.length > 0) {
      return {
        ok: true,
        token: envToken,
        source: "env",
        tokenEnv: settings.tokenEnv,
        authRef: settings.authRef,
        service: settings.service,
      };
    }
    return {
      ok: false,
      error: `Stored GitHub token is expired and refresh failed: ${refreshed.error}`,
      tokenEnv: settings.tokenEnv,
      authRef: settings.authRef,
      service: settings.service,
    };
  }

  const envToken = (env[settings.tokenEnv] ?? "").trim();
  if (envToken.length > 0) {
    return {
      ok: true,
      token: envToken,
      source: "env",
      tokenEnv: settings.tokenEnv,
      authRef: settings.authRef,
      service: settings.service,
    };
  }

  return {
    ok: false,
    error: `Missing GitHub token. Store one with \`hack x github connect\`, or set ${settings.tokenEnv}.`,
    tokenEnv: settings.tokenEnv,
    authRef: settings.authRef,
    service: settings.service,
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
  readonly env?: Record<string, string | undefined>;
  readonly store?: SecretStore;
  readonly fetcher?: FetchLike;
  readonly nowMs?: number;
}): Promise<
  | { readonly ok: true; readonly token: string; readonly expiresAt?: string }
  | { readonly ok: false; readonly error: string }
> {
  const settings = resolveGitHubAuthSettings({
    controlPlaneConfig: input.controlPlaneConfig,
  });
  if (!(settings.appId && settings.installationId)) {
    return {
      ok: false,
      error:
        "GitHub App refresh is not configured. Set appId and installationId with `hack x github connect --app-id ... --installation-id ...`.",
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
 * Persist GitHub App token into secret storage under the configured `authRef`.
 */
export async function saveGitHubAppToken(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly token: string;
  readonly expiresAt?: string;
  readonly authRef?: string;
  readonly service?: string;
  readonly store?: SecretStore;
}): Promise<{ readonly authRef: string; readonly service: string }> {
  const settings = resolveGitHubAuthSettings({
    controlPlaneConfig: input.controlPlaneConfig,
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
  return { authRef, service };
}

/**
 * Remove a stored GitHub App token by auth reference.
 */
export async function deleteGitHubAppToken(input: {
  readonly controlPlaneConfig: ControlPlaneConfig;
  readonly authRef?: string;
  readonly service?: string;
  readonly store?: SecretStore;
}): Promise<{
  readonly deleted: boolean;
  readonly authRef: string;
  readonly service: string;
}> {
  const settings = resolveGitHubAuthSettings({
    controlPlaneConfig: input.controlPlaneConfig,
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
  return { deleted, authRef, service };
}

function normalizeConfigString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
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
      ? `Missing GitHub App private key in keychain ref ${input.settings.privateKeyAuthRef} and env ${input.settings.privateKeyEnv}.`
      : `Missing GitHub App private key in ${input.settings.privateKeyEnv}.`,
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
