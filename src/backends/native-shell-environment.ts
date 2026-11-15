import { HACK_KEY_MATERIAL_VARIABLES } from "../lib/child-environment.ts";
import { COMPOSE_PROJECT_NAME_VARIABLE } from "./native-compose-project-name.ts";

/** Shell source-name policy and private delivery limits. Resolution, including
 * dotenv and unset semantics, is owned by native-compose-environment.ts.
 * Values never enter this module except to measure a private delivery.
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
    HACK_KEY_MATERIAL_VARIABLES.has(name) ||
    RUNTIME_SUPPLIED_NAMES.has(name) ||
    UNREADABLE_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
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
