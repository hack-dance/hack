import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import {
  resolveExtraHostsPath,
  resolveInternalExtraHosts,
} from "../lib/internal-extra-hosts.ts";
import {
  type ProjectConfig,
  type ProjectContext,
  readProjectConfig,
} from "../lib/project.ts";
import { resolveNativeComposeText } from "./native-compose-interpolation.ts";
import type { NativeHostDependency } from "./native-project-dependencies.ts";
import type { NativeProjectInput } from "./native-project-input.ts";

/**
 * Project-wide host aliases (`internal.extra_hosts` plus checkout-local
 * `hack internal extra-hosts` entries) on the native backend.
 *
 * The Compose backend renders every entry into every service. Native has no
 * general host gateway: a `host-gateway` alias only resolves through a pinned
 * host dependency binding. Native therefore declares every entry on every
 * service, exactly as Compose does, and then requires a reviewed binding for
 * each active (service, alias) pair. An entry that native cannot honor is
 * refused instead of being dropped, because a dropped alias would let a
 * container resolve the public name and reach a different host.
 */

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const NUMERIC_HOST = /^[0-9.]+$/;
const MAX_ALIASES = 32;

/** Leading text when a declared host alias has no reviewed dependency binding. */
export const NATIVE_UNBOUND_HOST_ALIAS_REFUSAL =
  "Native host alias has no reviewed host dependency binding; configuration was not dropped.";

/** Fixed text when a project-wide host alias cannot be expressed natively. */
export const NATIVE_INTERNAL_HOST_ALIAS_REFUSAL =
  "Native up supports internal extra_hosts only as exact host-gateway aliases with reviewed host dependency bindings; configuration was not dropped.";

/** Leading text when a service's declared host aliases cannot be compiled natively. */
export const NATIVE_HOST_ALIAS_CONFLICT_REFUSAL =
  "Native host alias selection conflicts with declared configuration";

/**
 * Where a project-wide alias comes from, so a refusal can point at the file to
 * change. `inherited` is the main checkout's checkout-local map, which a linked
 * worktree inherits unless it hides the entry.
 */
export type NativeHostAliasSource = "project" | "checkout" | "inherited";

const PRINTABLE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Compose service names are printed only in their validated form. */
function serviceLabel(name: string): string {
  return PRINTABLE_SERVICE.test(name) ? `service ${name}` : "a service";
}

function describeSource(source: NativeHostAliasSource | undefined): string {
  switch (source) {
    case "project":
      return "internal.extra_hosts in the project configuration";
    case "checkout":
      return "this checkout's .hack/.internal/extra-hosts.json";
    case "inherited":
      return "the main checkout's .hack/.internal/extra-hosts.json, which this linked worktree inherits";
    default:
      return "the service's Compose extra_hosts";
  }
}

function removalHint(
  alias: string,
  source: NativeHostAliasSource | undefined
): string {
  switch (source) {
    case "project":
      return `remove ${alias} from internal.extra_hosts in the project configuration`;
    case "checkout":
      return `run \`hack internal extra-hosts unset ${alias}\``;
    case "inherited":
      return `run \`hack internal extra-hosts unset ${alias}\` in this worktree to stop inheriting it`;
    default:
      return `remove ${alias} from the service's extra_hosts`;
  }
}

type UnboundAlias = {
  readonly alias: string;
  readonly services: readonly string[];
  readonly source: NativeHostAliasSource | undefined;
};

/** At most this many aliases are listed; the rest are counted. */
const MAX_LISTED = 8;

/**
 * Name every unbound (service, alias) pair, where each alias comes from, and
 * the binding that would admit it. Aliases are validated DNS names and service
 * names are printed only when they match Compose's name rule, so the line
 * carries configuration names only: never targets, ports or listener values.
 */
function unbound(missing: readonly UnboundAlias[]): Error {
  const listed = missing
    .slice(0, MAX_LISTED)
    .map(
      (entry) =>
        `${entry.alias} for ${entry.services.map(serviceLabel).join(", ")} (from ${describeSource(entry.source)})`
    );
  const more =
    missing.length > MAX_LISTED
      ? `; and ${missing.length - MAX_LISTED} more aliases`
      : "";
  const first = missing[0];
  const aliases = JSON.stringify(
    missing.slice(0, MAX_LISTED).map((entry) => entry.alias)
  );
  const hint = first
    ? ` Add a binding with "aliases": ${aliases} to the HACK_NATIVE_DEPENDENCIES selection (a version 2 entry without "services" applies to every service that declares them), or ${removalHint(first.alias, first.source)}.`
    : "";
  return new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message: `${NATIVE_UNBOUND_HOST_ALIAS_REFUSAL} Unbound: ${listed.join("; ")}${more}.${hint}`,
  });
}
function unsupported(): Error {
  return new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message: NATIVE_INTERNAL_HOST_ALIAS_REFUSAL,
  });
}
function conflict(): Error {
  return new HackCliError({
    code: "E_CONFIG_INVALID",
    message: `${NATIVE_HOST_ALIAS_CONFLICT_REFUSAL}; values omitted.`,
  });
}
/** A target other than `host-gateway` for a project-wide alias; the target is omitted. */
function conflictingTarget(service: string, alias: string): Error {
  return new HackCliError({
    code: "E_CONFIG_INVALID",
    message: `${NATIVE_HOST_ALIAS_CONFLICT_REFUSAL}: ${serviceLabel(service)} maps project-wide host alias ${alias} to another target; native supports only host-gateway for it. Target value omitted.`,
  });
}
/** Two declarations compile to one runtime alias, which native execution refuses. */
function duplicateAlias(service: string, alias: string): Error {
  return new HackCliError({
    code: "E_CONFIG_INVALID",
    message: `${NATIVE_HOST_ALIAS_CONFLICT_REFUSAL}: ${serviceLabel(service)} declares host alias ${alias} more than once after Compose interpolation and name normalization; keep one declaration. Nothing was started.`,
  });
}

/** Same exact-name rule native dependency selections apply to aliases. */
function exactAlias(value: string): boolean {
  return (
    value.length <= 253 &&
    value !== "localhost" &&
    !value.endsWith(".localhost") &&
    value !== "localhost.localdomain" &&
    !NUMERIC_HOST.test(value) &&
    value.split(".").every((label) => LABEL.test(label))
  );
}

const ASCII = /^[\x20-\x7e]*$/;

/**
 * The name native review compiles a resolved extra host name to, with the
 * runtime's `normalize_hostname` semantics: strip one trailing dot, lowercase
 * ASCII, and require an exact DNS name (not an address). Returns null for a
 * name this check cannot canonicalize; native admission still enforces exact
 * alias and binding equality for those.
 */
function canonicalHostName(value: string): string | null {
  if (!ASCII.test(value)) {
    return null;
  }
  const name = (value.endsWith(".") ? value.slice(0, -1) : value).toLowerCase();
  if (
    name.length === 0 ||
    name.length > 253 ||
    NUMERIC_HOST.test(name) ||
    !name.split(".").every((label) => LABEL.test(label))
  ) {
    return null;
  }
  return name;
}

/**
 * The runtime alias one declared `extra_hosts` entry compiles to: Compose
 * interpolation as native execution resolves it (see
 * {@link resolveNativeComposeText}), then name canonicalization. Null when
 * the value is not knowable before execution or is not an exact DNS name.
 */
function compiledHostName(
  value: string,
  managed: ReadonlySet<string>
): string | null {
  const resolved = resolveNativeComposeText({ text: value, managed });
  return resolved === null ? null : canonicalHostName(resolved);
}

/** A declared target as native execution resolves it; null when unknown. */
function compiledTarget(
  value: string,
  managed: ReadonlySet<string>
): string | null {
  return resolveNativeComposeText({ text: value, managed });
}

/**
 * The (compiled name, compiled target) of each declaration that resolves
 * before execution, refusing a service that declares one alias twice: the
 * runtime refuses that only after the VM boots. Unknown declarations are left
 * to review and execution, keyed by their literal text.
 */
function compiledEntries(opts: {
  readonly service: string;
  readonly entries: readonly (readonly [string, string])[];
  readonly managed: ReadonlySet<string>;
}): Map<string, string | null> {
  const declared = new Map<string, string | null>();
  for (const [name, target] of opts.entries) {
    const compiled = compiledHostName(name, opts.managed);
    if (compiled !== null && declared.has(compiled)) {
      throw duplicateAlias(opts.service, compiled);
    }
    declared.set(compiled ?? name, compiledTarget(target, opts.managed));
  }
  return declared;
}

function managedNames(
  managedEnvironment:
    | Readonly<Record<string, Readonly<Record<string, string>>>>
    | undefined,
  service: string
): ReadonlySet<string> {
  const values = managedEnvironment
    ? Object.getOwnPropertyDescriptor(managedEnvironment, service)?.value
    : undefined;
  return new Set(isRecord(values) ? Object.keys(values) : []);
}

/**
 * The first `:` or `=` outside `{...}`, exactly as native review splits a list
 * entry, so the `:` of an interpolation such as `${PREFIX:+x-}` stays in the
 * name. -1 when there is none.
 */
function separatorIndex(entry: string): number {
  let depth = 0;
  for (let index = 0; index < entry.length; index += 1) {
    const c = entry[index];
    if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth = Math.max(0, depth - 1);
    } else if ((c === ":" || c === "=") && depth === 0) {
      return index;
    }
  }
  return -1;
}

/**
 * Split one Compose `extra_hosts` value into (name, target) pairs, using the
 * first `:` or `=` outside braces like the native review does. Returns
 * undefined for a shape native review would refuse; callers leave that
 * refusal to review.
 */
function extraHostEntries(
  value: unknown
): (readonly [string, string])[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (isRecord(value)) {
    const entries: (readonly [string, string])[] = [];
    for (const [name, target] of Object.entries(value)) {
      if (typeof target !== "string") {
        return undefined;
      }
      entries.push([name, target]);
    }
    return entries;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries: (readonly [string, string])[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return undefined;
    }
    const index = separatorIndex(entry);
    if (index < 0) {
      return undefined;
    }
    entries.push([entry.slice(0, index), entry.slice(index + 1)]);
  }
  return entries;
}

/** Validate project-wide aliases before any service is changed. */
function internalAliasNames(hosts: Readonly<Record<string, string>>): string[] {
  const names = Object.keys(hosts);
  if (names.length > MAX_ALIASES) {
    throw unsupported();
  }
  for (const name of names) {
    if (hosts[name] !== "host-gateway" || !exactAlias(name)) {
      throw unsupported();
    }
  }
  return names.sort();
}

function declareOnService(opts: {
  readonly name: string;
  readonly service: Record<string, unknown>;
  readonly aliases: readonly string[];
  readonly managed: ReadonlySet<string>;
}): void {
  const { service, aliases } = opts;
  const entries = extraHostEntries(service.extra_hosts);
  if (!entries) {
    throw conflict();
  }
  // Compare by the compiled name: `API.Example.` and `api.example` are one
  // runtime alias, and so is `${UNSET:+x-}api.example` once execution
  // resolves it; adding a second spelling would duplicate the alias.
  const declared = compiledEntries({
    service: opts.name,
    entries,
    managed: opts.managed,
  });
  const added: string[] = [];
  for (const alias of aliases) {
    if (!declared.has(alias)) {
      added.push(alias);
    } else if (declared.get(alias) !== "host-gateway") {
      throw conflictingTarget(opts.name, alias);
    }
  }
  if (added.length === 0) {
    return;
  }
  if (entries.length + added.length > MAX_ALIASES) {
    throw conflict();
  }
  if (isRecord(service.extra_hosts)) {
    const map: Record<string, unknown> = { ...service.extra_hosts };
    for (const alias of added) {
      Object.defineProperty(map, alias, {
        value: "host-gateway",
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    service.extra_hosts = map;
    return;
  }
  service.extra_hosts = [
    ...((service.extra_hosts as unknown[] | undefined) ?? []),
    ...added.map((alias) => `${alias}:host-gateway`),
  ];
}

/**
 * Declare the effective project-wide aliases on every service of the public
 * normalized Compose, as the Compose backend's internal override does.
 * Declarations grant nothing: each active pair still needs a pinned binding,
 * which {@link requireNativeHostAliasBindings} checks after lifecycle hooks.
 * With no dependency selection at all, refuse here, before hooks or runtime
 * work. An empty map leaves the input byte-identical.
 */
export function applyNativeInternalHostAliases(opts: {
  readonly input: NativeProjectInput;
  readonly hosts?: Readonly<Record<string, string>>;
  /** Where each project-wide alias comes from, for refusal text only. */
  readonly sources?: Readonly<Record<string, NativeHostAliasSource>>;
  readonly hasDependencySelection: boolean;
}): NativeProjectInput {
  if (opts.hosts === undefined || Object.keys(opts.hosts).length === 0) {
    return opts.input;
  }
  const aliases = internalAliasNames(opts.hosts);
  const compose: unknown = JSON.parse(opts.input.normalizedComposeJson);
  if (!(isRecord(compose) && isRecord(compose.services))) {
    throw conflict();
  }
  if (!opts.hasDependencySelection) {
    const services = Object.keys(compose.services).sort();
    throw unbound(
      aliases.map((alias) => ({
        alias,
        services,
        source: sourceOf(opts.sources, alias),
      }))
    );
  }
  for (const [name, service] of Object.entries(compose.services)) {
    if (!isRecord(service)) {
      throw conflict();
    }
    declareOnService({
      name,
      service,
      aliases,
      managed: managedNames(opts.input.managedEnvironment, name),
    });
  }
  return { ...opts.input, normalizedComposeJson: JSON.stringify(compose) };
}

function sourceOf(
  sources: Readonly<Record<string, NativeHostAliasSource>> | undefined,
  alias: string
): NativeHostAliasSource | undefined {
  const value: unknown = sources
    ? Object.getOwnPropertyDescriptor(sources, alias)?.value
    : undefined;
  return value === "project" || value === "checkout" || value === "inherited"
    ? value
    : undefined;
}

function activeService(
  spec: Readonly<Record<string, unknown>>,
  profiles: readonly string[]
): boolean {
  const declared = spec.profiles;
  if (declared === undefined) {
    return true;
  }
  return (
    Array.isArray(declared) &&
    (declared.length === 0 ||
      declared.some(
        (profile) => typeof profile === "string" && profiles.includes(profile)
      ))
  );
}

/**
 * The `host-gateway` aliases each profile-active service declares, keyed by
 * service, in the form native execution compiles them to: Compose
 * interpolation resolved as the runtime resolves it, then canonicalized (see
 * {@link compiledHostName}), so a declared `API.Example.` or
 * `${UNSET:-api.example}` matches a binding for `api.example`. A service that
 * declares one alias twice refuses here, before any runtime work. Inactive
 * services are never scheduled and receive no bindings, so they need none.
 * Malformed or not-yet-knowable declarations are left to review and admission.
 */
export function nativeServiceHostAliases(opts: {
  readonly services: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly profiles: readonly string[];
  /** Names delivered privately per service; references to them are unknown. */
  readonly managedEnvironment?: Readonly<
    Record<string, Readonly<Record<string, string>>>
  >;
}): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [name, spec] of Object.entries(opts.services)) {
    if (!activeService(spec, opts.profiles)) {
      continue;
    }
    const aliases = new Set<string>();
    const entries = extraHostEntries(spec.extra_hosts) ?? [];
    const managed = managedNames(opts.managedEnvironment, name);
    const declared = compiledEntries({ service: name, entries, managed });
    for (const [alias, target] of declared) {
      const canonical = canonicalHostName(alias);
      if (target === "host-gateway" && canonical === alias) {
        aliases.add(canonical);
      }
    }
    Object.defineProperty(result, name, {
      value: [...aliases],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

/**
 * Fail closed when an active service declares a host-gateway alias that no
 * selected binding of that service covers. Native admission later enforces
 * exact equality as well; this refuses earlier, before runtime effects. The
 * refusal names every unbound (service, alias) pair and where each alias
 * comes from, but never listener values.
 */
export function requireNativeHostAliasBindings(opts: {
  readonly dependencies: readonly NativeHostDependency[];
  readonly hostAliases: Readonly<Record<string, readonly string[]>>;
  /** Where each project-wide alias comes from, for refusal text only. */
  readonly sources?: Readonly<Record<string, NativeHostAliasSource>>;
}): void {
  const bound = new Set(
    opts.dependencies.flatMap((dependency) =>
      dependency.aliases.map((alias) => `${dependency.service}\0${alias}`)
    )
  );
  const missing = new Map<string, string[]>();
  for (const [service, aliases] of Object.entries(opts.hostAliases)) {
    for (const alias of aliases) {
      if (!bound.has(`${service}\0${alias}`)) {
        missing.set(alias, [...(missing.get(alias) ?? []), service]);
      }
    }
  }
  if (missing.size > 0) {
    throw unbound(
      [...missing.keys()].sort().map((alias) => ({
        alias,
        services: (missing.get(alias) ?? []).sort(),
        source: sourceOf(opts.sources, alias),
      }))
    );
  }
}

/** Fixed text when lifecycle hooks changed project-wide aliases after review input. */
export const NATIVE_INTERNAL_HOSTS_CHANGED_REFUSAL =
  "Native up cannot apply internal extra_hosts changed by lifecycle hooks; nothing was started. Run the command again.";

function sameHosts(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>
): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && right[key] === left[key])
  );
}

/** Fixed text when native up cannot read its project-wide alias inputs. */
export const NATIVE_INTERNAL_HOSTS_UNREADABLE_REFUSAL =
  "Native up requires a readable internal extra_hosts selection; values omitted.";

/**
 * The same project-wide aliases the Compose override renders (static
 * `internal.extra_hosts` plus checkout-local entries), for native start.
 *
 * Without `cfg`, project configuration is read and validated again, so a
 * caller that runs after lifecycle hooks observes what the hooks left behind.
 * Invalid configuration or an unreadable local map refuses with a closed line
 * instead of being skipped.
 */
export async function resolveNativeInternalExtraHosts(opts: {
  readonly project: ProjectContext;
  readonly cfg?: ProjectConfig;
}): Promise<Record<string, string>> {
  return (await resolveNativeInternalExtraHostSelection(opts)).hosts;
}

/**
 * {@link resolveNativeInternalExtraHosts} plus where each effective alias
 * comes from: `internal.extra_hosts` in project configuration, this
 * checkout's local map, or the main checkout's local map a linked worktree
 * inherits. Sources are used only to explain refusals.
 */
export async function resolveNativeInternalExtraHostSelection(opts: {
  readonly project: ProjectContext;
  readonly cfg?: ProjectConfig;
}): Promise<{
  readonly hosts: Record<string, string>;
  readonly sources: Record<string, NativeHostAliasSource>;
}> {
  try {
    const cfg = opts.cfg ?? (await readProjectConfig(opts.project));
    if (cfg.parseError) {
      throw new Error("invalid project configuration");
    }
    const resolved = await resolveInternalExtraHosts({
      projectRoot: opts.project.projectRoot,
      projectDir: opts.project.projectDir,
      staticHosts: cfg.internal?.extraHosts,
    });
    const local = resolveExtraHostsPath(opts.project.projectDir);
    const sources: Record<string, NativeHostAliasSource> = {};
    for (const [alias, origin] of Object.entries(resolved.origins)) {
      let source: NativeHostAliasSource = "inherited";
      if (origin === "internal.extra_hosts") {
        source = "project";
      } else if (origin === local) {
        source = "checkout";
      }
      Object.defineProperty(sources, alias, {
        value: source,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { hosts: resolved.hosts, sources };
  } catch {
    throw new HackCliError({
      code: "E_CONFIG_INVALID",
      message: NATIVE_INTERNAL_HOSTS_UNREADABLE_REFUSAL,
    });
  }
}

/**
 * The Compose backend re-reads project-wide aliases after `up.before` hooks.
 * Native declares them before review, so a hook that changes them refuses
 * (after its cleanup) instead of starting with stale or dropped aliases.
 */
export async function requireNativeInternalExtraHostsUnchanged(opts: {
  readonly reviewed: Readonly<Record<string, string>>;
  readonly current: () => Promise<Readonly<Record<string, string>>>;
  readonly cleanup: () => Promise<void>;
}): Promise<void> {
  let current: Readonly<Record<string, string>> | undefined;
  try {
    current = await opts.current();
  } catch {
    current = undefined;
  }
  if (current !== undefined && sameHosts(opts.reviewed, current)) {
    return;
  }
  await opts.cleanup();
  throw new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message: NATIVE_INTERNAL_HOSTS_CHANGED_REFUSAL,
  });
}

/**
 * Post-hook form of {@link requireNativeInternalExtraHostsUnchanged} for a
 * project checkout: re-reads project configuration and the checkout-local
 * alias maps, so an `up.before` hook that edits either refuses after cleanup.
 * It deliberately takes no configuration snapshot.
 */
export async function requireNativeProjectInternalExtraHostsUnchanged(opts: {
  readonly project: ProjectContext;
  readonly reviewed: Readonly<Record<string, string>>;
  readonly cleanup: () => Promise<void>;
}): Promise<void> {
  await requireNativeInternalExtraHostsUnchanged({
    reviewed: opts.reviewed,
    current: async () =>
      await resolveNativeInternalExtraHosts({ project: opts.project }),
    cleanup: opts.cleanup,
  });
}
