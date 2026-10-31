import { mock } from "bun:test";
import * as fs from "node:fs/promises";

/**
 * Preload for a source CLI child (`bun --preload <this> index.ts ...`) that
 * fails one filesystem step with the errno named by `HACK_TEST_STAGING_ERRNO`,
 * as a full disk (ENOSPC), an exhausted quota (EDQUOT), a read-only mount
 * (EROFS), a non-directory parent (ENOTDIR) or a directory in the way (EISDIR)
 * would. No real disk is filled.
 *
 * - `HACK_TEST_ERRNO_STEP` picks the step (default `open`): `open`, `access`,
 *   `lstat` or `rename` of a matching path (the rename's source), `link` from
 *   a matching source (for example ENOTSUP, as on a filesystem without hard
 *   links such as ExFAT), `write` or `sync` on a handle opened at a matching
 *   path, or `bun-write` (`Bun.write`) to a matching path.
 * - `HACK_TEST_ERRNO_PATH` is a regular expression a path must match (default
 *   `\.tmp$`, an atomic-write staging sibling).
 *
 * The injected message spells the raw errno and the path, like Node's own, so
 * a test can prove neither reaches output. Nothing else is mocked.
 */
const code = process.env.HACK_TEST_STAGING_ERRNO;
if (!code) {
  throw new Error("Missing HACK_TEST_STAGING_ERRNO");
}
const step = process.env.HACK_TEST_ERRNO_STEP ?? "open";
const STEPS = [
  "open",
  "access",
  "lstat",
  "rename",
  "link",
  "write",
  "sync",
  "bun-write",
];
if (!STEPS.includes(step)) {
  throw new Error(`HACK_TEST_ERRNO_STEP must be one of ${STEPS.join(", ")}`);
}
const pattern = new RegExp(process.env.HACK_TEST_ERRNO_PATH ?? "\\.tmp$");

function matches(path: unknown): path is string {
  return typeof path === "string" && pattern.test(path);
}

function injected(syscall: string, path: string): Error {
  return Object.assign(
    new Error(`${code}: injected failure, ${syscall} '${path}'`),
    { code, syscall, path }
  );
}

// Captured before mocking: the namespace bindings then point at the mocks.
const realOpen = fs.open;
const realAccess = fs.access;
const realLstat = fs.lstat;
const realRename = fs.rename;
const realLink = fs.link;

type Handle = Awaited<ReturnType<typeof fs.open>>;

/** Makes one method of a real handle fail; the handle still closes normally. */
function failHandleMethod(handle: Handle, path: string): Handle {
  const method = step === "write" ? "writeFile" : "sync";
  Object.defineProperty(handle, method, {
    configurable: true,
    value: async () => {
      throw injected(step, path);
    },
  });
  return handle;
}

mock.module("node:fs/promises", () => ({
  ...fs,
  open: async (...args: Parameters<typeof fs.open>) => {
    const [path] = args;
    if (step === "open" && matches(path)) {
      throw injected("open", path);
    }
    const handle = await realOpen(...args);
    return (step === "write" || step === "sync") && matches(path)
      ? failHandleMethod(handle, path)
      : handle;
  },
  access: async (...args: Parameters<typeof fs.access>) => {
    if (step === "access" && matches(args[0])) {
      throw injected("access", args[0]);
    }
    return await realAccess(...args);
  },
  lstat: async (...args: Parameters<typeof fs.lstat>) => {
    if (step === "lstat" && matches(args[0])) {
      throw injected("lstat", args[0]);
    }
    return await realLstat(...args);
  },
  rename: async (...args: Parameters<typeof fs.rename>) => {
    if (step === "rename" && matches(args[0])) {
      throw injected("rename", args[0]);
    }
    return await realRename(...args);
  },
  link: async (...args: Parameters<typeof fs.link>) => {
    if (step === "link" && matches(args[0])) {
      throw injected("link", String(args[0]));
    }
    return await realLink(...args);
  },
}));

if (step === "bun-write") {
  const realWrite = Bun.write;
  const write = (async (...args: Parameters<typeof Bun.write>) => {
    if (matches(args[0])) {
      throw injected("open", args[0]);
    }
    return await realWrite(...args);
  }) as typeof Bun.write;
  Object.assign(Bun, { write });
}
