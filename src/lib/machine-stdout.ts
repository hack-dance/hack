/**
 * Whether this process's stdout is reserved for Hack's machine output
 * (HACK-2311).
 *
 * With Hack's own `--json`, stdout carries exactly one JSON envelope (or,
 * with `--progress`, only ndjson events and the closing envelope). Output
 * of anything Hack runs for the command (lifecycle hooks, host commands,
 * the Compose client) then goes to stderr, never stdout. `runCli` sets this
 * once, from Hack's own argv only: a child command's `--json`, as in
 * `hack run web tool --json`, does not reserve stdout.
 *
 * Every place that would otherwise pass child stdout through to this
 * process's stdout checks this flag in addition to any per-call
 * `routeStdoutToStderr` option, so a call site that forgets the option
 * still keeps the envelope parseable.
 */
let reserved = false;

export function reserveStdoutForMachineOutput(): void {
  reserved = true;
}

export function isStdoutReservedForMachineOutput(): boolean {
  return reserved;
}

/** Tests only: undo {@link reserveStdoutForMachineOutput}. */
export function resetStdoutReservationForTests(): void {
  reserved = false;
}

/**
 * Where a child's stdout goes: `"stderr"` when the caller asked for it or
 * stdout is reserved for machine output, else `"inherit"`.
 */
export function childStdoutTarget(
  routeStdoutToStderr: boolean | undefined
): "stderr" | "inherit" {
  return routeStdoutToStderr === true || reserved ? "stderr" : "inherit";
}
