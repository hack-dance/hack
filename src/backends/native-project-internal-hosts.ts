import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { resolveInternalExtraHosts } from "../lib/internal-extra-hosts.ts";
import {
  type ProjectConfig,
  type ProjectContext,
  readProjectConfig,
} from "../lib/project.ts";
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
const SEPARATOR = /[:=]/;
const MAX_ALIASES = 32;

/** Fixed text when a declared host alias has no reviewed dependency binding. */
export const NATIVE_UNBOUND_HOST_ALIAS_REFUSAL =
  "Native host alias has no reviewed host dependency binding; configuration was not dropped. Select a host dependency binding for every service that declares the alias.";

/** Fixed text when a project-wide host alias cannot be expressed natively. */
export const NATIVE_INTERNAL_HOST_ALIAS_REFUSAL =
  "Native up supports internal extra_hosts only as exact host-gateway aliases with reviewed host dependency bindings; configuration was not dropped.";

function unbound(): Error {
  return new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message: NATIVE_UNBOUND_HOST_ALIAS_REFUSAL,
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
    message:
      "Native host alias selection conflicts with declared configuration; values omitted.",
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

/**
 * Split one Compose `extra_hosts` value into (name, target) pairs, using the
 * first `:` or `=` like the native review does. Returns undefined for a shape
 * native review would refuse; callers leave that refusal to review.
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
    const match = SEPARATOR.exec(entry);
    if (!match) {
      return undefined;
    }
    entries.push([entry.slice(0, match.index), entry.slice(match.index + 1)]);
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

function declareOnService(
  service: Record<string, unknown>,
  aliases: readonly string[]
): void {
  const entries = extraHostEntries(service.extra_hosts);
  if (!entries) {
    throw conflict();
  }
  const declared = new Map<string, string>();
  for (const [name, target] of entries) {
    declared.set(name, target);
  }
  const added: string[] = [];
  for (const alias of aliases) {
    const target = declared.get(alias);
    if (target === undefined) {
      added.push(alias);
    } else if (target !== "host-gateway") {
      throw conflict();
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
  readonly hasDependencySelection: boolean;
}): NativeProjectInput {
  if (opts.hosts === undefined || Object.keys(opts.hosts).length === 0) {
    return opts.input;
  }
  const aliases = internalAliasNames(opts.hosts);
  if (!opts.hasDependencySelection) {
    throw unbound();
  }
  const compose: unknown = JSON.parse(opts.input.normalizedComposeJson);
  if (!(isRecord(compose) && isRecord(compose.services))) {
    throw conflict();
  }
  for (const service of Object.values(compose.services)) {
    if (!isRecord(service)) {
      throw conflict();
    }
    declareOnService(service, aliases);
  }
  return { ...opts.input, normalizedComposeJson: JSON.stringify(compose) };
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
 * The exact `host-gateway` aliases each profile-active service declares,
 * keyed by service. Inactive services are never scheduled and receive no
 * bindings, so they need none. Malformed declarations are left to review.
 */
export function nativeServiceHostAliases(opts: {
  readonly services: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  readonly profiles: readonly string[];
}): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [name, spec] of Object.entries(opts.services)) {
    if (!activeService(spec, opts.profiles)) {
      continue;
    }
    const aliases = (extraHostEntries(spec.extra_hosts) ?? [])
      .filter(([, target]) => target === "host-gateway")
      .map(([alias]) => alias);
    Object.defineProperty(result, name, {
      value: aliases,
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
 * exact equality as well; this refuses earlier, before runtime effects, with
 * a value-free line.
 */
export function requireNativeHostAliasBindings(opts: {
  readonly dependencies: readonly NativeHostDependency[];
  readonly hostAliases: Readonly<Record<string, readonly string[]>>;
}): void {
  const bound = new Set(
    opts.dependencies.flatMap((dependency) =>
      dependency.aliases.map((alias) => `${dependency.service}\0${alias}`)
    )
  );
  for (const [service, aliases] of Object.entries(opts.hostAliases)) {
    for (const alias of aliases) {
      if (!bound.has(`${service}\0${alias}`)) {
        throw unbound();
      }
    }
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
  try {
    const cfg = opts.cfg ?? (await readProjectConfig(opts.project));
    if (cfg.parseError) {
      throw new Error("invalid project configuration");
    }
    return (
      await resolveInternalExtraHosts({
        projectRoot: opts.project.projectRoot,
        projectDir: opts.project.projectDir,
        staticHosts: cfg.internal?.extraHosts,
      })
    ).hosts;
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
