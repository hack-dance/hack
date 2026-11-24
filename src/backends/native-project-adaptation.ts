import { HackCliError } from "../lib/cli-result.ts";
import { isRecord } from "../lib/guards.ts";
import { applyNativeLocalDirectories } from "./native-local-directories.ts";
import { addNativeHostAliases } from "./native-project-host-aliases.ts";
import type { NativeProjectInput } from "./native-project-input.ts";
import { applyNativeAmd64Emulation } from "./native-project-platform.ts";
import { readNativeSelection } from "./native-project-selection.ts";
import { applyNativeWorkspaceCache } from "./native-workspace-cache.ts";

const SELECTION_KEYS = new Set([
  "version",
  "isolatedNetworks",
  "httpProbes",
  "additionalHostnames",
  "additionalHostAliases",
  "workspaceCache",
  "amd64Emulation",
]);
const PROBE_KEYS = new Set([
  "port",
  "path",
  "interval_ms",
  "timeout_ms",
  "retries",
  "start_period_ms",
]);
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH = /^\/[!-~]*$/;
const HOST_SEPARATOR = /[\s,]+/;

function refused(): Error {
  return new HackCliError({
    code: "E_CONFIG_INVALID",
    message:
      "Native project adaptation is invalid or conflicts with declared configuration; values omitted.",
  });
}
function integer(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}
function selectedMap(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value) || Object.keys(value).length > 32) {
    throw refused();
  }
  return value;
}
function probe(value: unknown): Record<string, unknown> {
  if (
    !(
      isRecord(value) &&
      Object.keys(value).every((key) => PROBE_KEYS.has(key)) &&
      integer(value.port, 1, 65_535) &&
      typeof value.path === "string" &&
      value.path.length <= 512 &&
      PATH.test(value.path) &&
      !value.path.includes("?") &&
      !value.path.includes("#")
    )
  ) {
    throw refused();
  }
  const result = {
    interval_ms: 1000,
    timeout_ms: 2000,
    retries: 60,
    start_period_ms: 120_000,
    ...value,
  };
  if (
    !(
      integer(result.interval_ms, 10, 3_600_000) &&
      integer(result.timeout_ms, 1, 60_000) &&
      integer(result.retries, 1, 100) &&
      integer(result.start_period_ms, 0, 3_600_000)
    )
  ) {
    throw refused();
  }
  return result;
}
function service(
  services: Record<string, unknown>,
  name: string
): Record<string, unknown> {
  const value = Object.hasOwn(services, name) ? services[name] : undefined;
  if (!isRecord(value)) {
    throw refused();
  }
  return value;
}
function replaceNetworks(
  compose: Record<string, unknown>,
  value: unknown
): void {
  if (value === undefined) {
    return;
  }
  if (
    !(
      Array.isArray(value) &&
      value.length <= 32 &&
      new Set(value).size === value.length
    )
  ) {
    throw refused();
  }
  for (const name of value) {
    if (
      !(
        typeof name === "string" &&
        isRecord(compose.networks) &&
        Object.hasOwn(compose.networks, name)
      )
    ) {
      throw refused();
    }
    const network = compose.networks[name];
    if (!isRecord(network) || network.external !== true) {
      throw refused();
    }
    network["x-hack-isolated"] = true;
  }
}
function addHostnames(
  services: Record<string, unknown>,
  selected: unknown
): void {
  for (const [name, value] of Object.entries(selectedMap(selected))) {
    const spec = service(services, name);
    if (
      !(
        isRecord(spec.labels) &&
        typeof spec.labels.caddy === "string" &&
        // Hostnames without an upstream are inert: adding more would publish nothing.
        typeof spec.labels["caddy.reverse_proxy"] === "string" &&
        Array.isArray(value) &&
        value.length > 0 &&
        value.length <= 8 &&
        value.every(
          (host) =>
            typeof host === "string" &&
            host.length <= 253 &&
            host.includes(".") &&
            host.split(".").every((part: string) => DNS_LABEL.test(part))
        )
      )
    ) {
      throw refused();
    }
    const existing = spec.labels.caddy.split(HOST_SEPARATOR).filter(Boolean);
    const all = [...existing, ...value];
    if (all.length > 8 || new Set(all).size !== all.length) {
      throw refused();
    }
    spec.labels.caddy = all.join(", ");
  }
}

/** Explicit native intent changes only public normalization, never the original checkout or private env. */
export function adaptNativeProject(opts: {
  readonly input: NativeProjectInput;
  readonly selection: unknown;
}): NativeProjectInput {
  const selection = opts.selection;
  if (
    !(
      isRecord(selection) &&
      selection.version === 1 &&
      Object.keys(selection).every((key) => SELECTION_KEYS.has(key))
    )
  ) {
    throw refused();
  }
  const compose: unknown = JSON.parse(opts.input.normalizedComposeJson);
  if (!(isRecord(compose) && isRecord(compose.services))) {
    throw refused();
  }
  const services = compose.services;
  const perService = (value: unknown, includeWitnesses = false) => {
    const omitted = opts.input.omittedServiceSpecs;
    return omitted && isRecord(value)
      ? Object.fromEntries(
          Object.entries(value).filter(
            ([name]) =>
              !omitted.has(name) ||
              (includeWitnesses && Object.hasOwn(services, name))
          )
        )
      : value;
  };
  replaceNetworks(compose, selection.isolatedNetworks);
  const cache = selection.workspaceCache;
  if (
    !(opts.input.omittedServiceSpecs && isRecord(cache)) ||
    workspaceCacheTargets(selection, compose).size > 0
  ) {
    applyNativeWorkspaceCache({ compose, selection: cache });
  }
  for (const [name, value] of Object.entries(
    // Existing dependency witnesses need their health condition for review.
    // The owner inspects their current probe and creates effects only for new services.
    selectedMap(perService(selection.httpProbes, true))
  )) {
    const spec = service(compose.services, name);
    if (spec.healthcheck !== undefined) {
      throw refused();
    }
    spec.healthcheck = { "x-hack-http": probe(value) };
  }
  addHostnames(compose.services, perService(selection.additionalHostnames));
  addNativeHostAliases({
    services: compose.services,
    selection: perService(selection.additionalHostAliases),
  });
  const amd64Emulation = applyNativeAmd64Emulation({
    services: compose.services,
    selection: perService(selection.amd64Emulation),
  });
  const normalizedComposeJson = JSON.stringify(compose);
  if (Buffer.byteLength(normalizedComposeJson) > 256 * 1024) {
    throw refused();
  }
  return Object.keys(amd64Emulation).length > 0
    ? { ...opts.input, normalizedComposeJson, amd64Emulation }
    : { ...opts.input, normalizedComposeJson };
}

/**
 * The native model for start, preflight and restart: the project's
 * `localDirectories` first (on every path, with or without an adaptation
 * file), then the selected adaptation.
 */
export async function prepareNativeProjectAdaptation(opts: {
  readonly input: NativeProjectInput;
  readonly path?: string;
}): Promise<NativeProjectInput> {
  const selection =
    opts.path === undefined ? undefined : await readNativeSelection(opts.path);
  const input = await withNativeLocalDirectories(opts.input, selection);
  if (selection === undefined) {
    return input;
  }
  return adaptNativeProject({ input, selection });
}

/**
 * The workspace `node_modules` paths an adaptation's `workspaceCache` mounts,
 * by service: only services that mount the cache volume at
 * `${root}/node_modules` get them (see `applyNativeWorkspaceCache`). The
 * cache keeps those paths on the VM disk and refuses a mount it finds there,
 * so `localDirectories` leaves them to it in exactly those services.
 */
function workspaceCacheTargets(
  selection: unknown,
  compose: Record<string, unknown>
): ReadonlyMap<string, ReadonlySet<string>> {
  const cache = isRecord(selection) ? selection.workspaceCache : undefined;
  if (
    !(
      isRecord(cache) &&
      typeof cache.volume === "string" &&
      typeof cache.root === "string" &&
      Array.isArray(cache.workspaces) &&
      isRecord(compose.services)
    )
  ) {
    return new Map();
  }
  const root = cache.root;
  const parent = `${root}/node_modules`;
  const targets = new Set(
    cache.workspaces
      .filter((path): path is string => typeof path === "string")
      .map((path) => `${root}/${path}/node_modules`)
  );
  const byService = new Map<string, ReadonlySet<string>>();
  for (const [name, spec] of Object.entries(compose.services)) {
    const volumes =
      isRecord(spec) && Array.isArray(spec.volumes) ? spec.volumes : [];
    if (
      volumes.some((value) =>
        mountsCacheAt(value, cache.volume as string, parent)
      )
    ) {
      byService.set(name, targets);
    }
  }
  return byService;
}

function mountsCacheAt(
  value: unknown,
  volume: string,
  target: string
): boolean {
  if (typeof value === "string") {
    const [source, mountTarget] = value.split(":");
    return source === volume && mountTarget === target;
  }
  return isRecord(value) && value.source === volume && value.target === target;
}

async function withNativeLocalDirectories(
  input: NativeProjectInput,
  selection: unknown
): Promise<NativeProjectInput> {
  if (input.localDirectories === undefined) {
    return input;
  }
  const compose: unknown = JSON.parse(input.normalizedComposeJson);
  if (!(isRecord(compose) && isRecord(compose.services))) {
    return input;
  }
  // Notices are printed by `up` before any detached owner starts.
  await applyNativeLocalDirectories({
    compose,
    selection: input.localDirectories,
    leaveTargets: workspaceCacheTargets(selection, compose),
  });
  return { ...input, normalizedComposeJson: JSON.stringify(compose) };
}
