import { expect, test } from "bun:test";

import { createDbClient } from "../src/client.ts";

test("db package exports createDbClient", () => {
  expect(typeof createDbClient).toBe("function");
});
