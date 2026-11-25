import { CliUsageError } from "../cli/command.ts";
import { withCommandTimings } from "./command-timings.ts";
import { printCommandTimeline } from "./up-timings-output.ts";

const TITLES = {
  down: "Stop timeline",
  ps: "Status timeline",
} as const;

/**
 * Opt-in `hack.timings/1` collection for a finite native command (`down`,
 * `ps`). Without either flag the action runs directly and the timing transport
 * is never loaded. `--timings` prints the joined timeline to stderr, so a
 * `--json` result on stdout is unchanged; `--timings-file` writes the records
 * to a new JSONL file. Timing never changes the command's exit code or output.
 */
export async function withNativeCommandTimings(opts: {
  readonly command: keyof typeof TITLES;
  readonly timings: boolean | undefined;
  readonly timingsFile: string | undefined;
  readonly run: () => Promise<number>;
}): Promise<number> {
  if (!opts.timings && opts.timingsFile === undefined) {
    return await opts.run();
  }
  if (process.env.HACK_RUNTIME_BACKEND !== "native") {
    throw new CliUsageError(
      "--timings and --timings-file require the native backend."
    );
  }
  const title = TITLES[opts.command];
  return await withCommandTimings(
    opts.timingsFile,
    opts.run,
    opts.timings ? (records) => printCommandTimeline(records, title) : undefined
  );
}
