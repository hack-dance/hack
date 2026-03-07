import { expect, test } from "bun:test";

import type { createDbClient } from "../src/db.ts";
import { ensureLinearConnectionsTable } from "../src/modules/linear-connections/service.ts";
import { ensureLinearWebhookEventsTable } from "../src/modules/linear-sync-store/service.ts";

type DbClient = ReturnType<typeof createDbClient>;

function createMockDb(input: {
  readonly execute: (query: unknown, index: number) => Promise<unknown>;
}): DbClient {
  let callIndex = 0;
  return {
    execute: (async (query: unknown) => {
      callIndex += 1;
      return await input.execute(query, callIndex);
    }) as DbClient["execute"],
  } as DbClient;
}

function stringifyQuery(query: unknown): string {
  if (query && typeof query === "object" && "queryChunks" in query) {
    const chunks = (query as { queryChunks: unknown[] }).queryChunks;
    return chunks
      .map((chunk) => {
        if (chunk && typeof chunk === "object" && "value" in chunk) {
          const value = (chunk as { value: unknown }).value;
          if (Array.isArray(value)) {
            return value.join("");
          }
          if (typeof value === "string") {
            return value;
          }
        }
        return String(chunk);
      })
      .join(" ");
  }
  return String(query);
}

test("ensureLinearConnectionsTable creates the broker connection table", async () => {
  const queries: string[] = [];
  const db = createMockDb({
    execute: (query) => {
      queries.push(stringifyQuery(query));
      return Promise.resolve({ rows: [] });
    },
  });

  await ensureLinearConnectionsTable({ db });

  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain("CREATE TABLE IF NOT EXISTS linear_connections");
  expect(queries[0]).toContain("connection_key text NOT NULL UNIQUE");
  expect(queries[0]).toContain("better_auth_organization_id text");
  expect(queries[0]).toContain("local_access_sealed text");
  expect(queries[0]).toContain("local_access_updated_at timestamptz");
});

test("ensureLinearWebhookEventsTable creates the broker webhook delivery table", async () => {
  const queries: string[] = [];
  const db = createMockDb({
    execute: (query) => {
      queries.push(stringifyQuery(query));
      return Promise.resolve({ rows: [] });
    },
  });

  await ensureLinearWebhookEventsTable({ db });

  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain(
    "CREATE TABLE IF NOT EXISTS linear_webhook_events"
  );
  expect(queries[0]).toContain("delivery_key text NOT NULL UNIQUE");
  expect(queries[0]).toContain("applied_at timestamptz");
});
