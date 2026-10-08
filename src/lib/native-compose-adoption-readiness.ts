import { isRecord } from "./guards.ts";
import { keys } from "./native-compose-private-state.ts";

export type LegacyComposeRetainedService = {
  readonly service: string;
  readonly healthy: boolean;
  readonly dependencies: readonly {
    readonly service: string;
    readonly condition: "started" | "ready";
  }[];
};
export type LegacyComposeRetainedPlan = {
  readonly requiresV5: boolean;
  readonly ordered: readonly LegacyComposeRetainedService[];
};
function refuse(): never {
  throw new Error(
    "Legacy adoption retained dependency plan refused; values omitted."
  );
}

function retainedService(
  name: string,
  value: unknown
): LegacyComposeRetainedService {
  if (!isRecord(value)) {
    refuse();
  }
  const dependencies: { service: string; condition: "started" | "ready" }[] =
    [];
  if (Object.hasOwn(value, "depends_on")) {
    if (!Array.isArray(value.depends_on)) {
      refuse();
    }
    for (const edge of value.depends_on) {
      if (
        !(isRecord(edge) && keys(edge, "condition,service")) ||
        typeof edge.service !== "string" ||
        (edge.condition !== "started" && edge.condition !== "ready") ||
        dependencies.some((old) => old.service === edge.service)
      ) {
        refuse();
      }
      dependencies.push(
        Object.freeze({ service: edge.service, condition: edge.condition })
      );
    }
  }
  const healthy = Object.hasOwn(value, "readiness");
  if (
    healthy &&
    (!(
      isRecord(value.readiness) &&
      keys(value.readiness, "command,interval,kind,retries,timeout")
    ) ||
      value.readiness.kind !== "exec")
  ) {
    refuse();
  }
  return Object.freeze({
    service: name,
    healthy,
    dependencies: Object.freeze(dependencies),
  });
}

/** Pure saved-candidate ordering; no container/image/env observations or effect authority. */
export function legacyComposeRetainedPlan(
  candidate: unknown
): LegacyComposeRetainedPlan {
  if (
    !(isRecord(candidate) && isRecord(candidate.services)) ||
    (isRecord(candidate.jobs) && Object.keys(candidate.jobs).length)
  ) {
    refuse();
  }
  const services = new Map<string, LegacyComposeRetainedService>();
  let requiresV5 = false;
  for (const [name, value] of Object.entries(candidate.services)) {
    const service = retainedService(name, value);
    requiresV5 ||=
      service.healthy ||
      (isRecord(value) && Object.hasOwn(value, "depends_on"));
    services.set(name, service);
  }
  const ordered: LegacyComposeRetainedService[] = [];
  const visiting = new Set<string>(),
    visited = new Set<string>();
  function visit(name: string) {
    if (visited.has(name)) {
      return;
    }
    const service = services.get(name);
    if (!service || visiting.has(name)) {
      refuse();
    }
    visiting.add(name);
    for (const edge of service.dependencies) {
      const target = services.get(edge.service);
      if (!target || (edge.condition === "ready" && !target.healthy)) {
        refuse();
      }
      visit(edge.service);
    }
    visiting.delete(name);
    visited.add(name);
    ordered.push(service);
  }
  for (const name of [...services.keys()].sort()) {
    visit(name);
  }
  return Object.freeze({ requiresV5, ordered: Object.freeze(ordered) });
}

export type LegacyComposeReadinessState = {
  readonly id: string;
  readonly running: boolean;
  readonly paused: boolean;
  readonly status: string;
  readonly health: "" | "starting" | "healthy" | "unhealthy";
};
/** Caller has already bound each unique observation to the exact original IDs. */
export function legacyComposeRetainedReady(opts: {
  readonly plan: LegacyComposeRetainedPlan;
  readonly ids: ReadonlyMap<string, string>;
  readonly observed: readonly LegacyComposeReadinessState[];
  readonly required?: readonly {
    readonly service: string;
    readonly condition: "started" | "ready";
  }[];
}): boolean {
  const required =
    opts.required ??
    opts.plan.ordered.map((service) => ({
      service: service.service,
      condition: service.healthy ? ("ready" as const) : ("started" as const),
    }));
  return required.every((edge) => {
    const id = opts.ids.get(edge.service);
    const rows = opts.observed.filter((row) => row.id === id);
    const row = rows[0];
    return (
      rows.length === 1 &&
      row !== undefined &&
      row.running &&
      !row.paused &&
      row.status === "running" &&
      (edge.condition !== "ready" || row.health === "healthy")
    );
  });
}
