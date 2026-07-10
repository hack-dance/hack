import { expect, test } from "bun:test";

import { exec } from "../src/lib/shell.ts";

test("exec timeout terminates the subprocess group and reports 124", async () => {
  const startedAt = Date.now();
  const result = await exec(["/bin/sh", "-c", "sleep 5"], {
    stdin: "ignore",
    timeoutMs: 50,
  });

  expect(result.exitCode).toBe(124);
  expect(Date.now() - startedAt).toBeLessThan(2000);
});
