import { DAEMON_CLI_VERSION, probeDaemonApi } from "../daemon/client.ts";
import type { DaemonPaths } from "../daemon/paths.ts";
import {
  buildDaemonCommandData,
  createDaemonCommandTrace,
  type DaemonCommandName,
  type DaemonCommandTrace,
  type DaemonObservation,
} from "../daemon/reconcile.ts";
import { readDaemonStatus } from "../daemon/status.ts";
import { emitCliResult, errorResult, okResult } from "../lib/cli-result.ts";
import {
  captureLoggedProblems,
  setLoggerBackendOverride,
} from "../ui/logger.ts";

/**
 * Runs one `hack daemon start|stop|restart|install` step and, with
 * `--json`, prints its single envelope (HACK-2216, HACK-2238):
 * `{ok: true, data: {schema: "hack.daemon-<command>/v1", ...}}`, or on a
 * nonzero exit `{ok: false, error: {code: "E_DAEMON_SERVICE", message,
 * detail}}` whose message is the last warning or error the step logged and
 * whose detail is the same data. Human lines go to stderr meanwhile, so
 * stdout holds only the envelope. Exit codes are unchanged. A thrown error
 * (for example an access refusal) propagates to the CLI's own `--json`
 * error handling.
 */
export async function runDaemonCommand(opts: {
  readonly command: DaemonCommandName;
  readonly json: boolean;
  readonly paths: DaemonPaths;
  readonly run: (trace: DaemonCommandTrace) => Promise<number>;
}): Promise<number> {
  const trace = createDaemonCommandTrace();
  if (!opts.json) {
    return await opts.run(trace);
  }
  setLoggerBackendOverride({ backend: "console" });
  const problems = captureLoggedProblems();
  let code: number;
  try {
    code = await opts.run(trace);
  } finally {
    problems.stop();
    setLoggerBackendOverride({ backend: null });
  }
  const data = buildDaemonCommandData({
    command: opts.command,
    trace,
    daemon: await observeDaemon({ paths: opts.paths }),
    cliVersion: DAEMON_CLI_VERSION,
  });
  emitCliResult({
    result:
      code === 0
        ? okResult({ data })
        : errorResult({
            code: "E_DAEMON_SERVICE",
            message: problems.last() ?? `hack daemon ${opts.command} failed`,
            detail: data,
          }),
  });
  return code;
}

/** The daemon after the command: its pid file and what its API reports. */
async function observeDaemon(opts: {
  readonly paths: DaemonPaths;
}): Promise<DaemonObservation> {
  const status = await readDaemonStatus({ paths: opts.paths });
  if (!(status.running && status.socketExists)) {
    return { running: status.running, pid: status.pid, version: null };
  }
  const probe = await probeDaemonApi({
    socketPath: opts.paths.socketPath,
    timeoutMs: 1000,
  });
  return {
    running: true,
    pid: status.pid,
    version: probe.reachable ? probe.version : null,
  };
}
