import { resolveLaunchdAccess } from "../daemon/launchd.ts";
import { resolveDaemonPaths } from "../daemon/paths.ts";
import {
  resolveSystemdAccess,
  resolveSystemdUnitPath,
} from "../daemon/systemd.ts";
import { pathExists } from "./fs.ts";
import type {
  AutostartGlobal,
  RegisteredProject,
} from "./projects-registry.ts";

export interface AutostartLoginRunView {
  readonly in_progress: boolean;
  readonly waiting_for_engine: boolean;
  readonly started_at: string | null;
  /** Registry project IDs, including active starts until their outcome is recorded. */
  readonly pending: readonly string[];
  readonly started: readonly string[];
  readonly failed: readonly string[];
}
export interface AutostartGlobalView {
  readonly paused: boolean;
  readonly login_run: AutostartLoginRunView;
  /** An installed service file was observed; this does not qualify its manager or executable. */
  readonly service_ready: boolean;
}
export interface ProjectAutostartView {
  readonly enabled: boolean;
  readonly state: "off" | "on" | "paused" | "starting" | "needs_attention";
  readonly paused_reason: "manual_stop" | null;
  readonly failures: {
    readonly count: number;
    readonly last_at: string | null;
    readonly failed_services: readonly string[];
    readonly last_error_code: string | null;
  };
  readonly max_failures: number;
  readonly branch: string | null;
  readonly paused: boolean;
  readonly last_result: NonNullable<
    RegisteredProject["autostart"]
  >["lastResult"];
}

/** Unit 1 has no restart loop; failure-budget fields reserve the desktop contract. */
export function serializeProjectAutostart(
  marker: RegisteredProject["autostart"],
  opts?: {
    readonly starting?: boolean;
    readonly globallyPaused?: boolean;
  }
): ProjectAutostartView {
  let state: ProjectAutostartView["state"] = "off";
  if (marker) {
    state = "on";
    if (opts?.starting) {
      state = "starting";
    }
    if (marker.paused || opts?.globallyPaused) {
      state = "paused";
    }
    if (marker.invalid) {
      state = "needs_attention";
    }
  }
  return {
    enabled: marker !== undefined,
    state,
    paused_reason: marker?.paused && !marker.invalid ? "manual_stop" : null,
    failures: {
      count: 0,
      last_at: null,
      failed_services: [],
      last_error_code: null,
    },
    max_failures: 3,
    branch: marker?.branch ?? null,
    paused: marker?.paused ?? false,
    last_result: marker?.lastResult
      ? {
          status: marker.lastResult.status,
          reason: marker.lastResult.reason,
          at: marker.lastResult.at,
        }
      : null,
  };
}

/** File-only service observation. Access opt-outs are honored before reading any path. */
export async function readAutostartServiceReady(opts?: {
  readonly platform?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly exists?: (path: string) => Promise<boolean>;
  readonly servicePath?: string;
}): Promise<boolean> {
  const platform = opts?.platform ?? process.platform;
  const env = opts?.env ?? process.env;
  const exists = opts?.exists ?? pathExists;
  if (
    (env.HACK_DAEMON_AUTOSTART_DISABLE ?? "").trim() === "1" ||
    (env.HACK_CANDIDATE_ENTRYPOINT ?? "").trim().length > 0
  ) {
    return false;
  }
  let servicePath: string;
  if (platform === "darwin") {
    if (!resolveLaunchdAccess({ env }).allowed) {
      return false;
    }
    servicePath = opts?.servicePath ?? resolveDaemonPaths({}).launchdPlistPath;
  } else if (platform === "linux") {
    if (!resolveSystemdAccess({ env }).allowed) {
      return false;
    }
    servicePath = opts?.servicePath ?? resolveSystemdUnitPath({ env });
  } else {
    return false;
  }
  return await exists(servicePath);
}

export function projectAutostartFromGlobal(opts: {
  readonly project: RegisteredProject | undefined;
  readonly global: AutostartGlobalView;
}): ProjectAutostartView {
  return serializeProjectAutostart(opts.project?.autostart, {
    globallyPaused: opts.global.paused,
    starting:
      (opts.global.login_run.in_progress ||
        opts.global.login_run.waiting_for_engine) &&
      opts.project !== undefined &&
      opts.global.login_run.pending.includes(opts.project.id),
  });
}

/** Private run and boot identities never cross the desktop JSON boundary. */
export function serializeAutostartGlobal(
  state: AutostartGlobal,
  serviceReady: boolean
): AutostartGlobalView {
  return {
    paused: state.paused,
    login_run: {
      in_progress: state.loginRun.inProgress,
      waiting_for_engine: state.loginRun.waitingForEngine,
      started_at: state.loginRun.startedAt,
      pending: [...state.loginRun.pending],
      started: [...state.loginRun.started],
      failed: [...state.loginRun.failed],
    },
    service_ready: serviceReady,
  };
}
