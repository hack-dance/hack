import { mock } from "bun:test";
import * as fs from "node:fs/promises";

/**
 * Preload for a source CLI child (`bun --preload <this> index.ts ...`): every
 * `open` of an atomic-write staging sibling (a path ending in `.tmp`) fails
 * with the errno named by `HACK_TEST_STAGING_ERRNO`, as a full disk (ENOSPC),
 * an exhausted quota (EDQUOT), a read-only mount (EROFS) or a non-directory
 * parent (ENOTDIR) would. The injected message spells the raw errno and the
 * staging path, like Node's own, so a test can prove neither reaches output.
 * Nothing else is mocked; no real disk is filled.
 */
const code = process.env.HACK_TEST_STAGING_ERRNO;
if (!code) {
  throw new Error("Missing HACK_TEST_STAGING_ERRNO");
}

// Captured before mocking: the namespace binding then points at the mock.
const realOpen = fs.open;

mock.module("node:fs/promises", () => ({
  ...fs,
  open: async (...args: Parameters<typeof fs.open>) => {
    const [path] = args;
    if (typeof path === "string" && path.endsWith(".tmp")) {
      throw Object.assign(
        new Error(`${code}: injected failure, open '${path}'`),
        { code, syscall: "open", path }
      );
    }
    return await realOpen(...args);
  },
}));
