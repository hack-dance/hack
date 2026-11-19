/**
 * Detached in-container jobs for the runtime footprint benchmark.
 *
 * A benchmark task (a package install, a 512 MiB write) can run longer than
 * one non-interactive `exec` is allowed to on every backend, and an exec that
 * gives up leaves its command running, which then overlaps the next sample.
 * So a job is started in the background, timed inside the guest from
 * `/proc/uptime`, and polled with short execs until it leaves an exit code.
 */

const JOB_ID = /^[a-z0-9]{8,32}$/;

/** Each job has its own directory, so a job left running cannot write into a later one. */
function jobDir(id: string): string {
  if (!JOB_ID.test(id)) {
    throw new Error("job id must be 8 to 32 lowercase letters or digits");
  }
  return `/tmp/.runtime-bench-job-${id}`;
}

const START_SCRIPT = `
d="$1"; shift
rm -rf "$d"; mkdir -p "$d" || exit 1
now() { cut -d" " -f1 /proc/uptime; }
(
  now > "$d/start"
  "$@" > "$d/out" 2> "$d/err"
  echo $? > "$d/exit.tmp"
  now > "$d/end"
  mv "$d/exit.tmp" "$d/exit"
) < /dev/null > /dev/null 2>&1 &
`;

// Each marker carries the job id and follows a newline, so command output cannot
// end a section early or hide the next marker behind an unterminated last line.
const POLL_SCRIPT = `
d="$1"; m="#$2"
[ -e "$d/exit" ] || { echo "$m:running"; exit 0; }
echo "$m:exit"; cat "$d/exit"
echo "$m:start"; cat "$d/start"
echo "$m:end"; cat "$d/end"
echo "$m:err"; tail -c 2000 "$d/err"; echo
echo "$m:out"; tail -c 4000 "$d/out"; echo
echo "$m:done"
`;

/** The argv that starts `argv` in the background inside a container. */
export function jobStartArgv(id: string, argv: readonly string[]): string[] {
  return ["sh", "-c", START_SCRIPT, "sh", jobDir(id), ...argv];
}

/** The argv that reports a finished job, or `#running`. */
export function jobPollArgv(id: string): string[] {
  return ["sh", "-c", POLL_SCRIPT, "sh", jobDir(id), id];
}

export type JobResult = {
  readonly exitCode: number;
  /** Guest-clock duration of the command alone, 10 ms resolution. */
  readonly seconds: number;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Parses one poll reply. `null` means the job is still running; a reply that
 * is neither running nor a complete record throws, because a truncated
 * record must never be read as a result.
 */
export function parseJobPoll(id: string, text: string): JobResult | null {
  const lines = text.split("\n");
  if (lines[0]?.trim() === `#${id}:running`) {
    return null;
  }
  const order = ["exit", "start", "end", "err", "out", "done"];
  const parts = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines) {
    const next = order[parts.size];
    if (next !== undefined && line === `#${id}:${next}`) {
      current = [];
      parts.set(next, current);
    } else {
      current?.push(line);
    }
  }
  const number = (key: string): number =>
    Number((parts.get(key) ?? []).join("").trim() || Number.NaN);
  const exitCode = number("exit");
  const start = number("start");
  const end = number("end");
  if (
    !(Number.isInteger(exitCode) && parts.has("done")) ||
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    end < start
  ) {
    throw new Error("incomplete job record");
  }
  // The newline the poll script adds after each stream is the one that ends
  // its last line here, so joining the lines gives the stream back unchanged.
  const stream = (key: string): string => (parts.get(key) ?? []).join("\n");
  return {
    exitCode,
    seconds: Math.round((end - start) * 100) / 100,
    stdout: stream("out"),
    stderr: stream("err"),
  };
}

/**
 * The kernel's figure for a process from macOS `footprint --format bytes`:
 * the `phys_footprint` line, which Activity Monitor shows as Memory. Not the
 * `Footprint:` header, which sums only the regions the tool can walk and for
 * a VM process came out at under half, and not `phys_footprint_peak`.
 */
export function parsePhysFootprintBytes(text: string): number | null {
  const match = /^\s*phys_footprint:\s+(\d+)\s+B\s*$/m.exec(text);
  return match ? Number(match[1]) : null;
}

/** True when a non-interactive exec gave up without knowing the outcome. */
export function execGaveUp(stderr: string): boolean {
  return stderr.includes("graph_service_exec_uncertain");
}
