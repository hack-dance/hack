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

/**
 * How to run THIS CLI again (HACK-2216): the executing compiled binary, or,
 * for a source invocation, the same runtime with the same entry point
 * (`bun index.ts`). Never the `hack` first on PATH: during `hack update`
 * the new binary runs by absolute path while an older `hack` may come
 * first on PATH, and a replacement daemon started from that one would run
 * the old version.
 */
export function resolveExecutingInvocation(
  opts: { readonly main?: string; readonly execPath?: string } = {}
): { readonly bin: string; readonly args: readonly string[] } {
  const executing = resolveExecutingCliPath(opts);
  if (executing !== null) {
    return { bin: executing, args: [] };
  }
  return {
    bin: opts.execPath ?? process.execPath,
    args: [opts.main ?? Bun.main],
  };
}

/** The argv that starts this CLI's hackd in the foreground. */
export function executingDaemonArgv(
  opts: { readonly main?: string; readonly execPath?: string } = {}
): readonly string[] {
  const invocation = resolveExecutingInvocation(opts);
  return [
    invocation.bin,
    ...invocation.args,
    "daemon",
    "start",
    "--foreground",
  ];
}
