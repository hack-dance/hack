import { mock } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";

/**
 * Swap-and-restore of a file's parent directory around one private read
 * (HACK-2165): just before the reader observes `<hackDir>/.env`, `hackDir`
 * is replaced by a link to `outsideDir` (which holds its own `.env`); right
 * after the reader opens it, the original directory is put back. Prints the
 * text the reader returned, or `refused`. Temporary paths only.
 */
const [hackDir, outsideDir] = process.argv.slice(2);
if (!(hackDir && outsideDir)) {
  throw new Error("Missing directories");
}
const envFile = join(hackDir, ".env");
const aside = `${hackDir}.aside`;
const { lstat, open, rename, rm, symlink } = fs;
let swapped = false;
let done = false;
mock.module("node:fs/promises", () => ({
  ...fs,
  lstat: async (path: string, ...rest: unknown[]) => {
    if (path === envFile && !done && !swapped) {
      await rename(hackDir, aside);
      await symlink(outsideDir, hackDir);
      swapped = true;
    }
    return await (lstat as (...args: unknown[]) => Promise<unknown>)(
      path,
      ...rest
    );
  },
  open: async (path: string, ...rest: unknown[]) => {
    const handle = await (open as (...args: unknown[]) => Promise<unknown>)(
      path,
      ...rest
    );
    if (path === envFile && swapped && !done) {
      await rm(hackDir);
      await rename(aside, hackDir);
      done = true;
    }
    return handle;
  },
}));
const { readPrivateEnvFile } = await import(
  "../../src/lib/private-env-file.ts"
);
try {
  process.stdout.write(
    `${(await readPrivateEnvFile({ envFile })) ?? "absent"}`
  );
} catch {
  process.stdout.write("refused");
}
