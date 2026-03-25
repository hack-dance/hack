import { expect, test } from "bun:test";

import type { createDbClient } from "../src/db.ts";
import { ensureOrgAdminTables } from "../src/modules/orgs/db-store.ts";

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

test("ensureOrgAdminTables creates durable org/team persistence tables", async () => {
  const queries: string[] = [];
  const db = createMockDb({
    execute: (query) => {
      queries.push(stringifyQuery(query));
      return Promise.resolve({ rows: [] });
    },
  });

  await ensureOrgAdminTables({ db });

  expect(
    queries.some((query) =>
      query.includes("CREATE TABLE IF NOT EXISTS org_admin_organizations")
    )
  ).toBe(true);
  expect(
    queries.some((query) =>
      query.includes("CREATE TABLE IF NOT EXISTS org_admin_teams")
    )
  ).toBe(true);
  expect(
    queries.some((query) =>
      query.includes("CREATE TABLE IF NOT EXISTS org_admin_memberships")
    )
  ).toBe(true);
  expect(
    queries.some((query) =>
      query.includes("CREATE TABLE IF NOT EXISTS org_admin_invitations")
    )
  ).toBe(true);
  expect(
    queries.some((query) =>
      query.includes(
        "CREATE INDEX IF NOT EXISTS org_admin_memberships_target_idx"
      )
    )
  ).toBe(true);
});
