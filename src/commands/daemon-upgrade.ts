import { probeDaemonApi } from "../daemon/client.ts";
import { getLaunchdServiceStatus } from "../daemon/launchd.ts";
import { type DaemonPaths, resolveDaemonPaths } from "../daemon/paths.ts";
import {
  DAEMON_RECONCILE_ONLY_ENV,
  type DaemonCommandAction,
  type DaemonServiceManager,
  type DaemonStaleReason,
} from "../daemon/reconcile.ts";
import { readDaemonStatus } from "../daemon/status.ts";
import { childEnvironment } from "../lib/child-environment.ts";
import { isRecord } from "../lib/guards.ts";
import { resolveSystemdStatus } from "./daemon-systemd.ts";

/**
 * What `hack update` did about hackd after installing a new release
 * (HACK-2216). Best effort: it never fails the update.
 * - `skipped`: no login service is installed for this Hack home
 *   (`no-service`), or it is installed but hackd is not running
 *   (`not-running`; nothing is started, and the next `hack daemon start`
 *   brings the service up to the new version);
 * - `reconciled`: the new executable's `hack daemon start --json` ran and
 *   succeeded;
 * - `failed`: it ran and failed, or could not be run; `next_step` says how
 *   to finish by hand.
 */
export type PostUpdateDaemonResult =
  | {
      readonly status: "skipped";
      readonly reason: "no-service" | "not-running";
    }
  | {
      readonly status: "reconciled";
      readonly manager: DaemonServiceManager;
      readonly action: DaemonCommandAction;
      readonly stale_reasons: readonly DaemonStaleReason[];
    }
  | {
      readonly status: "failed";
      readonly message: string;
      readonly next_step: "hack daemon install";
    };

/** What the post-update step needs to know before it runs anything. */
export interface PostUpdateDaemonState {
  readonly serviceInstalled: boolean;
  readonly daemonRunning: boolean;
}

const RECONCILE_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 64 * 1024;

/**
 * Runs the same reconcile as `hack daemon start` with the newly installed
 * executable, so the decision uses the new version's unit renderer and
 * version (this process is still the old CLI). Only when a login service
 * is installed and hackd is running: a daemon that was not running is not
 * started.
 */
export async function reconcileDaemonAfterUpdate(opts: {
  /** The executable the update just replaced, now the new version. */
  readonly binaryPath: string;
  /** Defaults to reading the systemd unit or launchd plist and pid file. */
  readonly observe?: () => Promise<PostUpdateDaemonState>;
  /** Defaults to running the executable with a bounded wait. */
  readonly runCli?: (
    argv: readonly string[]
  ) => Promise<{ readonly exitCode: number; readonly stdout: string }>;
}): Promise<PostUpdateDaemonResult> {
  // Everything here is best effort: the binary is already replaced, so no
  // failure (observing included) may fail the update.
  try {
    const state = await (opts.observe ?? (() => observePostUpdateDaemon()))();
    if (!state.serviceInstalled) {
      return { status: "skipped", reason: "no-service" };
    }
    if (!state.daemonRunning) {
      return { status: "skipped", reason: "not-running" };
    }
    // Reconcile-only: if hackd stopped since it was observed, the child
    // does nothing instead of starting it.
    const run = await (opts.runCli ?? runBounded)([
      opts.binaryPath,
      "daemon",
      "start",
      "--json",
    ]);
    return parseStartEnvelope({ exitCode: run.exitCode, stdout: run.stdout });
  } catch (error: unknown) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Reads `hack daemon start --json` output. Anything off the
 * `hack.daemon-start/v1` contract is a failure, never a success.
 */
export function parseStartEnvelope(opts: {
  readonly exitCode: number;
  readonly stdout: string;
}): PostUpdateDaemonResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.stdout);
  } catch {
    return failed(
      `hack daemon start exited ${opts.exitCode} without a JSON result`
    );
  }
  if (!isRecord(parsed)) {
    return failed("hack daemon start printed an unexpected result");
  }
  if (parsed.ok === true && isRecord(parsed.data)) {
    const data = parsed.data;
    if (data.schema !== "hack.daemon-start/v1" || opts.exitCode !== 0) {
      return failed("hack daemon start printed an unexpected result");
    }
    return {
      status: "reconciled",
      manager: oneOf(data.manager, ["systemd", "launchd", "none"], "none"),
      action: oneOf(
        data.action,
        ["none", "started", "restarted", "reinstalled", "stopped", "installed"],
        "none"
      ),
      stale_reasons: Array.isArray(data.stale_reasons)
        ? data.stale_reasons.filter(
            (reason): reason is DaemonStaleReason =>
              reason === "content" ||
              reason === "program-missing" ||
              reason === "version-mismatch"
          )
        : [],
    };
  }
  const error = isRecord(parsed.error) ? parsed.error : null;
  return failed(
    typeof error?.message === "string"
      ? error.message
      : `hack daemon start exited ${opts.exitCode}`
  );
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T
): T {
  return allowed.find((candidate) => candidate === value) ?? fallback;
}

function failed(message: string): PostUpdateDaemonResult {
  return { status: "failed", message, next_step: "hack daemon install" };
}

/**
 * Whether a login service is installed and this home's hackd is running.
 * A live pid alone is not enough (a stale pid file can name a reused pid):
 * hackd must answer on this home's socket.
 */
export async function observePostUpdateDaemon(
  opts: {
    readonly paths?: DaemonPaths;
    /** Defaults to reading the systemd unit or launchd plist. */
    readonly serviceInstalled?: () => Promise<boolean>;
  } = {}
): Promise<PostUpdateDaemonState> {
  const paths = opts.paths ?? resolveDaemonPaths({});
  const serviceInstalled = await (
    opts.serviceInstalled ?? (() => readServiceInstalled({ paths }))
  )();
  if (!serviceInstalled) {
    return { serviceInstalled, daemonRunning: false };
  }
  const daemon = await readDaemonStatus({ paths });
  if (!(daemon.running && daemon.socketExists)) {
    return { serviceInstalled, daemonRunning: false };
  }
  const probe = await probeDaemonApi({
    socketPath: paths.socketPath,
    timeoutMs: 1000,
  });
  return { serviceInstalled, daemonRunning: probe.reachable };
}

async function readServiceInstalled(opts: {
  readonly paths: DaemonPaths;
}): Promise<boolean> {
  if (process.platform === "linux") {
    return (await resolveSystemdStatus())?.status.installed === true;
  }
  if (process.platform === "darwin") {
    return (await getLaunchdServiceStatus({ paths: opts.paths })).installed;
  }
  return false;
}

async function runBounded(
  argv: readonly string[]
): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  const proc = Bun.spawn([...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: childEnvironment({
      ...process.env,
      HACK_NO_INTERACTIVE: "1",
      [DAEMON_RECONCILE_ONLY_ENV]: "1",
    }),
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), RECONCILE_TIMEOUT_MS);
  try {
    const [exitCode, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    return { exitCode, stdout: stdout.slice(0, MAX_OUTPUT_CHARS) };
  } finally {
    clearTimeout(timer);
  }
}
