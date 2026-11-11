import { COMPOSE_PROJECT_NAME_VARIABLE } from "./native-compose-project-name.ts";

/**
 * Shell references in a service's `environment`, resolved the way Compose
 * resolves them, for the native backend.
 *
 * Compose reads a variable reference and a bare `NAME` entry from the shell
 * that runs it. The native runtime deliberately consults no ambient
 * environment, so such an entry used to fail the start. This module resolves
 * the two forms that could never start, in the CLI, and hands each value to
 * the private delivery that Hack managed env already uses.
 *
 * Invariants:
 * - A value read from the shell is never written to the normalized Compose
 *   document, a plan, a receipt, an env fingerprint or a log. The entry
 *   becomes a bare reference (`null`) and the value travels only in the
 *   private delivery.
 * - The reviewed document does not depend on the shell: a resolved entry is
 *   always a bare reference, whether or not the variable is set. So a start
 *   from another shell reviews the same plan.
 * - Only variables an entry references are read, and only own string
 *   properties of the environment.
 * - Nothing that starts today changes. A reference with a default, an
 *   alternative or an error operator is left to the runtime, as before.
 * - A key Hack manages for the service is never taken from the shell, and a
 *   reference to a managed variable is left for the runtime, which refuses it.
 * - A name the runtime supplies itself, Hack's own `HACK_*` variables and the
 *   cloud credential names the scoped adapters own are never read from the
 *   shell.
 *
 * Scope: an entry whose whole value is one plain reference, or a bare name.
 * A reference inside a longer string, or in any field other than
 * `environment`, is not resolved here.
 */

/** A valid environment variable name. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** The whole value is one braced reference with no operator. */
const BRACED = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
/** The whole value is one unbraced reference. */
const UNBRACED = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

/**
 * Names the native runtime binds itself during review. Taking one from the
 * shell would give a service another instance's value and remove the
 * reference the runtime looks for.
 */
const RUNTIME_SUPPLIED_NAMES: ReadonlySet<string> = new Set([
  COMPOSE_PROJECT_NAME_VARIABLE,
]);

/**
 * Name prefixes that are never read from the shell. Such an entry is left as
 * written, so it fails the start as it did before.
 *
 * - `HACK_`: Hack's own settings and credentials. `HACK_ENV_SECRET_KEY`
 *   decrypts every managed secret of a project, and a Compose file from the
 *   repository must not be able to copy it into a container. The runtime also
 *   owns the `HACK_*` keys it gives services as metadata.
 * - `AWS_`, `GOOGLE_`, `CLOUDSDK_`: cloud credential and selector names.
 *   Long-lived shell credentials are not copied into containers; the AWS and
 *   gcloud adapters deliver scoped ones (see the native guide). This also
 *   covers non-secret names under these prefixes, such as `AWS_REGION`.
 */
const UNREADABLE_NAME_PREFIXES = [
  "HACK_",
  "AWS_",
  "GOOGLE_",
  "CLOUDSDK_",
] as const;

/** Whether `name` may be read from the caller's shell. */
export function shellVariableReadable(name: string): boolean {
  return !(
    RUNTIME_SUPPLIED_NAMES.has(name) ||
    UNREADABLE_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** The shell's own string value for `name`, never an inherited property. */
function shellValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined {
  if (!Object.hasOwn(env, name)) {
    return;
  }
  const value = env[name];
  return typeof value === "string" ? value : undefined;
}

/** The variable an entry reads from the shell, or nothing when it reads none. */
export function shellReference(opts: {
  readonly key: string;
  readonly value: unknown;
  /** Names Hack delivers for this service. */
  readonly managed: ReadonlySet<string>;
}): string | undefined {
  if (opts.managed.has(opts.key) || !NAME.test(opts.key)) {
    return;
  }
  let name: string | undefined;
  if (opts.value === null) {
    // A bare `NAME`: pass the shell's value through.
    name = opts.key;
  } else if (typeof opts.value === "string") {
    name = BRACED.exec(opts.value)?.[1] ?? UNBRACED.exec(opts.value)?.[1];
  }
  if (name === undefined || opts.managed.has(name)) {
    return;
  }
  // The entry's own key is checked too: it is the name that gets delivered.
  return shellVariableReadable(name) && shellVariableReadable(opts.key)
    ? name
    : undefined;
}

export type ShellEnvironmentResolution = {
  /** The service's environment as a mapping, with resolved entries set to `null`. */
  readonly environment: Record<string, unknown>;
  /** Values to deliver privately, by variable name. Never log this map. */
  readonly delivered: Record<string, string>;
  /** Value-free notes for the user: names only. */
  readonly notices: string[];
  /** Source names actually present in the caller's environment; never values. */
  readonly forwardedNames: readonly string[];
};

/**
 * Resolves every shell reference of one service. Returns `null` when the
 * service has none, so the caller leaves its `environment` untouched.
 *
 * A referenced variable the shell does not set is delivered as an empty
 * value, with a notice that names it. Compose substitutes an empty string for
 * an unset reference; for a bare name Compose leaves the variable unset in the
 * container, and native delivers it empty instead so the reviewed document
 * stays the same from one shell to the next.
 */
export function resolveShellEnvironment(opts: {
  readonly service: string;
  /** The service's environment as a mapping (`NAME` → value or `null`). */
  readonly environment: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly managed: ReadonlySet<string>;
}): ShellEnvironmentResolution | null {
  // Null-prototype maps: `__proto__` is a valid variable name.
  const environment: Record<string, unknown> = Object.create(null);
  const delivered: Record<string, string> = Object.create(null);
  const notices: string[] = [];
  const forwardedNames = new Set<string>();
  let changed = false;
  for (const [key, value] of Object.entries(opts.environment)) {
    const name = shellReference({ key, value, managed: opts.managed });
    if (name === undefined) {
      environment[key] = value;
      continue;
    }
    changed = true;
    const found =
      opts.env === undefined ? undefined : shellValue(opts.env, name);
    environment[key] = null;
    delivered[key] = found ?? "";
    if (found !== undefined) {
      forwardedNames.add(name);
    }
    if (found === undefined) {
      notices.push(
        name === key
          ? `Service ${opts.service}: ${key} is empty because it is not set in your shell.`
          : `Service ${opts.service}: ${key} is empty because ${name} is not set in your shell.`
      );
    }
  }
  return changed
    ? {
        environment,
        delivered,
        notices,
        forwardedNames: [...forwardedNames].sort(),
      }
    : null;
}

/** The runtime's limits on one service's private delivery (`provider/environment.rs`). */
const MAX_SERVICE_PAYLOAD_BYTES = 32 * 1024;
const MAX_SERVICE_KEYS = 256;
const MAX_PRIVATE_SERVICES = 32;

/**
 * Why the runtime would refuse this private delivery, checked here so the
 * refusal can name the service; the runtime's own refusal cannot. `null`
 * when it fits. Values are measured as the runtime receives them, JSON-escaped.
 */
export function shellDeliveryProblem(opts: {
  /** The merged private values of each service that has any. */
  readonly services: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * Services that received a value from the shell; only these are reported.
   * Pass only services that will run: the runtime receives nothing for a
   * service the selected profiles leave out.
   */
  readonly fromShell: ReadonlySet<string>;
}):
  | { readonly kind: "value" | "size" | "keys"; readonly service: string }
  | { readonly kind: "services" }
  | null {
  for (const service of [...opts.fromShell].sort()) {
    const values = opts.services[service] ?? {};
    if (Object.values(values).some((value) => value.includes("\0"))) {
      return { kind: "value", service };
    }
    if (Object.keys(values).length > MAX_SERVICE_KEYS) {
      return { kind: "keys", service };
    }
    if (Buffer.byteLength(JSON.stringify(values)) > MAX_SERVICE_PAYLOAD_BYTES) {
      return { kind: "size", service };
    }
  }
  return opts.fromShell.size > 0 &&
    Object.keys(opts.services).length > MAX_PRIVATE_SERVICES
    ? { kind: "services" }
    : null;
}
