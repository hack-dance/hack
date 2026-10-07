import { isIP } from "node:net";
import type {
  EndpointProtocol,
  EndpointReference,
  EndpointTarget,
  EnvironmentBinding,
  HostBindingOrigin,
  HostBindingTarget,
} from "../../packages/config-compiler/generated/native-config.ts";
import { isRecord } from "./guards.ts";
import type {
  NativeDeclaredWorkloads,
  NativeEnvBinding,
  NativeEnvironmentPlan,
  NativeEnvMetadata,
  NativeManagedEntry,
} from "./native-env-plan-protocol.ts";
import type { NativeRoutingResolution } from "./native-routing-plan-protocol.ts";

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const BINDING_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/;
const DESTINATION = /^[A-Za-z_][A-Za-z0-9_]*$/;

type BindingOrigin = HostBindingOrigin;
export type NativeEndpointReference = Readonly<EndpointReference>;
export type NativeHostBindingTarget = Readonly<HostBindingTarget>;
export type NativeEndpointTarget = Readonly<EndpointTarget>;
export type NativeEndpointBinding = Readonly<
  Omit<
    Extract<EnvironmentBinding, { kind: "endpoint" }>,
    "reference" | "target"
  >
> & {
  readonly reference: NativeEndpointReference;
  readonly target: NativeEndpointTarget;
};
export type NativeHostBindingResolution = {
  readonly bindings: Readonly<
    Record<
      string,
      {
        readonly target: NativeHostBindingTarget;
        readonly origin: BindingOrigin;
      }
    >
  >;
  readonly removed: Readonly<Record<string, BindingOrigin>>;
};

function only(
  value: Record<string, unknown>,
  allowed: readonly string[]
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function protocol(value: unknown): value is EndpointProtocol {
  return value === "http" || value === "https" || value === "tcp";
}

function port(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 65_535
  );
}

function hostname(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 253) {
    return false;
  }
  if (value.startsWith("[")) {
    try {
      return (
        isIP(value.slice(1, -1)) === 6 &&
        new URL(`http://${value}`).hostname === value
      );
    } catch {
      return false;
    }
  }
  if (isIP(value) === 4) {
    return true;
  }
  return (
    value.split(".").every((label) => DNS_LABEL.test(label)) &&
    !NUMERIC_LABEL.test(value.split(".").at(-1) ?? "")
  );
}

function origin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === value &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

/** Wire validation only. Rust owns authored normalization, selection and local policy. */
export function parseNativeEndpointReference(
  value: unknown
): NativeEndpointReference | null {
  if (
    !(
      isRecord(value) &&
      typeof value.name === "string" &&
      NAME.test(value.name)
    )
  ) {
    return null;
  }
  if (
    (value.kind === "route" || value.kind === "host_binding") &&
    only(value, ["kind", "name"])
  ) {
    if (value.kind === "host_binding" && !BINDING_NAME.test(value.name)) {
      return null;
    }
    return { kind: value.kind, name: value.name };
  }
  if (
    value.kind === "service" &&
    only(value, ["kind", "name", "port", "protocol"]) &&
    port(value.port) &&
    protocol(value.protocol)
  ) {
    return {
      kind: "service",
      name: value.name,
      port: value.port,
      protocol: value.protocol,
    };
  }
  return null;
}

export function parseNativeHostBindingTarget(
  value: unknown
): NativeHostBindingTarget | null {
  if (!(isRecord(value) && port(value.port) && protocol(value.protocol))) {
    return null;
  }
  if (value.kind === "host" && only(value, ["kind", "port", "protocol"])) {
    return { kind: "host", port: value.port, protocol: value.protocol };
  }
  if (
    value.kind === "external" &&
    only(value, ["kind", "hostname", "port", "protocol"]) &&
    hostname(value.hostname)
  ) {
    return {
      kind: "external",
      hostname: value.hostname,
      port: value.port,
      protocol: value.protocol,
    };
  }
  return null;
}

function parseTarget(value: unknown): NativeEndpointTarget | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.kind === "route" &&
    only(value, ["kind", "origin"]) &&
    origin(value.origin)
  ) {
    return { kind: "route", origin: value.origin };
  }
  if (value.kind === "service") {
    const reference = parseNativeEndpointReference(value);
    return reference?.kind === "service" ? reference : null;
  }
  if (
    value.kind === "host" &&
    only(value, ["kind", "context", "port", "protocol"]) &&
    (value.context === "host" || value.context === "workload") &&
    port(value.port) &&
    protocol(value.protocol)
  ) {
    return {
      kind: "host",
      context: value.context,
      port: value.port,
      protocol: value.protocol,
    };
  }
  const binding = parseNativeHostBindingTarget(value);
  return binding?.kind === "external" ? binding : null;
}

/** Endpoint bindings remain symbolic; this transport never invents a runtime address. */
export function parseNativeEndpointBinding(
  value: unknown
): NativeEndpointBinding | null {
  if (
    !(
      isRecord(value) &&
      value.kind === "endpoint" &&
      only(value, ["kind", "reference", "target"])
    )
  ) {
    return null;
  }
  const reference = parseNativeEndpointReference(value.reference);
  const target = parseTarget(value.target);
  return reference && target ? { kind: "endpoint", reference, target } : null;
}

function bindingOrigin(value: unknown): value is BindingOrigin {
  return (
    value === "project" ||
    value === "primary_local" ||
    value === "checkout_local"
  );
}

export function parseNativeHostBindingResolution(
  value: unknown
): NativeHostBindingResolution | null {
  if (
    !(
      isRecord(value) &&
      only(value, ["bindings", "removed"]) &&
      isRecord(value.bindings) &&
      isRecord(value.removed)
    )
  ) {
    return null;
  }
  const bindings: [string, NativeHostBindingResolution["bindings"][string]][] =
    [];
  for (const [name, entry] of Object.entries(value.bindings)) {
    if (
      !(
        NAME.test(name) &&
        BINDING_NAME.test(name) &&
        isRecord(entry) &&
        only(entry, ["target", "origin"]) &&
        bindingOrigin(entry.origin)
      )
    ) {
      return null;
    }
    const target = parseNativeHostBindingTarget(entry.target);
    if (!target) {
      return null;
    }
    bindings.push([name, { target, origin: entry.origin }]);
  }
  const removed: [string, BindingOrigin][] = [];
  for (const [name, source] of Object.entries(value.removed)) {
    if (
      !(NAME.test(name) && BINDING_NAME.test(name) && bindingOrigin(source)) ||
      source === "project" ||
      Object.hasOwn(value.bindings, name)
    ) {
      return null;
    }
    removed.push([name, source]);
  }
  return {
    bindings: Object.fromEntries(bindings),
    removed: Object.fromEntries(removed),
  };
}

type EnvironmentEntry = {
  readonly name: string;
  readonly host: boolean;
  readonly environment: Record<string, unknown>;
  readonly pointer: string;
};

function environmentEntries(
  plan: Readonly<Record<string, unknown>>
): EnvironmentEntry[] | null {
  const output: EnvironmentEntry[] = [];
  for (const field of ["services", "jobs"] as const) {
    const workloads = plan[field];
    if (!isRecord(workloads)) {
      return null;
    }
    for (const [name, entry] of Object.entries(workloads)) {
      if (!isRecord(entry)) {
        return null;
      }
      if (entry.environment !== undefined && !isRecord(entry.environment)) {
        return null;
      }
      output.push({
        name,
        host: false,
        environment: isRecord(entry.environment) ? entry.environment : {},
        pointer: `/${field}/${escapePointer(name)}/environment`,
      });
    }
  }
  if (!isRecord(plan.host)) {
    return output;
  }
  const hooks = hookEnvironments(plan.host);
  const processes = processEnvironments(plan.host.processes);
  if (!(hooks && processes)) {
    return null;
  }
  output.push(...hooks, ...processes);
  return output;
}

function hookEnvironments(
  host: Record<string, unknown>
): EnvironmentEntry[] | null {
  const output: EnvironmentEntry[] = [];
  for (const action of ["up", "down"]) {
    const hooks = host[action];
    if (!isRecord(hooks)) {
      continue;
    }
    for (const phase of ["before", "after"]) {
      const entries = hooks[phase];
      if (!Array.isArray(entries)) {
        continue;
      }
      for (const [index, entry] of entries.entries()) {
        if (
          !(
            isRecord(entry) &&
            typeof entry.name === "string" &&
            isRecord(entry.environment)
          )
        ) {
          return null;
        }
        output.push({
          name: entry.name,
          host: true,
          environment: entry.environment,
          pointer: `/host/${action}/${phase}/${index}/environment`,
        });
      }
    }
  }
  return output;
}

function processEnvironments(processes: unknown): EnvironmentEntry[] | null {
  if (processes === undefined) {
    return [];
  }
  if (!isRecord(processes)) {
    return null;
  }
  const output: EnvironmentEntry[] = [];
  for (const [name, entry] of Object.entries(processes)) {
    if (!(isRecord(entry) && isRecord(entry.environment))) {
      return null;
    }
    output.push({
      name,
      host: true,
      environment: entry.environment,
      pointer: `/host/processes/${escapePointer(name)}/environment`,
    });
  }
  return output;
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Detect additive capability intent in a normalized plan, without reading local documents. */
export function nativeEndpointPlanningRequired(
  plan: Readonly<Record<string, unknown>>
): boolean {
  if (Object.hasOwn(plan, "host_bindings")) {
    return true;
  }
  return (environmentEntries(plan) ?? []).some((entry) =>
    Object.values(entry.environment).some(
      (value) => isRecord(value) && Object.hasOwn(value, "endpoint")
    )
  );
}

function validReference(opts: {
  readonly reference: NativeEndpointReference;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly declared?: NativeDeclaredWorkloads;
  readonly resolution?: NativeHostBindingResolution;
  readonly resolved?: boolean;
}): boolean {
  const reference = opts.reference;
  if (reference.kind === "host_binding") {
    return (
      !opts.resolved ||
      (opts.resolution !== undefined &&
        Object.hasOwn(opts.resolution.bindings, reference.name))
    );
  }
  let service = reference.name;
  if (reference.kind === "route") {
    const routes = opts.plan.routes;
    const route =
      isRecord(routes) &&
      isRecord(routes.http) &&
      Object.hasOwn(routes.http, reference.name)
        ? routes.http[reference.name]
        : undefined;
    if (!(isRecord(route) && typeof route.service === "string")) {
      return false;
    }
    service = route.service;
  }
  return (
    opts.declared?.[service] === "service" &&
    isRecord(opts.plan.services) &&
    Object.hasOwn(opts.plan.services, service)
  );
}

/** Check normalized references and declarations, not the source-language policy. */
export function nativeEndpointPlanIsValid(opts: {
  readonly plan: Readonly<Record<string, unknown>>;
  readonly declared?: NativeDeclaredWorkloads;
  readonly resolution?: NativeHostBindingResolution;
  readonly resolved?: boolean;
}): boolean {
  const authoredBindings = opts.plan.host_bindings;
  if (authoredBindings !== undefined && !isRecord(authoredBindings)) {
    return false;
  }
  if (
    isRecord(authoredBindings) &&
    Object.entries(authoredBindings).some(
      ([name, value]) =>
        !(
          NAME.test(name) &&
          BINDING_NAME.test(name) &&
          parseNativeHostBindingTarget(value)
        )
    )
  ) {
    return false;
  }
  const entries = environmentEntries(opts.plan);
  if (!entries) {
    return !nativeEndpointPlanningRequired(opts.plan);
  }
  for (const entry of entries) {
    for (const [name, value] of Object.entries(entry.environment)) {
      if (!(isRecord(value) && Object.hasOwn(value, "endpoint"))) {
        continue;
      }
      const reference = parseNativeEndpointReference(value.endpoint);
      if (
        !(
          DESTINATION.test(name) &&
          only(value, ["endpoint"]) &&
          reference &&
          validReference({ ...opts, reference })
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

/** Reconcile report provenance and declared project entries without implementing merge precedence. */
export function nativeHostBindingResolutionMatches(opts: {
  readonly plan: Readonly<Record<string, unknown>>;
  readonly resolution?: NativeHostBindingResolution;
  readonly primaryLocal?: Uint8Array;
  readonly checkoutLocal?: Uint8Array;
  readonly inheritLocal: boolean;
}): boolean {
  const authored = opts.plan.host_bindings;
  const primary = bindingSource(opts.primaryLocal);
  const checkout = bindingSource(opts.checkoutLocal);
  if (primary === null || checkout === null) {
    return false;
  }
  const sources = {
    project: isRecord(authored) ? authored : undefined,
    primary_local: opts.inheritLocal ? primary : undefined,
    checkout_local: checkout,
  };
  const active = Object.values(sources).some((source) => source !== undefined);
  const resolution = opts.resolution;
  if (resolution === undefined) {
    return !active;
  }
  if (!active) {
    return false;
  }
  for (const [name, entry] of Object.entries(resolution.bindings)) {
    const source = sources[entry.origin];
    if (
      !(
        source &&
        Object.hasOwn(source, name) &&
        sameTarget(source[name], entry.target)
      )
    ) {
      return false;
    }
  }
  for (const [name, role] of Object.entries(resolution.removed)) {
    const source = sources[role];
    if (!(source && Object.hasOwn(source, name) && source[name] === null)) {
      return false;
    }
  }
  return Object.values(sources).every(
    (source) =>
      source === undefined ||
      Object.keys(source).every(
        (name) =>
          Object.hasOwn(resolution.bindings, name) ||
          Object.hasOwn(resolution.removed, name)
      )
  );
}

/** Cross-check only the claimed source member. Rust remains the document and merge authority. */
function bindingSource(
  input: Uint8Array | undefined
): Record<string, unknown> | null | undefined {
  if (input === undefined) {
    return undefined;
  }
  try {
    const document: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input)
    );
    if (!isRecord(document)) {
      return undefined;
    }
    if (!Object.hasOwn(document, "host_bindings")) {
      return undefined;
    }
    return isRecord(document.host_bindings) ? document.host_bindings : null;
  } catch {
    // The Rust owner validates the whole document; an unparseable projection cannot support a claim.
    return undefined;
  }
}

function sameTarget(
  left: unknown,
  right: NativeHostBindingTarget | NativeEndpointReference
): boolean {
  return (
    isRecord(left) &&
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(right).every(([key, value]) => left[key] === value)
  );
}

/** Bind emitted targets to the normalized reference and its existing resolver report. */
type EndpointEnvironmentInputs = {
  readonly plan: Readonly<Record<string, unknown>>;
  readonly declared: NativeDeclaredWorkloads;
  readonly environmentPlan: NativeEnvironmentPlan;
  readonly routing?: NativeRoutingResolution;
  readonly resolution?: NativeHostBindingResolution;
  readonly metadata: NativeEnvMetadata;
};

export function nativeEndpointEnvironmentMatches(
  opts: EndpointEnvironmentInputs
): boolean {
  const entries = environmentEntries(opts.plan);
  const reportedEndpoints = [
    ...Object.values(opts.environmentPlan.workloads),
    ...Object.values(opts.environmentPlan.host ?? {}).map(
      (entry) => entry.bindings
    ),
  ].some((bindings) =>
    Object.values(bindings).some((binding) => binding.kind === "endpoint")
  );
  const authoredEndpoints = (entries ?? []).some((entry) =>
    Object.values(entry.environment).some(
      (value) => isRecord(value) && Object.hasOwn(value, "endpoint")
    )
  );
  if (!(authoredEndpoints || reportedEndpoints)) {
    return true;
  }
  if (!entries) {
    return false;
  }
  for (const entry of entries) {
    const reports = entry.host
      ? opts.environmentPlan.host?.[entry.name]?.bindings
      : opts.environmentPlan.workloads[entry.name];
    if (!reports) {
      return false;
    }
    if (
      !(
        reportedEndpointsMatch({ ...opts, entry, reports }) &&
        endpointOmissionsMatch({ ...opts, entry, reports })
      )
    ) {
      return false;
    }
  }
  return true;
}

function reportedEndpointsMatch(
  opts: EndpointEnvironmentInputs & {
    readonly entry: EnvironmentEntry;
    readonly reports: Readonly<Record<string, NativeEnvBinding>>;
  }
): boolean {
  for (const [name, binding] of Object.entries(opts.reports)) {
    if (binding.kind !== "endpoint") {
      continue;
    }
    const authored = opts.entry.environment[name];
    if (
      !(
        isRecord(authored) &&
        only(authored, ["endpoint"]) &&
        sameTarget(authored.endpoint, binding.reference) &&
        validReference({
          ...opts,
          reference: binding.reference,
          resolved: true,
        }) &&
        endpointTargetMatches({ ...opts, binding, host: opts.entry.host })
      ) ||
      baselineMetadata({ ...opts, name }) !== undefined
    ) {
      return false;
    }
  }
  return true;
}

function endpointOmissionsMatch(
  opts: EndpointEnvironmentInputs & {
    readonly entry: EnvironmentEntry;
    readonly reports: Readonly<Record<string, NativeEnvBinding>>;
  }
): boolean {
  for (const [name, value] of Object.entries(opts.entry.environment)) {
    if (
      !(isRecord(value) && Object.hasOwn(value, "endpoint")) ||
      opts.reports[name]?.kind === "endpoint"
    ) {
      continue;
    }
    const reference = parseNativeEndpointReference(value.endpoint);
    if (!reference) {
      return false;
    }
    const pointer = `${opts.entry.pointer}/${escapePointer(name)}`;
    const diagnostic = opts.environmentPlan.diagnostics.find(
      (item) => item.document === "project" && item.pointer === pointer
    );
    if (
      diagnostic?.code === "unsupported_endpoint_context" &&
      opts.entry.host &&
      reference.kind === "service" &&
      !Object.hasOwn(opts.reports, name) &&
      baselineMetadata({ ...opts, name }) === undefined
    ) {
      continue;
    }
    if (
      diagnostic?.code !== "env_endpoint_collision" ||
      !collisionPreservesBaseline({ ...opts, name })
    ) {
      return false;
    }
  }
  return true;
}

function collisionPreservesBaseline(
  opts: EndpointEnvironmentInputs & {
    readonly entry: EnvironmentEntry;
    readonly reports: Readonly<Record<string, NativeEnvBinding>>;
    readonly name: string;
  }
): boolean {
  const baseline = baselineMetadata(opts);
  const binding = opts.reports[opts.name];
  return (
    baseline !== undefined &&
    binding?.kind === "managed" &&
    binding.key === opts.name &&
    binding.scope === baseline.scope &&
    binding.secret === baseline.secret
  );
}

function baselineMetadata(
  opts: EndpointEnvironmentInputs & {
    readonly entry: EnvironmentEntry;
    readonly name: string;
  }
): NativeManagedEntry | undefined {
  if (!opts.entry.host) {
    return Object.hasOwn(opts.metadata.workloads, opts.entry.name) &&
      Object.hasOwn(opts.metadata.workloads[opts.entry.name] ?? {}, opts.name)
      ? opts.metadata.workloads[opts.entry.name]?.[opts.name]
      : undefined;
  }
  const target = opts.environmentPlan.host?.[opts.entry.name]?.env_target;
  let entries: Readonly<Record<string, NativeManagedEntry>> | undefined;
  if (target?.kind === "host") {
    entries = opts.metadata.host?.default;
  } else if (target?.kind === "workload") {
    entries = opts.metadata.host?.workloads[target.name];
  }
  return entries && Object.hasOwn(entries, opts.name)
    ? entries[opts.name]
    : undefined;
}

function endpointTargetMatches(opts: {
  readonly binding: NativeEndpointBinding;
  readonly host: boolean;
  readonly routing?: NativeRoutingResolution;
  readonly resolution?: NativeHostBindingResolution;
}): boolean {
  const { reference, target } = opts.binding;
  if (reference.kind === "route") {
    return (
      target.kind === "route" &&
      opts.routing !== undefined &&
      Object.hasOwn(opts.routing.routes, reference.name) &&
      opts.routing?.routes[reference.name]?.origin === target.origin
    );
  }
  if (reference.kind === "service") {
    return (
      !opts.host && target.kind === "service" && sameTarget(reference, target)
    );
  }
  const resolved =
    opts.resolution !== undefined &&
    Object.hasOwn(opts.resolution.bindings, reference.name)
      ? opts.resolution.bindings[reference.name]?.target
      : undefined;
  if (resolved?.kind === "host") {
    return (
      target.kind === "host" &&
      target.context === (opts.host ? "host" : "workload") &&
      target.port === resolved.port &&
      target.protocol === resolved.protocol
    );
  }
  return (
    resolved?.kind === "external" &&
    target.kind === "external" &&
    sameTarget(resolved, target)
  );
}
