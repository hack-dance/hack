import { mock } from "bun:test";
import * as fs from "node:fs/promises";

/**
 * Runs one `writeTextFileAtomicIfChanged` in a disposable child whose commit
 * rename fails after the staging file is created, written and fsynced. Every
 * step before the rename runs unmocked. Prints `failed` when the write rejects
 * and `committed` if it unexpectedly succeeds. The content is a synthetic test
 * string passed on stdin, never in argv.
 */
const [target] = process.argv.slice(2);
if (!target) {
  throw new Error("Missing atomic write worker target");
}

mock.module("node:fs/promises", () => ({
  ...fs,
  rename: async () => {
    throw Object.assign(new Error("synthetic rename failure"), {
      code: "EIO",
    });
  },
}));

const content = await Bun.stdin.text();
const { writeTextFileAtomicIfChanged } = await import("../../src/lib/fs.ts");
try {
  await writeTextFileAtomicIfChanged(target, content);
  process.stdout.write("committed\n");
} catch {
  process.stdout.write("failed\n");
}
