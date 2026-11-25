import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  NATIVE_BUILD_FIELDS,
  unsupportedNativeBuildField,
} from "../backends/native-project-builds.ts";
import {
  type NativePlatformMode,
  selectNativePlatformModes,
} from "../backends/native-project-platform.ts";
import { readNativeSelection } from "../backends/native-project-selection.ts";
import { selectNativeServices } from "../backends/native-service-selection.ts";
import {
  type CandidateLauncher,
  currentCandidateLauncher,
  launcherCommand,
} from "./candidate-launcher.ts";
import { HackCliError } from "./cli-result.ts";
import { isRecord } from "./guards.ts";
import { HACK_OWNERSHIP_LABEL_NAMESPACES } from "./hack-ownership-labels.ts";
import { mapLegacyComposeBuild } from "./native-config-import-build.ts";
import {
  duplicateHackComposeNetworks,
  foreignComposeNetworkNames,
  isHackExternalNetwork,
} from "./native-hack-compose-conventions.ts";

/**
 * Compose features that keep an unchanged Compose project on the Compose
 * backend in v5 (HACK-1291). Native support for them is post-v5 work
 * (HACK-1270). Each one is refused by native image-project `up` and `restart`
 * before any runtime request, storage preparation, lifecycle hook or stop.
 *
 * The set is closed and ordered; it is part of the refusal and the doctor
 * report contract. Refusals name bounded foreign network identifiers. Label values, host paths
 * and environment values are never included.
 *
 * Only `.hack/docker-compose.yml` itself is classified, after the explicit
 * `HACK_NATIVE_ADAPTATION` selection. Compose override files, `extends`,
 * `include` and environment such as `DOCKER_DEFAULT_PLATFORM` are not merged
 * or read, as native start does not read them either. The native runtime's
 * own review reports `extends` and `include` as unsupported fields, and a
 * platform counts only when a service sets the `platform` field.
 */
export const COMPOSE_BACKEND_FEATURES = [
  "external_network",
  "duplicate_hack_network",
  "external_volume",
  "reserved_label", // Older reports only; authored metadata no longer emits this feature.
  "unsupported_build",
  "foreign_platform",
] as const;

/** One Compose feature from {@link COMPOSE_BACKEND_FEATURES}. */
export type ComposeBackendFeature = (typeof COMPOSE_BACKEND_FEATURES)[number];

/**
 * Engine label namespaces that prove resource ownership. Authored Compose
 * declarations are ignored metadata and never copied to native Engine resources:
 *
 * - `com.docker.compose.*`: Docker Compose's own project, service and one-off
 *   labels, which the Compose backend reads to find a project's containers.
 * - Every namespace in {@link HACK_OWNERSHIP_LABEL_NAMESPACES}, the single
 *   source of truth for the ownership labels Hack itself writes.
 *
 * Other labels, including Hack's routing (`caddy*`), dependency cache
 * (`hack.dependencies.*`) and one-shot (`hack.service.one-shot`) markers, are not
 * reserved: native `up` reviews them itself. The native review accepts only the
 * exact one-shot key as a completion role; unsupported semantic service/cache keys still refuse.
 */
export const RESERVED_OWNERSHIP_LABEL_PREFIXES = [
  "com.docker.compose.",
  ...HACK_OWNERSHIP_LABEL_NAMESPACES,
] as const;

/** "a.*, b.* or c.*" for the reserved prefixes, in their declared order. */
function reservedNamespaceList(): string {
  const names = RESERVED_OWNERSHIP_LABEL_PREFIXES.map((prefix) => `${prefix}*`);
  return `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

/**
 * The native VM runs Linux arm64; registry admission selects only this platform unless
 * a service opts in to `linux/amd64` emulation through the native adaptation.
 */
const NATIVE_PLATFORMS = new Set(["linux/arm64", "linux/arm64/v8"]);
const EMULATED_PLATFORM = "linux/amd64";

/** The same bound native image-project input applies to the Compose file. */
const COMPOSE_LIMIT = 256 * 1024;

const FEATURE_PHRASES: Readonly<Record<ComposeBackendFeature, string>> = {
  external_network: "an external Compose network",
  duplicate_hack_network: "multiple logical aliases of one Hack shared network",
  external_volume: "an external Compose volume",
  reserved_label: `a label in a reserved ownership namespace (${reservedNamespaceList()})`,
  unsupported_build:
    "a Compose build outside the basic context, dockerfile and target form",
  foreign_platform: "a service platform other than linux/arm64",
};

/** "a, b, c and d" for the build fields native builds implement. */
function nativeBuildFieldList(): string {
  return `${NATIVE_BUILD_FIELDS.slice(0, -1).join(", ")} and ${NATIVE_BUILD_FIELDS.at(-1)}`;
}

/** The `unsupported_build` phrase while `HACK_NATIVE_BUILDS=1` is set. */
const NATIVE_BUILDS_PHRASE = `a Compose build field other than ${nativeBuildFieldList()}, or image together with build`;

/** Options shared by the classifier, its readers and its messages. */
export type ComposeBackendFeatureOptions = {
  /**
   * Whether native builds are enabled (`HACK_NATIVE_BUILDS=1`). Then a build
   * is a Compose-backend feature only when it declares a field native builds
   * do not implement, or `image` together with `build`; native build
   * admission reviews the rest, including `args` and the managed-secret check.
   */
  readonly buildsEnabled?: boolean;
};

/** Service locations from the same platform predicate used for admission. */
function foreignPlatformServices(
  compose: unknown,
  emulated: ReadonlySet<string> = new Set()
): string[] {
  if (!(isRecord(compose) && isRecord(compose.services))) {
    return [];
  }
  return Object.entries(compose.services)
    .filter(
      ([name, service]) =>
        isRecord(service) && isForeignPlatform(service, emulated.has(name))
    )
    .map(([name]) => name);
}

/**
 * Compose treats `external: true` and the legacy `external: {name: ...}` form
 * as a network the project does not own. The runtime's reviewed
 * `x-hack-isolated: true` replacement is supported natively: it creates an
 * owned internal bridge instead of joining the external one. A network that
 * the `HACK_NATIVE_ADAPTATION` selection lists in `isolatedNetworks` receives
 * that replacement in native normalization, so it is not external either.
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
 * Without native builds, a build is inside the supported path only when the
 * import preview's basic build mapper accepts it and the service names no
 * image, exactly as `hack config import --dry-run` reports
 * `invalid_or_unsupported_build` and `image_build_exclusive`.
 *
 * With native builds, the gate admits exactly the fields native builds
 * implement ({@link NATIVE_BUILD_FIELDS}). Values in those fields, such as
 * paths, interpolation and build args, are left to native build admission,
 * which refuses with the service name and never suggests the Compose backend:
 * a build arg that carries a secret would be recorded in the image history
 * there too.
 */
function isUnsupportedBuild(
  service: Record<string, unknown>,
  buildsEnabled: boolean
): boolean {
  if (!Object.hasOwn(service, "build")) {
    return false;
  }
  if (Object.hasOwn(service, "image")) {
    return true;
  }
  const build = service.build;
  if (buildsEnabled) {
    const fields: ReadonlySet<string> = new Set(NATIVE_BUILD_FIELDS);
    return (
      isRecord(build) && Object.keys(build).some((key) => !fields.has(key))
    );
  }
  return mapLegacyComposeBuild(build) === undefined;
}

/**
 * A basic build is one the import preview's build mapper accepts for a service
 * that names no image. It does not keep the project on the Compose backend,
 * but without `HACK_NATIVE_BUILDS=1` native image-project `up` refuses it
 * (`NATIVE_BUILDS_DISABLED_REFUSAL`).
 */
function isBasicBuild(service: Record<string, unknown>): boolean {
  return Object.hasOwn(service, "build") && !isUnsupportedBuild(service, false);
}

/**
 * Compose takes an absent or `null` `platform` as unset, and native review
 * does the same, so only a declared value other than the native platform is
 * foreign. Environment defaults such as `DOCKER_DEFAULT_PLATFORM` are not read.
 * `linux/amd64` is not foreign for a service the native adaptation opted in to
 * emulation; every other value stays foreign.
 */
function isForeignPlatform(
  service: Record<string, unknown>,
  emulated: boolean
): boolean {
  const platform = service.platform;
  if (platform === undefined || platform === null) {
    return false;
  }
  if (emulated && platform === EMULATED_PLATFORM) {
    return false;
  }
  return !(typeof platform === "string" && NATIVE_PLATFORMS.has(platform));
}

/**
 * Compose treats `external: true` and the legacy `external: {name: ...}` form
 * as a volume the project does not own. Native review refuses it as
 * `external_volume`; there is no native replacement for it.
 */
function isExternalVolume(volume: unknown): boolean {
  if (!isRecord(volume)) {
    return false;
  }
  return volume.external === true || isRecord(volume.external);
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
 * recognize are left to native review, which refuses them as before. A
 * network named in `isolatedNetworks` is not external, because the native
 * adaptation replaces its connectivity with an owned isolated network.
 */
export function findComposeBackendFeatures(
  compose: unknown,
  opts?: {
    /**
     * Network names a valid native adaptation isolates; see
     * {@link readAdaptedIsolatedNetworks}.
     */
    readonly isolatedNetworks?: ReadonlySet<string>;
    /**
     * Service names a valid native adaptation opts in to `linux/amd64`
     * emulation; see {@link readAdaptedEmulatedServices}.
     */
    readonly emulatedServices?: ReadonlySet<string>;
  } & ComposeBackendFeatureOptions
): ComposeBackendFeature[] {
  if (!isRecord(compose)) {
    return [];
  }
  const found = new Set<ComposeBackendFeature>();
  if (duplicateHackComposeNetworks(compose).length) {
    found.add("duplicate_hack_network");
  }
  const services = topLevelEntries(compose, "services").filter(isRecord);
  const isolated = opts?.isolatedNetworks ?? new Set<string>();
  const networks = isRecord(compose.networks)
    ? Object.entries(compose.networks)
    : [];
  if (
    networks.some(
      ([name, network]) =>
        !(isolated.has(name) || isHackExternalNetwork(name, network)) &&
        isExternalNetwork(network)
    )
  ) {
    found.add("external_network");
  }
  if (topLevelEntries(compose, "volumes").some(isExternalVolume)) {
    found.add("external_volume");
  }
  const buildsEnabled = opts?.buildsEnabled === true;
  if (services.some((service) => isUnsupportedBuild(service, buildsEnabled))) {
    found.add("unsupported_build");
  }
  const emulated = opts?.emulatedServices ?? new Set<string>();
  const named = isRecord(compose.services)
    ? Object.entries(compose.services)
    : [];
  if (
    named.some(
      ([name, service]) =>
        isRecord(service) && isForeignPlatform(service, emulated.has(name))
    )
  ) {
    found.add("foreign_platform");
  }
  return COMPOSE_BACKEND_FEATURES.filter((feature) => found.has(feature));
}

/**
 * Reads one Compose file with the bounds native image-project input uses.
 * Read-only: no lock, no write, no runtime request. A file that is missing,
 * oversized, a symlink or not parseable returns `undefined`, so the existing
 * native input refusal still reports it.
 */
export async function readNativeComposeDocument(
  composeFile: string
): Promise<unknown> {
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
        return;
      }
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, bytesRead)
      );
    } finally {
      await file.close();
    }
  } catch {
    return;
  }
  try {
    return Bun.YAML.parse(text);
  } catch {
    return;
  }
}

/** The same closed refusal native start gives for an invalid adaptation. */
function adaptationRefused(): HackCliError {
  return new HackCliError({
    code: "E_CONFIG_INVALID",
    message:
      "Native project adaptation is invalid or conflicts with declared configuration; values omitted.",
  });
}

/**
 * Reads the network names a `HACK_NATIVE_ADAPTATION` selection isolates. The
 * file is read with the same bounds as native start. An unreadable file, a
 * selection that is not version 1, or an `isolatedNetworks` value that is not
 * a bounded list of unique names refuses with `E_CONFIG_INVALID`, as native
 * start would. Native start still validates the whole selection against the
 * normalized Compose file, including that each name is an external network.
 */
export async function readAdaptedIsolatedNetworks(
  adaptationFile: string
): Promise<ReadonlySet<string>> {
  const selection = await readNativeSelection(adaptationFile);
  if (!isRecord(selection) || selection.version !== 1) {
    throw adaptationRefused();
  }
  const names = selection.isolatedNetworks;
  if (names === undefined) {
    return new Set();
  }
  if (
    !(
      Array.isArray(names) &&
      names.length <= 32 &&
      names.every((name) => typeof name === "string") &&
      new Set(names).size === names.length
    )
  ) {
    throw adaptationRefused();
  }
  return new Set(names);
}

/**
 * Whether any service, including one outside the selected profiles, declares a
 * basic build (see {@link isBasicBuild}). Shapes this check does not recognize
 * return false and stay with native review.
 */
export function hasBasicComposeBuild(compose: unknown): boolean {
  if (!isRecord(compose)) {
    return false;
  }
  return topLevelEntries(compose, "services")
    .filter(isRecord)
    .some(isBasicBuild);
}

/** What doctor reports for one Compose file: closed names and flags only. */
export type ComposeBackendReading = {
  readonly foreignPlatformServices?: readonly string[];
  readonly features: ComposeBackendFeature[];
  /** A basic build that native image-project `up` refuses; see {@link hasBasicComposeBuild}. */
  readonly basicBuild: boolean;
};

/**
 * Reads one Compose file once and reports both its Compose-backend features
 * (after the explicit native adaptation, as {@link readComposeBackendFeatures})
 * and whether it declares a basic build. Read-only and value-free.
 */
export async function readComposeBackendReading(
  composeFile: string,
  opts?: {
    readonly adaptationFile?: string;
    /** See {@link readComposeBackendFeatures}; replaces `adaptationFile`. */
    readonly adaptationCandidates?: readonly (string | undefined)[];
  } & ComposeBackendFeatureOptions
): Promise<ComposeBackendReading> {
  const compose = await readNativeComposeDocument(composeFile);
  return await classifyComposeBackendReading(compose, opts);
}

/** Classifies a captured document without reopening its Compose path. */
export async function classifyComposeBackendReading(
  compose: unknown,
  opts?: Parameters<typeof readComposeBackendReading>[1]
): Promise<ComposeBackendReading> {
  const buildsEnabled = opts?.buildsEnabled === true;
  const foreign: string[] = [];
  const features = await classifyAdapted(
    compose,
    adaptationCandidates(opts),
    buildsEnabled,
    foreign
  );
  return {
    features,
    ...(foreign.length ? { foreignPlatformServices: foreign } : {}),
    // With native builds enabled, native `up` builds a basic build itself.
    basicBuild: !buildsEnabled && hasBasicComposeBuild(compose),
  };
}

/** The adaptation candidates a reading applies: explicit candidates, else the one file. */
function adaptationCandidates(opts?: {
  readonly adaptationFile?: string;
  readonly adaptationCandidates?: readonly (string | undefined)[];
}): readonly (string | undefined)[] {
  return (
    opts?.adaptationCandidates ??
    (opts?.adaptationFile === undefined ? [] : [opts.adaptationFile])
  );
}

function intersect(
  left: ReadonlySet<string> | undefined,
  right: ReadonlySet<string>
): ReadonlySet<string> {
  return left === undefined
    ? right
    : new Set([...left].filter((name) => right.has(name)));
}

/**
 * Classify after adaptation. With several candidates (the effective env is not yet
 * known), a network counts as isolated and a service as emulated only when every
 * candidate says so; `undefined` is "no adaptation". This never passes a project
 * that the selected adaptation would leave unsupported.
 */
async function classifyAdapted(
  compose: unknown,
  candidates: readonly (string | undefined)[],
  buildsEnabled: boolean,
  foreign?: string[]
): Promise<ComposeBackendFeature[]> {
  const features = findComposeBackendFeatures(compose, { buildsEnabled });
  const network = features.includes("external_network");
  const platform = features.includes("foreign_platform");
  if (
    candidates.every((candidate) => candidate === undefined) ||
    !(network || platform)
  ) {
    foreign?.push(...foreignPlatformServices(compose));
    return features;
  }
  const services =
    isRecord(compose) && isRecord(compose.services)
      ? Object.keys(compose.services)
      : [];
  let isolated: ReadonlySet<string> | undefined;
  let emulated: ReadonlySet<string> | undefined;
  for (const candidate of new Set(candidates)) {
    if (network) {
      isolated = intersect(
        isolated,
        candidate === undefined
          ? new Set()
          : await readAdaptedIsolatedNetworks(candidate)
      );
    }
    if (platform) {
      emulated = intersect(
        emulated,
        candidate === undefined
          ? new Set()
          : await readAdaptedEmulatedServices(candidate, services)
      );
    }
  }
  foreign?.push(...foreignPlatformServices(compose, emulated));
  return findComposeBackendFeatures(compose, {
    isolatedNetworks: isolated,
    emulatedServices: emulated,
    buildsEnabled,
  });
}

/**
 * Reads the service names a `HACK_NATIVE_ADAPTATION` selection opts in to
 * `linux/amd64` emulation (`amd64Emulation`, with mode `prefer-native` or
 * `amd64`). The same closed `E_CONFIG_INVALID` refusal applies as native start
 * gives, including for a service name the Compose file does not declare.
 */
export async function readAdaptedEmulatedServices(
  adaptationFile: string,
  services: readonly string[]
): Promise<ReadonlySet<string>> {
  const selection = await readNativeSelection(adaptationFile);
  if (!isRecord(selection) || selection.version !== 1) {
    throw adaptationRefused();
  }
  const modes = selectNativePlatformModes({
    selection: selection.amd64Emulation,
    services,
  });
  return new Set(
    [...modes].filter(([, mode]) => mode !== "native").map(([name]) => name)
  );
}

/**
 * Reads and classifies one Compose file after the explicit native adaptation.
 * Read-only: no lock, no write, no runtime request. A Compose file that is
 * missing, oversized, a symlink or not parseable returns no features, so the
 * existing native input refusal still reports it.
 *
 * `adaptationFile` is the `HACK_NATIVE_ADAPTATION` path native start applies.
 * It is read only when the unadapted file has an external network or a
 * foreign platform, so a project without either keeps its existing order of
 * refusals. An invalid adaptation refuses with `E_CONFIG_INVALID` (see
 * {@link readAdaptedIsolatedNetworks} and {@link readAdaptedEmulatedServices}).
 */
export async function readComposeBackendFeatures(
  composeFile: string,
  opts?: {
    readonly adaptationFile?: string;
    /**
     * Every adaptation that could apply when the effective env is not yet known
     * (`undefined` is "no adaptation"). A network counts as isolated only when
     * every candidate isolates it, so the check never passes a project that the
     * selected adaptation would leave external. Replaces `adaptationFile`.
     */
    readonly adaptationCandidates?: readonly (string | undefined)[];
  } & ComposeBackendFeatureOptions
): Promise<ComposeBackendFeature[]> {
  const compose = await readNativeComposeDocument(composeFile);
  return await classifyAdapted(
    compose,
    adaptationCandidates(opts),
    opts?.buildsEnabled === true
  );
}

/**
 * Each declared service's native platform mode after the `HACK_NATIVE_ADAPTATION`
 * selection, for doctor reporting. Read-only. Without a selection every service is
 * `native`; an unreadable Compose file has no services. An invalid selection refuses
 * with the same `E_CONFIG_INVALID` native start gives.
 */
export async function readNativePlatformModes(opts: {
  readonly composeFile: string;
  readonly adaptationFile?: string;
}): Promise<ReadonlyMap<string, NativePlatformMode>> {
  const compose = await readNativeComposeDocument(opts.composeFile);
  const services =
    isRecord(compose) && isRecord(compose.services)
      ? Object.keys(compose.services)
      : [];
  if (opts.adaptationFile === undefined) {
    return selectNativePlatformModes({ selection: undefined, services });
  }
  const selection = await readNativeSelection(opts.adaptationFile);
  if (!isRecord(selection) || selection.version !== 1) {
    throw adaptationRefused();
  }
  return selectNativePlatformModes({
    selection: selection.amd64Emulation,
    services,
  });
}

/** Value-free phrase list, such as "a and b" or "a, b and c". */
export function describeComposeBackendFeatures(
  features: readonly ComposeBackendFeature[],
  opts?: ComposeBackendFeatureOptions
): string {
  const phrases = features.map((feature) =>
    feature === "unsupported_build" && opts?.buildsEnabled === true
      ? NATIVE_BUILDS_PHRASE
      : FEATURE_PHRASES[feature]
  );
  if (phrases.length <= 1) {
    return phrases[0] ?? "";
  }
  return `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`;
}

/**
 * The command that runs `args` on the Compose backend, through the launcher
 * the user has (`hack`, `~/.hack-next/bin/hack-next` or the bundle's
 * `hack-v5`; HACK-2251).
 */
export function composeBackendCommand(
  args: readonly string[],
  launcher: CandidateLauncher = currentCandidateLauncher()
): string {
  return launcherCommand(launcher, args, { HACK_RUNTIME_BACKEND: "compose" });
}

/**
 * The documented selection that keeps a project with an external network on
 * native: native start replaces each listed network with an owned isolated one.
 */
export const ISOLATED_NETWORKS_SELECTION =
  "An external network can stay on native instead: list it by name in `isolatedNetworks` of the `HACK_NATIVE_ADAPTATION` selection, and native start replaces it with an owned isolated network that does not join the external one";

/**
 * The next step for a basic build, which native image-project `up` refuses
 * without native builds. The preview command names the user's launcher.
 */
export function basicBuildNextStep(
  launcher: CandidateLauncher = currentCandidateLauncher(),
  /** The selected project's root; `<project root>` when unknown. */
  projectRoot?: string
): string {
  const preview =
    projectRoot === undefined
      ? `${launcherCommand(launcher, ["config", "import", "--dry-run", "--path"])} <project root>`
      : launcherCommand(launcher, [
          "config",
          "import",
          "--dry-run",
          "--path",
          projectRoot,
        ]);
  return `Set HACK_NATIVE_BUILDS=1 to build it in the native runtime, or preview the authored native conversion with \`${preview}\``;
}

/**
 * The command words that select the same project, branch and env overlay as
 * the refused command, so the printed fallback works from any directory and
 * starts the same configuration.
 */
export function projectSelectorArgs(opts: {
  readonly projectRoot?: string;
  readonly branch?: string;
  readonly env?: string;
}): string[] {
  return [
    ...(opts.projectRoot === undefined ? [] : ["--path", opts.projectRoot]),
    ...(opts.branch === undefined ? [] : ["--branch", opts.branch]),
    ...(opts.env === undefined ? [] : ["--env", opts.env]),
  ];
}

const LINE_BREAK = /[\r\n]/;
const IMAGE_WITH_BUILD = "image together with build";
/** Compose service names that a refusal may print as they are. */
const PRINTABLE_SERVICE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * What keeps a native build on the Compose backend, for the refusal: the first
 * service (in name order) whose build declares a field native builds lack, the
 * field from a fixed list, and how many other services also need the Compose
 * backend for their build. Authored keys outside the list are never printed, and
 * a service name only when it is plain.
 */
export interface UnsupportedNativeBuild {
  readonly service?: string;
  /** `build.<field>`, or `image together with build`; absent for unknown keys. */
  readonly what?: string;
  readonly reason?: string;
  readonly others: number;
}

/** The {@link UnsupportedNativeBuild} of a Compose document, with builds enabled. */
export function unsupportedNativeBuild(
  compose: unknown
): UnsupportedNativeBuild | undefined {
  if (!(isRecord(compose) && isRecord(compose.services))) {
    return;
  }
  const refused = Object.entries(compose.services)
    .filter(
      (entry): entry is [string, Record<string, unknown>] =>
        isRecord(entry[1]) && isUnsupportedBuild(entry[1], true)
    )
    .sort(([a], [b]) => codeUnitOrder(a, b));
  const first = refused[0];
  if (!first) {
    return;
  }
  const [name, service] = first;
  return {
    ...(PRINTABLE_SERVICE.test(name) ? { service: name } : {}),
    ...unsupportedBuildWhat(service),
    others: refused.length - 1,
  };
}

/** Plain code-unit order, independent of the locale. */
function codeUnitOrder(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

function unsupportedBuildWhat(
  service: Record<string, unknown>
): Pick<UnsupportedNativeBuild, "what" | "reason"> {
  if (Object.hasOwn(service, "image")) {
    return { what: IMAGE_WITH_BUILD };
  }
  const field = isRecord(service.build)
    ? unsupportedNativeBuildField(service.build)
    : undefined;
  return field ? { what: field.field, reason: field.reason } : {};
}

function unsupportedBuildSentence(build: UnsupportedNativeBuild): string {
  const who = build.service ? `Service ${build.service}` : "A service";
  const what = build.what ?? "a build field native builds lack";
  const why = build.reason ? `: ${build.reason}` : "";
  const more =
    build.others > 0
      ? ` ${build.others} other service${build.others === 1 ? "" : "s"} also need${build.others === 1 ? "s" : ""} the Compose backend for their build.`
      : "";
  return ` ${who} uses ${what}${why}.${more}`;
}

/**
 * The closed refusal for a project that needs the Compose backend: stable code
 * `E_NATIVE_PROJECT_UNSUPPORTED`, one line, and a `detail` that lists only the
 * closed feature names. With native builds enabled and an unsupported build the
 * only reason, it also carries the three-line start blocker naming the service
 * and field ({@link UnsupportedNativeBuild}).
 */
export function composeBackendRefusal(
  opts: {
    readonly features: readonly ComposeBackendFeature[];
    readonly restart: boolean;
    readonly foreignNetworks?: readonly string[];
    /** With builds enabled: which build needs the Compose backend, if known. */
    readonly build?: UnsupportedNativeBuild;
    /** The selected project's root, printed as `--path` in the fallback. */
    readonly projectRoot?: string;
    /** The `--branch` the refused command was given, if any. */
    readonly branch?: string;
    /** The `--env` the refused command was given, if any. */
    readonly env?: string;
  } & ComposeBackendFeatureOptions
): HackCliError {
  const command = opts.restart ? "hack restart" : "hack up";
  const names = opts.foreignNetworks?.length
    ? ` Foreign external networks: ${opts.foreignNetworks.join(", ")}.`
    : "";
  const fallback = composeBackendCommand([
    opts.restart ? "restart" : "up",
    ...projectSelectorArgs(opts),
  ]);
  const build =
    opts.build &&
    opts.buildsEnabled === true &&
    opts.features.includes("unsupported_build")
      ? opts.build
      : undefined;
  return new HackCliError({
    code: "E_NATIVE_PROJECT_UNSUPPORTED",
    message: `Native \`${command}\` does not support ${describeComposeBackendFeatures(opts.features, opts)}; this project runs on the Compose backend. To run it there: ${fallback}. Nothing was started or stopped.${names}${build ? unsupportedBuildSentence(build) : ""}`,
    detail: { backend: "compose", features: [...opts.features] },
    ...(build && opts.features.length === 1
      ? { startBlocker: unsupportedBuildBlocker(build, fallback) }
      : {}),
  });
}

/** The change the blocker's second line asks for. */
function unsupportedBuildChange(what: string | undefined): string {
  if (what === IMAGE_WITH_BUILD) {
    return "use either image or build for native builds, or run this project on the Compose backend";
  }
  return `remove ${what ?? "that field"} for native builds, or run this project on the Compose backend`;
}

/** The three-line start blocker when an unsupported build field is the only reason. */
function unsupportedBuildBlocker(
  build: UnsupportedNativeBuild,
  fallback: string
) {
  const what = build.what ?? "a build field native builds lack";
  const printable = !LINE_BREAK.test(fallback);
  return {
    thing: "build",
    problem: `${build.service ?? "a service"} uses ${what}${build.others > 0 ? ` (and ${build.others} more)` : ""}`,
    ...(build.reason ? { which: build.reason } : {}),
    ...(printable
      ? {
          needs: unsupportedBuildChange(build.what),
          command: fallback,
        }
      : {}),
  };
}

/**
 * Refuses native image-project `up` or `restart` for a Compose project that
 * needs the Compose backend. Call it after project selection and before any
 * runtime request, storage preparation, lifecycle hook or stop.
 */
export async function refuseNativeComposeBackendFeatures(
  opts: {
    readonly composeFile: string;
    /** The `HACK_NATIVE_ADAPTATION` path native start applies, if any. */
    readonly adaptationFile?: string;
    /** Every adaptation native start could apply; see {@link readComposeBackendFeatures}. */
    readonly adaptationCandidates?: readonly (string | undefined)[];
    readonly targets?: readonly string[];
    readonly profiles?: readonly string[];
    readonly restart: boolean;
    /** The selected project's root, printed as `--path` in the fallback. */
    readonly projectRoot?: string;
    /** The `--branch` the refused command was given, if any. */
    readonly branch?: string;
    /** The `--env` the refused command was given, if any. */
    readonly env?: string;
  } & ComposeBackendFeatureOptions
): Promise<void> {
  const source = await readNativeComposeDocument(opts.composeFile);
  const document =
    opts.targets?.length && isRecord(source) && isRecord(source.services)
      ? {
          ...source,
          services: selectNativeServices({
            services: source.services,
            targets: opts.targets,
            profiles: opts.profiles ?? [],
          }),
        }
      : source;
  const features = await classifyAdapted(
    document,
    adaptationCandidates(opts),
    opts.buildsEnabled === true
  );
  if (features.length > 0) {
    const foreignNetworks = features.includes("external_network")
      ? foreignComposeNetworkNames(document)
      : [];
    const build =
      opts.buildsEnabled === true && features.includes("unsupported_build")
        ? unsupportedNativeBuild(document)
        : undefined;
    throw composeBackendRefusal({ ...opts, features, foreignNetworks, build });
  }
}
