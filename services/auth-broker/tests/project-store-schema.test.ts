import { expect, test } from "bun:test";

import type { createDbClient } from "../src/db.ts";
import { ensureProjectAdminTables } from "../src/modules/projects/db-store.ts";

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

test("ensureProjectAdminTables creates durable project registration tables", async () => {
  const queries: string[] = [];
  const db = createMockDb({
    execute: (query) => {
      queries.push(stringifyQuery(query));
      return Promise.resolve({ rows: [] });
    },
  });

  await ensureProjectAdminTables({ db });

  expect(
    queries.some((query) =>
      query.includes("CREATE TABLE IF NOT EXISTS project_admin_projects")
    )
  ).toBe(true);
  expect(
    queries.some((query) =>
      query.includes("CREATE TABLE IF NOT EXISTS project_admin_access_grants")
    )
  ).toBe(true);
  expect(
    queries.some((query) =>
      query.includes(
        "CREATE UNIQUE INDEX IF NOT EXISTS project_admin_projects_slug_idx"
      )
    )
  ).toBe(true);
  expect(
    queries.some((query) =>
      query.includes(
        "CREATE INDEX IF NOT EXISTS project_admin_access_grants_project_id_idx"
      )
    )
  ).toBe(true);
});
