import { hackReexecEnvironment } from "../lib/child-environment.ts";

/**
 * Flags that scope one `hack daemon` invocation and must not reach the
 * daemon it starts (or anything that daemon starts):
 * - `HACK_DAEMON_SERVICE_READ_ONLY`: `hack doctor --fix` sets it for that
 *   one repair;
 * - `HACK_DAEMON_RECONCILE_ONLY`: `hack update` sets it for the new
 *   executable's `daemon start --json`, which never starts a stopped
 *   daemon. A daemon it replaces must start normally (HACK-2216).
 */
const INVOCATION_ONLY_ENV_KEYS = [
  "HACK_DAEMON_SERVICE_READ_ONLY",
  "HACK_DAEMON_RECONCILE_ONLY",
] as const;

/** The environment for a detached hackd: the caller's, minus those flags. */
export function detachedDaemonEnvironment(
  base: Readonly<Record<string, string | undefined>>
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const key of INVOCATION_ONLY_ENV_KEYS) {
    Reflect.deleteProperty(env, key);
  }
  return env;
}
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
    env: hackReexecEnvironment(detachedDaemonEnvironment(process.env)),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  proc.unref();
  return { pid: proc.pid };
}
