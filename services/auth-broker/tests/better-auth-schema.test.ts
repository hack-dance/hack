import { describe, expect, test } from "bun:test";

import { authBrokerSchema, betterAuthSchema } from "../src/db/schema.ts";

describe("auth broker Better Auth schema", () => {
  test("exports the required Better Auth core and organization tables", () => {
    expect(Object.keys(betterAuthSchema).sort()).toEqual([
      "account",
      "invitation",
      "member",
      "organization",
      "session",
      "team",
      "teamMember",
      "user",
      "verification",
    ]);
    expect(authBrokerSchema.verification).toBeDefined();
    expect(authBrokerSchema.teamMember).toBeDefined();
  });
});
