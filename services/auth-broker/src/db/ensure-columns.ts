import { sql } from "drizzle-orm";

import type { createDbClient } from "../db.ts";

type DbClient = ReturnType<typeof createDbClient>;
const SQL_IDENTIFIER_REGEX = /^[a-z_][a-z0-9_]*$/i;

export type TableColumnSpec = {
  readonly name: string;
  readonly definition: string;
};

export function createTableColumnsEnsurer(input: {
  readonly db: DbClient;
  readonly tableName: string;
  readonly columns: readonly TableColumnSpec[];
}) {
  let promise: Promise<void> | null = null;
  return async () => {
    if (!promise) {
      promise = ensureTableColumns(input).catch((error) => {
        promise = null;
        throw error;
      });
    }
    await promise;
  };
}

export async function ensureTableColumns(input: {
  readonly db: DbClient;
  readonly tableName: string;
  readonly columns: readonly TableColumnSpec[];
}): Promise<void> {
  const existingColumns = await listTableColumns({
    db: input.db,
    tableName: input.tableName,
  });
  for (const column of input.columns) {
    if (existingColumns.has(column.name)) {
      continue;
    }
    await input.db.execute(
      sql.raw(
        `ALTER TABLE ${quoteIdentifier(input.tableName)} ADD COLUMN ${quoteIdentifier(column.name)} ${column.definition}`
      )
    );
  }
}

async function listTableColumns(input: {
  readonly db: DbClient;
  readonly tableName: string;
}): Promise<Set<string>> {
  const result = await input.db.execute(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ${input.tableName}
  `);
  const names = new Set<string>();
  for (const row of readResultRows(result)) {
    const name = readStringField({
      record: row,
      key: "column_name",
    });
    if (name) {
      names.add(name);
    }
  }
  return names;
}

function readResultRows(result: unknown): readonly Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result.filter(isRecord);
  }
  if (!isRecord(result)) {
    return [];
  }
  const rows = result.rows;
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.filter(isRecord);
}

function readStringField(input: {
  readonly record: Record<string, unknown>;
  readonly key: string;
}): string | null {
  const value = input.record[input.key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function quoteIdentifier(value: string): string {
  if (!SQL_IDENTIFIER_REGEX.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return `"${value}"`;
}
