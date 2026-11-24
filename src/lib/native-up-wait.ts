/**
 * When native `hack up` and `hack restart` return (owner decision, Nov 20):
 * once every container has started (Compose's rule: running, or exited 0 for a
 * job others wait on), with routes still warming; `--wait` keeps the old
 * behaviour and returns once every goal is met and every route answers.
 */

/**
 * Whether `--json` and `--no-interactive` imply `--wait`. One constant, so the
 * owner's answer (open question Q4, recommended `false`) is a one-line change.
 */
export const NATIVE_UP_SCRIPTS_WAIT_BY_DEFAULT = false;

/** Whether this `up` or `restart` waits for every service to be ready. */
export function nativeUpWaitsForReady(opts: {
  readonly wait: boolean | undefined;
  readonly json: boolean | undefined;
  readonly interactive: boolean;
}): boolean {
  return (
    opts.wait === true ||
    (NATIVE_UP_SCRIPTS_WAIT_BY_DEFAULT &&
      (opts.json === true || !opts.interactive))
  );
}
