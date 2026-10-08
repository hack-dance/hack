import { isRecord } from "./guards.ts";
import { createNativeComposeProbe } from "./native-compose-ownership.ts";
import { NativeComposeRoutingError } from "./native-compose-routing.ts";

const ID = /^[a-f0-9]{64}$/;
const SITE_SEPARATOR = /[\s,]+/;
// Read only root site labels. Never fetch full config, environment, images or
// unrelated labels; site values are untrusted and never included in diagnostics.
const FORMAT =
  '{"id":{{json .Id}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"owner":{{json (index .Config.Labels "io.hack.native-config.owner")}},"instance":{{json (index .Config.Labels "io.hack.native-config.instance")}},"generation":{{json (index .Config.Labels "io.hack.native-config.generation")}},"sites":[{{range $key,$value := .Config.Labels}}{{if or (eq $key "caddy") (and (ge (len $key) 7) (eq (slice $key 0 6) "caddy_") (eq (len (split $key ".")) 1) (ne $key "caddy_ingress_network"))}}{{json $value}},{{end}}{{end}}null]}';

function refused(): never {
  throw new NativeComposeRoutingError();
}
function ids(output: string): string[] {
  const values: unknown[] = output.trim()
    ? output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  if (
    !values.every((id) => typeof id === "string" && ID.test(id)) ||
    new Set(values).size !== values.length
  ) {
    return refused();
  }
  return (values as string[]).sort();
}
function covers(site: string, hostname: string): boolean {
  if (site.startsWith(":")) {
    return true;
  }
  let url: URL;
  try {
    url = new URL(site.includes("://") ? site : `https://${site}`);
  } catch {
    return refused();
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  ) {
    return refused();
  }
  const selected = url.hostname.toLowerCase();
  if (selected === "*") {
    return true;
  }
  return selected.startsWith("*.")
    ? hostname.endsWith(selected.slice(1))
    : hostname === selected;
}

/**
 * Refuse observed foreign Caddy collisions on the selected engine. This is an
 * inventory fence, not an atomic lock against arbitrary external Docker writers.
 * Cooperative native writers additionally hold durable per-hostname claims.
 */
type InventoryOptions = {
  readonly composeProject: string;
  readonly ownerToken: string;
  readonly hostnames: readonly string[];
  readonly requireGenerationId?: string;
  readonly requireAbsent?: boolean;
  readonly signal?: AbortSignal;
};

function inspectRows(
  text: string,
  batch: readonly string[],
  opts: InventoryOptions
): void {
  const rows: unknown[] = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (rows.length !== batch.length) {
    refused();
  }
  const seen = new Set<string>();
  for (const value of rows) {
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join() !==
        "generation,id,instance,owner,project,sites" ||
      typeof value.id !== "string" ||
      !batch.includes(value.id) ||
      seen.has(value.id) ||
      !Array.isArray(value.sites) ||
      value.sites.at(-1) !== null ||
      !value.sites.slice(0, -1).every((site) => typeof site === "string")
    ) {
      refused();
    }
    seen.add(value.id);
    inspectPolicy(value, value.sites.slice(0, -1) as string[], opts);
  }
}

function inspectPolicy(
  value: Record<string, unknown>,
  sites: readonly string[],
  opts: InventoryOptions
): void {
  const owned =
    value.project === opts.composeProject &&
    value.instance === opts.composeProject &&
    value.owner === opts.ownerToken;
  if (owned && opts.requireAbsent) {
    refused();
  }
  if (
    owned &&
    sites.length &&
    opts.requireGenerationId !== undefined &&
    value.generation !== opts.requireGenerationId
  ) {
    refused();
  }
  if (
    !owned &&
    sites.some((value) =>
      value
        .split(SITE_SEPARATOR)
        .filter(Boolean)
        .some((site) =>
          opts.hostnames.some((hostname) => covers(site, hostname))
        )
    )
  ) {
    refused();
  }
}

export async function assertNativeComposeRouteInventory(
  opts: InventoryOptions
): Promise<void> {
  try {
    const selectedOptions = Object.freeze({
      ...opts,
      hostnames: Object.freeze([...opts.hostnames]),
    });
    const probe = createNativeComposeProbe({ signal: selectedOptions.signal });
    const list = () =>
      probe([
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--format",
        "{{json .ID}}",
      ]);
    // Fence the relevant policy twice. Unrelated worktree containers may be
    // created between reads; their existence does not conflict with these hosts.
    for (let pass = 0; pass < 2; pass++) {
      const selected = ids(await list());
      for (let offset = 0; offset < selected.length; offset += 64) {
        const batch = selected.slice(offset, offset + 64);
        const text = await probe([
          "container",
          "inspect",
          "--format",
          FORMAT,
          ...batch,
        ]);
        inspectRows(text, batch, selectedOptions);
      }
    }
  } catch {
    return refused();
  }
}
