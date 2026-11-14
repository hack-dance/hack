/** Shared public state vocabulary. Absence of trustworthy evidence is unknown. */
export type ProjectState =
  | "running"
  | "degraded"
  | "starting"
  | "stopping"
  | "stopped"
  | "failed"
  | "unknown";

export type ServiceObservation = {
  readonly name: string;
  readonly state: ProjectState;
  readonly ready: boolean | null;
  readonly completed: boolean | null;
  readonly health: string | null;
  readonly exit_code: number | null;
  readonly started_at: string | null;
};

/** Current member evidence, separate from historical run/ready receipts. */
export type ServiceMemberEvidence = {
  readonly state: string;
  readonly health: string | null;
  readonly exitCode: number | null;
  readonly startedAt: string | null;
};

export type ServiceReadiness = "started" | "healthy" | "completed";

function memberState(member: ServiceMemberEvidence): ProjectState {
  if (member.state === "running") {
    if (member.health === "unhealthy") {
      return "degraded";
    }
    return member.health === "starting" ? "starting" : "running";
  }
  if (member.state === "restarting" || member.state === "starting") {
    return "starting";
  }
  if (member.state === "stopping") {
    return "stopping";
  }
  if (member.state === "dead" || member.state === "failed") {
    return "failed";
  }
  if (member.state === "exited") {
    if (member.exitCode === null) {
      return "unknown";
    }
    return member.exitCode === 0 ? "stopped" : "failed";
  }
  if (member.state === "stopped" || member.state === "absent") {
    return "stopped";
  }
  return member.state === "created" ? "stopped" : "unknown";
}

/** A completed job can satisfy readiness, but exit zero without its role cannot. */
export function observeService(opts: {
  readonly name: string;
  readonly available: boolean;
  readonly members: readonly ServiceMemberEvidence[];
  readonly readiness: ServiceReadiness | null;
}): ServiceObservation {
  const unknown: ServiceObservation = {
    name: opts.name,
    state: "unknown",
    ready: null,
    completed: null,
    health: null,
    exit_code: null,
    started_at: null,
  };
  if (!opts.available) {
    return unknown;
  }
  if (opts.members.length === 0) {
    return { ...unknown, state: "stopped", ready: false, completed: false };
  }
  const states = opts.members.map(memberState);
  const mixedLive =
    opts.members.some((member) => member.state === "running") &&
    opts.members.some((member) =>
      ["exited", "dead", "stopped", "absent"].includes(member.state)
    );
  const completed =
    opts.readiness === "completed"
      ? allEvidence(
          opts.members.map((member) => {
            const state = memberState(member);
            if (state === "unknown") {
              return null;
            }
            if (
              state !== "stopped" ||
              (member.state !== "exited" && member.state !== "stopped")
            ) {
              return false;
            }
            return member.exitCode === null ? null : member.exitCode === 0;
          })
        )
      : null;
  let ready: boolean | null = null;
  if (opts.readiness === "completed") {
    ready = completed;
  } else if (opts.readiness === "healthy") {
    ready = allEvidence(
      opts.members.map((member) => {
        if (memberState(member) === "unknown") {
          return null;
        }
        if (member.state !== "running") {
          return false;
        }
        return member.health === null ? null : member.health === "healthy";
      })
    );
  } else if (opts.readiness === "started") {
    ready = allEvidence(
      states.map((state) => (state === "unknown" ? null : state === "running"))
    );
  }
  const health = sameValue(opts.members.map((member) => member.health));
  const exitCode = sameValue(opts.members.map((member) => member.exitCode));
  return {
    name: opts.name,
    state: mixedLive ? "degraded" : aggregateProjectState(states),
    ready,
    completed,
    health,
    exit_code: exitCode,
    started_at: earliestStart(opts.members.map((member) => member.startedAt)),
  };
}

/** Unknown prevents a complete claim; mixed live replicas are degraded. */
export function aggregateProjectState(
  states: readonly ProjectState[]
): ProjectState {
  if (states.length === 0 || states.includes("unknown")) {
    return "unknown";
  }
  const first = states[0];
  if (first && states.every((state) => state === first)) {
    return first;
  }
  if (states.includes("running") || states.includes("degraded")) {
    return "degraded";
  }
  if (states.includes("failed")) {
    return "failed";
  }
  if (states.includes("stopping")) {
    return "stopping";
  }
  if (states.includes("starting")) {
    return "starting";
  }
  return "unknown";
}

function allEvidence(values: readonly (boolean | null)[]): boolean | null {
  if (values.includes(false)) {
    return false;
  }
  return values.includes(null) ? null : true;
}

function sameValue<T>(values: readonly (T | null)[]): T | null {
  const first = values[0] ?? null;
  return values.every((value) => value === first) ? first : null;
}

/** Missing timestamps remain missing; never substitute the receipt or observation time. */
export function earliestStart(
  values: readonly (string | null)[]
): string | null {
  const known = values.filter(
    (value): value is string =>
      value !== null &&
      Number.isFinite(Date.parse(value)) &&
      !value.startsWith("0001-")
  );
  return (
    known.sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null
  );
}

/** Successful declared jobs do not degrade otherwise-ready long-running services. */
export function observedProjectState(
  services: readonly ServiceObservation[]
): ProjectState {
  const active = services.filter((service) => service.completed !== true);
  if (services.length > 0 && active.length === 0) {
    return "stopped";
  }
  return aggregateProjectState(active.map((service) => service.state));
}
