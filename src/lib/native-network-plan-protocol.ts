import { isRecord } from "./guards.ts";
import type { NativeDeclaredWorkloads } from "./native-env-plan-protocol.ts";

const NAME = /^[a-z0-9][a-z0-9_.-]{0,62}$/;
type Definitions = ReadonlyMap<string, boolean>;
type Attachments = ReadonlyMap<string, readonly string[]>;

function project(input: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input)
    );
    return isRecord(value) ? value : undefined;
  } catch {
    // Rust owns whole-document parsing and invalid-input diagnostics.
    return undefined;
  }
}

/** Negotiate before input delivery, even when only an inactive workload authors networks. */
export function authoredNetworkPlanningRequired(input: Uint8Array): boolean {
  const source = project(input);
  return source !== undefined && nativeNetworkPlanningRequired(source);
}

/** Omission leaves the existing default network wire and hash unchanged. */
export function nativeNetworkPlanningRequired(
  plan: Readonly<Record<string, unknown>>
): boolean {
  return (
    Object.hasOwn(plan, "networks") ||
    [plan.services, plan.jobs].some(
      (entries) =>
        isRecord(entries) &&
        Object.values(entries).some(
          (workload) =>
            isRecord(workload) && Object.hasOwn(workload, "networks")
        )
    )
  );
}

function definitions(opts: {
  readonly document: Readonly<Record<string, unknown>>;
  readonly normalized: boolean;
}): Definitions | undefined {
  if (!Object.hasOwn(opts.document, "networks")) {
    return new Map();
  }
  const value = opts.document.networks;
  if (
    !isRecord(value) ||
    (opts.normalized && Object.keys(value).length === 0)
  ) {
    return undefined;
  }
  const result = new Map<string, boolean>();
  for (const [name, network] of Object.entries(value)) {
    if (
      !NAME.test(name) ||
      name === "default" ||
      name === "ingress" ||
      !isRecord(network) ||
      Object.keys(network).some((key) => key !== "internal") ||
      (Object.hasOwn(network, "internal") &&
        typeof network.internal !== "boolean") ||
      (opts.normalized && !Object.hasOwn(network, "internal"))
    ) {
      return undefined;
    }
    result.set(
      name,
      Object.hasOwn(network, "internal") && network.internal === true
    );
  }
  return result;
}

function attachments(opts: {
  readonly workload: Readonly<Record<string, unknown>>;
  readonly definitions: Definitions;
  readonly normalized: boolean;
}): Attachments | undefined {
  if (!Object.hasOwn(opts.workload, "networks")) {
    return new Map();
  }
  const value = opts.workload.networks;
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return undefined;
  }
  const result = new Map<string, readonly string[]>();
  for (const [name, attachment] of Object.entries(value)) {
    if (
      !(
        (name === "default" || opts.definitions.has(name)) &&
        isRecord(attachment)
      ) ||
      Object.keys(attachment).some((key) => key !== "aliases")
    ) {
      return undefined;
    }
    const aliases = Object.hasOwn(attachment, "aliases")
      ? attachment.aliases
      : [];
    if (
      !(
        Array.isArray(aliases) &&
        aliases.every((alias) => typeof alias === "string" && NAME.test(alias))
      ) ||
      new Set(aliases).size !== aliases.length ||
      (opts.normalized &&
        Object.hasOwn(attachment, "aliases") &&
        aliases.length === 0)
    ) {
      return undefined;
    }
    const sorted = [...aliases].sort();
    if (
      opts.normalized &&
      sorted.some((alias, index) => aliases[index] !== alias)
    ) {
      return undefined;
    }
    result.set(name, sorted);
  }
  return result;
}

function sameDefinitions(left: Definitions, right: Definitions): boolean {
  return (
    left.size === right.size &&
    [...left].every(([name, internal]) => right.get(name) === internal)
  );
}

function sameAttachments(left: Attachments, right: Attachments): boolean {
  return (
    left.size === right.size &&
    [...left].every(([name, aliases]) => {
      const expected = right.get(name);
      return (
        expected !== undefined &&
        aliases.length === expected.length &&
        aliases.every((alias, index) => alias === expected[index])
      );
    })
  );
}

/** Validate only closed network declarations; Rust retains topology policy ownership. */
export function nativeNetworkPlanIsValid(opts: {
  readonly plan: Readonly<Record<string, unknown>>;
  readonly declared?: NativeDeclaredWorkloads;
}): boolean {
  if (!nativeNetworkPlanningRequired(opts.plan)) {
    return true;
  }
  const networks = definitions({ document: opts.plan, normalized: true });
  if (!(networks && opts.declared)) {
    return false;
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
        !isRecord(workload) ||
        seen.has(name) ||
        !Object.hasOwn(opts.declared, name) ||
        opts.declared[name] !== kind ||
        !attachments({ workload, definitions: networks, normalized: true })
      ) {
        return false;
      }
      seen.add(name);
    }
  }
  return true;
}

function selected(
  workload: Record<string, unknown>,
  profiles: readonly string[]
): boolean | undefined {
  if (!Object.hasOwn(workload, "profiles")) {
    return true;
  }
  if (
    !(
      Array.isArray(workload.profiles) &&
      workload.profiles.every(
        (name) => typeof name === "string" && NAME.test(name)
      )
    ) ||
    new Set(workload.profiles).size !== workload.profiles.length
  ) {
    return undefined;
  }
  return (
    workload.profiles.length === 0 ||
    workload.profiles.some((name) => profiles.includes(name))
  );
}

function namespaceMatches(opts: {
  readonly inputs: Record<string, unknown>;
  readonly outputs: Record<string, unknown>;
  readonly networks: Definitions;
  readonly profiles: readonly string[];
  readonly kind: "service" | "job";
  readonly declared: Map<string, "service" | "job">;
}): boolean {
  for (const [name, workload] of Object.entries(opts.inputs)) {
    if (
      !(NAME.test(name) && isRecord(workload)) ||
      opts.declared.has(name) ||
      !attachments({ workload, definitions: opts.networks, normalized: false })
    ) {
      return false;
    }
    opts.declared.set(name, opts.kind);
    const active = selected(workload, opts.profiles);
    if (active === undefined || active !== Object.hasOwn(opts.outputs, name)) {
      return false;
    }
  }
  return Object.entries(opts.outputs).every(([name, workload]) => {
    const source = opts.inputs[name];
    if (
      !(
        Object.hasOwn(opts.inputs, name) &&
        isRecord(source) &&
        isRecord(workload)
      )
    ) {
      return false;
    }
    const authored = attachments({
      workload: source,
      definitions: opts.networks,
      normalized: false,
    });
    const compiled = attachments({
      workload,
      definitions: opts.networks,
      normalized: true,
    });
    return (
      authored !== undefined &&
      compiled !== undefined &&
      sameAttachments(authored, compiled)
    );
  });
}

/** Check exact source claims, without making attachment or engine policy decisions. */
export function nativeNetworkSourceMatches(opts: {
  readonly input: Uint8Array;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly declared?: NativeDeclaredWorkloads;
  readonly profiles?: readonly string[];
}): boolean {
  const source = project(opts.input);
  if (
    !(
      (source && nativeNetworkPlanningRequired(source)) ||
      nativeNetworkPlanningRequired(opts.plan)
    )
  ) {
    return true;
  }
  if (
    !(source && opts.declared) ||
    typeof source.name !== "string" ||
    !NAME.test(source.name) ||
    opts.plan.name !== source.name ||
    !nativeNetworkPlanIsValid(opts)
  ) {
    return false;
  }
  const authored = definitions({ document: source, normalized: false });
  const compiled = definitions({ document: opts.plan, normalized: true });
  if (!(authored && compiled && sameDefinitions(authored, compiled))) {
    return false;
  }
  const profiles = [...(opts.profiles ?? [])].sort();
  const reported = opts.plan.selected_profiles;
  if (
    new Set(profiles).size !== profiles.length ||
    !Array.isArray(reported) ||
    profiles.length !== reported.length ||
    profiles.some((name, index) => name !== reported[index])
  ) {
    return false;
  }
  const declared = new Map<string, "service" | "job">();
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
        namespaceMatches({
          inputs,
          outputs,
          networks: authored,
          profiles,
          kind,
          declared,
        })
      )
    ) {
      return false;
    }
  }
  return (
    declared.size === Object.keys(opts.declared).length &&
    [...declared].every(
      ([name, kind]) =>
        Object.hasOwn(opts.declared ?? {}, name) &&
        opts.declared?.[name] === kind
    )
  );
}
