import { expect, test } from "bun:test";

import { createDbClient } from "../src/client.ts";
import {
  githubConnections,
  linearAssigneeMappings,
  linearConnections,
  linearSyncSubscriptions,
  linearWebhookEvents,
} from "../src/schema/core.ts";

test("db package exports createDbClient", () => {
  expect(typeof createDbClient).toBe("function");
});

test("db package exports linear sync schema tables", () => {
  expect(linearConnections[Symbol.for("drizzle:Name")]).toBe(
    "linear_connections"
  );
  expect(linearConnections.betterAuthOrganizationId.name).toBe(
    "better_auth_organization_id"
  );
  expect(linearConnections.betterAuthTeamId.name).toBe("better_auth_team_id");
  expect(linearAssigneeMappings[Symbol.for("drizzle:Name")]).toBe(
    "linear_assignee_mappings"
  );
  expect(linearWebhookEvents[Symbol.for("drizzle:Name")]).toBe(
    "linear_webhook_events"
  );
  expect(linearWebhookEvents.betterAuthOrganizationId.name).toBe(
    "better_auth_organization_id"
  );
  expect(linearWebhookEvents.betterAuthTeamId.name).toBe("better_auth_team_id");
  expect(linearSyncSubscriptions[Symbol.for("drizzle:Name")]).toBe(
    "linear_sync_subscriptions"
  );
  expect(githubConnections[Symbol.for("drizzle:Name")]).toBe(
    "github_connections"
  );
});
