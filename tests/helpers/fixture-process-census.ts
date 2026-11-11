/**
 * Scope read-only incarnation observations to the fixture's processes. Real ps,
 * getsid, boot and image checks remain in use; unrelated host process churn is
 * covered separately by native-authored-process-incarnation.test.ts.
 * The caller must include every process whose presence it asserts, even after
 * that process exits, and restore the wrapper before releasing the fixture.
 */
export function installFixtureProcessCensus(
  pids: () => readonly number[]
): () => void {
  const spawn = Bun.spawn;
  // Bun.spawn has array and options-object overloads. Preserve both unchanged
  // except for the exact host-wide ps probe used by the incarnation reader.
  const scoped = ((...args: unknown[]) => {
    const command = args[0];
    if (
      Array.isArray(command) &&
      command[0] === "/bin/ps" &&
      command[1] === "-Aww"
    ) {
      const selected = pids();
      if (
        selected.length === 0 ||
        selected.some((pid) => !Number.isSafeInteger(pid) || pid < 1)
      ) {
        throw new Error("Fixture census requires positive owned PIDs.");
      }
      args[0] = [
        "/bin/ps",
        "-ww",
        "-p",
        selected.join(","),
        ...command.slice(2),
      ];
    }
    return Reflect.apply(spawn, Bun, args);
  }) as typeof Bun.spawn;
  Bun.spawn = scoped;
  return () => {
    Bun.spawn = spawn;
  };
}
