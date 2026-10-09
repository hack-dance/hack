import { isRecord } from "./guards.ts";
import { keys } from "./native-compose-private-state.ts";

export type LegacyComposeRetainedService = {
  readonly service: string;
  /** Absent on historical service-only plans. Physical Compose names remain unchanged. */
  readonly kind?: "job";
  readonly healthy: boolean;
  readonly dependencies: readonly {
    readonly service: string;
    readonly condition: "started" | "ready" | "completed";
  }[];
};
export type LegacyComposeRetainedPlan = {
  readonly requiresV5: boolean;
  /** The distinct static/default-network job owner; never an alias for v5. */
  readonly requiresV7?: true;
  readonly ordered: readonly LegacyComposeRetainedService[];
};
function refuse(): never {
  throw new Error(
    "Legacy adoption retained dependency plan refused; values omitted."
  );
}
function dataRecord(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every((item) =>
      Object.hasOwn(item, "value")
    )
  );
}

function retainedDependencies(
  value: Record<string, unknown>
): LegacyComposeRetainedService["dependencies"] {
  const dependencies: {
    service: string;
    condition: "started" | "ready" | "completed";
  }[] = [];
  if (Object.hasOwn(value, "depends_on")) {
    if (!Array.isArray(value.depends_on)) {
      refuse();
    }
    if (
      Reflect.ownKeys(value.depends_on).length !==
        value.depends_on.length + 1 ||
      Object.keys(value.depends_on).some(
        (key, index) => key !== String(index)
      ) ||
      !Object.values(Object.getOwnPropertyDescriptors(value.depends_on)).every(
        (descriptor) => Object.hasOwn(descriptor, "value")
      )
    ) {
      refuse();
    }
    for (const edge of value.depends_on) {
      const selected = retainedDependency(edge);
      if (dependencies.some((old) => old.service === selected.service)) {
        refuse();
      }
      dependencies.push(selected);
    }
  }
  return Object.freeze(dependencies);
}

function retainedDependency(
  value: unknown
): LegacyComposeRetainedService["dependencies"][number] {
  if (!dataRecord(value)) {
    refuse();
  }
  if (
    keys(value, "condition,job") &&
    typeof value.job === "string" &&
    value.condition === "completed"
  ) {
    return Object.freeze({ service: value.job, condition: "completed" });
  }
  if (
    keys(value, "condition,service") &&
    typeof value.service === "string" &&
    (value.condition === "started" || value.condition === "ready")
  ) {
    return Object.freeze({
      service: value.service,
      condition: value.condition,
    });
  }
  refuse();
}

function assertJobPolicy(value: Record<string, unknown>): void {
  if (
    Object.hasOwn(value, "readiness") ||
    Object.hasOwn(value, "profiles") ||
    (Object.hasOwn(value, "restart") &&
      !(
        dataRecord(value.restart) &&
        keys(value.restart, "kind") &&
        value.restart.kind === "no"
      ))
  ) {
    refuse();
  }
}

function retainedService(
  name: string,
  value: unknown,
  job = false
): LegacyComposeRetainedService {
  if (!dataRecord(value)) {
    refuse();
  }
  const dependencies = retainedDependencies(value);
  const healthy = Object.hasOwn(value, "readiness");
  if (job) {
    assertJobPolicy(value);
  }
  if (
    healthy &&
    (!(
      dataRecord(value.readiness) &&
      keys(value.readiness, "command,interval,kind,retries,timeout")
    ) ||
      value.readiness.kind !== "exec")
  ) {
    refuse();
  }
  return Object.freeze({
    service: name,
    ...(job ? { kind: "job" as const } : {}),
    healthy,
    dependencies,
  });
}

/** Pure saved-candidate ordering; no container/image/env observations or effect authority. */
export function legacyComposeRetainedPlan(
  candidate: unknown
): LegacyComposeRetainedPlan {
  if (
    !(
      dataRecord(candidate) &&
      Object.hasOwn(candidate, "services") &&
      dataRecord(candidate.services)
    ) ||
    (Object.hasOwn(candidate, "jobs") && !dataRecord(candidate.jobs))
  ) {
    refuse();
  }
  const services = new Map<string, LegacyComposeRetainedService>();
  const authoredServices = candidate.services;
  let requiresV5 = false;
  for (const [name, value] of Object.entries(authoredServices)) {
    const service = retainedService(name, value);
    requiresV5 ||=
      service.healthy ||
      (isRecord(value) && Object.hasOwn(value, "depends_on"));
    services.set(name, service);
  }
  const jobs: Record<string, unknown> =
    Object.hasOwn(candidate, "jobs") && isRecord(candidate.jobs)
      ? candidate.jobs
      : {};
  const requiresV7 = Object.keys(jobs).length > 0;
  if (requiresV7 && Object.hasOwn(candidate, "profiles")) {
    refuse();
  }
  for (const [name, value] of Object.entries(jobs)) {
    if (services.has(name)) {
      refuse();
    }
    const job = retainedService(name, value, true);
    services.set(name, job);
  }
  if (
    requiresV7 &&
    [...services.values()].some((item) => {
      const authored =
        item.kind === "job"
          ? jobs[item.service]
          : authoredServices[item.service];
      return !isRecord(authored) || Object.hasOwn(authored, "profiles");
    })
  ) {
    refuse();
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
      if (
        !target ||
        (edge.condition === "ready" && !target.healthy) ||
        (edge.condition === "completed") !== (target.kind === "job")
      ) {
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
  return Object.freeze({
    requiresV5,
    ...(requiresV7 ? { requiresV7: true as const } : {}),
    ordered: Object.freeze(ordered),
  });
}

export function legacyComposeRetainedOrdered(
  plan: LegacyComposeRetainedPlan
): boolean {
  return plan.requiresV5 || plan.requiresV7 === true;
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
    readonly condition: "started" | "ready" | "completed";
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
      edge.condition !== "completed" &&
      row !== undefined &&
      row.running &&
      !row.paused &&
      row.status === "running" &&
      (edge.condition !== "ready" || row.health === "healthy")
    );
  });
}
