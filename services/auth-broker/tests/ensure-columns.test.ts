import { expect, test } from "bun:test";

import {
  createTableColumnsEnsurer,
  ensureTableColumns,
} from "../src/db/ensure-columns.ts";
import type { createDbClient } from "../src/db.ts";

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

test("ensureTableColumns skips ALTER TABLE when columns already exist", async () => {
  const calls: unknown[] = [];
  const db = createMockDb({
    execute: (query) => {
      calls.push(query);
      return Promise.resolve({
        rows: [
          { column_name: "better_auth_organization_id" },
          { column_name: "better_auth_team_id" },
        ],
      });
    },
  });

  await ensureTableColumns({
    db,
    tableName: "linear_connections",
    columns: [
      { name: "better_auth_organization_id", definition: "text" },
      { name: "better_auth_team_id", definition: "text" },
    ],
  });

  expect(calls).toHaveLength(1);
});

test("ensureTableColumns adds only missing columns", async () => {
  const calls: unknown[] = [];
  const db = createMockDb({
    execute: (query, index) => {
      calls.push(query);
      if (index === 1) {
        return Promise.resolve({
          rows: [{ column_name: "better_auth_organization_id" }],
        });
      }
      return Promise.resolve({ rows: [] });
    },
  });

  await ensureTableColumns({
    db,
    tableName: "linear_connections",
    columns: [
      { name: "better_auth_organization_id", definition: "text" },
      { name: "better_auth_team_id", definition: "text" },
    ],
  });

  expect(calls).toHaveLength(2);
});

test("createTableColumnsEnsurer retries after a failed migration attempt", async () => {
  let alterAttempts = 0;
  const db = createMockDb({
    execute: (_query, index) => {
      if (index === 1 || index === 3) {
        return Promise.resolve({ rows: [] });
      }
      alterAttempts += 1;
      if (alterAttempts === 1) {
        return Promise.reject(new Error("temporary migration failure"));
      }
      return Promise.resolve({ rows: [] });
    },
  });
  const ensure = createTableColumnsEnsurer({
    db,
    tableName: "linear_connections",
    columns: [{ name: "better_auth_team_id", definition: "text" }],
  });

  await expect(ensure()).rejects.toThrow("temporary migration failure");
  await expect(ensure()).resolves.toBeUndefined();
  expect(alterAttempts).toBe(2);
});
