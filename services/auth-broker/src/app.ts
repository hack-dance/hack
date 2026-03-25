import { Elysia } from "elysia";

import {
  type BetterAuthRuntime,
  createBetterAuthRuntimeFromEnv,
} from "./better-auth.ts";
import type { BrokerConfig } from "./config.ts";
import { FlowStore } from "./flow-store.ts";
import { createBetterAuthPlugin } from "./modules/better-auth/plugin.ts";
import { createBetterAuthShellPlugin } from "./modules/better-auth/shell-plugin.ts";
import { createCoreRoutesPlugin } from "./modules/core/plugin.ts";
import { createGitHubOAuthPlugin } from "./modules/github-oauth/plugin.ts";
import { createLinearAgentPlugin } from "./modules/linear-agent/plugin.ts";
import { createLinearAutosyncPlugin } from "./modules/linear-autosync/plugin.ts";
import {
  createLinearAutosyncStoreFromDb,
  InMemoryLinearAutosyncStore,
  type LinearAutosyncStore,
} from "./modules/linear-autosync/service.ts";
import { createLinearConnectionsPlugin } from "./modules/linear-connections/plugin.ts";
import {
  createLinearConnectionStoreFromDb,
  InMemoryLinearConnectionStore,
  type LinearConnectionStore,
} from "./modules/linear-connections/service.ts";
import { createLinearOAuthPlugin } from "./modules/linear-oauth/plugin.ts";
import { createLinearSyncStorePlugin } from "./modules/linear-sync-store/plugin.ts";
import {
  createLinearSyncStoreFromDb,
  InMemoryLinearSyncStore,
  type LinearSyncStore,
} from "./modules/linear-sync-store/service.ts";
import { createOrgTeamsStoreFromDb } from "./modules/orgs/db-store.ts";
import { createOrgsPlugin } from "./modules/orgs/plugin.ts";
import {
  InMemoryOrgTeamsStore,
  type OrgTeamsStore,
} from "./modules/orgs/service.ts";
import { createProvidersPlugin } from "./modules/providers/plugin.ts";
import { createSharedMiddlewarePlugin } from "./plugins/shared-middleware.ts";

export type CreateAuthBrokerAppOptions = {
  readonly config: BrokerConfig;
  readonly flowStore?: FlowStore;
  readonly betterAuthRuntime?: BetterAuthRuntime;
  readonly linearSyncStore?: LinearSyncStore;
  readonly linearConnectionStore?: LinearConnectionStore;
  readonly linearAutosyncStore?: LinearAutosyncStore;
  readonly orgTeamsStore?: OrgTeamsStore;
};

export type DefaultOrgTeamsStoreMode =
  | {
      readonly kind: "durable_database";
      readonly startupMessage: string;
    }
  | {
      readonly kind: "in_memory_dev_only";
      readonly startupMessage: string;
    };

type CreateDbOrgTeamsStore = (input: {
  readonly databaseUrl: string;
}) => OrgTeamsStore;

const DURABLE_ORG_TEAMS_STORE_STARTUP_MESSAGE =
  "[auth-broker] org/team store: durable database-backed mode via DATABASE_URL";
const IN_MEMORY_ORG_TEAMS_STORE_STARTUP_MESSAGE =
  "[auth-broker] org/team store: development-only in-memory mode because DATABASE_URL is not configured";

/**
 * Build auth-broker HTTP app from composable feature plugins.
 */
export function createAuthBrokerApp({
  config,
  flowStore: externalStore,
  betterAuthRuntime: externalBetterAuthRuntime,
  linearSyncStore: externalLinearSyncStore,
  linearConnectionStore: externalLinearConnectionStore,
  linearAutosyncStore: externalLinearAutosyncStore,
  orgTeamsStore: externalOrgTeamsStore,
}: CreateAuthBrokerAppOptions) {
  const flowStore =
    externalStore ?? new FlowStore({ filePath: config.flowStorePath });
  const betterAuthRuntime =
    externalBetterAuthRuntime ?? createBetterAuthRuntimeFromEnv();
  const linearSyncStore =
    externalLinearSyncStore ?? createDefaultLinearSyncStore();
  const linearConnectionStore =
    externalLinearConnectionStore ?? createDefaultLinearConnectionStore();
  const linearAutosyncStore =
    externalLinearAutosyncStore ?? createDefaultLinearAutosyncStore();
  const orgTeamsStore =
    externalOrgTeamsStore ?? resolveDefaultOrgTeamsStore().store;
  let flowSweepTimer: ReturnType<typeof setInterval> | null = null;

  return new Elysia({
    name: "hack-auth-broker",
  })
    .onBeforeHandle(({ request, set }) => {
      if (!isReadOnlyRoutePath({ path: new URL(request.url).pathname })) {
        return;
      }
      if (request.method === "GET") {
        return;
      }
      set.status = 405;
      return {
        ok: false,
        error: "method_not_allowed",
      } as const;
    })
    .use(createSharedMiddlewarePlugin())
    .use(
      createCoreRoutesPlugin({
        betterAuthRuntime,
      })
    )
    .use(
      createProvidersPlugin({
        config,
        betterAuthRuntime,
      })
    )
    .use(
      createBetterAuthPlugin({
        runtime: betterAuthRuntime,
      })
    )
    .use(
      createBetterAuthShellPlugin({
        config,
        runtime: betterAuthRuntime,
        flowStore,
      })
    )
    .use(
      createGitHubOAuthPlugin({
        config,
        flowStore,
        betterAuthRuntime,
      })
    )
    .use(
      createLinearAgentPlugin({
        config,
        syncStore: linearSyncStore,
        connectionStore: linearConnectionStore,
        autosyncStore: linearAutosyncStore,
      })
    )
    .use(
      createLinearAutosyncPlugin({
        autosyncStore: linearAutosyncStore,
        betterAuthRuntime,
      })
    )
    .use(
      createLinearConnectionsPlugin({
        config,
        connectionStore: linearConnectionStore,
        betterAuthRuntime,
      })
    )
    .use(
      createOrgsPlugin({
        store: orgTeamsStore,
        betterAuthRuntime,
      })
    )
    .use(
      createLinearSyncStorePlugin({
        syncStore: linearSyncStore,
        betterAuthRuntime,
      })
    )
    .use(
      createLinearOAuthPlugin({
        config,
        flowStore,
        connectionStore: linearConnectionStore,
        betterAuthRuntime,
      })
    )
    .onStart(async () => {
      await betterAuthRuntime.ready;
      const intervalMs = Math.max(config.flowSweepIntervalMs, 5000);
      flowSweepTimer = setInterval(() => {
        flowStore.pruneExpired();
      }, intervalMs);
      flowSweepTimer.unref?.();
    })
    .onStop(() => {
      if (!flowSweepTimer) {
        return;
      }
      clearInterval(flowSweepTimer);
      flowSweepTimer = null;
    });
}

function createDefaultLinearSyncStore(): LinearSyncStore {
  if (!process.env.DATABASE_URL) {
    return new InMemoryLinearSyncStore();
  }
  try {
    return createLinearSyncStoreFromDb({
      databaseUrl: process.env.DATABASE_URL,
    });
  } catch {
    return new InMemoryLinearSyncStore();
  }
}

function createDefaultLinearConnectionStore(): LinearConnectionStore {
  if (!process.env.DATABASE_URL) {
    return new InMemoryLinearConnectionStore();
  }
  try {
    return createLinearConnectionStoreFromDb({
      databaseUrl: process.env.DATABASE_URL,
    });
  } catch {
    return new InMemoryLinearConnectionStore();
  }
}

function createDefaultLinearAutosyncStore(): LinearAutosyncStore {
  if (!process.env.DATABASE_URL) {
    return new InMemoryLinearAutosyncStore();
  }
  try {
    return createLinearAutosyncStoreFromDb({
      databaseUrl: process.env.DATABASE_URL,
    });
  } catch {
    return new InMemoryLinearAutosyncStore();
  }
}

export function createDefaultOrgTeamsStore(input?: {
  readonly databaseUrl?: string;
  readonly createDbStore?: CreateDbOrgTeamsStore;
}): OrgTeamsStore {
  return resolveDefaultOrgTeamsStore(input).store;
}

export function resolveDefaultOrgTeamsStore(input?: {
  readonly databaseUrl?: string;
  readonly createDbStore?: CreateDbOrgTeamsStore;
}): {
  readonly store: OrgTeamsStore;
  readonly mode: DefaultOrgTeamsStoreMode;
} {
  const databaseUrl = normalizeOptionalText({
    value: input?.databaseUrl ?? process.env.DATABASE_URL,
  });
  if (!databaseUrl) {
    return {
      store: new InMemoryOrgTeamsStore(),
      mode: {
        kind: "in_memory_dev_only",
        startupMessage: IN_MEMORY_ORG_TEAMS_STORE_STARTUP_MESSAGE,
      },
    };
  }

  const createDbStore = input?.createDbStore ?? createOrgTeamsStoreFromDb;
  try {
    return {
      store: createDbStore({
        databaseUrl,
      }),
      mode: {
        kind: "durable_database",
        startupMessage: DURABLE_ORG_TEAMS_STORE_STARTUP_MESSAGE,
      },
    };
  } catch (error) {
    throw new Error(
      "Failed to initialize durable org/team store from DATABASE_URL.",
      {
        cause: error,
      }
    );
  }
}

function normalizeOptionalText(input: {
  readonly value: string | null | undefined;
}): string | undefined {
  const normalized = input.value?.trim();
  return normalized ? normalized : undefined;
}

/**
 * Identify route paths that are intentionally GET-only in broker v1.
 */
function isReadOnlyRoutePath(input: { readonly path: string }): boolean {
  if (input.path === "/health") {
    return true;
  }
  if (input.path === "/v1/auth/providers") {
    return true;
  }
  if (input.path === "/v1/auth/better-auth/status") {
    return true;
  }
  if (input.path === "/auth") {
    return true;
  }
  if (input.path === "/auth/account") {
    return true;
  }
  if (input.path === "/v1/auth/session/start") {
    return true;
  }
  if (input.path === "/v1/auth/me") {
    return true;
  }
  if (input.path === "/linear/callback") {
    return true;
  }
  if (input.path === "/linear/start") {
    return true;
  }
  if (input.path === "/v1/auth/linear/refresh") {
    return false;
  }
  if (input.path === "/v1/auth/linear/connections/seed") {
    return false;
  }
  if (input.path === "/v1/auth/linear/connections/update-local-access") {
    return false;
  }
  if (input.path === "/v1/auth/linear/subscriptions") {
    return false;
  }
  if (input.path === "/v1/auth/linear/subscriptions/remove") {
    return false;
  }
  if (
    input.path.startsWith("/v1/auth/linear/deliveries/") &&
    input.path.endsWith("/apply")
  ) {
    return false;
  }
  if (input.path.startsWith("/gh/")) {
    return true;
  }
  if (input.path.startsWith("/v1/auth/github/")) {
    return true;
  }
  if (input.path.startsWith("/v1/auth/session/flows/")) {
    return true;
  }
  if (input.path.startsWith("/v1/auth/linear/")) {
    return true;
  }
  return false;
}
