/**
 * Spawns a hackd launcher that must outlive its caller.
 *
 * `detached: true` makes Bun call `setsid()` in the child: it leads a new
 * session and process group, has no controlling terminal, and so does not
 * receive the SIGHUP of a closing terminal or a signal sent to the caller's
 * process group (an agent harness killing its group, `kill -- -PGID`).
 * stdio is ignored so the caller never waits on pipes the daemon holds;
 * hackd writes its own capped log file. The child is unref'd, so the caller
 * exits without waiting for it (HACK-2052).
 *
 * This does not escape a systemd scope or cgroup that is torn down at logout
 * (`KillUserProcesses=yes`); `hack daemon install` covers that case.
 *
 * Throws when the executable cannot be spawned.
 */
export function spawnDetachedDaemon(opts: {
  readonly argv: readonly string[];
}): { readonly pid: number } {
  const proc = Bun.spawn([...opts.argv], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  proc.unref();
  return { pid: proc.pid };
}
