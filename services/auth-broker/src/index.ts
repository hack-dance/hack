import { createAuthBrokerApp as createAuthBrokerAppInternal } from "./app.ts";
import { resolveConfig } from "./config.ts";

export const createAuthBrokerApp = createAuthBrokerAppInternal;

if (import.meta.main) {
  const config = resolveConfig();
  const app = createAuthBrokerAppInternal({ config });
  app.listen({
    hostname: config.host,
    port: config.port,
  });
  process.stdout.write(
    `[auth-broker] listening on ${config.host}:${config.port} (public: ${config.publicBaseUrl})\n`
  );
}
