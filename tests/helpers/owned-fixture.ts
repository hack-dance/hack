import { mkdir, writeFile } from "node:fs/promises";

/** Create a positive fixture for checks that reject group-writable paths. */
export async function mkdirOwnedFixture(path: string, recursive = false) {
  await mkdir(path, { mode: 0o700, recursive });
}

/** Preserve the requested permissions of an existing fixture entry. */
export async function writeOwnedFixture(
  path: string,
  content: string | Uint8Array
) {
  await writeFile(path, content, { mode: 0o600 });
}

/** Git creates its own positive-fixture paths instead of accepting file modes. */
export function ownedFixtureCommand(args: readonly string[]): string[] {
  return ["sh", "-c", 'umask 022; exec "$@"', "fixture", ...args];
}
