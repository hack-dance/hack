/**
 * Detached in-container jobs for the runtime footprint benchmark.
 *
 * A benchmark task (a package install, a 512 MiB write) can run longer than
 * one non-interactive `exec` is allowed to on every backend, and an exec that
 * gives up leaves its command running, which then overlaps the next sample.
 * So a job is started in the background, timed inside the guest from
 * `/proc/uptime`, and polled with short execs until it leaves an exit code.
 */

const JOB_DIR = "/tmp/.runtime-bench-job";

const START_SCRIPT = `
d=${JOB_DIR}
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

const POLL_SCRIPT = `
d=${JOB_DIR}
[ -e "$d/exit" ] || { echo "#running"; exit 0; }
echo "#exit"; cat "$d/exit"
echo "#start"; cat "$d/start"
echo "#end"; cat "$d/end"
echo "#err"; tail -c 2000 "$d/err"
echo "#out"; tail -c 4000 "$d/out"
`;

/** The argv that starts `argv` in the background inside a container. */
export function jobStartArgv(argv: readonly string[]): string[] {
  return ["sh", "-c", START_SCRIPT, "sh", ...argv];
}

/** The argv that reports a finished job, or `#running`. */
export function jobPollArgv(): string[] {
  return ["sh", "-c", POLL_SCRIPT];
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
export function parseJobPoll(text: string): JobResult | null {
  const lines = text.split("\n");
  if (lines[0]?.trim() === "#running") {
    return null;
  }
  const parts = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of lines) {
    if (/^#(exit|start|end|err|out)$/.test(line) && !parts.has(line)) {
      current = [];
      parts.set(line, current);
    } else {
      current?.push(line);
    }
  }
  const number = (key: string): number =>
    Number((parts.get(key) ?? []).join("").trim() || Number.NaN);
  const exitCode = number("#exit");
  const start = number("#start");
  const end = number("#end");
  if (
    !(Number.isInteger(exitCode) && parts.has("#out")) ||
    Number.isNaN(start) ||
    Number.isNaN(end) ||
    end < start
  ) {
    throw new Error("incomplete job record");
  }
  return {
    exitCode,
    seconds: Math.round((end - start) * 100) / 100,
    stdout: (parts.get("#out") ?? []).join("\n"),
    stderr: (parts.get("#err") ?? []).join("\n"),
  };
}

/** True when a non-interactive exec gave up without knowing the outcome. */
export function execGaveUp(stderr: string): boolean {
  return stderr.includes("graph_service_exec_uncertain");
}
