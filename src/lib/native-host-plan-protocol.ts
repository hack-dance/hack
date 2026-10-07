import type {
  HostEnvTarget,
  HostEnvTargets,
  HostMetadata,
} from "../../packages/config-compiler/generated/native-config.ts";
import { isRecord } from "./guards.ts";
import type {
  NativeDeclaredWorkloads,
  NativeEnvBinding,
  NativeManagedEntry,
} from "./native-env-plan-protocol.ts";

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const KEY = /^[A-Z_][A-Z0-9_]*$/;
const DESTINATION = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCOPE = /^[a-z0-9][a-z0-9._-]*$/;

export type NativeHostEnvTargets = Readonly<
  Omit<HostEnvTargets, "workloads">
> & { readonly workloads: readonly string[] };
export type NativeHostEnvTarget = Readonly<HostEnvTarget>;
export type NativeHostMetadata = Readonly<
  Omit<HostMetadata, "default" | "workloads">
> & {
  readonly default?: Readonly<Record<string, NativeManagedEntry>>;
  readonly workloads: Readonly<
    Record<string, Readonly<Record<string, NativeManagedEntry>>>
  >;
};
export type NativeHostEnvironmentPlan = Readonly<
  Record<
    string,
    {
      readonly env_target: NativeHostEnvTarget;
      readonly bindings: Readonly<Record<string, NativeEnvBinding>>;
    }
  >
>;

function only(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function parseNativeHostTarget(
  value: unknown
): NativeHostEnvTarget | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind === "host" && only(value, ["kind"])) {
    return { kind: "host" };
  }
  if (
    value.kind === "workload" &&
    only(value, ["kind", "name"]) &&
    typeof value.name === "string" &&
    NAME.test(value.name)
  ) {
    return { kind: "workload", name: value.name };
  }
  return null;
}

/** Rust selects owner targets; this boundary checks only the wire projection. */
export function parseNativeHostTargets(
  value: unknown
): NativeHostEnvTargets | null {
  if (
    !(isRecord(value) && only(value, ["include_default", "workloads"])) ||
    typeof value.include_default !== "boolean" ||
    !Array.isArray(value.workloads)
  ) {
    return null;
  }
  const workloads: string[] = [];
  for (const name of value.workloads) {
    const previous = workloads.at(-1);
    if (
      typeof name !== "string" ||
      !NAME.test(name) ||
      (previous !== undefined && name <= previous)
    ) {
      return null;
    }
    workloads.push(name);
  }
  return { include_default: value.include_default, workloads };
}

function parseManagedMap(
  value: unknown
): Record<string, NativeManagedEntry> | null {
  if (!isRecord(value)) {
    return null;
  }
  const output: Record<string, NativeManagedEntry> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      !(KEY.test(key) && isRecord(entry) && only(entry, ["scope", "secret"])) ||
      typeof entry.scope !== "string" ||
      !SCOPE.test(entry.scope) ||
      typeof entry.secret !== "boolean"
    ) {
      return null;
    }
    output[key] = { scope: entry.scope, secret: entry.secret };
  }
  return output;
}

/** Refuse extra stored values rather than forwarding or silently stripping them. */
export function parseNativeHostMetadata(
  value: unknown
): NativeHostMetadata | null {
  if (
    !(
      isRecord(value) &&
      only(value, ["default", "workloads"]) &&
      isRecord(value.workloads)
    )
  ) {
    return null;
  }
  const defaultBindings = Object.hasOwn(value, "default")
    ? parseManagedMap(value.default)
    : undefined;
  if (defaultBindings === null) {
    return null;
  }
  const workloads: Record<string, Record<string, NativeManagedEntry>> = {};
  for (const [name, bindings] of Object.entries(value.workloads)) {
    const projected = parseManagedMap(bindings);
    if (!(NAME.test(name) && projected)) {
      return null;
    }
    workloads[name] = projected;
  }
  return {
    ...(defaultBindings === undefined ? {} : { default: defaultBindings }),
    workloads,
  };
}

export function parseNativeHostReports(opts: {
  readonly value: unknown;
  readonly parseBinding: (value: unknown) => NativeEnvBinding | null;
}): NativeHostEnvironmentPlan | null {
  if (!isRecord(opts.value)) {
    return null;
  }
  const output: Record<string, NativeHostEnvironmentPlan[string]> = {};
  for (const [name, entry] of Object.entries(opts.value)) {
    if (
      !(
        NAME.test(name) &&
        isRecord(entry) &&
        only(entry, ["env_target", "bindings"]) &&
        isRecord(entry.bindings)
      )
    ) {
      return null;
    }
    const target = parseNativeHostTarget(entry.env_target);
    if (!target) {
      return null;
    }
    const bindings: Record<string, NativeEnvBinding> = {};
    for (const [key, value] of Object.entries(entry.bindings)) {
      const binding = opts.parseBinding(value);
      if (!(DESTINATION.test(key) && binding)) {
        return null;
      }
      Object.defineProperty(bindings, key, {
        value: binding,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    output[name] = { env_target: target, bindings };
  }
  return output;
}

/** Compare normalized Rust envelopes, without interpreting authored documents. */
export function nativeHostSelectionMatches(opts: {
  readonly plan: Readonly<Record<string, unknown>>;
  readonly declared: NativeDeclaredWorkloads | undefined;
  readonly targets: NativeHostEnvTargets | undefined;
  readonly report?: NativeHostEnvironmentPlan;
  readonly requireReport?: boolean;
}): boolean {
  if (opts.plan.host === undefined) {
    return opts.targets === undefined && opts.report === undefined;
  }
  const entries = readNormalizedInvocations(opts.plan.host);
  if (!(entries && opts.targets && opts.declared) || entries.size === 0) {
    return false;
  }
  let includeDefault = false;
  const workloads = new Set<string>();
  for (const target of entries.values()) {
    if (target.kind === "host") {
      includeDefault = true;
    } else if (Object.hasOwn(opts.declared, target.name)) {
      workloads.add(target.name);
    } else {
      return false;
    }
  }
  if (
    includeDefault !== opts.targets.include_default ||
    workloads.size !== opts.targets.workloads.length ||
    !opts.targets.workloads.every((name) => workloads.has(name))
  ) {
    return false;
  }
  if (opts.report === undefined) {
    return !opts.requireReport;
  }
  return (
    entries.size === Object.keys(opts.report).length &&
    Object.entries(opts.report).every(([name, report]) => {
      const target = entries.get(name);
      return (
        target?.kind === report.env_target.kind &&
        (target.kind === "host" ||
          (report.env_target.kind === "workload" &&
            target.name === report.env_target.name))
      );
    })
  );
}

function readNormalizedInvocations(
  host: unknown
): Map<string, NativeHostEnvTarget> | null {
  if (!(isRecord(host) && only(host, ["up", "down", "processes"]))) {
    return null;
  }
  const output = new Map<string, NativeHostEnvTarget>();
  const add = (name: unknown, value: unknown): boolean => {
    if (typeof name !== "string" || !NAME.test(name) || !isRecord(value)) {
      return false;
    }
    const target = parseNativeHostTarget(value.env_target);
    if (!target || output.has(name)) {
      return false;
    }
    output.set(name, target);
    return true;
  };
  for (const action of ["up", "down"]) {
    const hooks = normalizedHooks(host[action]);
    if (!hooks) {
      return null;
    }
    for (const entry of hooks) {
      if (!add(entry.name, entry)) {
        return null;
      }
    }
  }
  if (host.processes !== undefined) {
    if (!isRecord(host.processes)) {
      return null;
    }
    for (const [name, entry] of Object.entries(host.processes)) {
      if (!add(name, entry)) {
        return null;
      }
    }
  }
  return output;
}

function normalizedHooks(value: unknown): Record<string, unknown>[] | null {
  if (value === undefined) {
    return [];
  }
  if (!(isRecord(value) && only(value, ["before", "after"]))) {
    return null;
  }
  const output: Record<string, unknown>[] = [];
  for (const phase of ["before", "after"]) {
    const entries = value[phase];
    if (entries === undefined) {
      continue;
    }
    if (!Array.isArray(entries)) {
      return null;
    }
    for (const entry of entries) {
      if (!isRecord(entry)) {
        return null;
      }
      output.push(entry);
    }
  }
  return output;
}
