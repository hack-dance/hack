import type { PullPolicy } from "../../packages/config-compiler/generated/native-config.ts";
import { isRecord } from "./guards.ts";
import type { NativeDeclaredWorkloads } from "./native-env-plan-protocol.ts";

function project(input: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input)
    );
    return isRecord(value) ? value : undefined;
  } catch {
    // Rust retains whole-document and duplicate-key diagnostic ownership.
    return undefined;
  }
}

function hasPolicy(value: unknown): boolean {
  return isRecord(value) && Object.hasOwn(value, "pull_policy");
}

function imagePolicy(value: unknown): value is Exclude<PullPolicy, "build"> {
  return value === "always" || value === "never" || value === "missing";
}

/** Negotiate on authored presence before sending input, including inactive workloads. */
export function authoredAcquisitionPlanningRequired(
  input: Uint8Array
): boolean {
  const source = project(input);
  return source !== undefined && nativeAcquisitionPlanningRequired(source);
}

/** Omission preserves the old wire rather than materializing backend defaults. */
export function nativeAcquisitionPlanningRequired(
  plan: Readonly<Record<string, unknown>>
): boolean {
  return [plan.services, plan.jobs].some(
    (entries) => isRecord(entries) && Object.values(entries).some(hasPolicy)
  );
}

function sourceKind(
  value: Record<string, unknown>
): "image" | "build" | undefined {
  const image = Object.hasOwn(value, "image");
  const build = Object.hasOwn(value, "build");
  if (image === build) {
    return undefined;
  }
  if (image) {
    return typeof value.image === "string" && value.image.length > 0
      ? "image"
      : undefined;
  }
  return isRecord(value.build) ? "build" : undefined;
}

function policyIsValid(value: Record<string, unknown>): boolean {
  const kind = sourceKind(value);
  if (!kind) {
    return false;
  }
  if (!Object.hasOwn(value, "pull_policy")) {
    return true;
  }
  return kind === "build"
    ? value.pull_policy === "build"
    : imagePolicy(value.pull_policy);
}

/** Validate the acquisition-owned fields without implementing engine acquisition. */
export function nativeAcquisitionPlanIsValid(opts: {
  readonly plan: Readonly<Record<string, unknown>>;
  readonly declared?: NativeDeclaredWorkloads;
}): boolean {
  if (!nativeAcquisitionPlanningRequired(opts.plan)) {
    return true;
  }
  const seen = new Set<string>();
  for (const [field, kind] of [
    ["services", "service"],
    ["jobs", "job"],
  ] as const) {
    const workloads = opts.plan[field];
    if (!isRecord(workloads)) {
      return false;
    }
    for (const [name, workload] of Object.entries(workloads)) {
      if (
        !(isRecord(workload) && policyIsValid(workload)) ||
        seen.has(name) ||
        !opts.declared ||
        !Object.hasOwn(opts.declared, name) ||
        opts.declared[name] !== kind
      ) {
        return false;
      }
      seen.add(name);
    }
  }
  return true;
}

function selected(
  source: Record<string, unknown>,
  profiles: readonly string[]
): boolean | undefined {
  if (!Object.hasOwn(source, "profiles")) {
    return true;
  }
  if (
    !(
      Array.isArray(source.profiles) &&
      source.profiles.every((name) => typeof name === "string")
    )
  ) {
    return undefined;
  }
  return (
    source.profiles.length === 0 ||
    source.profiles.some((name) => profiles.includes(name))
  );
}

function sourceNamespaceMatches(opts: {
  readonly inputs: Record<string, unknown>;
  readonly outputs: Record<string, unknown>;
  readonly profiles: readonly string[];
  readonly kind: "service" | "job";
  readonly sourceKinds: Map<string, "service" | "job">;
}): boolean {
  for (const [name, workload] of Object.entries(opts.inputs)) {
    if (
      !(isRecord(workload) && policyIsValid(workload)) ||
      opts.sourceKinds.has(name)
    ) {
      return false;
    }
    opts.sourceKinds.set(name, opts.kind);
    const active = selected(workload, opts.profiles);
    if (active === undefined || active !== Object.hasOwn(opts.outputs, name)) {
      return false;
    }
  }
  return Object.entries(opts.outputs).every(([name, workload]) => {
    const source = opts.inputs[name];
    return (
      Object.hasOwn(opts.inputs, name) &&
      isRecord(source) &&
      isRecord(workload) &&
      sourceKind(source) === sourceKind(workload) &&
      source.image === workload.image &&
      Object.hasOwn(source, "pull_policy") ===
        Object.hasOwn(workload, "pull_policy") &&
      source.pull_policy === workload.pull_policy
    );
  });
}

/** Cross-check successful source claims; invalid inputs still receive Rust diagnostics. */
export function nativeAcquisitionSourceMatches(opts: {
  readonly input: Uint8Array;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly declared?: NativeDeclaredWorkloads;
  readonly profiles?: readonly string[];
}): boolean {
  const source = project(opts.input);
  if (
    !(
      (source && nativeAcquisitionPlanningRequired(source)) ||
      nativeAcquisitionPlanningRequired(opts.plan)
    )
  ) {
    return true;
  }
  if (
    !(source && opts.declared && nativeAcquisitionPlanIsValid(opts)) ||
    typeof source.name !== "string" ||
    opts.plan.name !== source.name
  ) {
    return false;
  }
  const profiles = [...(opts.profiles ?? [])].sort();
  const selectedProfiles = opts.plan.selected_profiles;
  if (
    new Set(profiles).size !== profiles.length ||
    !Array.isArray(selectedProfiles) ||
    selectedProfiles.length !== profiles.length ||
    profiles.some((name, index) => name !== selectedProfiles[index])
  ) {
    return false;
  }
  const sourceKinds = new Map<string, "service" | "job">();
  for (const [field, kind] of [
    ["services", "service"],
    ["jobs", "job"],
  ] as const) {
    const inputs = Object.hasOwn(source, field) ? source[field] : {};
    const outputs = opts.plan[field];
    if (
      !(
        isRecord(inputs) &&
        isRecord(outputs) &&
        sourceNamespaceMatches({ inputs, outputs, profiles, kind, sourceKinds })
      )
    ) {
      return false;
    }
  }
  return (
    sourceKinds.size === Object.keys(opts.declared).length &&
    [...sourceKinds].every(
      ([name, kind]) =>
        Object.hasOwn(opts.declared ?? {}, name) &&
        opts.declared?.[name] === kind
    )
  );
}
