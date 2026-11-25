/**
 * Doctor checks for settings that make a Compose dev project slow on the
 * host (HACK-2323): emulated services, polling file watchers, mixed
 * architectures on one shared volume, and mutable dev image tags while the
 * repository declares Node or Bun versions.
 *
 * Project configuration stays the project's: these checks report and name
 * the file and line. The only repair offered is the opt-in removal of the
 * polling lines old `hack init` generated (see doctor-polling-fix.ts).
 *
 * Inputs are injected so the checks are pure: the Compose text, the host's
 * architecture, and (when Docker answered) the project's containers with
 * their image architectures. "Unknown" never becomes a finding.
 */

import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { YAML } from "bun";
import {
  type ComposeServiceLines,
  scanComposeServiceLines,
} from "./compose-service-lines.ts";
import {
  type ArchitectureProbe,
  type ContainerArchitecture,
  dockerArchitectureProbe,
  inspectContainerArchitectures,
  platformArchitecture,
} from "./container-architecture.ts";
import {
  findSharedSourceInstalls,
  SHARED_SOURCE_INSTALLS_CHECK,
  type SharedSourceInstallFinding,
  sharedSourceInstallsMessage,
} from "./doctor-shared-source-installs.ts";
import { isRecord } from "./guards.ts";
import { scopeRuntimeHygieneToProject } from "./project-runtime-hygiene.ts";
import { readProjectsRegistry } from "./projects-registry.ts";
import { readRuntimeProjects } from "./runtime-projects.ts";

export const EMULATED_SERVICES_CHECK = "emulated services";
export const POLLING_WATCHERS_CHECK = "polling watchers";
export const SHARED_VOLUME_ARCH_CHECK = "shared volume architectures";
export const DEV_IMAGE_TAGS_CHECK = "dev image tags";

export const DEV_PERFORMANCE_CHECKS = [
  EMULATED_SERVICES_CHECK,
  POLLING_WATCHERS_CHECK,
  SHARED_VOLUME_ARCH_CHECK,
  DEV_IMAGE_TAGS_CHECK,
  SHARED_SOURCE_INSTALLS_CHECK,
] as const;

export const DEV_PERFORMANCE_GUIDE_URL =
  "https://github.com/hack-dance/hack/blob/next/docs/guides/development-runtime-safety.md#check-an-existing-project";

const WHITESPACE = /\s+/;
const MISE_TOOL_LINE = /^\s*(node|bun)\s*=\s*["']?([^"'\s#]+)/;
const INTERPOLATION = /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::?-([^}]*))?\}$/;

/** Image names that ship Node or Bun (`node`, `oven/bun`, `x/bun-node`). */
const NODE_OR_BUN_IMAGE = /(^|[/_.-])(node|nodejs|bun)([/_.-]|$)/;

/** Repository and name without tag or digest, lowercased. */
function imageName(image: string): string {
  const ref = image.trim().toLowerCase().split("@")[0] ?? "";
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  return colon > slash ? ref.slice(0, colon) : ref;
}

const POLLING_VARIABLES = ["CHOKIDAR_USEPOLLING", "WATCHPACK_POLLING"] as const;
type PollingVariable = (typeof POLLING_VARIABLES)[number];

/** Where a finding sits: project-relative file and 1-based line, if known. */
export type DevPerformanceLocation = {
  readonly file: string;
  readonly line: number | null;
};

export type PlatformPinFinding = DevPerformanceLocation & {
  readonly service: string;
  readonly platform: string;
  readonly arch: ContainerArchitecture;
};

export type EmulatedContainerFinding = {
  readonly instance: string;
  readonly service: string;
  readonly arch: ContainerArchitecture;
  readonly image: string | null;
  /** True when the Compose file pins this service's platform. */
  readonly pinned: boolean;
};

export type PollingWatcherFinding = DevPerformanceLocation & {
  readonly service: string;
  readonly variable: PollingVariable;
  readonly value: string;
  /** The exact `KEY: "true"` map line old `hack init` generated. */
  readonly legacy: boolean;
};

export type SharedVolumeArchFinding = {
  readonly instance: string;
  readonly volume: string;
  readonly services: readonly {
    readonly service: string;
    readonly arch: ContainerArchitecture;
  }[];
};

export type DeclaredToolVersion = {
  readonly tool: "node" | "bun";
  readonly version: string;
  /** Project-relative file (and field) that declares it. */
  readonly source: string;
};

export type MutableImageFinding = DevPerformanceLocation & {
  readonly service: string;
  readonly image: string;
};

/** The `devPerformance` JSON field: one variant per check. */
export type DevPerformanceReport =
  | {
      readonly kind: "emulated_services";
      readonly hostArch: ContainerArchitecture;
      /** False when Docker was unavailable: only Compose pins were read. */
      readonly runtimeInspected: boolean;
      readonly pins: readonly PlatformPinFinding[];
      readonly containers: readonly EmulatedContainerFinding[];
    }
  | {
      readonly kind: "polling_watchers";
      readonly services: readonly PollingWatcherFinding[];
    }
  | {
      readonly kind: "shared_volume_architectures";
      readonly volumes: readonly SharedVolumeArchFinding[];
    }
  | {
      readonly kind: "dev_image_tags";
      readonly declared: readonly DeclaredToolVersion[];
      readonly services: readonly MutableImageFinding[];
    }
  | {
      readonly kind: "shared_source_installs";
      readonly services: readonly SharedSourceInstallFinding[];
    };

export type DevPerformanceCheck = {
  readonly name: (typeof DEV_PERFORMANCE_CHECKS)[number];
  readonly status: "ok" | "warn";
  readonly message: string;
  readonly devPerformance?: DevPerformanceReport;
};

/** One project container, with its image architecture when Docker reported it. */
export type DevRuntimeContainer = {
  readonly instance: string;
  readonly service: string;
  readonly state: string;
  readonly image: string | null;
  /** Named volumes it mounts (Docker volume names). */
  readonly volumes: readonly string[];
  readonly arch: ContainerArchitecture | null;
};

/** The parsed Compose service fields these checks read. */
type ComposeService = Readonly<Record<string, unknown>>;

export type ComposeDevInputs = {
  /** Project-relative Compose file path. */
  readonly file: string;
  readonly text: string;
  readonly services: ReadonlyMap<string, ComposeService>;
  readonly lines: ReadonlyMap<string, ComposeServiceLines>;
};

/** Reads and parses the Compose file; an unreadable or invalid file has no services. */
export async function readComposeDevInputs(opts: {
  readonly projectRoot: string;
  readonly composeFile: string;
}): Promise<ComposeDevInputs> {
  const file = relative(opts.projectRoot, opts.composeFile) || opts.composeFile;
  let text = "";
  try {
    text = await readFile(opts.composeFile, "utf8");
  } catch {
    return { file, text, services: new Map(), lines: new Map() };
  }
  return composeDevInputsFromText({ file, text });
}

export function composeDevInputsFromText(opts: {
  readonly file: string;
  readonly text: string;
}): ComposeDevInputs {
  const services = new Map<string, ComposeService>();
  try {
    const parsed: unknown = YAML.parse(opts.text);
    const raw = isRecord(parsed) ? parsed.services : undefined;
    if (isRecord(raw)) {
      for (const [name, value] of Object.entries(raw)) {
        if (isRecord(value)) {
          services.set(name, value);
        }
      }
    }
  } catch {
    // An invalid Compose file is reported by other checks and by Compose.
  }
  return {
    file: opts.file,
    text: opts.text,
    services,
    lines: scanComposeServiceLines(opts.text),
  };
}

function keyLine(
  inputs: ComposeDevInputs,
  service: string,
  key: string
): number | null {
  return inputs.lines.get(service)?.keys.get(key) ?? null;
}

function where(location: DevPerformanceLocation): string {
  return location.line === null
    ? location.file
    : `${location.file}:${location.line}`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Emulated services

/** `${VAR:-x}` / `${VAR-x}` → `x`; other interpolation → null; plain text unchanged. */
function interpolationDefault(value: string): string | null {
  const match = INTERPOLATION.exec(value);
  if (match) {
    return match[1] ?? null;
  }
  return value.includes("$") ? null : value;
}

export function findPlatformPins(opts: {
  readonly inputs: ComposeDevInputs;
  readonly hostArch: ContainerArchitecture;
}): PlatformPinFinding[] {
  const pins: PlatformPinFinding[] = [];
  for (const [service, spec] of opts.inputs.services) {
    if (typeof spec.platform !== "string") {
      continue;
    }
    const effective = interpolationDefault(spec.platform.trim());
    const arch = effective ? platformArchitecture(effective) : null;
    if (!arch || arch === opts.hostArch) {
      continue;
    }
    pins.push({
      service,
      platform: spec.platform,
      arch,
      file: opts.inputs.file,
      line: keyLine(opts.inputs, service, "platform"),
    });
  }
  return pins;
}

export function emulatedServicesCheck(opts: {
  readonly inputs: ComposeDevInputs;
  readonly hostArch: ContainerArchitecture;
  /** Null when Docker was unavailable. */
  readonly containers: readonly DevRuntimeContainer[] | null;
}): DevPerformanceCheck {
  const pins = findPlatformPins(opts);
  const pinned = new Set(pins.map((pin) => pin.service));
  const seen = new Set<string>();
  const containers: EmulatedContainerFinding[] = [];
  for (const container of opts.containers ?? []) {
    if (
      container.state.toLowerCase() !== "running" ||
      !container.arch ||
      container.arch === opts.hostArch
    ) {
      continue;
    }
    const key = `${container.instance}\u0000${container.service}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    containers.push({
      instance: container.instance,
      service: container.service,
      arch: container.arch,
      image: container.image,
      pinned: pinned.has(container.service),
    });
  }
  const report: DevPerformanceReport = {
    kind: "emulated_services",
    hostArch: opts.hostArch,
    runtimeInspected: opts.containers !== null,
    pins,
    containers,
  };
  if (pins.length === 0 && containers.length === 0) {
    return {
      name: EMULATED_SERVICES_CHECK,
      status: "ok",
      message:
        opts.containers === null
          ? `No Compose service pins a platform other than this host's ${opts.hostArch}; running containers not inspected (Docker unavailable or did not answer in time).`
          : `No service is pinned to or running another architecture than this host's ${opts.hostArch}.`,
      devPerformance: report,
    };
  }
  const entries: string[] = [];
  const runningServices = new Set(containers.map((c) => c.service));
  for (const container of containers) {
    const pin = pins.find((p) => p.service === container.service);
    entries.push(
      pin
        ? `${container.service} runs a ${container.arch} image in ${container.instance} (pinned at ${where(pin)})`
        : `${container.service} runs a ${container.arch} image in ${container.instance} without a pin (a locally cached tag of the other architecture)`
    );
  }
  for (const pin of pins) {
    if (!runningServices.has(pin.service)) {
      entries.push(`${pin.service} pins ${pin.platform} at ${where(pin)}`);
    }
  }
  const services = new Set([...pinned, ...runningServices]).size;
  return {
    name: EMULATED_SERVICES_CHECK,
    status: "warn",
    message: `${plural(services, "service", "services")} emulated or pinned to emulation on this ${opts.hostArch} host: ${entries.join("; ")}. Remove the pin and make sure the native variant is used: pull it (docker pull --platform linux/${opts.hostArch} <image>) or build from a base pinned by multi-architecture digest, then recreate the service. Guide: ${DEV_PERFORMANCE_GUIDE_URL}`,
    devPerformance: report,
  };
}

// ---------------------------------------------------------------------------
// Polling watchers

const TRUE_WORDS = new Set(["true", "yes", "on"]);

/**
 * Whether a value turns polling on. Chokidar treats `1` like `true`;
 * a numeric `WATCHPACK_POLLING` is a deliberate interval and is not flagged.
 * A `${VAR:-x}` default is judged by `x`; other interpolation is unknown.
 */
export function pollingValueEnabled(opts: {
  readonly variable: PollingVariable;
  readonly value: unknown;
}): boolean {
  if (opts.value === true) {
    return true;
  }
  if (typeof opts.value === "number") {
    return opts.variable === "CHOKIDAR_USEPOLLING" && opts.value === 1;
  }
  if (typeof opts.value !== "string") {
    return false;
  }
  const effective = interpolationDefault(opts.value.trim());
  if (effective === null) {
    return false;
  }
  const lower = effective.trim().toLowerCase();
  if (TRUE_WORDS.has(lower)) {
    return true;
  }
  return opts.variable === "CHOKIDAR_USEPOLLING" && lower === "1";
}

function environmentEntries(
  spec: ComposeService
): readonly { readonly key: string; readonly value: unknown }[] {
  const env = spec.environment;
  if (isRecord(env)) {
    return Object.entries(env).map(([key, value]) => ({ key, value }));
  }
  if (Array.isArray(env)) {
    return env.flatMap((item): { key: string; value: unknown }[] => {
      if (typeof item !== "string") {
        return [];
      }
      const eq = item.indexOf("=");
      return eq === -1
        ? [{ key: item, value: undefined }]
        : [{ key: item.slice(0, eq), value: item.slice(eq + 1) }];
    });
  }
  return [];
}

function isPollingVariable(key: string): key is PollingVariable {
  return (POLLING_VARIABLES as readonly string[]).includes(key);
}

/** The exact map line `KEY: "true"` the old generator wrote. */
export function isLegacyPollingLine(entry: {
  readonly form: "map" | "list";
  readonly key: string;
  readonly raw: string;
}): boolean {
  return (
    entry.form === "map" &&
    isPollingVariable(entry.key) &&
    entry.raw === '"true"'
  );
}

export function findPollingWatchers(
  inputs: ComposeDevInputs
): PollingWatcherFinding[] {
  const findings: PollingWatcherFinding[] = [];
  for (const [service, spec] of inputs.services) {
    for (const { key, value } of environmentEntries(spec)) {
      if (
        !(
          isPollingVariable(key) &&
          pollingValueEnabled({ variable: key, value })
        )
      ) {
        continue;
      }
      const line = inputs.lines
        .get(service)
        // Compose keeps the last of duplicate keys.
        ?.environment.findLast((entry) => entry.key === key);
      findings.push({
        service,
        variable: key,
        value: String(value),
        file: inputs.file,
        line: line?.line ?? null,
        legacy: line ? isLegacyPollingLine(line) : false,
      });
    }
  }
  return findings;
}

export function pollingWatchersCheck(
  inputs: ComposeDevInputs
): DevPerformanceCheck {
  const services = findPollingWatchers(inputs);
  const report: DevPerformanceReport = { kind: "polling_watchers", services };
  if (services.length === 0) {
    return {
      name: POLLING_WATCHERS_CHECK,
      status: "ok",
      message: "No service forces polling file watchers.",
      devPerformance: report,
    };
  }
  const entries = services.map(
    (f) => `${f.service}: ${f.variable}=${f.value} (${where(f)})`
  );
  const legacy = services.some((f) => f.legacy);
  const fix = legacy
    ? "Preview removing the lines old hack init generated with `hack doctor --fix --only 'polling watchers'`, then add --yes to apply."
    : "Remove the variable unless a measured runtime needs it.";
  return {
    name: POLLING_WATCHERS_CHECK,
    status: "warn",
    message: `${plural(new Set(services.map((f) => f.service)).size, "service polls", "services poll")} for file changes, which costs CPU while idle: ${entries.join("; ")}. ${fix} Guide: ${DEV_PERFORMANCE_GUIDE_URL}`,
    devPerformance: report,
  };
}

// ---------------------------------------------------------------------------
// Mixed architectures on one shared volume

export function findSharedVolumeArchitectures(
  containers: readonly DevRuntimeContainer[]
): SharedVolumeArchFinding[] {
  // Every (service, architecture) pair: replicas of one service can differ.
  const byVolume = new Map<
    string,
    Map<string, SharedVolumeArchFinding["services"][number]>
  >();
  for (const container of containers) {
    if (!container.arch) {
      continue;
    }
    for (const volume of container.volumes) {
      const key = `${container.instance}\u0000${volume}`;
      const pairs = byVolume.get(key) ?? new Map();
      pairs.set(`${container.service}\u0000${container.arch}`, {
        service: container.service,
        arch: container.arch,
      });
      byVolume.set(key, pairs);
    }
  }
  const findings: SharedVolumeArchFinding[] = [];
  for (const [key, pairs] of byVolume) {
    const services = [...pairs.values()];
    if (new Set(services.map((pair) => pair.arch)).size < 2) {
      continue;
    }
    const [instance = "", volume = ""] = key.split("\u0000");
    findings.push({
      instance,
      volume,
      services: services.sort(
        (a, b) =>
          a.service.localeCompare(b.service) || a.arch.localeCompare(b.arch)
      ),
    });
  }
  return findings.sort((a, b) =>
    `${a.instance}/${a.volume}`.localeCompare(`${b.instance}/${b.volume}`)
  );
}

export function sharedVolumeArchCheck(
  containers: readonly DevRuntimeContainer[]
): DevPerformanceCheck {
  const volumes = findSharedVolumeArchitectures(containers);
  const report: DevPerformanceReport = {
    kind: "shared_volume_architectures",
    volumes,
  };
  if (volumes.length === 0) {
    return {
      name: SHARED_VOLUME_ARCH_CHECK,
      status: "ok",
      message:
        "No named volume is shared by containers of different architectures.",
      devPerformance: report,
    };
  }
  const entries = volumes.map(
    (f) =>
      `volume ${f.volume} in ${f.instance} is mounted by ${f.services.map((s) => `${s.service} (${s.arch})`).join(", ")}`
  );
  return {
    name: SHARED_VOLUME_ARCH_CHECK,
    status: "warn",
    message: `${entries.join("; ")}. Native modules installed by one architecture break the other. Run every service of the instance on the host architecture, then reinstall dependencies into the volume. Guide: ${DEV_PERFORMANCE_GUIDE_URL}`,
    devPerformance: report,
  };
}

// ---------------------------------------------------------------------------
// Mutable dev image tags

/** `:latest` or no tag, and no digest; interpolated references are not judged. */
export function isMutableImageReference(image: string): boolean {
  const ref = image.trim();
  if (!ref || ref.includes("$") || ref.includes("@")) {
    return false;
  }
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  if (colon <= slash) {
    return true;
  }
  return ref.slice(colon + 1) === "latest";
}

function mountsProjectSource(spec: ComposeService): boolean {
  const volumes = Array.isArray(spec.volumes) ? spec.volumes : [];
  return volumes.some((volume) => {
    if (typeof volume === "string") {
      return volume.startsWith(".");
    }
    return (
      isRecord(volume) &&
      volume.type === "bind" &&
      typeof volume.source === "string" &&
      volume.source.startsWith(".")
    );
  });
}

/** Image-only services that bind-mount project source and use a mutable tag. */
export function findMutableDevImages(
  inputs: ComposeDevInputs
): MutableImageFinding[] {
  const findings: MutableImageFinding[] = [];
  for (const [service, spec] of inputs.services) {
    if (
      spec.build !== undefined ||
      typeof spec.image !== "string" ||
      !isMutableImageReference(spec.image) ||
      !NODE_OR_BUN_IMAGE.test(imageName(spec.image)) ||
      !mountsProjectSource(spec)
    ) {
      continue;
    }
    findings.push({
      service,
      image: spec.image,
      file: inputs.file,
      line: keyLine(inputs, service, "image"),
    });
  }
  return findings;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#")) ?? ""
  );
}

function packageJsonVersions(text: string | null): DeclaredToolVersion[] {
  let pkg: unknown;
  try {
    pkg = text ? JSON.parse(text) : null;
  } catch {
    return [];
  }
  if (!isRecord(pkg)) {
    return [];
  }
  const declared: DeclaredToolVersion[] = [];
  const engines = isRecord(pkg.engines) ? pkg.engines : {};
  for (const tool of ["node", "bun"] as const) {
    const version = engines[tool];
    if (typeof version === "string" && version.trim()) {
      declared.push({
        tool,
        version: version.trim(),
        source: "package.json engines",
      });
    }
  }
  const manager = pkg.packageManager;
  if (typeof manager === "string" && manager.startsWith("bun@")) {
    declared.push({
      tool: "bun",
      version: manager.slice(4).split("+")[0] ?? "",
      source: "package.json packageManager",
    });
  }
  return declared;
}

function toolVersionsFileVersions(text: string | null): DeclaredToolVersion[] {
  const declared: DeclaredToolVersion[] = [];
  for (const line of text?.split("\n") ?? []) {
    const [name, version] = line.trim().split(WHITESPACE);
    const tool = name === "nodejs" ? "node" : name;
    if ((tool === "node" || tool === "bun") && version) {
      declared.push({ tool, version, source: ".tool-versions" });
    }
  }
  return declared;
}

function miseVersions(
  text: string | null,
  source: string
): DeclaredToolVersion[] {
  const declared: DeclaredToolVersion[] = [];
  for (const line of text?.split("\n") ?? []) {
    const match = MISE_TOOL_LINE.exec(line);
    if (match?.[1] && match[2]) {
      declared.push({
        tool: match[1] as "node" | "bun",
        version: match[2],
        source,
      });
    }
  }
  return declared;
}

/**
 * Node and Bun versions the repository declares: `package.json` `engines`
 * and `packageManager`, `.nvmrc`, `.node-version`, `.bun-version`,
 * `.tool-versions`, and `mise.toml` tools.
 */
export async function readDeclaredToolVersions(
  projectRoot: string
): Promise<DeclaredToolVersion[]> {
  const read = (file: string) => readText(join(projectRoot, file));
  const declared = packageJsonVersions(await read("package.json"));
  const single: readonly [string, "node" | "bun"][] = [
    [".nvmrc", "node"],
    [".node-version", "node"],
    [".bun-version", "bun"],
  ];
  for (const [file, tool] of single) {
    const text = await read(file);
    const version = text ? firstLine(text) : "";
    if (version) {
      declared.push({ tool, version, source: file });
    }
  }
  declared.push(...toolVersionsFileVersions(await read(".tool-versions")));
  for (const file of ["mise.toml", ".mise.toml"]) {
    declared.push(...miseVersions(await read(file), file));
  }
  return declared;
}

/** A note, never a warning: a mutable tag is legitimate, but can drift. */
export function devImageTagsCheck(opts: {
  readonly inputs: ComposeDevInputs;
  readonly declared: readonly DeclaredToolVersion[];
}): DevPerformanceCheck {
  const services =
    opts.declared.length > 0 ? findMutableDevImages(opts.inputs) : [];
  const report: DevPerformanceReport = {
    kind: "dev_image_tags",
    declared: opts.declared,
    services,
  };
  if (opts.declared.length === 0) {
    return {
      name: DEV_IMAGE_TAGS_CHECK,
      status: "ok",
      message: "No Node or Bun version declared; dev image tags not compared.",
      devPerformance: report,
    };
  }
  if (services.length === 0) {
    return {
      name: DEV_IMAGE_TAGS_CHECK,
      status: "ok",
      message: "Dev images use fixed tags or digests.",
      devPerformance: report,
    };
  }
  const versions = opts.declared
    .map((d) => `${d.tool} ${d.version} (${d.source})`)
    .join(", ");
  return {
    name: DEV_IMAGE_TAGS_CHECK,
    status: "ok",
    message: `Note: ${services.map((f) => `${f.service} uses ${f.image} (${where(f)})`).join("; ")} while the repository declares ${versions}. A locally cached mutable tag can be older than those versions, or another architecture; use a version tag or a multi-architecture digest that matches them. Guide: ${DEV_PERFORMANCE_GUIDE_URL}`,
    devPerformance: report,
  };
}

/** True when the note above names at least one service. */
export function hasDevPerformanceDetail(
  check: Omit<DevPerformanceCheck, "name">
): boolean {
  if (check.status !== "ok") {
    return true;
  }
  const report = check.devPerformance;
  if (
    report?.kind === "shared_source_installs" &&
    check.message.startsWith("Note:")
  ) {
    return true;
  }
  return report?.kind === "dev_image_tags" && report.services.length > 0;
}

/** HACK-2358: an advisory note, like dev image tags; never a failure. */
export async function sharedSourceInstallsCheck(opts: {
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly inputs: ComposeDevInputs;
  readonly localDirectories: readonly string[];
  /** Set when the project's `localDirectories` is invalid. */
  readonly localDirectoriesError?: string;
}): Promise<DevPerformanceCheck> {
  if (opts.localDirectoriesError) {
    // Advice would name entries the invalid list may already hold.
    return {
      name: SHARED_SOURCE_INSTALLS_CHECK,
      status: "ok",
      message: `Note: localDirectories in .hack/hack.config.json is invalid, so it was not compared, and hack up refuses it: ${opts.localDirectoriesError}`,
      devPerformance: { kind: "shared_source_installs", services: [] },
    };
  }
  const services = await findSharedSourceInstalls({
    projectRoot: opts.projectRoot,
    composeFile: opts.composeFile,
    services: opts.inputs.services,
    localDirectories: opts.localDirectories,
  });
  return {
    name: SHARED_SOURCE_INSTALLS_CHECK,
    status: "ok",
    message:
      sharedSourceInstallsMessage(services) ??
      "No dependency or build directory in the shared source is visible to a service.",
    devPerformance: { kind: "shared_source_installs", services },
  };
}

// ---------------------------------------------------------------------------
// Runtime observation and the check set

/**
 * The project's Compose containers (every instance of this checkout, any
 * state) with image architectures, or null when Docker could not be read.
 */
export async function observeDevRuntime(opts: {
  readonly projectRoot: string;
  readonly projectDir: string;
  readonly probe?: ArchitectureProbe;
}): Promise<readonly DevRuntimeContainer[] | null> {
  const [registry, runtimeResult] = await Promise.all([
    readProjectsRegistry(),
    readRuntimeProjects({ includeGlobal: false }),
  ]);
  if (!runtimeResult.ok) {
    return null;
  }
  const scoped = scopeRuntimeHygieneToProject({
    projectRoot: opts.projectRoot,
    projectDir: opts.projectDir,
    projects: registry.projects,
    runtime: runtimeResult.runtime,
  });
  const containers = scoped.runtime.flatMap((project) =>
    [...project.services.values()].flatMap((service) =>
      service.containers.map((container) => ({
        id: container.id,
        instance: project.project,
        service: service.service,
        state: container.state,
        image: container.image,
        volumes: container.mounts
          .filter((mount) => mount.type === "volume" && mount.name)
          .map((mount) => mount.name ?? ""),
      }))
    )
  );
  const archs = await inspectContainerArchitectures({
    ids: containers.map((c) => c.id),
    probe: opts.probe ?? dockerArchitectureProbe,
  });
  return containers.map(({ id, ...rest }) => ({
    ...rest,
    arch: archs.get(id) ?? null,
  }));
}

/**
 * The four checks. `containers` is null when Docker is unavailable; the
 * shared-volume check needs containers and is omitted then.
 */
export async function runDevPerformanceChecks(opts: {
  readonly projectRoot: string;
  readonly composeFile: string;
  readonly hostArch: ContainerArchitecture;
  readonly containers: readonly DevRuntimeContainer[] | null;
  /** The project's `localDirectories`; already kept off the share. */
  readonly localDirectories?: readonly string[];
  readonly localDirectoriesError?: string;
}): Promise<DevPerformanceCheck[]> {
  const inputs = await readComposeDevInputs(opts);
  const declared = await readDeclaredToolVersions(opts.projectRoot);
  return [
    emulatedServicesCheck({
      inputs,
      hostArch: opts.hostArch,
      containers: opts.containers,
    }),
    pollingWatchersCheck(inputs),
    ...(opts.containers === null
      ? []
      : [sharedVolumeArchCheck(opts.containers)]),
    devImageTagsCheck({ inputs, declared }),
    await sharedSourceInstallsCheck({
      projectRoot: opts.projectRoot,
      composeFile: opts.composeFile,
      inputs,
      localDirectories: opts.localDirectories ?? [],
      localDirectoriesError: opts.localDirectoriesError,
    }),
  ];
}
