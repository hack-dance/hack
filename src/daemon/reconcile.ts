/**
 * What `hack daemon start` (and restart, and the post-update hook) does
 * about an installed login service that no longer matches this CLI
 * (HACK-2216). The decision is pure; `src/commands/daemon-systemd.ts` and
 * `src/commands/daemon.ts` observe the unit and the running daemon, call
 * {@link planDaemonReconcile} and carry the plan out.
 */

import { MACHINE_SCHEMAS } from "../lib/machine-output.ts";

/**
 * Set to `1` by `hack update` for the new executable's
 * `hack daemon start --json`: reconcile a running hackd only. When no hackd
 * of this home is running, start does nothing (action `none`), so a daemon
 * that stopped after the update looked is never started.
 */
export const DAEMON_RECONCILE_ONLY_ENV = "HACK_DAEMON_RECONCILE_ONLY";

/** Who runs hackd: a systemd user unit, a launchd agent, or nobody. */
export type DaemonServiceManager = "systemd" | "launchd" | "none";

/**
 * Why the service or daemon is stale, as a closed set for `--json`:
 * - `content`: the unit or plist differs from what this CLI renders for the
 *   same program;
 * - `program-missing`: the program it runs no longer exists;
 * - `version-mismatch`: the running hackd reports another version than this
 *   CLI.
 */
export type DaemonStaleReason =
  | "content"
  | "program-missing"
  | "version-mismatch";

export const DAEMON_STALE_REASON_ORDER: readonly DaemonStaleReason[] = [
  "content",
  "program-missing",
  "version-mismatch",
];

/** What a `hack daemon` command did, as reported by `--json`. */
export type DaemonCommandAction =
  | "none"
  | "started"
  | "restarted"
  | "reinstalled"
  | "stopped"
  | "installed";

/**
 * How the installed unit compares with what this CLI renders for the
 * unit's own program (see `computeDrift` in `src/daemon/systemd.ts`).
 * `program-unknown`: its ExecStart is not understood, so it is never
 * rewritten.
 */
export type ServiceUnitState =
  | "current"
  | "content"
  | "program-missing"
  | "program-unknown";

/**
 * Why a stale service was not repaired:
 * - `read-only`: `HACK_DAEMON_SERVICE_READ_ONLY=1` (`hack doctor --fix`
 *   without a TTY) forbids writing the unit;
 * - `other-program`: the unit runs another existing `hack`, which the user
 *   may have chosen; `hack daemon install` switches it;
 * - `unknown-program`: what the unit runs cannot be read, so a restart is
 *   not known to run this version;
 * - `unmanaged`: the unit's main file does not start with Hack's managed
 *   header (it was written or edited by hand), so it is never rewritten
 *   automatically; `hack daemon install` replaces it;
 * - `home-binding`: the unit's main file binds the service to a Hack home
 *   (`HACK_HOME`, `HOME` or an `EnvironmentFile=`) that a rewrite would drop;
 * - `inside-service`: this command runs inside the service (for example a
 *   job hackd started), so restarting or rewriting it would stop the caller;
 * - `unproven-owner`: a restart was needed, but the service's main process
 *   is not proven to be this home's hackd (the same proof `stop` needs), so
 *   restarting it could stop another home's daemon;
 * - `rewrite-refused`: the service needs a rewrite, or an automatic
 *   start or restart, but the program it would run, or a directory of the
 *   PATH it gives hackd, fails the checks (no durable
 *   `hack` to retarget to, a refreshed plist's kept program that is not
 *   durable or that another account could replace, or a program or service
 *   PATH that fails install's checks), so nothing was written, reloaded or
 *   restarted, and a running daemon was not stopped to make room for it;
 * - `service-pending`: a replaced daemon's service start failed, but the
 *   manager may still start it (a queued job, restart timer or KeepAlive
 *   retry) or could not be checked, so hackd was not started directly
 *   next to it;
 * - `untrusted-unit`: the unit file, the directories above it, a user-unit
 *   load directory or a drop-in systemd loads could have been written by
 *   another account (the checks install and enable run), or the same for
 *   the launchd plist and `~/Library/LaunchAgents`, so Hack did not read it
 *   to rewrite, retarget, reload or restart it, and did not stop a running
 *   daemon for it; `hack daemon install` is the next step.
 */
export type DaemonReconcileBlock =
  | "read-only"
  | "other-program"
  | "unknown-program"
  | "unmanaged"
  | "home-binding"
  | "inside-service"
  | "unproven-owner"
  | "rewrite-refused"
  | "service-pending"
  | "untrusted-unit";

export interface DaemonReconcileInput {
  readonly unit: ServiceUnitState;
  /**
   * The unit runs this CLI's executable: the same path, or a path that
   * resolves to the same file. False when the program is unknown or missing.
   */
  readonly programIsOurs: boolean;
  readonly readOnly: boolean;
  /**
   * The hackd the service manager runs now, or null when it runs none.
   * `version` is null when the daemon's API did not report one; that is not
   * evidence of a mismatch.
   */
  readonly running: { readonly version: string | null } | null;
  /**
   * An earlier repair rewrote the unit but its restart did not complete,
   * so the running service still has the old unit loaded.
   */
  readonly restartPending?: boolean;
  /**
   * Why the unit's content must not be rewritten automatically even though
   * it runs this CLI's executable; null or absent when it may be.
   */
  readonly contentBlock?: "unmanaged" | "home-binding" | null;
  /**
   * This process runs inside the service, or that could not be ruled out.
   * Only meaningful while the service runs hackd.
   */
  readonly invokerInsideService?: boolean;
  readonly cliVersion: string;
}

export interface DaemonReconcilePlan {
  /**
   * `program`: retarget ExecStart to this CLI (the old program is gone);
   * `content`: rewrite the whole unit for its own program.
   */
  readonly rewrite: "none" | "content" | "program";
  /**
   * `keep`: leave the running daemon as it is; `refuse`: stop with an error
   * (see `blocked`).
   */
  readonly service: "keep" | "start" | "restart" | "refuse";
  readonly reasons: readonly DaemonStaleReason[];
  /** Why a stale part was left as it is; null when nothing was. */
  readonly blocked: DaemonReconcileBlock | null;
}

/**
 * Decides how to bring an installed service and its daemon up to this CLI.
 *
 * Invariants:
 * - a unit is rewritten only when it runs this CLI's executable (`content`)
 *   or its program is gone (`program`), and never under `readOnly`;
 * - a running daemon is restarted only when the restart is known to run
 *   this CLI's executable, or the unit changed under it;
 * - a version mismatch that a restart cannot fix is refused, never
 *   reported as success;
 * - nothing is rewritten or restarted from inside the running service: a
 *   stale but compatible daemon is kept, a mismatched one refused.
 */
export function planDaemonReconcile(
  input: DaemonReconcileInput
): DaemonReconcilePlan {
  const plan = planWithoutCallerGuard(input);
  if (
    input.running === null ||
    input.invokerInsideService !== true ||
    (plan.service !== "restart" && plan.rewrite === "none")
  ) {
    return plan;
  }
  return {
    rewrite: "none",
    service: plan.reasons.includes("version-mismatch") ? "refuse" : "keep",
    reasons: plan.reasons,
    blocked: "inside-service",
  };
}

function planWithoutCallerGuard(
  input: DaemonReconcileInput
): DaemonReconcilePlan {
  const mismatch =
    input.running !== null &&
    input.running.version !== null &&
    input.running.version !== input.cliVersion;
  const reasons = staleReasons({ input, mismatch });

  if (input.unit === "program-missing") {
    if (input.readOnly) {
      return {
        rewrite: "none",
        service: "refuse",
        reasons,
        blocked: "read-only",
      };
    }
    return {
      rewrite: "program",
      service: input.running === null ? "start" : "restart",
      reasons,
      blocked: null,
    };
  }

  const { rewrite, blocked } = planContentRewrite(input);
  if (input.running === null) {
    return { rewrite, service: "start", reasons, blocked };
  }
  if (mismatch && !input.programIsOurs) {
    return {
      rewrite,
      service: "refuse",
      reasons,
      blocked:
        input.unit === "program-unknown" ? "unknown-program" : "other-program",
    };
  }
  // Under read-only a pending restart cannot load anything new (the reload
  // that would is not allowed), so it alone never restarts a compatible
  // daemon; that would repeat on every start. It stays reported.
  const pendingRestart = input.restartPending === true && !input.readOnly;
  const restart = mismatch || rewrite !== "none" || pendingRestart;
  const pendingBlocked =
    input.restartPending === true && input.readOnly && !restart
      ? "read-only"
      : null;
  return {
    rewrite,
    service: restart ? "restart" : "keep",
    reasons,
    blocked: blocked ?? pendingBlocked,
  };
}

function staleReasons(opts: {
  readonly input: DaemonReconcileInput;
  readonly mismatch: boolean;
}): DaemonStaleReason[] {
  const { input } = opts;
  const reasons: DaemonStaleReason[] = [];
  if (input.unit === "content" || input.restartPending === true) {
    reasons.push("content");
  }
  if (input.unit === "program-missing") {
    reasons.push("program-missing");
  }
  if (opts.mismatch) {
    reasons.push("version-mismatch");
  }
  return reasons;
}

/** Whether stale content (not a missing program) may be rewritten. */
function planContentRewrite(input: DaemonReconcileInput): {
  readonly rewrite: "none" | "content";
  readonly blocked: DaemonReconcileBlock | null;
} {
  if (input.unit !== "content") {
    return { rewrite: "none", blocked: null };
  }
  if (input.readOnly) {
    return { rewrite: "none", blocked: "read-only" };
  }
  if (!input.programIsOurs) {
    return { rewrite: "none", blocked: "other-program" };
  }
  return input.contentBlock
    ? { rewrite: "none", blocked: input.contentBlock }
    : { rewrite: "content", blocked: null };
}

/** The `--json` action for a plan that was carried out. */
export function reconcileAction(
  plan: DaemonReconcilePlan
): DaemonCommandAction {
  if (plan.rewrite !== "none") {
    return "reinstalled";
  }
  if (plan.service === "restart") {
    return "restarted";
  }
  if (plan.service === "start") {
    return "started";
  }
  return "none";
}

/**
 * What one `hack daemon` command observed and did, filled in as it runs
 * and rendered by `--json`. The decisions themselves are made by
 * {@link planDaemonReconcile} and the existing ownership checks; this only
 * records their result.
 */
export interface DaemonCommandTrace {
  manager: DaemonServiceManager;
  action: DaemonCommandAction;
  readonly stale: Set<DaemonStaleReason>;
  /** Why a stale service was left as it is, if it was. */
  blocked: DaemonReconcileBlock | null;
  /**
   * `direct`: a running daemon was replaced, the service could not start
   * its replacement, and this home's hackd was started directly instead,
   * so a replacement never leaves hackd stopped (HACK-2216).
   */
  fallback: "direct" | null;
}

export function createDaemonCommandTrace(): DaemonCommandTrace {
  return {
    manager: "none",
    action: "none",
    stale: new Set(),
    blocked: null,
    fallback: null,
  };
}

/** Records a carried-out plan on `trace`. */
export function recordReconcile(opts: {
  readonly trace: DaemonCommandTrace | undefined;
  readonly manager: DaemonServiceManager;
  readonly plan: DaemonReconcilePlan;
}): void {
  const { trace } = opts;
  if (!trace) {
    return;
  }
  trace.manager = opts.manager;
  trace.action = reconcileAction(opts.plan);
  trace.blocked = opts.plan.blocked;
  for (const reason of opts.plan.reasons) {
    trace.stale.add(reason);
  }
}

/** The stale reasons in a stable order for output. */
export function sortedStaleReasons(
  stale: ReadonlySet<DaemonStaleReason>
): DaemonStaleReason[] {
  return DAEMON_STALE_REASON_ORDER.filter((reason) => stale.has(reason));
}

/** The `hack daemon` commands that report a `--json` result. */
export type DaemonCommandName = "start" | "stop" | "restart" | "install";

/**
 * The versioned `data.schema` of each command's `--json` envelope, from
 * the shared machine-output registry (docs/reference/machine-readable-output.md).
 */
export const DAEMON_COMMAND_SCHEMAS = {
  start: MACHINE_SCHEMAS.daemonStart,
  stop: MACHINE_SCHEMAS.daemonStop,
  restart: MACHINE_SCHEMAS.daemonRestart,
  install: MACHINE_SCHEMAS.daemonInstall,
} as const satisfies Record<DaemonCommandName, string>;

/** The daemon as observed after the command. */
export interface DaemonObservation {
  readonly running: boolean;
  readonly pid: number | null;
  /** What its API reported; null when it did not answer. */
  readonly version: string | null;
}

/**
 * `data` of the `--json` envelope for `hack daemon <command>`, with the
 * schema `hack.daemon-<command>.v1` ({@link DAEMON_COMMAND_SCHEMAS}).
 * Closed enums only; no paths and no values from the environment.
 */
export function buildDaemonCommandData(opts: {
  readonly command: DaemonCommandName;
  readonly trace: DaemonCommandTrace;
  readonly daemon: DaemonObservation;
  readonly cliVersion: string;
}): {
  readonly schema: string;
  readonly manager: DaemonServiceManager;
  readonly action: DaemonCommandAction;
  readonly stale: boolean;
  readonly stale_reasons: readonly DaemonStaleReason[];
  readonly blocked: DaemonReconcileBlock | null;
  readonly fallback: "direct" | null;
  readonly cli_version: string;
  readonly daemon: {
    readonly running: boolean;
    readonly pid: number | null;
    readonly version: string | null;
    readonly compatible: boolean;
  };
} {
  const reasons = sortedStaleReasons(opts.trace.stale);
  return {
    schema: DAEMON_COMMAND_SCHEMAS[opts.command],
    manager: opts.trace.manager,
    action: opts.trace.action,
    stale: reasons.length > 0,
    stale_reasons: reasons,
    blocked: opts.trace.blocked,
    fallback: opts.trace.fallback,
    cli_version: opts.cliVersion,
    daemon: {
      running: opts.daemon.running,
      pid: opts.daemon.running ? opts.daemon.pid : null,
      version: opts.daemon.version,
      compatible: opts.daemon.version === opts.cliVersion,
    },
  };
}
