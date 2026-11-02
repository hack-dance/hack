import { isRecord } from "./guards.ts";
import { literalComposeArg } from "./native-config-import-argv.ts";

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DURATION = /^(\d+)(ms|s|m|h)$/;
const UNITS: Readonly<Record<string, bigint>> = {
  ms: 1n,
  s: 1000n,
  m: 60_000n,
  h: 3_600_000n,
};
export type ImportedReadiness = {
  readonly kind: "exec";
  readonly command: { readonly exec: readonly string[] };
  readonly interval: string;
  readonly timeout: string;
  readonly retries: number;
};
export type ImportedServiceDependency = {
  readonly service: string;
  readonly condition: "started" | "ready";
};
export type ImportedDependency =
  | ImportedServiceDependency
  | { readonly job: string; readonly condition: "completed" };
type ComposeDependency = {
  readonly service: string;
  readonly condition: "started" | "ready" | "completed";
};
function dependencyCondition(value: unknown): ComposeDependency["condition"] {
  if (value === "service_completed_successfully") {
    return "completed";
  }
  return value === "service_healthy" ? "ready" : "started";
}
function duration(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const match = DURATION.exec(value);
  const digits = match?.[1],
    unit = match?.[2];
  if (!(digits && unit)) {
    return false;
  }
  const scale = UNITS[unit];
  if (scale === undefined) {
    return false;
  }
  const milliseconds = BigInt(digits) * scale;
  return milliseconds > 0n && milliseconds <= 4_294_967_295n;
}

/**
 * Only authored exec probes with every native timing field are lossless here.
 * Missing/zero timings can inherit image health settings; CMD-SHELL uses image
 * SHELL. Neither authority is acquired by the importer, so no defaults are guessed.
 */
export function mapLegacyComposeHealthcheck(
  value: unknown
): ImportedReadiness | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        !["test", "interval", "timeout", "retries", "disable"].includes(key)
    ) ||
    (Object.hasOwn(value, "disable") && value.disable !== false) ||
    !Array.isArray(value.test) ||
    value.test.length < 2 ||
    value.test[0] !== "CMD" ||
    !duration(value.interval) ||
    !duration(value.timeout) ||
    !Number.isInteger(value.retries) ||
    typeof value.retries !== "number" ||
    value.retries < 1 ||
    value.retries > 4_294_967_295
  ) {
    return undefined;
  }
  const exec: string[] = [];
  for (const part of value.test.slice(1)) {
    const decoded = literalComposeArg(part);
    if (decoded === undefined || !(exec.length || decoded.length)) {
      return undefined;
    }
    exec.push(decoded);
  }
  return {
    kind: "exec",
    command: { exec },
    interval: value.interval,
    timeout: value.timeout,
    retries: value.retries,
  };
}

function composeDependencies(
  value: unknown
): readonly ComposeDependency[] | undefined {
  if (Array.isArray(value)) {
    if (
      value.some((name) => typeof name !== "string" || !NAME.test(name)) ||
      new Set(value).size !== value.length
    ) {
      return undefined;
    }
    return value.map((service) => ({ service, condition: "started" }));
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const result: ComposeDependency[] = [];
  for (const [service, edge] of Object.entries(value)) {
    if (
      !(NAME.test(service) && isRecord(edge)) ||
      Object.keys(edge).some(
        (key) => !["condition", "required", "restart"].includes(key)
      ) ||
      (Object.hasOwn(edge, "required") && edge.required !== true) ||
      (Object.hasOwn(edge, "restart") && edge.restart !== false) ||
      (Object.hasOwn(edge, "condition") &&
        edge.condition !== "service_started" &&
        edge.condition !== "service_healthy" &&
        edge.condition !== "service_completed_successfully")
    ) {
      return undefined;
    }
    result.push({
      service,
      condition: dependencyCondition(
        Object.hasOwn(edge, "condition") ? edge.condition : undefined
      ),
    });
  }
  return result;
}

/** Role discovery shares the closed edge parser; malformed intent never infers a job. */
export function legacyComposeCompletedJobTargets(
  value: unknown
): readonly string[] {
  return (composeDependencies(value) ?? [])
    .filter((edge) => edge.condition === "completed")
    .map((edge) => edge.service);
}

export function legacyComposeMixedJobDependency(opts: {
  readonly value: unknown;
  readonly jobs: ReadonlySet<string>;
}): boolean {
  return (composeDependencies(opts.value) ?? []).some(
    (edge) => edge.condition !== "completed" && opts.jobs.has(edge.service)
  );
}

/** Typed dependency conversion only; retained-job execution is a separate owner contract. */
export function mapLegacyComposeDependencies(
  value: unknown,
  jobs: ReadonlySet<string> = new Set()
): readonly ImportedDependency[] | undefined {
  const parsed = composeDependencies(value);
  if (!parsed) {
    return undefined;
  }
  const result: ImportedDependency[] = [];
  for (const edge of parsed) {
    if (edge.condition === "completed") {
      if (!jobs.has(edge.service)) {
        return undefined;
      }
      result.push({ job: edge.service, condition: "completed" });
    } else {
      if (jobs.has(edge.service)) {
        return undefined;
      }
      result.push({ service: edge.service, condition: edge.condition });
    }
  }
  return result;
}
