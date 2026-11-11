import { exec } from "../shell.ts";

/** Environment marker on a background `exec`'s process in the container. */
export const GUEST_MARKER_ENV = "HACK_BACKGROUND_COMMAND";

/**
 * Set on the stop script's own process by the runtime (`exec -e`): the
 * script's positive control looks for it in its own environment.
 */
export const GUEST_STOP_PROBE_ENV = "HACK_BACKGROUND_STOP_PROBE=1";

/**
 * POSIX sh run inside the container: TERM, then KILL, every process whose
 * environment carries the marker, then exit 0 only if none is left.
 *
 * Fails closed: it first reads its own `/proc/$$/environ` the same way it
 * reads every other process's and must find `GUEST_STOP_PROBE_ENV` (set by
 * the runtime, which really execs this shell; a nested busybox `sh` may not
 * be exec'd, so its environ cannot serve as the control). A missing `/proc`
 * or `tr` therefore exits nonzero instead of reading as "none left".
 * Matching uses shell built-ins only. A process whose environment cannot be
 * read (another user's, or gone mid-scan) is skipped: the command's own
 * processes run as the exec user and stay readable unless they change user.
 * Needs `sh`, `/proc` and `tr`; `sleep` only paces the TERM grace.
 */
export const GUEST_STOP_SCRIPT = [
  `m="${GUEST_MARKER_ENV}=$1"`,
  'nl="\n"',
  `has() { e=$(tr '\\0' '\\n' 2>/dev/null < "$1/environ") || return 1; case "$nl$e$nl" in *"$nl$2$nl"*) return 0 ;; esac; return 1; }`,
  `has "/proc/$$" "${GUEST_STOP_PROBE_ENV}" || exit 3`,
  `marked() { for d in /proc/[0-9]*; do has "$d" "$m" && echo "\${d##*/}"; done; }`,
  "first=$(marked)",
  'test -z "$first" && exit 0',
  'for p in $first; do kill -TERM "$p" 2>/dev/null; done',
  "sleep 2",
  'for p in $(marked); do kill -KILL "$p" 2>/dev/null; done',
  "sleep 1",
  'test -z "$(marked)"',
].join("\n");

/** Kept short so the stop path stays well inside a 30 s MCP control call. */
const INSPECT_TIMEOUT_MS = 5000;
const REMOVE_TIMEOUT_MS = 10_000;
const NO_SUCH_CONTAINER = /no such (object|container)/i;

/**
 * Remove a background `run`'s one-off container after its Compose client was
 * stopped (cancel or timeout); stopping the client alone leaves the
 * container, and the process in it, running.
 *
 * Ownership: the container is named by the launcher (`hack-bg-<random>`) and
 * is removed only if Docker reports it as a Compose one-off container of the
 * expected service. Returns `stopped` when it is confirmed gone (removed, or
 * already removed by `--rm`), `not_confirmed` otherwise (Docker unreachable,
 * labels do not match, removal failed).
 */
export async function removeOneOffContainer(opts: {
  readonly name: string;
  readonly service: string;
  readonly env: Readonly<Record<string, string>>;
}): Promise<"stopped" | "not_confirmed"> {
  const inspect = await docker(opts, [
    "inspect",
    "--type",
    "container",
    "--format",
    '{{index .Config.Labels "com.docker.compose.oneoff"}} {{index .Config.Labels "com.docker.compose.service"}}',
    opts.name,
  ]);
  if (inspect === null) {
    return "not_confirmed";
  }
  if (inspect.exitCode !== 0) {
    return NO_SUCH_CONTAINER.test(inspect.stderr) ? "stopped" : "not_confirmed";
  }
  if (inspect.stdout.trim() !== `True ${opts.service}`) {
    return "not_confirmed";
  }
  const removed = await docker(
    opts,
    ["rm", "--force", opts.name],
    REMOVE_TIMEOUT_MS
  );
  if (!removed) {
    return "not_confirmed";
  }
  const after = await docker(opts, [
    "inspect",
    "--type",
    "container",
    "--format",
    "{{.Id}}",
    opts.name,
  ]);
  return after !== null &&
    after.exitCode !== 0 &&
    NO_SUCH_CONTAINER.test(after.stderr)
    ? "stopped"
    : "not_confirmed";
}

async function docker(
  opts: { readonly env: Readonly<Record<string, string>> },
  args: readonly string[],
  timeoutMs = INSPECT_TIMEOUT_MS
): Promise<{ exitCode: number; stdout: string; stderr: string } | null> {
  try {
    return await exec(["docker", ...args], {
      stdin: "ignore",
      timeoutMs,
      env: { ...opts.env },
    });
  } catch {
    return null;
  }
}

/**
 * Stop a background `exec`'s process in the container after its Compose
 * client was stopped or died: stopping the client alone leaves the process
 * running. Matches processes by the marker in their environment, set by
 * `docker compose exec -e` at start. Returns `stopped` when the script
 * confirms none is left, `not_confirmed` otherwise (no `sh` or `/proc` in the
 * image, the container is gone or unreachable, the script failed).
 */
export async function stopExecGuest(opts: {
  readonly marker: string;
  readonly service: string;
  readonly compose: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
}): Promise<"stopped" | "not_confirmed"> {
  try {
    const result = await exec(
      [
        ...opts.compose,
        "exec",
        "-T",
        "-e",
        GUEST_STOP_PROBE_ENV,
        opts.service,
        "sh",
        "-c",
        GUEST_STOP_SCRIPT,
        "hack-background-stop",
        opts.marker,
      ],
      {
        stdin: "ignore",
        cwd: opts.cwd,
        timeoutMs: REMOVE_TIMEOUT_MS,
        env: { ...opts.env },
      }
    );
    return result.exitCode === 0 ? "stopped" : "not_confirmed";
  } catch {
    return "not_confirmed";
  }
}
