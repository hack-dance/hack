import {
  createAuthBrokerApp as createAuthBrokerAppInternal,
  type DefaultOrgTeamsStoreMode,
  type DefaultProjectStoreMode,
  resolveDefaultOrgTeamsStore,
  resolveDefaultProjectStore,
} from "./app.ts";
import { type BrokerConfig, resolveConfig } from "./config.ts";

export const createAuthBrokerApp = createAuthBrokerAppInternal;

export function formatAuthBrokerStartupMessages(input: {
  readonly config: Pick<BrokerConfig, "host" | "port" | "publicBaseUrl">;
  readonly orgTeamsStoreMode: DefaultOrgTeamsStoreMode;
  readonly projectStoreMode: DefaultProjectStoreMode;
}): string {
  return [
    `[auth-broker] listening on ${input.config.host}:${input.config.port} (public: ${input.config.publicBaseUrl})`,
    input.orgTeamsStoreMode.startupMessage,
    input.projectStoreMode.startupMessage,
  ].join("\n");
}

if (import.meta.main) {
  const config = resolveConfig();
  const orgTeamsStore = resolveDefaultOrgTeamsStore();
  const projectStore = resolveDefaultProjectStore({
    orgStore: orgTeamsStore.store,
  });
  const app = createAuthBrokerAppInternal({
    config,
    orgTeamsStore: orgTeamsStore.store,
    projectStore: projectStore.store,
  });
  app.listen({
    hostname: config.host,
    port: config.port,
  });
  process.stdout.write(
    `${formatAuthBrokerStartupMessages({
      config,
      orgTeamsStoreMode: orgTeamsStore.mode,
      projectStoreMode: projectStore.mode,
    })}\n`
  );
}
