import {
  createAuthBrokerApp as createAuthBrokerAppInternal,
  type DefaultOrgTeamsStoreMode,
  resolveDefaultOrgTeamsStore,
} from "./app.ts";
import { type BrokerConfig, resolveConfig } from "./config.ts";

export const createAuthBrokerApp = createAuthBrokerAppInternal;

export function formatAuthBrokerStartupMessages(input: {
  readonly config: Pick<BrokerConfig, "host" | "port" | "publicBaseUrl">;
  readonly orgTeamsStoreMode: DefaultOrgTeamsStoreMode;
}): string {
  return [
    `[auth-broker] listening on ${input.config.host}:${input.config.port} (public: ${input.config.publicBaseUrl})`,
    input.orgTeamsStoreMode.startupMessage,
  ].join("\n");
}

if (import.meta.main) {
  const config = resolveConfig();
  const orgTeamsStore = resolveDefaultOrgTeamsStore();
  const app = createAuthBrokerAppInternal({
    config,
    orgTeamsStore: orgTeamsStore.store,
  });
  app.listen({
    hostname: config.host,
    port: config.port,
  });
  process.stdout.write(
    `${formatAuthBrokerStartupMessages({
      config,
      orgTeamsStoreMode: orgTeamsStore.mode,
    })}\n`
  );
}
