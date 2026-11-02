import { isAbsolute } from "node:path";
import { ClosedCliError } from "../../src/lib/cli-result.ts";

/**
 * Returns `root` when it is an absolute path, and refuses anything else.
 *
 * `resolve("")` and `join("", name)` name the current directory, which during
 * `bun test` is the checkout. A call that outlives its test, after `afterEach`
 * removed the fixture and reset its root to `""`, `null` or `undefined`, would
 * otherwise create files in the repository (HACK-1343). Every helper that
 * derives a path from a fixture root reads it through this function, so a late
 * call fails, closed, before it can write anything.
 */
export function requireFixtureRoot(root: unknown, owner: string): string {
  if (typeof root !== "string" || root.length === 0 || !isAbsolute(root)) {
    throw new ClosedCliError(
      `${owner}: the fixture root is not an absolute path; refusing to resolve it against the current directory.`
    );
  }
  return root;
}
