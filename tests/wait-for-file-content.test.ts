import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForFileContent } from "./helpers/wait-for-file-content.ts";

test("a fixture witness must contain the complete stage before its writer can be interrupted", async () => {
  const root = await mkdtemp(join(tmpdir(), "fixture-witness-"));
  const path = join(root, "stage");
  const emptyObserved = Promise.withResolvers<void>();
  const partialObserved = Promise.withResolvers<void>();
  let complete = false;
  await Bun.write(path, "");
  const result = waitForFileContent({
    path,
    what: "takeover stage regression",
    budgetMs: 1000,
    complete: (text) => {
      if (text === "") {
        emptyObserved.resolve();
      }
      if (text === "res") {
        partialObserved.resolve();
      }
      return text === "reserved" ? text : undefined;
    },
  }).then((stage) => {
    complete = true;
    return stage;
  });
  try {
    await emptyObserved.promise;
    expect(complete).toBe(false);
    await Bun.write(path, "res");
    await partialObserved.promise;
    expect(complete).toBe(false);
    await Bun.write(path, "reserved");
    expect(await result).toBe("reserved");
  } finally {
    await result.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
