/**
 * The CLI contract for a native `hack exec` or `hack run` whose output passed
 * the runtime's cap of 1 MiB per stream (HACK-2759). The runtime keeps the
 * beginning of each stream and reads the rest to its end, counting it. The CLI
 * writes what was kept and says on stderr that the output is incomplete and how
 * much was dropped. The exit status stays the command's own, so a passing
 * command with a large output (a CI test run) still passes.
 *
 * Without counts the notice claims no more than the runtime observed: the
 * runtime also reports a large output whose end the engine socket lost past the
 * kept range, with no counts, so "at most" covers a stream that kept less.
 */

/** Bytes of each stream past the cap, when the runtime reported them. */
export type NativeCommandDrops = {
  readonly stdout: number;
  readonly stderr: number;
};

/** The one-line notice, written to stderr after the command's own output. */
export function nativeCommandTruncatedMessage(input: {
  readonly operation: "exec" | "run";
  readonly dropped?: NativeCommandDrops;
}): string {
  const dropped = [
    input.dropped?.stdout
      ? `${input.dropped.stdout} bytes of stdout`
      : undefined,
    input.dropped?.stderr
      ? `${input.dropped.stderr} bytes of stderr`
      : undefined,
  ].filter((part) => part !== undefined);
  const what =
    dropped.length > 0
      ? `only the first 1 MiB of each stream was written and ${dropped.join(" and ")} were dropped`
      : "at most the first 1 MiB of each stream was written and the rest was dropped";
  return `hack ${input.operation} output is incomplete: ${what}.\n`;
}
