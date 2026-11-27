/**
 * The CLI contract for a native `hack exec` or `hack run` whose output passed
 * the runtime's cap of 1 MiB per stream (HACK-2759). The runtime keeps the
 * beginning of each stream and reads the rest to its end, counting it. The CLI
 * writes what was kept, says that the output was truncated and how much was
 * dropped, and never exits 0 for an incomplete output.
 */

/** Bytes of each stream past the cap, when the runtime reported them. */
export type NativeCommandDrops = {
  readonly stdout: number;
  readonly stderr: number;
};

/** The one-line notice, written to stderr after the command's own output. */
export function nativeCommandTruncatedMessage(input: {
  readonly operation: "exec" | "run";
  readonly exitCode: number;
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
      ? `the first 1 MiB of each stream was written and ${dropped.join(" and ")} were dropped`
      : "the first 1 MiB of each stream was written and the rest was dropped";
  const status =
    input.exitCode === 0
      ? "The command succeeded, but hack exits with status 1 because its output is incomplete."
      : `The command exited with status ${input.exitCode}.`;
  return `hack ${input.operation} output was truncated: ${what}. ${status}\n`;
}

/** A command whose output was truncated never exits 0. */
export function nativeCommandExitCode(result: {
  readonly exitCode: number;
  readonly truncated: boolean;
}): number {
  return result.truncated && result.exitCode === 0 ? 1 : result.exitCode;
}
