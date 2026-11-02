import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Make `root` the repository root for repo-root discovery.
 *
 * `findRepoRootForInit` walks up from its start directory to the nearest
 * `package.json` or `.git`. A temp fixture without its own `package.json`
 * (an empty repo, a Python-only repo) otherwise resolves to whatever host
 * ancestor has one. With a stray `/tmp/package.json` on a shared machine and
 * `TMPDIR=/tmp`, the onboarding inventory scanned all of `/tmp`, so the tests
 * hit their timeout while describing the wrong repo.
 *
 * An empty `.git` directory stops the walk at the fixture. The inventory never
 * reads dot directories, so it reports the same signals.
 */
export async function markRepoBoundary(root: string): Promise<void> {
  await mkdir(join(root, ".git"), { recursive: true });
}
