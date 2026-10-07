import type {
  EnvironmentBinding,
  EnvironmentPlan,
  EnvMetadata,
  ManagedBindingMetadata,
  WorkloadKind,
} from "../../packages/config-compiler/generated/native-config.ts";
import { isRecord } from "./guards.ts";
import type { NativeConfigDiagnostic } from "./native-config-compiler.ts";
import {
  type NativeHostEnvironmentPlan,
  type NativeHostMetadata,
  parseNativeHostMetadata,
  parseNativeHostReports,
} from "./native-host-plan-protocol.ts";

const WORKLOAD_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const MANAGED_KEY = /^[A-Z_][A-Z0-9_]*$/;
const AUTHORED_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCOPE = /^[a-z0-9][a-z0-9._-]*$/;
const OVERLAY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type NativeDeclaredWorkloads = Readonly<Record<string, WorkloadKind>>;
export type NativeManagedEntry = Readonly<ManagedBindingMetadata>;
export type NativeEnvMetadata = Readonly<
  Omit<EnvMetadata, "workloads" | "inactive_scopes" | "host">
> & {
  readonly workloads: Readonly<
    Record<string, Readonly<Record<string, NativeManagedEntry>>>
  >;
  readonly inactive_scopes: readonly string[];
  readonly host?: NativeHostMetadata;
};
export type NativeEnvBinding = Readonly<EnvironmentBinding>;
export type NativeEnvironmentPlan = Readonly<
  Omit<EnvironmentPlan, "workloads" | "warnings" | "diagnostics" | "host">
> & {
  readonly workloads: Readonly<
    Record<string, Readonly<Record<string, NativeEnvBinding>>>
  >;
  readonly warnings: readonly NativeConfigDiagnostic[];
  readonly diagnostics: readonly NativeConfigDiagnostic[];
  readonly host?: NativeHostEnvironmentPlan;
};

function hasOnly(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isOverlay(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && OVERLAY.test(value));
}

/** Wire projection only; authored policy and binding decisions remain in Rust. */
export function parseDeclaredWorkloads(
  value: unknown
): NativeDeclaredWorkloads | null {
  if (!isRecord(value)) {
    return null;
  }
  const output: Record<string, "service" | "job"> = {};
  for (const [name, kind] of Object.entries(value)) {
    if (!WORKLOAD_NAME.test(name) || (kind !== "service" && kind !== "job")) {
      return null;
    }
    output[name] = kind;
  }
  return output;
}

/** Never forward extra stored values or paths through the metadata transport. */
export function parseNativeEnvMetadata(
  value: unknown
): NativeEnvMetadata | null {
  if (
    !(
      isRecord(value) &&
      hasOnly(value, [
        "metadata_version",
        "overlay",
        "overlay_exists",
        "workloads",
        "inactive_scopes",
        "host",
      ])
    ) ||
    value.metadata_version !== 1 ||
    !isOverlay(value.overlay) ||
    typeof value.overlay_exists !== "boolean" ||
    !isRecord(value.workloads) ||
    !Array.isArray(value.inactive_scopes)
  ) {
    return null;
  }
  const workloads = parseWorkloadMetadata(value.workloads);
  if (!workloads) {
    return null;
  }
  const inactiveScopes: string[] = [];
  for (const scope of value.inactive_scopes) {
    if (typeof scope !== "string" || !SCOPE.test(scope)) {
      return null;
    }
    inactiveScopes.push(scope);
  }
  const host = Object.hasOwn(value, "host")
    ? parseNativeHostMetadata(value.host)
    : undefined;
  if (host === null) {
    return null;
  }
  return {
    metadata_version: 1,
    overlay: value.overlay,
    overlay_exists: value.overlay_exists,
    workloads,
    inactive_scopes: inactiveScopes,
    ...(host === undefined ? {} : { host }),
  };
}

function parseWorkloadMetadata(
  value: Record<string, unknown>
): Record<string, Record<string, NativeManagedEntry>> | null {
  const workloads: Record<string, Record<string, NativeManagedEntry>> = {};
  for (const [name, entries] of Object.entries(value)) {
    if (!(WORKLOAD_NAME.test(name) && isRecord(entries))) {
      return null;
    }
    const projected: Record<string, NativeManagedEntry> = {};
    for (const [key, entry] of Object.entries(entries)) {
      if (
        !(
          MANAGED_KEY.test(key) &&
          isRecord(entry) &&
          hasOnly(entry, ["scope", "secret"])
        ) ||
        typeof entry.scope !== "string" ||
        !SCOPE.test(entry.scope) ||
        typeof entry.secret !== "boolean"
      ) {
        return null;
      }
      projected[key] = { scope: entry.scope, secret: entry.secret };
    }
    workloads[name] = projected;
  }
  return workloads;
}

function parseBinding(value: unknown): NativeEnvBinding | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.kind === "managed" &&
    hasOnly(value, ["kind", "key", "scope", "secret"]) &&
    typeof value.key === "string" &&
    MANAGED_KEY.test(value.key) &&
    typeof value.scope === "string" &&
    SCOPE.test(value.scope) &&
    typeof value.secret === "boolean"
  ) {
    return {
      kind: "managed",
      key: value.key,
      scope: value.scope,
      secret: value.secret,
    };
  }
  if (
    (value.kind === "literal" || value.kind === "default") &&
    hasOnly(value, ["kind", "value"]) &&
    typeof value.value === "string"
  ) {
    return { kind: value.kind, value: value.value };
  }
  return null;
}

/** Validate the names-only report envelope without deciding effective bindings. */
export function parseNativeEnvironmentPlan(opts: {
  readonly value: unknown;
  readonly parseDiagnostic: (value: unknown) => NativeConfigDiagnostic;
}): NativeEnvironmentPlan | null {
  const value = opts.value;
  if (
    !(
      isRecord(value) &&
      hasOnly(value, [
        "plan_version",
        "overlay",
        "overlay_exists",
        "complete",
        "workloads",
        "warnings",
        "diagnostics",
        "host",
      ])
    ) ||
    value.plan_version !== 1 ||
    !isOverlay(value.overlay) ||
    typeof value.overlay_exists !== "boolean" ||
    typeof value.complete !== "boolean" ||
    !isRecord(value.workloads) ||
    !Array.isArray(value.warnings) ||
    !Array.isArray(value.diagnostics)
  ) {
    return null;
  }
  const workloads: Record<string, Record<string, NativeEnvBinding>> = {};
  for (const [name, entries] of Object.entries(value.workloads)) {
    if (!(WORKLOAD_NAME.test(name) && isRecord(entries))) {
      return null;
    }
    const bindings: Record<string, NativeEnvBinding> = {};
    for (const [key, entry] of Object.entries(entries)) {
      const binding = parseBinding(entry);
      if (!(AUTHORED_KEY.test(key) && binding)) {
        return null;
      }
      // Authored destinations may include __proto__; define an own data key.
      Object.defineProperty(bindings, key, {
        value: binding,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    workloads[name] = bindings;
  }
  const warnings = value.warnings.map(opts.parseDiagnostic);
  const diagnostics = value.diagnostics.map(opts.parseDiagnostic);
  const host = Object.hasOwn(value, "host")
    ? parseNativeHostReports({ value: value.host, parseBinding })
    : undefined;
  if (
    host === null ||
    value.complete !== (diagnostics.length === 0) ||
    [...warnings, ...diagnostics].some((entry) => entry.document === undefined)
  ) {
    return null;
  }
  return {
    plan_version: 1,
    overlay: value.overlay,
    overlay_exists: value.overlay_exists,
    complete: value.complete,
    workloads,
    warnings,
    diagnostics,
    ...(host === undefined ? {} : { host }),
  };
}
