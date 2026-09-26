import { isRecord } from "../lib/guards.ts";
import { addNativeHostAliases } from "./native-project-host-aliases.ts";
import type { NativeProjectInput } from "./native-project-input.ts";
import { readNativeSelection } from "./native-project-selection.ts";
import { applyNativeWorkspaceCache } from "./native-workspace-cache.ts";

const SELECTION_KEYS = new Set([
  "version",
  "isolatedNetworks",
  "httpProbes",
  "additionalHostnames",
  "additionalHostAliases",
  "workspaceCache",
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
  return new Error(
    "Native project adaptation is invalid or conflicts with declared configuration; values omitted."
  );
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
  replaceNetworks(compose, selection.isolatedNetworks);
  applyNativeWorkspaceCache({ compose, selection: selection.workspaceCache });
  for (const [name, value] of Object.entries(
    selectedMap(selection.httpProbes)
  )) {
    const spec = service(compose.services, name);
    if (spec.healthcheck !== undefined) {
      throw refused();
    }
    spec.healthcheck = { "x-hack-http": probe(value) };
  }
  addHostnames(compose.services, selection.additionalHostnames);
  addNativeHostAliases({
    services: compose.services,
    selection: selection.additionalHostAliases,
  });
  const normalizedComposeJson = JSON.stringify(compose);
  if (Buffer.byteLength(normalizedComposeJson) > 256 * 1024) {
    throw refused();
  }
  return { ...opts.input, normalizedComposeJson };
}

export async function prepareNativeProjectAdaptation(opts: {
  readonly input: NativeProjectInput;
  readonly path?: string;
}): Promise<NativeProjectInput> {
  if (opts.path === undefined) {
    return opts.input;
  }
  return adaptNativeProject({
    input: opts.input,
    selection: await readNativeSelection(opts.path),
  });
}
