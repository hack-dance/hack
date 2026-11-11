/**
 * Shell references in a service's `environment`, resolved the way Compose
 * resolves them, for the native backend.
 *
 * Compose reads a variable reference and a bare `NAME` entry from the shell
 * that runs it. The native runtime deliberately consults no ambient
 * environment, so such an entry used to fail the start. This module resolves
 * the common whole-value forms in the CLI and hands each value to the private
 * delivery that Hack managed env already uses.
 *
 * Invariants:
 * - A value read from the shell is never written to the normalized Compose
 *   document, a plan, a receipt or a log. The entry becomes a bare reference
 *   (`null`) and the value travels only in the private delivery map.
 * - Only variables an entry references are read. Nothing else of the caller's
 *   environment is touched.
 * - A key Hack manages for the service is never taken from the shell, and a
 *   reference to a managed variable is left for the runtime, which refuses it.
 * - A service with no shell reference keeps its `environment` exactly as
 *   authored, list form included.
 *
 * Scope: an entry whose whole value is one reference. A reference inside a
 * longer string, or in any field other than `environment`, is not resolved
 * here; the runtime resolves its default or refuses it, as before.
 */

/** A valid environment variable name. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NAME_PATTERN = "[A-Za-z_][A-Za-z0-9_]*";
/** The whole value is one braced reference with no operator. */
const BRACED = new RegExp(`^\\$\\{(${NAME_PATTERN})\\}$`);
/** The whole value is one unbraced reference. */
const UNBRACED = new RegExp(`^\\$(${NAME_PATTERN})$`);
/**
 * The whole value is one reference with a literal default: the variable, the
 * `:-` operator and a word with no reference of its own.
 */
const DEFAULTED = new RegExp(`^\\$\\{(${NAME_PATTERN}):-[^$}]*\\}$`);
/**
 * One value can never exceed the runtime's whole private payload for a service
 * (`MAX_ENVIRONMENT_PAYLOAD`, 32 KiB). Refusing here names the variable; the
 * runtime's own refusal could not.
 */
export const MAX_SHELL_VALUE_BYTES = 32 * 1024;

export type ShellEnvironmentEntry =
  /** Deliver this value privately; the entry becomes a bare reference. */
  | {
      readonly kind: "deliver";
      readonly value: string;
      readonly unset?: string;
    }
  /** Leave the entry out, as Compose leaves a bare unset name unset. */
  | { readonly kind: "omit" }
  /** Not a shell reference this module resolves. */
  | { readonly kind: "keep" };

/**
 * How one `environment` entry resolves against the caller's shell.
 * `managed` holds the names Hack delivers for this service.
 */
export function resolveShellEnvironmentEntry(opts: {
  readonly value: unknown;
  readonly key: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly managed: ReadonlySet<string>;
}): ShellEnvironmentEntry {
  const { value, env } = opts;
  if (value === null) {
    // A bare `NAME`: pass the shell's value through, or leave it unset.
    const passed = env[opts.key];
    return passed === undefined
      ? { kind: "omit" }
      : { kind: "deliver", value: passed };
  }
  if (typeof value !== "string") {
    return { kind: "keep" };
  }
  const plain = BRACED.exec(value)?.[1] ?? UNBRACED.exec(value)?.[1];
  if (plain !== undefined) {
    if (opts.managed.has(plain)) {
      return { kind: "keep" };
    }
    const found = env[plain];
    // Compose substitutes an empty string for a variable that is not set.
    return found === undefined
      ? { kind: "deliver", value: "", unset: plain }
      : { kind: "deliver", value: found };
  }
  const defaulted = DEFAULTED.exec(value)?.[1];
  if (defaulted !== undefined && !opts.managed.has(defaulted)) {
    const found = env[defaulted];
    // Unset or empty selects the default, which the runtime resolves itself.
    if (found !== undefined && found !== "") {
      return { kind: "deliver", value: found };
    }
  }
  return { kind: "keep" };
}

export type ShellEnvironmentResolution = {
  /** The service's environment as a mapping, with delivered entries set to `null`. */
  readonly environment: Record<string, unknown>;
  /** Values to deliver privately, by variable name. Never log this map. */
  readonly delivered: Record<string, string>;
  /** Value-free notes for the user: names only. */
  readonly notices: string[];
  /** The variable whose shell value cannot be delivered, when one cannot. */
  readonly refused?: string;
};

/**
 * Resolves every shell reference of one service. Returns `null` when the
 * service has none, so the caller leaves its `environment` untouched.
 */
export function resolveShellEnvironment(opts: {
  readonly service: string;
  /** The service's environment as a mapping (`NAME` → value or `null`). */
  readonly environment: Readonly<Record<string, unknown>>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly managed: ReadonlySet<string>;
}): ShellEnvironmentResolution | null {
  const environment: Record<string, unknown> = {};
  const delivered: Record<string, string> = {};
  const notices: string[] = [];
  let changed = false;
  for (const [key, value] of Object.entries(opts.environment)) {
    // A key Hack manages is delivered from managed env; the shell never overrides it.
    const entry: ShellEnvironmentEntry =
      opts.managed.has(key) || !NAME.test(key)
        ? { kind: "keep" }
        : resolveShellEnvironmentEntry({ ...opts, value, key });
    if (entry.kind === "keep") {
      environment[key] = value;
      continue;
    }
    changed = true;
    if (entry.kind === "omit") {
      continue;
    }
    if (
      entry.value.includes("\0") ||
      Buffer.byteLength(entry.value) > MAX_SHELL_VALUE_BYTES
    ) {
      return {
        environment,
        delivered,
        notices,
        refused: value === null ? key : (shellVariable(value) ?? key),
      };
    }
    environment[key] = null;
    delivered[key] = entry.value;
    if (entry.unset !== undefined) {
      notices.push(
        `Service ${opts.service}: ${key} is empty because ${entry.unset} is not set in your shell.`
      );
    }
  }
  return changed ? { environment, delivered, notices } : null;
}

/** The variable a whole-value reference names, for a refusal that names it. */
function shellVariable(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return;
  }
  return (
    BRACED.exec(value)?.[1] ??
    UNBRACED.exec(value)?.[1] ??
    DEFAULTED.exec(value)?.[1]
  );
}
