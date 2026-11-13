import { mock } from "bun:test";
import * as fs from "node:fs/promises";

/**
 * Emulates a filesystem without Unix permissions (ExFAT, FAT): every new
 * directory reports a mount-wide 0777 mode, and chmod changes nothing. Runs
 * one private staging preparation for the target in argv and prints
 * `admitted` or `refused`. Only temporary paths from the parent are used.
 */
const [target] = process.argv.slice(2);
if (!target) {
  throw new Error("Missing target");
}
const { mkdir, chmod } = fs;
mock.module("node:fs/promises", () => ({
  ...fs,
  mkdir: async (path: string, options?: { mode?: number }) => {
    const made = await mkdir(path, options);
    await chmod(path, 0o777);
    return made;
  },
  chmod: async () => undefined,
}));
const { preparePrivateStaging } = await import(
  "../../src/lib/private-staging.ts"
);
try {
  await preparePrivateStaging({
    target,
    refusal: () => new Error("refused"),
  });
  process.stdout.write("admitted\n");
} catch {
  process.stdout.write("refused\n");
}
