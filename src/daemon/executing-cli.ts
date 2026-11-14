/**
 * The executable of the CLI running now, for deciding whether a service
 * runs "this CLI" (HACK-2216). Distinct from the `hack` this CLI would
 * install (the first on PATH, `resolveExpectedSystemdUnit` and
 * `resolveLaunchdHackBinPath`): `hack update` runs the new binary by
 * absolute path while an older `hack` may come first on PATH, and a
 * service running that older one is not this CLI.
 *
 * A compiled Hack binary (its entry is inside the binary's virtual
 * filesystem) is `process.execPath`. A source invocation (`bun index.ts`)
 * has no executable a unit or plist could name, so it is null: unknown,
 * which never makes a service eligible for an automatic restart or
 * refresh.
 */
export function resolveExecutingCliPath(
  opts: { readonly main?: string; readonly execPath?: string } = {}
): string | null {
  const main = opts.main ?? Bun.main;
  // A compiled Bun binary's entry lives in its virtual filesystem.
  const compiled = main.startsWith("/$bunfs/") || main.includes("~BUN");
  return compiled ? (opts.execPath ?? process.execPath) : null;
}
