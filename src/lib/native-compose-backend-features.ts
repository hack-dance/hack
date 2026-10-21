import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { HackCliError } from "./cli-result.ts";
import { isRecord } from "./guards.ts";
import { mapLegacyComposeBuild } from "./native-config-import-build.ts";

/**
 * Compose features that keep an unchanged Compose project on the Compose
 * backend in v5 (HACK-1291). Native support for them is post-v5 work
 * (HACK-1270). Each one is refused by native image-project `up` and `restart`
 * before any runtime request, storage preparation, lifecycle hook or stop.
 *
 * The set is closed and ordered; it is part of the refusal and the doctor
 * report contract. Messages and reports name only these features, never a
 * network, label, path, platform or other authored value.
 */
export const COMPOSE_BACKEND_FEATURES = [
  "external_network",
  "reserved_label",
  "unsupported_build",
  "foreign_platform",
] as const;

/** One Compose feature from {@link COMPOSE_BACKEND_FEATURES}. */
export type ComposeBackendFeature = (typeof COMPOSE_BACKEND_FEATURES)[number];

/**
 * Label namespaces that prove resource ownership. A project must not declare
 * them, because their consumers trust them as ownership evidence:
 *
 * - `com.docker.compose.*`: Docker Compose's own project, service and one-off
 *   labels, which the Compose backend reads to find a project's containers.
 * - `io.hack-local.*`: native runtime graph ownership (`owner`, `graph`,
 *   `namespace`, `plan`, `kind`, `resource`, `job` and cache labels), which the
 *   runtime-core provider writes and verifies before cleanup.
 * - `io.hack.native-config.*`: native-config Compose ownership (`version`,
 *   `instance`, `owner`, `generation`, `workload`, `storage`), which the
 *   native-config renderer writes and its generation inventory, route owner
 *   and storage witness verify.
 *
 * Other labels, including Hack's routing (`caddy*`), dependency cache
 * (`hack.dependencies.*`) and one-shot markers, are not reserved: native `up`
 * reviews them as it did before.
 */
export const RESERVED_OWNERSHIP_LABEL_PREFIXES = [
  "com.docker.compose.",
  "io.hack-local.",
  "io.hack.native-config.",
] as const;

/** The native VM runs Linux arm64; registry admission selects only this platform. */
const NATIVE_PLATFORMS = new Set(["linux/arm64", "linux/arm64/v8"]);

/** The same bound native image-project input applies to the Compose file. */
const COMPOSE_LIMIT = 256 * 1024;

const FEATURE_PHRASES: Readonly<Record<ComposeBackendFeature, string>> = {
  external_network: "an external Compose network",
  reserved_label:
    "a label in a reserved ownership namespace (com.docker.compose.*, io.hack-local.* or io.hack.native-config.*)",
  unsupported_build:
    "a Compose build outside the basic context, dockerfile and target form",
  foreign_platform: "a service platform other than linux/arm64",
};

function labelKeys(labels: unknown): readonly string[] {
  if (isRecord(labels)) {
    return Object.keys(labels);
  }
  if (Array.isArray(labels)) {
    return labels
      .filter((label): label is string => typeof label === "string")
      .map((label) => label.split("=", 1)[0] ?? "");
  }
  return [];
}

function hasReservedLabel(labels: unknown): boolean {
  return labelKeys(labels).some((key) =>
    RESERVED_OWNERSHIP_LABEL_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/**
 * Compose treats `external: true` and the legacy `external: {name: ...}` form
 * as a network the project does not own. The runtime's reviewed
 * `x-hack-isolated: true` replacement is supported natively: it creates an
 * owned internal bridge instead of joining the external one.
 */
function isExternalNetwork(network: unknown): boolean {
  if (!isRecord(network)) {
    return false;
  }
  const external = network.external;
  const declared = external === true || isRecord(external);
  return declared && network["x-hack-isolated"] !== true;
}

/**
 * A build is inside the supported path only when the import preview's basic
 * build mapper accepts it and the service names no image, exactly as
 * `hack config import --dry-run` reports `invalid_or_unsupported_build` and
 * `image_build_exclusive`.
 */
function isUnsupportedBuild(service: Record<string, unknown>): boolean {
  if (!Object.hasOwn(service, "build")) {
    return false;
  }
  return (
    Object.hasOwn(service, "image") ||
    mapLegacyComposeBuild(service.build) === undefined
  );
}

function isForeignPlatform(service: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(service, "platform") &&
    !(
      typeof service.platform === "string" &&
      NATIVE_PLATFORMS.has(service.platform)
    )
  );
}

function topLevelEntries(
  compose: Record<string, unknown>,
  key: string
): unknown[] {
  const value = compose[key];
  return isRecord(value) ? Object.values(value) : [];
}

/**
 * Classifies a parsed Compose document. Returns the blocking features in
 * {@link COMPOSE_BACKEND_FEATURES} order, each at most once. Every service is
 * inspected, including services outside the selected profiles, because the
 * native path reviews all declarations. Shapes this classifier does not
 * recognize are left to native review, which refuses them as before.
 */
export function findComposeBackendFeatures(
  compose: unknown
): ComposeBackendFeature[] {
  if (!isRecord(compose)) {
    return [];
  }
  const found = new Set<ComposeBackendFeature>();
  const services = topLevelEntries(compose, "services").filter(isRecord);
  if (topLevelEntries(compose, "networks").some(isExternalNetwork)) {
    found.add("external_network");
  }
  const resources = [
    ...topLevelEntries(compose, "networks"),
    ...topLevelEntries(compose, "volumes"),
  ].filter(isRecord);
  if (
    services.some((service) => hasReservedLabel(service.labels)) ||
    resources.some((resource) => hasReservedLabel(resource.labels))
  ) {
    found.add("reserved_label");
  }
  if (services.some(isUnsupportedBuild)) {
    found.add("unsupported_build");
  }
  if (services.some(isForeignPlatform)) {
    found.add("foreign_platform");
  }
  return COMPOSE_BACKEND_FEATURES.filter((feature) => found.has(feature));
}

/**
 * Reads and classifies one Compose file with the bounds native image-project
 * input uses. Read-only: no lock, no write, no runtime request. A file that is
 * missing, oversized, a symlink or not parseable returns no features, so the
 * existing native input refusal still reports it.
 */
export async function readComposeBackendFeatures(
  composeFile: string
): Promise<ComposeBackendFeature[]> {
  let text: string;
  try {
    const file = await open(
      composeFile,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
    );
    try {
      // One byte past the bound detects an oversized or growing file.
      const buffer = Buffer.alloc(COMPOSE_LIMIT + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > COMPOSE_LIMIT) {
        return [];
      }
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, bytesRead)
      );
    } finally {
      await file.close();
    }
  } catch {
    return [];
  }
  try {
    return findComposeBackendFeatures(Bun.YAML.parse(text));
  } catch {
    return [];
  }
}

/** Value-free phrase list, such as "a and b" or "a, b and c". */
export function describeComposeBackendFeatures(
  features: readonly ComposeBackendFeature[]
): string {
  const phrases = features.map((feature) => FEATURE_PHRASES[feature]);
  if (phrases.length <= 1) {
    return phrases[0] ?? "";
  }
  return `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`;
}

/** The selection that runs this project on the Compose backend. */
export const COMPOSE_BACKEND_SELECTION =
  "Set HACK_RUNTIME_BACKEND=compose (hack-next and hack-v5 accept it too)";

/**
 * The closed refusal for a project that needs the Compose backend: stable code
 * `E_NATIVE_PROJECT_UNSUPPORTED`, one line, and a `detail` that lists only the
 * closed feature names.
 */
export function composeBackendRefusal(opts: {
  readonly features: readonly ComposeBackendFeature[];
  readonly restart: boolean;
}): HackCliError {
  const command = opts.restart ? "hack restart" : "hack up";
  return new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message: `Native \`${command}\` does not support ${describeComposeBackendFeatures(opts.features)}; this project runs on the Compose backend. ${COMPOSE_BACKEND_SELECTION} and run the command again. Nothing was started or stopped.`,
    detail: { backend: "compose", features: [...opts.features] },
  });
}

/**
 * Refuses native image-project `up` or `restart` for a Compose project that
 * needs the Compose backend. Call it after project selection and before any
 * runtime request, storage preparation, lifecycle hook or stop.
 */
export async function refuseNativeComposeBackendFeatures(opts: {
  readonly composeFile: string;
  readonly restart: boolean;
}): Promise<void> {
  const features = await readComposeBackendFeatures(opts.composeFile);
  if (features.length > 0) {
    throw composeBackendRefusal({ features, restart: opts.restart });
  }
}
