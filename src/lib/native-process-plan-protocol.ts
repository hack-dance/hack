import type {
  Entrypoint,
  Restart,
  Shutdown,
  ShutdownSignal,
} from "../../packages/config-compiler/generated/native-config.ts";
import { isRecord } from "./guards.ts";
import type { NativeDeclaredWorkloads } from "./native-env-plan-protocol.ts";

const FIELDS = ["entrypoint", "init", "shutdown", "restart"] as const;
const U32_MAX = 4_294_967_295;
const DURATION = /^(\d+)(ms|s|m|h)$/;
const CANONICAL_MILLISECONDS = /^[1-9]\d*ms$/;
const LEADING_ZEROES = /^0+/;
const SIGNALS: Readonly<Record<ShutdownSignal, true>> = {
  SIGHUP: true,
  SIGINT: true,
  SIGQUIT: true,
  SIGILL: true,
  SIGTRAP: true,
  SIGABRT: true,
  SIGBUS: true,
  SIGFPE: true,
  SIGKILL: true,
  SIGUSR1: true,
  SIGSEGV: true,
  SIGUSR2: true,
  SIGPIPE: true,
  SIGALRM: true,
  SIGTERM: true,
  SIGSTKFLT: true,
  SIGCHLD: true,
  SIGCONT: true,
  SIGSTOP: true,
  SIGTSTP: true,
  SIGTTIN: true,
  SIGTTOU: true,
  SIGURG: true,
  SIGXCPU: true,
  SIGXFSZ: true,
  SIGVTALRM: true,
  SIGPROF: true,
  SIGWINCH: true,
  SIGIO: true,
  SIGPWR: true,
  SIGSYS: true,
};
const UNITS = { ms: 1n, s: 1000n, m: 60_000n, h: 3_600_000n } as const;

function only(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function positiveU32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= U32_MAX
  );
}

function project(input: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input)
    );
    return isRecord(value) ? value : undefined;
  } catch {
    // Rust owns whole-document validity and duplicate-key diagnostics.
    return undefined;
  }
}

function hasProcessFields(value: unknown): boolean {
  return isRecord(value) && FIELDS.some((field) => Object.hasOwn(value, field));
}

/** Request capability from authored presence, including fields in inactive workloads. */
export function authoredProcessPlanningRequired(input: Uint8Array): boolean {
  const source = project(input);
  return source !== undefined && nativeProcessPlanningRequired(source);
}

/** Inspect intent presence only, preserving absence and image-provided defaults. */
export function nativeProcessPlanningRequired(
  plan: Readonly<Record<string, unknown>>
): boolean {
  return [plan.services, plan.jobs].some(
    (entries) =>
      isRecord(entries) && Object.values(entries).some(hasProcessFields)
  );
}

function entrypoint(value: unknown): value is Entrypoint {
  if (!isRecord(value)) {
    return false;
  }
  if (Object.hasOwn(value, "exec")) {
    return (
      only(value, ["exec"]) &&
      Array.isArray(value.exec) &&
      (value.exec.length === 0 || value.exec[0] !== "") &&
      value.exec.every(
        (part) => typeof part === "string" && !part.includes("\0")
      )
    );
  }
  return (
    only(value, ["shell"]) &&
    typeof value.shell === "string" &&
    value.shell.length > 0 &&
    !value.shell.includes("\0")
  );
}

function shutdown(value: unknown, normalized: boolean): value is Shutdown {
  if (
    !(isRecord(value) && only(value, ["signal", "grace"])) ||
    Object.keys(value).length === 0
  ) {
    return false;
  }
  if (
    Object.hasOwn(value, "signal") &&
    !(typeof value.signal === "string" && Object.hasOwn(SIGNALS, value.signal))
  ) {
    return false;
  }
  if (!Object.hasOwn(value, "grace")) {
    return true;
  }
  if (typeof value.grace !== "string") {
    return false;
  }
  const milliseconds = duration(value.grace);
  return (
    milliseconds !== undefined &&
    (!normalized ||
      (CANONICAL_MILLISECONDS.test(value.grace) &&
        value.grace === `${milliseconds}ms`))
  );
}

function duration(value: string): bigint | undefined {
  const match = DURATION.exec(value);
  const amount = match?.[1];
  const unit = match?.[2];
  if (!(amount && unit && Object.hasOwn(UNITS, unit))) {
    return undefined;
  }
  const significant = amount.replace(LEADING_ZEROES, "");
  if (significant.length === 0 || significant.length > 10) {
    return undefined;
  }
  const factor = UNITS[unit as keyof typeof UNITS];
  const milliseconds = BigInt(significant) * factor;
  return milliseconds > 0n && milliseconds <= BigInt(U32_MAX)
    ? milliseconds
    : undefined;
}

function restart(value: unknown, kind: "service" | "job"): value is Restart {
  if (!(isRecord(value) && only(value, ["kind", "max_retries"]))) {
    return false;
  }
  if (value.kind === "on-failure") {
    return (
      !Object.hasOwn(value, "max_retries") || positiveU32(value.max_retries)
    );
  }
  if (value.kind === "no") {
    return !Object.hasOwn(value, "max_retries");
  }
  return (
    kind === "service" &&
    (value.kind === "always" || value.kind === "unless-stopped") &&
    !Object.hasOwn(value, "max_retries")
  );
}

function fieldsValid(
  value: Record<string, unknown>,
  kind: "service" | "job",
  normalized: boolean
): boolean {
  return (
    (!Object.hasOwn(value, "entrypoint") || entrypoint(value.entrypoint)) &&
    (!Object.hasOwn(value, "init") || typeof value.init === "boolean") &&
    (!Object.hasOwn(value, "shutdown") ||
      shutdown(value.shutdown, normalized)) &&
    (!Object.hasOwn(value, "restart") || restart(value.restart, kind))
  );
}

/** Validate only process-owned normalized fields and their service/job namespace. */
export function nativeProcessPlanIsValid(opts: {
  readonly plan: Readonly<Record<string, unknown>>;
  readonly declared?: NativeDeclaredWorkloads;
}): boolean {
  if (!nativeProcessPlanningRequired(opts.plan)) {
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
        !(isRecord(workload) && fieldsValid(workload, kind, true)) ||
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

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }
  return (
    isRecord(left) &&
    isRecord(right) &&
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(
      ([key, value]) =>
        Object.hasOwn(right, key) && sameValue(value, right[key])
    )
  );
}

function fieldsMatch(
  source: Record<string, unknown>,
  output: Record<string, unknown>
): boolean {
  for (const field of FIELDS) {
    if (Object.hasOwn(source, field) !== Object.hasOwn(output, field)) {
      return false;
    }
    if (field === "shutdown" && isRecord(source.shutdown)) {
      const normalized = { ...source.shutdown };
      if (typeof normalized.grace === "string") {
        const milliseconds = duration(normalized.grace);
        if (milliseconds === undefined) {
          return false;
        }
        normalized.grace = `${milliseconds}ms`;
      }
      if (!sameValue(normalized, output.shutdown)) {
        return false;
      }
    } else if (!sameValue(source[field], output[field])) {
      return false;
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
      source.profiles.every((profile) => typeof profile === "string")
    )
  ) {
    return undefined;
  }
  return (
    source.profiles.length === 0 ||
    source.profiles.some((profile) => profiles.includes(profile))
  );
}

/** Cross-check source claims after Rust succeeds; no default engine behavior is synthesized. */
export function nativeProcessSourceMatches(opts: {
  readonly input: Uint8Array;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly declared?: NativeDeclaredWorkloads;
  readonly profiles?: readonly string[];
}): boolean {
  const source = project(opts.input);
  if (
    !(
      (source && nativeProcessPlanningRequired(source)) ||
      nativeProcessPlanningRequired(opts.plan)
    )
  ) {
    return true;
  }
  if (
    !(source && opts.declared && nativeProcessPlanIsValid(opts)) ||
    typeof source.name !== "string" ||
    opts.plan.name !== source.name
  ) {
    return false;
  }
  const profiles = [...(opts.profiles ?? [])].sort();
  if (new Set(profiles).size !== profiles.length) {
    return false;
  }
  if (!sameValue(profiles, opts.plan.selected_profiles)) {
    return false;
  }
  const sourceKinds = new Map<string, "service" | "job">();
  for (const [field, kind] of [
    ["services", "service"],
    ["jobs", "job"],
  ] as const) {
    const inputs = Object.hasOwn(source, field) ? source[field] : {};
    const outputs = opts.plan[field];
    if (!(isRecord(inputs) && isRecord(outputs))) {
      return false;
    }
    if (
      !sourceNamespaceMatches({ inputs, outputs, profiles, kind, sourceKinds })
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

function sourceNamespaceMatches(opts: {
  readonly inputs: Record<string, unknown>;
  readonly outputs: Record<string, unknown>;
  readonly profiles: readonly string[];
  readonly kind: "service" | "job";
  readonly sourceKinds: Map<string, "service" | "job">;
}): boolean {
  for (const [name, workload] of Object.entries(opts.inputs)) {
    if (
      !(isRecord(workload) && fieldsValid(workload, opts.kind, false)) ||
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
  return Object.entries(opts.outputs).every(
    ([name, workload]) =>
      Object.hasOwn(opts.inputs, name) &&
      isRecord(opts.inputs[name]) &&
      isRecord(workload) &&
      fieldsMatch(opts.inputs[name], workload)
  );
}
