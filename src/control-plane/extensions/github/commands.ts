import { secrets } from "bun";
import { updateGlobalConfig } from "../../../lib/config.ts";
import { display } from "../../../ui/display.ts";
import type { ExtensionCommand } from "../types.ts";
import {
  deleteGitHubAppToken,
  exchangeGitHubAppInstallationToken,
  resolveGitHubAppToken,
  resolveGitHubAuthSettings,
  saveGitHubAppToken,
} from "./auth.ts";
import {
  createGitHubAppClient,
  type GitHubRepoRef,
  parseGitHubRepoRef,
} from "./client.ts";

const EXTENSION_ID = "dance.hack.github";
const DIRECT_REPO_PATTERN = /^([^/\s]+)\/([^/\s]+)$/;

export const GITHUB_COMMANDS: readonly ExtensionCommand[] = [
  {
    name: "connect",
    summary: "Store GitHub App installation token in keychain and config",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const parsed = parseConnectArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const defaults = resolveGitHubAuthSettings({
        controlPlaneConfig: ctx.controlPlaneConfig,
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

      await saveGitHubAppToken({
        controlPlaneConfig: ctx.controlPlaneConfig,
        token: tokenResult.token,
        ...(tokenResult.expiresAt ? { expiresAt: tokenResult.expiresAt } : {}),
        authRef: resolved.authRef,
        service: resolved.service,
      });

      await persistConnectDefaults({
        resolved,
        privateKeyAuthRefOverride: tokenResult.privateKeyAuthRef,
      });

      await display.kv({
        title: "GitHub auth connected",
        entries: buildConnectSummaryEntries({
          resolved,
          tokenResult,
        }),
      });
      return 0;
    },
  },
  {
    name: "disconnect",
    summary: "Remove stored GitHub App token from keychain",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const parsed = parseDisconnectArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const deleted = await deleteGitHubAppToken({
        controlPlaneConfig: ctx.controlPlaneConfig,
        ...(parsed.value.authRef ? { authRef: parsed.value.authRef } : {}),
        ...(parsed.value.service ? { service: parsed.value.service } : {}),
      });

      await display.kv({
        title: "GitHub auth disconnected",
        entries: [
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
    summary: "Show GitHub App auth/config status",
    scope: "global",
    handler: async ({ ctx }) => {
      const settings = resolveGitHubAuthSettings({
        controlPlaneConfig: ctx.controlPlaneConfig,
      });
      const token = await resolveGitHubAppToken({
        controlPlaneConfig: ctx.controlPlaneConfig,
      });
      await display.kv({
        title: "GitHub extension status",
        entries: [
          ["extension_id", EXTENSION_ID],
          ["auth_ref", settings.authRef],
          ["service", settings.service],
          ["token_env_fallback", settings.tokenEnv],
          ["app_id", settings.appId ?? ""],
          ["installation_id", settings.installationId ?? ""],
          ["private_key_env", settings.privateKeyEnv],
          ["private_key_auth_ref", settings.privateKeyAuthRef ?? ""],
          ["api_base_url", settings.apiBaseUrl],
          ["token_resolved", token.ok ? "yes" : "no"],
          ["token_source", token.ok ? token.source : "none"],
          ...(token.ok && token.expiresAt
            ? ([["token_expires_at", token.expiresAt]] as const)
            : []),
          ...(token.ok ? [] : ([["error", token.error]] as const)),
        ],
      });
      return token.ok ? 0 : 1;
    },
  },
  {
    name: "pr-upsert",
    summary: "Create or update a pull request via GitHub App token",
    scope: "global",
    handler: async ({ ctx, args }) => {
      const parsed = parsePrUpsertArgs({ args });
      if (!parsed.ok) {
        ctx.logger.error({ message: parsed.error });
        return 1;
      }

      const token = await resolveGitHubAppToken({
        controlPlaneConfig: ctx.controlPlaneConfig,
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
    "stdin" | "privateKeyStdin"
  >]?: Omit<ConnectParsedValue, "stdin" | "privateKeyStdin">[K];
};

type ConnectResolvedDefaults = {
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

const CONNECT_VALUE_KEYS = {
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
  keyof Omit<ConnectParsedValue, "stdin" | "privateKeyStdin">
>;

function parseConnectArgs(input: {
  readonly args: readonly string[];
}): ConnectParseResult {
  const values: MutableConnectParsedValues = {};
  let stdin = false;
  let privateKeyStdin = false;

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

async function persistConnectDefaults(input: {
  readonly resolved: ConnectResolvedDefaults;
  readonly privateKeyAuthRefOverride?: string;
}): Promise<void> {
  const updates: Promise<{ readonly changed: boolean }>[] = [
    updateGlobalConfig({
      path: `controlPlane.extensions["${EXTENSION_ID}"].enabled`,
      value: true,
    }),
    updateGlobalConfig({
      path: `controlPlane.extensions["${EXTENSION_ID}"].config.authRef`,
      value: input.resolved.authRef,
    }),
    updateGlobalConfig({
      path: `controlPlane.extensions["${EXTENSION_ID}"].config.tokenEnv`,
      value: input.resolved.tokenEnv,
    }),
    updateGlobalConfig({
      path: `controlPlane.extensions["${EXTENSION_ID}"].config.service`,
      value: input.resolved.service,
    }),
  ];
  if (input.resolved.appModeRequested) {
    updates.push(
      updateGlobalConfig({
        path: `controlPlane.extensions["${EXTENSION_ID}"].config.appId`,
        value: input.resolved.appId,
      }),
      updateGlobalConfig({
        path: `controlPlane.extensions["${EXTENSION_ID}"].config.installationId`,
        value: input.resolved.installationId,
      }),
      updateGlobalConfig({
        path: `controlPlane.extensions["${EXTENSION_ID}"].config.privateKeyEnv`,
        value: input.resolved.privateKeyEnv,
      }),
      updateGlobalConfig({
        path: `controlPlane.extensions["${EXTENSION_ID}"].config.privateKeyAuthRef`,
        value:
          input.privateKeyAuthRefOverride ?? input.resolved.privateKeyAuthRef,
      }),
      updateGlobalConfig({
        path: `controlPlane.extensions["${EXTENSION_ID}"].config.apiBaseUrl`,
        value: input.resolved.apiBaseUrl,
      })
    );
  }
  await Promise.all(updates);
}

function buildConnectSummaryEntries(input: {
  readonly resolved: ConnectResolvedDefaults;
  readonly tokenResult: ConnectTokenResult;
}): readonly (readonly [string, string])[] {
  const entries: (readonly [string, string])[] = [
    ["extension_id", EXTENSION_ID],
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

type DisconnectParseResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly authRef?: string;
        readonly service?: string;
      };
    }
  | { readonly ok: false; readonly error: string };

function parseDisconnectArgs(input: {
  readonly args: readonly string[];
}): DisconnectParseResult {
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
      ...(authRef ? { authRef } : {}),
      ...(service ? { service } : {}),
    },
  };
}

type PrUpsertParseResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly repo: GitHubRepoRef;
        readonly headRef: string;
        readonly baseRef: string;
        readonly title: string;
        readonly body: string;
        readonly comment?: string;
      };
    }
  | { readonly ok: false; readonly error: string };

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
        "Usage: hack x github pr-upsert --repo <owner/repo|git-url> --head <branch> --base <branch> --title <text> --body <text> [--comment <text>]",
    };
  }

  const repo = parseRepoArg({ raw: repoRaw });
  if (!repo) {
    return { ok: false, error: `Unable to parse --repo: ${repoRaw}` };
  }

  return {
    ok: true,
    value: {
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
