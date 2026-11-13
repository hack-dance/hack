import { hackReexecEnvironment } from "../lib/child-environment.ts";
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
  // `hack doctor --fix` may run this with the read-only service flag; it is
  // for that one repair, not for the daemon and everything it starts.
  const env: Record<string, string | undefined> = { ...process.env };
  Reflect.deleteProperty(env, "HACK_DAEMON_SERVICE_READ_ONLY");
  const proc = Bun.spawn([...opts.argv], {
    env: hackReexecEnvironment(env),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  proc.unref();
  return { pid: proc.pid };
}
