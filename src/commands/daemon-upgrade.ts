import { getLaunchdServiceStatus } from "../daemon/launchd.ts";
import { resolveDaemonPaths } from "../daemon/paths.ts";
import type {
  DaemonCommandAction,
  DaemonServiceManager,
  DaemonStaleReason,
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
  const state = await (opts.observe ?? observePostUpdateDaemon)();
  if (!state.serviceInstalled) {
    return { status: "skipped", reason: "no-service" };
  }
  if (!state.daemonRunning) {
    return { status: "skipped", reason: "not-running" };
  }
  let run: { readonly exitCode: number; readonly stdout: string };
  try {
    run = await (opts.runCli ?? runBounded)([
      opts.binaryPath,
      "daemon",
      "start",
      "--json",
    ]);
  } catch (error: unknown) {
    return failed(error instanceof Error ? error.message : String(error));
  }
  return parseStartEnvelope({ exitCode: run.exitCode, stdout: run.stdout });
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

async function observePostUpdateDaemon(): Promise<PostUpdateDaemonState> {
  const paths = resolveDaemonPaths({});
  let serviceInstalled = false;
  if (process.platform === "linux") {
    serviceInstalled =
      (await resolveSystemdStatus())?.status.installed === true;
  } else if (process.platform === "darwin") {
    serviceInstalled = (await getLaunchdServiceStatus({ paths })).installed;
  }
  const daemon = await readDaemonStatus({ paths });
  return { serviceInstalled, daemonRunning: daemon.running };
}

async function runBounded(
  argv: readonly string[]
): Promise<{ readonly exitCode: number; readonly stdout: string }> {
  const proc = Bun.spawn([...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    env: childEnvironment({ ...process.env, HACK_NO_INTERACTIVE: "1" }),
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
