import { mock } from "bun:test";
import * as fs from "node:fs/promises";

/**
 * Runs one `writeTextFileAtomicIfChanged` in a disposable child where the
 * target appears to belong to another user: `stat` of the target reports the
 * caller's uid plus one, so the staging file must be `fchown`ed to a user the
 * caller is not. Run as a non-root user, that `fchown` really fails with EPERM;
 * nothing else is mocked. Prints `refused:<reason>` for an
 * `AtomicWriteRefusedError`, `failed` for any other rejection and `committed`
 * if the write succeeds. The content is a synthetic test string passed on
 * stdin, never in argv.
 */
const [target] = process.argv.slice(2);
if (!target) {
  throw new Error("Missing atomic write worker target");
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
    return Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
      uid: Number(info.uid) + 1,
    });
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
