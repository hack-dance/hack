import { mock } from "bun:test";
import * as fs from "node:fs/promises";

/**
 * Runs one `writeTextFileAtomicIfChanged` in a disposable child where the
 * target appears to belong to another user or group. With `uid` (the default)
 * `stat` of the target reports the caller's uid plus one; with `gid` it keeps
 * the caller's uid and reports the group passed as the third argument, which
 * the caller must not belong to. The staging file must then be `fchown`ed to
 * an owner or group the caller cannot assign; run as a non-root user, that
 * `fchown` really fails with EPERM, and nothing else is mocked. Prints
 * `refused:<reason>` for an `AtomicWriteRefusedError`, `failed` for any other
 * rejection and `committed` if the write succeeds. The content is a synthetic
 * test string passed on stdin, never in argv.
 */
const [target, field = "uid", foreignGid] = process.argv.slice(2);
if (!target) {
  throw new Error("Missing atomic write worker target");
}
if (field !== "uid" && field !== "gid") {
  throw new Error("Atomic write worker field must be uid or gid");
}
if (field === "gid" && !foreignGid) {
  throw new Error("Missing atomic write worker foreign gid");
}

// Captured before mocking: the namespace binding then points at the mock.
const realStat = fs.stat;

mock.module("node:fs/promises", () => ({
  ...fs,
  stat: async (...args: Parameters<typeof fs.stat>) => {
    const info = await realStat(...args);
    if (args[0] !== target) {
      return info;
    }
    const foreign =
      field === "uid"
        ? { uid: Number(info.uid) + 1 }
        : { gid: Number(foreignGid) };
    return Object.assign(
      Object.create(Object.getPrototypeOf(info)),
      info,
      foreign
    );
  },
}));

const content = await Bun.stdin.text();
const { AtomicWriteRefusedError, writeTextFileAtomicIfChanged } = await import(
  "../../src/lib/fs.ts"
);
try {
  await writeTextFileAtomicIfChanged(target, content);
  process.stdout.write("committed\n");
} catch (error: unknown) {
  process.stdout.write(
    error instanceof AtomicWriteRefusedError
      ? `refused:${error.reason}\n`
      : "failed\n"
  );
}
